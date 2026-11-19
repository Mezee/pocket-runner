// Calibration: stand still (baseline), then one test of each move to set the
// player's personal thresholds. Pure state machine; the UI just renders `step`.
//
//   stand  (2.5 s still)  -> baseline hip/shoulder height, torso, shoulder width, centre
//   jump   (one jump)     -> jumpUp = 45% of measured peak rise (clamped)
//   duck   (one squat)    -> duckDown = 50% of measured peak drop (clamped)
//   (no lane calibration: lanes are fixed thirds of the camera image)
//
// Each test step times out and keeps defaults, so calibration never gets stuck.

import type { Features } from './features';
import { DEFAULT_THRESHOLDS, type Baseline, type Thresholds } from './detector';

export type CalStep = 'find' | 'stand' | 'jump' | 'duck' | 'left' | 'right' | 'done';

export const CAL_PROMPTS: Record<CalStep, { title: string; sub: string }> = {
    find: { title: 'STEP INTO VIEW', sub: 'Stand 2–3 m back, in the middle: head to FEET visible' },
    stand: { title: 'STAND STILL', sub: 'Measuring you…' },
    jump: { title: 'JUMP!', sub: 'One big jump on the spot' },
    duck: { title: 'DUCK!', sub: 'Squat down, then stand back up' },
    // lanes need no calibration (fixed thirds); kept for type completeness
    left: { title: 'STEP LEFT', sub: 'One big step to your left, then come back' },
    right: { title: 'STEP RIGHT', sub: 'One big step to your right, then come back' },
    done: { title: 'READY!', sub: 'Jump to start' },
};

const STAND_MS = 2500;
const FIND_MS = 600;
const TEST_TIMEOUT_MS = 7000;
const MAX_STILL_SPREAD = 0.08; // torsos

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1] ?? 0;
};

export class Calibrator {
    step: CalStep = 'find';
    stepStarted = 0;
    progress = 0; // 0..1 for the current step
    base: Baseline | null = null;
    th: Thresholds = { ...DEFAULT_THRESHOLDS };
    measured: Partial<Record<'jump' | 'duck' | 'left' | 'right', number>> = {};
    private buf: Features[] = [];
    private peak = 0;
    private footPeak = 0;
    private returned = false;

    start(t: number): void {
        this.step = 'find';
        this.stepStarted = t;
        this.progress = 0;
        this.buf = [];
        this.base = null;
        this.th = { ...DEFAULT_THRESHOLDS };
        this.measured = {};
    }

    /** Skip straight to done with a baseline from the current frame (keyboard 'C'). */
    get done(): boolean {
        return this.step === 'done';
    }

    private go(step: CalStep, t: number): void {
        this.step = step;
        this.stepStarted = t;
        this.progress = 0;
        this.peak = 0;
        if (step === 'jump') this.footPeak = 0;
        this.returned = false;
        this.buf = [];
    }

    update(f: Features): void {
        const t = f.t;
        const el = t - this.stepStarted;
        switch (this.step) {
            case 'find':
                if (f.ok && f.vis.head) {
                    this.progress = clamp(el / FIND_MS, 0, 1);
                    if (el > FIND_MS) this.go('stand', t);
                } else this.stepStarted = t;
                return;
            case 'stand': {
                if (!f.ok) {
                    this.go('find', t);
                    return;
                }
                this.buf.push(f);
                while (this.buf.length && t - this.buf[0].t > STAND_MS) this.buf.shift();
                const span = this.buf.length ? t - this.buf[0].t : 0;
                const torso = median(this.buf.map((b) => b.torso));
                const hips = this.buf.map((b) => b.hipY);
                const spread = (Math.max(...hips) - Math.min(...hips)) / Math.max(0.02, torso);
                if (spread > MAX_STILL_SPREAD * 2) {
                    // moved too much: restart the window
                    this.buf = [f];
                    this.progress = 0;
                    return;
                }
                this.progress = clamp(span / STAND_MS, 0, 1);
                if (span >= STAND_MS * 0.98) {
                    this.base = {
                        hipY: median(hips),
                        shoulderY: median(this.buf.map((b) => b.shoulderY)),
                        torso,
                        shoulderW: median(this.buf.map((b) => b.shoulderW)),
                        cx: median(this.buf.map((b) => b.cx)),
                        footY: this.buf.every((b) => b.footY !== null) ? median(this.buf.map((b) => b.footY as number)) : null,
                        headToFoot: this.buf.every((b) => b.headToFoot !== null) ? median(this.buf.map((b) => b.headToFoot as number)) : null,
                    };
                    this.go('jump', t);
                }
                return;
            }
            case 'jump':
            case 'duck':
            case 'left':
            case 'right': {
                const b = this.base!;
                if (!f.ok) return;
                let v = 0;
                if (this.step === 'jump') {
                    v = (b.hipY - f.hipY) / b.torso;
                    if (f.footY !== null && b.footY) this.footPeak = Math.max(this.footPeak, (b.footY - f.footY) / b.torso);
                }
                if (this.step === 'duck') v = f.headToFoot !== null && b.headToFoot ? (b.headToFoot - f.headToFoot) / b.headToFoot : (f.shoulderY - b.shoulderY) / b.torso;
                if (this.step === 'left') v = -(f.cx - b.cx) / b.shoulderW;
                if (this.step === 'right') v = (f.cx - b.cx) / b.shoulderW;
                this.peak = Math.max(this.peak, v);
                const enough = { jump: 0.18, duck: 0.15, left: 0.7, right: 0.7 }[this.step];
                if (this.peak > enough && v < this.peak * 0.4) this.returned = true;
                this.progress = clamp(this.peak / (enough * 1.6), 0, 1);
                const timeout = el > TEST_TIMEOUT_MS;
                if (this.returned || timeout) {
                    if (this.returned) this.measured[this.step] = this.peak;
                    this.apply();
                    const next: Record<string, CalStep> = { jump: 'duck', duck: 'done', left: 'done', right: 'done' };
                    this.go(next[this.step], t);
                }
                return;
            }
            case 'done':
                return;
        }
    }

    private apply(): void {
        const m = this.measured;
        const d = DEFAULT_THRESHOLDS;
        if (m.jump) this.th.jumpUp = clamp(m.jump * 0.45, 0.12, d.jumpUp * 1.3);
        if (m.duck) this.th.duckDown = clamp(m.duck * 0.5, 0.12, d.duckDown * 1.4);
        // Feet must rise ~40% of how high they rose in your test jump.
        if (m.jump && this.footPeak > 0.1) this.th.jumpFoot = clamp(this.footPeak * 0.4, 0.07, 0.25);
    }

    /** Instant calibration from a single standing frame (dev / keyboard). */
    quick(f: Features): boolean {
        if (!f.ok) return false;
        this.base = { hipY: f.hipY, shoulderY: f.shoulderY, torso: f.torso, shoulderW: f.shoulderW, cx: f.cx, footY: f.footY, headToFoot: f.headToFoot };
        this.th = { ...DEFAULT_THRESHOLDS };
        this.go('done', f.t);
        return true;
    }
}
