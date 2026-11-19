# Assets

Every non-code asset shipped by Pocket Runner, with source and licence.

**No Bull Rush images, textures, fonts or music are used.** Bull Rush's own
`ASSET_PROVENANCE.md` lists its images as undocumented and its music as
unlicensed, so none of `public/*.jpg`, `public/*.png`, `server/assets/*` or
`assets/audio/*` was copied. The port took code only (see `LICENSE`).

| Asset | Where | Source | Licence |
|---|---|---|---|
| Runner character, trains, hurdles, bars, coins, houses, trees, track | `src/three/*.tsx` | Original, built from three.js primitive geometry at runtime | MIT (this repo) |
| Toon gradient, stripe and sky textures | `src/three/toon.ts` | Generated at runtime (DataTexture / canvas) | MIT (this repo) |
| Sound effects | `src/audio.ts` | Synthesised at runtime with Web Audio oscillators and noise (no audio files) | MIT (this repo) |
| Spoken calibration cues | `src/ui/Screens.tsx` | The browser's built-in `speechSynthesis` voice (no files shipped) | n/a |
| Fonts | `src/ui/styles.css` | System fonts only (`Arial Black`, `system-ui`); none bundled | n/a |
| Favicon | `index.html` | 🏃 emoji rendered by the OS emoji font | n/a |
| Pose model `pose_landmarker_lite.task` (5.8 MB) | `public/models/` | Google MediaPipe, `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` (sha256 `59929e1d…690d574a`). Model card: BlazePose GHUM 3D | Distributed by Google as part of MediaPipe (Apache-2.0 project). The model page does not restate a licence for the `.task` file itself, so **check the model card's terms before any commercial release** |
| MediaPipe WASM runtime | `public/mediapipe/wasm/` (copied from `node_modules` on `npm install`) | `@mediapipe/tasks-vision@1.1.1` | Apache-2.0 |
| Screenshots | `docs/*.png` | Captured from this game | MIT (this repo) |

`reference/viral-game-workout.mp4` (outside this folder) is a third-party clip
used only as a design reference and for local detector testing. It is not
shipped and must not be committed or redistributed.
