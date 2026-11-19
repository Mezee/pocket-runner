// App state (Zustand) + per-frame mutable refs kept out of React.
// Structure adapted from Bull Rush's store.ts (MIT, Copyright (c) 2026 winsznx).
import { create } from 'zustand';
import { HEALTH_MAX } from './sim/sim';

export type Phase = 'setup' | 'calibrate' | 'ready' | 'playing' | 'dead';
export type InputMode = 'camera' | 'keyboard';

export interface RunResult {
    distance: number;
    score: number;
    cause: string;
    durationMs: number;
    steps: number;
    stats: { jumps: number; ducks: number; laneChanges: number; coins: number; dodges: number; graceSaves: number; hits: number };
}

export interface Prompt {
    id: number;
    move: 'JUMP' | 'DUCK' | 'LEFT' | 'RIGHT';
}

interface GameState {
    phase: Phase;
    inputMode: InputMode;
    debug: boolean;
    hearts: number;
    score: number;
    dist: number;
    speed: number;
    coins: number;
    steps: number; // workout bonus: steps counted this run
    paused: boolean; // camera lost the player
    result: RunResult | null;
    runId: number;
    flashKey: number;
    prompt: Prompt | null;
    lastMove: { id: number; move: string; source: string } | null;
    best: number;

    setPhase: (p: Phase) => void;
    setInputMode: (m: InputMode) => void;
    toggleDebug: () => void;
    start: () => void;
    die: (r: RunResult) => void;
}

const BEST_KEY = 'pocket-runner:best';
const params = new URLSearchParams(location.search);

export const useGameStore = create<GameState>((set, get) => ({
    phase: 'setup',
    inputMode: params.get('input') === 'keyboard' ? 'keyboard' : 'camera',
    debug: params.has('debug'),
    hearts: HEALTH_MAX,
    score: 0,
    dist: 0,
    speed: 0,
    coins: 0,
    steps: 0,
    paused: false,
    result: null,
    runId: 0,
    flashKey: 0,
    prompt: null,
    lastMove: null,
    best: Number(localStorage.getItem(BEST_KEY) ?? 0) || 0,

    setPhase: (phase) => set({ phase }),
    setInputMode: (inputMode) => set({ inputMode }),
    toggleDebug: () => set((s) => ({ debug: !s.debug })),
    start: () => set((s) => ({ phase: 'playing', hearts: HEALTH_MAX, score: 0, dist: 0, speed: 0, coins: 0, steps: 0, paused: false, result: null, prompt: null, runId: s.runId + 1 })),
    die: (r) => {
        if (get().phase !== 'playing') return;
        const best = Math.max(get().best, r.score);
        localStorage.setItem(BEST_KEY, String(best));
        set({ phase: 'dead', result: r, best });
    },
}));

/** Per-frame values the 3D scene reads (never trigger React renders). */
export const refs = {
    x: 0,
    dist: 0,
    jump: 0, // 0..1 height phase
    sliding: false,
    speed: 0,
    shake: 0,
    invuln: false,
    lean: 0,
    runPhase: 0,
};

export const query = params;
