// Synthesized SFX + voice cues. No audio files are shipped.
// The tone/noise synth approach is adapted from Bull Rush's audio.ts (MIT,
// Copyright (c) 2026 winsznx); Bull Rush's music tracks are NOT used.

export type Sfx = 'jump' | 'duck' | 'lane' | 'coin' | 'hit' | 'death' | 'go' | 'tick' | 'good';

class AudioEngine {
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;
    muted = false;

    unlock(): void {
        if (!this.ctx) {
            this.ctx = new AudioContext();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.muted ? 0 : 0.5;
            this.master.connect(this.ctx.destination);
        } else if (this.ctx.state === 'suspended') void this.ctx.resume();
    }

    setMuted(m: boolean): void {
        this.muted = m;
        if (this.master) this.master.gain.value = m ? 0 : 0.5;
        if (m) speechSynthesis?.cancel();
    }

    private tone(freq: number, type: OscillatorType, dur: number, vol: number, slideTo?: number, delay = 0): void {
        if (!this.ctx || !this.master) return;
        const t = this.ctx.currentTime + delay;
        const o = this.ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + dur + 0.03);
    }

    private noise(dur: number, vol: number): void {
        if (!this.ctx || !this.master) return;
        const t = this.ctx.currentTime;
        const buf = this.ctx.createBuffer(1, Math.max(1, Math.floor(this.ctx.sampleRate * dur)), this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(g).connect(this.master);
        src.start(t);
    }

    sfx(name: Sfx): void {
        if (!this.ctx) return;
        switch (name) {
            case 'jump':
                this.tone(300, 'square', 0.16, 0.12, 700);
                break;
            case 'duck':
                this.tone(500, 'triangle', 0.16, 0.14, 180);
                this.noise(0.12, 0.05);
                break;
            case 'lane':
                this.tone(420, 'sine', 0.08, 0.1, 560);
                break;
            case 'coin':
                this.tone(988, 'square', 0.06, 0.1);
                this.tone(1319, 'square', 0.12, 0.1, undefined, 0.06);
                break;
            case 'hit':
                this.tone(180, 'square', 0.22, 0.28, 60);
                this.noise(0.16, 0.12);
                break;
            case 'death':
                this.tone(320, 'sawtooth', 0.7, 0.28, 38);
                this.noise(0.4, 0.1);
                break;
            case 'go':
                this.tone(523, 'sine', 0.12, 0.2);
                this.tone(784, 'sine', 0.2, 0.2, undefined, 0.1);
                break;
            case 'tick':
                this.tone(880, 'sine', 0.05, 0.08);
                break;
            case 'good':
                this.tone(660, 'sine', 0.08, 0.14);
                this.tone(990, 'sine', 0.12, 0.14, undefined, 0.07);
                break;
        }
    }

    /** Spoken cue (calibration happens away from the screen). */
    say(text: string): void {
        if (this.muted || typeof speechSynthesis === 'undefined') return;
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.1;
        speechSynthesis.speak(u);
    }
}

export const Audio = new AudioEngine();
