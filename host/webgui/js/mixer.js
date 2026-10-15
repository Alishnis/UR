// Mixer: pure functions, no DOM, no timers. Unit-tested in tests/mixer.test.js.
//
// Logical thrusters: left, right (horizontal: surge + yaw), vert (heave).
// Firmware outputs ("slots"): index 0, 1, 2 in ESC_PINS order.
// outputSlot maps logical -> slot and can be changed without reflashing.

export const NAMES = ['left', 'right', 'vert'];

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// surge/yaw/heave in -1..1, magnitude 0..1 -> logical values left/right/vert.
//   left  = surge + yaw
//   right = surge - yaw
//   if max(|left|, |right|) > 1, divide both by it
//   left, right *= magnitude;  vert = heave * magnitude
export function mix({ surge = 0, yaw = 0, heave = 0 }, magnitude = 1) {
  let left = surge + yaw;
  let right = surge - yaw;
  const peak = Math.max(Math.abs(left), Math.abs(right));
  if (peak > 1) {
    left /= peak;
    right /= peak;
  }
  return {
    left: left * magnitude,
    right: right * magnitude,
    vert: heave * magnitude,
  };
}

// Dead band: v' = sign(v) * (deadBand + |v| * (1 - deadBand)) for nonzero v.
export function applyDeadBand(v, deadBand) {
  if (v === 0) return 0;
  return Math.sign(v) * (deadBand + Math.abs(v) * (1 - deadBand));
}

// One thruster, in this order: invert -> gain -> deadBand -> clamp -1..1.
export function calibrate(v, { invert = false, gain = 1, deadBand = 0 } = {}) {
  let x = invert ? -v : v;
  x *= gain;
  x = applyDeadBand(x, deadBand);
  return clamp(x, -1, 1);
}

// Logical commands -> calibrated, scaled to the MAX throttle (still logical order).
export function toTargets(logical, thrusters, maxThrottle) {
  const out = {};
  for (const n of NAMES) {
    out[n] = calibrate(logical[n], thrusters[n]) * maxThrottle;
  }
  return out;
}

// True if outputSlot assigns each of 0, 1, 2 to exactly one logical thruster.
export function isPermutation(outputSlot) {
  if (!outputSlot) return false;
  const used = new Set();
  for (const n of NAMES) {
    const s = outputSlot[n];
    if (!Number.isInteger(s) || s < 0 || s > 2) return false;
    used.add(s);
  }
  return used.size === 3;
}

// {left,right,vert} -> [slot0, slot1, slot2] (firmware order).
export function toSlots(values, outputSlot) {
  if (!isPermutation(outputSlot)) throw new Error('outputSlot is not a permutation of 0, 1, 2');
  const slots = [0, 0, 0];
  for (const n of NAMES) slots[outputSlot[n]] = values[n];
  return slots;
}

// [slot0, slot1, slot2] -> {left,right,vert}. Inverse of toSlots.
export function fromSlots(slots, outputSlot) {
  if (!isPermutation(outputSlot)) throw new Error('outputSlot is not a permutation of 0, 1, 2');
  const out = {};
  for (const n of NAMES) out[n] = slots[outputSlot[n]];
  return out;
}

// Move current toward target by at most maxStep.
export function rampToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

// Value for the D line: 3 decimals, clamped to -1..1, never "-0.000".
export function formatValue(v) {
  const s = clamp(Number.isFinite(v) ? v : 0, -1, 1).toFixed(3);
  return s === '-0.000' ? '0.000' : s;
}

// Firmware-order values -> "D a b c".
export function encodeD(slots) {
  if (slots.length !== 3) throw new Error('encodeD needs exactly 3 values');
  return `D ${formatValue(slots[0])} ${formatValue(slots[1])} ${formatValue(slots[2])}`;
}

// PIN TEST: raw value on ONE firmware output, others neutral.
// Ignores outputSlot, invert, gain and dead band.
export function pinTestSlots(slot, value) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw new Error('slot must be 0, 1 or 2');
  const slots = [0, 0, 0];
  slots[slot] = value;
  return slots;
}

// THRUSTER TEST: ONE logical thruster at `level` (-1..1), through the same
// pipeline as driving (outputSlot, invert, gain, dead band), scaled to MAX throttle.
export function thrusterTestSlots(name, level, { outputSlot, thrusters, maxThrottle }) {
  if (!NAMES.includes(name)) throw new Error(`unknown thruster ${name}`);
  const logical = { left: 0, right: 0, vert: 0 };
  logical[name] = level;
  return toSlots(toTargets(logical, thrusters, maxThrottle), outputSlot);
}
