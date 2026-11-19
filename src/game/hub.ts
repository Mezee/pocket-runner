// The only place where control events become sim inputs.
//
// Design (after the first playtest): the runner ALWAYS moves. Running cadence
// is no longer a control — webcam step detection was too unreliable to gate
// speed on, and stalling in front of obstacles felt awful. Steps are counted
// as a workout bonus instead (see camera.detector.stepCount).
//
// Camera lanes are ABSOLUTE: the body's zone (left / centre / right of where
// you calibrated) is the lane. If the sim's lane target differs from the zone,
// we send the Left/Right steps needed, so missed or doubled lane events are
// self-correcting. Keyboard lanes are relative (one press = one lane).

import { controlBus } from '../control/bus';
import { latencyLog } from '../control/latency';
import type { ControlEvent } from '../control/types';
import { Act, EFFORT_MAX, type Input } from '../sim/sim';
import type { SimRunner } from '../sim/runner';

export class InputHub {
    private effortSent = false;

    /** Called once per rendered frame before runner.advance(). */
    pump(runner: SimRunner, now: number, mode: 'camera' | 'keyboard'): ControlEvent[] {
        const events = controlBus.drain();
        const st = runner.state;
        let target = st.laneTarget;
        if (!this.effortSent) {
            runner.input({ act: Act.Effort, value: EFFORT_MAX });
            this.effortSent = true;
        }
        for (const e of events) {
            const inputs: Input[] = [];
            if (e.move === 'jump') inputs.push({ act: Act.Jump });
            else if (e.move === 'duck') {
                // "Still holding" pulses only extend a slide that is already
                // happening; they must never cancel a jump or start a new slide.
                if (!e.hold || runner.sliding) inputs.push({ act: Act.Duck });
            }
            else if (e.source === 'camera' && e.zone !== undefined) {
                while (target > e.zone) {
                    inputs.push({ act: Act.Left });
                    target--;
                }
                while (target < e.zone) {
                    inputs.push({ act: Act.Right });
                    target++;
                }
            } else if (e.move === 'left') {
                inputs.push({ act: Act.Left });
                target = Math.max(-1, target - 1);
            } else if (e.move === 'right') {
                inputs.push({ act: Act.Right });
                target = Math.min(1, target + 1);
            }
            for (const i of inputs) runner.input(i);
            latencyLog.applied(e, now);
        }

        // Camera: re-sync lane to the zone you're standing in (covers lost events).
        if (mode === 'camera' && controlBus.state.present) {
            const z = controlBus.state.zone;
            while (target > z) {
                runner.input({ act: Act.Left });
                target--;
            }
            while (target < z) {
                runner.input({ act: Act.Right });
                target++;
            }
        }
        return events;
    }

    reset(): void {
        this.effortSent = false;
        controlBus.clear();
    }
}

export const hub = new InputHub();
