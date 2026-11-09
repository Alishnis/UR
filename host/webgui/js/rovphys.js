// Rigid-body physics of OUR ROV for the flight simulator (sim.html). Pure, unit-tested.
//
// The ROV is a list of parts (PVC frame, the box with the electronics, three thrusters, cables, ballast),
// each with its mass, the water it displaces and where it sits. From those: total mass, centre of mass
// (CoM), buoyancy and centre of buoyancy (CoB), inertia. Each step: gravity pulls every part down at its
// own position, buoyancy pushes every part up at its own position (only the part that is under water),
// the thrusters push at their mounts, water drag slows it. Forces that do not pass through the CoM make
// the ROV pitch and roll, exactly the effect to practise for.
//
// Body frame: x right, y forward, z up (right-handed), origin = the centre of the PVC frame.
// World frame (same as sim.js): X right, Y forward, Z up, pool floor z = 0, surface z = POOL.depth.
// UI units are grams, millilitres and centimetres; inside everything is kg, m3, m, N.

import { POOL } from './sim.js';

export const RHO = 1000; // kg/m3, pool water
export const G = 9.81;
export const STEEL_DENSITY = 7.85; // g/mL, ballast

// Our ROV as described: two horizontal thrusters at the rear on the left and right sides at mid height,
// the up thruster in the middle fixed to the box, the box (ESP32, camera, electronics) in the middle
// towards the front. Thrusters 130 g, box 450 g. Volumes and the frame are estimates from the photo:
// CHANGE THEM to what you measure (a box of 20 x 10 x 11 cm displaces 2.2 litres = 2.2 kg of lift).
export const DEFAULT_PARTS = [
  { id: 'frame', label: 'PVC frame (pipes flooded)', mass: 600, vol: 430, pos: [0, 0, 0], size: [30, 40, 30] },
  { id: 'box', label: 'Box (ESP32, camera, electronics)', mass: 450, vol: 2200, pos: [2, 6, 3], size: [10, 20, 11] },
  { id: 'thrL', label: 'Left thruster', mass: 130, vol: 60, pos: [-17, -15, 0], size: [6, 9, 6] },
  { id: 'thrR', label: 'Right thruster', mass: 130, vol: 60, pos: [17, -15, 0], size: [6, 9, 6] },
  { id: 'thrV', label: 'Up thruster', mass: 130, vol: 60, pos: [0, 0, 9], size: [6, 6, 9] },
  { id: 'cables', label: 'Cables, connectors, glue', mass: 150, vol: 70, pos: [0, -4, 0], size: [10, 10, 10] },
  { id: 'ballast', label: 'Ballast (steel, mL auto)', mass: 0, vol: 0, pos: [0, 0, -14], size: [12, 12, 2] },
];

// Which part each thruster is, and which way it pushes (body frame) for a positive command.
export const THRUSTERS = {
  left: { part: 'thrL', dir: [0, 1, 0] },
  right: { part: 'thrR', dir: [0, 1, 0] },
  vert: { part: 'thrV', dir: [0, 0, 1] },
};

// The camera sits inside the box at its front, looking 20 deg down.
export const CAMERA = { part: 'box', tiltDeg: 20 };

export const DEFAULT_PARAMS = {
  thrustN: 4.0,      // thrust of one thruster at +-150 us (command 0.3), N: a guess, measure it (slider)
  refCmd: 0.3,       // the command thrustN belongs to; thrust keeps rising beyond it up to the limit
  reverseFrac: 0.7,  // propellers push less backwards
  deadband: 0.04,    // ESC dead band around 1500 us, as a command (0.04 = 20 us)
  limit: 0.6,        // firmware clamp: +-300 us of 500 (60 %)
  motorTau: 0.15,    // s, propeller spin-up
  dragQuad: [50, 40, 60], // N per (m/s)^2 along body x, y, z (frame + box cross-sections)
  dragLin: 3,        // N per m/s
  rotQuad: 1.2,      // N m per (rad/s)^2
  rotLin: 0.25,      // N m per rad/s
  addedMass: 0.7,    // water dragged along: fraction of the mass, translation
  addedInertia: 0.5, // same for rotation
  current: [0, 0, 0], // steady water push on the ROV, world N (practice in a current)
};

// ---------- small vector helpers ----------

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const n = norm(a);
  return n > 1e-12 ? mul(a, 1 / n) : [0, 0, 1];
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const vec = { add, sub, mul, dot, cross, norm, unit };

// Orientation: R = [ex, ey, ez], the body axes in world coordinates.
export const toWorld = (R, b) => add(add(mul(R[0], b[0]), mul(R[1], b[1])), mul(R[2], b[2]));
export const toBody = (R, w) => [dot(R[0], w), dot(R[1], w), dot(R[2], w)];

// ---------- the body from its parts ----------

const partVolumeMl = (p) => (p.id === 'ballast' ? fin(p.mass) / STEEL_DENSITY : fin(p.vol));

// parts (UI units) -> {mass kg, volume m3, com, cob (body, m), inertia [Ixx, Iyy, Izz] about the CoM,
// parts in SI, corners for contacts}.
export function computeBody(parts = DEFAULT_PARTS) {
  const P = parts.map((p) => ({
    id: p.id,
    mass: Math.max(0, fin(p.mass)) / 1000,
    vol: Math.max(0, partVolumeMl(p)) * 1e-6,
    pos: (p.pos ?? [0, 0, 0]).map((v) => fin(v) / 100),
    size: (p.size ?? [5, 5, 5]).map((v) => Math.max(0.01, fin(v, 5) / 100)),
  }));
  const mass = P.reduce((s, p) => s + p.mass, 0) || 1e-3;
  const volume = P.reduce((s, p) => s + p.vol, 0);
  const wsum = (key) => P.reduce((s, p) => add(s, mul(p.pos, p[key])), [0, 0, 0]);
  const com = mul(wsum('mass'), 1 / mass);
  const cob = volume > 0 ? mul(wsum('vol'), 1 / volume) : [...com];
  const inertia = [0, 0, 0];
  for (const p of P) {
    const r = sub(p.pos, com);
    const [sx, sy, sz] = p.size;
    const own = [(sy * sy + sz * sz) / 12, (sx * sx + sz * sz) / 12, (sx * sx + sy * sy) / 12];
    const pt = [r[1] * r[1] + r[2] * r[2], r[0] * r[0] + r[2] * r[2], r[0] * r[0] + r[1] * r[1]];
    for (let i = 0; i < 3; i++) inertia[i] += p.mass * (own[i] + pt[i]);
  }
  for (let i = 0; i < 3; i++) inertia[i] = Math.max(inertia[i], 1e-3);
  // contact points: the corners of the frame and of the box, relative to the CoM
  const corners = [];
  for (const id of ['frame', 'box']) {
    const p = P.find((q) => q.id === id);
    if (!p) continue;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push(sub(add(p.pos, [sx * p.size[0] / 2, sy * p.size[1] / 2, sz * p.size[2] / 2]), com));
    }
  }
  // where the water drag acts: the middle of what the water sees (frame and box outlines, weighted by
  // their outside volume), NOT the centre of mass. Equal thrust on both sides then goes straight even when
  // the box and ballast sit off-centre, as on the real robot.
  let dw = 0, dsum = [0, 0, 0];
  for (const id of ['frame', 'box']) {
    const p = P.find((q) => q.id === id);
    if (!p) continue;
    const w = p.size[0] * p.size[1] * p.size[2];
    dw += w;
    dsum = add(dsum, mul(p.pos, w));
  }
  const dragCentre = dw > 0 ? mul(dsum, 1 / dw) : [...com];
  return { parts: P, mass, volume, com, cob, dragCentre, inertia, corners, netBuoyancyN: (RHO * volume - mass) * G };
}

// ---------- thrust ----------

// Command u (fraction of 500 us, as the D line carries it) -> thrust in N. Dead band, firmware clamp,
// thrust rising a bit faster than linearly, weaker backwards.
export function thrustFromCommand(u, prm = DEFAULT_PARAMS) {
  const a = Math.min(Math.abs(fin(u)), prm.limit);
  if (a <= prm.deadband) return 0;
  const f = prm.thrustN * ((a - prm.deadband) / (prm.refCmd - prm.deadband)) ** 1.3;
  return u > 0 ? f : -f * prm.reverseFrac;
}

// ---------- state and step ----------

const LEVEL = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// Start level at (x, y) facing `heading` (deg, + = right), CoM `depth` m below the surface.
export function physInitial({ x = 0, y = 0, heading = 0, depth = 1 } = {}) {
  const h = (fin(heading) * Math.PI) / 180;
  const R = [[Math.cos(h), -Math.sin(h), 0], [Math.sin(h), Math.cos(h), 0], [0, 0, 1]];
  return {
    c: [fin(x), fin(y), POOL.depth - fin(depth, 1)], v: [0, 0, 0], w: [0, 0, 0], R,
    force: { left: 0, right: 0, vert: 0 }, t: 0, wet: 1, onFloor: false,
  };
}

// Small body rotation by angle vector a (rad, body frame), Rodrigues.
function rotate(R, a) {
  const th = norm(a);
  if (th < 1e-12) return R;
  const k = mul(a, 1 / th), c = Math.cos(th), s = Math.sin(th);
  const rot = (v) => add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
  // new body axes, expressed in the old body frame, then to world
  const cols = [rot([1, 0, 0]), rot([0, 1, 0]), rot([0, 0, 1])];
  const nR = cols.map((b) => toWorld(R, b));
  const ez = unit(nR[2]);
  const ex = unit(cross(nR[1], ez));
  return [ex, cross(ez, ex), ez];
}

const WALL_K = 3000, WALL_C = 80, FLOOR_FRICTION = 40;

// One step. cmd: {left, right, vert} commands (-1..1, the D line). Returns the next state and the
// forces of this step for drawing ({thrusters N, buoyancy N, gravity N}).
export function physStep(state, body, cmd, dt, prm = DEFAULT_PARAMS) {
  let s = state;
  const total = clamp(fin(dt), 0, 0.1);
  const n = Math.max(1, Math.ceil(total / 0.004));
  const h = total / n;
  for (let i = 0; i < n; i++) s = substep(s, body, cmd, h, prm);
  return s;
}

function substep(st, body, cmd, h, prm) {
  const { R } = st;
  const S = POOL.depth;
  let F = [...prm.current];
  let T = [0, 0, 0];
  const apply = (fWorld, rBody) => {
    F = add(F, fWorld);
    T = add(T, cross(rBody, toBody(R, fWorld)));
  };
  // gravity and buoyancy per part (buoyancy only for the part under water)
  let wetVol = 0;
  for (const p of body.parts) {
    const r = sub(p.pos, body.com);
    const z = st.c[2] + toWorld(R, r)[2];
    const hz = 0.5 * (Math.abs(R[0][2]) * p.size[0] + Math.abs(R[1][2]) * p.size[1] + Math.abs(R[2][2]) * p.size[2]);
    const frac = clamp((S - (z - hz)) / (2 * hz), 0, 1);
    wetVol += p.vol * frac;
    apply([0, 0, RHO * G * p.vol * frac - p.mass * G], r);
  }
  const wet = body.volume > 0 ? wetVol / body.volume : 1;
  // thrusters with spin-up lag
  const k = Math.min(1, h / prm.motorTau);
  const force = {};
  for (const [name, t] of Object.entries(THRUSTERS)) {
    const target = thrustFromCommand(cmd?.[name], prm);
    force[name] = st.force[name] + (target - st.force[name]) * k;
    const p = body.parts.find((q) => q.id === t.part);
    if (p && wet > 0.05) apply(toWorld(R, mul(t.dir, force[name] * Math.min(1, wet * 1.5))), sub(p.pos, body.com));
  }
  // water drag (body axes), acting at the drag centre
  const rd = sub(body.dragCentre ?? body.com, body.com);
  const vb = add(toBody(R, st.v), cross(st.w, rd));
  const drag = vb.map((v, i) => -(prm.dragLin * v + prm.dragQuad[i] * Math.abs(v) * v) * wet);
  apply(toWorld(R, drag), rd);
  T = add(T, st.w.map((w) => -(prm.rotLin * w + prm.rotQuad * Math.abs(w) * w) * (0.2 + 0.8 * wet)));
  // floor and walls: springs at the corners of the frame and the box
  let onFloor = false;
  for (const q of body.corners) {
    const qw = toWorld(R, q);
    const P = add(st.c, qw);
    const vP = add(st.v, toWorld(R, cross(st.w, q)));
    const f = [0, 0, 0];
    if (P[2] < 0) {
      onFloor = true;
      f[2] += -WALL_K * P[2] - WALL_C * Math.min(0, vP[2]);
      f[0] -= FLOOR_FRICTION * vP[0];
      f[1] -= FLOOR_FRICTION * vP[1];
    }
    for (const [ax, lo, hi] of [[0, POOL.xMin, POOL.xMax], [1, POOL.yMin, POOL.yMax]]) {
      if (P[ax] < lo) f[ax] += WALL_K * (lo - P[ax]) - WALL_C * Math.min(0, vP[ax]);
      if (P[ax] > hi) f[ax] -= WALL_K * (P[ax] - hi) + WALL_C * Math.max(0, vP[ax]);
    }
    if (f[0] || f[1] || f[2]) apply(f, q);
  }
  // integrate (semi-implicit Euler); added mass only for the part in the water
  const m = body.mass * (1 + prm.addedMass * wet);
  const v = add(st.v, mul(F, h / m));
  const c = add(st.c, mul(v, h));
  const I = body.inertia.map((x) => x * (1 + prm.addedInertia * wet));
  const Iw = st.w.map((w, i) => I[i] * w);
  const gyro = cross(st.w, Iw);
  const w = st.w.map((wi, i) => wi + ((T[i] - gyro[i]) / I[i]) * h);
  const out = { ...st, c, v, w, R: rotate(R, mul(w, h)), force, t: st.t + h, wet, onFloor };
  return [out.c, out.v, out.w].flat().every(Number.isFinite) ? out : { ...physInitial(), t: st.t };
}

// ---------- trimming ----------

// Steel ballast that leaves +targetG of float AND sits where the ROV hangs level (centre of mass straight
// under the centre of buoyancy), at height z (cm, low in the frame), kept inside the frame.
// parts in UI units -> new parts (a copy) with the ballast mass and x, y set.
export function levelBallast(parts, { targetG = 40, z = -14 } = {}) {
  const out = parts.map((p) => ({ ...p, pos: [...p.pos], size: [...p.size] }));
  const ballast = out.find((p) => p.id === 'ballast');
  if (!ballast) return out;
  const frame = out.find((p) => p.id === 'frame');
  const half = frame ? [frame.size[0] / 2 - 2, frame.size[1] / 2 - 2] : [12, 18];
  ballast.mass = 0;
  ballast.pos = [0, 0, z];
  const b0 = computeBody(out);
  const netG = (RHO * b0.volume - b0.mass) * 1000;
  const mb = netG > targetG ? (netG - targetG) / (1 - 1 / STEEL_DENSITY) : 0;
  if (mb <= 0) return out;
  ballast.mass = Math.round(mb);
  const M0 = b0.mass * 1000; // g
  for (let i = 0; i < 4; i++) { // the ballast's own volume moves the CoB a little: settle in a few rounds
    const cob = computeBody(out).cob.map((v) => v * 100);
    for (const k of [0, 1]) {
      const want = ((M0 + mb) * cob[k] - M0 * b0.com[k] * 100) / mb;
      ballast.pos[k] = Math.round(clamp(want, -half[k], half[k]) * 10) / 10;
    }
  }
  return out;
}

// Ready-made trims for practice. Each keeps the measured parts and only sets the ballast.
//   practice: what a real, careful trim in the pool gives ("90 % right"): almost neutral (+30 g, rises
//             slowly) with a small leftover tilt (~3 deg nose up, ~1 deg roll) to correct while driving.
//   perfect:  +40 g and exactly level (levelBallast).
//   raw:      no ballast at all, as built: it floats.
export const TRIMS = {
  practice: { label: 'Almost neutral (90 % trimmed): practice', targetG: 30, shift: [0.3, -0.8] },
  perfect: { label: 'Perfect: +40 g, level', targetG: 40, shift: [0, 0] },
  raw: { label: 'No ballast (as built): floats', targetG: null, shift: [0, 0] },
};
export const DEFAULT_TRIM = 'practice';

export function trimParts(parts, name = DEFAULT_TRIM) {
  const t = TRIMS[name] ?? TRIMS[DEFAULT_TRIM];
  if (t.targetG === null) {
    return parts.map((p) => (p.id === 'ballast' ? { ...p, mass: 0, pos: [...p.pos], size: [...p.size] } : { ...p, pos: [...p.pos], size: [...p.size] }));
  }
  const out = levelBallast(parts, { targetG: t.targetG });
  const ballast = out.find((p) => p.id === 'ballast');
  if (ballast && ballast.mass > 0) {
    ballast.pos[0] = Math.round((ballast.pos[0] + t.shift[0]) * 10) / 10;
    ballast.pos[1] = Math.round((ballast.pos[1] + t.shift[1]) * 10) / 10;
  }
  return out;
}

// ---------- what the pilot reads ----------

// Heading (deg, + = turned right), pitch (deg, + = nose up), roll (deg, + = right side down),
// depth of the CoM below the surface (m), speeds.
export function attitude(state) {
  const [ex, ey, ez] = state.R;
  const deg = 180 / Math.PI;
  return {
    heading: Math.atan2(ey[0], ey[1]) * deg,
    pitch: Math.asin(clamp(ey[2], -1, 1)) * deg,
    roll: Math.atan2(-ex[2], ez[2]) * deg,
    depth: POOL.depth - state.c[2],
    speed: Math.hypot(state.v[0], state.v[1]),
    climb: state.v[2],
    surge: dot(state.v, ey),
  };
}

// Where a body point (m, body frame) is in the world.
export function bodyPointWorld(state, body, b) {
  return add(state.c, toWorld(state.R, sub(b, body.com)));
}

// Camera pose for sim.js / testscene.js drawing: {pos, right, down, fwd}.
export function cameraPose(state, body, tiltDeg = CAMERA.tiltDeg) {
  const box = body.parts.find((p) => p.id === CAMERA.part);
  const at = box ? [box.pos[0], box.pos[1] + box.size[1] / 2 - 0.01, box.pos[2]] : [0, 0.2, 0];
  const t = (tiltDeg * Math.PI) / 180;
  const fwdB = [0, Math.cos(t), -Math.sin(t)];
  const upB = [0, Math.sin(t), Math.cos(t)];
  return {
    pos: bodyPointWorld(state, body, at),
    right: toWorld(state.R, [1, 0, 0]),
    down: mul(toWorld(state.R, upB), -1),
    fwd: toWorld(state.R, fwdB),
  };
}

// Static balance, from the parts alone: what to expect before the dive.
export function balanceReport(body, prm = DEFAULT_PARAMS) {
  const B = RHO * G * body.volume;
  const netG = (RHO * body.volume - body.mass) * 1000; // + floats, - sinks (grams)
  const d = sub(body.cob, body.com); // CoB relative to CoM, m
  const stable = d[2] > 0.002;
  const stiff = B * Math.max(d[2], 1e-4); // N m per rad of tilt, fully submerged
  const deg = 180 / Math.PI;
  const thr = (id) => body.parts.find((p) => p.id === id)?.pos ?? [0, 0, 0];
  const lever = sub(mul(add(thr('thrL'), thr('thrR')), 0.5), body.com); // horizontal thrust line
  const dragUp = (body.dragCentre ?? body.com)[2] - body.com[2];
  const vLever = sub(thr('thrV'), body.com);
  const full = thrustFromCommand(prm.limit, prm);   // one thruster at the firmware limit
  const down = -thrustFromCommand(-prm.limit, prm);
  // ballast (steel, placed low) that leaves +40 g of float
  const steelNet = 1 - 1 / STEEL_DENSITY;
  return {
    massG: body.mass * 1000,
    volumeMl: body.volume * 1e6,
    netG,
    floats: netG > 0,
    ballastForNeutralG: netG > 40 ? (netG - 40) / steelNet : 0,
    holdDepthN: (netG / 1000) * G, // the up thruster must push this much down (+) or up (-)
    canHoldDepth: netG >= 0 ? (netG / 1000) * G <= down : (-netG / 1000) * G <= full,
    downThrustN: down,
    upThrustN: full,
    cobAboveComCm: d[2] * 100,
    cobAheadCm: d[1] * 100,
    cobRightCm: d[0] * 100,
    stable,
    // resting tilt when neutral and fully under water: CoB ends up straight above the CoM
    restPitchDeg: stable ? Math.atan2(d[1], d[2]) * deg : null,
    restRollDeg: stable ? -Math.atan2(d[0], d[2]) * deg : null,
    // both horizontal thrusters forward at full, steady speed: the pitch it leans to (+ = nose up). The
    // thrust pushes at the thruster height, the water holds back at the drag centre: the nose dips when
    // the thrust line is above the drag centre. (While speeding up it also dips if the thrust line is
    // above the CoM; the simulator shows that, this number is the steady lean.)
    forwardPitchDeg: stable ? -Math.atan2(2 * full * (lever[2] - dragUp), stiff) * deg : null,
    thrustLineAboveComCm: lever[2] * 100,
    thrustLineAboveDragCm: (lever[2] - dragUp) * 100,
    // up thruster at full: nose up when the thruster is ahead of the CoM
    upPitchDeg: stable ? Math.atan2(full * vLever[1], stiff) * deg : null,
    upRollDeg: stable ? -Math.atan2(full * vLever[0], stiff) * deg : null,
    upThrusterAheadCm: vLever[1] * 100,
    upThrusterRightCm: vLever[0] * 100,
  };
}
