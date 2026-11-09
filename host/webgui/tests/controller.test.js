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

test('Space: a tap shorter than one tick still brakes (Hold and Throttle)', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW');
  run(c, 0.5);
  c.keyDown('Space');
  c.keyUp('Space');                                    // released before the next step
  assert.deepEqual(c.step(DT).slots, [0, 0, 0]);
  near(c.step(DT).slots[0], 0.075);                    // W still held: ramps up again, as after a held Space
  const l = latch();
  l.arm();
  for (let i = 0; i < 4; i++) press(l, 'KeyW');
  run(l, 1);
  press(l, 'Space');
  assert.equal(l.step(DT).line, 'D 0.000 0.000 0.000');
  near(l.lever.surge, 0);
  assert.equal(run(l, 1).line, 'D 0.000 0.000 0.000');
  const d = make();                                     // disarmed: a tap does nothing and is not remembered
  press(d, 'Space');
  d.arm();
  d.keyDown('KeyW');
  assert.ok(run(d, 0.5).slots[0] > 0);
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

// ---- Throttle mode (driveMode 'latch'): keys move a level gradually and it stays ----------------

const LV = 7;
const latch = (o = {}) => make(cal(), { driveMode: 'latch', levels: LV, repeatDelaySec: 0.5, repeatPerSec: 4, ...o });
const press = (c, code) => { c.keyDown(code); c.keyUp(code); };

test('latch: one press is one level, and the level stays after release', () => {
  const c = latch();
  c.arm();
  press(c, 'KeyW');                // a tap shorter than one tick still counts
  near(c.lever.surge, 1 / LV);
  press(c, 'KeyW');
  press(c, 'KeyW');
  near(c.lever.surge, 3 / LV);
  const r = run(c, 1);             // nothing pressed: the level must not decay
  near(c.lever.surge, 3 / LV);
  near(r.slots[0], (3 / LV) * 0.3, 1e-6); // level 3 of 7 of the MAX throttle (0.3)
  near(r.slots[1], (3 / LV) * 0.3, 1e-6);
});

test('latch: the levels are whole steps, never in between', () => {
  const c = latch();
  c.arm();
  c.keyDown('KeyW');
  run(c, 1.3);                     // a held key: the first step, then repeats
  c.keyUp('KeyW');
  assert.ok(Number.isInteger(Math.round(c.lever.surge * LV * 1e6) / 1e6), `${c.lever.surge}`);
  near(c.lever.surge * LV, Math.round(c.lever.surge * LV), 1e-9);
});

test('latch: a held key waits repeatDelay, then steps repeatPerSec times a second', () => {
  const c = latch();
  c.arm();
  c.keyDown('KeyW');
  near(c.lever.surge * LV, 1);
  run(c, 0.4);
  near(c.lever.surge * LV, 1);     // still inside the delay
  run(c, 0.2);                     // 0.6 s: first repeat at 0.5 s
  near(c.lever.surge * LV, 2);
  run(c, 0.5);                     // 1.1 s: repeats at 0.75 and 1.0
  near(c.lever.surge * LV, 4);
});

test('latch: the opposite key lowers the level, through zero into reverse', () => {
  const c = latch();
  c.arm();
  for (let i = 0; i < 3; i++) press(c, 'KeyW');
  for (let i = 0; i < 5; i++) press(c, 'KeyS');
  near(c.lever.surge, -2 / LV);
  assert.ok(run(c, 1).slots[0] < 0);
});

test('latch: the level never leaves -levels..levels', () => {
  const c = latch();
  c.arm();
  for (let i = 0; i < 20; i++) press(c, 'KeyR');
  near(c.lever.heave, 1);
  for (let i = 0; i < 30; i++) press(c, 'KeyF');
  near(c.lever.heave, -1);
});

test('latch: opposite keys together cancel, axes are independent', () => {
  const c = latch();
  c.arm();
  c.keyDown('KeyW');
  c.keyDown('KeyS');
  near(c.lever.surge, 0);
  c.keyUp('KeyW');
  c.keyUp('KeyS');
  press(c, 'KeyW');
  press(c, 'KeyD');
  near(c.lever.surge, 1 / LV);
  near(c.lever.yaw, 1 / LV);
  near(c.lever.heave, 0);
});

test('latch: Space zeroes the levels and the output at once', () => {
  const c = latch();
  c.arm();
  for (let i = 0; i < 4; i++) press(c, 'KeyW');
  run(c, 1);
  c.keyDown('Space');
  const r = c.step(DT);
  assert.equal(r.line, 'D 0.000 0.000 0.000');
  c.keyUp('Space');
  near(c.lever.surge, 0);
  assert.equal(run(c, 1).line, 'D 0.000 0.000 0.000');   // and it stays at zero
});

test('latch: disarm, E-STOP, re-arm and lost focus all reset the levels', () => {
  for (const reset of [(c) => c.disarm(), (c) => c.estop(), (c) => c.clearKeys()]) {
    const c = latch();
    c.arm();
    c.keyDown('KeyW');
    run(c, 1);
    c.keyUp('KeyW');
    assert.ok(c.lever.surge > 0);
    reset(c);
    near(c.lever.surge, 0);
  }
  const c = latch();
  c.arm();
  c.keyDown('KeyW');
  run(c, 1);
  c.keyUp('KeyW');
  c.disarm();
  c.arm();
  near(c.lever.surge, 0);
  assert.equal(c.step(DT).line, 'D 0.000 0.000 0.000');
});

test('latch: while disarmed the keys change nothing', () => {
  const c = latch();
  c.keyDown('KeyW');
  run(c, 1);
  near(c.lever.surge, 0);
  assert.equal(c.step(DT).line, 'S');
});

test('latch: the output still ramps (no jump) and a running thruster test freezes the levels', () => {
  const c = latch({ levels: 1 });            // one press = full, so the ramp is the only limit
  c.arm();
  c.keyDown('KeyW');
  const first = c.step(DT);
  assert.ok(first.slots[0] > 0 && first.slots[0] <= 1.5 * DT + 1e-9);
  c.keyUp('KeyW');
  c.startThrusterTest('left', +1);
  const before = c.lever.surge;
  c.keyDown('KeyW');
  run(c, 0.5);
  near(c.lever.surge, before);               // a test owns the output: the lever does not move
});

test('latch: MAX throttle still scales the result and magnitude still applies', () => {
  const c = latch();
  c.arm();
  for (let i = 0; i < LV; i++) press(c, 'KeyW'); // top level
  near(c.lever.surge, 1);
  c.setMaxThrottle(0.2);
  assert.equal(run(c, 2).line, 'D 0.200 0.200 0.000');
  c.keyDown('KeyJ');
  run(c, 1);                                  // magnitude 1.0 -> 0.5
  c.keyUp('KeyJ');
  assert.equal(run(c, 2).line, 'D 0.100 0.100 0.000');
});

test('setDriveMode: only latch or hold, refused while armed, clears the levels, axes() follows the mode', () => {
  const c = latch();
  assert.equal(c.setDriveMode('turbo'), false);
  assert.equal(c.driveMode, 'latch');
  c.arm();
  for (let i = 0; i < 3; i++) press(c, 'KeyW');
  near(c.axes().surge, 3 / LV);
  assert.equal(c.axes().yaw, 0);
  assert.equal(c.setDriveMode('hold'), false);   // armed
  c.disarm();
  assert.equal(c.setDriveMode('hold'), true);
  near(c.lever.surge, 0);
  c.keyDown('KeyD');
  assert.deepEqual(c.axes(), { surge: 0, yaw: 1, heave: 0 });   // hold: straight from the keys
});

test('hold mode is the default and is unchanged: full on press, stop on release', () => {
  const c = make();
  assert.equal(c.driveMode, 'hold');
  c.arm();
  c.keyDown('KeyW');
  assert.equal(run(c, 1).line, 'D 0.300 0.300 0.000');
  c.keyUp('KeyW');
  assert.equal(run(c, 1).line, 'D 0.000 0.000 0.000');
});

// -- single-thruster buttons (Left / Right / Up, Reverse toggle): buttons only, no keyboard key -----------------------------------
test('hold: the Left button drives only the left thruster, Right only the right, Up only the vertical one', () => {
  for (const [code, want] of [['BtnThrLeft', [0.3, 0, 0]], ['BtnThrRight', [0, 0.3, 0]], ['BtnThrVert', [0, 0, 0.3]]]) {
    const c = make();
    c.arm();
    c.keyDown(code);
    assert.deepEqual(run(c, 0.5).slots, want, code);
    c.keyUp(code);
    assert.deepEqual(run(c, 1).slots, [0, 0, 0], `${code} released`);
  }
});

test('hold: Reverse on makes a thruster button push backwards', () => {
  const c = make();
  c.arm();
  c.keyDown('BtnThrReverse');
  c.keyDown('BtnThrLeft');
  assert.deepEqual(run(c, 0.5).slots, [-0.3, 0, 0]);
});

test('hold: a thruster key adds to the six-direction command and never exceeds full', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyW'); // left = right = 1
  c.keyDown('BtnThrLeft'); // left would be 2 -> clamped to 1
  assert.deepEqual(run(c, 1).slots, [0.3, 0.3, 0]);
});

test('latch: a thruster button steps its level, it stays after release, with Reverse on it steps down', () => {
  const c = latch();
  c.arm();
  press(c, 'BtnThrRight');
  press(c, 'BtnThrRight');
  near(c.direct.right, 2 / LV);
  run(c, 2);
  near(c.direct.right, 2 / LV);
  assert.ok(c.step(DT).slots[1] > 0, 'the right thruster keeps running');
  assert.equal(c.direct.left, 0);
  c.keyDown('BtnThrReverse');
  press(c, 'BtnThrRight');
  press(c, 'BtnThrRight');
  press(c, 'BtnThrRight');
  near(c.direct.right, -1 / LV);
});

test('latch: Space and DISARM clear the thruster levels', () => {
  const c = latch();
  c.arm();
  press(c, 'BtnThrVert');
  near(c.direct.vert, 1 / LV);
  c.keyDown('Space');
  c.step(DT);
  near(c.direct.vert, 0);
  c.keyUp('Space');
  press(c, 'BtnThrLeft');
  near(c.direct.left, 1 / LV);
  c.disarm();
  near(c.direct.left, 0);
});

test('latch: levels option - 3 levels means thirds, one press at a time', () => {
  const c = latch({ levels: 3 });
  c.arm();
  press(c, 'KeyW');
  near(c.lever.surge, 1 / 3);
  press(c, 'KeyW');
  press(c, 'KeyW');
  press(c, 'KeyW');
  near(c.lever.surge, 1);
});

test('latch: a key already down when arming does nothing until it is pressed again', () => {
  const c = latch();
  c.keyDown('KeyW');
  c.arm();
  run(c, 2);
  near(c.lever.surge, 0);
  c.keyUp('KeyW');
  press(c, 'KeyW');
  near(c.lever.surge, 1 / LV);
});

test('the keyboard cannot reach a single thruster: R is Up (heave), there are no thruster keys', () => {
  const c = make();
  c.arm();
  c.keyDown('KeyR');
  assert.deepEqual(run(c, 0.5).slots, [0, 0, 0.3]); // vertical thruster only, as heave
  c.keyUp('KeyR');
  for (const code of ['KeyL', 'KeyU', 'ShiftLeft', 'ShiftRight']) c.keyDown(code);
  assert.deepEqual(run(c, 1).slots, [0, 0, 0]);
});
