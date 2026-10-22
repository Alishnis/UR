import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attemptInitial, attemptPause, attemptReset, attemptStart, attemptView, holdInitial, holdReset, holdStart,
  holdStop, holdView, loadAttempt, loadHold, saveAttempt, saveHold,
} from '../js/timers.js';

const NEED = 3000;

test('hold: idle', () => {
  const v = holdView(holdInitial(), 1000, NEED);
  assert.deepEqual(v, { running: false, elapsedMs: 0, progress: 0, secured: false, bestMs: 0 });
});

test('hold: a continuous 3 s hold secures the points, and they stay after the drop', () => {
  let s = holdStart(holdInitial(), 10_000);
  let v = holdView(s, 11_500, NEED);
  assert.deepEqual([v.running, v.elapsedMs, v.progress, v.secured], [true, 1500, 0.5, false]);
  v = holdView(s, 13_000, NEED);
  assert.equal(v.secured, true); // exactly 3.0 s
  assert.equal(v.progress, 1);
  v = holdView(s, 20_000, NEED);
  assert.equal(v.progress, 1); // capped
  s = holdStop(s, 14_000);
  v = holdView(s, 99_000, NEED);
  assert.deepEqual(v, { running: false, elapsedMs: 4000, progress: 1, secured: true, bestMs: 4000 });
  s = holdStart(s, 100_000); // hooked again: still secured from the first hold
  v = holdView(s, 100_500, NEED);
  assert.deepEqual([v.elapsedMs, v.secured, v.bestMs], [500, true, 4000]);
});

test('hold: dropped before 3 s, then re-hooked: the clock starts again from zero', () => {
  let s = holdStart(holdInitial(), 0);
  s = holdStop(s, 2900); // dropped at 2.9 s
  let v = holdView(s, 5000, NEED);
  assert.deepEqual([v.running, v.elapsedMs, v.secured, v.bestMs], [false, 2900, false, 2900]);
  s = holdStart(s, 6000);
  v = holdView(s, 8000, NEED); // 2 s into the new hold: 2.9 + 2 does not add up
  assert.deepEqual([v.elapsedMs, v.secured, v.bestMs], [2000, false, 2900]);
  assert.ok(Math.abs(v.progress - 2 / 3) < 1e-9);
  v = holdView(s, 9000, NEED);
  assert.equal(v.secured, true);
  s = holdStop(s, 9100);
  assert.equal(holdView(s, 9100, NEED).bestMs, 3100);
});

test('hold: start while running and stop while stopped change nothing; reset clears', () => {
  const running = holdStart(holdInitial(), 100);
  assert.equal(holdStart(running, 500), running);
  const idle = holdInitial();
  assert.equal(holdStop(idle, 500), idle);
  const done = holdStop(holdStart(holdInitial(), 0), 5000);
  assert.deepEqual(holdReset(done), holdInitial());
  assert.equal(holdView(holdReset(done), 0, NEED).secured, false);
});

test('hold: a clock going backwards never gives a negative time', () => {
  const s = holdStart(holdInitial(), 5000);
  assert.equal(holdView(s, 4000, NEED).elapsedMs, 0);
  assert.equal(holdStop(s, 4000).lastMs, 0);
});

test('hold: needMs is a parameter (config mission4.holdMs)', () => {
  const s = holdStart(holdInitial(), 0);
  assert.equal(holdView(s, 2000, 2000).secured, true);
  assert.equal(holdView(s, 2000).secured, false); // default 3000
});

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}
const blocked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };

test('hold persistence: the result survives a reload, a running hold does not resume', () => {
  const st = fakeStorage();
  const s = holdStop(holdStart(holdInitial(), 0), 3500);
  assert.equal(saveHold(st, holdStart(s, 10_000)), true);
  const back = loadHold(st);
  assert.equal(back.running, false);
  assert.equal(holdView(back, 0, NEED).secured, true);
  assert.equal(back.bestMs, 3500);
  assert.deepEqual(loadHold(fakeStorage({ 'rov.m4.v1': '{"bestMs":"x","lastMs":-5}' })), holdInitial());
  assert.deepEqual(loadHold(fakeStorage({ 'rov.m4.v1': '{bad' })), holdInitial());
  assert.deepEqual(loadHold(blocked), holdInitial());
  assert.equal(saveHold(blocked, s), false);
});

const MIN = 60_000;
const T0 = 1_760_000_000_000; // a Date.now() value

test('attempt: fresh clock shows the full time', () => {
  const s = attemptInitial(20 * MIN);
  const v = attemptView(s, T0);
  assert.deepEqual(v, { remainingMs: 20 * MIN, running: false, text: '20:00', kind: 'ok' });
  assert.equal(attemptInitial().totalMs, 20 * MIN); // default
  assert.equal(attemptInitial(-5).totalMs, 20 * MIN);
  assert.equal(attemptInitial('x').totalMs, 20 * MIN);
});

test('attempt: counts down, rounds up to whole seconds', () => {
  const s = attemptStart(attemptInitial(20 * MIN), T0);
  assert.equal(attemptView(s, T0 + 300).text, '20:00');
  assert.equal(attemptView(s, T0 + 1000).text, '19:59');
  assert.equal(attemptView(s, T0 + 1001).text, '19:59');
  assert.equal(attemptView(s, T0 + 75_500).text, '18:45');
  assert.equal(attemptView(s, T0 + 75_500).running, true);
  assert.equal(attemptStart(s, T0 + 5000), s); // start while running: no change
});

test('attempt: warn under 5 min, bad under 1 min and over time', () => {
  const s = attemptStart(attemptInitial(20 * MIN), T0);
  assert.equal(attemptView(s, T0 + 15 * MIN).kind, 'ok'); // exactly 5:00 left
  assert.equal(attemptView(s, T0 + 15 * MIN + 1).kind, 'warn');
  assert.equal(attemptView(s, T0 + 19 * MIN).kind, 'warn'); // exactly 1:00 left
  assert.equal(attemptView(s, T0 + 19 * MIN + 1).kind, 'bad');
  let v = attemptView(s, T0 + 20 * MIN);
  assert.deepEqual([v.text, v.kind, v.remainingMs], ['00:00', 'bad', 0]);
  v = attemptView(s, T0 + 20 * MIN + 400);
  assert.equal(v.text, '00:00'); // not "-00:00"
  v = attemptView(s, T0 + 21 * MIN + 5000);
  assert.deepEqual([v.text, v.kind, v.remainingMs], ['-01:05', 'bad', -65_000]);
});

test('attempt: pause keeps the used time, resume continues', () => {
  let s = attemptStart(attemptInitial(20 * MIN), T0);
  s = attemptPause(s, T0 + 2 * MIN);
  assert.equal(attemptView(s, T0 + 10 * MIN).text, '18:00'); // paused: frozen
  assert.equal(attemptView(s, T0 + 10 * MIN).running, false);
  assert.equal(attemptPause(s, T0 + 11 * MIN), s); // pause while paused: no change
  s = attemptStart(s, T0 + 10 * MIN);
  assert.equal(attemptView(s, T0 + 11 * MIN).text, '17:00');
  assert.deepEqual(attemptReset(s), attemptInitial(20 * MIN));
});

test('attempt: a wall clock jumping backwards does not add time', () => {
  const s = attemptStart(attemptInitial(20 * MIN), T0);
  assert.equal(attemptView(s, T0 - 5000).remainingMs, 20 * MIN);
  assert.equal(attemptPause(s, T0 - 5000).usedMs, 0);
});

test('attempt: a running clock survives a page reload (wall-clock start is saved)', () => {
  const st = fakeStorage();
  let s = attemptStart(attemptInitial(20 * MIN), T0);
  s = attemptPause(s, T0 + MIN); // 1 min used
  s = attemptStart(s, T0 + 2 * MIN);
  assert.equal(saveAttempt(st, s), true);
  // ... page reload 3 minutes later ...
  const back = loadAttempt(st, 20 * MIN);
  assert.deepEqual(back, s);
  const v = attemptView(back, T0 + 5 * MIN);
  assert.deepEqual([v.text, v.running], ['16:00', true]); // 1 min before the pause + 3 min since the restart
});

test('attempt: a paused clock survives a reload; a new attempt length applies only to a fresh clock', () => {
  const st = fakeStorage();
  const paused = attemptPause(attemptStart(attemptInitial(20 * MIN), T0), T0 + 90_000);
  saveAttempt(st, paused);
  assert.equal(attemptView(loadAttempt(st, 25 * MIN), T0 + 99 * MIN).text, '18:30'); // attempt under way: keeps 20
  saveAttempt(st, attemptInitial(20 * MIN));
  assert.equal(loadAttempt(st, 25 * MIN).totalMs, 25 * MIN); // nothing used yet: config wins
});

test('attempt persistence: junk and blocked storage give a fresh clock', () => {
  const fresh = attemptInitial(20 * MIN);
  assert.deepEqual(loadAttempt(fakeStorage(), 20 * MIN), fresh);
  assert.deepEqual(loadAttempt(null, 20 * MIN), fresh);
  assert.deepEqual(loadAttempt(blocked, 20 * MIN), fresh);
  assert.equal(saveAttempt(blocked, fresh), false);
  for (const text of ['{bad', '[]', '5', '{"running":true}', '{"running":true,"startedAt":"x"}', '{"usedMs":-9}']) {
    assert.deepEqual(loadAttempt(fakeStorage({ 'rov.attempt.v1': text }), 20 * MIN), fresh, text);
  }
  const odd = loadAttempt(fakeStorage({ 'rov.attempt.v1': '{"running":false,"usedMs":1000,"totalMs":-1}' }), 20 * MIN);
  assert.deepEqual(odd, { totalMs: 20 * MIN, running: false, startedAt: null, usedMs: 1000 });
});
