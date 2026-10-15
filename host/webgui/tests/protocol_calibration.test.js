import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLine } from '../js/protocol.js';
import {
  clearCalibration, defaultCalibration, loadCalibration, sanitize, saveCalibration,
} from '../js/calibration.js';

// ---- protocol ------------------------------------------------------------
test('parseLine: telemetry', () => {
  assert.deepEqual(parseLine('T 1550 1450 1600'), { kind: 'T', us: [1550, 1450, 1600] });
  assert.equal(parseLine('T 1550 1450').kind, 'other');
  assert.equal(parseLine('T 15x0 1450 1600').kind, 'other');
});

test('parseLine: PONG, W, N, B', () => {
  assert.deepEqual(parseLine('PONG'), { kind: 'PONG' });
  assert.deepEqual(parseLine('W watchdog: no command for 500 ms, thrusters neutral'),
    { kind: 'W', text: 'watchdog: no command for 500 ms, thrusters neutral' });
  assert.deepEqual(parseLine('N got: hello'), { kind: 'N', text: 'got: hello' });
  assert.deepEqual(parseLine('B serial /dev/cu.x connected'), { kind: 'B', text: 'serial /dev/cu.x connected' });
});

test('parseLine: boot banner lines', () => {
  assert.deepEqual(parseLine('ROV firmware 0.1.0'), { kind: 'banner', text: 'ROV firmware 0.1.0', boot: true });
  assert.equal(parseLine('ROV mode: LIVE').mode, 'LIVE');
  assert.equal(parseLine('ROV mode: DRY RUN (ESC pins held LOW, no pulses)').mode, 'DRY RUN');
  assert.equal(parseLine('ROV ready, accepting commands').ready, true);
  assert.equal(parseLine('ROV watchdog 500 ms').boot, undefined);
});

test('parseLine: readback report, live and dry run', () => {
  const live = parseLine('R left io1->io4: 1500us 50Hz sent 1500 ok | right io42->io5: 1450us 50Hz sent 1500 MISMATCH | vert io40->io6: no signal (LOW) sent 1500');
  assert.equal(live.kind, 'R');
  assert.equal(live.dry, false);
  assert.deepEqual(live.outputs.map((o) => [o.name, o.io, o.rb, o.state]),
    [['left', 1, 4, 'ok'], ['right', 42, 5, 'mismatch'], ['vert', 40, 6, 'nosignal']]);
  const dry = parseLine('R [DRY RUN] left io1->io4: no signal (LOW) sent 1500 | right io42->io5: stuck HIGH sent 1500 | vert io40->io6: measuring sent 1500');
  assert.equal(dry.dry, true);
  assert.deepEqual(dry.outputs.map((o) => o.state), ['nosignal', 'stuck', 'measuring']);
});

test('parseLine: anything else is just text', () => {
  assert.deepEqual(parseLine('ets Jun  8 2016 00:22:57'), { kind: 'other', text: 'ets Jun  8 2016 00:22:57' });
  assert.deepEqual(parseLine('  PONG \r'), { kind: 'PONG' });
});

// ---- calibration ---------------------------------------------------------
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

test('defaultCalibration copies config (editing it never mutates CONFIG)', () => {
  const a = defaultCalibration();
  a.thrusters.left.gain = 9;
  a.outputSlot.left = 2;
  const b = defaultCalibration();
  assert.equal(b.thrusters.left.gain, 1);
  assert.equal(b.outputSlot.left, 0);
});

test('sanitize: clamps gain and dead band, rejects junk, keeps good values', () => {
  const s = sanitize({
    outputSlot: { left: 2, right: 0, vert: 1 },
    thrusters: {
      left: { invert: true, gain: 5, deadBand: 0.9 },
      right: { invert: 'yes', gain: 'x', deadBand: -1 },
      vert: { invert: false, gain: 0.9, deadBand: 0.12 },
    },
  });
  assert.deepEqual(s.outputSlot, { left: 2, right: 0, vert: 1 });
  assert.deepEqual(s.thrusters.left, { invert: true, gain: 2, deadBand: 0.5 });
  assert.deepEqual(s.thrusters.right, { invert: false, gain: 1, deadBand: 0 });
  assert.deepEqual(s.thrusters.vert, { invert: false, gain: 0.9, deadBand: 0.12 });
});

test('sanitize: garbage input falls back to defaults', () => {
  for (const bad of [null, undefined, 5, 'x', [], { thrusters: 7 }, { outputSlot: { left: 9 } }]) {
    assert.deepEqual(sanitize(bad), defaultCalibration());
  }
});

test('sanitize: a duplicate outputSlot survives (ARM refuses it, the user sees why)', () => {
  const s = sanitize({ outputSlot: { left: 1, right: 1, vert: 2 } });
  assert.deepEqual(s.outputSlot, { left: 1, right: 1, vert: 2 });
});

test('save / load round trip, reset, and broken storage', () => {
  const st = fakeStorage();
  assert.deepEqual(loadCalibration(st), defaultCalibration());
  const cal = defaultCalibration();
  cal.thrusters.right.invert = true;
  cal.thrusters.right.deadBand = 0.11;
  assert.equal(saveCalibration(st, cal), true);
  assert.deepEqual(loadCalibration(st), cal);
  clearCalibration(st);
  assert.deepEqual(loadCalibration(st), defaultCalibration());

  assert.deepEqual(loadCalibration(fakeStorage({ 'rov.calibration.v1': '{not json' })), defaultCalibration());
  assert.deepEqual(loadCalibration(null), defaultCalibration());
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadCalibration(throwing), defaultCalibration());
  assert.equal(saveCalibration(throwing, cal), false);
});
