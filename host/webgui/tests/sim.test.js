import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_COLORS, inRange, rgbToHsv } from '../js/colors.js';
import {
  DOCK, HOOK, LINE, PALETTE, POLE, POLES, POOL, ROV, SCENES, SIM_SCENES, SPEED, TAG_IDS, TAG_PATTERNS, TAG_SIZE_M,
  TAG_WALL, projectPoint, projectPolygon, simCamera, simInitial, simStep, tagPoint, toCamera,
} from '../js/sim.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const NONE = { surge: 0, yaw: 0, heave: 0 };

// Runs the simulator with constant keys for `secs` seconds at 50 Hz.
function hold(state, axes, secs, dt = 0.02) {
  for (let i = 0; i < Math.round(secs / dt); i++) state = simStep(state, axes, dt);
  return state;
}

test('simInitial: every scene starts at its pose, at rest', () => {
  for (const scene of SIM_SCENES) {
    const s = simInitial(scene);
    assert.equal(s.scene, scene);
    assert.deepEqual([s.x, s.y, s.heading, s.depth], Object.values(SCENES[scene].start));
    assert.deepEqual([s.vSurge, s.vYaw, s.vHeave, s.t], [0, 0, 0, 0]);
  }
  assert.equal(simInitial('nope').scene, 'tags');
  assert.equal(simInitial().scene, 'tags');
});

test('simStep: surge moves along the heading with a little lag, never sideways', () => {
  const s0 = simInitial('tags');
  const s = hold(s0, { surge: 1, yaw: 0, heave: 0 }, 10);
  const moved = s.y - s0.y;
  assert.ok(moved > 3.2 && moved < 3.5, `moved ${moved} m in 10 s`); // 0.35 m/s minus the start-up lag
  assert.ok(near(s.vSurge, SPEED.surge, 1e-6));
  assert.equal(s.x, s0.x);
  assert.equal(s.depth, s0.depth);
  assert.ok(near(s.t, 10, 1e-9));
  const back = hold(simInitial('tags'), { surge: -1, yaw: 0, heave: 0 }, 1);
  assert.ok(back.y < s0.y);
});

test('simStep: +yaw turns right in place; heading 90 drives along +X', () => {
  const s0 = simInitial('tags');
  let s = hold(s0, { surge: 0, yaw: 1, heave: 0 }, 2);
  assert.ok(s.heading > 70 && s.heading < 90, String(s.heading)); // 45 deg/s minus lag
  assert.deepEqual([s.x, s.y], [s0.x, s0.y]); // no surge: turns on the spot
  s = hold({ ...s0, heading: 90 }, { surge: 1, yaw: 0, heave: 0 }, 2);
  assert.ok(s.x - s0.x > 0.5);
  assert.ok(near(s.y, s0.y, 1e-9));
  s = hold(s0, { surge: 0, yaw: -1, heave: 0 }, 1);
  assert.ok(s.heading < 0);
});

test('simStep: heading wraps into -180..180', () => {
  let s = { ...simInitial('tags'), heading: 179, vYaw: 45 };
  s = simStep(s, { surge: 0, yaw: 1, heave: 0 }, 0.1);
  assert.ok(near(s.heading, 179 + 4.5 - 360, 1e-9));
  s = simStep({ ...simInitial('tags'), heading: -179, vYaw: -45 }, { surge: 0, yaw: -1, heave: 0 }, 0.1);
  assert.ok(near(s.heading, 360 - 179 - 4.5, 1e-9));
});

test('simStep: +heave rises (less depth); depth stays inside the pool', () => {
  const s0 = simInitial('tags');
  let s = hold(s0, { surge: 0, yaw: 0, heave: 1 }, 1);
  assert.ok(s.depth < s0.depth);
  s = hold(s0, { surge: 0, yaw: 0, heave: 1 }, 30);
  assert.equal(s.depth, ROV.halfHeight);
  s = hold(s0, { surge: 0, yaw: 0, heave: -1 }, 30);
  assert.equal(s.depth, POOL.depth - ROV.halfHeight);
});

test('simStep: clamped to the pool box', () => {
  let s = hold(simInitial('tags'), { surge: 1, yaw: 0, heave: 0 }, 60);
  assert.equal(s.y, POOL.yMax);
  s = hold({ ...simInitial('tags'), heading: -90 }, { surge: 1, yaw: 0, heave: 0 }, 60);
  assert.equal(s.x, POOL.xMin);
});

test('simStep: releasing the keys lets the ROV coast to a stop', () => {
  let s = hold(simInitial('tags'), { surge: 1, yaw: 1, heave: 1 }, 2);
  s = hold(s, NONE, 3);
  assert.ok(Math.abs(s.vSurge) < 0.01 * SPEED.surge);
  assert.ok(Math.abs(s.vYaw) < 0.01 * SPEED.yawDeg);
  assert.ok(Math.abs(s.vHeave) < 0.01 * SPEED.heave);
});

test('simStep: dt is capped, junk axes and dt do nothing, input is not modified', () => {
  const s0 = simInitial('line');
  const copy = { ...s0 };
  assert.deepEqual(simStep(s0, { surge: 1 }, 5), simStep(s0, { surge: 1 }, 0.1));
  assert.deepEqual(simStep(s0, { surge: 1 }, -1), s0);
  assert.deepEqual(simStep(s0, { surge: 1 }, NaN), s0);
  assert.deepEqual(simStep(s0, { surge: NaN, yaw: 'x', heave: undefined }, 0.1), { ...s0, t: 0.1 });
  assert.deepEqual(simStep(s0, null, 0.1), { ...s0, t: 0.1 });
  assert.deepEqual(simStep(s0, { surge: 7 }, 0.1), simStep(s0, { surge: 1 }, 0.1)); // clamped to -1..1
  assert.deepEqual(s0, copy);
  assert.deepEqual(simStep(s0, { surge: 1, yaw: 0.5 }, 0.05), simStep(s0, { surge: 1, yaw: 0.5 }, 0.05));
});

// ---------- camera ----------

const flat = (over = {}) => ({ ...simInitial('tags'), x: 0, y: 0, heading: 0, depth: 1, ...over });

test('simCamera: pinhole model from the horizontal field of view', () => {
  const cam = simCamera(flat(), { hfovDeg: 90, tiltDeg: 0 });
  assert.ok(near(cam.fx, 640));
  assert.equal(cam.fy, cam.fx);
  assert.deepEqual([cam.cx, cam.cy, cam.width, cam.height], [640, 360, 1280, 720]);
  assert.deepEqual(cam.pos, [0, ROV.camForward, POOL.depth - 1]);
  assert.ok(near(simCamera(flat(), { hfovDeg: 60 }).fx, 640 / Math.tan(Math.PI / 6)));
  assert.equal(simCamera(flat()).hfovDeg, 70); // default
  assert.equal(simCamera(flat({ scene: 'line' })).tiltDeg, SCENES.line.camTiltDeg); // tilt from the scene
});

test('projectPoint: centre, right, up, behind', () => {
  const cam = simCamera(flat(), { hfovDeg: 90, tiltDeg: 0 });
  const z = POOL.depth - 1;
  let p = projectPoint(cam, [0, 2.2, z]); // 2 m straight ahead of the camera
  assert.ok(near(p[0], 640) && near(p[1], 360) && near(p[2], 2));
  p = projectPoint(cam, [0.5, 2.2, z]);
  assert.ok(near(p[0], 640 + 640 * 0.25)); // fx * x / z
  p = projectPoint(cam, [0, 2.2, z + 0.4]);
  assert.ok(near(p[1], 360 - 640 * 0.2)); // above: smaller image y
  assert.equal(projectPoint(cam, [0, -1, z]), null);
  assert.equal(projectPoint(cam, [0, ROV.camForward + 0.01, z]), null); // closer than the near plane
  assert.deepEqual(toCamera(cam, [0.5, 2.2, z - 0.1]).map((v) => Math.round(v * 1e9) / 1e9), [0.5, 0.1, 2]);
});

test('projectPoint: heading turns the view (heading 90 looks along +X)', () => {
  const cam = simCamera(flat({ heading: 90 }), { hfovDeg: 90, tiltDeg: 0 });
  const z = POOL.depth - 1;
  const p = projectPoint(cam, [3, 0, z]);
  assert.ok(near(p[0], 640) && near(p[1], 360));
  assert.ok(projectPoint(cam, [3, -1, z])[0] > 640); // -Y is on the right when facing +X
  assert.equal(projectPoint(cam, [-3, 0, z]), null);
});

test('projectPoint: a camera tilted 45 deg down sees the floor at its own height ahead in the middle', () => {
  const state = flat({ depth: POOL.depth - 0.6 }); // camera 0.6 m above the floor
  const cam = simCamera(state, { hfovDeg: 70, tiltDeg: 45 });
  const p = projectPoint(cam, [0, cam.pos[1] + 0.6, 0]);
  assert.ok(near(p[0], 640) && near(p[1], 360));
  assert.ok(near(cam.horizonY, 360 - cam.fx)); // tan 45 = 1
  const far = projectPoint(cam, [0, 1e5, 0]);
  assert.ok(far[1] > cam.horizonY && far[1] - cam.horizonY < 0.1); // far floor approaches the horizon
  assert.equal(simCamera(state, { tiltDeg: 0 }).horizonY, 360);
});

test('projectPolygon: matches projectPoint in front, clips at the near plane, [] behind', () => {
  const cam = simCamera(flat(), { hfovDeg: 90, tiltDeg: 0 });
  const z = POOL.depth - 1;
  const square = [[-0.5, 2, z + 0.5], [0.5, 2, z + 0.5], [0.5, 2, z - 0.5], [-0.5, 2, z - 0.5]];
  assert.deepEqual(projectPolygon(cam, square), square.map((p) => projectPoint(cam, p).slice(0, 2)));
  // floor strip from behind the camera to far ahead: clipped, every point finite
  const strip = [[-0.1, -2, 0], [0.1, -2, 0], [0.1, 5, 0], [-0.1, 5, 0]];
  const clipped = projectPolygon(cam, strip);
  assert.equal(clipped.length, 4);
  assert.ok(clipped.flat().every(Number.isFinite));
  assert.ok(clipped.some(([, v]) => v > 720 * 10)); // reaches far below the frame, as it should
  assert.deepEqual(projectPolygon(cam, strip.map(([x, , zz]) => [x, -3, zz])), []);
});

// ---------- world ----------

test('tag patterns: 8x8, black border, the three contest ids', () => {
  assert.deepEqual(TAG_IDS, [17, 245, 503]);
  assert.deepEqual(Object.keys(TAG_PATTERNS).map(Number), TAG_IDS);
  for (const rows of Object.values(TAG_PATTERNS)) {
    assert.equal(rows.length, 8);
    for (const r of rows) assert.match(r, /^0[01]{6}0$/);
    assert.equal(rows[0], '00000000');
    assert.equal(rows[7], '00000000');
  }
});

test('tagPoint: corners of the black square face -Y, u right, v down', () => {
  const tag = { id: 17, center: [1, 3, 1] };
  const h = TAG_SIZE_M / 2;
  assert.deepEqual(tagPoint(tag, 0, 0), [1 - h, 3, 1 + h]); // top-left as seen from the front
  assert.deepEqual(tagPoint(tag, 1, 1), [1 + h, 3, 1 - h]);
  assert.deepEqual(tagPoint(tag, 0.5, 0.5), [1, 3, 1]);
});

const inFrame = (p, margin = 0) => p && p[0] >= margin && p[0] <= 1280 - margin && p[1] >= margin && p[1] <= 720 - margin;
const UNDERWATER_HFOV = (2 * Math.atan(Math.tan((35 * Math.PI) / 180) / 1.333) * 180) / Math.PI; // 70 deg lens

for (const hfovDeg of [70, UNDERWATER_HFOV]) {
  test(`scenes start with the props in view (hfov ${hfovDeg.toFixed(1)})`, () => {
    let cam = simCamera(simInitial('tags'), { hfovDeg });
    for (const tag of TAG_WALL.tags) {
      for (const [u, v] of [[-1 / 8, -1 / 8], [9 / 8, 9 / 8]]) assert.ok(inFrame(projectPoint(cam, tagPoint(tag, u, v))), `tag ${tag.id}`);
      // big enough for the detector: at least 5 px per cell
      const a = projectPoint(cam, tagPoint(tag, 0, 0.5)), b = projectPoint(cam, tagPoint(tag, 1, 0.5));
      assert.ok((b[0] - a[0]) / 8 >= 5, `tag ${tag.id}: ${(b[0] - a[0]) / 8} px per cell`);
    }
    cam = simCamera(simInitial('dock'), { hfovDeg });
    for (const cell of DOCK.cells) assert.ok(inFrame(projectPoint(cam, cell.tag.center), 40), `dock tag ${cell.id}`);
    cam = simCamera(simInitial('line'), { hfovDeg });
    assert.ok(inFrame(projectPoint(cam, [LINE.x, LINE.tapes[0], 0])), 'start tape');
    cam = simCamera(simInitial('poles'), { hfovDeg });
    for (const p of POLES) {
      assert.ok(inFrame(projectPoint(cam, [p.x, p.y, 0])), `${p.color} pole foot`);
      assert.ok(inFrame(projectPoint(cam, [p.x, p.y, POLE.height + POLE.ballD])), `${p.color} ball`);
    }
    cam = simCamera(simInitial('hook'), { hfovDeg });
    const [ox, oy] = HOOK.object.center;
    assert.ok(inFrame(projectPoint(cam, [ox, oy, HOOK.object.size[2] + HOOK.handle.height])), 'hook handle');
  });
}

test('dock: three 70 cm chambers side by side, a tag above each entrance', () => {
  assert.equal(DOCK.cells.length, 3);
  assert.deepEqual([...DOCK.cells.map((c) => c.id)].sort((a, b) => a - b), TAG_IDS);
  for (const [i, c] of DOCK.cells.entries()) {
    assert.equal(c.index, i);
    assert.ok(near(c.x1 - c.x0, DOCK.cell));
    if (i) assert.ok(near(c.x0, DOCK.cells[i - 1].x1));
    assert.equal(c.tag.id, c.id);
    assert.ok(near(c.tag.center[0], c.entrance[0]));
    const tagBottom = c.tag.center[2] - (TAG_SIZE_M * 10) / 8 / 2; // incl. the white quiet zone
    assert.ok(tagBottom > DOCK.cell + DOCK.pipeD / 2, 'tag clears the top bar');
  }
  assert.equal(DOCK.bars.length, 20); // 4 long bars, 8 depth bars, 8 posts
  const lengths = DOCK.bars.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  assert.equal(lengths.filter((l) => near(l, 3 * DOCK.cell)).length, 4);
  assert.equal(lengths.filter((l) => near(l, DOCK.cell)).length, 16);
});

test('line: tapes at the start and every 50 cm, all on the line', () => {
  assert.deepEqual(LINE.tapes, [0, 0.5, 1.0, 1.5]);
  for (const y of LINE.tapes) assert.ok(y > LINE.y[0] && y < LINE.y[1]);
  assert.ok(LINE.tapeLength > LINE.width);
});

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const detectedAs = (hex) => Object.keys(DEFAULT_COLORS).filter((n) => inRange(rgbToHsv(...rgb(hex)), DEFAULT_COLORS[n]));

test('palette: each pole is found as its own colour, nothing else is found at all', () => {
  assert.deepEqual(POLES.map((p) => p.color).sort(), ['blue', 'red', 'yellow']);
  for (const p of POLES) assert.deepEqual(detectedAs(PALETTE[p.color]), [p.color], p.color);
  for (const [name, hex] of Object.entries(PALETTE)) {
    if (['red', 'yellow', 'blue'].includes(name)) continue;
    assert.deepEqual(detectedAs(hex), [], name);
    // water and floor keep a safety margin under the blue saturation limit (noise, shading)
    if (['waterTop', 'waterDeep', 'floor', 'grout'].includes(name)) assert.ok(rgbToHsv(...rgb(hex))[1] <= 130, name);
  }
});
