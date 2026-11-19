// Synthetic skeleton generator: produces MediaPipe-shaped landmark arrays for a
// player running in place, jumping, ducking and stepping sideways. Used by unit
// tests and by the in-browser "fake camera" mode (?fake=1) for headless e2e.
import type { Landmark } from './features';

export interface SynthState {
    t: number; // ms
    cx: number; // image-x centre of the body (0..1), image coordinates
    rise: number; // whole-body vertical offset, image units (+ = up)
    crouch: number; // 0..1
    running: boolean;
    cadence: number; // steps per minute
    noise: number; // landmark jitter (image units)
    vigor?: number; // 1 = gentle jog, 3 = vigorous high-knees with a big hip bounce
}

// Simple deterministic noise so tests are reproducible.
function hashNoise(i: number, t: number): number {
    const x = Math.sin(i * 12.9898 + t * 0.0781) * 43758.5453;
    return x - Math.floor(x) - 0.5;
}

/** Body ~0.55 of image height, standing in the centre. */
export function synthLandmarks(s: SynthState): Landmark[] {
    const lms: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.2 }));
    const torso = 0.2;
    const shoulderW = 0.11;
    const baseShoulderY = 0.32;
    // Squat: hips drop a lot (legs fold), torso leans a little.
    const crouchDrop = s.crouch * 0.15;
    const shoulderY = baseShoulderY - s.rise + crouchDrop;
    const hipY = shoulderY + torso - s.crouch * 0.01;
    const phase = ((s.t / 1000) * s.cadence) / 60 * Math.PI; // one half-cycle per step
    const vig = s.vigor ?? 1;
    const lift = s.running ? 0.05 * vig : 0;
    const lKneeLift = s.running ? Math.max(0, Math.sin(phase)) * lift : 0;
    const rKneeLift = s.running ? Math.max(0, -Math.sin(phase)) * lift : 0;
    // Upper body bounces with each step; vigorous running bounces a lot (this
    // is what used to look like a jump). The planted foot stays on the floor.
    const bob = s.running ? Math.abs(Math.sin(phase)) * 0.008 * vig * vig : 0;
    const n = (i: number) => hashNoise(i, s.t) * s.noise * 2;
    const set = (i: number, x: number, y: number, bobs = true) => {
        lms[i] = { x: x + n(i), y: y - (bobs ? bob : 0) + n(i + 100), z: 0, visibility: 0.95 };
    };
    // Camera faces the player: the person's LEFT appears on the image RIGHT.
    set(0, s.cx, shoulderY - 0.09);
    set(11, s.cx + shoulderW / 2, shoulderY);
    set(12, s.cx - shoulderW / 2, shoulderY);
    set(23, s.cx + 0.045, hipY);
    set(24, s.cx - 0.045, hipY);
    const kneeY = hipY + 0.17 - s.crouch * 0.1;
    set(25, s.cx + 0.05, kneeY - lKneeLift);
    set(26, s.cx - 0.05, kneeY - rKneeLift);
    // Ankles: the floor is fixed; a foot only rises when it is lifted (or on a jump).
    const floorY = baseShoulderY + torso + 0.34;
    set(27, s.cx + 0.05, floorY - s.rise - lKneeLift * 0.9, false);
    set(28, s.cx - 0.05, floorY - s.rise - rKneeLift * 0.9, false);
    return lms;
}

/** A scripted sequence of actions, sampled at `fps`, producing (t, landmarks). */
export type ScriptAction =
    | { kind: 'stand'; ms: number }
    | { kind: 'run'; ms: number; cadence?: number }
    | { kind: 'jump'; ms?: number; height?: number }
    | { kind: 'duck'; ms?: number; depth?: number }
    | { kind: 'step'; dir: -1 | 1; ms?: number; dist?: number }; // dir in PLAYER space

export function* runScript(
    actions: ScriptAction[],
    opts: { fps?: number; noise?: number; runWhile?: boolean; vigor?: number } = {},
): Generator<{ t: number; lms: Landmark[]; label?: string }> {
    const fps = opts.fps ?? 30;
    const dt = 1000 / fps;
    const st: SynthState = { t: 0, cx: 0.5, rise: 0, crouch: 0, running: false, cadence: 160, noise: opts.noise ?? 0.002, vigor: opts.vigor };
    for (const a of actions) {
        const ms = 'ms' in a && a.ms ? a.ms : a.kind === 'jump' ? 550 : a.kind === 'duck' ? 700 : a.kind === 'step' ? 350 : 1000;
        const frames = Math.max(1, Math.round(ms / dt));
        const startCx = st.cx;
        for (let i = 0; i < frames; i++) {
            const p = (i + 1) / frames;
            let label: string | undefined;
            if (i === 0) label = a.kind + ('dir' in a ? (a.dir < 0 ? ':left' : ':right') : '');
            if (a.kind === 'stand') {
                st.running = false;
            } else if (a.kind === 'run') {
                st.running = true;
                st.cadence = a.cadence ?? 160;
            } else if (a.kind === 'jump') {
                st.running = !!opts.runWhile;
                st.rise = 4 * p * (1 - p) * (a.height ?? 0.09);
            } else if (a.kind === 'duck') {
                st.running = false;
                st.crouch = Math.sin(p * Math.PI) > 0.2 ? Math.min(1, Math.sin(p * Math.PI) * 1.4) * (a.depth ?? 1) : 0;
            } else if (a.kind === 'step') {
                st.running = !!opts.runWhile;
                // player's left = image right (mirror)
                const target = startCx + -a.dir * (a.dist ?? 0.12);
                const e = p < 1 ? 0.5 - Math.cos(p * Math.PI) / 2 : 1;
                st.cx = startCx + (target - startCx) * e;
            }
            yield { t: st.t, lms: synthLandmarks(st), label };
            st.t += dt;
        }
        st.rise = 0;
        st.crouch = 0;
    }
}
