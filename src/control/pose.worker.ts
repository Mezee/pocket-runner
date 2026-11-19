// Pose detection off the main thread. The main thread sends one ImageBitmap at
// a time (frames are dropped while we're busy, so latency never builds up) and
// gets landmarks back. This keeps MediaPipe inference + GPU readback from
// stalling the game's rendering, which caused the stutter in playtest v3.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

type InitMsg = { type: 'init'; wasmBase: string; model: string; numPoses: number; prefer: 'GPU' | 'CPU' };
type FrameMsg = { type: 'frame'; id: number; ts: number; bitmap: ImageBitmap };

let landmarker: PoseLandmarker | null = null;
let lastTs = -1;

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<InitMsg | FrameMsg>) => {
    const m = e.data;
    if (m.type === 'init') {
        try {
            const fileset = await FilesetResolver.forVisionTasks(m.wasmBase, true);
            const make = (delegate: 'GPU' | 'CPU') =>
                PoseLandmarker.createFromOptions(fileset, {
                    baseOptions: { modelAssetPath: m.model, delegate },
                    canvas: delegate === 'GPU' ? new OffscreenCanvas(1, 1) : undefined,
                    runningMode: 'VIDEO',
                    numPoses: m.numPoses,
                    minPoseDetectionConfidence: 0.5,
                    minPosePresenceConfidence: 0.5,
                    minTrackingConfidence: 0.5,
                });
            let delegate: 'GPU' | 'CPU' = m.prefer;
            try {
                landmarker = await make(delegate);
            } catch {
                delegate = delegate === 'GPU' ? 'CPU' : 'GPU';
                landmarker = await make(delegate);
            }
            post({ type: 'ready', delegate });
        } catch (err) {
            post({ type: 'error', message: String(err) });
        }
        return;
    }
    if (m.type === 'frame') {
        if (!landmarker) {
            m.bitmap.close();
            post({ type: 'result', id: m.id, landmarks: [], inferenceMs: 0 });
            return;
        }
        let ts = m.ts;
        if (ts <= lastTs) ts = lastTs + 1;
        lastTs = ts;
        const t0 = performance.now();
        let landmarks: unknown[] = [];
        try {
            const res = landmarker.detectForVideo(m.bitmap, ts);
            landmarks = res.landmarks ?? [];
        } catch (err) {
            post({ type: 'warn', message: String(err) });
        }
        const inferenceMs = performance.now() - t0;
        m.bitmap.close();
        post({ type: 'result', id: m.id, landmarks, inferenceMs });
    }
};
