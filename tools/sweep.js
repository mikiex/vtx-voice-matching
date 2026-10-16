// Voice matching sweep: run named configurations on your own clips and rank
// them by intelligibility (STOI), with formant error, slot error and
// register writes. Noise vocoders (4, 8, 16 bands) are scored as reference
// points for the STOI scale.
//
//   node tools/sweep.js clips.json [--clips name,name] [--only config,config] [--wav] [--record]
//
// clips.json (see tools/clips.example.json): { "folder": "...", "clips": {
//   name: { "file": "...", "from": 0, "to": 10, "base": { "gateDb": 19 },
//           "speech": { "fmax": 400 } } } }. "base" holds the settings that suit
// the clip (the gate between background and voice); "speech" what speech mode
// adds (its pitch range).
// --wav writes every configuration's AY output to build/sweep/ for
// listening; --record merges the table into results/sweep.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
require(path.join(root, "vendor/ayumi.js"));
const VM = require(path.join(root, "js/core.js"));

let FOLDER = ".", CLIPS = {};
const SPEECH = { mode: "speech", voicing: 0.45, pitchSmooth: true };
// Configurations: free matching and speech mode, each with ablations.
const CONFIGS = {
  "free": {},
  "free no noise": { noise: false },
  "free no squares": { fixed: false },
  "free no bare buzz": { bare: false },
  "free smooth 10": { smooth: 10 },
  "free smooth 25": { smooth: 25 },
  "free range 20": { rangeDb: 20 },
  "free range 40": { rangeDb: 40 },
  "free no auto level": { autoLevel: false },
  "free 100 Hz": { updates: 100 },
  "free gate off": { gateDb: 60 },
  "speech": { ...SPEECH },
  "speech no squares": { ...SPEECH, fixed: false },
  "speech no C": { ...SPEECH, channels: [true, true, false] },
  "speech no noise": { ...SPEECH, noise: false },
  "speech smooth 10": { ...SPEECH, smooth: 10 },
  "speech smooth 25": { ...SPEECH, smooth: 25 },
  "speech 100 Hz": { ...SPEECH, updates: 100 },
  "speech 200 Hz": { ...SPEECH, updates: 200 },
  "speech gate off": { ...SPEECH, gateDb: 60 },
  // Preprocessing of the target (scored against the original).
  "free denoise 2": { denoise: 2 },
  "free denoise 4": { denoise: 4 },
  "free consonants 6": { consonantDb: 6 },
  "free consonants 12": { consonantDb: 12 },
  "free sharpen 0.5": { sharpen: 0.5 },
  "free sharpen 1": { sharpen: 1 },
  "free denoise 2 + consonants 6 + sharpen 0.5": { denoise: 2, consonantDb: 6, sharpen: 0.5 },
  "speech denoise 2": { ...SPEECH, denoise: 2 },
  "speech consonants 6": { ...SPEECH, consonantDb: 6 },
  "speech sharpen 0.5": { ...SPEECH, sharpen: 0.5 },
  "speech denoise 2 + consonants 6 + sharpen 0.5": { ...SPEECH, denoise: 2, consonantDb: 6, sharpen: 0.5 },
};

function args(argv) {
  const o = { clips: null, only: null, wav: false, record: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--") && !o.config) o.config = argv[i];
    else if (argv[i] === "--clips") o.clips = argv[++i].split(",");
    else if (argv[i] === "--only") o.only = argv[++i].split(",");
    else if (argv[i] === "--wav") o.wav = true;
    else if (argv[i] === "--record") o.record = true;
    else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
  }
  if (!o.config) { console.error("usage: node tools/sweep.js clips.json [--clips a,b] [--only config,config] [--wav] [--record]"); process.exit(2); }
  const cfg = JSON.parse(fs.readFileSync(o.config, "utf8"));
  FOLDER = path.resolve(path.dirname(o.config), cfg.folder || ".");
  CLIPS = cfg.clips;
  o.clips = o.clips || Object.keys(CLIPS);
  return o;
}

// Noise vocoder: each frame's power in `bands` log-spaced bands (100 Hz to
// 8 kHz) carried by white noise; overlap-added. A reference with known
// intelligibility (8 bands is largely intelligible for speech).
function vocode(x, rate, bands, seed = 1) {
  const N = 1024, hop = 256, win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const top = Math.min(8000, rate / 2 - 1), edges = [];
  for (let j = 0; j <= bands; j++) edges.push(Math.round(100 * Math.pow(top / 100, j / bands) * N / rate));
  let r = seed;
  const rand = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x40000000 - 1; };
  const out = new Float64Array(x.length), norm = new Float64Array(x.length);
  const sr = new Float64Array(N), si = new Float64Array(N), nr = new Float64Array(N), ni = new Float64Array(N);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += hop) {
    si.fill(0); ni.fill(0); re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) { sr[i] = x[s + i] * win[i]; nr[i] = rand() * win[i]; }
    VM.fft(sr, si); VM.fft(nr, ni);
    for (let j = 0; j < bands; j++) {
      // Band power of the speech and of the noise; scale the noise to it.
      let ex = 0, en = 0;
      const lo = Math.max(1, edges[j]), hi = Math.min(N / 2, edges[j + 1]);
      for (let k = lo; k < hi; k++) { ex += sr[k] ** 2 + si[k] ** 2; en += nr[k] ** 2 + ni[k] ** 2; }
      const g = en > 0 ? Math.sqrt(ex / en) : 0;
      for (let k = lo; k < hi; k++) { re[k] = nr[k] * g; im[k] = ni[k] * g; }
    }
    // Inverse FFT of the half spectrum made Hermitian: conj, fft, conj, /N.
    for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    for (let k = 0; k < N; k++) im[k] = -im[k];
    VM.fft(re, im);
    for (let i = 0; i < N; i++) { out[s + i] += (re[i] / N) * win[i]; norm[s + i] += win[i] * win[i]; }
  }
  for (let i = 0; i < out.length; i++) out[i] = norm[i] > 1e-6 ? out[i] / norm[i] : 0;
  return out;
}

function main() {
  const o = args(process.argv.slice(2));
  const out = path.join(root, "build/sweep");
  if (o.wav) fs.mkdirSync(out, { recursive: true });
  const results = {};
  for (const name of o.clips) {
    const clip = CLIPS[name];
    const { rate, samples } = VM.readWav(new Uint8Array(fs.readFileSync(path.join(FOLDER, clip.file))), clip.from, clip.to);
    const rows = [];
    for (const bands of [4, 8, 16]) {
      const v = vocode(samples, rate, bands);
      rows.push({ config: `reference: noise vocoder ${bands} bands`, stoi: VM.stoi(samples, v, rate) });
      if (o.wav) {
        const peak = VM.maxOf(v.map(Math.abs));
        fs.writeFileSync(path.join(out, `${name}_vocoder${bands}.wav`), VM.writeWav(Float32Array.from(v, (s) => s * 0.9 / peak), rate));
      }
    }
    const analyses = new Map();
    for (const [config, extra] of Object.entries(CONFIGS)) {
      if (o.only && !o.only.includes(config)) continue;
      const opts = { ...clip.base, ...(extra.mode === "speech" ? clip.speech : {}), ...extra };
      const key = JSON.stringify([opts.updates || 50, opts.mode || "match", opts.fmax, opts.voicing, opts.pitchSmooth, opts.gateDb, opts.denoise, opts.consonantDb, opts.sharpen]);
      const t0 = Date.now();
      if (!analyses.has(key)) analyses.set(key, VM.analyse(samples, rate, opts));
      const analysis = analyses.get(key), result = VM.match(analysis, opts);
      const rendered = VM.render(result.regs, rate, Ayumi, result.updates, result.clock);
      const m = VM.evaluate(analysis, result, rendered, samples);
      const row = {
        config, stoi: m.stoi, peakErrorDb: m.renderedPeakErrorDb, f1: m.formantError.f1, f2: m.formantError.f2,
        writesPerSecond: result.stats.writesPerFrame * result.updates, channelUse: result.stats.channelUse, ms: Date.now() - t0,
      };
      rows.push(row);
      if (o.wav) fs.writeFileSync(path.join(out, `${name}_${config.replace(/ /g, "_")}.wav`), VM.writeWav(rendered, rate));
      console.error(`${name}: ${config} ${row.stoi.toFixed(3)} (${row.ms} ms)`);
    }
    rows.sort((a, b) => b.stoi - a.stoi);
    results[name] = { file: clip.file, from: clip.from, to: clip.to, settings: clip.base, rows };
    const pct = (v) => (v === null || v === undefined ? "" : `${Math.round(100 * v)}%`);
    console.log(`\n${name} (${clip.file}, ${clip.from}-${clip.to} s)\n`);
    console.log("| configuration | STOI | peak dB | F1 | F2 | writes/s |\n|---|---|---|---|---|---|");
    for (const r of rows) console.log(`| ${r.config} | ${r.stoi.toFixed(3)} | ${r.peakErrorDb ? r.peakErrorDb.toFixed(2) : ""} | ${pct(r.f1)} | ${pct(r.f2)} | ${r.writesPerSecond ? Math.round(r.writesPerSecond) : ""} |`);
  }
  if (o.record) {
    // Merge into the recorded table: rows are replaced by clip and
    // configuration name, so a partial sweep keeps the other rows.
    const file = path.join(root, "results/sweep.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { results: {} };
    for (const [name, r] of Object.entries(results)) {
      const rows = new Map(((old.results[name] || {}).rows || []).map((row) => [row.config, row]));
      for (const row of r.rows) rows.set(row.config, row);
      old.results[name] = { ...r, rows: [...rows.values()].sort((a, b) => b.stoi - a.stoi) };
    }
    fs.writeFileSync(file, JSON.stringify({ tool: "tools/sweep.js", host: "Ayumi (no Vectrex)", metric: "STOI (Taal et al. 2011)", results: old.results }, null, 1) + "\n");
    console.log(`\nrecorded ${path.relative(root, file)}`);
  }
}

main();
