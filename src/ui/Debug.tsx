// Debug overlay (toggle with G or the backtick key, or open with ?debug):
// live graphs of the body signals with threshold lines and a marker for each
// detected move, camera stats, latency summary, and live threshold sliders.
import { useEffect, useRef, useState } from 'react';
import { camera } from '../control/camera';
import { latencyLog } from '../control/latency';
import { controlBus } from '../control/bus';
import { CameraView } from './CameraView';
import type { Thresholds } from '../control/detector';

const W = 520;
const H = 92;
const WINDOW_MS = 8000;

interface Trace {
    key: 'up' | 'drop' | 'lat' | 'foot' | 'knee';
    label: string;
    color: string;
    range: [number, number];
    lines: (th: Thresholds) => { v: number; color: string }[];
    marks: string[];
}

const TRACES: Trace[] = [
    { key: 'up', label: 'hip rise (torsos) → JUMP', color: '#51cf66', range: [-0.3, 0.8], lines: (t) => [{ v: t.jumpUp, color: '#51cf66' }], marks: ['jump'] },
    { key: 'drop', label: 'head drop vs feet (crouch) → DUCK', color: '#fcc419', range: [-0.3, 1.0], lines: (t) => [{ v: t.duckDown, color: '#fcc419' }], marks: ['duck'] },
    { key: 'foot', label: 'both feet off floor (torsos) → JUMP gate', color: '#20c997', range: [-0.2, 0.6], lines: (t) => [{ v: t.jumpFoot, color: '#20c997' }], marks: ['jump'] },
    {
        key: 'lat',
        label: 'body position (thirds of the image) → LEFT/RIGHT',
        color: '#4dabf7',
        range: [-0.5, 0.5],
        lines: () => [
            { v: 1 / 6, color: '#4dabf7' },
            { v: -1 / 6, color: '#4dabf7' },
        ],
        marks: ['left', 'right'],
    },
    { key: 'knee', label: 'knee alternation → cadence', color: '#f783ac', range: [-0.6, 0.6], lines: () => [{ v: 0.08, color: '#f783ac' }, { v: -0.08, color: '#f783ac' }], marks: [] },
];

function Graph({ tr }: { tr: Trace }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        let raf = 0;
        const draw = () => {
            raf = requestAnimationFrame(draw);
            const c = ref.current;
            if (!c) return;
            const g = c.getContext('2d')!;
            g.clearRect(0, 0, W, H);
            g.fillStyle = 'rgba(10,14,24,0.85)';
            g.fillRect(0, 0, W, H);
            const ring = camera.ring;
            const now = ring.length ? ring[ring.length - 1].t : performance.now();
            const [lo, hi] = tr.range;
            const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
            const x = (t: number) => W - ((now - t) / WINDOW_MS) * W;
            g.strokeStyle = 'rgba(255,255,255,0.15)';
            g.beginPath();
            g.moveTo(0, y(0));
            g.lineTo(W, y(0));
            g.stroke();
            g.setLineDash([5, 4]);
            for (const l of tr.lines(camera.detector.th)) {
                g.strokeStyle = l.color;
                g.globalAlpha = 0.7;
                g.beginPath();
                g.moveTo(0, y(l.v));
                g.lineTo(W, y(l.v));
                g.stroke();
            }
            g.globalAlpha = 1;
            g.setLineDash([]);
            for (const m of camera.moves) {
                if (!tr.marks.includes(m.move) || now - m.t > WINDOW_MS) continue;
                g.fillStyle = m.hold ? 'rgba(255,255,255,0.25)' : '#fff';
                g.fillRect(x(m.t) - 1, 0, m.hold ? 1 : 3, H);
                if (!m.hold) {
                    g.font = 'bold 11px system-ui';
                    g.fillText(m.move.toUpperCase(), x(m.t) + 4, 12);
                    g.fillStyle = 'rgba(255,255,255,0.35)';
                    g.fillRect(x(m.onset), H - 6, Math.max(2, x(m.t) - x(m.onset)), 6);
                }
            }
            g.strokeStyle = tr.color;
            g.lineWidth = 2;
            g.beginPath();
            let started = false;
            for (const s of ring) {
                if (now - s.t > WINDOW_MS) continue;
                if (!s.ok) {
                    started = false;
                    continue;
                }
                const px = x(s.t);
                const py = y(Math.max(lo, Math.min(hi, s[tr.key])));
                if (!started) g.moveTo(px, py);
                else g.lineTo(px, py);
                started = true;
            }
            g.stroke();
            g.lineWidth = 1;
            g.fillStyle = '#ced4da';
            g.font = '11px system-ui';
            g.fillText(tr.label, 6, H - 8);
        };
        draw();
        return () => cancelAnimationFrame(raf);
    }, [tr]);
    return <canvas ref={ref} width={W} height={H} className="dbg-graph" />;
}

const SLIDERS: { key: keyof Thresholds; label: string; min: number; max: number; step: number }[] = [
    { key: 'jumpUp', label: 'jump rise', min: 0.06, max: 0.5, step: 0.01 },
    { key: 'jumpVel', label: 'jump speed', min: 0.3, max: 3, step: 0.05 },
    { key: 'duckDown', label: 'duck fold', min: 0.05, max: 0.6, step: 0.01 },
    { key: 'jumpFoot', label: 'feet off floor', min: 0, max: 0.4, step: 0.01 },
    { key: 'laneDead', label: 'lane dead band', min: 0, max: 0.08, step: 0.005 },
];

const fmt = (s: { median: number; p90: number; n: number } | null) => (s ? `${s.median.toFixed(0)} / ${s.p90.toFixed(0)} ms (n=${s.n})` : '—');

export function Debug() {
    const [, force] = useState(0);
    useEffect(() => {
        const id = setInterval(() => force((x) => x + 1), 250);
        return () => clearInterval(id);
    }, []);
    const th = camera.detector.th;
    const sum = latencyLog.summary('camera');
    const st = controlBus.state;
    const download = () => {
        const blob = new Blob([latencyLog.exportJSON()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `pocket-runner-latency-${Date.now()}.json`;
        a.click();
    };
    return (
        <div className="debug">
            <div className="dbg-col">
                <CameraView width={320} height={240} className="dbg-cam" />
                <div className="dbg-stats">
                    <div>
                        camera: <b>{camera.status}</b> · {camera.delegate} · <b>{camera.fps}</b> fps
                    </div>
                    <div>
                        inference {camera.timing.inferenceMs.toFixed(1)} ms · capture→detect {camera.timing.captureToDetectMs.toFixed(0)} ms
                    </div>
                    <div>
                        present {st.present ? '✔' : '✘'} · zone <b>{st.zone}</b> · cadence <b>{st.cadence.toFixed(0)}</b> spm · {st.running ? 'RUNNING' : 'still'}
                    </div>
                    <div className="dbg-sub">latency median / p90 (camera moves)</div>
                    <div>motion onset → detect: {fmt(sum.onsetToDetect)}</div>
                    <div>frame → detect: {fmt(sum.frameToDetect)}</div>
                    <div>detect → on screen: {fmt(sum.detectToShown)}</div>
                    <div>
                        <b>onset → on screen: {fmt(sum.onsetToShown)}</b>
                    </div>
                    <button className="btn tiny" onClick={download}>
                        download latency log
                    </button>
                </div>
            </div>
            <div className="dbg-col">
                {TRACES.map((t) => (
                    <Graph key={t.key} tr={t} />
                ))}
                <div className="dbg-sliders">
                    {SLIDERS.map((s) => (
                        <label key={s.key}>
                            <span>
                                {s.label} <b>{th[s.key].toFixed(2)}</b>
                            </span>
                            <input
                                type="range"
                                min={s.min}
                                max={s.max}
                                step={s.step}
                                value={th[s.key]}
                                onChange={(e) => {
                                    camera.detector.th = { ...camera.detector.th, [s.key]: Number(e.target.value) };
                                    force((x) => x + 1);
                                }}
                            />
                        </label>
                    ))}
                </div>
            </div>
        </div>
    );
}
