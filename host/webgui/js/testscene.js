// Practice scenes for the "Test scene (simulator)" source: what the ROV camera would see, drawn from
// the sim.js state on a 1280x720 canvas and driven by the held W/A/S/D/R/F keys (also while
// DISARMED: nothing here reaches the motors). The frames go through the real detectors, so the
// props are drawn to be found: crisp tags with their quiet zone, a dark line with white tapes,
// saturated poles. Only the background gets haze, rays and noise.

import {
  DOCK, HOOK, LINE, PALETTE, POLE, POLES, POOL, TAG_PATTERNS, TAG_WALL,
  projectPoint, projectPolygon, simCamera, simInitial, simStep, tagPoint, toCamera,
} from './sim.js';

export const SCENE_LABELS = {
  tags: 'Tag wall (2.1)', dock: 'Docking frame (2.2)', line: 'Line on the floor (3)',
  hook: 'Object with handle (4)', poles: 'Three poles (5)',
};

const NEAR = 0.05;
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgb = ([r, g, b]) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
const mixRgb = (a, b, f) => a.map((x, i) => x + (b[i] - x) * f);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const WATER = hexRgb(PALETTE.waterDeep);

// [r, g, b] lit (f > 0, towards white) or shaded (f < 0, towards black).
const tint = (c, f) => mixRgb(c, f > 0 ? [255, 255, 255] : [0, 0, 0], Math.abs(f));
// Distance haze towards the water colour, capped so the detectors still see the props.
const fogged = (c, d, max = 0.25) => mixRgb(c, WATER, Math.min(max, 1 - Math.exp(-Math.max(0, d) / 10)));
const haze = (hex, d, max) => rgb(fogged(hexRgb(hex), d, max));
const shade = (hex, f) => rgb(tint(hexRgb(hex), f));

function fillPoly(ctx, pts, color) {
  if (pts.length < 3) return;
  ctx.beginPath();
  pts.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// World segment -> image segment clipped at the near plane: [[u, v, z], [u, v, z]] or null.
function projectSegment(cam, a, b) {
  const A = toCamera(cam, a), B = toCamera(cam, b);
  if (A[2] < NEAR && B[2] < NEAR) return null;
  const cut = (P, Q) => {
    const s = (NEAR - P[2]) / (Q[2] - P[2]);
    return [P[0] + (Q[0] - P[0]) * s, P[1] + (Q[1] - P[1]) * s, NEAR];
  };
  const pix = (P) => [(cam.fx * P[0]) / P[2] + cam.cx, (cam.fy * P[1]) / P[2] + cam.cy, P[2]];
  return [pix(A[2] < NEAR ? cut(A, B) : A), pix(B[2] < NEAR ? cut(B, A) : B)];
}

// A round bar of diameter d between two world points: a tapered quad plus round ends.
function drawBar(ctx, cam, a, b, d, color) {
  const s = projectSegment(cam, a, b);
  if (!s) return;
  const [[u0, v0, z0], [u1, v1, z1]] = s;
  const w0 = (cam.fx * d) / z0 / 2, w1 = (cam.fx * d) / z1 / 2;
  const len = Math.hypot(u1 - u0, v1 - v0) || 1;
  const nx = -(v1 - v0) / len, ny = (u1 - u0) / len;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(u0 + nx * w0, v0 + ny * w0);
  ctx.lineTo(u1 + nx * w1, v1 + ny * w1);
  ctx.lineTo(u1 - nx * w1, v1 - ny * w1);
  ctx.lineTo(u0 - nx * w0, v0 - ny * w0);
  ctx.closePath();
  ctx.fill();
  for (const [u, v, w] of [[u0, v0, w0], [u1, v1, w1]]) {
    ctx.beginPath();
    ctx.arc(u, v, w, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- background: water, floor, haze, light ----------

function drawWater(ctx, cam) {
  const g = ctx.createLinearGradient(0, 0, 0, cam.height);
  g.addColorStop(0, PALETTE.waterTop);
  g.addColorStop(1, PALETTE.waterDeep);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cam.width, cam.height);
}

const FLOOR_FAR = 40; // the floor is drawn well past the pool box so it fades into the haze

function drawFloor(ctx, cam) {
  const [cx, cy] = [cam.pos[0], cam.pos[1]];
  const floor = [[cx - FLOOR_FAR, cy - FLOOR_FAR, 0], [cx + FLOOR_FAR, cy - FLOOR_FAR, 0],
    [cx + FLOOR_FAR, cy + FLOOR_FAR, 0], [cx - FLOOR_FAR, cy + FLOOR_FAR, 0]];
  fillPoly(ctx, projectPolygon(cam, floor, NEAR), PALETTE.floor);

  const t = LINE.tile;
  for (let x = POOL.xMin; x <= POOL.xMax + 1e-9; x += t) {
    for (let y = POOL.yMin; y < POOL.yMax - 1e-9; y += t) grout(ctx, cam, [x, y, 0], [x, y + t, 0], PALETTE.grout);
  }
  for (let y = POOL.yMin; y <= POOL.yMax + 1e-9; y += t) {
    for (let x = POOL.xMin; x < POOL.xMax - 1e-9; x += t) grout(ctx, cam, [x, y, 0], [x + t, y, 0], PALETTE.grout);
  }
}

// One tile-long piece of grout (1 cm), so each piece gets a width for its own distance.
function grout(ctx, cam, a, b, color) {
  const s = projectSegment(cam, a, b);
  if (!s) return;
  const z = (s[0][2] + s[1][2]) / 2;
  if (z > 9) return; // far grout only makes moire
  ctx.strokeStyle = color;
  ctx.lineCap = 'butt';
  ctx.lineWidth = Math.min(4, Math.max(0.6, (cam.fx * 0.01) / z));
  ctx.beginPath();
  ctx.moveTo(s[0][0], s[0][1]);
  ctx.lineTo(s[1][0], s[1][1]);
  ctx.stroke();
}

// The far floor melts into the water (visibility is a few metres in a pool).
function drawHaze(ctx, cam) {
  const top = Math.max(0, cam.horizonY - 2);
  const bottom = cam.horizonY + cam.height * 0.32;
  if (bottom <= 0 || top >= cam.height) return;
  const f = Math.min(1, Math.max(0, cam.horizonY / cam.height));
  const water = mixRgb(hexRgb(PALETTE.waterTop), WATER, f);
  const g = ctx.createLinearGradient(0, cam.horizonY, 0, bottom);
  g.addColorStop(0, `rgba(${water.map(Math.round).join(', ')}, 0.92)`);
  g.addColorStop(1, `rgba(${water.map(Math.round).join(', ')}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, top, cam.width, bottom - top);
}

// Soft light shafts from the surface, drifting slowly. Very faint: background only.
function drawRays(ctx, cam, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 5; i++) {
    const x = cam.width * (0.1 + 0.2 * i) + Math.sin(t * 0.3 + i * 1.7) * cam.width * 0.05;
    const w = cam.width * (0.04 + 0.02 * Math.sin(t * 0.5 + i));
    const g = ctx.createLinearGradient(0, 0, 0, cam.height * 0.9);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.07)');
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, 0);
    ctx.lineTo(x + w / 2, 0);
    ctx.lineTo(x + w * 2.2 - cam.width * 0.08, cam.height * 0.9);
    ctx.lineTo(x - w * 1.2 - cam.width * 0.08, cam.height * 0.9);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---------- props ----------

// One tag36h11 tag from its bit pattern: plate (quiet zone and more), black square, white cells.
// Every cell is the exact perspective image of its square (corners projected), so the tag stays
// crisp at any angle. plate: margin around the black square in tag widths (1/8 = one cell).
function drawTag(ctx, cam, tag, plate = 1 / 8) {
  if (cam.pos[1] >= tag.center[1]) return; // behind the wall: tags face -Y
  const rows = TAG_PATTERNS[tag.id];
  if (!rows) return;
  const quad = (u0, v0, u1, v1) => {
    const pts = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => projectPoint(cam, tagPoint(tag, u, v), NEAR));
    return pts.every(Boolean) ? pts : null;
  };
  const d = dist3(cam.pos, tag.center);
  const outer = quad(-plate, -plate, 1 + plate, 1 + plate);
  const black = quad(0, 0, 1, 1);
  if (!outer || !black) return;
  fillPoly(ctx, outer, haze(PALETTE.plate, d));
  fillPoly(ctx, black, haze('#0a0a0a', d));
  const white = haze(PALETTE.plate, d);
  const eps = 0.003; // white runs overlap a hair, so no dark seams between rows
  for (let r = 0; r < 8; r++) {
    const row = rows[r];
    for (let c = 0; c < 8; c++) {
      if (row[c] !== '1') continue;
      let end = c;
      while (end + 1 < 8 && row[end + 1] === '1') end++;
      const q = quad(c / 8 - eps, r / 8 - eps, (end + 1) / 8 + eps, (r + 1) / 8 + eps);
      if (q) fillPoly(ctx, q, white);
      c = end;
    }
  }
}

function drawTagWall(ctx, cam) {
  const { y, x: [x0, x1], z: [z0, z1] } = TAG_WALL;
  const wall = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
  const d = dist3(cam.pos, [(x0 + x1) / 2, y, (z0 + z1) / 2]);
  fillPoly(ctx, projectPolygon(cam, wall, NEAR), haze(PALETTE.wall, d, 0.35));
  // wall tiles (faint, lighter grout): something to see moving while yawing between the tags
  const g = rgb(fogged(tint(hexRgb(PALETTE.wall), 0.14), d, 0.35));
  const step = 0.3;
  for (let x = x0; x <= x1 + 1e-9; x += step) {
    for (let z = z0; z < z1 - 1e-9; z += step) grout(ctx, cam, [x, y, z], [x, y, Math.min(z1, z + step)], g);
  }
  for (let z = z0; z <= z1 + 1e-9; z += step) {
    for (let x = x0; x < x1 - 1e-9; x += step) grout(ctx, cam, [x, y, z], [Math.min(x1, x + step), y, z], g);
  }
  // a darker cap along the top edge reads as thickness
  fillPoly(ctx, projectPolygon(cam, [[x0, y, z1 - 0.03], [x1, y, z1 - 0.03], [x1, y, z1], [x0, y, z1]], NEAR),
    rgb(fogged(tint(hexRgb(PALETTE.wall), -0.25), d, 0.35)));
  for (const tag of TAG_WALL.tags) drawTag(ctx, cam, tag);
}

function drawDock(ctx, cam) {
  const x0 = DOCK.cells[0].x0, x1 = DOCK.cells[DOCK.cells.length - 1].x1;
  const y0 = DOCK.frontY, y1 = DOCK.frontY + DOCK.cell;
  // shadow on the floor under the frame
  fillPoly(ctx, projectPolygon(cam, [[x0 - 0.05, y0 - 0.03, 0], [x1 + 0.05, y0 - 0.03, 0], [x1 + 0.05, y1 + 0.05, 0],
    [x0 - 0.05, y1 + 0.05, 0]], NEAR), shade(PALETTE.floor, -0.18));
  const bars = DOCK.bars
    .map(([a, b]) => ({ a, b, d: Math.max(dist3(cam.pos, a), dist3(cam.pos, b)) }))
    .sort((p, q) => q.d - p.d);
  for (const { a, b, d } of bars) drawBar(ctx, cam, a, b, DOCK.pipeD, haze(PALETTE.pipe, d, 0.3));
  for (const cell of DOCK.cells) drawTag(ctx, cam, cell.tag, 0.36);
}

function drawLineCourse(ctx, cam) {
  const { x, width, tapeWidth, tapeLength } = LINE;
  const [y0, y1] = LINE.y;
  const mid = [x, (y0 + y1) / 2, 0];
  fillPoly(ctx, projectPolygon(cam, [[x - width / 2, y0, 0], [x + width / 2, y0, 0], [x + width / 2, y1, 0],
    [x - width / 2, y1, 0]], NEAR), haze(PALETTE.line, dist3(cam.pos, mid)));
  for (const ty of LINE.tapes) {
    const pts = [[x - tapeLength / 2, ty - tapeWidth / 2, 0], [x + tapeLength / 2, ty - tapeWidth / 2, 0],
      [x + tapeLength / 2, ty + tapeWidth / 2, 0], [x - tapeLength / 2, ty + tapeWidth / 2, 0]];
    fillPoly(ctx, projectPolygon(cam, pts, NEAR), haze(PALETTE.tape, dist3(cam.pos, [x, ty, 0])));
  }
}

function drawPole(ctx, cam, pole) {
  const { height, diameter, ballD, baseD, baseH } = POLE;
  const d = dist3(cam.pos, [pole.x, pole.y, height / 2]);
  // base disc
  const disc = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    disc.push([pole.x + Math.cos(a) * baseD / 2, pole.y + Math.sin(a) * baseD / 2, baseH]);
  }
  fillPoly(ctx, projectPolygon(cam, disc, NEAR), haze(PALETTE.poleBase, d));
  // body: a flat strip facing the camera, lit from the left
  let dx = pole.x - cam.pos[0], dy = pole.y - cam.pos[1];
  const n = Math.hypot(dx, dy) || 1;
  dx /= n;
  dy /= n;
  const px = dy, py = -dx; // to the right as seen from the camera
  const strip = (s0, s1, color) => {
    const a = -diameter / 2 + s0 * diameter, b = -diameter / 2 + s1 * diameter;
    fillPoly(ctx, projectPolygon(cam, [[pole.x + px * a, pole.y + py * a, baseH], [pole.x + px * b, pole.y + py * b, baseH],
      [pole.x + px * b, pole.y + py * b, height], [pole.x + px * a, pole.y + py * a, height]], NEAR), color);
  };
  const base = fogged(hexRgb(PALETTE[pole.color]), d);
  strip(0, 1, rgb(base));
  strip(0.12, 0.3, rgb(tint(base, 0.16)));
  strip(0.78, 1, rgb(tint(base, -0.18)));
  // golf ball
  const c = projectPoint(cam, [pole.x, pole.y, height + ballD / 2], NEAR);
  if (c) {
    const R = (cam.fx * ballD) / 2 / c[2];
    const grad = ctx.createRadialGradient(c[0] - R * 0.35, c[1] - R * 0.35, R * 0.1, c[0], c[1], R);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, haze('#c9ced3', d));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c[0], c[1], R, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPoles(ctx, cam) {
  const order = [...POLES].sort((a, b) => dist3(cam.pos, [b.x, b.y, 0]) - dist3(cam.pos, [a.x, a.y, 0]));
  for (const pole of order) drawPole(ctx, cam, pole);
}

function drawHook(ctx, cam) {
  const [ox, oy] = HOOK.object.center;
  const [sx, sy, sz] = HOOK.object.size;
  const x0 = ox - sx / 2, x1 = ox + sx / 2, y0 = oy - sy / 2, y1 = oy + sy / 2;
  // baseline to carry the object back across
  fillPoly(ctx, projectPolygon(cam, [[-2, HOOK.baselineY - 0.015, 0], [2, HOOK.baselineY - 0.015, 0],
    [2, HOOK.baselineY + 0.015, 0], [-2, HOOK.baselineY + 0.015, 0]], NEAR), PALETTE.pipe);
  // soft shadow, then the visible faces of the box (normal towards the camera)
  fillPoly(ctx, projectPolygon(cam, [[x0 - 0.04, y0 - 0.02, 0], [x1 + 0.04, y0 - 0.02, 0], [x1 + 0.05, y1 + 0.06, 0],
    [x0 - 0.05, y1 + 0.06, 0]], NEAR), shade(PALETTE.floor, -0.22));
  const d = dist3(cam.pos, [ox, oy, sz / 2]);
  const faces = [
    { n: [0, -1, 0], p: [[x0, y0, 0], [x1, y0, 0], [x1, y0, sz], [x0, y0, sz]], f: -0.22 },
    { n: [0, 1, 0], p: [[x1, y1, 0], [x0, y1, 0], [x0, y1, sz], [x1, y1, sz]], f: -0.3 },
    { n: [-1, 0, 0], p: [[x0, y1, 0], [x0, y0, 0], [x0, y0, sz], [x0, y1, sz]], f: -0.32 },
    { n: [1, 0, 0], p: [[x1, y0, 0], [x1, y1, 0], [x1, y1, sz], [x1, y0, sz]], f: -0.12 },
    { n: [0, 0, 1], p: [[x0, y0, sz], [x1, y0, sz], [x1, y1, sz], [x0, y1, sz]], f: 0.08 },
  ];
  for (const face of faces) {
    const q = face.p[0];
    const toCam = [cam.pos[0] - q[0], cam.pos[1] - q[1], cam.pos[2] - q[2]];
    if (face.n[0] * toCam[0] + face.n[1] * toCam[1] + face.n[2] * toCam[2] <= 0) continue;
    fillPoly(ctx, projectPolygon(cam, face.p, NEAR), rgb(fogged(tint(hexRgb(PALETTE.object), face.f), d)));
  }
  // black U handle: two legs up from the lid and a bar across X
  const { width, height, thickness } = HOOK.handle;
  const hx = width / 2, top = sz + height;
  const color = haze(PALETTE.handle, d);
  drawBar(ctx, cam, [ox - hx, oy, sz], [ox - hx, oy, top], thickness, color);
  drawBar(ctx, cam, [ox + hx, oy, sz], [ox + hx, oy, top], thickness, color);
  drawBar(ctx, cam, [ox - hx, oy, top], [ox + hx, oy, top], thickness, color);
}

// ---------- sensor look: vignette and a little noise ----------

function makeNoise() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.round(Math.random() * 40);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function drawSensor(ctx, cam, noise) {
  const { width: W, height: H } = cam;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.6);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.2)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (!noise) return;
  ctx.save();
  ctx.globalAlpha = 0.35;
  const ox = Math.floor(Math.random() * 128), oy = Math.floor(Math.random() * 128);
  ctx.translate(-ox, -oy);
  ctx.fillStyle = ctx.createPattern(noise, 'repeat');
  ctx.fillRect(0, 0, W + 128, H + 128);
  ctx.restore();
}

// ---------- the scene ----------

const PROPS = { tags: drawTagWall, dock: drawDock, line: drawLineCourse, poles: drawPoles, hook: drawHook };

export class TestScene {
  // getAxes() -> {surge, yaw, heave} from the held keys; getHfov() -> the HFOV the detector is told
  // (so the tag pose the bridge computes matches the simulated geometry).
  constructor({ getAxes, getHfov } = {}) {
    this.getAxes = getAxes;
    this.getHfov = getHfov;
    this.state = simInitial('tags');
    this.t = 0;
    this.noise = null;
  }

  get scene() {
    return this.state.scene;
  }

  // Switching scene puts the ROV at that scene's start.
  setScene(name) {
    if (name && name !== this.state.scene && PROPS[name]) this.state = simInitial(name);
  }

  reset() {
    this.state = simInitial(this.state.scene);
  }

  draw(ctx, dt) {
    let axes = null;
    try {
      axes = this.getAxes?.() ?? null;
    } catch {
      axes = null;
    }
    this.state = simStep(this.state, axes, dt);
    this.t += Math.min(0.1, Math.max(0, dt || 0));
    if (!this.noise) {
      try {
        this.noise = makeNoise();
      } catch {
        this.noise = false;
      }
    }
    const cam = simCamera(this.state, {
      width: ctx.canvas.width, height: ctx.canvas.height, hfovDeg: Number(this.getHfov?.()) || 70,
    });
    ctx.imageSmoothingEnabled = false;
    drawWater(ctx, cam);
    drawRays(ctx, cam, this.t);
    drawFloor(ctx, cam);
    drawHaze(ctx, cam);
    PROPS[this.state.scene]?.(ctx, cam);
    drawSensor(ctx, cam, this.noise);
  }
}
