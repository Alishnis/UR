import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approachView, loadPoles, nextColor, orderText, parseOrder, pickPoles, polesHit, polesInitial, polesReset,
  polesSetOrder, polesUndo, savePoles,
} from '../js/poles.js';

const RBY = ['red', 'blue', 'yellow'];

test('parseOrder: the ways a referee order gets typed', () => {
  for (const text of ['R-B-Y', 'rby', 'RBY', 'R B Y', 'r,b,y', ' r , b , y ', 'R–B–Y', 'R>B>Y', 'R/B/Y',
    'red blue yellow', 'Red-Blue-Yellow', 'r-blue-Y']) {
    assert.deepEqual(parseOrder(text), RBY, text);
  }
  assert.deepEqual(parseOrder('Y-R-B'), ['yellow', 'red', 'blue']);
  assert.deepEqual(parseOrder('byr'), ['blue', 'yellow', 'red']);
});

test('parseOrder: R-B-Y typed with the Russian keyboard layout', () => {
  assert.deepEqual(parseOrder('К-И-Н'), RBY);
  assert.deepEqual(parseOrder('кин'), RBY);
});

test('parseOrder: must be a permutation of R, Y, B', () => {
  for (const bad of ['', '   ', 'R-B', 'R-B-Y-R', 'R-R-B', 'rrr', 'R-G-B', 'x', 'red', 'redblueyellow',
    'R--', 'RB Y', null, undefined, 42]) {
    assert.equal(parseOrder(bad), null, String(bad));
  }
});

test('orderText', () => {
  assert.equal(orderText(RBY), 'R-B-Y');
  assert.equal(orderText(['yellow', 'red', 'blue']), 'Y-R-B');
  assert.equal(orderText(null), '');
  assert.equal(orderText(['red', 'red', 'blue']), '');
  assert.equal(orderText(parseOrder(orderText(parseOrder('b y r')))), 'B-Y-R'); // round trip
});

test('order state: set, hit, undo, reset, next colour', () => {
  let s = polesInitial();
  assert.deepEqual(s, { order: null, done: 0 });
  assert.equal(nextColor(s), null);
  s = polesSetOrder(s, RBY);
  assert.equal(nextColor(s), 'red');
  s = polesHit(s);
  assert.equal(nextColor(s), 'blue');
  s = polesHit(polesHit(s));
  assert.equal(s.done, 3);
  assert.equal(nextColor(s), null); // all three done
  assert.equal(polesHit(s).done, 3); // never more than 3
  s = polesUndo(s);
  assert.equal(nextColor(s), 'yellow');
  s = polesReset(s);
  assert.deepEqual(s, { order: RBY, done: 0 }); // reset keeps the order
  assert.equal(polesUndo(s).done, 0);
});

test('order state: a new order restarts, a bad one is ignored, the input is not shared', () => {
  const order = [...RBY];
  let s = polesHit(polesSetOrder(polesInitial(), order));
  order[0] = 'green';
  assert.deepEqual(s.order, RBY);
  s = polesSetOrder(s, ['yellow', 'blue', 'red']);
  assert.deepEqual(s, { order: ['yellow', 'blue', 'red'], done: 0 });
  assert.equal(polesSetOrder(s, ['red', 'red', 'blue']), s);
  assert.equal(polesSetOrder(s, 'R-B-Y'), s);
  assert.deepEqual(polesSetOrder(s, null), { order: null, done: 0 });
});

const blob = (color, area, aspect, x = 300, boxH = 100) => ({
  color, area, aspect, box: [x - 10, 50, 20, boxH], center: [x, 100], areaFrac: area / (640 * 360), fill: 0.9,
});

test('pickPoles: the biggest blob per colour, tall ones preferred', () => {
  const tallRed = blob('red', 1000, 3);
  const squatRed = blob('red', 1800, 0.8); // 1800 * 0.5 = 900 < 1000
  const bigSquatRed = blob('red', 2400, 1); // 1200 > 1000
  const yellow = blob('yellow', 500, 2);
  assert.deepEqual(pickPoles([squatRed, tallRed, yellow], { minAspect: 1.2 }), { red: tallRed, yellow, blue: null });
  assert.equal(pickPoles([tallRed, bigSquatRed]).red, bigSquatRed);
  assert.equal(pickPoles([blob('blue', 100, 1.2), blob('blue', 150, 1.19)]).blue.area, 100); // 100 vs 75
  assert.deepEqual(pickPoles([]), { red: null, yellow: null, blue: null });
  assert.deepEqual(pickPoles(null), { red: null, yellow: null, blue: null });
  const green = blob('green', 300, 2);
  assert.equal(pickPoles([green]).green, green); // extra calibrated colours come through too
  assert.deepEqual(pickPoles([null, { color: 'red' }, { area: 5 }, { color: '__proto__', area: 9 }]),
    { red: null, yellow: null, blue: null });
});

const CFG = { alignFrac: 0.08, closeFrac: 0.6 };

test('approachView: search, yaw, forward, close', () => {
  assert.deepEqual(approachView(null, 640, 360, CFG), { text: 'SEARCH: turn slowly', kind: 'warn', turn: null });
  assert.deepEqual(approachView(blob('red', 1, 2, 500), 640, 360, CFG), { text: 'YAW RIGHT', kind: 'warn', turn: 'right' });
  assert.deepEqual(approachView(blob('red', 1, 2, 100), 640, 360, CFG), { text: 'YAW LEFT', kind: 'warn', turn: 'left' });
  assert.deepEqual(approachView(blob('red', 1, 2, 340), 640, 360, CFG), { text: 'FORWARD', kind: 'ok', turn: null });
  assert.equal(approachView(blob('red', 1, 2, 345.5), 640, 360, CFG).text, 'FORWARD'); // just inside alignFrac
  assert.deepEqual(approachView(blob('red', 1, 2, 320, 216), 640, 360, CFG), { text: 'CLOSE: hit it', kind: 'ok', turn: null });
  assert.equal(approachView(blob('red', 1, 2, 320, 215), 640, 360, CFG).text, 'FORWARD');
});

test('approachView: centre from the box, defaults, junk', () => {
  assert.equal(approachView({ box: [600, 0, 20, 10] }, 640, 360).text, 'YAW RIGHT');
  assert.equal(approachView({ box: [310, 0, 20, 300] }, 640, 360).text, 'CLOSE: hit it');
  assert.equal(approachView({}, 640, 360, CFG).text, 'SEARCH: turn slowly');
  assert.equal(approachView(blob('red', 1, 2), 0, 0, CFG).text, 'SEARCH: turn slowly');
});

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

test('persistence: round trip, junk, blocked storage', () => {
  const st = fakeStorage();
  const s = polesHit(polesSetOrder(polesInitial(), RBY));
  assert.equal(savePoles(st, s), true);
  assert.ok(st.data['rov.m5.v1']);
  assert.deepEqual(loadPoles(st), s);
  assert.deepEqual(loadPoles(fakeStorage()), polesInitial());
  assert.deepEqual(loadPoles(null), polesInitial());
  for (const text of ['{bad', '[]', '1', '{"order":["red","red","blue"],"done":-1}', '{"order":"RBY","done":1.5}']) {
    assert.deepEqual(loadPoles(fakeStorage({ 'rov.m5.v1': text })), polesInitial(), text);
  }
  assert.equal(loadPoles(fakeStorage({ 'rov.m5.v1': '{"order":null,"done":7}' })).done, 3);
  const blocked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.deepEqual(loadPoles(blocked), polesInitial());
  assert.equal(savePoles(blocked, s), false);
});
