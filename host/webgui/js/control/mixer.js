// Pilot input -> three thruster commands. Pure functions (tested with node: host/tests/webgui_mixer.test.mjs).

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// surge/yaw/heave in -1..1 and magnitude 0..1 -> left / right / vertical in -1..1.
// Two horizontal thrusters: forward = both push, turn right = left pushes, right pulls.
export function mix(input) {
  const m = input.magnitude;
  let left = (input.surge + input.yaw) * m;
  let right = (input.surge - input.yaw) * m;
  const big = Math.max(Math.abs(left), Math.abs(right), 1);
  left /= big;  // keep the ratio (the turn) instead of clipping one side
  right /= big;
  return { left, right, vert: clamp(input.heave * m, -1, 1) };
}

// One thruster: direction, balance and dead band, then the throttle limit.
export function shapeThruster(value, t, maxThrottle) {
  let v = clamp(value * t.gain, -1, 1);
  if (t.invert) v = -v;
  if (Math.abs(v) > 1e-3 && t.deadBand > 0) v = Math.sign(v) * (t.deadBand + Math.abs(v) * (1 - t.deadBand));
  return clamp(v * maxThrottle, -maxThrottle, maxThrottle);
}

export const THRUSTERS = ["left", "right", "vert"];

// THRUSTER TEST: one thruster only, at the pilot's throttle, through the same invert / gain / dead band, so after
// the config is right "L +" must push the ROV forward with the left motor.
export function testCommands(test, magnitude, cfg, maxThrottle) {
  const out = { left: 0, right: 0, vert: 0 };
  out[test.name] = shapeThruster(test.sign * magnitude, cfg.thrusters[test.name], maxThrottle);
  return out;
}

// PIN TEST: raw signal on ONE firmware output (GPIO 4 / 5 / 6), ignoring outputSlot, invert, gain and dead band -
// for checking the wiring itself. Returned as thruster commands so the ramp and toSlots() still apply.
export function pinTestCommands(pinTest, magnitude, outputSlot, maxThrottle) {
  const out = { left: 0, right: 0, vert: 0 };
  const name = THRUSTERS.find((k) => outputSlot[k] === pinTest.slot);
  if (name) out[name] = clamp(pinTest.sign * magnitude, -1, 1) * maxThrottle;
  return out;
}

export function thrusterCommands(input, cfg, maxThrottle) {
  if (input.pinTest) return pinTestCommands(input.pinTest, input.magnitude, cfg.outputSlot, maxThrottle);
  if (input.test) return testCommands(input.test, input.magnitude, cfg, maxThrottle);
  const raw = mix(input);
  return {
    left: shapeThruster(raw.left, cfg.thrusters.left, maxThrottle),
    right: shapeThruster(raw.right, cfg.thrusters.right, maxThrottle),
    vert: shapeThruster(raw.vert, cfg.thrusters.vert, maxThrottle),
  };
}

// outputSlot must use 0, 1, 2 exactly once, otherwise two thrusters would share an ESC
export function outputSlotProblem(outputSlot) {
  const used = THRUSTERS.map((k) => outputSlot[k]).sort();
  return used.join() === "0,1,2" ? null : `config outputSlot must use 0, 1, 2 once each (got ${used.join(", ")})`;
}

// thruster commands -> the three numbers of the D line, in firmware output order
export function toSlots(cmd, outputSlot) {
  const slots = [0, 0, 0];
  for (const k of THRUSTERS) slots[outputSlot[k]] = cmd[k];
  return slots;
}

// T line (firmware output order) -> [left, right, vert]
export function fromSlots(slots, outputSlot) {
  return THRUSTERS.map((k) => slots[outputSlot[k]]);
}

// Limits how fast each command changes (rampPerSec full-scale per second). Stop is NOT ramped.
export class Ramp {
  constructor(ratePerSec) {
    this.rate = ratePerSec;
    this.value = { left: 0, right: 0, vert: 0 };
  }

  step(target, dt) {
    const d = this.rate * dt;
    for (const k of ["left", "right", "vert"]) {
      this.value[k] += clamp(target[k] - this.value[k], -d, d);
    }
    return { ...this.value };
  }

  reset() { this.value = { left: 0, right: 0, vert: 0 }; }
}
