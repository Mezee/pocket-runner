// Camera preview + skeleton overlay + lane zone guides (mirror view).
import { useEffect, useRef } from 'react';
import { camera } from '../control/camera';

const BONES: [number, number][] = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28], [27, 31], [28, 32],
];

export function CameraView({ width, height, zones = true, className }: { width: number; height: number; zones?: boolean; className?: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let raf = 0;
        const draw = () => {
            raf = requestAnimationFrame(draw);
            const c = ref.current;
            if (!c) return;
            const g = c.getContext('2d')!;
            const W = c.width;
            const H = c.height;
            const mir = camera.mirror;
            g.save();
            // Front camera: show as a mirror. Camera behind you: show as-is.
            if (mir) {
                g.translate(W, 0);
                g.scale(-1, 1);
            }
            const v = camera.video;
            if (v && v.readyState >= 2) g.drawImage(v, 0, 0, W, H);
            else {
                g.fillStyle = '#1b2433';
                g.fillRect(0, 0, W, H);
            }
            g.restore();

            const det = camera.detector;
            const b = det.base;
            const toX = (x: number) => (mir ? 1 - x : x) * W; // image x -> canvas x
            if (zones && !camera.calibrating) {
                // Lanes are fixed, equal thirds of the picture.
                const zone = det.currentZone;
                g.fillStyle = 'rgba(77,171,247,0.22)';
                g.fillRect(((zone + 1) * W) / 3, 0, W / 3, H);
                g.strokeStyle = 'rgba(255,255,255,0.8)';
                g.setLineDash([8, 8]);
                g.lineWidth = 2;
                for (const x of [W / 3, (2 * W) / 3]) {
                    g.beginPath();
                    g.moveTo(x, 0);
                    g.lineTo(x, H);
                    g.stroke();
                }
                g.setLineDash([]);
            }
            if (zones && b && !camera.calibrating) {
                // jump / duck lines
                const hipLine = (b.hipY - det.th.jumpUp * b.torso) * H;
                const duckLine = (b.shoulderY + det.th.duckDown * b.torso) * H;
                g.strokeStyle = '#51cf66';
                g.beginPath();
                g.moveTo(0, hipLine);
                g.lineTo(W, hipLine);
                g.stroke();
                void duckLine; // duck is measured from leg folding now, not a fixed line
            }

            const lms = camera.landmarks;
            if (lms) {
                g.lineWidth = Math.max(2, W / 160);
                g.strokeStyle = camera.features?.ok ? '#ffd43b' : '#ff6b6b';
                for (const [a, bb] of BONES) {
                    const p = lms[a];
                    const q = lms[bb];
                    if ((p.visibility ?? 1) < 0.4 || (q.visibility ?? 1) < 0.4) continue;
                    g.beginPath();
                    g.moveTo(toX(p.x), p.y * H);
                    g.lineTo(toX(q.x), q.y * H);
                    g.stroke();
                }
                g.fillStyle = '#fff';
                for (const i of [0, 11, 12, 23, 24, 25, 26, 27, 28]) {
                    const p = lms[i];
                    if ((p.visibility ?? 1) < 0.4) continue;
                    g.beginPath();
                    g.arc(toX(p.x), p.y * H, Math.max(3, W / 120), 0, Math.PI * 2);
                    g.fill();
                }
            }
        };
        draw();
        return () => cancelAnimationFrame(raf);
    }, [zones]);
    return <canvas ref={ref} width={width} height={height} className={className} />;
}
