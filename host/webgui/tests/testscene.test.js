import test from 'node:test';
import assert from 'node:assert/strict';

import { SIM_SCENES } from '../js/sim.js';
import { SCENE_LABELS, TestScene } from '../js/testscene.js';
import { effectiveHfov } from '../js/vision_ui.js';

// A 2D context that accepts every call and remembers the filled paths' points, enough to run the
// scene code without a browser. The pictures themselves are checked end to end against the real
// detectors (see README, "Camera and missions 2-5").
function stubContext(width = 1280, height = 720) {
  const fills = [];
  let path = [];
  const grad = { addColorStop() {} };
  return {
    canvas: { width, height },
    fills,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true, lineCap: 'butt',
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    arc(x, y) { path.push([x, y]); },
    closePath() {},
    fill() { fills.push({ style: this.fillStyle, pts: path }); },
    stroke() {},
    fillRect() {},
    save() {}, restore() {}, translate() {},
  };
}

test('every simulator scene has a label and draws without errors', () => {
  for (const name of SIM_SCENES) {
    assert.ok(SCENE_LABELS[name], name);
    const scene = new TestScene({ getAxes: () => ({ surge: 0, yaw: 0, heave: 0 }), getHfov: () => 55.4 });
    scene.setScene(name);
    assert.equal(scene.scene, name);
    const ctx = stubContext();
    scene.draw(ctx, 1 / 30);
    assert.ok(ctx.fills.length > 5, `${name}: only ${ctx.fills.length} fills`);
    for (const f of ctx.fills) for (const [x, y] of f.pts) assert.ok(Number.isFinite(x) && Number.isFinite(y), name);
  }
});

test('held keys move the simulated ROV; reset puts it back', () => {
  let axes = { surge: 1, yaw: 0, heave: 0 };
  const scene = new TestScene({ getAxes: () => axes, getHfov: () => 70 });
  scene.setScene('line');
  const y0 = scene.state.y;
  for (let i = 0; i < 30; i++) scene.draw(stubContext(), 0.05);
  assert.ok(scene.state.y > y0 + 0.2, 'surge forward moves +Y at heading ~0');
  axes = { surge: 0, yaw: 1, heave: 0 };
  const h0 = scene.state.heading;
  for (let i = 0; i < 20; i++) scene.draw(stubContext(), 0.05);
  assert.ok(scene.state.heading > h0 + 10, 'D turns right');
  scene.reset();
  assert.equal(scene.state.y, -0.9);
});

test('a throwing getAxes does not stop the picture', () => {
  const scene = new TestScene({ getAxes: () => { throw new Error('no keys'); } });
  assert.doesNotThrow(() => scene.draw(stubContext(), 0.03));
});

test('effectiveHfov: a flat port narrows 70 deg to about 55.4 deg', () => {
  assert.equal(effectiveHfov(70, false), 70);
  assert.ok(Math.abs(effectiveHfov(70, true) - 55.4) < 0.1);
  assert.ok(effectiveHfov(120, true) < 120);
});
