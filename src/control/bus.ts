import type { ControlEvent, ControlState, Move, Source } from './types';

type Listener = (e: ControlEvent) => void;

/** Single queue that every input producer writes to and the game drains. */
export class ControlBus {
    private queue: ControlEvent[] = [];
    private seq = 0;
    private listeners = new Set<Listener>();
    readonly state: ControlState = { cadence: 0, running: false, zone: 0, present: false };

    emit(move: Move, source: Source, extra: Partial<Omit<ControlEvent, 'move' | 'source' | 'seq'>> = {}): ControlEvent {
        const e: ControlEvent = { move, source, seq: ++this.seq, sentAt: performance.now(), ...extra };
        this.queue.push(e);
        for (const l of this.listeners) l(e);
        return e;
    }

    /** Consume all pending pulses (each event is delivered exactly once). */
    drain(): ControlEvent[] {
        const out = this.queue;
        this.queue = [];
        return out;
    }

    clear(): void {
        this.queue = [];
    }

    subscribe(l: Listener): () => void {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }
}

export const controlBus = new ControlBus();
