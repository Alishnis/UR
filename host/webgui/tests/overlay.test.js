import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cssToPicture, drawTags, fitRect, frameMapper, kindInk, INK, label, makeView, overlapArea, pictureToDevice,
} from '../js/overlay.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('fitRect: object-fit contain letterboxes left/right or top/bottom', () => {
  assert.deepEqual(fitRect(1280, 720, 1280, 720), { x: 0, y: 0, w: 1280, h: 720 });
  // 16:9 picture in a 4:3 box: bars top and bottom
  assert.deepEqual(fitRect(1280, 720, 800, 600), { x: 0, y: 75, w: 800, h: 450 });
  // 4:3 picture in a 16:9 box: bars left and right
  assert.deepEqual(fitRect(640, 480, 1600, 900), { x: 200, y: 0, w: 1200, h: 900 });
});

test('fitRect: no picture size -> the whole box, never NaN', () => {
  assert.deepEqual(fitRect(0, 0, 640, 360), { x: 0, y: 0, w: 640, h: 360 });
  assert.deepEqual(fitRect(1280, 720, 0, 0), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(fitRect(undefined, null, NaN, 10), { x: 0, y: 0, w: 0, h: 10 });
});

test('makeView: device pixels follow devicePixelRatio', () => {
  const v = makeView({ cssW: 800, cssH: 600, dpr: 2, videoW: 1280, videoH: 720 });
  assert.equal(v.W, 1600);
  assert.equal(v.H, 1200);
  assert.deepEqual(v.rect, { x: 0, y: 150, w: 1600, h: 900 });
  assert.ok(v.hasVideo);
  assert.ok(v.k > 0);
  const bad = makeView({ cssW: 100, cssH: 50, dpr: NaN });
  assert.equal(bad.dpr, 1);
  assert.equal(bad.hasVideo, false);
});

test('frameMapper: JPEG pixels of a smaller sent frame land on the displayed video', () => {
  // video 1280x720 shown in 800x600 css at dpr 2; the detector got a 640x360 copy
  const v = makeView({ cssW: 800, cssH: 600, dpr: 2, videoW: 1280, videoH: 720 });
  const map = frameMapper(v, 640, 360);
  assert.deepEqual(map([0, 0]), [0, 150]);
  assert.deepEqual(map([640, 360]), [1600, 1050]);
  assert.deepEqual(map([320, 180]), [800, 600]);
});

test('cssToPicture: pointer -> 0..1 of the picture, null on the black bars', () => {
  const v = makeView({ cssW: 800, cssH: 600, dpr: 2, videoW: 1280, videoH: 720 });
  assert.deepEqual(cssToPicture(v, 400, 300), [0.5, 0.5]);
  assert.deepEqual(cssToPicture(v, 0, 75), [0, 0]);
  assert.equal(cssToPicture(v, 400, 40), null); // top bar
  assert.equal(cssToPicture(v, 400, 560), null); // bottom bar
  assert.equal(cssToPicture(makeView({ cssW: 800, cssH: 600 }), 400, 300), null); // no video
});

test('pictureToDevice is the inverse of cssToPicture (times dpr)', () => {
  const v = makeView({ cssW: 1000, cssH: 400, dpr: 1.5, videoW: 640, videoH: 480 });
  const p = cssToPicture(v, 520, 130);
  const [x, y] = pictureToDevice(v, p);
  close(x, 520 * 1.5);
  close(y, 130 * 1.5);
});

test('kindInk: kinds, explicit colours, fallback', () => {
  assert.equal(kindInk('ok'), INK.ok);
  assert.equal(kindInk('bad'), INK.bad);
  assert.equal(kindInk('#4dabf7'), '#4dabf7');
  assert.equal(kindInk('javascript:alert(1)'), INK.text);
  assert.equal(kindInk(undefined), INK.text);
});

// Enough of a 2D context for label(): every character is 10 px wide.
function textContext() {
  const noop = () => {};
  return {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
    measureText: (t) => ({ width: t.length * 10 }),
    beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop, fill: noop, stroke: noop, fillText: noop,
  };
}

test('label: within keeps the box inside the picture at its edges', () => {
  const ctx = textContext();
  const within = { x: 100, y: 0, w: 500, h: 300 };
  const free = label(ctx, 'SELECTED ID 503', 590, 50, { size: 20, align: 'center' });
  assert.ok(free.x + free.w > 600, 'without within the box sticks out');
  const right = label(ctx, 'SELECTED ID 503', 590, 50, { size: 20, align: 'center', within });
  close(right.x + right.w, 600);
  const left = label(ctx, 'ID 17', 90, 50, { size: 20, align: 'center', within });
  close(left.x, 100);
  const mid = label(ctx, 'ID 17', 350, 50, { size: 20, align: 'center', within });
  close(mid.x + mid.w / 2, 350);
});

test('overlapArea: sums the overlap with each rectangle', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 };
  assert.equal(overlapArea(box, []), 0);
  assert.equal(overlapArea(box, [[5, 5, 20, 20]]), 25);
  assert.equal(overlapArea(box, [[5, 5, 20, 20], [-5, -5, 2, 2]]), 29);
  assert.equal(overlapArea(box, [[20, 20, 30, 30]]), 0);
});

// Records strokes and texts of a 2D context (enough for the overlay helpers).
function recordingCtx() {
  const log = { strokes: [], texts: [] };
  let dash = [];
  const ctx = {
    log,
    set lineWidth(v) {}, set strokeStyle(v) { this._stroke = v; }, set fillStyle(v) {}, set font(v) {},
    set textAlign(v) {}, set textBaseline(v) {}, set lineJoin(v) {}, set lineCap(v) {}, set globalAlpha(v) {},
    setLineDash(d) { dash = d; }, getLineDash() { return dash; },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {}, arcTo() {}, rect() {}, fill() {}, fillRect() {},
    roundRect() {}, save() {}, restore() {}, strokeRect() {},
    stroke() { log.strokes.push({ color: this._stroke, dashed: dash.length > 0 }); },
    fillText(t) { log.texts.push(t); }, strokeText() {},
    measureText(t) { return { width: t.length * 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }; },
  };
  return ctx;
}

test('drawTags: weak (not trusted) tags are dashed grey "ID n?", never over a trusted one', () => {
  const view = makeView({ cssW: 1280, cssH: 720, dpr: 1, videoW: 1280, videoH: 720 });
  const quad = (x) => [[x, 100], [x + 50, 100], [x + 50, 150], [x, 150]];
  const ctx = recordingCtx();
  drawTags(ctx, view, {
    w: 1280, h: 720,
    tags: [{ id: 17, corners: quad(100), center: [125, 125] }],
    weak: [{ id: 245, corners: quad(400), center: [425, 125] }, { id: 17, corners: quad(700), center: [725, 125] }],
  });
  assert.ok(ctx.log.texts.includes('ID 245?'));
  assert.ok(!ctx.log.texts.includes('ID 17?'));
  assert.ok(ctx.log.strokes.some((s) => s.dashed && s.color === INK.dim));
  assert.ok(ctx.log.texts.some((t) => t.startsWith('ID 17')));
});
