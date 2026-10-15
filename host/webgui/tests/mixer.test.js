import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDeadBand, calibrate, encodeD, formatValue, fromSlots, isPermutation, mix,
  pinTestSlots, rampToward, thrusterTestSlots, toSlots, toTargets,
} from '../js/mixer.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const IDENTITY = { invert: false, gain: 1, deadBand: 0 };
const NEUTRAL_CAL = { left: IDENTITY, right: IDENTITY, vert: IDENTITY };

test('mix: surge only drives both horizontals equally, vert untouched', () => {
  assert.deepEqual(mix({ surge: 1 }), { left: 1, right: 1, vert: 0 });
  assert.deepEqual(mix({ surge: -0.5 }), { left: -0.5, right: -0.5, vert: 0 });
});

test('mix: yaw only turns the horizontals against each other', () => {
  assert.deepEqual(mix({ yaw: 1 }), { left: 1, right: -1, vert: 0 });
  assert.deepEqual(mix({ yaw: -1 }), { left: -1, right: 1, vert: 0 });
});

test('mix: heave only drives the vertical', () => {
  assert.deepEqual(mix({ heave: 1 }), { left: 0, right: 0, vert: 1 });
  assert.deepEqual(mix({ heave: -1 }), { left: 0, right: 0, vert: -1 });
});

test('mix: normalises when surge + yaw exceed 1, keeping the ratio', () => {
  const r = mix({ surge: 1, yaw: 1 });
  assert.deepEqual(r, { left: 1, right: 0, vert: 0 });
  const r2 = mix({ surge: 1, yaw: 0.5 });
  assert.deepEqual(r2, { left: 1, right: 1 / 3, vert: 0 });
  const r3 = mix({ surge: -1, yaw: 1 });
  assert.deepEqual(r3, { left: 0, right: -1, vert: 0 });
});

test('mix: never exceeds 1 for any axis combination', () => {
  for (const surge of [-1, 0, 1]) {
    for (const yaw of [-1, 0, 1]) {
      for (const heave of [-1, 0, 1]) {
        const r = mix({ surge, yaw, heave });
        for (const v of Object.values(r)) assert.ok(Math.abs(v) <= 1);
      }
    }
  }
});

test('mix: magnitude scales everything, vert included', () => {
  const r = mix({ surge: 1, heave: -1 }, 0.5);
  assert.deepEqual(r, { left: 0.5, right: 0.5, vert: -0.5 });
  // normalisation happens before magnitude
  assert.deepEqual(mix({ surge: 1, yaw: 1 }, 0.5), { left: 0.5, right: 0, vert: 0 });
});

test('mix: no keys gives exact zeros', () => {
  assert.deepEqual(mix({}), { left: 0, right: 0, vert: 0 });
});

test('applyDeadBand: zero stays zero, nonzero jumps to the dead band', () => {
  assert.equal(applyDeadBand(0, 0.2), 0);
  near(applyDeadBand(1, 0.2), 1);
  near(applyDeadBand(-1, 0.2), -1);
  near(applyDeadBand(0.5, 0.2), 0.2 + 0.5 * 0.8);
  near(applyDeadBand(-0.5, 0.2), -(0.2 + 0.5 * 0.8));
  near(applyDeadBand(0.001, 0.2), 0.2 + 0.001 * 0.8);
  assert.equal(applyDeadBand(0.5, 0), 0.5);
});

test('calibrate: invert flips the sign', () => {
  assert.equal(calibrate(0.5, { ...IDENTITY, invert: true }), -0.5);
  assert.equal(calibrate(-0.5, { ...IDENTITY, invert: true }), 0.5);
});

test('calibrate: gain scales, then clamps to -1..1', () => {
  near(calibrate(0.5, { ...IDENTITY, gain: 0.8 }), 0.4);
  assert.equal(calibrate(1, { ...IDENTITY, gain: 1.5 }), 1);
  assert.equal(calibrate(-1, { ...IDENTITY, gain: 1.5 }), -1);
});

test('calibrate: order is invert, gain, dead band, clamp', () => {
  // v=0.5 -> invert -0.5 -> gain 0.5 -> -0.25 -> deadBand 0.2: -(0.2 + 0.25*0.8) = -0.4
  near(calibrate(0.5, { invert: true, gain: 0.5, deadBand: 0.2 }), -0.4);
});

test('calibrate: zero input stays exactly zero (no -0, no dead band jump)', () => {
  const c = calibrate(0, { invert: true, gain: 1, deadBand: 0.3 });
  assert.ok(Object.is(c, 0), 'must be +0');
});

test('toTargets: multiplies by the MAX throttle after calibration', () => {
  const t = toTargets({ left: 1, right: -1, vert: 0.5 }, NEUTRAL_CAL, 0.3);
  near(t.left, 0.3);
  near(t.right, -0.3);
  near(t.vert, 0.15);
});

test('toTargets: dead band applies before MAX (full key = MAX exactly)', () => {
  const cal = { ...NEUTRAL_CAL, left: { ...IDENTITY, deadBand: 0.2 } };
  const t = toTargets({ left: 1, right: 0, vert: 0 }, cal, 0.3);
  near(t.left, 0.3);
  near(t.right, 0);
});

test('isPermutation', () => {
  assert.ok(isPermutation({ left: 0, right: 1, vert: 2 }));
  assert.ok(isPermutation({ left: 2, right: 0, vert: 1 }));
  assert.ok(!isPermutation({ left: 0, right: 0, vert: 2 }));
  assert.ok(!isPermutation({ left: 0, right: 1, vert: 3 }));
  assert.ok(!isPermutation({ left: 0, right: 1, vert: -1 }));
  assert.ok(!isPermutation({ left: 0, right: 1.5, vert: 2 }));
  assert.ok(!isPermutation({ left: '0', right: 1, vert: 2 }));
  assert.ok(!isPermutation({ left: 0, right: 1 }));
  assert.ok(!isPermutation(null));
  assert.ok(!isPermutation(undefined));
});

test('toSlots / fromSlots: identity mapping', () => {
  const slot = { left: 0, right: 1, vert: 2 };
  assert.deepEqual(toSlots({ left: 0.1, right: 0.2, vert: 0.3 }, slot), [0.1, 0.2, 0.3]);
  assert.deepEqual(fromSlots([0.1, 0.2, 0.3], slot), { left: 0.1, right: 0.2, vert: 0.3 });
});

test('toSlots / fromSlots: swapped mapping and round trip for all 6 permutations', () => {
  assert.deepEqual(toSlots({ left: 0.1, right: 0.2, vert: 0.3 }, { left: 2, right: 0, vert: 1 }), [0.2, 0.3, 0.1]);
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const [l, r, v] of perms) {
    const slot = { left: l, right: r, vert: v };
    const logical = { left: 0.11, right: 0.22, vert: 0.33 };
    assert.deepEqual(fromSlots(toSlots(logical, slot), slot), logical);
  }
});

test('toSlots / fromSlots throw on a bad mapping (never guess)', () => {
  const bad = { left: 0, right: 0, vert: 2 };
  assert.throws(() => toSlots({ left: 0, right: 0, vert: 0 }, bad));
  assert.throws(() => fromSlots([0, 0, 0], bad));
});

test('rampToward: limited step in both directions, lands exactly on target', () => {
  near(rampToward(0, 0.3, 0.075), 0.075);
  near(rampToward(0.075, 0.3, 0.075), 0.15);
  assert.equal(rampToward(0.28, 0.3, 0.075), 0.3);
  near(rampToward(0.3, 0, 0.1), 0.2);
  assert.equal(rampToward(0.05, 0, 0.1), 0);
  near(rampToward(0.1, -0.3, 0.1), 0);
  assert.equal(rampToward(0.2, 0.2, 0.1), 0.2);
});

test('formatValue: 3 decimals, clamps, never -0.000, survives NaN', () => {
  assert.equal(formatValue(0.1), '0.100');
  assert.equal(formatValue(-0.25), '-0.250');
  assert.equal(formatValue(1), '1.000');
  assert.equal(formatValue(2), '1.000');
  assert.equal(formatValue(-5), '-1.000');
  assert.equal(formatValue(-0.0001), '0.000');
  assert.equal(formatValue(-0), '0.000');
  assert.equal(formatValue(NaN), '0.000');
  assert.equal(formatValue(Infinity), '0.000');
});

test('encodeD produces the exact protocol line', () => {
  assert.equal(encodeD([0.1, -0.1, 0.2]), 'D 0.100 -0.100 0.200');
  assert.equal(encodeD([0, 0, 0]), 'D 0.000 0.000 0.000');
  assert.throws(() => encodeD([0, 0]));
});

test('encodeD output always matches the firmware number grammar', () => {
  const grammar = /^D (-?\d\.\d{3}) (-?\d\.\d{3}) (-?\d\.\d{3})$/;
  for (let i = 0; i < 2000; i++) {
    const v = [Math.random() * 3 - 1.5, Math.random() * 3 - 1.5, Math.random() * 3 - 1.5];
    const m = grammar.exec(encodeD(v));
    assert.ok(m, encodeD(v));
    for (const x of m.slice(1)) assert.ok(Math.abs(Number(x)) <= 1);
  }
});

test('PIN TEST: raw value on exactly one slot, ignoring everything else', () => {
  assert.deepEqual(pinTestSlots(0, 0.3), [0.3, 0, 0]);
  assert.deepEqual(pinTestSlots(1, -0.3), [0, -0.3, 0]);
  assert.deepEqual(pinTestSlots(2, 0.2), [0, 0, 0.2]);
  assert.throws(() => pinTestSlots(3, 0.1));
  assert.throws(() => pinTestSlots(-1, 0.1));
  assert.throws(() => pinTestSlots(1.5, 0.1));
});

test('THRUSTER TEST: goes through outputSlot', () => {
  const ctx = {
    outputSlot: { left: 2, right: 0, vert: 1 },
    thrusters: NEUTRAL_CAL,
    maxThrottle: 0.3,
  };
  assert.deepEqual(thrusterTestSlots('left', 1, ctx), [0, 0, 0.3]);
  assert.deepEqual(thrusterTestSlots('right', 1, ctx), [0.3, 0, 0]);
  assert.deepEqual(thrusterTestSlots('vert', -1, ctx), [0, -0.3, 0]);
});

test('THRUSTER TEST: invert flips direction, gain and dead band apply, others stay zero', () => {
  const ctx = {
    outputSlot: { left: 0, right: 1, vert: 2 },
    thrusters: {
      left: { invert: true, gain: 1, deadBand: 0 },
      right: { invert: false, gain: 0.5, deadBand: 0 },
      vert: { invert: false, gain: 1, deadBand: 0.2 },
    },
    maxThrottle: 0.3,
  };
  const l = thrusterTestSlots('left', 1, ctx);
  near(l[0], -0.3);
  assert.equal(l[1], 0);
  assert.equal(l[2], 0);
  near(thrusterTestSlots('right', 1, ctx)[1], 0.15);
  near(thrusterTestSlots('vert', 1, ctx)[2], 0.3); // dead band maps full key to full key
});

test('THRUSTER TEST rejects unknown names', () => {
  assert.throws(() => thrusterTestSlots('port', 1, {
    outputSlot: { left: 0, right: 1, vert: 2 }, thrusters: NEUTRAL_CAL, maxThrottle: 0.3,
  }));
});
