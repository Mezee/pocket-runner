// Client-side fixed-timestep driver for the deterministic sim.
// Ported from Bull Rush (src/sim/runner.ts, MIT, Copyright (c) 2026 winsznx):
// same accumulator + capped catch-up; replay submission removed.
import {
    createSim,
    stepSim,
    simDistance,
    simScore,
    simPlayerX,
    simSpeed,
    jumpPhase,
    isSliding,
    TICK_HZ,
    type SimState,
    type SimEvent,
    type Input,
    type InputEvent,
} from './sim';

const TICK_MS = 1000 / TICK_HZ;
const MAX_CATCHUP = 5;

export class SimRunner {
    private s: SimState;
    private acc = 0;
    private pending: Input[] = [];
    readonly log: InputEvent[] = [];
    lastEvents: SimEvent[] = [];
    paused = false;

    constructor(readonly seed: string) {
        this.s = createSim(seed);
    }

    input(inp: Input): void {
        if (this.s.alive) this.pending.push(inp);
    }

    /** Advance by a real-time delta (seconds). Runs whole fixed ticks only. */
    advance(deltaSec: number): void {
        this.lastEvents = [];
        if (!this.s.alive || this.paused) return;
        this.acc += deltaSec * 1000;
        let ran = 0;
        while (this.acc >= TICK_MS && this.s.alive && ran < MAX_CATCHUP) {
            const acts = this.pending;
            this.pending = [];
            for (const a of acts) this.log.push({ tick: this.s.tick, ...a });
            stepSim(this.s, acts);
            if (this.s.events.length > 0) this.lastEvents.push(...this.s.events);
            this.acc -= TICK_MS;
            ran++;
        }
        // Dropped backlog from a stall/background: do not fast-forward.
        if (this.acc > TICK_MS) this.acc = 0;
    }

    /** Sub-tick interpolation fraction for smooth rendering. */
    get frac(): number {
        return Math.min(1, this.acc / TICK_MS);
    }
    get state(): SimState {
        return this.s;
    }
    get alive(): boolean {
        return this.s.alive;
    }
    get tick(): number {
        return this.s.tick;
    }
    get distance(): number {
        return simDistance(this.s);
    }
    get score(): number {
        return simScore(this.s);
    }
    get playerX(): number {
        return simPlayerX(this.s);
    }
    get speed(): number {
        return simSpeed(this.s);
    }
    get jump(): number {
        return jumpPhase(this.s, this.frac);
    }
    get sliding(): boolean {
        return isSliding(this.s);
    }
}
