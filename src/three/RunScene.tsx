// Sim-driven scene: the render layer reads from the deterministic SimRunner.
// Adapted from Bull Rush's SimScene.tsx (MIT, Copyright (c) 2026 winsznx):
// fixed-step runner + "re-render obstacles only when the row set changes".
import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { refs, useGameStore } from '../store';
import { SimRunner } from '../sim/runner';
import { LANE_WIDTH, TICK_HZ, type Row } from '../sim/sim';
import { hub } from '../game/hub';
import { latencyLog } from '../control/latency';
import { Audio } from '../audio';
import { camera } from '../control/camera';
import { controlBus } from '../control/bus';
import { Player } from './Player';
import { Obstacle } from './Obstacles';
import { World } from './World';

// Show the move prompt this many seconds before the player reaches the row.
// Covers ~350 ms of input latency + reaction time.
const PROMPT_LEAD_S = 1.5;
// Camera: pause if the player has been out of frame this long; resume on return.
const LOST_PAUSE_MS = 400;
const STEP_POINTS = 2; // bonus points per step counted (workout score)

export const game = { runner: null as SimRunner | null };

function promptFor(row: Row, lane: number): 'JUMP' | 'DUCK' | 'LEFT' | 'RIGHT' | null {
    const here = row.cells[lane + 1];
    if (!here || here.kind === 'coin') return null;
    if (here.kind === 'low') return 'JUMP';
    if (here.kind === 'high') return 'DUCK';
    // block: nearest open lane
    for (const d of [-1, 1, -2, 2]) {
        const l = lane + d;
        if (l < -1 || l > 1) continue;
        const c = row.cells[l + 1];
        if (!c || c.kind === 'coin') return d < 0 ? 'LEFT' : 'RIGHT';
    }
    return null;
}

export function RunScene() {
    const runId = useGameStore((s) => s.runId);
    const inputMode = useGameStore((s) => s.inputMode);
    const [, setVersion] = useState(0);
    const rowSig = useRef('');
    const prompted = useRef(new Set<number>());
    const promptId = useRef(0);
    const lastUi = useRef(0);
    const stepBase = useRef(0);
    const lostSince = useRef(0);

    useEffect(() => {
        const seed = new URLSearchParams(location.search).get('seed') ?? `run-${Date.now().toString(36)}`;
        game.runner = new SimRunner(seed);
        hub.reset();
        prompted.current.clear();
        stepBase.current = camera.detector.stepCount;
        lostSince.current = 0;
        refs.dist = 0;
        refs.x = 0;
        setVersion((v) => v + 1);
    }, [runId]);

    useFrame((state, delta) => {
        const dt = Math.min(delta, 0.05);
        const store = useGameStore.getState();
        const runner = game.runner;
        const now = performance.now();

        if (runner && store.phase === 'playing') {
            const evs = hub.pump(runner, now, inputMode);
            if (evs.length) {
                const e = evs[evs.length - 1];
                useGameStore.setState({ lastMove: { id: e.seq, move: e.move, source: e.source } });
            }
            // Auto-pause when the camera can't see the player (bystander, walked off).
            if (inputMode === 'camera') {
                if (!controlBus.state.present) lostSince.current ||= now;
                else lostSince.current = 0;
                const paused = lostSince.current > 0 && now - lostSince.current > LOST_PAUSE_MS;
                if (paused !== runner.paused) {
                    runner.paused = paused;
                    useGameStore.setState({ paused });
                }
            }
            runner.advance(dt);
            const s = runner.state;
            const steps = inputMode === 'camera' ? camera.detector.stepCount - stepBase.current : 0;

            for (const ev of runner.lastEvents) {
                if (ev.type === 'jump') Audio.sfx('jump');
                else if (ev.type === 'duck') Audio.sfx('duck');
                else if (ev.type === 'lane') Audio.sfx('lane');
                else if (ev.type === 'coin') Audio.sfx('coin');
                else if (ev.type === 'hit') {
                    Audio.sfx('hit');
                    refs.shake = 0.5;
                    useGameStore.setState((st) => ({ flashKey: st.flashKey + 1 }));
                } else if (ev.type === 'death') {
                    Audio.sfx('death');
                    store.die({
                        distance: runner.distance,
                        score: runner.score + steps * STEP_POINTS,
                        steps,
                        cause: s.deathCause,
                        durationMs: Math.round((s.tick / TICK_HZ) * 1000),
                        stats: { ...s.stats },
                    });
                }
            }

            // Move prompts ("JUMP", "LEFT"...) ahead of each obstacle row.
            const speed = Math.max(runner.speed, 6);
            for (const row of s.rows.slice(0, 3)) {
                if (row.pattern === 'empty' || prompted.current.has(row.index)) continue;
                const secs = (row.dist - runner.distance) / speed;
                if (secs <= PROMPT_LEAD_S) {
                    prompted.current.add(row.index);
                    const mv = promptFor(row, s.laneTarget);
                    if (mv) useGameStore.setState({ prompt: { id: ++promptId.current, move: mv } });
                }
            }

            const sig = `${s.rows[0]?.index ?? -1}:${s.nextRow}:${s.stats.coins}`;
            if (sig !== rowSig.current) {
                rowSig.current = sig;
                setVersion((v) => v + 1);
            }

            if (now - lastUi.current > 100) {
                lastUi.current = now;
                useGameStore.setState({ score: runner.score + steps * STEP_POINTS, steps, dist: runner.distance, hearts: s.hearts, speed: runner.speed, coins: s.stats.coins });
            }
        }

        // Map sim -> refs for the render layer (with sub-tick interpolation).
        if (runner) {
            const s = runner.state;
            const prevX = refs.x;
            refs.x = runner.playerX;
            refs.lean = THREE.MathUtils.clamp((refs.x - prevX) / Math.max(dt, 1e-3) / 12, -1, 1);
            refs.dist = runner.distance + (runner.speed / TICK_HZ) * runner.frac;
            refs.jump = runner.jump;
            refs.sliding = runner.sliding;
            refs.speed = runner.speed;
            refs.invuln = s.tick < s.invulnUntil;
        }

        // Camera follow (low, behind, Subway-style).
        const cam = state.camera as THREE.PerspectiveCamera;
        let cx = refs.x * 0.7;
        let cy = 4.2 + refs.jump * 0.8;
        if (refs.shake > 0.01) {
            cx += (Math.random() - 0.5) * refs.shake;
            cy += (Math.random() - 0.5) * refs.shake;
            refs.shake *= Math.exp(-dt * 6);
        }
        cam.position.x = THREE.MathUtils.lerp(cam.position.x, cx, dt * 8);
        cam.position.y = THREE.MathUtils.lerp(cam.position.y, cy, dt * 6);
        cam.position.z = -refs.dist + 7.5;
        cam.lookAt(refs.x * 0.5, 1.6, -refs.dist - 10);
        const targetFov = 62 + Math.min(10, refs.speed * 0.3);
        cam.fov = THREE.MathUtils.lerp(cam.fov, targetFov, dt * 2);
        cam.updateProjectionMatrix();

        latencyLog.frameShown(now);
    });

    const runner = game.runner;
    const rows = runner ? [...runner.state.passed, ...runner.state.rows] : [];

    return (
        <group>
            <group position={[0, 0, 0]}>
                <PlayerAnchor />
            </group>
            <World />
            {rows.map((row) =>
                row.cells.map((cell, i) =>
                    cell && !(cell.kind === 'coin' && cell.taken) && !(row.outcome === 'hit' && cell.kind !== 'coin') ? (
                        <group key={`${row.index}-${i}`} position={[(i - 1) * LANE_WIDTH, 0, -row.dist]}>
                            <Obstacle kind={cell.kind} variant={row.index + i} />
                        </group>
                    ) : null,
                ),
            )}
        </group>
    );
}

/** Moves the player group along the track each frame. */
function PlayerAnchor() {
    const g = useRef<THREE.Group>(null);
    useFrame(() => {
        if (g.current) g.current.position.z = -refs.dist;
    });
    return (
        <group ref={g}>
            <Player />
        </group>
    );
}
