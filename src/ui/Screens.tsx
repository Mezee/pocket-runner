import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../store';
import { camera } from '../control/camera';
import { controlBus } from '../control/bus';
import { CAL_PROMPTS, type CalStep } from '../control/calibration';
import { HEALTH_MAX } from '../sim/sim';
import { Audio } from '../audio';
import { CameraView } from './CameraView';

function useCameraTick(): void {
    const [, f] = useState(0);
    useEffect(() => camera.onChange(() => f((x) => x + 1)), []);
}

/** Setup: choose camera or keyboard, grant camera permission. */
export function Setup() {
    useCameraTick();
    const setPhase = useGameStore((s) => s.setPhase);
    const setInputMode = useGameStore((s) => s.setInputMode);
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [deviceId, setDeviceId] = useState<string>(localStorage.getItem('pocket-runner:cam') ?? '');
    const fake = new URLSearchParams(location.search).has('fake');

    const startCamera = async () => {
        Audio.unlock();
        await camera.start({ fake, deviceId: deviceId || undefined });
        if (camera.status === 'running') {
            if (!fake) {
                const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
                setDevices(list);
            }
            setInputMode('camera');
            camera.beginCalibration();
            setPhase('calibrate');
        }
    };
    const keyboard = () => {
        Audio.unlock();
        setInputMode('keyboard');
        setPhase('ready');
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter') void startCamera();
            if (e.key.toLowerCase() === 'k') keyboard();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    return (
        <div className="overlay">
            <div className="panel wide">
                <div className="logo">
                    POCKET<span>RUNNER</span>
                </div>
                <p className="sub">Run on the spot. Jump, duck and step side to side to play. Your body is the controller.</p>
                <ol className="setup-steps">
                    <li>Put the laptop or webcam by the TV, at about waist to chest height.</li>
                    <li>Stand 2–3 m back so the camera sees you from head to knees.</li>
                    <li>Leave about one big step of clear floor on each side of you.</li>
                </ol>
                <button className="btn primary" onClick={startCamera} disabled={camera.status === 'loading'}>
                    {camera.status === 'loading' ? 'STARTING CAMERA…' : '▶ PLAY WITH CAMERA'}
                </button>
                {devices.length > 1 && (
                    <select
                        className="cam-select"
                        value={deviceId}
                        onChange={(e) => {
                            setDeviceId(e.target.value);
                            localStorage.setItem('pocket-runner:cam', e.target.value);
                        }}
                    >
                        {devices.map((d) => (
                            <option key={d.deviceId} value={d.deviceId}>
                                {d.label || d.deviceId.slice(0, 8)}
                            </option>
                        ))}
                    </select>
                )}
                <button className="btn ghost" onClick={keyboard}>
                    PLAY WITH KEYBOARD (K)
                </button>
                <label className="behind">
                    <input type="checkbox" checked={!camera.mirror} onChange={(e) => camera.setBehind(e.target.checked)} /> Camera is behind me (filming my back)
                </label>
                {camera.status === 'error' && <div className="error">{camera.error}</div>}
                <div className="hint">Video stays on this computer. Nothing is uploaded.</div>
            </div>
        </div>
    );
}

const SAY: Partial<Record<CalStep, string>> = {
    find: 'Step back until I can see you from head to feet.',
    stand: 'Stand still.',
    jump: 'Now jump!',
    duck: 'Now duck!',
    left: 'Step left, then come back.',
    right: 'Step right, then come back.',
    done: 'Ready. Jump to start!',
};

/** Calibration: all prompts on the TV + spoken cues. */
export function Calibrate() {
    useCameraTick();
    const setPhase = useGameStore((s) => s.setPhase);
    const [, f] = useState(0);
    const lastStep = useRef<CalStep | null>(null);
    useEffect(() => {
        const id = setInterval(() => f((x) => x + 1), 100);
        return () => clearInterval(id);
    }, []);
    const step = camera.calibrator.step;
    useEffect(() => {
        if (step !== lastStep.current) {
            lastStep.current = step;
            if (SAY[step]) Audio.say(SAY[step]!);
            if (step !== 'find') Audio.sfx('good');
            if (step === 'done') setTimeout(() => setPhase('ready'), 900);
        }
    }, [step, setPhase]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key.toLowerCase() === 'c' && camera.quickCalibrate()) setPhase('ready');
            if (e.key === 'Escape') {
                camera.beginCalibration();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [setPhase]);

    const p = CAL_PROMPTS[step];
    const order: CalStep[] = ['stand', 'jump', 'duck'];
    const idx = order.indexOf(step);
    return (
        <div className="overlay cal">
            <div className="cal-wrap">
                <CameraView width={640} height={480} zones={false} className="cal-cam" />
                <div className="cal-side">
                    <div className="cal-title" key={step}>
                        {p.title}
                    </div>
                    <div className="cal-sub">{p.sub}</div>
                    <div className="cal-bar">
                        <div style={{ width: `${camera.calibrator.progress * 100}%` }} />
                    </div>
                    <div className="cal-dots">
                        {order.map((s, i) => (
                            <span key={s} className={i < idx || step === 'done' ? 'on' : i === idx ? 'cur' : ''}>
                                {s}
                            </span>
                        ))}
                    </div>
                    <div className="hint">C = quick calibrate (standing pose, default thresholds) · Esc = restart</div>
                </div>
            </div>
        </div>
    );
}

/** Ready: jump to start (or Space with the keyboard). The runner always moves. */
export function Ready() {
    const start = useGameStore((s) => s.start);
    const inputMode = useGameStore((s) => s.inputMode);
    const best = useGameStore((s) => s.best);
    const [count, setCount] = useState<number | null>(null);

    // A jump (camera or keyboard) starts the countdown.
    useEffect(() => {
        controlBus.clear();
        const t0 = performance.now();
        return controlBus.subscribe((e) => {
            if (e.move === 'jump' && performance.now() - t0 > 600) setCount((c) => (c === null ? 3 : c));
        });
    }, []);

    useEffect(() => {
        if (count === null) return;
        if (count === 0) {
            Audio.sfx('go');
            controlBus.clear();
            start();
            return;
        }
        Audio.sfx('tick');
        const id = setTimeout(() => setCount(count - 1), 700);
        return () => clearTimeout(id);
    }, [count, start]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter') setCount((c) => (c === null ? 3 : c));
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <div className="overlay ready">
            {count !== null ? (
                <div className="countdown" key={count}>
                    {count || 'GO!'}
                </div>
            ) : (
                <div className="panel">
                    <div className="big">{inputMode === 'camera' ? 'JUMP TO START' : 'PRESS SPACE TO START'}</div>
                    <div className="moves">
                        <span>⬆ jump = hurdles</span>
                        <span>⬇ duck = bars</span>
                        <span>⬅ step left</span>
                        <span>step right ➡</span>
                    </div>
                    {inputMode === 'camera' && <div className="hint">Running on the spot is optional: every step adds bonus points 🏃</div>}
                    {best > 0 && <div className="hint">best: {best.toLocaleString()}</div>}
                    {inputMode === 'keyboard' && <div className="hint">←/→ lanes · Space/↑ jump · ↓ duck</div>}
                </div>
            )}
        </div>
    );
}

export function Hud() {
    const hearts = useGameStore((s) => s.hearts);
    const score = useGameStore((s) => s.score);
    const coins = useGameStore((s) => s.coins);
    const steps = useGameStore((s) => s.steps);
    const paused = useGameStore((s) => s.paused);
    const prompt = useGameStore((s) => s.prompt);
    const inputMode = useGameStore((s) => s.inputMode);
    const lastMove = useGameStore((s) => s.lastMove);
    const [promptVisible, setPromptVisible] = useState(false);

    useEffect(() => {
        if (!prompt) return;
        setPromptVisible(true);
        const id = setTimeout(() => setPromptVisible(false), 1300);
        return () => clearTimeout(id);
    }, [prompt]);

    const icon = { JUMP: '⬆', DUCK: '⬇', LEFT: '⬅', RIGHT: '➡' } as const;
    return (
        <div className="hud">
            <div className="hud-top">
                <div className="hearts">
                    {Array.from({ length: HEALTH_MAX }).map((_, i) => (
                        <span key={i} className={i < hearts ? 'on' : 'off'}>
                            ♥
                        </span>
                    ))}
                </div>
                <div className="score">{score.toLocaleString()}</div>
                <div className="coins">
                    {inputMode === 'camera' && <span className="steps">🏃 {steps}</span>}● {coins}
                </div>
            </div>
            {prompt && promptVisible && (
                <div className={`prompt p-${prompt.move.toLowerCase()}`} key={prompt.id}>
                    <span className="pi">{icon[prompt.move]}</span>
                    <span>{prompt.move}</span>
                </div>
            )}
            {lastMove && (
                <div className="move-chip" key={lastMove.id}>
                    {lastMove.move.toUpperCase()}
                </div>
            )}
            {inputMode === 'camera' && paused && (
                <div className="paused">
                    <div className="big">PAUSED</div>
                    <div>Step back into view to keep playing</div>
                </div>
            )}
        </div>
    );
}

export function GameOver() {
    const result = useGameStore((s) => s.result);
    const best = useGameStore((s) => s.best);
    const setPhase = useGameStore((s) => s.setPhase);
    const inputMode = useGameStore((s) => s.inputMode);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === ' ' || e.key === 'Enter') setPhase('ready');
            if (e.key.toLowerCase() === 'r' && inputMode === 'camera') {
                camera.beginCalibration();
                setPhase('calibrate');
            }
        };
        const id = setTimeout(() => window.addEventListener('keydown', onKey), 600);
        return () => {
            clearTimeout(id);
            window.removeEventListener('keydown', onKey);
        };
    }, [setPhase, inputMode]);
    // Hands-free restart: jump (after a short pause so the fatal jump doesn't count).
    useEffect(() => {
        const t0 = performance.now();
        return controlBus.subscribe((e) => {
            if (e.move === 'jump' && performance.now() - t0 > 2000) setPhase('ready');
        });
    }, [setPhase]);
    if (!result) return null;
    const s = result.stats;
    return (
        <div className="overlay dead">
            <div className="panel">
                <div className="big red">GAME OVER</div>
                <div className="cause">{result.cause}</div>
                <div className="result-grid">
                    <div>
                        <b>{result.score.toLocaleString()}</b>
                        <span>score</span>
                    </div>
                    <div>
                        <b>{result.distance.toLocaleString()} m</b>
                        <span>distance</span>
                    </div>
                    <div>
                        <b>{Math.round(result.durationMs / 1000)} s</b>
                        <span>time</span>
                    </div>
                    <div>
                        <b>{result.steps.toLocaleString()}</b>
                        <span>steps 🏃</span>
                    </div>
                    <div>
                        <b>{best.toLocaleString()}</b>
                        <span>best</span>
                    </div>
                </div>
                <div className="hint">
                    jumps {s.jumps} · ducks {s.ducks} · lane changes {s.laneChanges} · dodged {s.dodges} (saved late: {s.graceSaves}) · coins {s.coins}
                </div>
                <div className="hint">{inputMode === 'camera' ? 'Jump to go again · R = recalibrate' : 'Space to go again'}</div>
            </div>
        </div>
    );
}
