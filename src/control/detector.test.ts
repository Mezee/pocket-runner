import { describe, expect, it } from 'vitest';
import { extractFeatures } from './features';
import { MoveDetector, type DetectedMove } from './detector';
import { Calibrator } from './calibration';
import { runScript, type ScriptAction } from './synth';

function calibrated(noise = 0.002): MoveDetector {
    const cal = new Calibrator();
    cal.start(0);
    const script: ScriptAction[] = [
        { kind: 'stand', ms: 3600 },
        { kind: 'jump' },
        { kind: 'stand', ms: 600 },
        { kind: 'duck' },
        { kind: 'stand', ms: 600 },
        { kind: 'stand', ms: 500 },
    ];
    for (const fr of runScript(script, { noise })) cal.update(extractFeatures(fr.lms, fr.t, true));
    expect(cal.step).toBe('done');
    const d = new MoveDetector();
    d.setBaseline(cal.base!);
    d.th = cal.th;
    return d;
}

function feed(d: MoveDetector, script: ScriptAction[], opts: { noise?: number; runWhile?: boolean; t0?: number; vigor?: number } = {}) {
    const moves: DetectedMove[] = [];
    const labels: { t: number; label: string }[] = [];
    const t0 = opts.t0 ?? 100000;
    for (const fr of runScript(script, opts)) {
        const t = fr.t + t0;
        if (fr.label) labels.push({ t, label: fr.label });
        moves.push(...d.update(extractFeatures(fr.lms, t, true)));
    }
    return { moves, labels };
}

describe('calibration', () => {
    it('produces a baseline and personal thresholds from one of each move', () => {
        const d = calibrated();
        expect(d.base!.torso).toBeGreaterThan(0.1);
        expect(d.th.jumpUp).toBeGreaterThan(0.1);
    });
});

describe('jump vs running', () => {
    it('vigorous high-knees running (big hip bounce) never counts as a jump', () => {
        const d = calibrated();
        for (const vigor of [1, 2, 3]) {
            const { moves } = feed(d, [{ kind: 'run', ms: 8000, cadence: 180 }], { noise: 0.003, vigor, t0: 100000 * vigor });
            expect(moves.filter((m) => m.move === 'jump').length, `vigor ${vigor}`).toBe(0);
        }
    });

    it('a real jump while running vigorously is still detected', () => {
        const d = calibrated();
        const { moves } = feed(d, [{ kind: 'run', ms: 2000 }, { kind: 'jump', ms: 550 }, { kind: 'run', ms: 2000 }], { runWhile: true, vigor: 2.5 });
        expect(moves.filter((m) => m.move === 'jump').length).toBe(1);
    });
});

describe('lanes are fixed thirds', () => {
    it('zone follows which third of the image the body is in', () => {
        const d = calibrated();
        // player's left = image right when mirrored; dist 0.25 from centre crosses the 1/6 boundary
        const { moves } = feed(d, [
            { kind: 'stand', ms: 500 },
            { kind: 'step', dir: -1, dist: 0.25 },
            { kind: 'stand', ms: 500 },
            { kind: 'step', dir: 1, dist: 0.25 },
            { kind: 'stand', ms: 500 },
            { kind: 'step', dir: 1, dist: 0.25 },
            { kind: 'stand', ms: 500 },
        ]);
        expect(moves.filter((m) => m.move === 'left' || m.move === 'right').map((m) => m.move)).toEqual(['left', 'right', 'right']);
        expect(d.currentZone).toBe(1);
    });

    it('small sways inside the centre third do not change lane', () => {
        const d = calibrated();
        const { moves } = feed(d, [
            { kind: 'step', dir: -1, dist: 0.1 },
            { kind: 'step', dir: 1, dist: 0.2 },
            { kind: 'step', dir: -1, dist: 0.1 },
        ]);
        expect(moves.filter((m) => m.move === 'left' || m.move === 'right')).toEqual([]);
    });
});

describe('detector', () => {
    it('standing still with noise produces no moves', () => {
        const d = calibrated();
        const { moves } = feed(d, [{ kind: 'stand', ms: 10000 }], { noise: 0.004 });
        expect(moves).toEqual([]);
    });

    it('running in place produces no false moves and a running cadence', () => {
        const d = calibrated();
        const { moves } = feed(d, [{ kind: 'run', ms: 10000, cadence: 160 }], { noise: 0.003 });
        expect(moves.map((m) => m.move)).toEqual([]);
        expect(d.running).toBe(true);
        expect(d.cadence).toBeGreaterThan(110);
        expect(d.cadence).toBeLessThan(210);
    });

    it('stopping drops cadence to 0 and running to false', () => {
        const d = calibrated();
        feed(d, [{ kind: 'run', ms: 4000 }, { kind: 'stand', ms: 3000 }]);
        expect(d.cadence).toBeLessThan(10);
        expect(d.running).toBe(false);
    });

    it('detects a jump while running, early in the jump (take-off, not landing)', () => {
        const d = calibrated();
        const { moves, labels } = feed(d, [{ kind: 'run', ms: 2000 }, { kind: 'jump', ms: 550 }, { kind: 'run', ms: 1500 }], { runWhile: true });
        const jumps = moves.filter((m) => m.move === 'jump');
        expect(jumps.length).toBe(1);
        const start = labels.find((l) => l.label === 'jump')!.t;
        expect(jumps[0].t - start).toBeLessThan(200);
    });

    it('detects a duck', () => {
        const d = calibrated();
        const { moves } = feed(d, [{ kind: 'run', ms: 1500 }, { kind: 'duck', ms: 800 }, { kind: 'run', ms: 1500 }]);
        expect(moves.filter((m) => m.move === 'duck' && !m.hold).length).toBe(1);
        expect(moves.filter((m) => m.move === 'jump').length).toBe(0);
    });

    it('detects step left / step right as lane changes with correct direction', () => {
        const d = calibrated();
        const { moves } = feed(
            d,
            [
                { kind: 'run', ms: 1000 },
                { kind: 'step', dir: -1, dist: 0.25 },
                { kind: 'run', ms: 800 },
                { kind: 'step', dir: 1, dist: 0.25 },
                { kind: 'run', ms: 800 },
                { kind: 'step', dir: 1, dist: 0.25 },
                { kind: 'run', ms: 800 },
            ],
            { runWhile: true },
        );
        expect(moves.filter((m) => m.move === 'left' || m.move === 'right').map((m) => m.move)).toEqual(['left', 'right', 'right']);
        expect(d.currentZone).toBe(1);
    });

    it('20 jumps and 20 lane changes: hit rate >= 95% on synthetic data', () => {
        const d = calibrated();
        const script: ScriptAction[] = [{ kind: 'run', ms: 1500 }];
        for (let i = 0; i < 20; i++) script.push({ kind: 'jump', height: 0.06 + (i % 4) * 0.01 }, { kind: 'run', ms: 900 });
        for (let i = 0; i < 10; i++) script.push({ kind: 'step', dir: -1, dist: 0.25 }, { kind: 'run', ms: 700 }, { kind: 'step', dir: 1, dist: 0.25 }, { kind: 'run', ms: 700 });
        const { moves } = feed(d, script, { noise: 0.003, runWhile: true });
        const jumps = moves.filter((m) => m.move === 'jump').length;
        const lanes = moves.filter((m) => m.move === 'left' || m.move === 'right').length;
        expect(jumps).toBeGreaterThanOrEqual(19);
        expect(jumps).toBeLessThanOrEqual(20);
        expect(lanes).toBeGreaterThanOrEqual(19);
        expect(lanes).toBeLessThanOrEqual(20);
    });
});

import { pickPlayer } from './features';
import { synthLandmarks } from './synth';

describe('multi-person', () => {
    const body = (cx: number, scale = 1) =>
        synthLandmarks({ t: 0, cx, rise: 0, crouch: 0, running: false, cadence: 0, noise: 0 }).map((l) => ({ ...l, y: 0.5 + (l.y - 0.5) * scale }));
    it('keeps tracking the player when a bystander appears', () => {
        const player = body(0.5);
        const bystander = body(0.8, 1.3); // bigger (closer to camera)
        expect(pickPlayer([bystander, player], 0.5)).toBe(player);
    });
    it('with no history, picks the largest body', () => {
        const near = body(0.3, 1.3);
        const far = body(0.7, 0.8);
        expect(pickPlayer([far, near], null)).toBe(near);
    });
});

describe('duck never sticks', () => {
    // Shift every landmark down (closer to camera / lower in the picture) and scale up.
    const feedTransformed = (d: MoveDetector, script: ScriptAction[], tf: (t: number) => { dy: number; k: number }, t0: number) => {
        const moves: DetectedMove[] = [];
        for (const fr of runScript(script)) {
            const { dy, k } = tf(fr.t);
            const lms = fr.lms.map((l) => ({ ...l, y: 0.5 + (l.y - 0.5) * k + dy }));
            moves.push(...d.update(extractFeatures(lms, fr.t + t0, true)));
        }
        return moves;
    };

    it('walking closer to the camera (body lower + bigger in frame) does not duck', () => {
        const d = calibrated();
        const moves = feedTransformed(d, [{ kind: 'run', ms: 6000 }], (t) => ({ dy: Math.min(1, t / 3000) * 0.08, k: 1 + Math.min(1, t / 3000) * 0.15 }), 200000);
        expect(moves.filter((m) => m.move === 'duck')).toEqual([]);
    });

    it('duck lasts as long as you hold it, and springs back when you stand', () => {
        const d = calibrated();
        const held: DetectedMove[] = [];
        // hold a crouch for 6 s: duck should still be active (no arbitrary timeout)
        for (let i = 0; i < 180; i++) {
            const lms = synthLandmarks({ t: i * 33, cx: 0.5, rise: 0, crouch: 0.8, running: false, cadence: 0, noise: 0.002 });
            held.push(...d.update(extractFeatures(lms, 300000 + i * 33, true)));
        }
        expect(held.some((m) => m.move === 'duck' && !m.hold)).toBe(true);
        expect(held[held.length - 1].move).toBe('duck'); // still holding at the end
        // stand up: no more duck pulses
        const after: DetectedMove[] = [];
        for (let i = 0; i < 30; i++) {
            const lms = synthLandmarks({ t: i * 33, cx: 0.5, rise: 0, crouch: 0, running: false, cadence: 0, noise: 0.002 });
            after.push(...d.update(extractFeatures(lms, 310000 + i * 33, true)));
        }
        expect(after.filter((m) => m.move === 'duck')).toEqual([]);
        // and it can duck again straight away
        const again: DetectedMove[] = [];
        for (let i = 0; i < 30; i++) {
            const lms = synthLandmarks({ t: i * 33, cx: 0.5, rise: 0, crouch: 0.8, running: false, cadence: 0, noise: 0.002 });
            again.push(...d.update(extractFeatures(lms, 311000 + i * 33, true)));
        }
        expect(again.filter((m) => m.move === 'duck' && !m.hold).length).toBe(1);
    });

    it('a squat is still detected after walking closer', () => {
        const d = calibrated();
        feedTransformed(d, [{ kind: 'stand', ms: 5000 }], (t) => ({ dy: Math.min(1, t / 2000) * 0.08, k: 1 + Math.min(1, t / 2000) * 0.15 }), 400000);
        const moves = feedTransformed(d, [{ kind: 'stand', ms: 300 }, { kind: 'duck', ms: 800 }, { kind: 'stand', ms: 500 }], () => ({ dy: 0.08, k: 1.15 }), 406000);
        expect(moves.filter((m) => m.move === 'duck' && !m.hold).length).toBe(1);
    });
});
