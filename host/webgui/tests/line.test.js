import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkpointLabel, checkpointsAdjust, checkpointsInitial, checkpointsReset, checkpointsUpdate, loadLine, tapesTotal,
  saveLine, steerView,
} from '../js/line.js';

const CFG = { steerDead: 0.08, angleGain: 1 / 45, offsetGain: 1 };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('steerView: on the line', () => {
  const v = steerView({ offset: 0, angleDeg: 0 }, CFG);
  assert.deepEqual([v.text, v.kind, v.steer, v.lost], ['ON LINE', 'ok', 0, false]);
  assert.equal(steerView({ offset: 0.05, angleDeg: 1 }, CFG).text, 'ON LINE'); // 0.072 < dead band
  assert.equal(steerView({ offset: 0.08, angleDeg: 0 }, CFG).text, 'ON LINE'); // exactly at the dead band
});

test('steerView: offset and angle both steer, + = yaw right', () => {
  let v = steerView({ offset: 0.3, angleDeg: 0 }, CFG);
  assert.deepEqual([v.text, v.kind, v.side], ['YAW RIGHT', 'warn', 'right']);
  assert.ok(close(v.steer, 0.3));
  v = steerView({ offset: 0, angleDeg: -9 }, CFG);
  assert.equal(v.text, 'YAW LEFT');
  assert.ok(close(v.steer, -0.2));
  v = steerView({ offset: -0.2, angleDeg: 18 }, CFG); // they cancel: line left of centre but leaning right
  assert.ok(close(v.steer, 0.2));
  assert.equal(v.text, 'YAW RIGHT');
  assert.equal(v.side, 'left');
});

test('steerView: clamped to -1..1, gains and defaults', () => {
  assert.equal(steerView({ offset: 2, angleDeg: 45 }, CFG).steer, 1);
  assert.equal(steerView({ offset: -2, angleDeg: -90 }, CFG).steer, -1);
  assert.ok(close(steerView({ offset: 0.1, angleDeg: 0 }, { ...CFG, offsetGain: 3 }).steer, 0.3));
  assert.ok(close(steerView({ offset: 0, angleDeg: 10 }, { ...CFG, angleGain: 0.05 }).steer, 0.5));
  assert.ok(close(steerView({ offset: 0, angleDeg: 9 }).steer, 0.2)); // defaults 0.08, 1/45, 1
  assert.equal(steerView({ offset: 0, angleDeg: 3 }, null).text, 'ON LINE');
  assert.equal(steerView({ offset: 0.1, angleDeg: 0 }, { steerDead: 0.2 }).text, 'ON LINE');
  assert.equal(steerView({ offset: 'x', angleDeg: null }, CFG).text, 'ON LINE'); // junk numbers = 0
});

test('steerView: line lost, with the side where it was last seen', () => {
  let v = steerView(null, CFG);
  assert.deepEqual([v.text, v.kind, v.steer, v.lost], ['LINE LOST', 'bad', 0, true]);
  v = steerView(null, CFG, 'left');
  assert.equal(v.text, 'LINE LOST · last seen LEFT');
  assert.equal(v.side, 'left');
  assert.equal(steerView(null, { ...CFG, lastSide: 'right' }).text, 'LINE LOST · last seen RIGHT');
  assert.equal(steerView(null, CFG, 'up').text, 'LINE LOST');
  assert.equal(steerView(null, CFG, 'up').side, null);
  // the side is remembered while the line is visible, then used when it is lost
  const seen = steerView({ offset: -0.5, angleDeg: 0 }, CFG);
  assert.match(steerView(null, CFG, seen.side).text, /LEFT/);
  assert.equal(steerView({ offset: 0, angleDeg: 0 }, CFG, 'right').side, 'right'); // centred: keep the old side
});

const TRIG = { triggerRow: 0.85, debounceMs: 1500, total: 3 };

// Runs a list of [tapes, timeMs] updates.
function run(state, steps, cfg = TRIG) {
  for (const [tapes, t] of steps) state = checkpointsUpdate(state, tapes, t, cfg);
  return state;
}

test('checkpointsInitial', () => {
  assert.deepEqual(checkpointsInitial(), { count: 0, tapesY: [], lastCountMs: -Infinity, auto: true });
});

test('checkpoints: a tape moving down across the trigger row counts once', () => {
  const s0 = checkpointsInitial();
  let s = run(s0, [[[0.5], 0], [[0.7], 100], [[0.84], 200]]);
  assert.equal(s.count, 0);
  s = checkpointsUpdate(s, [0.86], 300, TRIG);
  assert.equal(s.count, 1);
  assert.equal(s.lastCountMs, 300);
  s = run(s, [[[0.95], 400], [[], 500]]); // leaves the image
  assert.equal(s.count, 1);
  assert.deepEqual(s0, checkpointsInitial()); // pure
});

test('checkpoints: landing exactly on the trigger row counts', () => {
  assert.equal(run(checkpointsInitial(), [[[0.8], 0], [[0.85], 100]]).count, 1);
});

test('checkpoints: debounce', () => {
  // two tapes cross 0.9 s apart (faster than the ROV can go 50 cm): only the first counts
  let s = run(checkpointsInitial(), [[[0.5, 0.8], 0], [[0.55, 0.86], 100]]);
  assert.equal(s.count, 1);
  s = run(s, [[[0.7, 0.95], 400], [[0.84], 700], [[0.86], 1000]]);
  assert.equal(s.count, 1);
  // after the debounce time the next one counts
  s = run(s, [[[], 2000], [[0.75], 3000], [[0.86], 3100]]);
  assert.equal(s.count, 2);
  assert.equal(s.lastCountMs, 3100);
});

test('checkpoints: never above total', () => {
  let s = checkpointsInitial();
  for (let i = 0; i < 6; i++) s = run(s, [[[0.75], i * 2000], [[0.86], i * 2000 + 100], [[], i * 2000 + 200]]);
  assert.equal(s.count, 3);
  assert.equal(run(checkpointsInitial(), [[[0.75], 0], [[0.86], 100]], { ...TRIG, total: 0 }).count, 0);
});

test('checkpoints: hovering on a tape (jitter) does not count it again', () => {
  let s = run(checkpointsInitial(), [[[0.8], 0], [[0.86], 100]]);
  assert.equal(s.count, 1);
  s = run(s, [[[0.84], 2000], [[0.86], 4000], [[0.83], 6000], [[0.87], 8000]]);
  assert.equal(s.count, 1);
  // backing up well above the trigger and passing again does count (pilot corrects with -1 if needed)
  s = run(s, [[[0.78], 10000], [[0.72], 11000], [[0.8], 12000], [[0.86], 13000]]);
  assert.equal(s.count, 2);
});

test('checkpoints: moving backwards does not count', () => {
  const s = run(checkpointsInitial(), [[[0.95], 0], [[0.86], 2000], [[0.7], 4000], [[0.5], 6000]]);
  assert.equal(s.count, 0);
});

test('checkpoints: tapes are matched by the nearest y within 0.15', () => {
  // a jump larger than 0.15 is a different tape: no count
  assert.equal(run(checkpointsInitial(), [[[0.6], 0], [[0.9], 100]]).count, 0);
  // a tape that appears already below the trigger row (e.g. after the line was lost) does not count
  assert.equal(run(checkpointsInitial(), [[[], 0], [[0.9], 100]]).count, 0);
  // with two tapes in view, each keeps its own track
  let s = run(checkpointsInitial(), [[[0.3, 0.8], 0], [[0.35, 0.84], 100], [[0.4, 0.9], 200]]);
  assert.equal(s.count, 1);
  assert.deepEqual(s.tapesY, [0.4, 0.9]);
  s = run(s, [[[0.85], 3000]]); // upper tape jumped 0.45: new, no count
  assert.equal(s.count, 1);
});

test('checkpoints: unsorted and junk input', () => {
  const s = run(checkpointsInitial(), [[[0.9, 'x', NaN, 0.3, null], 0]]);
  assert.deepEqual(s.tapesY, [0.3, 0.9]);
  assert.deepEqual(checkpointsUpdate(s, 'junk', 100, TRIG).tapesY, []);
  assert.deepEqual(checkpointsUpdate(s, undefined, 100, TRIG).tapesY, []);
  assert.equal(run(checkpointsInitial(), [[[0.8], 0], [[0.9], 100]], undefined).count, 1); // default cfg
});

test('checkpoints: auto off only remembers positions; turning it on does not count old crossings', () => {
  let s = { ...checkpointsInitial(), auto: false };
  s = run(s, [[[0.8], 0], [[0.9], 100]]);
  assert.equal(s.count, 0);
  assert.deepEqual(s.tapesY, [0.9]);
  s = { ...s, auto: true };
  s = run(s, [[[0.92], 3000]]);
  assert.equal(s.count, 0);
  s = run(s, [[[0.75], 4000], [[0.86], 5000]]); // the next tape counts
  assert.equal(s.count, 1);
});

test('checkpointsAdjust and checkpointsReset', () => {
  let s = checkpointsInitial();
  s = checkpointsAdjust(s, +1, 3);
  assert.equal(s.count, 1);
  s = checkpointsAdjust(checkpointsAdjust(s, +1, 3), +5, 3);
  assert.equal(s.count, 3);
  s = checkpointsAdjust(s, -10, 3);
  assert.equal(s.count, 0);
  assert.equal(checkpointsAdjust(s, 'x', 3).count, 0);
  s = { ...checkpointsAdjust(s, 2, 3), auto: false };
  assert.deepEqual(checkpointsReset(s), { ...checkpointsInitial(), auto: false });
  assert.deepEqual(checkpointsReset(), checkpointsInitial());
});

test('checkpointLabel', () => {
  // the START tape is counted like the others: 1 = start passed, 2 = checkpoint 1, ...
  assert.equal(checkpointLabel(0, 3, 50), 'Before the start tape');
  assert.equal(checkpointLabel(1, 3, 50), 'Start tape passed');
  assert.equal(checkpointLabel(2, 3, 50), 'Checkpoint 1 · 50 cm');
  assert.equal(checkpointLabel(3, 3, 50), 'Checkpoint 2 · 100 cm');
  assert.equal(checkpointLabel(4, 3, 50), 'FINAL · 150 cm');
  assert.equal(checkpointLabel(6, 3, 50), 'FINAL · 150 cm');
  assert.equal(checkpointLabel(4, 4, 40), 'Checkpoint 3 · 120 cm');
  assert.equal(checkpointLabel(3), 'Checkpoint 2 · 100 cm');
  assert.equal(tapesTotal(3), 4);
});

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

test('persistence: count and auto survive a reload, live tape data does not', () => {
  const st = fakeStorage();
  const s = { ...run(checkpointsInitial(), [[[0.8], 0], [[0.9], 100]]), auto: false };
  assert.equal(saveLine(st, s), true);
  assert.deepEqual(JSON.parse(st.data['rov.m3.v1']), { count: 1, auto: false });
  assert.deepEqual(loadLine(st), { ...checkpointsInitial(), count: 1, auto: false });
});

test('persistence: junk, limits and blocked storage', () => {
  assert.deepEqual(loadLine(fakeStorage()), checkpointsInitial());
  assert.deepEqual(loadLine(null), checkpointsInitial());
  for (const text of ['{bad', '[]', '7', '{"count":-1,"auto":"yes"}', '{"count":1.5}']) {
    assert.deepEqual(loadLine(fakeStorage({ 'rov.m3.v1': text })), checkpointsInitial(), text);
  }
  assert.equal(loadLine(fakeStorage({ 'rov.m3.v1': '{"count":9}' }), 3).count, 3);
  const blocked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.deepEqual(loadLine(blocked), checkpointsInitial());
  assert.equal(saveLine(blocked, checkpointsInitial()), false);
});
