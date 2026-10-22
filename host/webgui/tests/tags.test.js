import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAG_ID_MAX, dockingView, loadTags, saveTags, selectTag, selectionView, tagsInitial, tagsReset,
  tagsSetRule, tagsUndo, tagsUpdate,
} from '../js/tags.js';

// Feeds frames (arrays of ids) and collects the newly confirmed ids.
function feed(state, frames, confirmFrames = 3) {
  const newly = [];
  for (const ids of frames) {
    const r = tagsUpdate(state, ids, confirmFrames);
    state = r.state;
    newly.push(...r.newly);
  }
  return { state, newly };
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

test('tagsInitial', () => {
  assert.deepEqual(tagsInitial(), { seen: {}, confirmed: [], ignored: [], rule: null });
  assert.notEqual(tagsInitial().seen, tagsInitial().seen); // fresh objects every time
});

test('tagsUpdate: an id is confirmed after N frames, not necessarily in a row', () => {
  const { state, newly } = feed(tagsInitial(), [[17], [], [245], [17], [], [17]], 3);
  assert.deepEqual(newly, [17]);
  assert.deepEqual(state.confirmed, [17]);
  assert.equal(state.seen[17], 3);
  assert.equal(state.seen[245], 1);
});

test('tagsUpdate: an id twice in one frame counts once; confirm order is kept', () => {
  let { state } = feed(tagsInitial(), [[503, 503, 503]], 3);
  assert.equal(state.seen[503], 1);
  ({ state } = feed(state, [[503, 17], [503, 17], [17]], 3));
  assert.deepEqual(state.confirmed, [503, 17]);
});

test('tagsUpdate: two ids confirmed in the same frame', () => {
  const r = feed(tagsInitial(), [[245, 17], [17, 245]], 2);
  assert.deepEqual(r.newly, [17, 245]);
  assert.deepEqual(r.state.confirmed, [17, 245]);
});

test('tagsUpdate: is pure and returns the same object when nothing changed', () => {
  const s0 = tagsInitial();
  const r = tagsUpdate(s0, [17], 5);
  assert.deepEqual(s0, tagsInitial()); // input untouched
  assert.notEqual(r.state, s0);
  assert.equal(tagsUpdate(r.state, [], 5).state, r.state);
  const done = feed(tagsInitial(), [[17], [17]], 2).state;
  assert.equal(tagsUpdate(done, [17], 2).state, done); // confirmed ids stop counting
});

test('tagsUpdate: only integer tag36h11 ids 0..586 count', () => {
  const junk = [-1, TAG_ID_MAX + 1, 1.5, NaN, '17', null, undefined, {}, Infinity];
  const r = tagsUpdate(tagsInitial(), junk, 1);
  assert.deepEqual(r.newly, []);
  assert.deepEqual(r.state.seen, {});
  assert.deepEqual(tagsUpdate(tagsInitial(), [0, TAG_ID_MAX], 1).newly, [0, TAG_ID_MAX]);
  assert.deepEqual(tagsUpdate(tagsInitial(), 'nope', 1).newly, []);
  assert.deepEqual(tagsUpdate(tagsInitial(), null, 1).newly, []);
});

test('tagsUpdate: a bad confirmFrames falls back to 5', () => {
  for (const bad of [0, -2, 1.5, 'x', undefined, null]) {
    let state = tagsInitial();
    for (let i = 0; i < 4; i++) state = tagsUpdate(state, [1], bad).state;
    assert.deepEqual(state.confirmed, [], String(bad));
    assert.deepEqual(tagsUpdate(state, [1], bad).newly, [1], String(bad));
  }
});

test('tagsUndo: last confirmed becomes ignored and never counts again', () => {
  let { state } = feed(tagsInitial(), [[17], [17], [99], [99]], 2);
  assert.deepEqual(state.confirmed, [17, 99]);
  state = tagsUndo(state);
  assert.deepEqual(state.confirmed, [17]);
  assert.deepEqual(state.ignored, [99]);
  assert.equal(state.seen[99], undefined);
  const r = feed(state, [[99], [99], [99], [99]], 2);
  assert.deepEqual(r.newly, []);
  assert.equal(r.state.seen[99], undefined);
  const empty = tagsInitial();
  assert.equal(tagsUndo(empty), empty); // nothing to undo
});

test('tagsReset keeps the rule, forgets tags and ignored ids', () => {
  let { state } = feed(tagsSetRule(tagsInitial(), 'smallest'), [[17], [17], [5], [5]], 2);
  state = tagsUndo(state);
  state = tagsReset(state);
  assert.deepEqual(state, { seen: {}, confirmed: [], ignored: [], rule: 'smallest' });
});

test('tagsSetRule accepts only largest / smallest / null', () => {
  const s = tagsSetRule(tagsInitial(), 'largest');
  assert.equal(s.rule, 'largest');
  assert.equal(tagsSetRule(s, 'biggest'), s);
  assert.equal(tagsSetRule(s, undefined), s);
  assert.equal(tagsSetRule(s, null).rule, null);
});

test('selectTag', () => {
  assert.equal(selectTag([245, 17, 503], 'largest'), 503);
  assert.equal(selectTag([245, 17, 503], 'smallest'), 17);
  assert.equal(selectTag([245], 'smallest'), 245);
  assert.equal(selectTag([], 'largest'), null);
  assert.equal(selectTag([1, 2], null), null);
  assert.equal(selectTag([1, 2], 'middle'), null);
  assert.equal(selectTag([0, 3], 'smallest'), 0); // id 0 is a real tag
  assert.equal(selectTag(null, 'largest'), null);
});

test('selectionView: no rule -> ask for it (even with all tags found)', () => {
  const v = selectionView(tagsInitial(), 3);
  assert.equal(v.final, false);
  assert.equal(v.big, 'Pick LARGEST or SMALLEST');
  assert.equal(v.kind, 'warn');
  const { state } = feed(tagsInitial(), [[17, 245, 503]], 1);
  const v2 = selectionView(state, 3);
  assert.equal(v2.big, 'Pick LARGEST or SMALLEST');
  assert.match(v2.sub, /3 \/ 3/);
});

test('selectionView: searching -> selected -> too many', () => {
  let state = tagsSetRule(tagsInitial(), 'largest');
  let v = selectionView(state, 3);
  assert.deepEqual([v.final, v.big, v.kind], [false, 'Searching: 0 / 3 tags', 'idle']);

  ({ state } = feed(state, [[245]], 1));
  v = selectionView(state, 3);
  assert.equal(v.big, 'Searching: 1 / 3 tags');
  assert.equal(v.sub, 'best so far: ID 245');

  ({ state } = feed(state, [[17], [503]], 1));
  v = selectionView(state, 3);
  assert.deepEqual([v.final, v.big, v.kind], [true, 'SELECTED: ID 503 (LARGEST)', 'ok']);
  assert.equal(v.sub, 'confirmed: 17, 245, 503');
  assert.equal(selectionView(tagsSetRule(state, 'smallest'), 3).big, 'SELECTED: ID 17 (SMALLEST)');

  ({ state } = feed(state, [[42]], 1)); // a false positive: more tags than expected
  v = selectionView(state, 3);
  assert.deepEqual([v.final, v.big, v.sub, v.kind], [false, '4 tags confirmed, expected 3', 'Undo a wrong one', 'warn']);
  v = selectionView(tagsUndo(state), 3);
  assert.equal(v.big, 'SELECTED: ID 503 (LARGEST)');
});

test('selectionView: expected is configurable, junk falls back to 3', () => {
  const { state } = feed(tagsSetRule(tagsInitial(), 'smallest'), [[8, 9]], 1);
  assert.equal(selectionView(state, 2).big, 'SELECTED: ID 8 (SMALLEST)');
  assert.equal(selectionView(state, 0).big, 'Searching: 2 / 3 tags');
  assert.equal(selectionView(state).big, 'Searching: 2 / 3 tags');
});

test('persistence: round trip', () => {
  const st = fakeStorage();
  let { state } = feed(tagsSetRule(tagsInitial(), 'largest'), [[17], [17], [3], [3], [245]], 2);
  state = tagsUndo(state);
  assert.equal(saveTags(st, state), true);
  assert.ok(st.data['rov.m21.v1']);
  assert.deepEqual(loadTags(st), state);
});

test('persistence: junk and blocked storage', () => {
  assert.deepEqual(loadTags(fakeStorage()), tagsInitial());
  assert.deepEqual(loadTags(null), tagsInitial());
  assert.deepEqual(loadTags(blocked), tagsInitial());
  assert.equal(saveTags(blocked, tagsInitial()), false);
  for (const text of ['{bad', 'null', '42', '"x"', '[]', '{"confirmed":"17"}']) {
    assert.deepEqual(loadTags(fakeStorage({ 'rov.m21.v1': text })), tagsInitial(), text);
  }
  const messy = {
    seen: { 17: 3, 245: -1, abc: 2, 999: 4, '05': 1, 9: 1.5, 503: 2 },
    confirmed: [17, 17, 'x', 600, 503, 8],
    ignored: [8, -3, 8],
    rule: 'biggest',
  };
  const text = JSON.stringify(messy).replace('"seen":{', '"seen":{"__proto__":7,');
  const s = loadTags(fakeStorage({ 'rov.m21.v1': text }));
  assert.deepEqual(s, { seen: { 17: 3, 503: 2 }, confirmed: [17, 503], ignored: [8], rule: null });
});

// ---------- 2.2 docking ----------

const CFG = { alignDeg: 5, alignVertM: 0.08, slowDistM: 1.0 };
const at = (x, y, z, yawDeg = 0) => ({ id: 17, center: [640, 360], pose: { x, y, z, dist: Math.hypot(x, y, z), yawDeg } });

test('dockingView: target not in view', () => {
  const v = dockingView(null, CFG);
  assert.equal(v.text, 'TARGET NOT IN VIEW');
  assert.equal(v.kind, 'warn');
  assert.equal(v.turn, null);
  assert.equal(v.vert, null);
});

test('dockingView: turn first, the sign follows the bearing', () => {
  let v = dockingView(at(0.3, 0.2, 2), CFG); // ~8.5 deg right, and also too high
  assert.equal(v.turn, 'right');
  assert.equal(v.vert, null); // turning has priority
  assert.equal(v.text, 'TURN RIGHT');
  assert.ok(Math.abs(v.bearingDeg - (Math.atan2(0.3, 2) * 180) / Math.PI) < 1e-9);
  v = dockingView(at(-0.3, 0, 2), CFG);
  assert.equal(v.turn, 'left');
  assert.equal(v.text, 'TURN LEFT');
  assert.ok(v.bearingDeg < 0);
});

test('dockingView: then up / down (image y points down)', () => {
  let v = dockingView(at(0.05, 0.2, 2), CFG); // tag below the camera axis
  assert.equal(v.turn, null);
  assert.equal(v.vert, 'down');
  assert.equal(v.text, 'DOWN');
  assert.equal(v.vertM, 0.2);
  v = dockingView(at(0, -0.1, 2), CFG);
  assert.equal(v.vert, 'up');
  assert.equal(v.text, 'UP');
  assert.equal(dockingView(at(0, 0.08, 2), CFG).vert, null); // at the limit: aligned
});

test('dockingView: aligned -> FORWARD, close -> SLOW, ENTERING', () => {
  let v = dockingView(at(0.05, 0.03, 2), CFG);
  assert.deepEqual([v.text, v.kind, v.turn, v.vert], ['FORWARD', 'ok', null, null]);
  assert.ok(Math.abs(v.dist - Math.hypot(0.05, 0.03, 2)) < 1e-9);
  v = dockingView(at(0.02, 0.03, 0.8), CFG);
  assert.deepEqual([v.text, v.kind], ['SLOW, ENTERING', 'ok']);
});

test('dockingView: off-axis hint from the tag yaw (+ = ROV right of the centre line)', () => {
  assert.equal(dockingView(at(0, 0, 2, 5), CFG).hint, '');
  assert.match(dockingView(at(0, 0, 2, 25), CFG).hint, /RIGHT/);
  assert.match(dockingView(at(0, 0, 2, -25), CFG).hint, /LEFT/);
  assert.equal(dockingView(at(0, 0, 2, 25), CFG).tagYawDeg, 25);
});

test('dockingView: no pose -> angles from the pixel offset', () => {
  const tag = { id: 17, center: [640 + 320, 360], pose: null, w: 1280, h: 720 };
  let v = dockingView(tag, { ...CFG, hfovDeg: 90 });
  // half way to the right edge with a 90 deg lens: atan(0.5 * tan 45) = 26.6 deg
  assert.ok(Math.abs(v.bearingDeg - 26.565) < 0.01);
  assert.equal(v.turn, 'right');
  assert.equal(v.dist, null);
  assert.equal(v.vertM, null);

  v = dockingView({ ...tag, center: [640, 360 + 100] }, { ...CFG, hfovDeg: 90 });
  assert.equal(v.vert, 'down');
  v = dockingView({ ...tag, center: [645, 362] }, CFG);
  assert.equal(v.text, 'FORWARD'); // no distance: never "SLOW"
  // frame size from cfg instead of the tag
  v = dockingView({ id: 1, center: [100, 360], pose: null }, { ...CFG, w: 1280, h: 720 });
  assert.equal(v.turn, 'left');
  // nothing to go on
  v = dockingView({ id: 1, center: [100, 360], pose: null }, CFG);
  assert.equal(v.kind, 'warn');
  assert.equal(v.turn, null);
  v = dockingView({ id: 1, pose: { x: 'a' }, w: 1280, h: 720 }, CFG);
  assert.equal(v.kind, 'warn');
});

test('dockingView: defaults when cfg is missing', () => {
  assert.equal(dockingView(at(0.3, 0, 2)).turn, 'right');
  assert.equal(dockingView(at(0.01, 0.01, 0.5)).text, 'SLOW, ENTERING');
});
