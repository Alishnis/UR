import { InputState } from "../input/input_state.js";
import { Ramp, outputSlotProblem, thrusterCommands, toSlots } from "./mixer.js";
import { Protocol } from "../protocol/protocol.js";

// Sends a command EVERY tick (20 Hz), also when nothing changes: the firmware watchdog needs to hear from us,
// otherwise it stops the thrusters after 500 ms. Disarmed -> "S" every tick.
export class CommandLoop {
  constructor(transport, config) {
    this.transport = transport;
    this.config = config;
    this.rateHz = config.commandRateHz;
    this.maxThrottle = config.maxThrottle;
    this.ramp = new Ramp(config.rampPerSec);
    this.armed = false;
    this.output = { left: 0, right: 0, vert: 0 };  // what was sent last (after limit and ramp)
    this.timer = null;
    this.lastTick = 0;
  }

  start() {
    if (this.timer) return;
    this.lastTick = performance.now();
    this.timer = setInterval(() => this._tick(), 1000 / this.rateHz);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setMaxThrottle(v) {
    this.maxThrottle = Math.min(Math.max(v, 0), this.config.maxThrottleLimit);
  }

  arm() {
    if (!this.transport.isConnected()) return "not connected";
    const slotProblem = outputSlotProblem(this.config.outputSlot);
    if (slotProblem) return slotProblem;
    if (!InputState.idle()) return "release all movement keys first";
    this.ramp.reset();
    this.armed = true;
    return null;
  }

  disarm() {
    this.armed = false;
    this.sendStop();
  }

  sendStop() {
    this.ramp.reset();
    this.output = { left: 0, right: 0, vert: 0 };
    if (this.transport.isConnected()) this.transport.send(Protocol.encodeStop());
  }

  _tick() {
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.2);
    this.lastTick = now;
    if (!this.transport.isConnected()) {
      this.armed = false;
      return;
    }
    if (!this.armed || InputState.hold) {
      this.sendStop();  // stop is immediate, not ramped
      return;
    }
    const target = thrusterCommands(InputState, this.config, this.maxThrottle);
    this.output = this.ramp.step(target, dt);
    const o = this.output;
    this.transport.send(Protocol.encodeDrive(...toSlots(o, this.config.outputSlot)));
  }
}
