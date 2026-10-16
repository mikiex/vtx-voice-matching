// Drives the voice matching page in headless Chrome over the DevTools
// protocol (Node 22+, no packages): load a WAV through the file input, match,
// switch update rate, inspect a frame, with no page errors.
//
//   node test/browser.mjs <wav> <screenshot dir> [cdp port]
//
// The WAV is any recording; test/core.test.js makes a
// synthetic one. Screenshots go to the given directory (use build/).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The pages are served over http, as on GitHub Pages (the examples are fetched).
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wav": "audio/wav", ".json": "application/json" };
const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`, PAGE = BASE + "tool.html";
const CANDIDATES = [process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
const CHROME = CANDIDATES.find((c) => c && fs.existsSync(c));
if (!CHROME) { console.error("no Chrome or Edge found (set CHROME)"); process.exit(2); }
const [WAV, OUT] = [path.resolve(process.argv[2]), process.argv[3]];
const PORT = Number(process.argv[4] || 9341);
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-vm-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1400,1100", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const waiting = new Map(), errors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || "exception");
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push(d.params.entry.text);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  };
}
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
async function until(expr, what, ms = 30000) {
  for (let t = 0; t < ms; t += 100) { if (await js(expr)) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}: status "${await js("document.querySelector('#status').textContent")}"`);
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, "base64"));
}
let checks = 0;
function check(ok, what) { if (!ok) throw new Error(`check failed: ${what}`); checks++; console.log(`ok   ${what}`); }
const done = "/updates in/.test(document.querySelector('#status').textContent)";

try {
  await connect();
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("DOM.enable");
  await send("Page.navigate", { url: PAGE });
  await until("document.readyState === 'complete' && window.VoiceMatching && window.Ayumi", "the page and Ayumi");
  check(await js("document.querySelector('#go').disabled"), "Match waits for a file");

  const doc = await send("DOM.getDocument");
  const input = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#file" });
  await send("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [WAV] });
  await until("!document.querySelector('#go').disabled", "the file to load");
  await js("document.querySelector('#to').value = 1.5; document.querySelector('#go').click()");
  await until(done, "matching");
  check(await js("document.querySelector('#status').textContent.startsWith('75 updates')"), "1.5 s at 50 Hz is 75 updates");
  check(await js("document.querySelector('#stats').textContent.includes('Error, rendered')"), "results are shown");
  check(await js("document.querySelector('#specAy').width > 100 && document.querySelector('#lanes').width === 75"), "spectrograms and lanes are drawn");
  check(await js("!document.querySelector('#playAy').disabled && !document.querySelector('#saveFrames').disabled && !document.querySelector('#playSeq').disabled && !document.querySelector('#saveSeq').disabled"), "listening and saving are enabled (including recording then AY)");
  await shot("voice_matching_50hz.png");

  // A frame in the middle: its slots and registers.
  await js("{ const c = document.querySelector('#specAy'), r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width / 2, clientY: r.top + 10, bubbles: true })); }");
  await until("document.querySelector('#frameText').textContent.includes('update 37')", "frame 37");
  check(await js("/R0–R13: ([0-9a-f]{2} ){13}[0-9a-f]{2}/.test(document.querySelector('#frameText').textContent)"), "the frame shows 14 registers");

  // Settings do not regenerate by themselves: they mark the result dirty.
  await js("document.querySelector('#updates [data-v=\"200\"]').click()");
  await sleep(600);
  check(await js("document.querySelector('#go').classList.contains('dirty') && !document.querySelector('#dirtyNote').hidden && document.querySelector('#go').textContent === 'Regenerate'"), "a setting marks the result dirty");
  check(await js("document.querySelector('#lanes').width === 75"), "nothing regenerates until asked");
  // Regenerate at 200 Hz re-analyses: four times as many updates.
  await js("document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching at 200 Hz");
  check(await js("!document.querySelector('#go').classList.contains('dirty') && document.querySelector('#dirtyNote').hidden"), "regenerating clears dirty");
  check(await js("document.querySelector('#status').textContent.startsWith('300 updates')"), "200 Hz is 300 updates");

  // A slider: dirty, then Regenerate.
  await js("const s = document.querySelector('#smooth'); s.value = 30; s.dispatchEvent(new Event('input'))");
  check(await js("document.querySelector('#status').textContent.startsWith('settings changed')"), "the status says to regenerate");
  await js("document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "re-matching after a slider");
  check(true, "smoothness applies on Regenerate");
  await shot("voice_matching_200hz.png");

  // Speech mode sets its pitch range and applies on Regenerate.
  await js("document.querySelector('#mode [data-v=\"speech\"]').click()");
  check(await js("document.querySelector('#fmax').value === '400' && document.querySelector('#go').classList.contains('dirty')"), "Speech sets its pitch range and marks dirty");
  await js("document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching in speech mode");
  check(await js("/Formant error/.test(document.querySelector('#stats').textContent) && document.querySelector('#frameText').textContent.includes('F1/F2/F3')"), "speech mode shows formants");
  await shot("voice_matching_speech.png");

  // Preprocessing changes the target: Regenerate, then the Target player is on.
  // The page opens with denoise 4 (the film-line setting): turn it off first.
  await js("const d0 = document.querySelector('#denoise'); d0.value = 0; d0.dispatchEvent(new Event('input')); document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching without preprocessing");
  check(await js("document.querySelector('#playTarget').disabled"), "no target without preprocessing");
  await js("const d = document.querySelector('#denoise'); d.value = 2; d.dispatchEvent(new Event('input')); document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching with denoise");
  check(await js("!document.querySelector('#playTarget').disabled"), "denoise gives a target to play");

  // A second recording to score against: here the same file, so its score
  // equals the input's. Clearing it removes the row.
  const ref = await send("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: "#refFile" });
  await send("DOM.setFileInputFiles", { nodeId: ref.result.nodeId, files: [WAV] });
  await until("document.querySelector('#go').classList.contains('dirty')", "the reference marking dirty");
  await js("document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching with a reference");
  check(await js("!document.querySelector('#playRef').hidden && /vs /.test(document.querySelector('#stats').textContent) && /the input itself: 1\.000/.test(document.querySelector('#stats').textContent)"), "the reference row shows (input scores 1.000 against itself)");
  await js("document.querySelector('#refClear').click(); document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching without the reference");
  check(await js("document.querySelector('#playRef').hidden && !/the input itself/.test(document.querySelector('#stats').textContent)"), "clearing the reference removes it");

  // Recording: Chrome's fake microphone (a beep), two seconds, then Match.
  await js("document.querySelector('#record').click()");
  await until("/recording…/.test(document.querySelector('#status').textContent)", "recording to start");
  await sleep(2000);
  await js("document.querySelector('#record').click()");
  await until("/recorded/.test(document.querySelector('#status').textContent)", "the recording");
  await js("document.querySelector('#to').value = 1.5; document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching the recording");
  check(await js("/^[0-9]+ updates/.test(document.querySelector('#status').textContent)"), "a microphone recording matches");

  // A long clip (when the file has it): no argument-limit errors drawing it.
  if (process.env.VM_LONG) {
    await js("document.querySelector('#to').value = " + Number(process.env.VM_LONG) + "; document.querySelector('#to').dispatchEvent(new Event('input')); document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
    await until(done, "matching a long clip", 600000);
    check(true, `${process.env.VM_LONG} s matches and draws`);
  }

  // A bundled example: loads, sets its suggested settings, matches.
  await js("document.querySelector('#updates [data-v=\"50\"]').click()");
  await js("const e = document.querySelector('#example'); e.value = 'examples/gettysburg_address_opening.wav'; e.dispatchEvent(new Event('change'))");
  await until("/suggested/.test(document.querySelector('#status').textContent)", "the example to load");
  check(await js("document.querySelector('#gateDb').value === '60' && document.querySelector('#denoise').value === '0'"), "the example sets its gate and denoise");
  await js("document.querySelector('#status').textContent = ''; document.querySelector('#go').click()");
  await until(done, "matching the example", 120000);
  const exampleStatus = await js("document.querySelector('#status').textContent");
  check(/^420 updates/.test(exampleStatus), `the 8.4 s example is 420 updates (${exampleStatus})`);
  await shot("example.png");

  // Phone width: neither page scrolls sideways (the nav strip and wide
  // tables scroll inside their own boxes).
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const page of ["index.html", "tool.html"]) {
    await send("Page.navigate", { url: BASE + page });
    await until("document.readyState === 'complete'", page);
    await sleep(300);
    const wide = await js("(() => { const W = document.documentElement.clientWidth; return [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1 && !(function scrolls(n) { for (let p = n.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; })(e)).slice(0, 8).map((e) => e.tagName + (e.id ? '#' + e.id : '') + ' ' + Math.round(e.getBoundingClientRect().right)); })()");
    await shot(`phone_${page.replace('.html', '')}.png`);
    check(wide.length === 0 && await js("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), `${page}: nothing wider than 390 px${wide.length ? ": " + wide.join(", ") : ""}`);
  }

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join("; ") : ""}`);
  console.log(`all passed (${checks}); screenshots in ${OUT}`);
} catch (e) {
  console.error(e.message);
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  ws?.close();
  chrome.kill();
  server.close();
}
