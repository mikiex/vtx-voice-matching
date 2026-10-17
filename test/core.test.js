// Voice matching core: the WAV reader, and a round trip on a synthetic AY
// voice whose registers are known (the pitch must come back exactly).
//
//   node test/core.test.js [synthetic.wav to write]
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
require(path.join(root, "vendor/ayumi.js"));
const VM = require(path.join(root, "js/core.js"));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok   ${name}`); }

test("a streamed 24-bit stereo WAV (data size 0xFFFFFFFF) reads as mono", () => {
  const frames = 480, bytes = new Uint8Array(44 + frames * 6), v = new DataView(bytes.buffer);
  const put = (o, s) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); v.setUint32(4, 0xffffffff, true); put(8, "WAVE");
  put(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, 48000, true); v.setUint32(28, 48000 * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true);
  put(36, "data"); v.setUint32(40, 0xffffffff, true);
  const put24 = (o, x) => { const n = Math.round(x * 8388607); bytes[o] = n & 0xff; bytes[o + 1] = (n >> 8) & 0xff; bytes[o + 2] = (n >> 16) & 0xff; };
  for (let i = 0; i < frames; i++) { put24(44 + i * 6, 0.5); put24(47 + i * 6, -0.25); }
  const w = VM.readWav(bytes, 0.005, 0.01);
  assert.strictEqual(w.rate, 48000);
  assert.strictEqual(w.samples.length, 240);
  assert.ok(Math.abs(w.samples[0] - 0.125) < 1e-5);
});

// A voice the AY can make exactly: a glide from 150 to 260 Hz, the envelope
// on A with a tone at harmonic 3, a fixed square at harmonic 7 on B, a
// noise burst in the middle.
const RATE = 44100, UPDATES = 50, SECONDS = 2;
const truth = [];
for (let i = 0; i < SECONDS * UPDATES; i++) {
  const f0 = 150 * Math.pow(260 / 150, i / (SECONDS * UPDATES - 1)), ep = VM.epFor(f0), r = new Array(14).fill(0);
  const noisy = i >= 45 && i < 55;
  const a = VM.tpFor(ep, 3), b = VM.tpFor(ep, 7);
  r[0] = a & 0xff; r[1] = a >> 8; r[2] = b & 0xff; r[3] = b >> 8;
  r[6] = 4;
  r[7] = noisy ? 0x1c : 0x3c;     // tones A, B on; noise on C in the burst
  r[8] = 0x10; r[9] = 12; r[10] = noisy ? 13 : 0;
  r[11] = ep & 0xff; r[12] = ep >> 8; r[13] = 8;
  truth.push({ regs: r, shape: i === 0, ep });
}
const samples = VM.render(truth, RATE, Ayumi, UPDATES);
if (process.argv[2]) {
  fs.mkdirSync(path.dirname(process.argv[2]), { recursive: true });
  fs.writeFileSync(process.argv[2], VM.writeWav(samples, RATE));
}

test("the pitch comes back as the same envelope period", () => {
  const analysis = VM.analyse(samples, RATE, {});
  const inner = analysis.frames.filter((f, i) => i >= 2 && i < truth.length - 2 && (i < 43 || i >= 57));   // not the noise burst
  const voiced = inner.filter((f) => f.voiced).length;
  assert.ok(voiced >= 0.9 * inner.length, `voiced ${voiced} of ${inner.length}`);
  const result = VM.match(analysis, {});
  let same = 0, counted = 0;
  analysis.frames.forEach((f, i) => { if (f.voiced && i >= 2 && i < truth.length - 2) { counted++; if (result.frames[i].ep === truth[i].ep) same++; } });
  assert.ok(same >= 0.95 * counted, `EP exact on ${same} of ${counted}`);
});

test("the AY's own voice matches closely, at 50, 100 and 200 Hz", () => {
  for (const updates of [50, 100, 200]) {
    const analysis = VM.analyse(samples, RATE, { updates });
    // Smoothness 10: this checks the model on a steady AY sound, where the
    // default 0 (best for real speech) flickers between near-equal settings.
    const result = VM.match(analysis, { smooth: 10 });
    const rendered = VM.render(result.regs, RATE, Ayumi, result.updates);
    const m = VM.evaluate(analysis, result, rendered, samples);
    assert.strictEqual(result.frames.length, SECONDS * updates);
    assert.ok(m.renderedPeakErrorDb < 4, `${updates} Hz: peak error ${m.renderedPeakErrorDb.toFixed(2)} dB`);
    console.log(`     ${updates} Hz: peak error ${m.renderedPeakErrorDb.toFixed(2)} dB, all ${m.renderedErrorDb.toFixed(2)} dB`);
  }
});

test("register frames are well formed", () => {
  const result = VM.match(VM.analyse(samples, RATE, {}), {});
  assert.strictEqual(result.regs.filter((f) => f.shape).length, 1, "R13 is written once");
  for (const f of result.regs) {
    assert.strictEqual(f.regs.length, 14);
    assert.ok(f.regs.every((r) => Number.isInteger(r) && r >= 0 && r <= 255));
    assert.strictEqual(f.regs[7] & 0xc0, 0, "R7 port bits are left clear");
  }
});

test("STOI: 1 for the same sound, blind to level, lower with noise and delay", () => {
  const louder = samples.map((v) => v * 3);
  let r = 7;
  const noisy = samples.map((v) => { r = (r * 1103515245 + 12345) & 0x7fffffff; return v + 0.2 * (r / 0x40000000 - 1); });
  const late = new Float32Array(samples.length);
  late.set(samples.subarray(0, samples.length - 8820), 8820);
  assert.ok(Math.abs(VM.stoi(samples, samples, RATE) - 1) < 1e-9, "same sound");
  assert.ok(Math.abs(VM.stoi(samples, louder, RATE) - 1) < 1e-9, "level");
  const n = VM.stoi(samples, noisy, RATE), d = VM.stoi(samples, late, RATE);
  assert.ok(n < 0.95 && n > d, `noise ${n.toFixed(3)}, 200 ms late ${d.toFixed(3)}`);
});

test("rendering below 23.4 kHz (8-bit 11/22 kHz clips) matches a 44.1 kHz render", () => {
  // Ayumi loses steps below CLOCK/64; render() goes through 44.1 kHz instead.
  for (const rate of [22050, 11025]) {
    const low = VM.render(truth, rate, Ayumi, UPDATES);
    const ref = Float32Array.from(VM.resample(VM.render(truth, 44100, Ayumi, UPDATES), 44100, rate));
    assert.strictEqual(low.length, Math.round(truth.length * rate / UPDATES));
    const s = VM.stoi(ref, low, rate);
    assert.ok(s > 0.99, `${rate} Hz: STOI against the 44.1 kHz render ${s.toFixed(3)}`);
  }
});

test("preprocessing: transparent when off; denoise removes a steady background", () => {
  const off = VM.preprocess(samples, RATE, { denoise: 0, consonantDb: 0, sharpen: 0 });
  let e = 0, n = 0;
  for (let i = 0; i < samples.length; i++) { e += (off[i] - samples[i]) ** 2; n += samples[i] ** 2; }
  assert.ok(10 * Math.log10(e / n) < -100, "rebuilt exactly");
  // The synthetic voice with half a second of silence before it, over a hum.
  const lead = RATE / 2, x = new Float32Array(lead + samples.length);
  x.set(samples, lead);
  for (let i = 0; i < x.length; i++) x[i] += 0.02 * Math.sin(2 * Math.PI * 300 * i / RATE);
  const y = VM.preprocess(x, RATE, { denoise: 2, consonantDb: 0, sharpen: 0 });
  const rms = (a, from, to) => { let s2 = 0; for (let i = from; i < to; i++) s2 += a[i] * a[i]; return Math.sqrt(s2 / (to - from)); };
  const before = rms(x, 2000, lead - 2000), after = rms(y, 2000, lead - 2000);
  assert.ok(20 * Math.log10(after / before) < -15, `hum lowered ${(20 * Math.log10(after / before)).toFixed(1)} dB`);
});

test("per-stretch envelope shapes: each gated tone's period follows its own update's shape", () => {
  // A triangle cycle is 64 steps, a sawtooth 32: a tone locked to harmonic n
  // has period steps * EP / (2 n). Registers once used the global shape.
  const analysis = VM.analyse(samples, RATE, {});
  const r = VM.match(analysis, { envShape: "segments", segmentShapes: ["triangle"] });
  let checked = 0;
  r.frames.forEach((f, i) => f.state.ch.forEach((c, ch) => {
    if (c.kind !== "env" || !c.n) return;
    const tp = r.regs[i].regs[2 * ch] | (r.regs[i].regs[2 * ch + 1] << 8);
    assert.strictEqual(tp, Math.round(64 * f.ep / (2 * c.n)), `update ${i}, channel ${ch}`);
    assert.strictEqual(r.regs[i].regs[13], 10);
    checked++;
  }));
  assert.ok(checked > 0, "some envelope-gated tones were checked");
});

test("writes within an update (events) take effect at their time", () => {
  // One update of a square on A; the volume drops to 0 at 10 ms by an event.
  const tp = 200, regs = [0, 0, 0].map(() => new Array(14).fill(0));
  regs.forEach((r) => { r[0] = tp; r[7] = 0x3e; r[8] = 15; });
  const frames = regs.map((r, i) => ({ regs: r, shape: false, events: i === 1 ? [{ t: 0.010, reg: 8, value: 0 }] : undefined }));
  const x = VM.render(frames, 44100, Ayumi, 50);
  // Variance, not power: Ayumi's DC filter (1,024 samples) leaves a slow drift after the sound stops.
  const level = (from, to) => {
    const seg = Array.from(x.subarray(Math.round(from * 44100), Math.round(to * 44100))), m = seg.reduce((u, v) => u + v, 0) / seg.length;
    return seg.reduce((u, v) => u + (v - m) ** 2, 0) / seg.length;
  };
  assert.ok(level(0.022, 0.029) > 1e-4, "sounding before the event");
  assert.ok(level(0.032, 0.039) < level(0.022, 0.029) / 100, "silent after the event (10 ms into update 1)");
});

console.log(`all passed (${passed})`);
