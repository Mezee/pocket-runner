// Headless end-to-end test of the camera pipeline with a synthetic body.
//
//   npm run build && npm run preview   (in another terminal)
//   npm run e2e [-- --url http://localhost:4173 --seconds 120 --react 350]
//
// Opens the game with ?fake=1 (synthetic skeleton instead of webcam+MediaPipe),
// runs the full calibration, then plays: a "bot body" watches the course and
// performs the right body move (jump / duck / step) `--react` ms after the
// on-screen prompt would let a human see it. Everything downstream of the
// landmarks — features, calibration, detector, control bus, hub, sim — is the
// real code. Prints detection + gameplay stats and a latency summary.
import { chromium } from 'playwright';

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const URL = args.url ?? 'http://localhost:4173';
const SECONDS = Number(args.seconds ?? 120);
const SEED = args.seed ?? 'e2e-1';
const SHOT = args.shot ?? '';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${URL}/?fake=1&seed=${SEED}`);
await page.waitForTimeout(800);
await page.getByText('PLAY WITH CAMERA').click();

// ---- Calibration with the synthetic body ----
const calStart = Date.now();
await page.evaluate(() => {
    const c = window.pocket.camera;
    c.act({ kind: 'stand', ms: 3800 }, { kind: 'jump' }, { kind: 'stand', ms: 700 }, { kind: 'duck' }, { kind: 'stand', ms: 900 });
});
if (SHOT) {
    await page.waitForTimeout(4500);
    await page.screenshot({ path: `${SHOT}-calibrate.png` });
}
await page.waitForFunction(() => window.pocket.store.getState().phase === 'ready', null, { timeout: 30000 });
const calMs = Date.now() - calStart;
const th = await page.evaluate(() => window.pocket.camera.detector.th);

// ---- Jump to start; the synthetic body also runs on the spot (bonus steps) ----
await page.waitForTimeout(800);
await page.evaluate(() => { window.pocket.camera.act({ kind: 'jump' }); window.pocket.camera.setFakeRunning(true); });
await page.waitForFunction(() => window.pocket.store.getState().phase === 'playing', null, { timeout: 15000 });

// ---- Bot body: plays from inside the page so timing is not skewed by CDP round-trips ----
await page.evaluate(
    ({ seconds }) => {
        const P = window.pocket;
        const done = new Set();
        const log = (window.__bot = { planned: [], zone: 0 });
        const tick = () => {
            const r = P.game.runner;
            if (!r || P.store.getState().phase !== 'playing') return;
            const s = r.state;
            const speed = Math.max(r.speed, 6);
            for (const row of s.rows.slice(0, 3)) {
                if (row.pattern === 'empty' || done.has(row.index)) continue;
                const secs = (row.dist - r.distance) / speed;
                // the prompt shows at 1.5 s; a human reacts and moves. We start the
                // body move when 0.75 s remain (prompt + ~750 ms reaction).
                if (secs > 0.75) continue;
                done.add(row.index);
                const lane = log.zone;
                const here = row.cells[lane + 1];
                if (!here || here.kind === 'coin') continue;
                if (here.kind === 'low') {
                    P.camera.act({ kind: 'jump' });
                    log.planned.push({ row: row.index, move: 'jump', at: performance.now() });
                } else if (here.kind === 'high') {
                    P.camera.act({ kind: 'duck', ms: 900 });
                    log.planned.push({ row: row.index, move: 'duck', at: performance.now() });
                } else {
                    for (const d of [-1, 1, -2, 2]) {
                        const l = lane + d;
                        if (l < -1 || l > 1) continue;
                        const c = row.cells[l + 1];
                        if (!c || c.kind === 'coin') {
                            const dir = d < 0 ? -1 : 1;
                            for (let k = 0; k < Math.abs(d); k++) {
                                P.camera.act({ kind: 'step', dir, dist: 0.3 }); // one third of the frame
                                log.planned.push({ row: row.index, move: dir < 0 ? 'left' : 'right', at: performance.now() });
                            }
                            log.zone = l;
                            break;
                        }
                    }
                }
            }
        };
        const id = setInterval(tick, 16);
        setTimeout(() => clearInterval(id), seconds * 1000 + 2000);
    },
    { seconds: SECONDS },
);

const t0 = Date.now();
let shotTaken = false;
while (Date.now() - t0 < SECONDS * 1000) {
    await page.waitForTimeout(1000);
    const ph = await page.evaluate(() => window.pocket.store.getState().phase);
    if (SHOT && !shotTaken && Date.now() - t0 > 12000) {
        await page.screenshot({ path: `${SHOT}-play.png` });
        await page.keyboard.press('g');
        await page.waitForTimeout(1500);
        await page.screenshot({ path: `${SHOT}-debug.png` });
        await page.keyboard.press('g');
        shotTaken = true;
    }
    if (ph !== 'playing') break;
}

const result = await page.evaluate(() => {
    const P = window.pocket;
    const r = P.game.runner;
    const s = r.state;
    const moves = P.camera.moves.filter((m) => !m.hold);
    const planned = window.__bot.planned;
    const count = (arr, k) => arr.filter((x) => x.move === k).length;
    return {
        phase: P.store.getState().phase,
        seconds: +(s.tick / 60).toFixed(1),
        distance: r.distance,
        hearts: s.hearts,
        stats: s.stats,
        cause: s.deathCause,
        planned: { jump: count(planned, 'jump'), duck: count(planned, 'duck'), left: count(planned, 'left'), right: count(planned, 'right') },
        detected: { jump: count(moves, 'jump'), duck: count(moves, 'duck'), left: count(moves, 'left'), right: count(moves, 'right') },
        latency: P.latencyLog.summary('camera'),
        fps: P.camera.fps,
        steps: P.store.getState().steps,
        score: P.store.getState().score,
    };
});
console.log(JSON.stringify({ calibrationMs: calMs, thresholds: th, ...result, errors }, null, 2));
await browser.close();
