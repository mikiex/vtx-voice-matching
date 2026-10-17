# VTX Voice Matching

An experiment that follows on from [VTX Speech](https://github.com/mikiex/vtx-speech):
instead of building speech from text, make an AY-3-8910 sound chip imitate a
recording, one register update per 50 Hz frame. The envelope generator is the
voice's buzz at the speaker's pitch, tones locked to its harmonics shape the
vowels, and noise makes the consonants. Every result is played through an AY
emulator (Ayumi) and scored for intelligibility (STOI).

Explainer and results: <https://mikiex.github.io/vtx-voice-matching/>.
Tool: [`tool.html`](https://mikiex.github.io/vtx-voice-matching/tool.html).

Status: experimental. The tool saves streams for a 6809 Vectrex player
(`vectrex/`, checked update by update in MAME); no Spectrum player exists
yet. Nobody has heard it on a real Vectrex.

## Requirements

| For | Needs |
|---|---|
| The tool (`tool.html`) | Chrome, Edge or Firefox; works from the web page or opened as a local file |
| Command line, sweep, core tests | Node 18+ |
| Browser test | Node 22+ (built-in WebSocket) and Chrome or Edge |

No packages to install and no build step. Five public-domain LibriVox
readings and two unaccompanied songs (CC0 and public domain) are included as examples (`examples/`, see `NOTICE.md`); or bring
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
- **exact squares**, **noise × tone** (on by default): squares tuned to the
  recording's pitch, and noise ANDed with a 1-6 kHz tone for consonants. Both
  were chosen by blind listening tests (see the explainer, section 3b).
- **Denoise**, **Gate**: clean up and silence a background. For noisy
  recordings, clean the file first with
  [NVIDIA RE-USE](https://huggingface.co/nvidia/RE-USE) (recommended; others:
  DeepFilterNet, Demucs vocals, Adobe Podcast Enhance) and load that with
  denoise 0 and gate 60.
- **score against**: also score the AY version against a second recording
  of the same words (for example the original, before cleaning).
- **Selecting a part**: drag across a spectrogram or the channel lanes. The
  bar under them plays the part (recording, AY, A/B) and saves it as an AY
  WAV or as a Vectrex stream (`.bin`, or `.asm` to include). A click still
  inspects one frame; Esc clears the selection.
- A white line follows playback; a progress bar shows matching; **Result**
  times each stage. Every control has a tooltip.
- Saves: frames.json, the AY WAV, the A→B WAV, **Vectrex .bin / .asm** (the
  player's stream, see below; 50 Hz on machine Vectrex only), and
  **registers .bin**.

## Playing it on a Vectrex

`vectrex/vtx_voice_player.asm` (AS09 syntax, 193 bytes, 4 bytes of RAM)
plays the stream from **Save Vectrex .asm/.bin**: each 50 Hz update is a
2-byte mask of the changed registers, then their values; `$80 $00` ends it.
It fills the BIOS sound buffer, so call `VM_Service` then `Do_Sound` once a
frame. `VM_Start` (X = stream), `VM_Busy` (Z = 1 when silent), `VM_Stop`.
A saved part restarts the envelope on its first update. Speech is about
250-350 bytes a second.

`vectrex/voice_cart.asm` is a complete example cartridge: save the stream as
`stream.asm` beside it, set `VOICE` to its label, and assemble. It plays the
voice, waits a second, and repeats.

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
| `vectrex/vtx_voice_player.asm`, `vectrex/voice_cart.asm` | the Vectrex player and an example cartridge |
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
