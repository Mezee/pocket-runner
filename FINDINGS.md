# Findings: camera prototype

## Update 4: duck rule + Android game analysis (v4)

The player challenged two choices: duck should be *head dropping*, not feet; and
the 2.5 s cap was arbitrary. Both were fair.

**Duck is now: your head drops, measured against your own feet.** The signal is
`headToFoot = lowest foot Y − head Y`. If it shrinks below a fraction of its
standing value, you're ducking; it lasts exactly as long as you're down and
springs back when you stand (release at 60% of the enter threshold). Measuring
against feet rather than a line in the picture is what stops walking toward the
camera from faking a duck. The 2.5 s cap is gone, and there's a test that a
6-second hold stays a duck and then releases on standing.

**What the Android game (Motion Sport Games AR, XAPK 2.1) actually does**, via
REA (Unity IL2CPP metadata) plus ARM64 disassembly — full notes in
`MOTION-GAMES-REA.md`:
- Jump: both feet must rise > 25 of their units above the previous sample.
  **Same approach as ours.**
- Jump arc is **timed (1.5 s)**, not "while you're actually airborne".
- Lateral movement is **continuous**: character lerps toward the average of
  both feet at 8 units/s, clamped to ±2. Not three hard lanes.
- Calibration is a **single snapshot**, and they recalibrate when you leave
  the frame.
- REA's decompiler backends aren't installed, so bodies were read as
  disassembly, not source. Their ducking logic wasn't found.


## Update 3: playtest of v3 (phone video + screen recording, 2026-10-27 21:22)

Reviewed side by side (phone video of the room plus the laptop screen), with Gemini via
`video-inspect` and frame-by-frame checks.

**What worked:** framing was good (whole body and feet in view). Lanes
followed the thirds. LEFT/RIGHT registered at 00:03, 00:08, 00:16 and 00:38,
and early ducks at 00:02, 00:11 and 00:25. There were no false jumps from
running.

**What went wrong**

| # | Problem | Evidence | Cause | Fix |
|---|---|---|---|---|
| 1 | **Duck got stuck.** "It keeps ducking when it's not ducking" | From ~00:27 the character stayed crouched, and the move chip showed DUCK while the player stood | Duck was "shoulders lower in the picture than at calibration". Moving closer to the camera puts your shoulders lower in the picture, so it read as a permanent crouch | Duck now measures **legs folding** (hip-to-foot length ÷ torso length), which doesn't change when you move around. A held duck **auto-releases after 2.5 s** and re-measures standing. Reproduced in tests: the old logic fails, the new logic passes |
| 2 | **Died on a hurdle** at 00:43 | The player jumped; the game showed DUCK and the runner slid into the hurdle | The stuck duck (1) blocked jumps, and its "still holding" pulses kept restarting the slide, which cancels a jump | A jump now **always overrides** a duck, and "holding" pulses can only extend a slide that's already happening |
| 3 | **"Very slow / glitchy / jittering"** | The game redraw dropped to **7–8 fps** at 4–5 s and 35 s, and was **~15–23 fps** for most of the run (frame analysis of the recording) | Pose detection ran on the same thread as the game, so every camera frame stalled rendering (which was also competing with screen recording plus Chrome) | Pose detection moved into a **Web Worker** (CPU/XNNPACK by default). Measured on the reference video: render **78 → 120 fps**, worst-frame p99 **33 ms → 10 ms**, and 25 camera fps. Rendering resolution was also capped slightly lower. Use `?mainthread` or `?delegate=gpu` to compare |

**To check next time:** whether it still feels slow. If it does, close other
tabs and stop screen recording to compare, then open debug (G) to see camera
fps and inference ms.


## Update 2: lanes and jump (v3)

Two issues came from playtesting v2:

1. **Lane zones weren't even thirds.** They were measured in shoulder widths
   from where you stood at calibration, so they drifted off-centre and changed
   size with distance. **Fix:** lanes are now the three equal thirds of the
   camera image (with a ±3% dead band). The left/right calibration steps
   are gone, cutting calibration from ~10 s to ~7 s.
2. **Running steps were detected as jumps.** Vigorous running bounces the hips
   as much as a small jump. **Fix:** a jump now also needs **both feet off
   the floor**: the *lower* ankle must rise above its standing level for at
   least 2 frames. Running always keeps one foot planted.
   - Synthetic vigorous running: **15 false jumps in 8 s before, 0 after.**
   - Reference video (real running, fake webcam, real MediaPipe): jump
     detections went from 6 to 3 over the first 34 s. The real jumps at
     0.1 s and 15.5 s are still detected. The third (3.9 s) comes right after
     a real jump in the clip at ~3.3 s, so it's a late detection or a
     double, not a running step. There were no jumps in the long running
     stretches. (The clip is edited, with cuts, so this is indicative only.)
   - Middle ground if it's still too strict or too loose: the debug
     view (G) has a **"feet off floor"** slider and its own graph.


## Update: first human playtest (2026-10-27, v1 build)

A 2-minute screen recording of a real person playing on a MacBook webcam in a
living room. It was reviewed with Gemini via `video-inspect` and checked
against extracted frames.

**What happened**
- Calibration took **~15 s** (target under 30 s) ✅.
- Framing was good: head to shins/feet visible at ~2.5–3 m, and the skeleton
  was steady.
- Lane changes and jumps mostly registered at the prompts. At 01:00 a hurdle
  was cleared cleanly with the jump, and LEFT at 01:23 registered promptly.
- **The biggest problem was the run-to-move rule.** "KEEP RUNNING!" showed for
  about **45 of the 92 s of play** (00:41–51, 01:02–20, 01:29–35, 01:41–53,
  01:56+). The runner stalled at score 219, 420, 653, 771 and 803. In several
  of these frames the player *was* moving, but the webcam's step detection
  didn't register it.
- **Hearts lost:** 1 at 00:51 (stalled in front of a hurdle: a consequence
  of the stop), 1 at 01:37 (clipped a train while changing lanes).
- **A second person** walking through the background (00:17, ~01:10–01:15,
  01:48) triggered "CAN'T SEE YOU" and made tracking flaky.

**What we changed (v2)**
1. **The runner always moves.** Cadence no longer gates speed. Running on the
   spot is now an optional **bonus: +2 points per step**, shown as 🏃 in the
   HUD and on the game-over screen. Main controls: left, right, jump, duck.
2. **Jump to start, jump to restart.** No more "run on the spot to start".
3. **Auto-pause** when the player leaves the frame for more than 0.4 s;
   play resumes on return. No more hits while you're off-screen.
4. **Bystander-proof tracking.** MediaPipe now tracks 2 poses, and we follow
   the one nearest the player's last position.
5. Tested: 22 unit tests pass, and synthetic e2e runs survive with all moves
   detected (plus one extra jump: the start jump, counted at game start).

**Still to check with a person:** whether the train clip at 01:37 was input
lag or the lane change starting too late (the prompt shows 1.5 s ahead). If
it happens again, look at the lateral graph in debug (G).

---

# Original findings (v1)

*2026-10-27. Built and tested by the agent, **without a real person in front
of a real camera yet.** Everything marked ✅ was measured. Everything marked 🔲
still needs a human test session (about 30 minutes, checklist at the bottom).*

## The question

> Does playing a runner with your body feel responsive and fun?

We changed the input from **phone-in-pocket** to **camera** on the user's
instruction. This document reports what we know so far.

## Why the camera is a good swap

| | Phone in pocket (brief) | Camera (built) |
|---|---|---|
| Setup | open URL on TV, scan QR, allow motion (iOS), calibrate, pocket the phone, keep the screen on | open URL, allow camera, calibrate (~10 s) |
| Moves | jump, lean/step, cadence | jump, **duck**, step (absolute lanes), cadence |
| Lane changes | relative and the hardest to detect (running sway) | **absolute position**: self-correcting, and running sway is small compared with a step |
| Network | phone → Wi-Fi → server → TV (20–100 ms + jitter) | none: everything runs in one browser tab |
| Infra | Air Jam server, HTTPS on the LAN (mkcert/tunnel) | none: `localhost` counts as a secure context |
| Needs | a phone | a webcam that sees you (a laptop by the TV, or a USB webcam) |
| Risks | iOS suspending the page, sensor quirks | lighting, framing, bystanders, camera delay, TV-browser camera support |

## Measured ✅

### Detection on synthetic bodies (full pipeline, headless)

`npm run e2e` drives the real code downstream of landmarks: features →
calibration → detector → bus → hub → sim. A synthetic skeleton performs each
move when an obstacle is ~0.75 s away (prompt at 1.5 s plus human reaction
time). Landmark noise is ±0.2% of the frame.

| Seed | Survived | Hits | Jumps | Ducks | Lanes | Detected / performed |
|---|---|---|---|---|---|---|
| e2e-1 | 119 s, 3/3 ♥ | 0 | 12/12 | 12/12 | 17/17 | 41/41 |
| e2e-2 | 119 s, 3/3 ♥ | 0 | 9/9 | 12/13 | 14/14 | 35/36 |
| e2e-3 | 122 s, 3/3 ♥ | 0 | 14/14 | 9/9 | 14/14 | 37/37 |

- Calibration took **10.2 s** with prompt-perfect moves (target was under 30 s).
- **Zero false moves** in 10 s of standing still and 10 s of running in place
  (unit tests).
- The one missed duck (e2e-2) arrived during a still-held slide and was
  merged into it, so it caused no gameplay effect.

**Caveat:** synthetic bodies are much cleaner than real ones. These numbers
prove the pipeline and logic work. They do **not** prove real-world hit rates.

### Real human motion (reference video as a fake webcam, real MediaPipe)

`reference/viral-game-workout.mp4` was fed to Chrome as a fake webcam. The
camera is behind the player, so "camera is behind me" mode was on.

- MediaPipe Pose Lite on the **GPU delegate: ~11 ms per frame, steady 30 fps**
  (camera-limited) on this Mac. Software rendering (SwiftShader) managed only
  ~6 fps, so **a real GPU is required**.
- All landmarks (head, shoulders, hips, knees, ankles) were tracked through
  the running sections.
- **Cadence from knee alternation: 150–230 steps/min while running**, falling
  to 0 when he stopped and during the video's cuts. This matches the video by
  eye. (The first version only counted steps while "not airborne", which
  stuck at 0 on real data. Fixed, and now covered by tests.)
- Moves detected in the clip included the jumps, the duck and the
  side-steps. There were also extra lane events at **camera cuts** in the
  edited video (the body teleports). In a live room there are no cuts, but
  that's why lanes are absolute and self-correcting.

### Latency (software part)

| Stage | Median | p90 | Notes |
|---|---|---|---|
| Inference (MediaPipe Lite, GPU) | ~11 ms | ~13 ms | Chrome, macOS |
| Frame → detection decision | 33 ms | 33 ms | one frame at 30 fps: the threshold is crossed on the next frame |
| Motion onset → detection | 35–41 ms | ~143 ms | synthetic; p90 is the slow-rising moves (squat, step) |
| Detection → on screen | 14–23 ms | ~37 ms | applied on the next 60 Hz tick + next render |
| **Onset → on screen (software)** | **~60 ms** | **~160 ms** | |

**Estimated glass-to-glass:** add the webcam's capture/USB delay (typically
50–100 ms at 30 fps) and TV display lag (20–40 ms in Game Mode, 80–150 ms
without). That gives about **130–240 ms median**, within the brief's 250 ms
target **only if the TV is in Game Mode**. 🔲 Confirm with a 240 fps video.

Where the time goes, worst first:

1. **TV display lag.** Use Game Mode.
2. **Camera frame interval and exposure.** 60 fps webcams halve this. The
   code asks for 60 fps if the camera offers it.
3. **Detection lag on slow moves (squat, step).** These are thresholds on
   position, so a slow squat crosses late. The early triggers on velocity
   help with steps.
4. Inference and render: small.

### Gameplay forgiveness (unit-tested)

- A move arriving up to **150 ms after** the collision tick still clears.
- A jump that **landed up to 200 ms before** a hurdle still clears. Players
  jump early on a prompt; without this, 3 of 3 e2e jumps failed, because the
  0.6 s arc left too narrow a window.
- Prompts show 1.5 s ahead. The first ~minute has an empty row between every
  obstacle (about 4 s apart).
- When you stop running, speed eases down (5 u/s²) instead of stopping dead.
- A well-timed autopilot survives 3 minutes on all 50 seeds tested, and every
  generated row has a reachable safe lane.

## Not yet measured 🔲

- Real hit and miss rates (20 jumps, 20 ducks, 20 lane changes per player).
- Real glass-to-glass latency (240 fps video).
- How it feels: is it fun, is it fair, does anything feel late?
- Framing in a real living room: distance, camera height, lighting, a sofa
  in the way.
- TV browsers: many smart-TV browsers have **no webcam support**. Expect to
  use a laptop over HDMI.
- Baggy clothes and dresses (hip and knee landmarks get less reliable),
  children, and two people in frame (it tracks one pose; a bystander can
  steal it).

## Risks and what to watch

1. **Ducking is a squat.** Repeated squats are a real workout (good), but a
   deep squat during a run is slow. If ducks feel late, lower `duck drop` in
   debug, or make bars rarer.
2. **Cadence needs the knees in frame.** If the camera only sees the upper
   body, cadence falls back to hip bob, which is weaker. The setup screen
   says "head to knees".
3. **Jumping forward or backward** changes the apparent body scale. The
   baseline adapts slowly (about 4 s), and jumps are measured in torso
   lengths, so small drifts are fine.
4. **Camera behind the player** (as in the viral video): supported with the
   checkbox. Landmarks are a little less stable from behind (MediaPipe is
   trained mostly on front views), but the reference clip tracked well.

## Recommendation

**Go ahead with the camera. Don't build pocket input next.** It removes all
the setup the brief worried about (QR, HTTPS, server, iOS permissions, phone
in pocket). It makes lane changes absolute and self-correcting, which was the
brief's #1 risk. And it adds duck. The detection pipeline works end to end
and the software latency is small (~60 ms median).

**Before anything else**, run the 30-minute human test below. The likely
outcomes:

- *Feels good:* tune thresholds, add more obstacle variety, a two-lane
  hop (step twice), music.
- *Jumps or ducks feel late:* try a 60 fps webcam and TV Game Mode first, then
  lower thresholds. The velocity triggers already fire early.
- *Lanes feel twitchy:* raise `lane out` / `lane back` in debug.

## 30-minute human test checklist

1. Laptop (or webcam) by the TV over HDMI, `npm run build && npm run preview`,
   Chrome, fullscreen (F), TV in Game Mode.
2. Someone new to the game: time from "open URL" to "running" (target under
   30 s for calibration).
3. Debug on (G). Do 20 jumps, 20 ducks and 10 left+right pairs at the
   prompts. Count misses and false triggers from the graph markers.
4. Two 2-minute runs. Ask: did anything feel late or unfair? Fun (1–5)?
5. Film it at 240 fps: 10 jumps, 10 lane changes. Count frames from body to
   screen.
6. Download the latency log (debug → *download latency log*) and attach it.
7. Repeat once with the camera behind the player, and once in loose clothes.
