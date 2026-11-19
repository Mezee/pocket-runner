// Deterministic three-lane runner simulation.
//
// Ported and adapted from Bull Rush (https://github.com/winsznx/bull-rush,
// src/sim/sim.ts, MIT, Copyright (c) 2026 winsznx). Changes for Pocket Runner:
//   - removed replay verification, rulesets, checksums, dash and the crypto
//     hazard set;
//   - added Jump (0.6 s arc) and Duck (slide) with low/high obstacle types;
//   - added a retroactive forgiveness window: a move that arrives up to
//     GRACE_TICKS after the collision tick still clears the obstacle;
//   - speed is driven by an `effort` input (0..1000, from running cadence)
//     and eases smoothly to a stop instead of punishing the player;
//   - row patterns are designed so the first minute is easy and a safe lane
//     is always reachable.
//
// Rules kept from the original: fixed 60 Hz tick, Q16.16 integer math, all
// randomness from the seeded integer Rng, difficulty keyed to row INDEX (not
// tick), and no Date.now / Math.random / performance.now in here.

import { Rng } from './prng';

export const TICK_HZ = 60;
export const FP = 65536; // Q16.16

// ---- Tunables (integers) ----
export const LANE_WIDTH = 3;
const LANE_WIDTH_FP = LANE_WIDTH * FP;
const HALF_LANE_FP = LANE_WIDTH_FP >> 1;
export const ROW_UNITS = 30;
const LOOKAHEAD_UNITS = 14 * ROW_UNITS;
const BASE_SPEED_FP = 13 * FP; // units/sec
const MAX_SPEED_FP = 24 * FP;
const RAMP_UNITS_PER_SPEED = 150; // +1 unit/sec of speed cap per 150 units run
const ACCEL_PER_TICK_FP = Math.round((8 * FP) / TICK_HZ); // 8 u/s²
const DECEL_PER_TICK_FP = Math.round((5 * FP) / TICK_HZ); // 5 u/s² (gentle stop)
export const HEALTH_MAX = 3;
export const JUMP_TICKS = Math.round(0.6 * TICK_HZ);
export const SLIDE_TICKS = Math.round(0.8 * TICK_HZ);
export const GRACE_TICKS = Math.round(0.15 * TICK_HZ);
// A jump that landed up to this long before the hurdle still clears it
// (players jump early on a prompt; the 0.6 s arc alone is a tight window).
export const EARLY_JUMP_TICKS = Math.round(0.2 * TICK_HZ);
const INVULN_TICKS = Math.round(1.2 * TICK_HZ);
const COIN_SCORE = 50;
const DODGE_SCORE = 10;
const SAFE_ROWS = 3;
export const EFFORT_MAX = 1000;

// ---- Inputs ----
export const Act = { Left: 0, Right: 1, Jump: 2, Duck: 3, Effort: 4 } as const;
export type Act = (typeof Act)[keyof typeof Act];
export interface Input {
    act: Act;
    value?: number; // Effort only: 0..EFFORT_MAX
}
export interface InputEvent extends Input {
    tick: number;
}

// ---- Rows ----
export type CellKind = 'block' | 'low' | 'high' | 'coin';
export interface Cell {
    kind: CellKind;
    taken?: boolean; // coin collected (render reads this)
}
export type Pattern = 'empty' | 'single' | 'double' | 'jumpWall' | 'duckWall' | 'mixed';
export interface Row {
    index: number;
    dist: number; // hit-point distance in units
    pattern: Pattern;
    cells: (Cell | null)[]; // lanes -1, 0, 1 -> indices 0, 1, 2
    outcome?: 'hit' | 'cleared';
}
interface PendingHit {
    row: Row;
    deadline: number;
}

export interface SimEvent {
    type: 'hit' | 'death' | 'coin' | 'dodge' | 'jump' | 'duck' | 'lane' | 'land';
    lane?: number;
    kind?: CellKind;
    lateTicks?: number; // dodge: how many ticks after the collision tick the save came
}

export interface SimStats {
    jumps: number;
    ducks: number;
    laneChanges: number;
    coins: number;
    dodges: number;
    graceSaves: number;
    hits: number;
}

export interface SimState {
    rng: Rng;
    tick: number;
    speedFP: number;
    effort: number;
    distFP: number;
    scoreFP: number;
    xFP: number;
    laneTarget: number;
    jumpStart: number; // tick the current jump began; -1 = grounded
    slideUntil: number;
    hearts: number;
    invulnUntil: number;
    alive: boolean;
    deathCause: string;
    rows: Row[]; // upcoming rows, ascending
    passed: Row[]; // recently crossed rows (render only)
    pending: PendingHit[];
    nextRow: number;
    lastOpen: number; // a safe lane in the most recent generated row (-1..1)
    lastWasEmpty: boolean;
    stats: SimStats;
    events: SimEvent[]; // produced during the last stepSim
}

export interface SimResult {
    alive: boolean;
    endTick: number;
    distance: number;
    score: number;
    hearts: number;
    deathCause: string;
    stats: SimStats;
}

export const rowHitDist = (index: number): number => index * ROW_UNITS + (ROW_UNITS >> 1);

// Difficulty by row index. At ~13–16 u/s a row is ~2 s, so tier 0+1 is
// roughly the first minute.
export function tierForIndex(index: number): number {
    if (index < 12) return 0;
    if (index < 30) return 1;
    if (index < 70) return 2;
    return 3;
}

function pickWeighted<T extends string>(table: [T, number][], rng: Rng): T {
    let total = 0;
    for (const [, w] of table) total += w;
    let r = rng.below(total);
    for (const [k, w] of table) {
        r -= w;
        if (r < 0) return k;
    }
    return table[table.length - 1][0];
}

const PATTERNS: Record<number, [Pattern, number][]> = {
    0: [['single', 5], ['jumpWall', 3], ['empty', 1]],
    1: [['single', 4], ['double', 3], ['jumpWall', 3], ['duckWall', 3]],
    2: [['single', 2], ['double', 4], ['jumpWall', 2], ['duckWall', 2], ['mixed', 3], ['empty', 2]],
    3: [['double', 4], ['jumpWall', 2], ['duckWall', 2], ['mixed', 4], ['empty', 1]],
};

// Exported for tests. Generates one row and updates the generator state.
export function generateRow(s: Pick<SimState, 'rng' | 'lastOpen' | 'lastWasEmpty'>, index: number): Row {
    const rng = s.rng;
    const cells: (Cell | null)[] = [null, null, null];
    const dist = rowHitDist(index);
    const tier = tierForIndex(index);
    // Early on, every other row is empty so there's ~4 s between obstacles.
    const forceEmpty = index < SAFE_ROWS || (tier <= 1 && !s.lastWasEmpty);
    const pattern: Pattern = forceEmpty ? 'empty' : pickWeighted(PATTERNS[tier], rng);

    // Lanes the player can reach in time: if the previous row was an obstacle
    // (no breathing room) only allow open lanes adjacent to its open lane.
    const reachable = [0, 1, 2].filter((i) => s.lastWasEmpty || Math.abs(i - 1 - s.lastOpen) <= 1);
    const openIdx = reachable[rng.below(reachable.length)];

    switch (pattern) {
        case 'empty': {
            if (index >= SAFE_ROWS && rng.chance(40, 100)) cells[rng.below(3)] = { kind: 'coin' };
            break;
        }
        case 'single': {
            // one block, never in the open lane
            const others = [0, 1, 2].filter((i) => i !== openIdx);
            cells[others[rng.below(2)]] = { kind: 'block' };
            break;
        }
        case 'double': {
            for (let i = 0; i < 3; i++) if (i !== openIdx) cells[i] = { kind: 'block' };
            break;
        }
        case 'jumpWall':
            for (let i = 0; i < 3; i++) cells[i] = { kind: 'low' };
            break;
        case 'duckWall':
            for (let i = 0; i < 3; i++) cells[i] = { kind: 'high' };
            break;
        case 'mixed': {
            // one block + one low/high + one open lane
            const others = [0, 1, 2].filter((i) => i !== openIdx);
            const blockFirst = rng.chance(1, 2);
            cells[others[blockFirst ? 0 : 1]] = { kind: 'block' };
            cells[others[blockFirst ? 1 : 0]] = { kind: rng.chance(1, 2) ? 'low' : 'high' };
            break;
        }
    }
    if ((pattern === 'single' || pattern === 'double' || pattern === 'mixed') && rng.chance(35, 100)) {
        cells[openIdx] = { kind: 'coin' };
    }

    const isWall = pattern === 'jumpWall' || pattern === 'duckWall';
    s.lastWasEmpty = pattern === 'empty';
    if (!s.lastWasEmpty && !isWall) s.lastOpen = openIdx - 1;
    return { index, dist, pattern, cells };
}

function laneOfX(xFP: number): number {
    if (xFP > HALF_LANE_FP) return 1;
    if (xFP < -HALF_LANE_FP) return -1;
    return 0;
}

function generateAhead(s: SimState): void {
    const horizon = ((s.distFP / FP) | 0) + LOOKAHEAD_UNITS;
    while (rowHitDist(s.nextRow) <= horizon) {
        s.rows.push(generateRow(s, s.nextRow));
        s.nextRow++;
    }
}

export function createSim(seed: string): SimState {
    const s: SimState = {
        rng: new Rng(seed),
        tick: 0,
        speedFP: 0,
        effort: EFFORT_MAX,
        distFP: 0,
        scoreFP: 0,
        xFP: 0,
        laneTarget: 0,
        jumpStart: -1,
        slideUntil: -1,
        hearts: HEALTH_MAX,
        invulnUntil: -1,
        alive: true,
        deathCause: '',
        rows: [],
        passed: [],
        pending: [],
        nextRow: 0,
        lastOpen: 0,
        lastWasEmpty: true,
        stats: { jumps: 0, ducks: 0, laneChanges: 0, coins: 0, dodges: 0, graceSaves: 0, hits: 0 },
        events: [],
    };
    generateAhead(s);
    return s;
}

export function isAirborne(s: SimState, tick = s.tick): boolean {
    return s.jumpStart >= 0 && tick < s.jumpStart + JUMP_TICKS;
}
export function isSliding(s: SimState, tick = s.tick): boolean {
    return tick < s.slideUntil;
}

// Is the player safe from `row` given their *committed* state (lane target,
// jump, slide)? Using laneTarget instead of the interpolated x is what makes
// late lane changes count.
function clears(s: SimState, row: Row, tick: number): boolean {
    const c = row.cells[s.laneTarget + 1];
    if (!c || c.kind === 'coin') return true;
    if (c.kind === 'low') return isAirborne(s, tick) || (s.jumpStart >= 0 && tick - (s.jumpStart + JUMP_TICKS) <= EARLY_JUMP_TICKS);
    if (c.kind === 'high') return isSliding(s, tick);
    return false;
}

const CAUSE: Record<string, string> = {
    block: 'YOU RAN INTO A CRATE STACK.',
    low: 'YOU TRIPPED ON A HURDLE — JUMP!',
    high: 'YOU HIT A BAR — DUCK!',
};

function applyHit(s: SimState, row: Row, tick: number): void {
    row.outcome = 'hit';
    const c = row.cells[laneOfX(s.xFP) + 1] ?? row.cells[s.laneTarget + 1];
    const kind = c && c.kind !== 'coin' ? c.kind : 'block';
    if (tick < s.invulnUntil) return;
    s.invulnUntil = tick + INVULN_TICKS;
    s.hearts -= 1;
    s.stats.hits++;
    s.events.push({ type: 'hit', kind });
    // stumble: lose some speed so recovering feels fair
    s.speedFP = (s.speedFP * 2) / 3 | 0;
    if (s.hearts <= 0) {
        s.hearts = 0;
        s.alive = false;
        s.deathCause = CAUSE[kind] ?? CAUSE.block;
        s.events.push({ type: 'death', kind });
    }
}

function speedCapFP(distUnits: number): number {
    return Math.min(MAX_SPEED_FP, BASE_SPEED_FP + ((distUnits / RAMP_UNITS_PER_SPEED) | 0) * FP);
}

// Advance exactly one fixed tick. `inputs` are the inputs for this tick, in order.
export function stepSim(s: SimState, inputs: readonly Input[]): void {
    if (!s.alive) return;
    s.events.length = 0;
    const tick = s.tick;
    const wasAirborne = isAirborne(s, tick - 1) && tick > 0;

    for (const inp of inputs) {
        switch (inp.act) {
            case Act.Left:
            case Act.Right: {
                const next = Math.max(-1, Math.min(1, s.laneTarget + (inp.act === Act.Left ? -1 : 1)));
                if (next !== s.laneTarget) {
                    s.laneTarget = next;
                    s.stats.laneChanges++;
                    s.events.push({ type: 'lane', lane: next });
                }
                break;
            }
            case Act.Jump:
                if (!isAirborne(s, tick)) {
                    s.jumpStart = tick;
                    s.slideUntil = -1;
                    s.stats.jumps++;
                    s.events.push({ type: 'jump' });
                }
                break;
            case Act.Duck:
                // ducking mid-air fast-drops into a slide (Subway-style)
                s.jumpStart = -1;
                if (!isSliding(s, tick)) {
                    s.stats.ducks++;
                    s.events.push({ type: 'duck' });
                }
                s.slideUntil = tick + SLIDE_TICKS;
                break;
            case Act.Effort:
                s.effort = Math.max(0, Math.min(EFFORT_MAX, (inp.value ?? EFFORT_MAX) | 0));
                break;
        }
    }
    if (wasAirborne && !isAirborne(s, tick)) s.events.push({ type: 'land' });

    // Speed eases toward cap * effort; never jumps.
    const distUnits = (s.distFP / FP) | 0;
    const target = ((speedCapFP(distUnits) / EFFORT_MAX) | 0) * s.effort;
    if (s.speedFP < target) s.speedFP = Math.min(target, s.speedFP + ACCEL_PER_TICK_FP);
    else if (s.speedFP > target) s.speedFP = Math.max(target, s.speedFP - DECEL_PER_TICK_FP);

    const step = (s.speedFP / TICK_HZ) | 0;
    s.distFP += step;
    s.scoreFP += step;
    const targetXFP = s.laneTarget * LANE_WIDTH_FP;
    s.xFP += (((targetXFP - s.xFP) * 14) / TICK_HZ) | 0;
    if (Math.abs(targetXFP - s.xFP) < 64) s.xFP = targetXFP;
    const lane = laneOfX(s.xFP);

    generateAhead(s);

    // 1) Rows reached this tick: collect coins, clear or queue a pending hit.
    const nowUnits = (s.distFP / FP) | 0;
    while (s.rows.length > 0 && nowUnits >= s.rows[0].dist) {
        const row = s.rows.shift() as Row;
        s.passed.push(row);
        if (s.passed.length > 4) s.passed.shift();
        const coin = row.cells[lane + 1];
        if (coin && coin.kind === 'coin' && !coin.taken) {
            coin.taken = true;
            s.scoreFP += COIN_SCORE * FP;
            s.stats.coins++;
            s.events.push({ type: 'coin', lane });
        }
        if (row.pattern === 'empty') continue;
        if (clears(s, row, tick)) {
            row.outcome = 'cleared';
            s.stats.dodges++;
            s.scoreFP += DODGE_SCORE * FP;
            s.events.push({ type: 'dodge', lateTicks: 0 });
        } else {
            s.pending.push({ row, deadline: tick + GRACE_TICKS });
        }
    }

    // 2) Forgiveness window: a pending hit is cancelled if the player's move
    //    lands within GRACE_TICKS; otherwise it resolves as a hit.
    for (let i = 0; i < s.pending.length; ) {
        const p = s.pending[i];
        if (clears(s, p.row, tick)) {
            p.row.outcome = 'cleared';
            s.stats.dodges++;
            s.stats.graceSaves++;
            s.scoreFP += DODGE_SCORE * FP;
            s.events.push({ type: 'dodge', lateTicks: tick - (p.deadline - GRACE_TICKS) });
            s.pending.splice(i, 1);
        } else if (tick >= p.deadline) {
            s.pending.splice(i, 1);
            applyHit(s, p.row, tick);
            if (!s.alive) break;
        } else i++;
    }

    s.tick++;
}

// ---- Render read-outs (pure derivations) ----
export function simDistance(s: SimState): number {
    return (s.distFP / FP) | 0;
}
export function simScore(s: SimState): number {
    return (s.scoreFP / FP) | 0;
}
export function simPlayerX(s: SimState): number {
    return s.xFP / FP;
}
export function simSpeed(s: SimState): number {
    return s.speedFP / FP;
}
/** Jump height 0..1 (parabola), for rendering. `frac` = sub-tick interpolation. */
export function jumpPhase(s: SimState, frac = 0): number {
    if (s.jumpStart < 0) return 0;
    const t = (s.tick - 1 - s.jumpStart + frac) / JUMP_TICKS;
    if (t < 0 || t >= 1) return 0;
    return 4 * t * (1 - t);
}

/** Re-run a full run from seed + logged inputs (used by tests). */
export function simulate(seed: string, inputs: InputEvent[], totalTicks: number): SimResult {
    const s = createSim(seed);
    let ip = 0;
    const acts: Input[] = [];
    while (s.tick < totalTicks && s.alive) {
        acts.length = 0;
        while (ip < inputs.length && inputs[ip].tick === s.tick) acts.push(inputs[ip++]);
        while (ip < inputs.length && inputs[ip].tick < s.tick) ip++;
        stepSim(s, acts);
    }
    return {
        alive: s.alive,
        endTick: s.tick,
        distance: simDistance(s),
        score: simScore(s),
        hearts: s.hearts,
        deathCause: s.deathCause,
        stats: { ...s.stats },
    };
}
