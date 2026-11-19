// Latency log: for each control event we record the stages
//   onset   -> body motion started (estimated from the signal's velocity onset)
//   frame   -> camera captured the frame that crossed the threshold
//   sent    -> detector fired (landmarks ready + decision)
//   applied -> the sim tick that consumed it
//   shown   -> the next rendered frame after it was applied
// Camera-to-screen (glass-to-glass) latency also includes the camera's own
// exposure/USB delay and the TV's display lag, which software cannot see —
// measure those with a 240 fps video (see README).

import type { ControlEvent } from './types';

export interface LatencyRecord {
    seq: number;
    move: string;
    source: string;
    onsetAt?: number;
    frameAt?: number;
    sentAt: number;
    appliedAt?: number;
    shownAt?: number;
}

const MAX = 500;

class LatencyLog {
    readonly records: LatencyRecord[] = [];
    private waitingShow: LatencyRecord[] = [];

    applied(e: ControlEvent, at: number): void {
        const r: LatencyRecord = {
            seq: e.seq,
            move: e.move,
            source: e.source,
            onsetAt: e.onsetAt,
            frameAt: e.frameAt,
            sentAt: e.sentAt,
            appliedAt: at,
        };
        this.records.push(r);
        if (this.records.length > MAX) this.records.shift();
        this.waitingShow.push(r);
    }

    /** Called once per rendered frame. */
    frameShown(at: number): void {
        for (const r of this.waitingShow) r.shownAt = at;
        this.waitingShow = [];
    }

    summary(source?: string) {
        const rs = this.records.filter((r) => !source || r.source === source);
        const pick = (f: (r: LatencyRecord) => number | undefined) =>
            rs.map(f).filter((x): x is number => typeof x === 'number' && isFinite(x) && x >= 0);
        const stats = (xs: number[]) => {
            if (!xs.length) return null;
            const s = [...xs].sort((a, b) => a - b);
            return { n: s.length, median: s[s.length >> 1], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] };
        };
        return {
            onsetToDetect: stats(pick((r) => (r.onsetAt !== undefined ? r.sentAt - r.onsetAt : undefined))),
            frameToDetect: stats(pick((r) => (r.frameAt !== undefined ? r.sentAt - r.frameAt : undefined))),
            detectToShown: stats(pick((r) => (r.shownAt !== undefined ? r.shownAt - r.sentAt : undefined))),
            onsetToShown: stats(pick((r) => (r.shownAt !== undefined && r.onsetAt !== undefined ? r.shownAt - r.onsetAt : undefined))),
        };
    }

    exportJSON(): string {
        return JSON.stringify({ records: this.records, summary: { camera: this.summary('camera'), keyboard: this.summary('keyboard') } }, null, 2);
    }
}

export const latencyLog = new LatencyLog();
