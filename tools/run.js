// Voice matching from the command line: the same core as the web page.
//
//   node tools/run.js <recording.wav> [--from 0] [--to 5]
//        [--updates 50|100|200] [--smooth 10] [--level 0] [--channels ABC]
//        [--no-fixed] [--no-noise] [--no-bare] [--speech] [--gateDb 30] [--reference other.wav]
//        [--out build/out]
//
// --reference: also score STOI against a second recording of the same words
// (for example a cleaned-up copy), lined up to the clip's rate and length.
//
// --speech: speech mode (LPC formants guide A/B, noise only when unvoiced,
// pitch 60-400 Hz smoothed); set --gateDb under the voice, above the background.
//
// --machine vectrex|spectrum|cpc|msx|st sets the AY clock (default vectrex, 1.5 MHz).
//
// Writes original.wav, ay.wav, ab.wav (the recording then the AY), registers.bin
// (14 bytes an update, R0..R13; R13 $FF = do not write), frames.json (registers per update) and
// compare.png (recording above, AY below, 0-6 kHz, pitch in white) to --out,
// and prints the measurements as JSON.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
require(path.join(root, "vendor/ayumi.js"));
const VM = require(path.join(root, "js/core.js"));

function args(argv) {
  const o = { out: path.join(root, "build/out") }, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-fixed") o.fixed = false;
    else if (a === "--no-noise") o.noise = false;
    else if (a === "--no-bare") o.bare = false;
    else if (a === "--speech") Object.assign(o, { mode: "speech", fmax: 400, voicing: 0.45, pitchSmooth: true });
    else if (a === "--channels") o.channels = ["A", "B", "C"].map((c) => argv[++i].toUpperCase().includes(c));
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--reference") o.reference = argv[++i];
    else if (a === "--triangle") o.envShape = "triangle";
    else if (a === "--segments") o.envShape = "segments";
    else if (a === "--machine") { const m = VM.MACHINES[argv[++i]]; if (!m) { console.error(`machines: ${Object.keys(VM.MACHINES).join(", ")}`); process.exit(2); } o.clock = m.clock; }
    else if (a === "--level") o.levelDb = Number(argv[++i]);
    else if (a.startsWith("--")) o[a.slice(2)] = Number(argv[++i]);
    else rest.push(a);
  }
  if (rest.length !== 1) {
    console.error("usage: node tools/run.js <recording.wav> [--from S] [--to S] [--updates 50|100|200] ...");
    process.exit(2);
  }
  o.wav = rest[0];
  return o;
}

// Colour PNG: recording spectrogram above, AY below, pitch tracks in white.
function png(file, a, b, f0a, f0b, updates) {
  const width = a.cols, gap = 4, height = 2 * a.bins + gap, px = Buffer.alloc((width * 3 + 1) * height);
  const top = VM.maxOf(a.db), floor = top - 70;
  const colour = (d) => {
    const t = Math.max(0, Math.min(1, (d - floor) / (top - floor)));
    return [Math.round(255 * Math.min(1, t * 1.6)), Math.round(255 * Math.max(0, t * 1.6 - 0.5)), Math.round(255 * (t < 0.5 ? t : 1 - t))];
  };
  const set = (x, y, c) => { if (x >= 0 && x < width && y >= 0 && y < height) c.forEach((v, i) => { px[y * (width * 3 + 1) + 1 + x * 3 + i] = v; }); };
  [a, b].forEach((s, panel) => {
    const y0 = panel * (a.bins + gap);
    for (let x = 0; x < Math.min(width, s.cols); x++) for (let k = 0; k < a.bins; k++) set(x, y0 + a.bins - 1 - k, colour(s.db[x * s.bins + k]));
    const f0 = panel ? f0b : f0a;
    for (let x = 0; x < width; x++) {
      const f = f0[Math.floor(x * updates / 100)];
      if (f) set(x, y0 + a.bins - 1 - Math.round(f / a.hz), [255, 255, 255]);
    }
  });
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]), sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(px)), chunk("IEND", Buffer.alloc(0))]));
}

function main() {
  const o = args(process.argv.slice(2));
  const { rate, samples, seconds } = VM.readWav(new Uint8Array(fs.readFileSync(o.wav)), o.from ?? 0, o.to ?? 5);
  const started = Date.now();
  const analysis = VM.analyse(samples, rate, o);
  const result = VM.match(analysis);
  const rendered = VM.render(result.regs, rate, Ayumi, result.updates, result.clock);
  const measured = VM.evaluate(analysis, result, rendered, samples);
  if (o.reference) {
    const r = VM.readWav(new Uint8Array(fs.readFileSync(o.reference)), o.from ?? 0, o.to ?? 5);
    const ref = VM.fitTo(r.samples, r.rate, rate, samples.length);
    measured.reference = { file: path.basename(o.reference), stoi: VM.stoi(ref, rendered, rate), inputStoi: VM.stoi(ref, samples, rate) };
  }
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, "original.wav"), VM.writeWav(samples, rate));
  fs.writeFileSync(path.join(o.out, "ay.wav"), VM.writeWav(rendered, rate));
  fs.writeFileSync(path.join(o.out, "registers.bin"), VM.dump(result.regs));   // 14 bytes an update, R13 $FF = leave
  fs.writeFileSync(path.join(o.out, "ab.wav"), VM.writeWav(VM.abSequence(samples, rendered, rate), rate));   // recording, then AY
  fs.writeFileSync(path.join(o.out, "frames.json"), JSON.stringify({
    source: path.basename(o.wav), from: o.from ?? 0, to: o.to ?? 5, updates: result.updates,
    frames: result.regs.map((f, i) => ({ regs: f.regs, shape: f.shape, state: result.frames[i].state })),
  }));
  const f0a = analysis.frames.map((f) => (f.voiced ? f.f0 : 0)), f0b = result.frames.map((f, i) => (analysis.frames[i].voiced ? f.f0q : 0));
  png(path.join(o.out, "compare.png"), VM.spectrogram(samples, rate), VM.spectrogram(rendered, rate), f0a, f0b, result.updates);
  console.log(JSON.stringify({ recordingSeconds: +seconds.toFixed(1), ...result.stats, ...measured, ms: Date.now() - started, out: o.out }, null, 1));
}

main();
