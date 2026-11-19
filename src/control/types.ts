// The control contract between input producers and the game.
//
// The game never sees camera frames or landmarks. Camera, keyboard (and, later,
// a phone) are interchangeable producers of these events. This is the design
// borrowed from Motion Parkour: one small control interface.

export type Move = 'left' | 'right' | 'jump' | 'duck';
export type Source = 'camera' | 'keyboard';

export interface ControlEvent {
    move: Move;
    source: Source;
    seq: number; // increments per event, for latency logging
    sentAt: number; // performance.now() when the producer detected the move
    onsetAt?: number; // best estimate of when the body motion actually started
    frameAt?: number; // capture time of the camera frame that triggered it
    hold?: boolean; // duck: "still holding", extends the slide
    zone?: -1 | 0 | 1; // camera lanes: absolute lane the body is now standing in
}

/** Snapshot the game reads every frame. Pulses are consumed once via drain(). */
export interface ControlState {
    cadence: number; // steps per minute, smoothed; 0 = standing still
    running: boolean; // cadence above the "running" threshold (with hold)
    zone: -1 | 0 | 1; // camera only: which lane zone the body is standing in
    present: boolean; // camera only: a person is in frame
}
