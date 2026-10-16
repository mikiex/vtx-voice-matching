# Third-party material and references

## Ayumi (`vendor/ayumi.js`)

- **What:** an emulator of the AY-3-8910 and YM2149 sound chips. Every AY
  sound in the tool is rendered through it.
- **Authors:** Peter Sovietov (Ayumi); JavaScript port by Alexander Kovalenko.
- **Source:** <https://github.com/alexanderk23/ayumi-js>, commit
  `3a1fb9120cc2c5ef8f538af59b46701e4c2305bb`, file `ayumi.js`.
- **Licence:** MIT. The full text is in `vendor/AYUMI_LICENSE`.
- **Changes:** none (SHA-256 of the file with LF line endings
  `ded3df8aa2a063bd873ec0fedf167a2f2873034467a94aaa17441feb888b1ba8`).
  Ayumi loses steps below an output rate of clock/64; `js/core.js` renders
  low-rate clips at 44.1 kHz and resamples instead of changing it.

## Methods implemented from publications (no code copied)

- STOI: C. H. Taal, R. C. Hendriks, R. Heusdens, J. Jensen, "An algorithm
  for intelligibility prediction of time-frequency weighted noisy speech",
  IEEE TASLP 19(7), 2011.
- YIN: A. de Cheveigné, H. Kawahara, "YIN, a fundamental frequency estimator
  for speech and music", JASA 111(4), 2002.
- Noise vocoder reference: R. V. Shannon, F.-G. Zeng, V. Kamath, J.
  Wygonski, M. Ekelid, "Speech recognition with primarily temporal cues",
  Science 270, 1995.
- LPC (autocorrelation and Levinson-Durbin) and spectral subtraction are
  textbook methods.

## Related projects (described, not used)

- Nick Bild, AY-3-8910 speech synthesis: <https://github.com/nickbild/ay-3-8910>
  (GPL-3.0).
- Jari Komppa, audio2ay: <https://github.com/jarikomppa/audio2ay> (zlib).

## Example recordings (`examples/`), all public domain

LibriVox recordings are dedicated to the public domain, and the texts are
public domain.

| File | Source | Changes |
|---|---|---|
| `gettysburg_address_opening.wav` | The Gettysburg Address (Abraham Lincoln, 1863) read by John Greenman; archive.org `gettysburg_johng_librivox` | 13.0-21.4 s |
| `librivox_seven_ages_of_man.wav` | "The Seven Ages of Man" (William Shakespeare); LibriVox 7th Anniversary Collection, section 2; archive.org `7th_anniversary_collection_1208_librivox` | 0.5-11.0 s |
| `librivox_adams_letter.wav` | John Adams to John Quincy Adams, 27 July 1777; same collection, section 3 | 0.7-11.4 s |
| `librivox_kearney_at_seven_pines.wav` | "Kearney at Seven Pines" (Edmund Clarence Stedman); same collection, section 8 | 0.5-10.8 s |

All converted from MP3 to 16-bit mono WAV at 22,050 Hz with 50/100 ms fades.
`examples/ay/` holds this tool's output from them.

## Other recordings

None. NVIDIA RE-USE was used outside this repository to clean one test
clip; it is neither included nor required.
