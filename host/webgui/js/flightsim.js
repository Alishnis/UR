// Flight simulator page (sim.html): our ROV's physics (rovphys.js) driven by the SAME controller, keys and
// buttons as the real GUI. Nothing here talks to the bridge or the robot.

import { CONFIG } from './config.js';
import { Controller } from './controller.js';
import { bindKeyboard, directionLevels, PAD_BUTTONS, REVERSE_CODE, THRUSTER_BUTTONS } from './controls.js';
import {
  attitude, balanceReport, bodyPointWorld, cameraPose, computeBody, DEFAULT_PARAMS, DEFAULT_PARTS, levelBallast, physInitial,
  physStep, STEEL_DENSITY, THRUSTERS, toWorld, vec,
} from './rovphys.js';
import { POLE, POLES, POOL, SCENES, projectPoint, projectPolygon, toCamera } from './sim.js';
import { drawPoolView } from './testscene.js';

const { add, sub, mul, cross, unit } = vec;
const $ = (id) => document.getElementById(id);
const STORE = 'rov.flightsim.v1';
const IDENTITY = { invert: false, gain: 1, deadBand: 0 };
const CAL = { outputSlot: { left: 0, right: 1, vert: 2 }, thrusters: { left: IDENTITY, right: IDENTITY, vert: IDENTITY } };
const deepCopy = (x) => JSON.parse(JSON.stringify(x));

// ---------- saved settings ----------

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (s && Array.isArray(s.parts) && s.parts.length === DEFAULT_PARTS.length) return s;
  } catch { /* defaults */ }
  return { parts: deepCopy(DEFAULT_PARTS), thrustN: DEFAULT_PARAMS.thrustN, current: 0, scene: 'poles', view: 'chase' };
}
const S = load();
const save = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(S));
  } catch { /* private window */ }
};

let params = { ...DEFAULT_PARAMS };
let body = computeBody(S.parts);
function rebuild() {
  params = { ...DEFAULT_PARAMS, thrustN: S.thrustN, current: [0, -S.current, 0] };
  body = computeBody(S.parts);
  renderReport();
  save();
}

// ---------- controller: the real one, always armed here ----------

let driveMode = 'latch';
try {
  driveMode = localStorage.getItem('rov.driveMode') === 'hold' ? 'hold' : 'latch';
} catch { /* default */ }
const controller = new Controller(CAL, { driveMode });
controller.arm();
const restart = () => {
  controller.estop();
  controller.arm();
};
bindKeyboard({ controller, onEstop: restart });

function resetPose() {
  const st = SCENES[S.scene]?.start ?? { x: 0, y: 0, heading: 0, depth: 1.2 };
  state = physInitial(st);
  restart();
}
let state = physInitial(SCENES[S.scene]?.start);

// ---------- UI wiring ----------

function holdButton(host, d, cls) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn dirbtn ${cls}`;
  btn.innerHTML = '<div class="dirfill"></div><span class="dirname"></span><span class="dirkey"></span><span class="dirlevel"></span>';
  btn.querySelector('.dirname').textContent = d.label;
  btn.querySelector('.dirkey').textContent = d.key;
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      btn.setPointerCapture(e.pointerId);
    } catch { /* ok */ }
    controller.keyDown(d.code);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, () => controller.keyUp(d.code));
  host.append(btn);
  return { btn, fill: btn.querySelector('.dirfill'), level: btn.querySelector('.dirlevel'), code: d.code };
}
const pad = Object.fromEntries(PAD_BUTTONS.map((d) => [d.id, holdButton($('dirpad'), d, `dir-${d.id}`)]));
const thr = Object.fromEntries(THRUSTER_BUTTONS.map((d) => [d.id, holdButton($('thrpad'), d, `thr-${d.id}`)]));
$('btn-reverse').addEventListener('click', (e) => {
  if (controller.keys.has(REVERSE_CODE)) controller.keyUp(REVERSE_CODE); else controller.keyDown(REVERSE_CODE);
  e.currentTarget.blur();
});
$('btn-zero').addEventListener('click', (e) => {
  controller.zeroLever();
  e.currentTarget.blur();
});
$('btn-reset').addEventListener('click', (e) => {
  resetPose();
  e.currentTarget.blur();
});

const modeSel = $('drive-mode');
modeSel.value = controller.driveMode;
modeSel.addEventListener('change', () => {
  controller.disarm();
  controller.setDriveMode(modeSel.value);
  controller.arm();
  modeSel.blur();
});

const maxIn = $('max');
maxIn.value = String(controller.maxThrottle);
const showMax = () => {
  $('max-val').textContent = `${controller.maxThrottle.toFixed(2)} (= +-${Math.round(controller.maxThrottle * 500)} us)`;
};
maxIn.addEventListener('input', () => {
  controller.setMaxThrottle(Number(maxIn.value));
  showMax();
});
showMax();

const sceneSel = $('scene');
sceneSel.value = S.scene;
sceneSel.addEventListener('change', () => {
  S.scene = sceneSel.value;
  save();
  resetPose();
  sceneSel.blur();
});

for (const b of document.querySelectorAll('.view')) {
  b.classList.toggle('on', b.dataset.view === S.view);
  b.addEventListener('click', () => {
    S.view = b.dataset.view;
    for (const x of document.querySelectorAll('.view')) x.classList.toggle('on', x === b);
    save();
    b.blur();
  });
}

function slider(id, key, fmt) {
  const el = $(id);
  el.value = String(S[key]);
  const show = () => {
    $(`${id}-val`).textContent = fmt(S[key]);
  };
  el.addEventListener('input', () => {
    S[key] = Number(el.value);
    show();
    rebuild();
  });
  show();
}
slider('thrust', 'thrustN', (v) => `${v.toFixed(1)} N per thruster at +-150 us (guess: measure if you can)`);
slider('current', 'current', (v) => (v ? `${v.toFixed(1)} N pushing the ROV back` : 'off'));

// parts table
const FIELDS = [['mass', null], ['vol', null], ['pos', 0], ['pos', 1], ['pos', 2]];
function buildParts() {
  const tb = $('parts');
  tb.textContent = '';
  S.parts.forEach((p) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = p.label;
    tr.append(name);
    for (const [key, i] of FIELDS) {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = key === 'pos' ? '1' : '10';
      const auto = key === 'vol' && p.id === 'ballast';
      inp.value = auto ? Math.round(p.mass / STEEL_DENSITY) : (i === null ? p[key] : p[key][i]);
      inp.disabled = auto;
      inp.addEventListener('change', () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        if (i === null) p[key] = Math.max(0, v);
        else p[key][i] = v;
        if (p.id === 'ballast' && key === 'mass') buildParts();
        rebuild();
      });
      td.append(inp);
      tr.append(td);
    }
    tb.append(tr);
  });
  const box = S.parts.find((p) => p.id === 'box');
  [$('box-w').value, $('box-l').value, $('box-h').value] = box.size.map(String);
}
for (const id of ['box-w', 'box-l', 'box-h']) {
  $(id).addEventListener('change', () => {
    const box = S.parts.find((p) => p.id === 'box');
    box.size = [Number($('box-w').value) || 1, Number($('box-l').value) || 1, Number($('box-h').value) || 1];
    rebuild();
  });
}
$('btn-box-vol').addEventListener('click', () => {
  const box = S.parts.find((p) => p.id === 'box');
  box.vol = Math.round(box.size[0] * box.size[1] * box.size[2]);
  buildParts();
  rebuild();
});
$('btn-neutral').addEventListener('click', () => {
  S.parts = levelBallast(S.parts);
  buildParts();
  rebuild();
  resetPose();
});
$('btn-defaults').addEventListener('click', () => {
  S.parts = deepCopy(DEFAULT_PARTS);
  S.thrustN = DEFAULT_PARAMS.thrustN;
  $('thrust').value = String(S.thrustN);
  $('thrust').dispatchEvent(new Event('input'));
  buildParts();
  rebuild();
  resetPose();
});

// ---------- balance report ----------

const f0 = (v) => (v === null ? '-' : v.toFixed(0));
const f1 = (v) => (v === null ? '-' : v.toFixed(1));
function line(cls, html) {
  return `<p class="${cls}">${html}</p>`;
}
function renderReport() {
  const r = balanceReport(body, params);
  const out = [];
  out.push(line('', `Mass <b>${f0(r.massG)} g</b>, displaces <b>${f0(r.volumeMl)} mL</b> of water.`));
  if (r.netG > 150) {
    out.push(line('bad', `<b>Floats with ${f0(r.netG)} g of lift.</b> The up thruster pushes down only ~${f1(r.downThrustN)} N `
      + `(${f0((r.downThrustN / 9.81) * 1000)} g)${r.canHoldDepth ? '' : ': it CANNOT keep the ROV under water'}. `
      + `Add about <b>${f0(r.ballastForNeutralG)} g of steel low in the frame</b> (button "Ballast: +40 g, level").`));
  } else if (r.netG > 0) {
    out.push(line('ok', `Slightly buoyant (+${f0(r.netG)} g): good. It rises slowly when you stop, so a dead robot comes up.`));
  } else {
    out.push(line(r.canHoldDepth ? 'warn' : 'bad', `<b>Sinks</b> (${f0(r.netG)} g). It lies on the floor if the power fails: `
      + 'remove ballast or add foam high up.'));
  }
  if (!r.stable) {
    out.push(line('bad', `<b>Centre of buoyancy is not above the centre of mass</b> (${f1(r.cobAboveComCm)} cm): it will roll over. `
      + 'Put the ballast LOW and the buoyant box HIGH.'));
  } else {
    out.push(line(r.cobAboveComCm >= 2 ? 'ok' : 'warn', `Centre of buoyancy ${f1(r.cobAboveComCm)} cm above the centre of mass: `
      + `${r.cobAboveComCm >= 2 ? 'it rights itself.' : 'weak: it wobbles and tips easily. Ballast lower helps.'}`));
    const rest = Math.abs(r.restPitchDeg) > 5 || Math.abs(r.restRollDeg) > 5 ? 'warn' : 'ok';
    out.push(line(rest, `At rest it hangs <b>${f1(r.restPitchDeg)}&deg; pitch</b> (+ nose up) and <b>${f1(r.restRollDeg)}&deg; roll</b> `
      + `(+ right side down). The buoyancy is ${f1(Math.abs(r.cobAheadCm))} cm ${r.cobAheadCm >= 0 ? 'ahead of' : 'behind'} `
      + `and ${f1(Math.abs(r.cobRightCm))} cm ${r.cobRightCm >= 0 ? 'right of' : 'left of'} the mass.`));
    out.push(line(Math.abs(r.forwardPitchDeg) > 8 ? 'warn' : 'ok', `Full forward: nose ${r.forwardPitchDeg <= 0 ? 'dips' : 'rises'} `
      + `about <b>${f1(Math.abs(r.forwardPitchDeg))}&deg;</b> (the side thrusters push ${f1(Math.abs(r.thrustLineAboveComCm))} cm `
      + `${r.thrustLineAboveComCm >= 0 ? 'above' : 'below'} the centre of mass).`));
    out.push(line(Math.abs(r.upPitchDeg) > 8 || Math.abs(r.upRollDeg) > 8 ? 'warn' : 'ok', `Up thruster at full: pitch `
      + `${f1(r.upPitchDeg)}&deg;, roll ${f1(r.upRollDeg)}&deg; (it sits ${f1(r.upThrusterAheadCm)} cm ahead and `
      + `${f1(r.upThrusterRightCm)} cm right of the centre of mass). Going DOWN tilts the opposite way.`));
  }
  if (r.floats || !r.canHoldDepth) {
    out.push(line('hint', `To stay at depth the up thruster must push ${f1(Math.abs(r.holdDepthN))} N `
      + `${r.holdDepthN >= 0 ? 'down' : 'up'} all the time.`));
  }
  $('report').innerHTML = out.join('');
}

// ---------- drawing helpers ----------

const NEAR = 0.05;
function lookAt(pos, target, W, H, hfovDeg = 60) {
  const fwd = unit(sub(target, pos));
  let right = cross(fwd, [0, 0, 1]);
  right = Math.hypot(...right) < 1e-6 ? [1, 0, 0] : unit(right);
  const down = cross(fwd, right);
  const fx = W / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { width: W, height: H, fx, fy: fx, cx: W / 2, cy: H / 2, pos, right, down, fwd, horizonY: horizonY(fwd, down, fx, H) };
}
function horizonY(fwd, down, fy, H) {
  const flat = unit([fwd[0], fwd[1], 0]);
  const z = vec.dot(flat, fwd);
  return z > 0.05 ? H / 2 + (fy * vec.dot(flat, down)) / z : (vec.dot(flat, down) > 0 ? H * 2 : -H);
}
function seg(cam, a, b) {
  const A = toCamera(cam, a), B = toCamera(cam, b);
  if (A[2] < NEAR && B[2] < NEAR) return null;
  const cut = (P, Q) => {
    const s = (NEAR - P[2]) / (Q[2] - P[2]);
    return [P[0] + (Q[0] - P[0]) * s, P[1] + (Q[1] - P[1]) * s, NEAR];
  };
  const pix = (P) => [(cam.fx * P[0]) / P[2] + cam.cx, (cam.fy * P[1]) / P[2] + cam.cy, P[2]];
  return [pix(A[2] < NEAR ? cut(A, B) : A), pix(B[2] < NEAR ? cut(B, A) : B)];
}
function strokeSeg(ctx, cam, a, b, widthM, color, minPx = 1) {
  const s = seg(cam, a, b);
  if (!s) return;
  const z = (s[0][2] + s[1][2]) / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(minPx, (cam.fx * widthM) / z);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(s[0][0], s[0][1]);
  ctx.lineTo(s[1][0], s[1][1]);
  ctx.stroke();
}
function fillPoly(ctx, pts, color) {
  if (pts.length < 3) return;
  ctx.beginPath();
  pts.forEach(([u, v], i) => (i ? ctx.lineTo(u, v) : ctx.moveTo(u, v)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
function arrow(ctx, cam, a, b, color, widthM = 0.012) {
  strokeSeg(ctx, cam, a, b, widthM, color, 2);
  const pb = projectPoint(cam, b);
  if (pb) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pb[0], pb[1], Math.max(3, (cam.fx * widthM * 1.6) / pb[2]), 0, Math.PI * 2);
    ctx.fill();
  }
}
function dot3(ctx, cam, p, color, rM = 0.018) {
  const q = projectPoint(cam, p);
  if (!q) return;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(q[0], q[1], Math.max(4, (cam.fx * rM) / q[2]), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

// ---------- outside view ----------

let viewHeading = 0;
function outsideCamera(W, H, dt) {
  const a = attitude(state);
  let d = a.heading - viewHeading;
  d = ((d + 540) % 360) - 180;
  viewHeading += d * Math.min(1, dt * 2.5);
  const h = (viewHeading * Math.PI) / 180;
  const fwdH = [Math.sin(h), Math.cos(h), 0];
  const rightH = [Math.cos(h), -Math.sin(h), 0];
  const c = state.c;
  if (S.view === 'side') return lookAt(add(c, mul(rightH, 1.5)), c, W, H, 55);
  if (S.view === 'behind') return lookAt(add(c, mul(fwdH, -1.5)), c, W, H, 55);
  return lookAt(add(add(c, mul(fwdH, -1.45)), [0, 0, 0.55]), add(c, [0, 0, 0.05]), W, H, 60);
}

function drawOutside(ctx, dt) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const cam = outsideCamera(W, H, dt);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#3f7f9e');
  g.addColorStop(1, '#173d50');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const S0 = POOL.depth;
  // floor, grid, walls, surface
  fillPoly(ctx, projectPolygon(cam, [[POOL.xMin, POOL.yMin, 0], [POOL.xMax, POOL.yMin, 0], [POOL.xMax, POOL.yMax, 0], [POOL.xMin, POOL.yMax, 0]]), '#5d93ad');
  for (let x = POOL.xMin; x <= POOL.xMax + 1e-9; x += 0.5) strokeSeg(ctx, cam, [x, POOL.yMin, 0], [x, POOL.yMax, 0], 0.008, '#4b7f98');
  for (let y = POOL.yMin; y <= POOL.yMax + 1e-9; y += 0.5) strokeSeg(ctx, cam, [POOL.xMin, y, 0], [POOL.xMax, y, 0], 0.008, '#4b7f98');
  const corners = [[POOL.xMin, POOL.yMin], [POOL.xMax, POOL.yMin], [POOL.xMax, POOL.yMax], [POOL.xMin, POOL.yMax]];
  for (let i = 0; i < 4; i++) {
    const [a, b] = [corners[i], corners[(i + 1) % 4]];
    strokeSeg(ctx, cam, [a[0], a[1], S0], [b[0], b[1], S0], 0.012, 'rgba(220,240,255,0.7)');
    strokeSeg(ctx, cam, [a[0], a[1], 0], [a[0], a[1], S0], 0.01, 'rgba(200,225,240,0.35)');
  }
  for (let x = POOL.xMin; x <= POOL.xMax + 1e-9; x += 1) strokeSeg(ctx, cam, [x, POOL.yMin, S0], [x, POOL.yMax, S0], 0.006, 'rgba(220,240,255,0.25)');

  const items = [];
  const push = (p, fn) => items.push({ z: toCamera(cam, p)[2], fn });
  // poles
  for (const p of POLES) {
    const top = [p.x, p.y, POLE.height];
    push([p.x, p.y, POLE.height / 2], () => {
      strokeSeg(ctx, cam, [p.x, p.y, 0], top, POLE.diameter, { red: '#d0312d', yellow: '#eed43a', blue: '#1d4fd8' }[p.color], 2);
      dot3(ctx, cam, add(top, [0, 0, 0.025]), '#f4f4f4', 0.022);
    });
  }
  // the ROV
  const W2 = (b) => bodyPointWorld(state, body, b);
  const frame = body.parts.find((p) => p.id === 'frame');
  const box = body.parts.find((p) => p.id === 'box');
  const corner = (p, sx, sy, sz) => W2(add(p.pos, [sx * p.size[0] / 2, sy * p.size[1] / 2, sz * p.size[2] / 2]));
  if (frame) {
    const edges = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      edges.push([corner(frame, -1, a, b), corner(frame, 1, a, b)]);
      edges.push([corner(frame, a, -1, b), corner(frame, a, 1, b)]);
      edges.push([corner(frame, a, b, -1), corner(frame, a, b, 1)]);
    }
    for (const [a, b] of edges) push(mul(add(a, b), 0.5), () => strokeSeg(ctx, cam, a, b, 0.022, '#eef0ea', 2));
  }
  if (box) {
    const faces = [
      [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [[-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1]],
      [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]],
    ];
    for (const f of faces) {
      const pts = f.map(([a, b, c]) => corner(box, a, b, c));
      const mid = mul(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 0.25);
      const n = unit(cross(sub(pts[1], pts[0]), sub(pts[3], pts[0])));
      const light = 0.55 + 0.45 * Math.abs(n[2]);
      const isFront = f.every(([, b]) => b === 1);
      push(mid, () => fillPoly(ctx, projectPolygon(cam, pts), isFront ? `rgba(70,80,90,0.95)` : `rgba(${Math.round(225 * light)},${Math.round(228 * light)},${Math.round(232 * light)},0.92)`));
    }
  }
  for (const [name, t] of Object.entries(THRUSTERS)) {
    const p = body.parts.find((q) => q.id === t.part);
    if (!p) continue;
    const c = W2(p.pos);
    const ax = toWorld(state.R, t.dir);
    push(c, () => {
      strokeSeg(ctx, cam, add(c, mul(ax, -0.045)), add(c, mul(ax, 0.045)), 0.06, '#39d353', 3);
      const f = state.force[name];
      if ($('show-forces').checked && Math.abs(f) > 0.05) {
        arrow(ctx, cam, c, add(c, mul(ax, f * 0.06)), f > 0 ? '#ff9f1a' : '#ff4d6d');
      }
    });
  }
  const com = state.c, cob = W2(body.cob);
  push(com, () => {
    if ($('show-forces').checked) {
      const Wn = body.mass * 9.81, Bn = body.volume * 1000 * 9.81 * state.wet;
      arrow(ctx, cam, com, add(com, [0, 0, -Wn * 0.025]), '#ffd43b', 0.01);
      arrow(ctx, cam, cob, add(cob, [0, 0, Bn * 0.025]), '#74c0fc', 0.01);
    }
    dot3(ctx, cam, com, '#ffd43b');
    dot3(ctx, cam, cob, '#4dabf7');
  });
  items.sort((a, b) => b.z - a.z);
  for (const it of items) it.fn();

  // HUD
  const a = attitude(state);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(10, 10, 330, 30);
  ctx.fillStyle = '#fff';
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.fillText(`depth ${a.depth.toFixed(2)} m   pitch ${a.pitch.toFixed(0)}°   roll ${a.roll.toFixed(0)}°`, 20, 31);
  if (state.wet < 0.97) banner(ctx, W, 'AT THE SURFACE: part of the ROV is out of the water', '#f5b942');
  else if (state.onFloor) banner(ctx, W, 'ON THE FLOOR', '#f5b942');
  if (Math.abs(a.roll) > 60 || Math.abs(a.pitch) > 60) banner(ctx, W, 'TIPPED OVER: press Reset position', '#ff5d5d', 80);
}
function banner(ctx, W, text, color, y = 50) {
  ctx.font = '700 18px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 24;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(W / 2 - w / 2, y, w, 32);
  ctx.fillStyle = color;
  ctx.fillText(text, W / 2 - w / 2 + 12, y + 22);
}

// ---------- onboard camera ----------

function drawOnboard(ctx, t) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const hfov = 52; // 70 deg in air behind a flat port
  const fx = W / 2 / Math.tan((hfov * Math.PI) / 360);
  const pose = cameraPose(state, body);
  const cam = { width: W, height: H, fx, fy: fx, cx: W / 2, cy: H / 2, ...pose, hfovDeg: hfov };
  cam.horizonY = horizonY(cam.fwd, cam.down, fx, H);
  if (cam.pos[2] > POOL.depth) {
    ctx.fillStyle = '#9fc7da';
    ctx.fillRect(0, 0, W, H);
  } else {
    drawPoolView(ctx, cam, S.scene, t, null);
  }
  const a = attitude(state);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(8, 8, 250, 26);
  ctx.fillStyle = '#fff';
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillText(`hdg ${a.heading.toFixed(0)}°  depth ${a.depth.toFixed(2)} m`, 16, 26);
}

// ---------- attitude: side view (pitch) and behind view (roll) ----------

function drawAttitude(ctx) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.fillStyle = '#0f2a38';
  ctx.fillRect(0, 0, W, H);
  const a = attitude(state);
  const frame = body.parts.find((p) => p.id === 'frame');
  const box = body.parts.find((p) => p.id === 'box');
  const scale = 420;
  const panel = (cx, angleDeg, axisA, axisB, title, value) => {
    const cy = H / 2 + 10;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(cx - 140, cy);
    ctx.lineTo(cx + 140, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-angleDeg * Math.PI) / 180);
    const rect = (p, fill, stroke) => {
      const w = p.size[axisA] * scale, h = p.size[axisB] * scale;
      const x = (p.pos[axisA] - body.com[axisA]) * scale, y = -(p.pos[2] - body.com[2]) * scale;
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 4;
      if (fill) ctx.fillRect(x - w / 2, y - h / 2, w, h);
      if (stroke) ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    };
    if (frame) rect(frame, null, '#eef0ea');
    if (box) rect(box, 'rgba(220,225,230,0.85)', null);
    for (const t of Object.values(THRUSTERS)) {
      const p = body.parts.find((q) => q.id === t.part);
      if (!p) continue;
      ctx.fillStyle = '#39d353';
      ctx.beginPath();
      ctx.arc((p.pos[axisA] - body.com[axisA]) * scale, -(p.pos[2] - body.com[2]) * scale, 10, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#4dabf7';
    ctx.beginPath();
    ctx.arc((body.cob[axisA] - body.com[axisA]) * scale, -(body.cob[2] - body.com[2]) * scale, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#ffd43b';
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = Math.abs(value) > 15 ? '#f5b942' : '#e6ebf0';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillText(`${title} ${value.toFixed(0)}°`, cx - 70, 34);
  };
  // side view: forward (body y) to the right, nose up = counter-clockwise
  panel(W * 0.27, a.pitch, 1, 2, 'pitch', a.pitch);
  // behind view: right (body x) to the right, right side down = clockwise
  panel(W * 0.75, -a.roll, 0, 2, 'roll', a.roll);
}

// ---------- telemetry and pad ----------

function renderPad() {
  const lv = directionLevels(controller.axes());
  for (const [id, el] of Object.entries(pad)) {
    el.fill.style.height = `${Math.round(lv[id] * 100)}%`;
    el.level.textContent = lv[id] > 0 ? `${Math.round(lv[id] * controller.levels)}/${controller.levels}` : '';
    el.btn.classList.toggle('pressed', controller.keys.has(el.code));
  }
  const d = controller.directLevels();
  for (const [id, el] of Object.entries(thr)) {
    const v = d[id];
    el.fill.style.height = `${Math.round(Math.abs(v) * 100)}%`;
    el.level.textContent = v ? `${v < 0 ? '-' : ''}${Math.round(Math.abs(v) * controller.levels)}/${controller.levels}` : '';
    el.btn.classList.toggle('pressed', controller.keys.has(el.code));
  }
  $('btn-reverse').classList.toggle('on', controller.keys.has(REVERSE_CODE));
}

function renderTele(slots) {
  const a = attitude(state);
  const cell = (label, value, warn) => `<div class="${warn ?? ''}"><b>${value}</b><span>${label}</span></div>`;
  const lvl = (x, w, b) => (Math.abs(x) > b ? 'bad' : Math.abs(x) > w ? 'warn' : '');
  $('tele').innerHTML = [
    cell('depth m', a.depth.toFixed(2), state.wet < 0.97 ? 'warn' : ''),
    cell('pitch ° (+ nose up)', a.pitch.toFixed(0), lvl(a.pitch, 10, 30)),
    cell('roll ° (+ right down)', a.roll.toFixed(0), lvl(a.roll, 10, 30)),
    cell('heading °', a.heading.toFixed(0)),
    cell('speed m/s', a.surge.toFixed(2)),
    cell('climb m/s', a.climb.toFixed(2)),
    cell('left / right N', `${state.force.left.toFixed(1)} / ${state.force.right.toFixed(1)}`),
    cell('up thruster N', state.force.vert.toFixed(1)),
    cell('D line (us)', slots.map((s) => Math.round(1500 + s * 500)).join(' ')),
  ].join('');
}

// ---------- main loop ----------

const outCtx = $('view-out').getContext('2d');
const camCtx = $('view-cam').getContext('2d');
const attCtx = $('view-att').getContext('2d');
let last = performance.now();
let simT = 0;
let teleAt = 0;
function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  const { slots } = controller.step(dt);
  const cmd = { left: slots[0], right: slots[1], vert: slots[2] };
  state = physStep(state, body, cmd, dt, params);
  simT += dt;
  drawOutside(outCtx, dt);
  drawOnboard(camCtx, simT);
  drawAttitude(attCtx);
  if (now - teleAt > 100) {
    teleAt = now;
    renderTele(slots);
    renderPad();
  }
  requestAnimationFrame(frame);
}

S.showForces = true;
buildParts();
rebuild();
requestAnimationFrame(frame);
