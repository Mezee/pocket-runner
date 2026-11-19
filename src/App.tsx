import { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGameStore } from './store';
import { RunScene } from './three/RunScene';
import { skyTexture } from './three/toon';
import { Setup, Calibrate, Ready, Hud, GameOver } from './ui/Screens';
import { Debug } from './ui/Debug';
import { CameraView } from './ui/CameraView';
import { attachKeyboard } from './control/keyboard';
import { camera } from './control/camera';
import { hub } from './game/hub';
import { Audio } from './audio';
import { game } from './three/RunScene';
import { latencyLog } from './control/latency';

const sky = skyTexture();

// Expose a small handle for e2e tests and console tuning.
(window as unknown as { pocket: unknown }).pocket = { camera, hub, store: useGameStore, game, latencyLog };

export function App() {
    const phase = useGameStore((s) => s.phase);
    const debug = useGameStore((s) => s.debug);
    const inputMode = useGameStore((s) => s.inputMode);
    const flashKey = useGameStore((s) => s.flashKey);

    useEffect(() => attachKeyboard(), []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = e.key.toLowerCase();
            if (k === 'g' || k === '`') useGameStore.getState().toggleDebug();
            if (k === 'm') Audio.setMuted(!Audio.muted);
            if (k === 'f') void document.documentElement.requestFullscreen?.().catch(() => {});
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    return (
        <div className="app">
            <Canvas dpr={[1, 1.25]} camera={{ position: [0, 4.2, 7.5], fov: 62, near: 0.1, far: 260 }} gl={{ antialias: true, powerPreference: 'high-performance' }} scene={{ background: sky }}>
                <fog attach="fog" args={['#cfeaff', 70, 190]} />
                <hemisphereLight args={['#ffffff', '#7bc96f', 1.4]} />
                <directionalLight position={[8, 20, 10]} intensity={1.6} />
                <RunScene />
            </Canvas>

            {phase === 'setup' && <Setup />}
            {phase === 'calibrate' && <Calibrate />}
            {phase === 'ready' && <Ready />}
            {phase === 'playing' && <Hud />}
            {phase === 'dead' && <GameOver />}
            {phase === 'playing' && flashKey > 0 && <div key={flashKey} className="hitflash" />}
            {inputMode === 'camera' && camera.status === 'running' && !debug && phase !== 'calibrate' && phase !== 'setup' && (
                <div className="pip">
                    <CameraView width={240} height={180} />
                </div>
            )}
            {debug && <Debug />}
            <div className="keys-hint">G debug · M mute · F fullscreen</div>
        </div>
    );
}
