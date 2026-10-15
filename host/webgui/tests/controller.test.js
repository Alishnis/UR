import test from 'node:test';
import assert from 'node:assert/strict';

import { Controller } from '../js/controller.js';

const IDENTITY = { invert: false, gain: 1, deadBand: 0 };
const cal = (over = {}) => ({
  outputSlot: { left: 0, right: 1, vert: 2 },
  thrusters: { left: IDENTITY, right: IDENTITY, vert: IDENTITY },
  ...over,
});
const OPTS = {
  rampPerSec: 1.5,
  maxThrottle: 0.3,
  maxLimit: 0.6,
  testMaxMs: 5000,
  magnitude: { default: 1, min: 0.1, max: 1, ratePerSec: 0.5 },
};
const make = (c = cal(), o = {}) => new Controller(c, { ...OPTS, ...o });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const DT = 0.05;

function run(ctl, seconds) {
  let r;
  for (let t = 0; t < seconds - 1e-9; t += DT) r = ctl.step(DT);
  return r;
}

test('disarmed: always S and zeros, whatever keys are held', () => {
  const c = make();
  c.keyDown('KeyW');
  const r = c.step(DT);
  assert.equal(r.line, 'S');
  assert.deepEqual(r.slots, [0, 0, 0]);
  assert.equal(r.armed, false);
});

test('arm refused for a non-permutation outputSlot, accepted otherwise', () => {
  const bad = make(cal({ outputSlot: { left: 0, right: 0, vert: 2 } }));
  const r = bad.arm();
  assert.equal(r.ok, false);
  assert.match(r.reason, /outputSlot/);
  assert.equal(bad.armed, false);
  assert.equal(bad.step(DT).line, 'S');

  const good = make();
  assert.deepEqual(good.arm(), { ok: true });
  assert.equal(good.armed, true);
});

test('armed with no keys: D 0 0 0', () => {
  const c = make();
  c.arm();
  assert.equal(c.step(DT).line, 'D 0.000 0.000 0.000');
});

test('W ramps up to MAX in 0.2 s, never jumps', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  const first = c.step(DT);
  near(first.slots[0], 1.5 * DT); // 0.075, not 0.3
  assert.equal(first.line, 'D 0.075 0.075 0.000');
  const second = c.step(DT);
  near(second.slots[0], 0.15);
  const end = run(c, 0.5);
  assert.deepEqual(end.slots, [0.3, 0.3, 0]);
  assert.equal(end.line, 'D 0.300 0.300 0.000');
});

test('releasing the key ramps back to zero', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  run(c, 0.5);
  c.keyUp('KeyW');
  const r = c.step(DT);
  near(r.slots[0], 0.3 - 0.075);
  assert.deepEqual(run(c, 0.5).slots, [0, 0, 0]);
});

test('D yaws right: left forward, right backward; A the opposite', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyD');
  assert.deepEqual(run(c, 0.5).slots, [0.3, -0.3, 0]);
  c.keyUp('KeyD');
  c.keyDown('KeyA');
  assert.deepEqual(run(c, 1).slots, [-0.3, 0.3, 0]);
});

test('R / F heave on the vertical thruster', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyR');
  assert.deepEqual(run(c, 0.5).slots, [0, 0, 0.3]);
  c.keyUp('KeyR');
  c.keyDown('KeyF');
  assert.deepEqual(run(c, 1).slots, [0, 0, -0.3]);
});

test('opposite keys cancel', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  c.keyDown('KeyS');
  assert.deepEqual(run(c, 0.5).slots, [0, 0, 0]);
});

test('Space zeroes instantly, no ramp', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  run(c, 0.5);
  c.keyDown('Space');
  const r = c.step(DT);
  assert.deepEqual(r.slots, [0, 0, 0]);
  assert.equal(r.line, 'D 0.000 0.000 0.000');
  c.keyUp('Space');
  near(c.step(DT).slots[0], 0.075); // W still held: restarts through the ramp
});

test('E-STOP: disarmed, zero, keys cleared, next line is S', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  run(c, 0.5);
  c.estop();
  assert.equal(c.armed, false);
  assert.equal(c.step(DT).line, 'S');
  // re-arming starts from zero with no held keys
  c.arm();
  assert.equal(c.step(DT).line, 'D 0.000 0.000 0.000');
});

test('re-arm starts from zero even without E-STOP', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  run(c, 0.5);
  c.disarm();
  c.keyUp('KeyW');
  c.arm();
  assert.deepEqual(c.step(DT).slots, [0, 0, 0]);
});

test('MAX slider scales output and is limited to the slider limit', () => {
  const c = make();
  c.arm();
  c.setMaxThrottle(0.1);
  c.keyDown('KeyW');
  assert.deepEqual(run(c, 0.5).slots, [0.1, 0.1, 0]);
  c.setMaxThrottle(5);
  assert.equal(c.maxThrottle, 0.6);
  c.setMaxThrottle(-1);
  assert.equal(c.maxThrottle, 0);
  c.setMaxThrottle('abc');
  assert.equal(c.maxThrottle, 0);
});

test('J / K change magnitude smoothly within [min, max]', () => {
  const c = make();
  c.keyDown('KeyJ');
  c.step(1); // dt is capped at 0.1 s: 0.5/s * 0.1 = 0.05
  near(c.magnitude, 0.95);
  run(c, 5);
  near(c.magnitude, 0.1);
  c.keyUp('KeyJ');
  c.keyDown('KeyK');
  run(c, 10);
  near(c.magnitude, 1);
});

test('magnitude scales the command', () => {
  const c = make();
  c.arm();
  c.magnitude = 0.5;
  c.keyDown('KeyW');
  assert.deepEqual(run(c, 0.5).slots, [0.15, 0.15, 0]);
});

test('invert / gain / dead band from calibration reach the output slots', () => {
  const c = make(cal({
    thrusters: {
      left: { invert: true, gain: 1, deadBand: 0 },
      right: { invert: false, gain: 0.5, deadBand: 0 },
      vert: IDENTITY,
    },
  }));
  c.arm();
  c.keyDown('KeyW');
  assert.deepEqual(run(c, 0.5).slots, [-0.3, 0.15, 0]);
});

test('outputSlot reorders the line into firmware order', () => {
  const c = make(cal({ outputSlot: { left: 2, right: 0, vert: 1 } }));
  c.arm();
  c.keyDown('KeyW');
  assert.deepEqual(run(c, 0.5).slots, [0.3, 0, 0.3]); // right -> slot 0, left -> slot 2
  c.keyUp('KeyW');
  c.keyDown('KeyR');
  run(c, 1);
  assert.deepEqual(c.step(DT).slots, [0, 0.3, 0]); // vert -> slot 1
});

test('THRUSTER TEST works only while armed and drives one thruster', () => {
  const c = make();
  assert.equal(c.startThrusterTest('left', 1), false);
  assert.equal(c.test, null);
  c.arm();
  assert.equal(c.startThrusterTest('right', -1), true);
  assert.deepEqual(run(c, 0.5).slots, [0, -0.3, 0]);
  c.stopTest();
  assert.deepEqual(run(c, 0.5).slots, [0, 0, 0]);
});

test('THRUSTER TEST follows outputSlot and invert', () => {
  const c = make(cal({
    outputSlot: { left: 1, right: 0, vert: 2 },
    thrusters: { left: { invert: true, gain: 1, deadBand: 0 }, right: IDENTITY, vert: IDENTITY },
  }));
  c.arm();
  c.startThrusterTest('left', 1);
  assert.deepEqual(run(c, 0.5).slots, [0, -0.3, 0]);
});

test('PIN TEST is raw: ignores outputSlot, invert, gain and dead band', () => {
  const c = make(cal({
    outputSlot: { left: 2, right: 0, vert: 1 },
    thrusters: {
      left: { invert: true, gain: 0.5, deadBand: 0.3 },
      right: { invert: true, gain: 0.5, deadBand: 0.3 },
      vert: { invert: true, gain: 0.5, deadBand: 0.3 },
    },
  }));
  assert.equal(c.startPinTest(1, 1), false); // not armed
  c.arm();
  assert.equal(c.startPinTest(1, 1), true);
  assert.deepEqual(run(c, 0.5).slots, [0, 0.3, 0]);
  c.startPinTest(2, -1);
  assert.deepEqual(run(c, 1.5).slots, [0, 0, -0.3]);
});

test('PIN TEST uses the MAX slider value as the raw value', () => {
  const c = make();
  c.arm();
  c.setMaxThrottle(0.12);
  c.startPinTest(0, 1);
  assert.deepEqual(run(c, 0.5).slots, [0.12, 0, 0]);
});

test('test stops by itself after testMaxMs (stuck button protection)', () => {
  const c = make(cal(), { testMaxMs: 1000 });
  c.arm();
  c.startPinTest(0, 1);
  run(c, 0.9);
  assert.notEqual(c.test, null);
  run(c, 0.3);
  assert.equal(c.test, null);
  assert.deepEqual(run(c, 0.5).slots, [0, 0, 0]);
});

test('clearKeys (window blur) also stops a running test', () => {
  const c = make();
  c.arm();
  c.startPinTest(0, 1);
  c.keyDown('KeyW');
  c.clearKeys();
  assert.equal(c.test, null);
  assert.equal(c.keys.size, 0);
  assert.deepEqual(run(c, 0.5).slots, [0, 0, 0]);
});

test('Space stops a test instantly too', () => {
  const c = make();
  c.arm();
  c.startPinTest(0, 1);
  run(c, 0.5);
  c.keyDown('Space');
  assert.deepEqual(c.step(DT).slots, [0, 0, 0]);
});

test('calibration cannot change while armed', () => {
  const c = make();
  c.arm();
  assert.equal(c.setCalibration(cal({ outputSlot: { left: 1, right: 0, vert: 2 } })), false);
  assert.deepEqual(c.cal.outputSlot, { left: 0, right: 1, vert: 2 });
  c.disarm();
  assert.equal(c.setCalibration(cal({ outputSlot: { left: 1, right: 0, vert: 2 } })), true);
  assert.deepEqual(c.cal.outputSlot, { left: 1, right: 0, vert: 2 });
});

test('a stalled page (huge dt) cannot produce a big ramp step', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  const r = c.step(10);
  near(r.slots[0], 1.5 * 0.1); // dt capped at 0.1 s
});

test('every line the controller emits matches the protocol grammar', () => {
  const c = make();
  c.arm();
  const codes = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyR', 'KeyF', 'KeyJ', 'KeyK', 'Space'];
  for (let i = 0; i < 3000; i++) {
    const code = codes[Math.floor(Math.random() * codes.length)];
    if (Math.random() < 0.5) c.keyDown(code); else c.keyUp(code);
    if (i % 400 === 0) c.startPinTest(i % 3, 1);
    if (i % 400 === 200) c.stopTest();
    const { line } = c.step(DT);
    assert.match(line, /^D -?\d\.\d{3} -?\d\.\d{3} -?\d\.\d{3}$/);
    for (const x of line.split(' ').slice(1)) assert.ok(Math.abs(Number(x)) <= 0.3 + 1e-9);
  }
});
