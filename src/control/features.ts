// Landmarks -> a handful of body features. Pure, so it is unit-testable.
//
// MediaPipe normalized landmarks: x in [0,1] left->right of the IMAGE, y in
// [0,1] top->bottom. With the camera facing the player (by the TV), the image
// is a mirror of the player's view, so we flip x to get "player's right = +".

export interface Landmark {
    x: number;
    y: number;
    z?: number;
    visibility?: number;
}

export const LM = {
    nose: 0,
    lShoulder: 11,
    rShoulder: 12,
    lHip: 23,
    rHip: 24,
    lKnee: 25,
    rKnee: 26,
    lAnkle: 27,
    rAnkle: 28,
} as const;

export interface Features {
    t: number; // ms
    ok: boolean; // shoulders + hips visible
    cx: number; // body centre x, player-relative (+ = player's right), image units
    hipY: number; // image units, down = +
    shoulderY: number;
    torso: number; // hip-to-shoulder vertical distance (scale reference)
    shoulderW: number; // shoulder width (lateral scale reference)
    kneeDiff: number | null; // (leftKneeY - rightKneeY) / torso; null if knees not visible
    // Height of the LOWER foot (image y, down = +). While running one foot is
    // always planted, so this only rises when BOTH feet leave the floor (a jump).
    // Uses ankles; falls back to knees if ankles are out of frame.
    footY: number | null;
    footSrc: 'ankle' | 'knee' | null;
    // Hip-to-foot vertical length / torso length. Scale- and position-free:
    // squatting folds the legs, so this drops a lot; walking around doesn't.
    // (head Y − lowest foot Y) in image units: your height above your own feet.
    // Walking closer to the camera moves BOTH head and feet in the picture, so
    // this stays the same; squatting drops the head while feet stay put.
    headToFoot: number | null;
    vis: { head: boolean; shoulders: boolean; hips: boolean; knees: boolean; ankles: boolean };
}

const VIS = 0.5;
const seen = (l?: Landmark) => !!l && (l.visibility ?? 1) >= VIS && l.x > -0.05 && l.x < 1.05 && l.y > -0.05 && l.y < 1.05;

export function extractFeatures(lms: Landmark[] | undefined, t: number, mirror: boolean): Features {
    const empty: Features = {
        t,
        ok: false,
        cx: 0,
        hipY: 0,
        shoulderY: 0,
        torso: 0,
        shoulderW: 0,
        kneeDiff: null,
        footY: null,
        footSrc: null,
        headToFoot: null,
        vis: { head: false, shoulders: false, hips: false, knees: false, ankles: false },
    };
    if (!lms || lms.length < 29) return empty;
    const ls = lms[LM.lShoulder];
    const rs = lms[LM.rShoulder];
    const lh = lms[LM.lHip];
    const rh = lms[LM.rHip];
    const lk = lms[LM.lKnee];
    const rk = lms[LM.rKnee];
    const vis = {
        head: seen(lms[LM.nose]),
        shoulders: seen(ls) && seen(rs),
        hips: seen(lh) && seen(rh),
        knees: seen(lk) && seen(rk),
        ankles: seen(lms[LM.lAnkle]) && seen(lms[LM.rAnkle]),
    };
    if (!vis.shoulders || !vis.hips) return { ...empty, vis };

    const shoulderY = (ls.y + rs.y) / 2;
    const hipY = (lh.y + rh.y) / 2;
    const torso = Math.max(0.02, hipY - shoulderY);
    const rawCx = (ls.x + rs.x + lh.x + rh.x) / 4;
    const cx = mirror ? 0.5 - rawCx : rawCx - 0.5;
    const shoulderW = Math.max(0.02, Math.hypot(ls.x - rs.x, ls.y - rs.y));
    // Landmark "left" is the person's left regardless of mirroring.
    const kneeDiff = vis.knees ? (lk.y - rk.y) / torso : null;
    const la = lms[LM.lAnkle];
    const ra = lms[LM.rAnkle];
    const footSrc = vis.ankles ? 'ankle' : vis.knees ? 'knee' : null;
    const footY = footSrc === 'ankle' ? Math.max(la.y, ra.y) : footSrc === 'knee' ? Math.max(lk.y, rk.y) : null;
    const headY = Math.min(lms[LM.nose].y, shoulderY);
    const headToFoot = footY !== null ? footY - headY : null;
    return { t, ok: true, cx, hipY, shoulderY, torso, shoulderW, kneeDiff, footY, footSrc, headToFoot, vis };
}

/**
 * Choose which detected person is the player: the pose whose body centre is
 * nearest the player's last known centre (image x, 0..1). Bystanders walking
 * behind the player no longer steal control. Falls back to the largest body.
 */
export function pickPlayer(poses: Landmark[][] | undefined, lastCx: number | null): Landmark[] | undefined {
    if (!poses || poses.length === 0) return undefined;
    if (poses.length === 1) return poses[0];
    const info = poses.map((p) => {
        const pts = [p[LM.lShoulder], p[LM.rShoulder], p[LM.lHip], p[LM.rHip]];
        const cx = pts.reduce((a, l) => a + l.x, 0) / 4;
        const size = Math.abs((p[LM.lHip].y + p[LM.rHip].y) / 2 - (p[LM.lShoulder].y + p[LM.rShoulder].y) / 2);
        return { p, cx, size };
    });
    if (lastCx !== null) {
        info.sort((a, b) => Math.abs(a.cx - lastCx) - Math.abs(b.cx - lastCx));
        return info[0].p;
    }
    info.sort((a, b) => b.size - a.size);
    return info[0].p;
}

/** Raw image-x body centre of a pose (for tracking between frames). */
export function poseCentreX(p: Landmark[] | undefined): number | null {
    if (!p || p.length < 25) return null;
    return (p[LM.lShoulder].x + p[LM.rShoulder].x + p[LM.lHip].x + p[LM.rHip].x) / 4;
}
