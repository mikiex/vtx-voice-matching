// Voice matching: LPC-style analysis, but resynthesised with what the AY has:
// envelope buzz, locked tones and noise. Fits AY register frames to a
// recording, one update at a time (50 Hz: one per Vectrex frame; 100 or
// 200 Hz as fallbacks), and measures how close the AY gets.
//
// Per frame: the recording's pitch (YIN) sets the envelope period, so the
// shape-8 sawtooth buzzes at the sung or spoken pitch. The recording's power
// is summed in harmonic slots (k*f0 +- f0/2). Each channel A/B/C is then
// chosen from: off; envelope volume with a tone locked to harmonic n (n = 0:
// tone off, the bare sawtooth); a fixed-volume square at harmonic n; or fixed-
// volume noise (one shared noise period). The choice minimises a weighted dB
// distance between slot energies, plus a penalty for changing a channel's
// setting from the previous frame (coordinate descent, two starts).
//
// The model adds channel powers (tone phase against the envelope is not
// controllable on the AY, so it averages four phases); the result is then
// rendered through Ayumi and measured the same way as the recording.
//
// Works in the browser (window.VoiceMatching; needs ayumi.js for rendering)
// and in Node (require).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.VoiceMatching = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The AY's clock decides every period register. It is per match
  // (options.clock); setClock switches it and empties the template caches.
  let CLOCK = 1500000;              // Vectrex AY clock
  let TICK = CLOCK / 8;             // Ayumi's internal step: tone, noise and envelope counters
  const MACHINES = {
    vectrex: { name: "Vectrex", clock: 1500000 },
    spectrum: { name: "ZX Spectrum 128 / +2 / +3", clock: 1773400 },
    cpc: { name: "Amstrad CPC", clock: 1000000 },
    msx: { name: "MSX", clock: 1789773 },
    st: { name: "Atari ST (YM2149)", clock: 2000000 },   // the YM envelope has 32 steps; modelled as the AY's 16
  };
  function setClock(hz) {
    if (hz === CLOCK) return;
    CLOCK = hz;
    TICK = hz / 8;
    envCache.clear();
    squareCache.clear();
  }
  // Envelope shape: the sawtooth (shape 8, 32 steps a cycle) or the triangle
  // (shape 10, down then up: 64 steps, odd harmonics only, falling about
  // 12 dB an octave instead of 6). The pitch, period and lock follow from it.
  let ENV_STEPS = 32, ENV_SHAPE = 8;
  function setShape(name) {
    const steps = name === "triangle" ? 64 : 32;
    if (steps === ENV_STEPS) return;
    ENV_STEPS = steps;
    ENV_SHAPE = name === "triangle" ? 10 : 8;
    envCache.clear();
    squareCache.clear();
  }
  const FRAME_RATE = 50;
  const RENDER_GAIN = 0.66;         // as tools/vtx_speech/render.js: three channels without clipping
  const PAN = 0.5;                  // each channel at pan 0.5: half its level on the output
  // AY volume levels (Ayumi's AY_DAC_TABLE, one entry per pair).
  const LEVEL = [0.0, 0.00999465934234, 0.0144502937362, 0.0210574502174, 0.0307011520562,
    0.0455481803616, 0.0644998855573, 0.107362478065, 0.126588845655, 0.20498970016,
    0.292210269322, 0.372838941024, 0.492530708782, 0.635324635691, 0.805584802014, 1.0];
  const NOISE_PERIODS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 31];

  const DEFAULTS = {
    from: 0, to: 5,                 // seconds of the recording
    updates: 50,                    // register updates a second: 50 (one per Vectrex frame), 100 or 200
    clock: 1500000,                 // AY clock (Hz): MACHINES; the Vectrex's 1.5 MHz by default
    fmin: 70, fmax: 1000,           // pitch search range (Hz)
    voicing: 0.3,                   // YIN clarity threshold (lower = stricter)
    silenceDb: 45,                  // frames this far below the loudest are unvoiced
    fTop: 6000,                     // highest slot frequency compared (Hz)
    channels: [true, true, true],   // A, B, C usable
    fixed: true,                    // fixed-volume squares
    noise: true,                    // noise channels
    bare: true,                     // envelope with tone off (the bare buzz)
    smooth: 0,                      // penalty for changing a channel's setting (dB^2); 0 scored best for speech (STOI)
    autoLevel: true,                // choose the recording's level against the AY's full buzz
    levelDb: 0,                     // trim on top of that (dB)
    floorDb: 50,                    // slots this far below the full buzz count as silence
    // Speech mode (mode: "speech"): LPC formants guide A to F1 and B to F2,
    // unvoiced updates are noise only, voiced ones have no noise, and the
    // cost compares the LPC spectral envelope rather than single harmonics.
    mode: "match",                  // "match" (free) or "speech"
    gateDb: 60,                     // updates this far below the loudest are silent
    pitchSmooth: false,             // median pitch over 5 updates, octave jumps corrected
    rangeDb: 30,                    // and slots this far below the frame's loudest (LPC-like: fit the peaks)
    // Preprocessing of the target (0 = off). The AY is matched to the
    // processed sound; STOI is still scored against the original.
    denoise: 0,                     // background removal: over-subtraction factor (2 is typical)
    consonantDb: 0,                 // boost above 1.5 kHz in unvoiced frames (dB)
    sharpen: 0,                     // formant sharpening: power on the smoothed envelope (0.5 is typical)
    // Extra AY sounds the search may choose:
    envNoise: false,                // envelope volume, tone off, noise on: a breathy buzz
    envGate: false,                 // envelope gated by an ultrasonic tone (period 1): the buzz at -6 dB
    noiseTone: true,                // noise ANDed with a 1-6 kHz tone: noise moved up the spectrum (default since 17 Oct 2026: preferred 4/4 blind on noisy and cleaned speech, a tie on clean)
    // Pitch options:
    envShape: "saw",                // "saw" (shape 8), "triangle" (shape 10), "segments" (chosen per voiced
                                    // stretch, R13 written at the gaps), or "auto": triangle when the
    triangleBelowHz: 110,           // phrase's median voiced pitch is below this (deep voices), else saw
    phaseLock: false,               // envelope-gated tones only on harmonics that divide the cycle exactly
    formantPairs: false,            // speech mode: C joins A near F1
    // Plosive bursts at sharp onsets after near-silence ("p", "t", "k", "b", "d", "g"):
    plosiveEnv: false,              // a noise channel at envelope volume, one-shot decay (R13 shape 0), when the envelope is free
    plosiveVol: false,              // volume steps 15, 11, 7, 3 within the update (needs mid-update writes)
    plosiveMs: 10,                  // burst length
    plosiveNoiseTrim: 0,            // volume steps off the noise at plosive releases only
    plosiveReplace: false,          // plosive releases: the noise channel decays over plosiveMs instead of a flat 20 ms block
    // Fewer register writes (both off by default):
    pitchHold: 0,                   // cents: keep the pitch (envelope and square periods) until it drifts further
    volumeHold: false,              // ignore +-1 volume steps on a channel keeping the same sound
    // Noise and brightness:
    overshoot: 1,                   // weight of errors where the AY is louder than the recording
    noiseTrim: 2,                   // volume steps taken off every noise channel after the search (user, 17 October 2026)
    dullNoiseTrim: 0,               // volume steps off the noise where the recording is dull (tiltDb over dullTiltDb)
    dullTiltDb: 5,
    brightNoiseBoost: 2,            // volume steps onto the noise where the recording is bright (tiltDb under brightTiltDb): "s" as matched
    brightTiltDb: -15,
    energyVoicing: false,           // free mode: voiced also by energy balance; unpitched voiced updates borrow the nearest clear pitch
    exactSquares: true,             // squares tuned to the recording's pitch, not the rounded envelope pitch (default since 17 Oct 2026: never lost by ear, helps singing)
    dither: false,                  // envelope period by error diffusion: the average pitch lands on target
  };

  // ---------------------------------------------------------------- WAV

  // A RIFF WAV as mono floats, optionally only [from, to) seconds. PCM 8/16/24/32
  // and float 32/64, plain or WAVE_FORMAT_EXTENSIBLE. Streamed files give a
  // data size of 0xFFFFFFFF: it is limited to the file.
  function readWav(bytes, from = 0, to = Infinity) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (bytes.length < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") throw new Error("not a WAV file");
    let p = 12, fmt = null;
    while (p + 8 <= bytes.length) {
      let size = v.getUint32(p + 4, true);
      if (id(p) === "fmt ") {
        let format = v.getUint16(p + 8, true);
        if (format === 0xfffe && size >= 26) format = v.getUint16(p + 32, true);
        fmt = { format, channels: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
      } else if (id(p) === "data") {
        if (!fmt) throw new Error("WAV has no fmt chunk");
        size = Math.min(size, bytes.length - p - 8);
        return decode(v, p + 8, size, fmt, from, to);
      }
      p += 8 + size + (size & 1);
    }
    throw new Error("WAV has no data chunk");
  }

  function decode(v, start, size, fmt, from, to) {
    const { format, channels, rate, bits } = fmt, width = bits / 8, step = channels * width;
    if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && (bits === 32 || bits === 64))))
      throw new Error(`unsupported WAV format ${format}, ${bits} bits`);
    const total = Math.floor(size / step);
    const a = Math.max(0, Math.min(total, Math.round(from * rate)));
    const b = Math.max(a, Math.min(total, Math.round(to * rate)));
    const read = format === 3
      ? (o) => (bits === 32 ? v.getFloat32(o, true) : v.getFloat64(o, true))
      : bits === 8 ? (o) => (v.getUint8(o) - 128) / 128
      : bits === 16 ? (o) => v.getInt16(o, true) / 32768
      : bits === 24 ? (o) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608)
      : (o) => v.getInt32(o, true) / 2147483648;
    const out = new Float32Array(b - a);
    for (let i = a; i < b; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += read(start + i * step + c * width);
      out[i - a] = s / channels;
    }
    return { rate, samples: out, seconds: total / rate };
  }

  function writeWav(samples, rate) {
    const bytes = new Uint8Array(44 + samples.length * 2), v = new DataView(bytes.buffer);
    const put = (o, s) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
    put(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); put(8, "WAVE");
    put(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    put(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) v.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
    return bytes;
  }

  // ----------------------------------------------------------- analysis

  function fft(re, im) {                                    // in place, radix 2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  // One-sided power spectrum of a Hann window (ms long) centred on `centre`,
  // scaled so a slot's sum is that part's mean-square amplitude.
  function makeSpectrum(rate, ms = 40) {
    const len = Math.round(rate * ms / 1000);
    let size = 1;
    while (size < len) size <<= 1;
    const win = new Float64Array(len);
    let w2 = 0;
    for (let i = 0; i < len; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / len); w2 += win[i] * win[i]; }
    const scale = 2 / (size * w2), re = new Float64Array(size), im = new Float64Array(size);
    return {
      binHz: rate / size,
      at(samples, centre) {
        re.fill(0); im.fill(0);
        const start = Math.round(centre - len / 2);
        for (let i = 0; i < len; i++) {
          const s = start + i;
          if (s >= 0 && s < samples.length) re[i] = samples[s] * win[i];
        }
        fft(re, im);
        const power = new Float32Array(size / 2);
        for (let b = 0; b < size / 2; b++) power[b] = (re[b] * re[b] + im[b] * im[b]) * scale;
        return power;
      },
    };
  }

  // YIN pitch on a copy decimated to about 16 kHz (box filter: pitch only).
  function makePitch(samples, rate, o) {
    const d = Math.max(1, Math.floor(rate / 16000)), r = rate / d;
    const y = new Float32Array(Math.floor(samples.length / d));
    for (let j = 0; j < y.length; j++) {
      let s = 0;
      for (let i = 0; i < d; i++) s += samples[j * d + i];
      y[j] = s / d;
    }
    const W = Math.round(r * 0.03), minLag = Math.max(2, Math.floor(r / o.fmax)), maxLag = Math.ceil(r / o.fmin);
    const diff = new Float64Array(maxLag + 2), cm = new Float64Array(maxLag + 2);
    return function at(centre) {
      const s = Math.max(0, Math.min(y.length - W - maxLag - 2, Math.round(centre / d - (W + maxLag) / 2)));
      if (s < 0) return { f0: 0, clarity: 1 };
      for (let tau = 1; tau <= maxLag + 1; tau++) {
        let sum = 0;
        for (let j = 0; j < W; j++) { const e = y[s + j] - y[s + j + tau]; sum += e * e; }
        diff[tau] = sum;
      }
      let run = 0;
      cm[0] = 1;
      for (let tau = 1; tau <= maxLag + 1; tau++) { run += diff[tau]; cm[tau] = run > 0 ? diff[tau] * tau / run : 1; }
      let best = -1;
      for (let tau = minLag; tau <= maxLag; tau++) {
        if (cm[tau] < 0.15) {
          while (tau + 1 <= maxLag && cm[tau + 1] < cm[tau]) tau++;
          best = tau;
          break;
        }
      }
      if (best < 0) {
        best = minLag;
        for (let tau = minLag; tau <= maxLag; tau++) if (cm[tau] < cm[best]) best = tau;
      }
      const a = cm[best - 1], b = cm[best], c = cm[best + 1], den = a - 2 * b + c;
      const shift = den > 0 ? Math.max(-1, Math.min(1, 0.5 * (a - c) / den)) : 0;
      return { f0: r / (best + shift), clarity: b };
    };
  }

  // ---------------------------------------------------------------- LPC

  // A copy at about 11 kHz (windowed-sinc low-pass), for LPC.
  function decimate(samples, rate) {
    const d = Math.max(1, Math.round(rate / 11025)), M = 8 * d, fc = 0.45 / d, h = new Float64Array(2 * M + 1);
    for (let i = 0; i <= 2 * M; i++) {
      const x = i - M, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      h[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (2 * M)));
    }
    const out = new Float32Array(Math.floor(samples.length / d));
    for (let j = 0; j < out.length; j++) {
      let acc = 0;
      for (let i = 0; i <= 2 * M; i++) { const s = j * d + i - M; if (s >= 0 && s < samples.length) acc += h[i] * samples[s]; }
      out[j] = acc;
    }
    return { samples: out, rate: rate / d };
  }

  const PRE = 0.97;                 // pre-emphasis for LPC (removed again from the envelope)
  // LPC (order 12, 25 ms Hamming, autocorrelation and Levinson-Durbin) at a
  // centre in the decimated signal: { a, err } with A(z) = 1 + sum a[j] z^-j.
  function lpcAt(y, rd, centre, order = 12) {
    const len = Math.round(rd * 0.025), start = Math.round(centre - len / 2), x = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const s = start + i, cur = s >= 0 && s < y.length ? y[s] : 0, prev = s - 1 >= 0 && s - 1 < y.length ? y[s - 1] : 0;
      x[i] = (cur - PRE * prev) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (len - 1)));
    }
    const r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) { let acc = 0; for (let i = k; i < len; i++) acc += x[i] * x[i - k]; r[k] = acc; }
    r[0] *= 1 + 1e-6;
    if (r[0] <= 1e-12) return null;
    let a = new Float64Array(order + 1), err = r[0];
    a[0] = 1;
    for (let i = 1; i <= order; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k = -acc / err, next = a.slice();
      for (let j = 1; j < i; j++) next[j] = a[j] + k * a[i - j];
      next[i] = k;
      a = next;
      err *= 1 - k * k;
    }
    return { a, err: err / len };
  }

  // The LPC spectral envelope's power at f Hz, with the pre-emphasis removed.
  function envelopeAt(lpc, rd, f) {
    const w = 2 * Math.PI * f / rd;
    let re = 0, im = 0;
    for (let j = 0; j < lpc.a.length; j++) { re += lpc.a[j] * Math.cos(w * j); im -= lpc.a[j] * Math.sin(w * j); }
    const pre = 1 - 2 * PRE * Math.cos(w) + PRE * PRE;
    return lpc.err / ((re * re + im * im) * pre);
  }

  // F1, F2, F3 from the envelope's peaks (pre-emphasised, every 20 Hz).
  function formantsOf(lpc, rd) {
    if (!lpc) return [null, null, null];
    const step = 20, top = Math.min(4000, rd / 2 - step), env = [];
    for (let f = 0; f <= top; f += step) {
      const w = 2 * Math.PI * f / rd;
      let re = 0, im = 0;
      for (let j = 0; j < lpc.a.length; j++) { re += lpc.a[j] * Math.cos(w * j); im -= lpc.a[j] * Math.sin(w * j); }
      env.push(1 / (re * re + im * im));
    }
    const peaks = [];
    for (let i = 1; i < env.length - 1; i++) if (env[i] > env[i - 1] && env[i] >= env[i + 1]) peaks.push(i * step);
    const f1 = peaks.find((f) => f >= 200 && f <= 1000) ?? null;
    const f2 = peaks.find((f) => f >= Math.max(600, (f1 ?? 0) + 200) && f <= 3000) ?? null;
    const f3 = peaks.find((f) => f >= Math.max(1500, (f2 ?? 0) + 300) && f <= 3800) ?? null;
    return [f1, f2, f3];
  }

  // Largest value of a list. Not Math.max(...list): spreading a long list (a
  // 50 s spectrogram) exceeds the browser's argument limit.
  function maxOf(list, start = -Infinity) {
    let m = start;
    for (const v of list) if (v > m) m = v;
    return m;
  }

  const median = (v) => { const s = v.slice().sort((a, b) => a - b); return s[s.length >> 1]; };

  // ------------------------------------------------------- preprocessing

  // One STFT pass (32 ms Hann frames, 75% overlap, overlap-added back):
  // background removal by spectral subtraction against the per-bin power of
  // the quietest 10% of frames, with a floor of -26 dB so it does not leave
  // "musical noise"; formant sharpening by raising the cepstrally smoothed
  // log envelope (lifter 1.5 ms) to 1 + sharpen, limited to +-12 dB; and a
  // boost above 1.5 kHz weighted by how unvoiced the frame is (low/high
  // power, as speech mode's voicing).
  function preprocess(x, rate, o) {
    let N = 1;
    while (N < rate * 0.032) N <<= 1;
    const hop = N / 4, win = new Float64Array(N), half = N / 2, binHz = rate / N;
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const starts = [];
    for (let s0 = -N + hop; s0 < x.length; s0 += hop) starts.push(s0);
    const spectra = starts.map((s0) => {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) { const k = s0 + i; if (k >= 0 && k < x.length) re[i] = x[k] * win[i]; }
      fft(re, im);
      return { re, im };
    });
    const power = (sp, k) => sp.re[k] * sp.re[k] + sp.im[k] * sp.im[k];
    let noise = null;
    if (o.denoise > 0) {
      const energy = spectra.map((sp) => { let e = 0; for (let k = 1; k < half; k++) e += power(sp, k); return e; });
      const order = energy.map((e, i) => i).sort((a, b) => energy[a] - energy[b]);
      const quiet = order.slice(0, Math.max(1, Math.floor(order.length * 0.1)));
      noise = new Float64Array(half + 1);
      for (const i of quiet) for (let k = 0; k <= half; k++) noise[k] += power(spectra[i], k) / quiet.length;
    }
    const lifter = Math.max(4, Math.round(rate * 0.0015)), floor = Math.pow(10, -26 / 20), cut = Math.round(1500 / binHz);
    const lo1 = Math.round(80 / binHz), hi1 = Math.round(1000 / binHz), lo2 = Math.round(2000 / binHz), hi2 = Math.min(half, Math.round(8000 / binHz));
    const out = new Float64Array(x.length), norm = new Float64Array(x.length);
    spectra.forEach((sp, j) => {
      const gain = new Float64Array(half + 1).fill(1);
      if (noise) for (let k = 0; k <= half; k++) { const p = power(sp, k); gain[k] = p > 0 ? Math.max(floor, Math.sqrt(Math.max(0, 1 - o.denoise * noise[k] / p))) : floor; }
      if (o.sharpen > 0) {
        // Log magnitude after the gains so far, smoothed by keeping the low quefrencies.
        const cr = new Float64Array(N), ci = new Float64Array(N);
        for (let k = 0; k <= half; k++) { const v = 0.5 * Math.log(power(sp, k) * gain[k] * gain[k] + 1e-12); cr[k] = v; if (k > 0 && k < half) cr[N - k] = v; }
        fft(cr, ci);
        for (let q = lifter; q <= N - lifter; q++) { cr[q] = 0; ci[q] = 0; }
        fft(cr, ci);                                  // forward again: real, even input, so this is N x the inverse
        let mean = 0, n = 0;
        for (let k = Math.round(100 / binHz); k < Math.min(half, Math.round(4000 / binHz)); k++) { mean += cr[k] / N; n++; }
        mean /= Math.max(1, n);
        for (let k = 0; k <= half; k++) gain[k] *= Math.exp(Math.max(-1.38, Math.min(1.38, o.sharpen * (cr[k] / N - mean))));
      }
      if (o.consonantDb > 0) {
        let a = 0, b = 0;
        for (let k = lo1; k < hi1; k++) a += power(sp, k);
        for (let k = lo2; k < hi2; k++) b += power(sp, k);
        const tilt = 10 * Math.log10((a + 1e-12) / (b + 1e-12)), weight = Math.max(0, Math.min(1, 0.5 - tilt / 10));
        const g = Math.pow(10, o.consonantDb * weight / 20);
        for (let k = cut; k <= half; k++) gain[k] *= g;
      }
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let k = 0; k <= half; k++) { re[k] = sp.re[k] * gain[k]; im[k] = sp.im[k] * gain[k]; }
      for (let k = 1; k < half; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      for (let k = 0; k < N; k++) im[k] = -im[k];
      fft(re, im);                                    // conjugate trick: the inverse transform
      const s0 = starts[j];
      for (let i = 0; i < N; i++) { const k = s0 + i; if (k >= 0 && k < x.length) { out[k] += re[i] / N * win[i]; norm[k] += win[i] * win[i]; } }
    });
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
    return y;
  }

  // Pitch, loudness and spectrum of every 50 Hz frame.
  function analyse(samples, rate, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const processed = o.denoise > 0 || o.consonantDb > 0 || o.sharpen > 0;
    if (processed) samples = preprocess(samples, rate, o);
    const hop = rate / o.updates, count = Math.floor(samples.length / hop);
    // 40 ms resolves harmonics at 50 Hz; faster updates need a shorter view.
    const windowMs = o.windowMs || (o.updates >= 100 ? 20 : 40);
    const spectrum = makeSpectrum(rate, windowMs), pitch = makePitch(samples, rate, o), low = decimate(samples, rate);
    const frames = [];
    let loudest = 0;
    for (let i = 0; i < count; i++) {
      const centre = (i + 0.5) * hop;
      let e = 0;
      for (let s = Math.round(i * hop); s < Math.round((i + 1) * hop); s++) e += samples[s] * samples[s];
      const rms = Math.sqrt(e / hop);
      loudest = Math.max(loudest, rms);
      const p = pitch(centre);
      const lpc = lpcAt(low.samples, low.rate, centre * low.rate / rate);
      frames.push({ time: i / o.updates, rms, f0: p.f0, clarity: p.clarity, power: spectrum.at(samples, centre), lpc, formants: formantsOf(lpc, low.rate) });
    }
    const quiet = loudest * Math.pow(10, -o.silenceDb / 20), gate = loudest * Math.pow(10, -o.gateDb / 20);
    for (const f of frames) {
      f.gated = f.rms < gate;
      let lo = 0, hi = 0;
      for (let b = 1; b < f.power.length; b++) {
        const hz = b * spectrum.binHz;
        if (hz >= 80 && hz < 1000) lo += f.power[b]; else if (hz >= 2000 && hz < 8000) hi += f.power[b];
      }
      f.tiltDb = 10 * Math.log10((lo + 1e-12) / (hi + 1e-12));
      f.pitched = f.clarity < o.voicing && f.f0 >= o.fmin && f.f0 <= o.fmax;
      // energyVoicing (free mode): also voiced when clearly low-heavy (over 3 dB),
      // so speech the pitch tracker misses keeps its buzz instead of turning to noise.
      f.voiced = !f.gated && f.rms > quiet && (o.mode === "speech" ? f.tiltDb > 0 : f.pitched || (o.energyVoicing && f.tiltDb > 3));
    }
    if (o.mode === "speech" || o.energyVoicing) {
      // Speech: voicing from where the energy is (above 0 dB low/high), as
      // speech coders do, since processed or noisy voices defeat YIN. A
      // voiced update without a clear pitch takes the nearest clear one.
      const clear = frames.map((f, i) => (f.pitched && !f.gated ? i : -1)).filter((i) => i >= 0);
      const fallback = clear.length ? median(clear.map((i) => frames[i].f0)) : 110;
      frames.forEach((f, i) => {
        if (!f.voiced || f.pitched) return;
        let best = -1;
        for (const j of clear) if (best < 0 || Math.abs(j - i) < Math.abs(best - i)) best = j;
        f.f0 = best >= 0 && Math.abs(best - i) <= 10 ? frames[best].f0 : fallback;
      });
    }
    if (o.pitchSmooth) {
      // Median of the voiced pitches within two updates; a jump of more than
      // about an octave-and-a-half step from it is taken as a tracking slip.
      const raw = frames.map((f) => (f.voiced ? f.f0 : 0));
      frames.forEach((f, i) => {
        if (!f.voiced) return;
        const near = raw.slice(Math.max(0, i - 2), i + 3).filter((x) => x);
        const m = median(near);
        f.f0 = Math.abs(Math.log2(raw[i] / m)) > 0.4 ? m : median(near.length >= 3 ? near : [raw[i]]);
      });
    }
    for (let k = 0; k < 3; k++) {                   // formant tracks: median of three updates
      const raw = frames.map((f) => f.formants[k]);
      frames.forEach((f, i) => {
        if (raw[i] === null) return;
        const near = raw.slice(Math.max(0, i - 1), i + 2).filter((x) => x !== null);
        f.formants[k] = median(near);
      });
    }
    return { rate, hop, binHz: spectrum.binHz, lowRate: low.rate, frames, target: processed ? samples : null, options: { ...o, windowMs } };
  }

  // Power in harmonic slots k*f0 +- f0/2, k = 1..count.
  function slots(power, binHz, f0, count) {
    const out = new Float64Array(count);
    for (let k = 1; k <= count; k++) {
      const lo = Math.ceil((k - 0.5) * f0 / binHz), hi = Math.min(power.length, Math.ceil((k + 0.5) * f0 / binHz));
      let s = 0;
      for (let b = Math.max(1, lo); b < hi; b++) s += power[b];
      out[k - 1] = s;
    }
    return out;
  }

  // ------------------------------------------------------------- model

  const epFor = (f0) => Math.max(1, Math.min(65535, Math.round(TICK / (ENV_STEPS * f0))));
  const pitchOf = (ep) => TICK / (ENV_STEPS * ep);
  const tpFor = (ep, n) => Math.max(1, Math.min(4095, Math.round(ENV_STEPS * ep / (2 * n))));

  // Slot powers (k = 1..) of one channel at envelope volume: the shape-8
  // sawtooth gated by a tone locked to harmonic n (n = 0: tone off), as a
  // DFT over one envelope period, averaged over four tone phases.
  const envCache = new Map();
  function envTemplate(ep, n, count) {
    const key = ep * 64 + n;
    let t = envCache.get(key);
    if (t && t.length >= count) return t;
    const period = ENV_STEPS * ep, tp = n ? tpFor(ep, n) : 0;
    const phases = n ? [0, tp >> 1, tp, (3 * tp) >> 1] : [0];
    const x = new Float64Array(period), cos = new Float64Array(period), sin = new Float64Array(period);
    for (let i = 0; i < period; i++) { cos[i] = Math.cos(2 * Math.PI * i / period); sin[i] = Math.sin(2 * Math.PI * i / period); }
    t = new Float64Array(count);
    for (const ph of phases) {
      for (let i = 0; i < period; i++) {
        const step = Math.floor(i / ep), level = LEVEL[(step < 32 ? 31 - step : step - 32) >> 1];   // down, then (triangle) up
        x[i] = n && (Math.floor((i + ph) / tp) & 1) ? 0 : level;
      }
      for (let k = 1; k <= count; k++) {
        let re = 0, im = 0;
        for (let i = 0, j = 0; i < period; i++, j = (j + k) % period) { re += x[i] * cos[j]; im -= x[i] * sin[j]; }
        t[k - 1] += 2 * (re * re + im * im) / (period * period) / phases.length;
      }
    }
    envCache.set(key, t);
    return t;
  }

  // Slot powers of a full-level square at harmonic n (its odd partials
  // m * tone frequency, each 2/(pi m)^2 of mean square, in the nearest slot).
  const squareCache = new Map();
  function squareTemplate(ep, n, count) {
    const key = ep * 64 + n;
    let t = squareCache.get(key);
    if (t && t.length >= count) return t;
    const f0 = pitchOf(ep), tone = TICK / (2 * tpFor(ep, n));
    t = new Float64Array(count);
    for (let m = 1; m * tone < (count + 0.5) * f0; m += 2) {
      const k = Math.round(m * tone / f0);
      if (k >= 1) t[k - 1] += 2 / (Math.PI * Math.PI * m * m);
    }
    squareCache.set(key, t);
    return t;
  }

  // Slot powers of full-level noise: random bits held 2*np ticks, so a
  // one-sided density 2 (L^2/4) T sinc^2(f T).
  function noiseTemplate(np, f0, count) {
    const T = 2 * np / TICK, t = new Float64Array(count);
    for (let k = 1; k <= count; k++) {
      const x = Math.PI * k * f0 * T, sinc = Math.sin(x) / x;
      t[k - 1] = 2 * 0.25 * T * sinc * sinc * f0;
    }
    return t;
  }

  // One-sided power density of full-level noise bits (variance 1/4) at f.
  function noisePsd(np, f) {
    const T = 2 * np / TICK, x = Math.PI * f * T;
    return 2 * 0.25 * T * (x === 0 ? 1 : (Math.sin(x) / x) ** 2);
  }

  // Slot powers of a full-level square of tone period tp (odd partials).
  function squareFromTp(tp, f0, count) {
    const tone = TICK / (2 * tp), t = new Float64Array(count);
    for (let m = 1; m * tone < (count + 0.5) * f0; m += 2) {
      const k = Math.round(m * tone / f0);
      if (k >= 1) t[k - 1] += 2 / (Math.PI * Math.PI * m * m);
    }
    return t;
  }

  // Noise bits b ANDed with a square s (both 0/1): b s = 1/4 + s'/2 + b'/2 + b' s',
  // with s' = s - 1/2 and b' = b - 1/2. Powers: the square / 4, the noise / 4,
  // and the noise moved to each odd partial m of the tone (amplitude 2/(pi m)).
  function noiseToneTemplate(np, tp, f0, count) {
    const sq = squareFromTp(tp, f0, count), tone = TICK / (2 * tp), t = new Float64Array(count);
    for (let k = 1; k <= count; k++) {
      const f = k * f0;
      let p = sq[k - 1] / 4 + noisePsd(np, f) * f0 / 4;
      for (let m = 1; m <= 7; m += 2) {
        const a2 = (2 / (Math.PI * m)) ** 2;
        p += a2 / 4 * (noisePsd(np, Math.abs(f - m * tone)) + noisePsd(np, f + m * tone)) * f0;
      }
      t[k - 1] = p;
    }
    return t;
  }

  // Mean square of the envelope's 32 steps (for noise ANDed with the buzz).
  const ENV_MEAN_SQ = Array.from({ length: 32 }, (_, i) => LEVEL[i >> 1] ** 2).reduce((a, b) => a + b, 0) / 32;
  const NOISE_TONES = [1000, 1600, 2500, 4000, 6000];   // Hz: where noise x tone moves the noise

  // Mean square of the bare full buzz (the reference for the level).
  function buzzPower() {
    let s = 0;
    for (const p of envTemplate(30, 0, 200)) s += p;
    return s;
  }

  // ------------------------------------------------------------ search

  const OFF = { kind: "off", n: 0, v: 0 };
  const sameSetting = (a, b) => a.kind === b.kind && a.n === b.n;

  // A state as a canonical codebook key: the three channels sorted (A, B and
  // C sound alike), the noise period only when a channel uses noise.
  const chKey = (c) => (c.kind === "off" ? "off" : `${c.kind}:${c.n}:${c.v}`);
  function stateKey(st) {
    const noisy = st.ch.some((c) => c.kind === "noise" || c.kind === "envnoise" || c.kind === "noisetone");
    return st.ch.map(chKey).sort().join("|") + (noisy ? `#${st.np}` : "");
  }
  function keyToEntry(key) {
    const [chs, np] = key.split("#");
    return { ch: chs.split("|").map((t) => { if (t === "off") return { kind: "off", n: 0, v: 0 }; const [kind, n, v] = t.split(":"); return { kind, n: +n, v: +v }; }), np: np ? +np : 0 };
  }

  // match() runs matchSteps() to the end; matchAsync() runs it in slices of
  // about 100 ms, reporting the fraction done and letting a page repaint. The
  // steps yield once per update searched (the search is nearly all the time).
  function match(analysis, options = {}) {
    const steps = matchSteps(analysis, options);
    let r;
    while (!(r = steps.next()).done);
    return r.value;
  }

  async function matchAsync(analysis, options = {}, onProgress = () => {}, sliceMs = 100) {
    const steps = matchSteps(analysis, options);
    let r, t = Date.now();
    while (!(r = steps.next()).done) {
      if (Date.now() - t < sliceMs) continue;
      onProgress(r.value);
      await new Promise((go) => setTimeout(go, 0));
      t = Date.now();
    }
    onProgress(1);
    return r.value;
  }

  function* matchSteps(analysis, options = {}) {
    const o = { ...analysis.options, ...options };
    setClock(o.clock || 1500000);
    // auto: one shape for the whole phrase (changing it restarts the envelope).
    let shape = o.envShape;
    const segments = shape === "segments";
    if (segments) shape = "saw";                  // for the level trial; chosen per stretch below
    if (shape === "auto") {
      const pitches = analysis.frames.filter((f) => f.voiced).map((f) => f.f0).sort((x, y) => x - y);
      shape = pitches.length && pitches[pitches.length >> 1] < o.triangleBelowHz ? "triangle" : "saw";
    }
    setShape(shape);
    const { frames, binHz } = analysis;
    const ref = buzzPower();
    // Starting level: the loudest voiced frames (90th percentile of slot
    // power) at the full buzz of two channels.
    const totals = frames.filter((f) => f.voiced).map((f) => slots(f.power, binHz, f.f0, Math.floor(o.fTop / f.f0)).reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
    const loud = totals.length ? totals[Math.floor(totals.length * 0.9)] : 1;
    const start = 2 * ref / Math.max(loud, 1e-12);
    const eps = 2 * ref * Math.pow(10, -o.floorDb / 10) / 40;
    // The envelope only plays at full level, so the recording's level decides
    // what the AY can match. Auto level: try -12..+12 dB on every fourth frame
    // and keep the best, then refine; levelDb trims the result.
    let auto = 0;
    const sample = frames.map((_, i) => i).filter((i) => i % 4 === 0);
    const passes = segments ? (o.segmentShapes || ["saw", "triangle"]).length : 1;
    const progress = { done: 0, total: (o.autoLevel ? 11 * sample.length : 0) + passes * frames.length || 1 };
    if (o.autoLevel) {
      // The silence floor moves with the level, or quieter would always win.
      const trial = function* (d) {
        const r = yield* search(analysis, o, start * Math.pow(10, d / 10), eps * Math.pow(10, d / 10), sample, true, progress);
        return r.reduce((s, f) => s + f.cost, 0);
      };
      let best = Infinity;
      for (let d = -12; d <= 12; d += 3) { const c = yield* trial(d); if (c < best) { best = c; auto = d; } }
      for (const d of [auto - 1.5, auto + 1.5]) { const c = yield* trial(d); if (c < best) { best = c; auto = d; } }
    }
    const gain = start * Math.pow(10, (auto + o.levelDb) / 10), floor = eps * Math.pow(10, auto / 10);
    let out;
    if (!segments) out = yield* search(analysis, o, gain, floor, frames.map((_, i) => i), false, progress);
    else {
      // Per stretch: a gap in the voicing plus the voiced run after it. Each
      // stretch tries the sawtooth and the triangle and keeps the lower cost;
      // R13 changes only where the shape does, at the stretch's first
      // envelope update (normally where voicing starts).
      const segs = [];
      let cur = [], voiced = false;
      frames.forEach((f, i) => {
        if (!f.voiced && voiced) { segs.push(cur); cur = []; voiced = false; }
        if (f.voiced) voiced = true;
        cur.push(i);
      });
      if (cur.length) segs.push(cur);
      out = new Array(frames.length);
      for (const seg of segs) {
        let best = null;
        for (const sh of o.segmentShapes || ["saw", "triangle"]) {
          setShape(sh);
          const r = yield* search(analysis, o, gain, floor, seg, false, progress), c = r.reduce((sum, f) => sum + f.cost, 0);
          if (!best || c < best.c) best = { c, r, code: sh === "triangle" ? 10 : 8 };
        }
        best.r.forEach((f, k) => { f.shapeCode = best.code; out[seg[k]] = f; });
      }
      setShape("saw");
      shape = "segments";
    }
    if (o.noiseTrim || o.dullNoiseTrim || o.brightNoiseBoost) {
      // Noise volume steps, one net change per update: noiseTrim off every
      // noise channel; by the recording's brightness (tiltDb: 80-1000 Hz
      // against 2-8 kHz), dullNoiseTrim more off where it is dull (a vowel
      // onset the pitch tracker missed, the "t" of "protect") and
      // brightNoiseBoost on where it is bright (an "s"). At most 15; off below 1.
      out.forEach((m, i) => {
        const t = analysis.frames[i].tiltDb;
        const d = -o.noiseTrim + (t > o.dullTiltDb ? -o.dullNoiseTrim : t < o.brightTiltDb ? o.brightNoiseBoost : 0);
        if (!d) return;
        m.state = { ...m.state, ch: m.state.ch.map((c) => (c.kind === "noise" || c.kind === "noisetone"
          ? (c.v + d >= 1 ? { ...c, v: Math.min(15, c.v + d) } : { kind: "off", n: 0, v: 0 }) : c)) };
      });
    }
    if (o.volumeHold) {
      // A +-1 step on a channel keeping the same sound and harmonic keeps the
      // previous (held) volume; two steps or more get through.
      for (let i = 1; i < out.length; i++) {
        const prevCh = out[i - 1].state.ch;
        out[i].state = { ...out[i].state, ch: out[i].state.ch.map((c, k) => {
          const p2 = prevCh[k];
          return p2.kind === c.kind && p2.n === c.n && c.v < 16 && c.v > 0 && p2.v > 0 && Math.abs(c.v - p2.v) === 1 ? { ...c, v: p2.v } : c;
        }) };
      }
    }
    if (o.plosiveEnv || o.plosiveVol || o.plosiveNoiseTrim || o.plosiveReplace) markPlosives(analysis, out, o);
    const regs = registers(out);
    return { frames: out, regs, updates: o.updates, clock: CLOCK, envShape: shape, gain, autoLevelDb: auto, eps: floor, stats: stats(analysis, out, regs) };
  }

  // Matches the given frames in order. `quick`: no smoothing (frames apart).
  // A generator: yields the fraction of the whole match done, once an update.
  function* search(analysis, o, gain, eps, indices, quick, progress = { done: 0, total: indices.length }) {
    const { frames, binHz } = analysis, usable = [0, 1, 2].filter((c) => o.channels[c]), smooth = quick ? 0 : o.smooth;
    const overshoot = o.overshoot || 1;
    const eps_ = [];                              // envelope period per frame: unvoiced frames keep the last
    // pitchHold: the pitch actually used, held until the measured pitch moves
    // more than pitchHold cents from it (fewer envelope and tone writes).
    const f0h = [];
    let held = 0;
    for (const f of frames) {
      if (f.voiced && !(held && o.pitchHold && Math.abs(1200 * Math.log2(f.f0 / held)) < o.pitchHold)) held = f.f0;
      f0h.push(f.voiced ? held : 0);
    }
    let carry = 0, err = 0;
    for (const [fi, f] of frames.entries()) {
      if (f.voiced) {
        if (o.dither) {
          // Error diffusion: carry the rounding error into the next update.
          const x = TICK / (ENV_STEPS * f0h[fi]), e = Math.max(1, Math.min(65535, Math.round(x + err)));
          err += x - e;
          carry = e;
        } else carry = epFor(f0h[fi]);
      } else err = 0;
      eps_.push(carry);
    }
    const firstEp = eps_.find((e) => e) || epFor(150);
    const out = [];
    let prev = { ch: [OFF, OFF, OFF], np: 8 };
    for (const i of indices) {
      yield ++progress.done / progress.total;
      const f = frames[i], ep = eps_[i] || firstEp;
      const f0q = pitchOf(ep), base = f.voiced ? f.f0 : f0q;
      const count = Math.max(1, Math.min(120, Math.floor(o.fTop / base)));
      let R = slots(f.power, binHz, base, count);
      const speech = o.mode === "speech";
      if (speech && f.voiced && f.lpc) {
        // Compare the LPC envelope at the harmonics (same total power): the
        // shape that carries the vowel, not each harmonic's level.
        const env = new Float64Array(count), nyq = analysis.lowRate / 2;
        let a = 0, b = 0;
        for (let k = 0; k < count; k++) { env[k] = (k + 1) * base < nyq ? envelopeAt(f.lpc, analysis.lowRate, (k + 1) * base) : 0; a += env[k]; b += R[k]; }
        if (a > 0) R = env.map((e) => e * b / a);
      }
      const fe = Math.max(eps, maxOf(R) * gain * Math.pow(10, -o.rangeDb / 10));
      const logR = new Float64Array(count), w = new Float64Array(count);
      let wsum = 0;
      for (let k = 0; k < count; k++) {
        logR[k] = Math.log(R[k] * gain + fe);
        w[k] = Math.min(1, 1000 / ((k + 1) * base));       // flat to 1 kHz, then per octave
        wsum += w[k];
      }
      const cost = (M) => {
        let s = 0;
        // overshoot: energy the AY adds over the recording counts this many times
        // (added sound is more audible than missing sound).
        for (let k = 0; k < count; k++) { const d = 4.342944819 * (logR[k] - Math.log(M[k] + fe)); s += w[k] * d * d * (d < 0 ? overshoot : 1); }
        return s / wsum;
      };

      // Candidate settings for one channel; noise ones use the shared period.
      const top = Math.max(0, Math.floor(o.fTop / f0q));
      const tones = [];
      for (let n = 1; n <= Math.min(top, 63); n++) if (ENV_STEPS * ep / (2 * n) >= 1) tones.push(n);
      // phaseLock: envelope-gated tones only where the tone period divides the cycle exactly.
      const envTones = o.phaseLock ? tones.filter((n) => (ENV_STEPS * ep / 2) % n === 0) : tones;
      const cands = [OFF];
      if (o.bare) cands.push({ kind: "env", n: 0, v: 16 });
      for (const n of envTones) cands.push({ kind: "env", n, v: 16 });
      // exactSquares: tone period from the recording's pitch (finer steps than the envelope's).
      const squareTp = (n) => (o.exactSquares && f.voiced ? Math.max(1, Math.min(4095, Math.round(TICK / (2 * n * f0h[i])))) : 0);
      if (o.fixed) for (const n of tones) { const tp = squareTp(n); for (let v = 1; v <= 15; v++) cands.push(tp ? { kind: "square", n, v, tp } : { kind: "square", n, v }); }
      if (o.envGate) cands.push({ kind: "envgate", n: 0, v: 16, tp: 1 });
      const noises = [];
      if (o.noise) for (let v = 1; v <= 15; v++) noises.push({ kind: "noise", n: 0, v });
      if (o.envNoise) noises.push({ kind: "envnoise", n: 0, v: 16 });
      if (o.noiseTone) NOISE_TONES.forEach((hz, j) => { const tp = Math.max(1, Math.round(TICK / (2 * hz))); for (let v = 1; v <= 15; v++) noises.push({ kind: "noisetone", n: j + 1, v, tp }); });
      // Per channel: free mode lets every channel be anything. Speech mode:
      // gated updates are silent; unvoiced ones noise only; voiced ones put
      // A within a harmonic of F1 and B of F2, C free, and no noise.
      const near = (hz) => { const n = Math.max(1, Math.round(hz / f0q)); return (c) => c.kind === "off" || (c.n >= n - 1 && c.n <= n + 1 && c.n >= 1); };
      let chCands;
      if (!speech) chCands = [0, 1, 2].map(() => cands.concat(noises));
      else if (f.gated) chCands = [[OFF], [OFF], [OFF]];
      else if (!f.voiced) chCands = [0, 1, 2].map(() => [OFF].concat(noises));
      else {
        const [f1, f2] = f.formants;
        // formantPairs: C joins A near F1, so the pair can place F1 between harmonics.
        chCands = [f1 ? cands.filter(near(f1)) : cands, f2 ? cands.filter(near(f2)) : cands, o.formantPairs && f1 ? cands.filter(near(f1)) : cands];
      }
      const noiseUnit = new Map();
      const contrib = (c, np) => {
        if (c.kind === "env") return envTemplate(ep, c.n, count);
        if (c.kind === "square") {
          if (!c.tp) return scaled(squareTemplate(ep, c.n, count), LEVEL[c.v] ** 2);
          const key = "sq" + c.tp;
          if (!noiseUnit.has(key)) noiseUnit.set(key, squareFromTp(c.tp, base, count));
          return scaled(noiseUnit.get(key), LEVEL[c.v] ** 2);
        }
        if (c.kind === "noise") {
          if (!noiseUnit.has(np)) noiseUnit.set(np, noiseTemplate(np, base, count));
          return scaled(noiseUnit.get(np), LEVEL[c.v] ** 2);
        }
        if (c.kind === "envgate") return scaled(envTemplate(ep, 0, count), 0.25);
        if (c.kind === "envnoise") {
          const key = "en" + np;
          if (!noiseUnit.has(key)) {
            const e = envTemplate(ep, 0, count), nz = noiseTemplate(np, base, count), t = new Float64Array(count);
            for (let k = 0; k < count; k++) t[k] = e[k] / 4 + nz[k] * ENV_MEAN_SQ;
            noiseUnit.set(key, t);
          }
          return noiseUnit.get(key);
        }
        if (c.kind === "noisetone") {
          const key = `nt${np}/${c.tp}`;
          if (!noiseUnit.has(key)) noiseUnit.set(key, noiseToneTemplate(np, c.tp, base, count));
          return scaled(noiseUnit.get(key), LEVEL[c.v] ** 2);
        }
        return null;
      };
      const total = (st) => {
        const M = new Float64Array(count);
        for (const c of st.ch) { const t = contrib(c, st.np); if (t) for (let k = 0; k < count; k++) M[k] += t[k]; }
        return M;
      };
      const penalty = (st) => st.ch.reduce((s, c, i) => s + (sameSetting(c, prev.ch[i]) ? 0 : smooth), 0);
      const score = (st) => cost(total(st)) + penalty(st);

      const descend = (start) => {
        const st = { ch: start.ch.map((c, i) => (usable.includes(i) && chCands[i].some((d) => sameSetting(d, c)) ? c : OFF)), np: start.np };
        for (let pass = 0; pass < 3; pass++) {
          let changed = false;
          for (const i of usable) {
            const others = new Float64Array(count);
            st.ch.forEach((c, j) => { if (j !== i) { const t = contrib(c, st.np); if (t) for (let k = 0; k < count; k++) others[k] += t[k]; } });
            let best = st.ch[i], bestScore = Infinity;
            const M = new Float64Array(count);
            for (const c of chCands[i]) {
              const t = contrib(c, st.np);
              for (let k = 0; k < count; k++) M[k] = others[k] + (t ? t[k] : 0);
              const s = cost(M) + (sameSetting(c, prev.ch[i]) ? 0 : smooth);
              if (s < bestScore) { bestScore = s; best = c; }
            }
            if (best !== st.ch[i]) { st.ch[i] = best; changed = true; }
          }
          if (st.ch.some((c) => c.kind === "noise" || c.kind === "envnoise" || c.kind === "noisetone")) {
            let bestNp = st.np, bestScore = Infinity;
            for (const np of NOISE_PERIODS) { const s = score({ ch: st.ch, np }); if (s < bestScore) { bestScore = s; bestNp = np; } }
            if (bestNp !== st.np) { st.np = bestNp; changed = true; }
          }
          if (!changed) break;
        }
        return st;
      };
      let st, entry = -1;
      if (o.codebook) {
        // Codebook: every entry at this update's pitch; keep the best. Entries
        // hold harmonic numbers, so the tone periods come from the pitch here.
        let bestScore = Infinity;
        // Gain-shape: each entry also at every gain in codebookGains (volume
        // steps added to the fixed-volume channels; the envelope channels
        // have no volume).
        const gains = o.codebookGains || [0];
        for (const g of gains) o.codebook.forEach((e0, j) => {
          const e = g ? { ...e0, ch: e0.ch.map((c) => (c.kind === "square" || c.kind === "noise" || c.kind === "noisetone" ? { ...c, v: Math.max(1, Math.min(15, c.v + g)) } : c)) } : e0;
          const cand = { ch: e.ch.map((c) => {
            if (c.kind === "square") { const tp = squareTp(c.n); return tp ? { ...c, tp } : c; }
            if (c.kind === "noisetone") return { ...c, tp: Math.max(1, Math.round(TICK / (2 * NOISE_TONES[c.n - 1]))) };
            if (c.kind === "envgate") return { ...c, tp: 1 };
            return c;
          }), np: e.np || prev.np };
          const sc = score(cand);
          if (sc < bestScore) { bestScore = sc; st = cand; entry = j; st.gain = g; }
        });
        // Escape: when the full search beats the best entry by more than
        // codebookEscape (in the cost's mean squared dB), store this update
        // as full registers instead.
        if (o.codebookEscape !== undefined) {
          const fa = descend(prev), fb = descend({ ch: [OFF, OFF, OFF], np: prev.np }), full = score(fa) <= score(fb) ? fa : fb;
          if (score(full) + o.codebookEscape < bestScore) { st = full; entry = -2; }
        }
      } else {
        const a = descend(prev), b = descend({ ch: [OFF, OFF, OFF], np: prev.np });
        st = score(a) <= score(b) ? a : b;
      }
      const M = total(st);
      out.push({ entry, ep, steps: ENV_STEPS, f0q, base, count, state: st, R: Array.from(R, (r) => r * gain), M: Array.from(M), eps: fe, cost: cost(M) });
      prev = st;
    }
    return out;
  }

  function scaled(t, s) {
    const out = new Float64Array(t.length);
    for (let k = 0; k < t.length; k++) out[k] = t[k] * s;
    return out;
  }

  // AY registers R0..R13 per frame; `shape` marks the frame that writes R13
  // (shape 8, once, when the envelope is first used: rewriting restarts it).
  // Plosive onsets: an update at least 10 dB louder than the one before,
  // which was at least 30 dB below the loudest (a closure, then the release).
  // The burst goes on an unused channel, or the quietest fixed-volume one.
  const usesEnv = (st) => st.ch.some((c) => c.kind === "env" || c.kind === "envgate" || c.kind === "envnoise");
  function markPlosives(analysis, out, o) {
    const fr = analysis.frames, loud = maxOf(fr.map((f) => f.rms)), quiet = loud * Math.pow(10, -30 / 20);
    for (let i = 1; i < out.length; i++) {
      if (!(fr[i - 1].rms < quiet && fr[i].rms > fr[i - 1].rms * Math.pow(10, 10 / 20))) continue;
      out[i].plosive = true;
      const isNoise = (c) => c.kind === "noise" || c.kind === "noisetone";
      if (o.plosiveNoiseTrim) {
        // Only the release: its noise channels plosiveNoiseTrim steps quieter (off below 1).
        out[i].state = { ...out[i].state, ch: out[i].state.ch.map((c) => (isNoise(c)
          ? (c.v - o.plosiveNoiseTrim >= 1 ? { ...c, v: c.v - o.plosiveNoiseTrim } : { kind: "off", n: 0, v: 0 }) : c)) };
      }
      if (o.plosiveReplace) {
        // The release's loudest noise channel becomes a decaying burst: its own
        // volume, then 3 steps quieter every quarter of plosiveMs, then off,
        // instead of a flat block for the whole update.
        const noisy = out[i].state.ch.map((c, k) => [c, k]).filter(([c]) => isNoise(c)).sort((x, y) => y[0].v - x[0].v);
        if (noisy.length) out[i].burst = { kind: "decay", ch: noisy[0][1], v: noisy[0][0].v, ms: o.plosiveMs };
        continue;
      }
      if (!o.plosiveEnv && !o.plosiveVol) continue;
      const ch = out[i].state.ch;
      let pick = ch.findIndex((c) => c.kind === "off");
      if (pick < 0) {
        const fixed = ch.map((c, k) => [c, k]).filter(([c]) => c.kind === "square" || c.kind === "noise" || c.kind === "noisetone");
        if (fixed.length) pick = fixed.sort((x, y) => x[0].v - y[0].v)[0][1];
      }
      if (pick < 0) continue;
      const envFree = !usesEnv(out[i].state) && !usesEnv(out[i - 1].state);
      if (o.plosiveEnv && envFree) out[i].burst = { kind: "env", ch: pick, ep: Math.max(1, Math.round(o.plosiveMs * TICK / 32000)) };
      else if (o.plosiveVol) out[i].burst = { kind: "vol", ch: pick, ms: o.plosiveMs };
    }
  }

  function registers(frames) {
    let written = -1;                               // the shape R13 last started
    return frames.map((f) => {
      const r = new Array(14).fill(0);
      let mixer = 0x3f;
      f.state.ch.forEach((c, i) => {
        // The tone period for this update's own envelope shape (stretches can differ).
        const tp = c.tp || (c.n && (c.kind === "env" || c.kind === "square") ? Math.max(1, Math.min(4095, Math.round((f.steps || ENV_STEPS) * f.ep / (2 * c.n)))) : 0);
        if (tp) { r[2 * i] = tp & 0xff; r[2 * i + 1] = tp >> 8; }
        if (tp) mixer &= ~(1 << i);                                  // tone on
        if (c.kind === "noise" || c.kind === "envnoise" || c.kind === "noisetone") mixer &= ~(8 << i);
        r[8 + i] = c.kind === "env" || c.kind === "envgate" || c.kind === "envnoise" ? 0x10 : c.kind === "off" ? 0 : c.v;
      });
      r[6] = f.state.np;
      r[7] = mixer;
      r[11] = f.ep & 0xff;
      r[12] = f.ep >> 8;
      let code = f.shapeCode || ENV_SHAPE, env = f.state.ch.some((c) => c.kind === "env" || c.kind === "envgate" || c.kind === "envnoise");
      let events;
      if (f.burst && f.burst.kind === "env") {
        // Envelope burst: noise on, tone off, envelope volume, a one-shot decay (shape 0).
        const b = f.burst.ch;
        r[7] = (r[7] | (1 << b)) & ~(8 << b);
        r[8 + b] = 0x10;
        r[11] = f.burst.ep & 0xff;
        r[12] = f.burst.ep >> 8;
        code = 0;
        env = true;
      } else if (f.burst && f.burst.kind === "decay") {
        // Decaying burst on a noise channel already sounding: v, v-3, v-6, v-9, then 0.
        const b = f.burst.ch, step = f.burst.ms / 4000;
        events = [0, 1, 2, 3].map((k) => ({ t: k * step, reg: 8 + b, value: Math.max(0, f.burst.v - 3 * k) }));
        events.push({ t: 4 * step, reg: 8 + b, value: 0 });
      } else if (f.burst && f.burst.kind === "vol") {
        // Volume burst: noise on, tone off, volumes 15, 11, 7, 3 across the burst,
        // then the update's own mixer and volume.
        const b = f.burst.ch, step = f.burst.ms / 4000;
        const mix = (r[7] | (1 << b)) & ~(8 << b);
        events = [{ t: 0, reg: 7, value: mix }, ...[15, 11, 7, 3].map((v, k) => ({ t: k * step, reg: 8 + b, value: v })),
          { t: 4 * step, reg: 8 + b, value: r[8 + b] }, { t: 4 * step, reg: 7, value: r[7] }];
      }
      r[13] = code;
      // Write R13 (restarting the envelope) only when the envelope is first
      // used, or when a stretch changes the shape.
      const shape = env && code !== written;
      if (env) written = code;
      return events ? { regs: r, shape, events } : { regs: r, shape };
    });
  }

  // Registers as bytes for a player: 14 a update, R0..R13 in order. R13 is
  // $FF when it must not be written (the YM-dump convention): writing R13
  // restarts the envelope, so only the first envelope update writes it.
  function dump(regs) {
    const out = new Uint8Array(14 * regs.length);
    regs.forEach((f, i) => { out.set(f.regs, 14 * i); if (!f.shape) out[14 * i + 13] = 0xff; });
    return out;
  }

  function stats(analysis, out, regs) {
    const voiced = analysis.frames.filter((f) => f.voiced);
    const cents = analysis.frames.map((f, i) => (f.voiced ? 1200 * Math.log2(out[i].f0q / f.f0) : null)).filter((c) => c !== null);
    let writes = 0;
    regs.forEach((f, i) => { if (i) for (let r = 0; r < 14; r++) if (f.regs[r] !== regs[i - 1].regs[r] && r !== 13) writes++; });
    const use = { off: 0, env: 0, square: 0, noise: 0, envgate: 0, envnoise: 0, noisetone: 0 };
    for (const f of out) for (const c of f.state.ch) use[c.kind]++;
    return {
      frames: out.length,
      voicedShare: voiced.length / Math.max(1, out.length),
      modelErrorDb: Math.sqrt(out.reduce((s, f) => s + f.cost, 0) / Math.max(1, out.length)),
      pitchStepCents: { mean: cents.reduce((s, c) => s + Math.abs(c), 0) / Math.max(1, cents.length), max: maxOf(cents.map(Math.abs), 0) },
      // The same over 4-update windows (80 ms at 50 Hz), where dithering pays off.
      pitchAvgCents: (() => {
        const w = [];
        for (let i = 0; i + 4 <= out.length; i += 4) {
          const fr = analysis.frames.slice(i, i + 4);
          if (fr.every((x) => x.voiced)) w.push(Math.abs(fr.reduce((sum, x, j) => sum + 1200 * Math.log2(out[i + j].f0q / x.f0), 0) / 4));
        }
        return w.length ? w.reduce((a2, b2) => a2 + b2, 0) / w.length : 0;
      })(),
      writesPerFrame: writes / Math.max(1, out.length - 1),
      // Data before any compression: 14 bytes an update raw; or a 2-byte
      // mask of changed registers plus the changed bytes.
      bytesPerSecond: { raw: 14 * out.length / Math.max(1, out.length) * (analysis.options.updates || FRAME_RATE),
        changes: (2 * out.length + writes + regs.filter((f) => f.shape).length) / Math.max(1, out.length) * (analysis.options.updates || FRAME_RATE) },
      channelUse: use,
    };
  }

  // ----------------------------------------------------------- render

  // Ayumi advances the chip at most one step per internal sub-sample, so
  // below CLOCK / 64 (23,437.5 Hz) it loses steps and its interpolator runs
  // away (high-pitched noise). Low-rate clips (8-bit 11/22 kHz files) are
  // rendered at 44.1 kHz and resampled to their own rate.
  function render(regs, rate, AyumiClass, updates = FRAME_RATE, clock = CLOCK) {
    if (rate < clock / 64) {
      const high = render(regs, 44100, AyumiClass, updates, clock);
      const out = Float32Array.from(resample(high, 44100, rate));
      const want = Math.round(regs.length * rate / updates);
      return out.length === want ? out : (() => { const o = new Float32Array(want); o.set(out.subarray(0, want)); return o; })();
    }
    const Ay = AyumiClass || (typeof Ayumi !== "undefined" ? Ayumi : null);
    if (!Ay) throw new Error("ayumi.js is not loaded");
    const ay = new Ay();
    ay.configure(false, clock, rate);
    for (let i = 0; i < 3; i++) ay.setPan(i, PAN, false);
    const edge = (n) => Math.round(n * rate / updates);
    const out = new Float32Array(edge(regs.length));
    let k = 0;
    regs.forEach((frame, n) => {
      const r = frame.regs;
      for (let i = 0; i < 3; i++) {
        ay.setTone(i, r[2 * i] | ((r[2 * i + 1] & 0x0f) << 8));
        ay.setMixer(i, (r[7] >> i) & 1, (r[7] >> (i + 3)) & 1, (r[8 + i] >> 4) & 1);
        ay.setVolume(i, r[8 + i] & 0x0f);
      }
      ay.setNoise(r[6]);
      ay.setEnvelope(r[11] | (r[12] << 8));
      if (frame.shape) ay.setEnvelopeShape(r[13]);
      // Writes within the update (events: { t seconds after its start, reg, value }).
      const cur = r.slice(), ev = (frame.events || []).slice().sort((x, y) => x.t - y.t);
      const write = (reg, value) => {
        cur[reg] = value;
        if (reg === 6) ay.setNoise(value);
        else if (reg === 13) ay.setEnvelopeShape(value);
        else if (reg === 11 || reg === 12) ay.setEnvelope(cur[11] | (cur[12] << 8));
        else for (let i = 0; i < 3; i++) {
          ay.setTone(i, cur[2 * i] | ((cur[2 * i + 1] & 0x0f) << 8));
          ay.setMixer(i, (cur[7] >> i) & 1, (cur[7] >> (i + 3)) & 1, (cur[8 + i] >> 4) & 1);
          ay.setVolume(i, cur[8 + i] & 0x0f);
        }
      };
      let e = 0;
      for (let s = edge(n); s < edge(n + 1); s++) {
        while (e < ev.length && edge(n) + ev[e].t * rate <= s) { write(ev[e].reg, ev[e].value); e++; }
        ay.process();
        ay.removeDC();
        out[k++] = Math.max(-1, Math.min(1, ay.left * RENDER_GAIN));
      }
      while (e < ev.length) { write(ev[e].reg, ev[e].value); e++; }
    });
    return out;
  }

  // Per update: the rendered slot powers (m.A) and dB error (m.actual), as
  // the matcher saw it. Overall: both sounds measured on one grid (100 Hz,
  // 25 ms windows, whatever the update rate) so rates and settings compare
  // fairly; and the rendered pitch against the recording's (cents).
  const GRID = { updates: 100, windowMs: 25 };
  function evaluate(analysis, result, rendered, original) {
    const { rate } = analysis, g2 = (RENDER_GAIN * PAN) ** 2;   // rendered output to model units
    const spectrum = makeSpectrum(rate, analysis.options.windowMs), hop = rate / analysis.options.updates;
    result.frames.forEach((m, i) => {
      const A = slots(spectrum.at(rendered, (i + 0.5) * hop), analysis.binHz, m.base, m.count);
      m.A = Array.from(A, (a) => a / g2);
      m.actual = slotError(m.R, m.A, m.base, m.eps);
    });

    const grid = analyse(original, rate, { ...analysis.options, ...GRID, denoise: 0, consonantDb: 0, sharpen: 0 });   // the original, unprocessed
    const gridSpectrum = makeSpectrum(rate, GRID.windowMs), pitch = makePitch(rendered, rate, analysis.options);
    const ghop = rate / GRID.updates, errors = [], voicedErrors = [], peakErrors = [], cents = [], f1 = [], f2 = [];
    const low = decimate(rendered, rate);
    grid.frames.forEach((f, i) => {
      const base = f.voiced ? f.f0 : 150, count = Math.max(1, Math.min(120, Math.floor(analysis.options.fTop / base)));
      const R = slots(f.power, grid.binHz, base, count).map((r) => r * result.gain);
      const A = slots(gridSpectrum.at(rendered, (i + 0.5) * ghop), grid.binHz, base, count).map((a) => a / g2);
      if (f.gated) return;                          // under the gate: silent on purpose, not scored
      const e = slotError(R, A, base, result.eps);
      errors.push(e);
      peakErrors.push(slotError(R, A, base, Math.max(result.eps, maxOf(R) * Math.pow(10, -analysis.options.rangeDb / 10))));
      if (f.voiced) {
        voicedErrors.push(e);
        // Formants of the AY output against the recording's (LPC both).
        const fa = formantsOf(lpcAt(low.samples, low.rate, (i + 0.5) * ghop * low.rate / rate), low.rate);
        if (f.formants[0] && fa[0]) f1.push(Math.abs(fa[0] / f.formants[0] - 1));
        if (f.formants[1] && fa[1]) f2.push(Math.abs(fa[1] / f.formants[1] - 1));
        const p = pitch((i + 0.5) * ghop);
        if (p.clarity < analysis.options.voicing) cents.push(1200 * Math.log2(p.f0 / f.f0));
      }
    });
    const rms = (a) => Math.sqrt(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
    const abs = cents.map(Math.abs).sort((a, b) => a - b);
    return {
      renderedErrorDb: rms(errors),
      renderedVoicedErrorDb: rms(voicedErrors),
      renderedPeakErrorDb: rms(peakErrors),        // within rangeDb of each frame's loudest slot
      stoi: stoi(original, rendered, rate),           // intelligibility, 0..1 (see stoi)
      // Median relative error of the AY output's F1 and F2 (LPC) on voiced updates.
      formantError: { f1: f1.length ? median(f1) : null, f2: f2.length ? median(f2) : null, frames: Math.min(f1.length, f2.length), of: voicedErrors.length },
      // A pitch tracker on the AY output: octave slips on harmonic-rich frames count as misses.
      renderedPitchCents: { frames: abs.length, of: voicedErrors.length, median: abs.length ? abs[abs.length >> 1] : 0, within50: abs.filter((c) => c <= 50).length / Math.max(1, voicedErrors.length) },
    };
  }

  // Weighted mean squared dB difference of two slot-power lists.
  function slotError(R, A, base, eps) {
    let s = 0, ws = 0;
    for (let k = 0; k < R.length; k++) {
      const w = Math.min(1, 1000 / ((k + 1) * base));
      const d = 10 * Math.log10((R[k] + eps) / (A[k] + eps));
      s += w * d * d; ws += w;
    }
    return s / ws;
  }

  // ------------------------------------------------------------- STOI

  // Resample to `to` Hz with a windowed-sinc low-pass at 0.45 * to.
  function resample(x, from, to) {
    if (from === to) return Float64Array.from(x);
    const ratio = from / to, fc = 0.45 * to / from, half = Math.ceil(16 * Math.max(1, ratio));
    const out = new Float64Array(Math.floor(x.length / ratio));
    for (let n = 0; n < out.length; n++) {
      const t = n * ratio, c = Math.floor(t);
      let acc = 0;
      for (let i = c - half + 1; i <= c + half; i++) {
        if (i < 0 || i >= x.length) continue;
        const d = t - i, w = 0.5 + 0.5 * Math.cos(Math.PI * d / half);
        acc += x[i] * w * (d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d));
      }
      out[n] = acc;
    }
    return out;
  }

  // Short-time objective intelligibility (Taal, Hendriks, Heusdens, Jensen,
  // IEEE TASLP 19(7), 2011): how well the band envelopes of `processed`
  // follow those of `clean` over 384 ms. 0..1; 1 is identical. Silent frames
  // of `clean` (40 dB under its loudest) are removed from both first.
  const STOI = { rate: 10000, frame: 256, fft: 512, bands: 15, low: 150, segment: 30, beta: -15, range: 40 };
  let stoiBands = null;
  function stoi(clean, processed, rate) {
    const S = STOI, x = resample(clean, rate, S.rate), y = resample(processed, rate, S.rate);
    const len = Math.min(x.length, y.length), hop = S.frame / 2, win = new Float64Array(S.frame);
    for (let i = 0; i < S.frame; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (S.frame + 1));
    // Frames: drop those of the clean signal more than 40 dB under the loudest.
    const starts = [], energy = [];
    for (let s = 0; s + S.frame <= len; s += hop) {
      let e = 0;
      for (let i = 0; i < S.frame; i++) e += (x[s + i] * win[i]) ** 2;
      starts.push(s); energy.push(10 * Math.log10(e + 1e-20));
    }
    const top = maxOf(energy), keep = starts.filter((_, i) => energy[i] > top - S.range);
    // Overlap-add the kept frames back into continuous signals.
    const cut = (sig) => {
      const out = new Float64Array((keep.length + 1) * hop);
      keep.forEach((s, j) => { for (let i = 0; i < S.frame; i++) out[j * hop + i] += sig[s + i] * win[i]; });
      return out;
    };
    const xc = cut(x), yc = cut(y);
    // One-third-octave band edges in FFT bins.
    if (!stoiBands) {
      stoiBands = [];
      for (let j = 0; j < S.bands; j++) {
        const f = S.low * Math.pow(2, j / 3), lo = f * Math.pow(2, -1 / 6), hi = f * Math.pow(2, 1 / 6), hz = S.rate / S.fft;
        stoiBands.push([Math.round(lo / hz), Math.round(hi / hz)]);
      }
    }
    const tf = (sig) => {
      const frames = [], re = new Float64Array(S.fft), im = new Float64Array(S.fft);
      for (let s = 0; s + S.frame <= sig.length; s += hop) {
        re.fill(0); im.fill(0);
        for (let i = 0; i < S.frame; i++) re[i] = sig[s + i] * win[i];
        fft(re, im);
        frames.push(stoiBands.map(([lo, hi]) => { let e = 0; for (let k = lo; k < hi; k++) e += re[k] * re[k] + im[k] * im[k]; return Math.sqrt(e); }));
      }
      return frames;
    };
    const X = tf(xc), Y = tf(yc), M = Math.min(X.length, Y.length);
    if (M < S.segment) return null;
    const clip = 1 + Math.pow(10, -S.beta / 20);
    let total = 0, count = 0;
    for (let m = S.segment; m <= M; m++) {
      for (let j = 0; j < S.bands; j++) {
        const a = [], b = [];
        for (let t = m - S.segment; t < m; t++) { a.push(X[t][j]); b.push(Y[t][j]); }
        const na = Math.hypot(...a), nb = Math.hypot(...b);
        const c = b.map((v, t) => Math.min(nb > 0 ? v * na / nb : 0, a[t] * clip));
        const ma = a.reduce((u, v) => u + v, 0) / a.length, mc = c.reduce((u, v) => u + v, 0) / c.length;
        let num = 0, da = 0, dc = 0;
        for (let t = 0; t < a.length; t++) { num += (a[t] - ma) * (c[t] - mc); da += (a[t] - ma) ** 2; dc += (c[t] - mc) ** 2; }
        total += da > 0 && dc > 0 ? num / Math.sqrt(da * dc) : 0;
        count++;
      }
    }
    return total / count;
  }

  // A second recording made to line up with a clip for scoring: resampled to
  // the clip's rate, then cut or padded with silence to its length.
  function fitTo(samples, fromRate, toRate, length) {
    const x = fromRate === toRate ? samples : resample(samples, fromRate, toRate);
    const out = new Float32Array(length);
    out.set(x.length > length ? x.subarray(0, length) : x);
    return out;
  }

  // A then B for listening tests: each scaled to the same peak (0.9), with
  // `gap` seconds of silence between.
  function abSequence(a, b, rate, gap = 0.5) {
    const pa = maxOf(a.map(Math.abs), 1e-6), pb = maxOf(b.map(Math.abs), 1e-6), g = Math.round(gap * rate);
    const out = new Float32Array(a.length + g + b.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] * 0.9 / pa;
    for (let i = 0; i < b.length; i++) out[a.length + g + i] = b[i] * 0.9 / pb;
    return out;
  }

  // ------------------------------------------------------- player stream

  // The stream the 6809 player reads (vtx_voice_player.asm). Each update: a
  // 2-byte mask, high byte first (low byte bits 0-7 = R0-R7, high byte bits
  // 0-5 = R8-R13), then the values of the set registers in order R0..R13. A
  // register is sent when it differs from the last value sent (all of them on
  // the first update). R13 is sent only when the envelope must restart (the
  // update's `shape`): writing it restarts the envelope. $80 $00 ends it.
  function encodeStream(regs) {
    const out = [], last = new Array(14).fill(-1);
    for (const f of regs) {
      let mask = 0;
      const vals = [];
      for (let r = 0; r < 13; r++) if (f.regs[r] !== last[r]) { mask |= 1 << r; vals.push(f.regs[r]); last[r] = f.regs[r]; }
      if (f.shape) { mask |= 1 << 13; vals.push(f.regs[13]); }
      out.push(mask >> 8, mask & 0xff, ...vals);
    }
    out.push(0x80, 0x00);
    return Uint8Array.from(out);
  }

  // What the player leaves in the sound buffer after each update: the
  // registers, and whether R13 was written (the envelope restarted).
  function decodeStream(bytes) {
    const frames = [], regs = new Array(14).fill(0);
    let i = 0;
    for (;;) {
      const mask = (bytes[i] << 8) | bytes[i + 1];
      i += 2;
      if (mask & 0x8000) break;
      for (let r = 0; r < 14; r++) if (mask & (1 << r)) regs[r] = bytes[i++];
      frames.push({ regs: regs.slice(), shape: !!(mask & (1 << 13)) });
    }
    return frames;
  }

  // Updates [from, to) of a match's registers as a stream of their own: the
  // first update restarts the envelope (writes R13), since a part taken from
  // the middle would otherwise rely on a restart before it.
  function sliceRegs(regs, from = 0, to = regs.length) {
    const out = regs.slice(from, to);
    if (out.length) out[0] = { ...out[0], shape: true };
    return out;
  }

  // AS09 source for a stream: `label` then fcb lines, 16 bytes a line.
  function streamAsm(bytes, label) {
    const lines = [`${label}:`];
    for (let i = 0; i < bytes.length; i += 16) lines.push("        fcb    " + Array.from(bytes.slice(i, i + 16), (b) => "$" + b.toString(16).toUpperCase().padStart(2, "0")).join(","));
    return lines.join("\n") + "\n";
  }

  // Log-power spectrogram (100 columns a second, 0..topHz) for display.
  function spectrogram(samples, rate, topHz = 6000) {
    const size = 1024, hop = rate / 100, cols = Math.floor(samples.length / hop);
    const bins = Math.min(size / 2, Math.ceil(topHz * size / rate));
    const win = new Float64Array(size);
    for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
    const re = new Float64Array(size), im = new Float64Array(size), db = new Float32Array(cols * bins);
    for (let c = 0; c < cols; c++) {
      const start = Math.round(c * hop + hop / 2 - size / 2);
      for (let i = 0; i < size; i++) { const s = start + i; re[i] = s >= 0 && s < samples.length ? samples[s] * win[i] : 0; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < bins; b++) db[c * bins + b] = 10 * Math.log10(re[b] * re[b] + im[b] * im[b] + 1e-12);
    }
    return { cols, bins, db, hz: rate / size };
  }

  return { get CLOCK() { return CLOCK; }, MACHINES, setClock, setShape, stateKey, keyToEntry, dump, FRAME_RATE, DEFAULTS, LEVEL, readWav, writeWav, analyse, match, matchAsync, sliceRegs, render, evaluate, spectrogram, slots, epFor, pitchOf, tpFor,
    envTemplate, squareTemplate, noiseTemplate, noiseToneTemplate, ENV_MEAN_SQ, maxOf, stoi, fft, resample, preprocess, fitTo, abSequence, encodeStream, decodeStream, streamAsm };
});
