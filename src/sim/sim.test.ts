// Tests for the Pocket Runner sim. The determinism cases are adapted from
// Bull Rush's sim.determinism.test.ts (MIT, Copyright (c) 2026 winsznx).
import { describe, expect, it } from 'vitest';
import {
    Act,
    createSim,
    stepSim,
    simulate,
    generateRow,
    rowHitDist,
    simDistance,
    GRACE_TICKS,
    JUMP_TICKS,
    TICK_HZ,
    type Input,
    type InputEvent,
    type SimState,
    type Row,
} from './sim';
import { Rng } from './prng';

// A deterministic "autopilot" that makes the right move for each obstacle row
// `lead` ticks before impact (negative lead = after impact, to test grace).
function moveFor(s: SimState, row: Row): Input[] {
    const here = row.cells[s.laneTarget + 1];
    if (!here || here.kind === 'coin') return [];
    if (here.kind === 'low') return [{ act: Act.Jump }];
    if (here.kind === 'high') return [{ act: Act.Duck }];
    for (const d of [-1, 1, -2, 2]) {
        const l = s.laneTarget + d;
        if (l < -1 || l > 1) continue;
        const c = row.cells[l + 1];
        if (!c || c.kind === 'coin') {
            const acts: Input[] = [];
            for (let k = 0; k < Math.abs(d); k++) acts.push({ act: d < 0 ? Act.Left : Act.Right });
            return acts;
        }
    }
    return [];
}

function makeAutopilot(lead: number) {
    const done = new Set<number>();
    const impactTick = new Map<number, number>();
    return (s: SimState): Input[] => {
        if (lead >= 0) {
            for (const row of s.rows.slice(0, 2)) {
                if (row.pattern === 'empty' || done.has(row.index)) continue;
                const ticksAway = ((row.dist - simDistance(s)) * TICK_HZ * 65536) / Math.max(1, s.speedFP);
                if (ticksAway <= lead) {
                    done.add(row.index);
                    return moveFor(s, row);
                }
            }
            return [];
        }
        // late mode: act |lead| ticks after the row was reached
        for (const row of s.passed) {
            if (row.pattern === 'empty' || done.has(row.index)) continue;
            if (!impactTick.has(row.index)) impactTick.set(row.index, s.tick);
            if (s.tick - impactTick.get(row.index)! >= -lead) {
                done.add(row.index);
                return moveFor(s, row);
            }
        }
        return [];
    };
}

function play(seed: string, ticks: number, lead: number, effort = 1000): { s: SimState; log: InputEvent[] } {
    const s = createSim(seed);
    const pilot = makeAutopilot(lead);
    const log: InputEvent[] = [{ tick: 0, act: Act.Effort, value: effort }];
    stepSim(s, [log[0]]);
    while (s.alive && s.tick < ticks) {
        const acts = pilot(s);
        for (const a of acts) log.push({ tick: s.tick, ...a });
        stepSim(s, acts);
    }
    return { s, log };
}

describe('determinism', () => {
    it('same seed + inputs are bit-identical', () => {
        const { log } = play('seed-a', 6000, 20);
        const a = simulate('seed-a', log, 6000);
        const b = simulate('seed-a', log, 6000);
        expect(a).toEqual(b);
    });

    it('live stepping equals batch re-simulation', () => {
        const { s, log } = play('seed-b', 6000, 20);
        const r = simulate('seed-b', log, s.tick);
        expect(r.distance).toBe(simDistance(s));
        expect(r.hearts).toBe(s.hearts);
        expect(r.alive).toBe(s.alive);
    });

    it('different seeds produce different courses', () => {
        const a = createSim('one').rows.map((r) => r.pattern + r.cells.map((c) => c?.kind ?? '_').join()).join('|');
        const b = createSim('two').rows.map((r) => r.pattern + r.cells.map((c) => c?.kind ?? '_').join()).join('|');
        expect(a).not.toBe(b);
    });
});

describe('jump', () => {
    it('lasts ~0.6s and cannot be re-triggered mid-air', () => {
        const s = createSim('jump');
        stepSim(s, [{ act: Act.Jump }]);
        stepSim(s, [{ act: Act.Jump }]);
        expect(s.stats.jumps).toBe(1);
        expect(JUMP_TICKS).toBe(36);
    });

    it('a well-timed autopilot survives 3 minutes on 50 seeds', () => {
        for (let i = 0; i < 50; i++) {
            const { s } = play(`fair-${i}`, 180 * TICK_HZ, 18);
            expect(s.alive, `seed fair-${i}: ${s.deathCause}`).toBe(true);
        }
    });

    it('never moving dies (obstacles really block)', () => {
        const s = createSim('idle');
        stepSim(s, [{ act: Act.Effort, value: 1000 }]);
        while (s.alive && s.tick < 180 * TICK_HZ) stepSim(s, []);
        expect(s.alive).toBe(false);
    });
});

describe('forgiveness window', () => {
    it('a move arriving up to GRACE_TICKS after impact still clears', () => {
        let saves = 0;
        for (let i = 0; i < 20; i++) {
            const { s } = play(`late-${i}`, 120 * TICK_HZ, -(GRACE_TICKS - 2));
            expect(s.alive, `late-${i}`).toBe(true);
            saves += s.stats.graceSaves;
        }
        expect(saves).toBeGreaterThan(0);
    });

    it('a move arriving after the window is a hit', () => {
        const { s } = play('too-late', 120 * TICK_HZ, -(GRACE_TICKS + 4));
        expect(s.stats.hits).toBeGreaterThan(0);
    });
});

describe('early jump tolerance', () => {
    it('a jump that lands shortly before a hurdle still clears it', () => {
        // jump a full arc + 8 ticks before impact
        const { s } = play('early-jump', 120 * TICK_HZ, 18);
        expect(s.alive).toBe(true);
    });
});

describe('speed / effort', () => {
    it('stopping (effort 0) eases to a halt instead of stopping instantly', () => {
        const s = createSim('effort');
        for (let t = 0; t < 4 * TICK_HZ; t++) stepSim(s, t === 0 ? [{ act: Act.Effort, value: 1000 }] : []);
        const before = s.speedFP;
        expect(before).toBeGreaterThan(0);
        stepSim(s, [{ act: Act.Effort, value: 0 }]);
        expect(s.speedFP).toBeGreaterThan(before * 0.9);
        for (let t = 0; t < 6 * TICK_HZ; t++) stepSim(s, []);
        expect(s.speedFP).toBe(0);
    });
});

describe('course generation', () => {
    it('the first rows are empty and early obstacles are spaced out', () => {
        const s = createSim('early');
        expect(s.rows.slice(0, 3).every((r) => r.pattern === 'empty')).toBe(true);
        const early = s.rows.filter((r) => r.index < 30);
        for (let i = 1; i < early.length; i++) {
            if (early[i].pattern !== 'empty') expect(early[i - 1].pattern).toBe('empty');
        }
    });

    it('every row has a passable lane, and back-to-back block rows stay adjacent-reachable', () => {
        const g = { rng: new Rng('gen'), lastOpen: 0, lastWasEmpty: true };
        let prev: Row | null = null;
        for (let i = 0; i < 2000; i++) {
            const r = generateRow(g, i);
            expect(r.dist).toBe(rowHitDist(i));
            const open = r.cells.map((c, idx) => (!c || c.kind !== 'block' ? idx : -1)).filter((x) => x >= 0);
            expect(open.length).toBeGreaterThan(0);
            if (prev && prev.pattern !== 'empty' && r.pattern !== 'empty') {
                const prevOpen = prev.cells.map((c, idx) => (!c || c.kind === 'coin' ? idx : -1)).filter((x) => x >= 0);
                if (prevOpen.length > 0) {
                    const ok = open.some((o) => prevOpen.some((p) => Math.abs(o - p) <= 1));
                    expect(ok).toBe(true);
                }
            }
            prev = r;
        }
    });
});
