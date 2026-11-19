// Body-move detector: Features stream -> moves + cadence. Pure (no DOM), so it
// is driven by synthetic data in tests and by MediaPipe in the browser.
//
// All distances are normalised by the player's own body so camera distance
// doesn't matter:
//   vertical   -> torso length (hip-to-shoulder)
//   horizontal -> shoulder width
//
// Moves
//   jump  : BOTH feet leave the floor: the lower of the two ankles rises above
//           its standing level by > jumpFoot torsos (while running one foot is
//           always planted, so running steps don't count), AND the hips rise
//           fast. Fires on take-off. Falls back to knees, then hips only, if
//           the feet are out of frame.
//   duck  : your head drops, measured as (head − lowest foot) shrinking below
//           duckDown × its standing value. Measuring against your OWN FEET (not
//           a line in the picture) means walking closer to the camera can't
//           fake a duck: head and feet move together. The duck lasts exactly as
//           long as you're down and springs back when you stand (hysteresis:
//           release at 60% of the enter threshold). No time limit.
//   lanes : the camera image is split into three EQUAL thirds. The third your
//           body centre is in is your lane, with a small dead band at each
//           boundary so you don't flicker between lanes.
//   cadence: running in place makes the knees alternate; each sign change of
//           (leftKneeY - rightKneeY) is a step. Falls back to hip-bob peaks
//           when the knees are out of frame.

import type { Features } from './features';
import type { Move } from './types';

export interface Thresholds {
    jumpUp: number; // torsos above baseline
    jumpVel: number; // torsos/sec upward
    duckDown: number; // fraction of standing head-to-foot height lost while crouched
    jumpFoot: number; // torsos: lower foot must rise this much (both feet off the floor)
    laneDead: number; // image fraction: hysteresis band around each third boundary
    runCadence: number; // steps/min to count as running
}

export const DEFAULT_THRESHOLDS: Thresholds = {
    jumpUp: 0.2,
    jumpVel: 1.1,
    duckDown: 0.22,
    jumpFoot: 0.12,
    laneDead: 0.03,
    runCadence: 70,
};

export interface Baseline {
    hipY: number;
    shoulderY: number;
    torso: number;
    shoulderW: number;
    cx: number;
    footY?: number | null; // standing level of the feet (image y)
    headToFoot?: number | null; // standing head-to-foot height (image units)
}

export interface DetectedMove {
    move: Move;
    t: number; // feature time that fired it
    onset: number; // estimated motion start time
    zone?: -1 | 0 | 1;
    hold?: boolean;
}

export interface Signals {
    t: number;
    ok: boolean;
    up: number; // hip rise above baseline, torsos (+ = up)
    upVel: number; // torsos/sec
    drop: number; // crouch: fraction of standing head-to-foot height lost (or shoulder drop in torsos with no legs)
    lat: number; // body centre in image units, player-relative (-0.5..0.5, + = player's right)
    latVel: number;
    foot: number; // lower-foot rise above standing level, torsos (+ = both feet up)
    knee: number; // kneeDiff (torsos), 0 if unknown
    cadence: number;
    zone: -1 | 0 | 1;
}

const JUMP_LOCK_MS = 420;
// Feet must stay off the floor for ~2 frames: running steps blip for 1 frame.
const FEET_OFF_MIN_MS = 45;
// If feet were seen this recently, never fall back to hips-only jump detection.
const FEET_RECENT_MS = 1000;
const LAND_LOCK_MS = 350; // ignore duck right after landing (knees bend)
const DUCK_HOLD_MS = 280;
const CADENCE_WINDOW_MS = 2500;
const RUN_HOLD_MS = 1200;
const KNEE_HYST = 0.08;
const BOB_HYST = 0.03;

export class MoveDetector {
    th: Thresholds = { ...DEFAULT_THRESHOLDS };
    base: Baseline | null = null;

    private prev: Features | null = null;
    private upF = 0; // smoothed signals
    private dropF = 0;
    private latF = 0;
    private upVelF = 0;
    private latVelF = 0;
    private footF = 0;
    private footBase: number | null = null;
    private footBaseSrc: 'ankle' | 'knee' | null = null;
    private feetSeenAt = -1e9;
    private feetOffSince = -1;
    private lastJump = -1e9;
    private airborne = false;
    private landedAt = -1e9;
    private ducking = false;
    private lastDuckPulse = -1e9;
    private zone: -1 | 0 | 1 = 0;
    private latOnset = -1;
    private upOnset = -1;
    private dropOnset = -1;
    private headBase: number | null = null;
    private headBaseSrc: 'ankle' | 'knee' | null = null;
    private kneeSign = 0;
    private bobSign = 0;
    private steps: number[] = [];
    private lastRunning = -1e9;
    cadence = 0;
    running = false;
    /** Total steps counted since the detector was created (bonus score, never gameplay). */
    stepCount = 0;
    signals: Signals = { t: 0, ok: false, up: 0, upVel: 0, drop: 0, lat: 0, latVel: 0, foot: 0, knee: 0, cadence: 0, zone: 0 };

    setBaseline(b: Baseline): void {
        this.base = { ...b };
        this.footBase = b.footY ?? null;
        this.footBaseSrc = b.footY != null ? 'ankle' : null;
        this.headBase = b.headToFoot ?? null;
        this.headBaseSrc = b.headToFoot != null ? 'ankle' : null;
        this.zone = 0;
        this.reset();
    }

    reset(): void {
        this.prev = null;
        this.upF = this.dropF = this.latF = this.upVelF = this.latVelF = this.footF = 0;
        this.airborne = false;
        this.ducking = false;
        this.steps = [];
    }

    get currentZone(): -1 | 0 | 1 {
        return this.zone;
    }

    /** Feed one frame of features. Returns any moves detected on this frame. */
    update(f: Features): DetectedMove[] {
        const out: DetectedMove[] = [];
        const b = this.base;
        if (!b || !f.ok) {
            this.signals = { ...this.signals, t: f.t, ok: false };
            this.prev = null;
            this.updateCadence(f.t, null);
            return out;
        }
        const dt = this.prev ? Math.max(1, f.t - this.prev.t) / 1000 : 1 / 30;

        // Slowly adapt scale (player drifts toward/away from the camera) while neutral.
        const neutral = !this.airborne && !this.ducking && Math.abs(this.upF) < 0.08 && Math.abs(this.dropF) < 0.08;
        if (neutral) {
            const k = Math.min(1, dt / 4); // ~4 s time constant
            b.torso += (f.torso - b.torso) * k;
            b.shoulderW += (f.shoulderW - b.shoulderW) * k;
            b.hipY += (f.hipY - b.hipY) * k * 0.5;
            b.shoulderY += (f.shoulderY - b.shoulderY) * k * 0.5;
        }
        // Feet: track the floor level. Follow quickly downward (feet back on the
        // floor), slowly upward, and never while airborne.
        // Ankle- and knee-based foot heights aren't comparable: only use the
        // same landmark the floor level was measured with.
        const footY = f.footSrc !== null && (this.footBaseSrc === null || f.footSrc === this.footBaseSrc) ? f.footY : null;
        if (f.footSrc !== null && this.footBaseSrc !== null && f.footSrc !== this.footBaseSrc && f.t - this.feetSeenAt > 1500) {
            // landmark changed for good (e.g. stepped closer, ankles out of frame): re-measure the floor
            this.footBase = null;
            this.footBaseSrc = null;
        }
        if (footY !== null) {
            this.feetSeenAt = f.t;
            if (this.footBase === null) {
                this.footBase = footY;
                this.footBaseSrc = f.footSrc;
            } else if (!this.airborne) {
                const kf = footY > this.footBase ? Math.min(1, dt / 0.3) : Math.min(1, dt / 3);
                this.footBase += (footY - this.footBase) * kf;
            }
        }

        const up = (b.hipY - f.hipY) / b.torso;
        // Crouch: head drop measured against your feet (scale-free, so walking
        // closer to the camera can't fake it). Falls back to shoulder drop only
        // if no feet are visible.
        if (f.headToFoot !== null && f.footSrc !== this.headBaseSrc && this.headBaseSrc !== null) {
            this.headBase = null; // landmark changed: re-measure standing height
        }
        if (f.headToFoot !== null && this.headBase === null) {
            this.headBase = f.headToFoot;
            this.headBaseSrc = f.footSrc;
        }
        const headDrop = f.headToFoot !== null && this.headBase && f.footSrc === this.headBaseSrc ? 1 - f.headToFoot / this.headBase : null;
        const drop = headDrop ?? (f.shoulderY - b.shoulderY) / b.torso;
        // Slowly re-learn standing height while clearly upright (posture changes).
        if (headDrop !== null && f.headToFoot !== null && this.headBase && !this.ducking && !this.airborne && headDrop < this.th.duckDown * 0.3) {
            this.headBase += (f.headToFoot - this.headBase) * Math.min(1, dt / 4);
        }

        const lat = f.cx; // image-relative: lanes are fixed thirds of the frame
        const foot = footY !== null && this.footBase !== null ? (this.footBase - footY) / b.torso : null;

        // Light smoothing (one-pole, ~2 frames) — enough to kill jitter without much lag.
        const a = Math.min(1, dt / 0.045);
        const prevUp = this.upF;
        const prevLat = this.latF;
        this.upF += (up - this.upF) * a;
        this.dropF += (drop - this.dropF) * a;
        this.latF += (lat - this.latF) * a;
        if (foot !== null) this.footF += (foot - this.footF) * a;
        const va = Math.min(1, dt / 0.06);
        this.upVelF += ((this.upF - prevUp) / dt - this.upVelF) * va;
        this.latVelF += ((this.latF - prevLat) / dt - this.latVelF) * va;

        const t = f.t;
        const th = this.th;

        // ---- Jump (rising edge) ----
        if (this.upVelF > th.jumpVel * 0.4 && this.upOnset < 0) this.upOnset = t;
        if (this.upVelF <= 0) this.upOnset = -1;
        if (!this.airborne && t - this.lastJump > JUMP_LOCK_MS) {
            const strong = this.upF > th.jumpUp && this.upVelF > th.jumpVel * 0.5;
            const early = this.upF > th.jumpUp * 0.6 && this.upVelF > th.jumpVel * 1.6;
            // Both feet must be off the floor. Knees as "feet" lift a lot when
            // running (high knees), so they need a bigger margin. With no legs in
            // frame we fall back to hips only (old behaviour).
            const footNeed = this.footBaseSrc === 'knee' ? th.jumpFoot * 1.8 : th.jumpFoot;
            const feetUp = foot !== null && this.footF > footNeed;
            if (feetUp) {
                if (this.feetOffSince < 0) this.feetOffSince = t;
            } else this.feetOffSince = -1;
            const feetSustained = feetUp && t - this.feetOffSince >= FEET_OFF_MIN_MS;
            // Hips-only fallback ONLY if we haven't seen feet for a while (legs out of frame).
            const noFeet = foot === null && t - this.feetSeenAt > FEET_RECENT_MS;
            const feetOff = feetSustained || noFeet;
            if ((strong || early) && feetOff) {
                this.ducking = false; // a jump always wins over a (possibly stale) duck
                this.airborne = true;
                this.lastJump = t;
                out.push({ move: 'jump', t, onset: this.upOnset > 0 ? this.upOnset : t });
            }
        }
        if (this.airborne && ((this.upF < th.jumpUp * 0.35 && t - this.lastJump > 150) || t - this.lastJump > 1200)) {
            this.airborne = false;
            this.landedAt = t;
        }

        // ---- Duck (hold) ----
        if (this.dropF > th.duckDown * 0.4 && this.dropOnset < 0) this.dropOnset = t;
        if (this.dropF < th.duckDown * 0.2) this.dropOnset = -1;
        const canDuck = !this.airborne && t - this.landedAt > LAND_LOCK_MS;
        if (!this.ducking && canDuck && this.dropF > th.duckDown) {
            this.ducking = true;
            this.lastDuckPulse = t;
            out.push({ move: 'duck', t, onset: this.dropOnset > 0 ? this.dropOnset : t });
        } else if (this.ducking) {
            if (this.dropF < th.duckDown * 0.6) this.ducking = false; // springs back when you stand
            else if (t - this.lastDuckPulse > DUCK_HOLD_MS) {
                this.lastDuckPulse = t;
                out.push({ move: 'duck', t, onset: t, hold: true });
            }
        }

        // ---- Lanes: equal thirds of the image, with a dead band ----
        const L = this.latF; // -0.5..0.5
        const v = this.latVelF;
        if (Math.abs(v) > 0.25 && this.latOnset < 0) this.latOnset = t;
        if (Math.abs(v) < 0.1) this.latOnset = -1;
        const edge = 1 / 6; // boundary between thirds, from the centre
        const dz = th.laneDead;
        let z = this.zone;
        if (L > edge + dz) z = 1;
        else if (L < -edge - dz) z = -1;
        else if (Math.abs(L) < edge - dz) z = 0;
        // inside a dead band: keep the current lane
        if (z !== this.zone) {
            const move: Move = z > this.zone ? 'right' : 'left';
            this.zone = z;
            out.push({ move, t, onset: this.latOnset > 0 ? this.latOnset : t, zone: z });
        }

        this.updateCadence(t, f);
        this.prev = f;
        this.signals = { t, ok: true, up: this.upF, upVel: this.upVelF, drop: this.dropF, lat: this.latF, latVel: this.latVelF, foot: this.footF, knee: f.kneeDiff ?? 0, cadence: this.cadence, zone: this.zone };
        return out;
    }

    private updateCadence(t: number, f: Features | null): void {
        // Only a fresh jump pauses step counting; a stuck airborne/duck state must
        // never freeze cadence (that would stop the runner).
        if (f && t - this.lastJump > 600) {
            if (f.kneeDiff !== null) {
                const s = f.kneeDiff > KNEE_HYST ? 1 : f.kneeDiff < -KNEE_HYST ? -1 : 0;
                if (s !== 0 && s !== this.kneeSign) {
                    if (this.kneeSign !== 0) {
                        this.steps.push(t);
                        this.stepCount++;
                    }
                    this.kneeSign = s;
                }
            } else {
                // fallback: hip bob, one peak per step
                const s = this.upF > BOB_HYST ? 1 : this.upF < -BOB_HYST ? -1 : 0;
                if (s === 1 && this.bobSign === -1) {
                    this.steps.push(t);
                    this.stepCount++;
                }
                if (s !== 0) this.bobSign = s;
            }
        }
        while (this.steps.length && t - this.steps[0] > CADENCE_WINDOW_MS) this.steps.shift();
        // need at least 3 steps in the window to call it cadence
        const raw = this.steps.length >= 3 ? ((this.steps.length - 1) / Math.max(0.4, (t - this.steps[0]) / 1000)) * 60 : 0;
        // if the last step is old, decay toward 0
        const sinceLast = this.steps.length ? t - this.steps[this.steps.length - 1] : 1e9;
        const target = sinceLast > 900 ? 0 : raw;
        this.cadence += (target - this.cadence) * 0.15;
        if (this.cadence < 5) this.cadence = target === 0 ? 0 : this.cadence;
        if (this.cadence > this.th.runCadence) this.lastRunning = t;
        this.running = t - this.lastRunning < RUN_HOLD_MS;
    }
}
