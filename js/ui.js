// Voice matching page: load a recording, match, listen, inspect frames.
"use strict";
(function () {
  const VM = window.VoiceMatching, $ = (id) => document.getElementById(id);
  const S = { mode: "match", bytes: null, name: "", clip: null, analysis: null, analysisKey: "", result: null, rendered: null, measured: null, frame: 0, updates: 50 };
  let audio = null, source = null, timer = 0;

  const status = (text) => { $("status").textContent = text; };
  const sliders = ["denoise", "consonantDb", "sharpen", "gateDb", "noiseTrim", "brightNoiseBoost", "overshoot", "smooth", "levelDb", "floorDb", "rangeDb", "fTop", "voicing", "fmin", "fmax"];
  const analysisKeys = ["voicing", "fmin", "fmax", "gateDb", "mode", "pitchSmooth", "denoise", "consonantDb", "sharpen"];

  function options() {
    const o = { clock: VM.MACHINES[$("machine").value].clock, mode: S.mode, pitchSmooth: S.mode === "speech", updates: S.updates, channels: ["chA", "chB", "chC"].map((id) => $(id).checked),
      bare: $("bare").checked, fixed: $("fixed").checked, noise: $("noise").checked, exactSquares: $("exactSquares").checked, noiseTone: $("noiseTone").checked };
    for (const id of sliders) o[id] = Number($(id).value);
    return o;
  }

  // ------------------------------------------------------------ loading

  $("file").onchange = async () => {
    const f = $("file").files[0];
    if (!f) return;
    S.bytes = new Uint8Array(await f.arrayBuffer());
    S.name = f.name.replace(/\.[^.]+$/, "");
    S.clip = null;
    $("go").disabled = false;
    setDirty(false);
    status(`${f.name}: ${(f.size / 1e6).toFixed(1)} MB. Match the chosen seconds.`);
  };

  // Bundled examples (only pages that have the picker): fetched, so they
  // need the page served over http(s), as on GitHub Pages.
  if ($("example")) $("example").onchange = async () => {
    const o = $("example").selectedOptions[0];
    if (!o.value) return;
    try {
      const r = await fetch(o.value);
      if (!r.ok) throw new Error(`${r.status}`);
      S.bytes = new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      status(`could not load ${o.value} (${e.message}): open the page through a web server`);
      return;
    }
    S.name = o.value.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
    S.clip = null;
    $("from").value = 0;
    $("to").value = 30;
    for (const [id, key] of [["gateDb", "gate"], ["denoise", "denoise"]]) { $(id).value = o.dataset[key]; $(id).dispatchEvent(new Event("input")); }
    $("go").disabled = false;
    setDirty(false);
    status(`${o.textContent}: suggested gate and denoise set. Match it`);
  };

  // Recording from the microphone: MediaRecorder, decoded like any other
  // file (decodeAudioData). Nothing leaves the browser.
  let recorder = null;
  $("record").onclick = async () => {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder = null;
        $("record").textContent = "● Record";
        $("record").classList.remove("dirty");
        S.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        S.name = "recording";
        S.clip = null;
        $("from").value = 0;
        $("go").disabled = false;
        setDirty(false);
        status("recorded: Match it");
      };
      recorder.start();
      $("record").textContent = "■ Stop recording";
      $("record").classList.add("dirty");
      status("recording… press again to stop");
    } catch (e) {
      status(`microphone: ${e.message}`);
    }
  };

  // An optional second recording to score against as well (for example a
  // cleaned-up copy of the same words). Not used for matching.
  $("refFile").onchange = async () => {
    const f = $("refFile").files[0];
    if (!f) return;
    S.refBytes = new Uint8Array(await f.arrayBuffer());
    S.refName = f.name.replace(/\.[^.]+$/, "");
    $("refClear").hidden = false;
    rerun();
  };
  $("refClear").onclick = () => {
    S.refBytes = null; S.ref = null; $("refFile").value = "";
    $("refClear").hidden = true; $("playRef").hidden = true;
    rerun();
  };

  async function decode(bytes, from, to) {
    try {
      return VM.readWav(bytes, from, to);
    } catch (e) {                                   // not a WAV: let the browser decode it
      const ctx = context(), buf = await ctx.decodeAudioData(bytes.slice().buffer);
      const a = Math.round(from * buf.sampleRate), b = Math.min(buf.length, Math.round(to * buf.sampleRate));
      const samples = new Float32Array(Math.max(0, b - a));
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < samples.length; i++) samples[i] += d[a + i] / buf.numberOfChannels;
      }
      return { rate: buf.sampleRate, samples, seconds: buf.duration };
    }
  }

  async function clip() {
    const from = Number($("from").value), to = Number($("to").value);
    if (S.clip && S.clip.from === from && S.clip.to === to) return S.clip;
    const c = await decode(S.bytes, from, to);
    if (!c.samples.length) throw new Error(`nothing between ${from} and ${to} s (the recording is ${c.seconds.toFixed(1)} s)`);
    S.clip = { ...c, from, to };
    S.analysisKey = "";
    return S.clip;
  }

  // ---------------------------------------------------------- matching

  // Each stage is timed (S.timing, ms; shown under Result) so the slow parts
  // can be found. Matching runs in slices with a progress bar.
  const paint = () => new Promise((r) => setTimeout(r, 0));
  async function run() {
    if (!S.bytes || S.running) return;
    S.running = true;
    $("go").disabled = true;
    $("progress").hidden = false;
    $("progress").value = 0;
    status("loading…");
    await paint();
    try {
      const timing = {}, t0 = performance.now();
      let t = t0;
      const lap = (name) => { const now = performance.now(); timing[name] = (timing[name] || 0) + now - t; t = now; };
      const c = await clip(), o = options();
      lap("load");
      S.options = o;
      const key = [c.from, c.to, o.updates, ...analysisKeys.map((k) => o[k])].join();
      if (key !== S.analysisKey) {
        status("analysing…");
        await paint();
        t = performance.now();
        S.analysis = VM.analyse(c.samples, c.rate, o); S.analysisKey = key; S.specRec = VM.spectrogram(c.samples, c.rate);
        lap("analyse");
      } else timing.analyse = 0;                       // kept from the last match
      const seconds = c.samples.length / c.rate, tm = performance.now();
      S.result = await VM.matchAsync(S.analysis, o, (f) => {
        const spent = (performance.now() - tm) / 1000;
        $("progress").value = f;
        status(`matching… ${Math.round(100 * f)}%, ${spent.toFixed(1)} s` + (f > 0.05 && f < 1 ? `, about ${Math.ceil(spent * (1 - f) / f)} s left` : ""));
      });
      t = tm;
      lap("match");
      status("rendering and scoring…");
      await paint();
      t = performance.now();
      S.rendered = VM.render(S.result.regs, c.rate, Ayumi, S.result.updates, S.result.clock);
      lap("render");
      S.measured = VM.evaluate(S.analysis, S.result, S.rendered, c.samples);
      S.ref = null;
      if (S.refBytes) {
        const r = await decode(S.refBytes, c.from, c.to);
        S.ref = VM.fitTo(r.samples, r.rate, c.rate, c.samples.length);
        S.measured.refStoi = VM.stoi(S.ref, S.rendered, c.rate);
        S.measured.inputVsRef = VM.stoi(S.ref, c.samples, c.rate);
      }
      lap("score");
      $("playRef").hidden = !S.ref;
      S.specAy = VM.spectrogram(S.rendered, c.rate);
      lap("spectrogram");
      S.frame = Math.min(S.frame, S.result.frames.length - 1);
      ["playRec", "playAy", "playSeq", "saveFrames", "saveWav", "saveSeq", "saveBin"].forEach((id) => { $(id).disabled = false; });
      setSelection(null);
      vectrexButtons();
      $("playTarget").disabled = !S.analysis.target;
      setDirty(false);
      $("go").textContent = "Regenerate";
      lap("other");
      draw();
      lap("draw");
      timing.total = performance.now() - t0;
      timing.seconds = seconds;
      S.timing = timing;
      drawStats();
      status(`${S.result.frames.length} updates in ${(timing.total / 1000).toFixed(1)} s (${(timing.total / 1000 / seconds).toFixed(1)} s per second of sound)`);
    } catch (e) {
      status(`error: ${e.message}`);
      console.error(e);
    } finally {
      S.running = false;
      $("go").disabled = false;
      $("progress").hidden = true;
    }
  }
  $("go").onclick = run;

  // Settings changes do not regenerate (it takes seconds): they mark the
  // result as out of date until Regenerate is pressed.
  function setDirty(dirty) {
    S.dirty = dirty;
    $("go").classList.toggle("dirty", dirty);
    $("dirtyNote").hidden = !dirty;
    if (dirty) status("settings changed: Regenerate to hear them");
  }
  const rerun = () => { if (S.result) setDirty(true); };
  ["from", "to"].forEach((id) => $(id).addEventListener("input", rerun));
  for (const id of sliders) {
    const input = $(id), out = input.parentElement.querySelector("output");
    const show = () => { out.textContent = input.value; };
    show();
    input.addEventListener("input", () => { show(); rerun(); });
  }
  ["chA", "chB", "chC", "bare", "fixed", "noise", "exactSquares", "noiseTone"].forEach((id) => $(id).addEventListener("change", rerun));
  for (const [id, m] of Object.entries(VM.MACHINES)) $("machine").add(new Option(`${m.name} (${(m.clock / 1e6).toFixed(4).replace(/0+$/, "")} MHz)`, id));
  $("machine").addEventListener("change", rerun);
  // Speech and free matching want different pitch settings: switching sets them.
  const PITCH = { match: { fmax: 1000, voicing: 0.3 }, speech: { fmax: 400, voicing: 0.45 } };
  $("mode").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.v === S.mode) return;
    S.mode = b.dataset.v;
    [...$("mode").children].forEach((x) => x.classList.toggle("on", x === b));
    for (const [id, v] of Object.entries(PITCH[S.mode])) { $(id).value = v; $(id).dispatchEvent(new Event("input")); }
    rerun();
  };
  $("updates").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.updates = Number(b.dataset.v);
    [...$("updates").children].forEach((x) => x.classList.toggle("on", x === b));
    rerun();
  };

  // ---------------------------------------------------------- drawing

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function drawSpec(canvas, spec, pitches, top, formants) {
    canvas.width = spec.cols;
    const h = canvas.height, ctx = canvas.getContext("2d"), img = ctx.createImageData(spec.cols, h);
    const floor = top - 70;
    for (let x = 0; x < spec.cols; x++) {
      for (let y = 0; y < h; y++) {
        const b = Math.floor((h - 1 - y) * spec.bins / h), d = spec.db[x * spec.bins + b];
        const t = Math.max(0, Math.min(1, (d - floor) / (top - floor))), o = 4 * (y * spec.cols + x);
        img.data[o] = 255 * Math.min(1, t * 1.6);
        img.data[o + 1] = 255 * Math.max(0, t * 1.6 - 0.5);
        img.data[o + 2] = 255 * (t < 0.5 ? t : 1 - t);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = "#fff";
    const perCol = S.result.updates / 100;
    for (let x = 0; x < spec.cols; x++) {
      const f = pitches[Math.floor(x * perCol)];
      if (f) ctx.fillRect(x, h - 1 - f / (spec.hz * spec.bins) * h, 1, 2);
    }
    if (formants) {
      [css("--good"), css("--ay")].forEach((colour, k) => {
        ctx.fillStyle = colour;
        for (let x = 0; x < spec.cols; x++) {
          const f = formants[Math.floor(x * perCol)];
          if (f && f[k]) ctx.fillRect(x, h - 1 - f[k] / (spec.hz * spec.bins) * h, 1, 2);
        }
      });
    }
    const fx = (S.frame + 0.5) / perCol;
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.fillRect(fx - 0.5, 0, Math.max(1, 1 / perCol), h);
  }

  function drawLanes() {
    const c = $("lanes"), frames = S.result.frames;
    c.width = frames.length;
    const ctx = c.getContext("2d"), row = c.height / 3;
    ctx.clearRect(0, 0, c.width, c.height);
    const colour = { env: css("--accent"), square: css("--ay"), noise: css("--noise") };
    frames.forEach((f, x) => f.state.ch.forEach((ch, i) => {
      if (ch.kind === "off") return;
      ctx.globalAlpha = ch.kind === "env" ? 1 : 0.25 + 0.75 * ch.v / 15;
      ctx.fillStyle = colour[ch.kind];
      ctx.fillRect(x, i * row + 1, 1, row - 2);
    }));
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.fillRect(S.frame, 0, 1, c.height);
  }

  function drawFrame() {
    const m = S.result.frames[S.frame], f = S.analysis.frames[S.frame], c = $("slotBars");
    c.width = c.clientWidth * devicePixelRatio;
    c.height = 160 * devicePixelRatio;
    const ctx = c.getContext("2d"), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    const db = (p) => 10 * Math.log10(p + m.eps);
    const top = VM.maxOf([...m.R, ...m.M, ...(m.A || [])].map(db)), floor = db(0);
    const y = (d) => H - (H - 4) * Math.max(0, (d - floor) / Math.max(1, top - floor));
    const slotW = W / m.count;
    [[m.R, css("--rec"), 0], [m.M, css("--good"), 1], [m.A || [], css("--ay"), 2]].forEach(([vals, colour, j]) => {
      ctx.fillStyle = colour;
      vals.forEach((p, k) => { const yy = y(db(p)); ctx.fillRect(k * slotW + j * slotW / 3, yy, slotW / 3 - 1, H - yy); });
    });
    const name = ["A", "B", "C"], regs = S.result.regs[S.frame].regs;
    const desc = (ch) => ch.kind === "off" ? "off" : ch.kind === "env" ? (ch.n ? `envelope × tone n=${ch.n} (${Math.round(ch.n * m.f0q)} Hz)` : "envelope, tone off (bare buzz)")
      : ch.kind === "square" ? `square n=${ch.n} (${Math.round(ch.n * m.f0q)} Hz) vol ${ch.v}` : `noise vol ${ch.v}`;
    $("frameText").innerHTML = `<p>update ${S.frame} · ${(S.clip.from + f.time).toFixed(2)} s · ` +
      (f.gated ? "gated" : f.voiced ? `pitch ${f.f0.toFixed(1)} Hz → EP ${m.ep} = ${m.f0q.toFixed(1)} Hz (${(1200 * Math.log2(m.f0q / f.f0)).toFixed(0)} cents)` : "unvoiced") +
      ` · F1/F2/F3 ${f.formants.map((x) => x ?? "–").join(" / ")} Hz · low/high ${f.tiltDb.toFixed(0)} dB` +
      ` · error model ${Math.sqrt(m.cost).toFixed(1)} dB, rendered ${Math.sqrt(m.actual).toFixed(1)} dB</p><table>` +
      m.state.ch.map((ch, i) => `<tr><td>${name[i]}</td><td>${desc(ch)}</td></tr>`).join("") +
      `<tr><td>noise</td><td>period ${m.state.np}</td></tr></table>` +
      `<p>R0–R13: ${regs.map((r) => r.toString(16).padStart(2, "0")).join(" ")}</p>`;
  }

  function drawStats() {
    const s = S.result.stats, e = S.measured, rows = [
      ["Updates", `${s.frames} at ${S.result.updates} Hz`],
      ["Voiced", `${Math.round(100 * s.voicedShare)}%`],
      ["Intelligibility", e.stoi === null ? "– (too short)" : `STOI ${e.stoi.toFixed(3)} (1 = the recording; 8-band noise vocoder ≈ 0.69 on the speech test)`],
      ...(e.refStoi === undefined ? [] : [[`  vs ${S.refName}`, e.refStoi === null ? "– (too short)" : `STOI ${e.refStoi.toFixed(3)} (the input itself: ${e.inputVsRef.toFixed(3)})`]]),
      ["Error, rendered", `${e.renderedErrorDb.toFixed(2)} dB`],
      ["  voiced frames", `${e.renderedVoicedErrorDb.toFixed(2)} dB`],
      ["  peaks (range)", `${e.renderedPeakErrorDb.toFixed(2)} dB`],
      ["Error, model", `${s.modelErrorDb.toFixed(2)} dB`],
      ["Formant error", e.formantError.f1 === null ? "–" : `F1 ${Math.round(100 * e.formantError.f1)}%, F2 ${Math.round(100 * e.formantError.f2)}% median (${e.formantError.frames}/${e.formantError.of})`],
      ["Pitch step", `${s.pitchStepCents.mean.toFixed(0)} cents mean, ${s.pitchStepCents.max.toFixed(0)} max`],
      ["Tracked AY pitch", `${Math.round(100 * e.renderedPitchCents.within50)}% of voiced within 50 cents`],
      ["Register writes", `${s.writesPerFrame.toFixed(2)} per update`],
      ["Data", `${Math.round(s.bytesPerSecond.raw)} bytes/s raw (14 an update), ${Math.round(s.bytesPerSecond.changes)} bytes/s as changes (2-byte mask + changed registers)`],
      ["Channel use", `env ${s.channelUse.env} · square ${s.channelUse.square} · noise ${s.channelUse.noise} · off ${s.channelUse.off}`],
      ...(S.timing ? [["Time", `${(S.timing.total / 1000).toFixed(1)} s (${(S.timing.total / 1000 / S.timing.seconds).toFixed(1)} s per second of sound)`],
        ...["load", "analyse", "match", "render", "score", "spectrogram", "draw", "other"].map((k) =>
          [`  ${k}`, `${Math.round(S.timing[k] || 0)} ms (${Math.round(100 * (S.timing[k] || 0) / S.timing.total)}%)` + (k === "analyse" && !S.timing[k] ? " (kept from the last match)" : "")])] : []),
    ];
    $("stats").innerHTML = rows.map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join("");
  }

  function draw() {
    const top = VM.maxOf(S.specRec.db);
    drawSpec($("specRec"), S.specRec, S.analysis.frames.map((f) => (f.voiced ? f.f0 : 0)), top, S.analysis.frames.map((f) => (f.voiced ? f.formants : null)));
    drawSpec($("specAy"), S.specAy, S.result.frames.map((m, i) => (S.analysis.frames[i].voiced ? m.f0q : 0)), top);
    drawLanes();
    drawFrame();
    drawStats();
  }

  // Selection: drag across a picture to choose updates [a, b). A click
  // without dragging still picks a frame.
  const updateAt = (canvas, x) => {
    const r = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(S.result.frames.length, Math.round((x - r.left) / r.width * S.result.frames.length)));
  };
  let drag = null;
  for (const id of ["specRec", "specAy", "lanes"]) {
    $(id).addEventListener("mousedown", (e) => {
      if (!S.result || e.button !== 0) return;
      drag = { canvas: e.currentTarget, x: e.clientX, from: updateAt(e.currentTarget, e.clientX), moved: false };
      e.preventDefault();
    });
    $(id).addEventListener("click", (e) => {
      const dragged = drag && drag.moved;
      drag = null;
      if (!S.result || dragged) return;
      const r = e.currentTarget.getBoundingClientRect();
      S.frame = Math.max(0, Math.min(S.result.frames.length - 1, Math.floor((e.clientX - r.left) / r.width * S.result.frames.length)));
      draw();
    });
  }
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x) < 4) return;
    drag.moved = true;
    const at = updateAt(drag.canvas, e.clientX);
    setSelection({ a: Math.min(at, drag.from), b: Math.max(at, drag.from) });
  });
  // A drag released outside the pictures gets no click: end it here.
  document.addEventListener("mouseup", (e) => { if (drag && drag.moved && e.target !== drag.canvas) drag = null; });

  function setSelection(sel) {
    S.sel = sel && sel.b > sel.a ? sel : null;
    const n = S.result ? S.result.frames.length : 1;
    boxes.forEach((b) => {
      b.hidden = !S.sel;
      if (S.sel) { b.style.left = `${100 * S.sel.a / n}%`; b.style.width = `${100 * (S.sel.b - S.sel.a) / n}%`; }
    });
    $("selBar").hidden = !S.sel;
    if (S.sel) {
      const u = S.result.updates;
      $("selText").textContent = `Selected ${(S.clip.from + S.sel.a / u).toFixed(2)}–${(S.clip.from + S.sel.b / u).toFixed(2)} s (${S.sel.b - S.sel.a} updates)`;
    }
  }
  $("selClear").onclick = () => { stop(); setSelection(null); };

  // Samples of the selection (updates on the clip's sample rate).
  const selSamples = (x) => {
    const per = S.clip.rate / S.result.updates;
    return x.subarray(Math.round(S.sel.a * per), Math.min(x.length, Math.round(S.sel.b * per)));
  };
  // The playback line runs over the selected part of the pictures.
  const selWhere = (len) => {
    const n = S.result.frames.length, start = S.sel.a / n, part = (S.sel.b - S.sel.a) / n;
    return (t) => start + part * Math.min(1, t * S.clip.rate / len);
  };
  $("selRec").onclick = () => { const x = selSamples(S.clip.samples); play(x, selWhere(x.length)); };
  $("selAy").onclick = () => { const x = selSamples(S.rendered); play(x, selWhere(x.length)); };
  $("selSeq").onclick = () => {
    const a = selSamples(S.clip.samples), b = selSamples(S.rendered), ta = a.length / S.clip.rate, wa = selWhere(a.length), wb = selWhere(b.length);
    play(VM.abSequence(a, b, S.clip.rate), (t) => (t < ta ? wa(t) : t < ta + 0.5 ? null : wb(t - ta - 0.5)));
  };
  const selName = () => `${S.name}_${(S.clip.from + S.sel.a / S.result.updates).toFixed(2)}-${(S.clip.from + S.sel.b / S.result.updates).toFixed(2)}s`;
  $("selWav").onclick = () => save(new Blob([VM.writeWav(selSamples(S.rendered), S.clip.rate)], { type: "audio/wav" }), `${selName()}_${S.result.updates}hz_ay.wav`);

  // Vectrex player streams: the player takes one update a frame at the
  // Vectrex's clock, so only a 50 Hz match on machine Vectrex plays right.
  function vectrexButtons() {
    const ok = !!S.result && S.result.updates === 50 && $("machine").value === "vectrex";
    ["saveStream", "saveStreamAsm", "selBin", "selAsm"].forEach((id) => {
      const b = $(id);
      if (b.dataset.title === undefined) b.dataset.title = b.title;
      b.disabled = !ok;
      b.title = ok || !S.result ? b.dataset.title : "The Vectrex player plays one update a frame at the Vectrex's clock: match at 50 Hz with machine Vectrex to save a stream.";
    });
  }
  $("machine").addEventListener("change", vectrexButtons);
  const asmLabel = (name) => "VM_" + name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  function saveStream(regs, name, asm) {
    const bytes = VM.encodeStream(regs);
    if (!asm) return save(new Blob([bytes], { type: "application/octet-stream" }), `${name}_vectrex_stream.bin`);
    const head = `; ${name}: ${regs.length} updates (${(regs.length / 50).toFixed(2)} s at 50 Hz), ${bytes.length} bytes.\n` +
      `; Voice matching stream for vtx_voice_player.asm: ldx #${asmLabel(name)} / jsr VM_Start, then\n` +
      `; jsr VM_Service and jsr Do_Sound once a frame while VM_Busy says it is playing.\n`;
    save(new Blob([head + VM.streamAsm(bytes, asmLabel(name))], { type: "text/plain" }), `${name}_vectrex_stream.asm`);
  }
  $("saveStream").onclick = () => saveStream(S.result.regs, S.name, false);
  $("saveStreamAsm").onclick = () => saveStream(S.result.regs, S.name, true);
  $("selBin").onclick = () => saveStream(VM.sliceRegs(S.result.regs, S.sel.a, S.sel.b), selName(), false);
  $("selAsm").onclick = () => saveStream(VM.sliceRegs(S.result.regs, S.sel.a, S.sel.b), selName(), true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.sel) { stop(); setSelection(null); return; }
    if (!S.result || e.target.tagName === "INPUT") return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      S.frame = Math.max(0, Math.min(S.result.frames.length - 1, S.frame + (e.key === "ArrowRight" ? 1 : -1)));
      draw();
      e.preventDefault();
    }
  });

  // ---------------------------------------------------------- listening

  function context() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    return audio;
  }
  const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-6);

  // Playback line: one over each spectrogram and the lanes, at the playing
  // time. `where(seconds)` gives the place in the clip (0..1), or null to hide
  // it (the A/B gap).
  const boxes = [];                               // the selection, over each picture
  const heads = ["specRec", "specAy", "lanes"].map((id) => {
    const c = $(id), wrap = document.createElement("div"), line = document.createElement("div"), box = document.createElement("div");
    wrap.className = "playwrap";
    line.className = "playhead";
    box.className = "selbox";
    box.hidden = true;
    c.parentNode.insertBefore(wrap, c);
    wrap.append(c, box, line);
    boxes.push(box);
    return line;
  });
  let headFrame = 0;
  const showHead = (x) => heads.forEach((h) => { h.hidden = x === null; if (x !== null) h.style.left = `${(100 * Math.min(1, Math.max(0, x))).toFixed(3)}%`; });
  showHead(null);

  function play(samples, where = (t) => t * S.clip.rate / samples.length) {
    stop();
    const ctx = context(), buf = ctx.createBuffer(1, samples.length, S.clip.rate), g = 0.9 / peak(samples);
    const d = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) d[i] = samples[i] * g;
    const src = ctx.createBufferSource();
    source = src;
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => { if (source === src) stop(); };
    const t0 = ctx.currentTime + 0.01;
    src.start(t0);
    const tick = () => {
      if (source !== src) return;
      const t = ctx.currentTime - t0;
      showHead(t < 0 ? 0 : where(t));
      headFrame = requestAnimationFrame(tick);
    };
    tick();
  }
  function stop() {
    if (source) { try { source.stop(); } catch (e) { /* already stopped */ } source = null; }
    clearTimeout(timer);
    cancelAnimationFrame(headFrame);
    showHead(null);
  }
  $("playRec").onclick = () => play(S.clip.samples);
  $("playRef").onclick = () => S.ref && play(S.ref);
  $("playAy").onclick = () => play(S.rendered);
  $("playTarget").onclick = () => S.analysis.target && play(S.analysis.target);
  $("playSeq").onclick = () => {
    // The recording, half a second of silence, then the AY: the line runs twice.
    const a = S.clip.samples.length / S.clip.rate, b = S.rendered.length / S.clip.rate;
    play(VM.abSequence(S.clip.samples, S.rendered, S.clip.rate), (t) => (t < a ? t / a : t < a + 0.5 ? null : (t - a - 0.5) / b));
  };
  $("stop").onclick = stop;

  // ------------------------------------------------------------ saving

  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $("saveFrames").onclick = () => save(new Blob([JSON.stringify({
    source: S.name, from: S.clip.from, to: S.clip.to, updates: S.result.updates, options: S.options,
    frames: S.result.regs.map((f, i) => ({ regs: f.regs, shape: f.shape, state: S.result.frames[i].state })),
  })], { type: "application/json" }), `${S.name}_${S.result.updates}hz_frames.json`);
  $("saveSeq").onclick = () => save(new Blob([VM.writeWav(VM.abSequence(S.clip.samples, S.rendered, S.clip.rate), S.clip.rate)], { type: "audio/wav" }), `${S.name}_${S.result.updates}hz_original_then_ay.wav`);
  $("saveBin").onclick = () => save(new Blob([VM.dump(S.result.regs)], { type: "application/octet-stream" }), `${S.name}_${$("machine").value}_${S.result.updates}hz_registers.bin`);
  $("saveWav").onclick = () => save(new Blob([VM.writeWav(S.rendered, S.clip.rate)], { type: "audio/wav" }), `${S.name}_${S.result.updates}hz_ay.wav`);

  $("theme").onclick = () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    if (S.result) draw();
  };
})();
