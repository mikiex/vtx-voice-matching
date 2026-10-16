# VTX Voice Matching

An experiment that follows on from [VTX Speech](https://github.com/mikiex/vtx-speech):
instead of building speech from text, make an AY-3-8910 sound chip imitate a
recording, one register update per 50 Hz frame. The envelope generator is the
voice's buzz at the speaker's pitch, tones locked to its harmonics shape the
vowels, and noise makes the consonants. Every result is played through an AY
emulator (Ayumi) and scored for intelligibility (STOI).

Explainer and results: <https://mikiex.github.io/vtx-voice-matching/>.
Tool: [`tool.html`](https://mikiex.github.io/vtx-voice-matching/tool.html).

Status: host only. The output is a register stream checked in emulation; no
Vectrex or Spectrum player exists yet.

## Requirements

| For | Needs |
|---|---|
| The tool (`tool.html`) | Chrome, Edge or Firefox; works from the web page or opened as a local file |
| Command line, sweep, core tests | Node 18+ |
| Browser test | Node 22+ (built-in WebSocket) and Chrome or Edge |

No packages to install and no build step. Four public-domain LibriVox
readings are included as examples (`examples/`, see `NOTICE.md`); or bring
your own WAV files, or record in the browser.

## The tool

Open `tool.html`, pick an **example**, choose a WAV or press **● Record**, set
the seconds and **Match**. The examples are fetched, so they need the page
served over http (GitHub Pages, or `python -m http.server`), not opened as a
file. Changing settings marks the result out of date until you press
**Regenerate**.

- **A/B** plays the whole recording, then the whole AY version.
- **machine** sets the AY clock: Vectrex 1.5 MHz, Spectrum 128 1.7734 MHz,
  CPC 1 MHz, MSX 1.79 MHz, Atari ST 2 MHz. Period registers depend on it.
- **Free match / Speech**: search everything, or speech-coder rules (LPC
  formants guide A/B, noise only when unvoiced).
- **Denoise**, **Gate**: clean up and silence a background. For noisy
  recordings, clean the file first with
  [NVIDIA RE-USE](https://huggingface.co/nvidia/RE-USE) (recommended; others:
  DeepFilterNet, Demucs vocals, Adobe Podcast Enhance) and load that with
  denoise 0 and gate 60.
- **score against**: also score the AY version against a second recording
  of the same words (for example the original, before cleaning).
- Saves: frames.json, the AY WAV, the A→B WAV, and **registers .bin**.

## Register stream (`registers.bin`)

14 bytes per update, R0..R13 in order, 50 updates a second unless chosen
otherwise. R13 is `$FF` when it must not be written: writing R13 restarts the
envelope, so it is written once, when the buzz starts. A player copies one
record to the AY each frame (Vectrex: into `Vec_Music_Work`, then
`Do_Sound`; Spectrum 128: ports `$FFFD`/`$BFFD`). Raw it is 700 bytes a
second; a changed-register mask brings it to about 300-350.

## Command line

```powershell
node tools/run.js recording.wav --from 0 --to 10 --gateDb 19 --denoise 4
node tools/run.js recording.wav --machine spectrum --speech
node tools/run.js cleaned.wav --gateDb 60 --reference original.wav
```

Writes `build/out/`: `original.wav`, `ay.wav`, `ab.wav` (recording then AY),
`registers.bin`, `frames.json` and `compare.png` (spectrograms), and prints the
measurements as JSON. Options: `--updates 50|100|200`, `--smooth`,
`--rangeDb`, `--no-noise`, `--no-fixed`, `--no-bare`, `--channels AB`,
`--consonantDb`, `--sharpen`; see `DEFAULTS` in `js/core.js`.

Sweep many configurations over your own clips and rank them by STOI, with
noise-vocoder references:

```powershell
node tools/sweep.js my_clips.json --wav          # see tools/clips.example.json
node tools/sweep.js my_clips.json --record       # merges into results/sweep.json
```

## Files

| Path | What |
|---|---|
| `index.html`, `css/` | the explainer |
| `tool.html`, `js/ui.js` | the tool |
| `js/core.js` | analysis, matching, rendering, STOI, preprocessing (browser and Node) |
| `tools/run.js`, `tools/sweep.js` | command line |
| `test/core.test.js` | WAV reading, round trip on a synthetic AY voice, STOI, low sample rates, preprocessing |
| `test/browser.mjs` | the tool in headless Chrome (fake microphone included) |
| `examples/` | public-domain examples; `examples/ay/` their AY versions |
| `results/sweep.json` | measured results |
| `vendor/` | Ayumi (MIT), unmodified |

## Tests

```powershell
node test/core.test.js build/synthetic.wav
node test/browser.mjs build/synthetic.wav build/browser
```

## Licence

MIT (`LICENSE`). Ayumi keeps its own MIT licence (`vendor/AYUMI_LICENSE`);
see `NOTICE.md` for sources and references.
