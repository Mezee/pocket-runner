# What the Android game does — Motion Sport Games AR (XAPK, 2.1)

Analysed locally from `/Users/chimeziechris-ike/Downloads/Motion+Sport+Games+AR_2.1_APKPure.xapk`
(package `com.motiongames`), on 2026-10-27. **No code was copied; this is a design comparison.**

## Tooling (and its limits)

- REA's `inspect_il2cpp_metadata` decoded Unity's `global-metadata.dat` (v31) and linked it to
  `libil2cpp.so`, giving C# class names, method names and **native addresses**.
- REA's decompiler backends (Ghidra/Hopper/IDA/Kuna) are **not installed** (`rea doctor`: all
  `missing_analysis_engine`), so decompilation was unavailable. Method bodies were read as ARM64
  disassembly with `objdump`, cross-checked against the metadata. **Constants below are read from
  instructions**, not from source, and method *names* are metadata, not proof of semantics.
- The game's ducking/squatting logic was **not located**. It has a separate *Duck Hunt* minigame,
  but that's shooting ducks, not ducking.

## Architecture

Unity + IL2CPP, with **MediaPipe Pose** (same model family we use) and TensorFlow Lite.

`MotionModuleV2` is the input layer shared by the minigames. Its fields are telling:

```
_jumpDetect, _leftFoot, _rightFoot, onJumped, _lFootStartY, _rFootStartY,
_jumpDetectStarted, _isJumping,
_walkDetect, stepResetInterval, _lKnee, _rKnee, _currentStepInterval,
_successivesteps, _isSteping, _lFootStartYForWalk, _rFootStartYForWalk,
isWalking, walkSpeed, _raisedLeftFoor, _raisedRightFoor, _walkDetectStarted,
_playerPosConfirmed, _outOfBoxCount, _reCalibrating, reCalibrationCam,
_requiredPoints, _detectedBodyParts, _distThreshold, _bodyPointDetected,
_handCircleGestureR/L (hand-circle gestures for the menu)
```

`Runner` (the Subway-style game) has: `Jump`, `MoveLeft`, `MoveRight`, `Scroll`, `Update`,
`CheckY`, `OnTriggerEnter`, `WrongMove`, `EndGame`.

## Findings, with evidence

### 1. Jump = both feet above where they were, by > 25 units

`MotionModuleV2.FixedUpdate` (`0x1d2c620`):

- reads both foot transforms' Y each frame and compares with `_lFootStartY` / `_rFootStartY`;
- if **current Y > start Y** for both feet, computes `|current − start|` for each and compares
  to **`fmov s1, #25.0`**;
- only if **both** differences exceed 25 does it set `_isJumping = true` and invoke `onJumped`
  with **`fmov s0, #1.5`**;
- afterwards it stores the current foot Y back into the start fields (so "start" means
  *previous sample*, not calibration).

**Same idea as ours** (both feet off the floor), but the units are their Unity scene units and
the reference is the previous frame, so it is a *per-frame rise*, not "feet above the floor".
Also note `ResetJump` is just `_isJumping = false`.

### 2. The jump is a fixed 1.5-second animation

`onJumped(1.5)` starts a timed callback (`Invoke`), not a "while you're in the air" state.
`Runner.Jump` reads an animation state, sets gravity to **2.0**, and sets vertical velocity using
`Mathf.Lerp(1, 2, ...)`. **The jump's length is fixed; the player's actual airborne time doesn't
matter.** Same as our 0.6 s arc.

### 3. Lanes are continuous, not thirds

`Runner.Update` (`0x1dcce74`) computes `_playerX = (leftFootX + rightFootX) / 2` (average of both
feet, stored at `#0x104`), then moves the character with **`Mathf.Lerp(current, target,
Time.deltaTime * 8)`** toward it, and clamps position to ±2. `MoveLeft`/`MoveRight` are only
small helpers that pass −1/+1 into a DOTween move.

**They do not snap to three lanes.** They track your lateral position continuously and smooth it.

### 4. Calibration is a single snapshot

`SetBodyPoints` stores `_visibilityThreshold = 0.5`, a duration of 1.0 and 75.0, and captures the
body points once (no long sequence). There's a `_reCalibrating` flag, `_outOfBoxCount` and a
`reCalibrationCam`, i.e. **they recalibrate when you leave the frame**.

### 5. Walking drives speed, with a step-reset interval

Fields `stepResetInterval`, `_currentStepInterval`, `_successivesteps`, `_isSteping`, `isWalking`
and `walkSpeed` show walking is detected from knees/feet and drives forward speed, with a reset
interval that drops you out of walking when you stop stepping.

## What this means for Pocket Runner

- **Both-feet-off-the-floor for jump is a sound, shipped approach.** Keep it.
- **Timed moves (jump/slide) are normal.** But a duck should be *held*, not timed: it is a
  posture, and the player controls its length. Ours is held; good.
- **Continuous lateral tracking may feel better than three hard lanes.** Their game lerps
  toward your actual position. Our "thirds of the image" is a reasonable simplification for a
  three-lane game, and you asked for exact thirds; but if it feels rigid, a smoothed lerp
  toward the centre third (not the raw body x) is the version that stays fair.
- **One-snapshot calibration and recalibration on losing the player** match what we do.
