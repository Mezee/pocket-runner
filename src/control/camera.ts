// Camera producer: webcam -> MediaPipe Pose -> features -> calibrator/detector
// -> ControlBus. Also exposes a ring buffer of signals + last landmarks for
// the debug overlay, and per-stage timing for latency logging.
//
// `?fake=1` swaps the webcam + MediaPipe for the synthetic skeleton (synth.ts),
// which lets the whole game be driven headlessly in e2e tests.

import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { controlBus } from './bus';
import { extractFeatures, pickPlayer, poseCentreX, type Features, type Landmark } from './features';
import { MoveDetector, type DetectedMove, type Signals } from './detector';
import { Calibrator } from './calibration';
import { synthLandmarks, type ScriptAction, type SynthState } from './synth';

export type CamStatus = 'idle' | 'loading' | 'running' | 'error';

export interface FrameTiming {
    captureToDetectMs: number; // frame capture -> landmarks ready (camera queue + inference)
    inferenceMs: number;
}

export interface LoggedMove extends DetectedMove {
    frameAt: number;
    sentAt: number;
}

const RING = 300; // ~10 s at 30 fps

class CameraInput {
    status: CamStatus = 'idle';
    error = '';
    video: HTMLVideoElement | null = null;
    landmarks: Landmark[] | null = null;
    features: Features | null = null;
    readonly detector = new MoveDetector();
    readonly calibrator = new Calibrator();
    calibrating = false;
    // true: camera faces the player (normal). false: camera is BEHIND the player
    // (like the reference video), so left/right are not mirrored. Toggle with B.
    mirror = !(new URLSearchParams(location.search).has('behind') || localStorage.getItem('pocket-runner:behind') === '1');
    fake = false;
    delegate: 'GPU' | 'CPU' | 'synthetic' = 'GPU';
    fps = 0;
    timing: FrameTiming = { captureToDetectMs: 0, inferenceMs: 0 };
    readonly ring: Signals[] = [];
    readonly moves: LoggedMove[] = [];
    readonly timings: FrameTiming[] = [];
    private landmarker: PoseLandmarker | null = null;
    private trackCx: number | null = null; // raw image x of the player, for multi-person tracking
    private trackSeenAt = 0;
    others = 0; // other people currently in frame
    private stopFlag = false;
    private lastTs = -1;
    private frameTimes: number[] = [];
    private listeners = new Set<() => void>();

    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    private changed() {
        for (const l of this.listeners) l();
    }

    async start(opts: { fake?: boolean; deviceId?: string } = {}): Promise<void> {
        if (this.status === 'running' || this.status === 'loading') return;
        this.status = 'loading';
        this.error = '';
        this.stopFlag = false;
        this.changed();
        try {
            if (opts.fake) {
                this.fake = true;
                this.delegate = 'synthetic';
                this.status = 'running';
                this.changed();
                void this.fakeLoop();
                return;
            }
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 60, min: 24 },
                    facingMode: 'user',
                },
            });
            const v = document.createElement('video');
            v.muted = true;
            v.playsInline = true;
            v.srcObject = stream;
            await v.play();
            this.video = v;

            const base = import.meta.env.BASE_URL;
            // Preferred: run pose detection in a Web Worker so it can't stall rendering.
            if (!new URLSearchParams(location.search).has('mainthread') && (await this.startWorker(base))) {
                this.status = 'running';
                this.changed();
                this.workerLoop();
                return;
            }
            const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
            const make = (delegate: 'GPU' | 'CPU') =>
                PoseLandmarker.createFromOptions(fileset, {
                    baseOptions: { modelAssetPath: `${base}models/pose_landmarker_lite.task`, delegate },
                    runningMode: 'VIDEO',
                    numPoses: 2, // track a bystander too, so we can ignore them
                    minPoseDetectionConfidence: 0.5,
                    minPosePresenceConfidence: 0.5,
                    minTrackingConfidence: 0.5,
                });
            try {
                this.landmarker = await make('GPU');
                this.delegate = 'GPU';
            } catch (e) {
                console.warn('[camera] GPU delegate failed, falling back to CPU', e);
                this.landmarker = await make('CPU');
                this.delegate = 'CPU';
            }
            this.status = 'running';
            this.changed();
            this.loop();
        } catch (e) {
            this.status = 'error';
            const err = e as Error;
            this.error =
                err.name === 'NotAllowedError'
                    ? 'Camera permission was denied. Allow camera access for this page and reload.'
                    : err.name === 'NotFoundError'
                      ? 'No camera found. Plug in a webcam (or press K to play with the keyboard).'
                      : `${err.name}: ${err.message}`;
            this.changed();
        }
    }

    stop(): void {
        this.stopFlag = true;
        this.worker?.terminate();
        this.worker = null;
        const s = this.video?.srcObject as MediaStream | null;
        s?.getTracks().forEach((t) => t.stop());
        this.video = null;
        this.status = 'idle';
        this.changed();
    }

    setBehind(behind: boolean): void {
        this.mirror = !behind;
        localStorage.setItem('pocket-runner:behind', behind ? '1' : '0');
        this.changed();
    }

    beginCalibration(): void {
        this.calibrator.start(performance.now());
        this.calibrating = true;
        this.changed();
    }

    /** Use the current standing pose as the baseline, default thresholds. */
    quickCalibrate(): boolean {
        if (!this.features) return false;
        const ok = this.calibrator.quick(this.features);
        if (ok) this.finishCalibration();
        return ok;
    }

    private finishCalibration(): void {
        this.calibrating = false;
        this.detector.setBaseline(this.calibrator.base!);
        this.detector.th = { ...this.calibrator.th };
        this.changed();
    }

    // ---- Worker path ----
    private worker: Worker | null = null;
    useWorker = false;
    private busy = false;
    private frameId = 0;
    private pendingFrameAt = 0;

    private startWorker(base: string): Promise<boolean> {
        if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return Promise.resolve(false);
        return new Promise((resolve) => {
            let w: Worker;
            try {
                w = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
            } catch (e) {
                console.warn('[camera] worker unavailable', e);
                resolve(false);
                return;
            }
            const abs = new URL(base, location.href).href;
            const timer = setTimeout(() => {
                console.warn('[camera] worker init timed out; using main thread');
                w.terminate();
                resolve(false);
            }, 20000);
            w.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'ready') {
                    clearTimeout(timer);
                    this.worker = w;
                    this.useWorker = true;
                    this.delegate = m.delegate;
                    w.onmessage = (ev) => this.onWorkerMessage(ev.data);
                    resolve(true);
                } else if (m.type === 'error') {
                    clearTimeout(timer);
                    console.warn('[camera] worker init failed; using main thread', m.message);
                    w.terminate();
                    resolve(false);
                }
            };
            w.onerror = (e) => {
                clearTimeout(timer);
                console.warn('[camera] worker error; using main thread', e.message);
                w.terminate();
                resolve(false);
            };
            w.postMessage({ type: 'init', wasmBase: `${abs}mediapipe/wasm`, model: `${abs}models/pose_landmarker_lite.task`, numPoses: 2, prefer: new URLSearchParams(location.search).get('delegate') === 'gpu' ? 'GPU' : 'CPU' });
        });
    }

    private onWorkerMessage(m: { type: string; landmarks?: Landmark[][]; inferenceMs?: number; message?: string }): void {
        if (m.type === 'warn') console.warn('[pose worker]', m.message);
        if (m.type !== 'result') return;
        this.busy = false;
        if (this.stopFlag) return;
        const lms = pickPlayer(m.landmarks, this.trackCx);
        this.others = Math.max(0, (m.landmarks?.length ?? 0) - 1);
        this.process(lms, performance.now(), this.pendingFrameAt, m.inferenceMs ?? 0);
    }

    /** Send the newest camera frame to the worker; drop frames while it's busy. */
    private workerLoop(): void {
        const v = this.video!;
        const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
        const onFrame = async (now: number, meta?: VideoFrameCallbackMetadata) => {
            if (this.stopFlag || !this.worker) return;
            const next = () => (hasRVFC ? v.requestVideoFrameCallback(onFrame) : requestAnimationFrame((n) => void onFrame(n)));
            if (!this.busy && v.readyState >= 2) {
                this.busy = true;
                this.pendingFrameAt = meta?.captureTime ?? meta?.presentationTime ?? now;
                try {
                    const bitmap = await createImageBitmap(v);
                    this.worker.postMessage({ type: 'frame', id: ++this.frameId, ts: performance.now(), bitmap }, [bitmap]);
                } catch {
                    this.busy = false;
                }
            }
            next();
        };
        if (hasRVFC) v.requestVideoFrameCallback(onFrame);
        else requestAnimationFrame((n) => void onFrame(n));
    }

    private loop(): void {
        const v = this.video!;
        const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
        const onFrame = (now: number, meta?: VideoFrameCallbackMetadata) => {
            if (this.stopFlag || !this.landmarker) return;
            // captureTime is when the camera captured the frame (Chrome, local cameras).
            const frameAt = meta?.captureTime ?? meta?.presentationTime ?? now;
            let ts = performance.now();
            if (ts <= this.lastTs) ts = this.lastTs + 1;
            this.lastTs = ts;
            const t0 = performance.now();
            let lms: Landmark[] | undefined;
            try {
                const res = this.landmarker.detectForVideo(v, ts);
                lms = pickPlayer(res.landmarks, this.trackCx);
                this.others = Math.max(0, (res.landmarks?.length ?? 0) - 1);
            } catch (e) {
                console.warn('[camera] detect failed', e);
            }
            const t1 = performance.now();
            this.process(lms, t1, frameAt, t1 - t0);
            if (hasRVFC) v.requestVideoFrameCallback(onFrame);
            else requestAnimationFrame((n) => onFrame(n));
        };
        if (hasRVFC) v.requestVideoFrameCallback(onFrame);
        else requestAnimationFrame((n) => onFrame(n));
    }

    // ---- Synthetic mode (?fake=1): a scripted virtual body ----
    private fakeQueue: ScriptAction[] = [];
    readonly synth: SynthState = { t: 0, cx: 0.5, rise: 0, crouch: 0, running: false, cadence: 160, noise: 0.002 };
    /** Queue synthetic body actions (fake mode only). */
    act(...a: ScriptAction[]): void {
        this.fakeQueue.push(...a);
    }
    /** Toggle synthetic running in place (fake mode only). */
    setFakeRunning(on: boolean): void {
        this.synth.running = on;
    }
    private async fakeLoop(): Promise<void> {
        const FRAME = 1000 / 30;
        let cur: { a: ScriptAction; start: number; ms: number; cx0: number } | null = null;
        while (!this.stopFlag) {
            const now = performance.now();
            const s = this.synth;
            s.t = now;
            if (!cur && this.fakeQueue.length) {
                const a = this.fakeQueue.shift()!;
                const ms = 'ms' in a && a.ms ? a.ms : a.kind === 'jump' ? 550 : a.kind === 'duck' ? 700 : a.kind === 'step' ? 350 : 1000;
                cur = { a, start: now, ms, cx0: s.cx };
            }
            if (cur) {
                const p = Math.min(1, (now - cur.start) / cur.ms);
                const a = cur.a;
                if (a.kind === 'jump') s.rise = 4 * p * (1 - p) * (a.height ?? 0.09);
                if (a.kind === 'duck') s.crouch = Math.min(1, Math.sin(p * Math.PI) * 1.4) * (a.depth ?? 1);
                if (a.kind === 'step') s.cx = cur.cx0 + -a.dir * (a.dist ?? 0.12) * (0.5 - Math.cos(p * Math.PI) / 2);
                if (a.kind === 'run') s.running = true;
                if (a.kind === 'stand') s.running = false;
                if (p >= 1) {
                    s.rise = 0;
                    s.crouch = 0;
                    cur = null;
                }
            }
            this.process(synthLandmarks(s), now, now - FRAME, 3);
            await new Promise((r) => setTimeout(r, FRAME));
        }
    }

    // ---- Shared per-frame processing ----
    private process(lms: Landmark[] | undefined, t: number, frameAt: number, inferenceMs: number): void {
        this.landmarks = lms ?? null;
        const cx = poseCentreX(lms);
        if (cx !== null) {
            this.trackCx = cx;
            this.trackSeenAt = t;
        } else if (t - this.trackSeenAt > 2000) this.trackCx = null; // lost for 2 s: re-acquire
        const f = extractFeatures(lms, t, this.mirror);
        this.features = f;

        this.frameTimes.push(t);
        while (this.frameTimes.length && t - this.frameTimes[0] > 1000) this.frameTimes.shift();
        this.fps = this.frameTimes.length;
        this.timing = { captureToDetectMs: t - frameAt, inferenceMs };
        this.timings.push(this.timing);
        if (this.timings.length > 600) this.timings.shift();

        if (this.calibrating) {
            const before = this.calibrator.step;
            this.calibrator.update(f);
            if (this.calibrator.step !== before) this.changed();
            if (this.calibrator.done) this.finishCalibration();
            this.ring.push({ ...this.detector.signals, t, ok: f.ok });
            if (this.ring.length > RING) this.ring.shift();
            return;
        }

        const detected = this.detector.update(f);
        const st = controlBus.state;
        st.present = f.ok;
        st.cadence = this.detector.cadence;
        st.running = this.detector.running;
        st.zone = this.detector.currentZone;
        for (const m of detected) {
            const e = controlBus.emit(m.move, 'camera', { onsetAt: m.onset, frameAt, hold: m.hold, zone: m.zone });
            this.moves.push({ ...m, frameAt, sentAt: e.sentAt });
            if (this.moves.length > 200) this.moves.shift();
        }
        this.ring.push(this.detector.signals);
        if (this.ring.length > RING) this.ring.shift();
    }
}

export const camera = new CameraInput();
