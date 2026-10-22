// Practice simulator behind the "Test scene" camera source. Pure, unit-tested; testscene.js draws
// the picture from the state and the world constants below.
//
// World frame: X right, Y forward (away from the start), Z up, pool floor z = 0, surface z = POOL.depth.
// ROV pose: x, y (m), heading (deg, 0 = facing +Y, + = turned right), depth (m below the surface).
// Moves like the real ROV: surge, yaw and heave only, no sideways motion (3 thrusters).

const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export const SIM_SCENES = ['tags', 'dock', 'line', 'poles', 'hook'];
export const POOL = { xMin: -3, xMax: 3, yMin: -2, yMax: 5, depth: 2.0 };
export const ROV = { halfHeight: 0.15, camForward: 0.2 }; // camera sits at the front of the hull
export const SPEED = { surge: 0.35, yawDeg: 45, heave: 0.25, tau: 0.4 }; // full-key speeds; tau = inertia (s)

// Colours testscene.js paints with. Checked in tests/sim.test.js: the poles fall inside
// DEFAULT_COLORS (colors.js), water, floor and props fall inside none of them.
export const PALETTE = {
  waterTop: '#5b8fae', waterDeep: '#35596b', floor: '#78aac8', grout: '#6b98b3', wall: '#8fa3ad',
  pipe: '#e8ecef', plate: '#f4f4f4', line: '#161616', tape: '#f2f2f2', ball: '#f4f4f4', poleBase: '#3a3f44',
  red: '#d0312d', yellow: '#f2c230', blue: '#1d4fd8', object: '#8a9096', handle: '#121212',
};

// ---------- AprilTags (tag36h11, 16.2 cm black square) ----------

export const TAG_SIZE_M = 0.162;
export const TAG_IDS = [17, 245, 503];
// 8x8 cells including the black border, '1' = white. Draw ONE extra white cell of quiet zone
// all around (10x10 cells). Same patterns as host/tests/vision_synth.py.
export const TAG_PATTERNS = {
  17: ['00000000', '00011000', '01000110', '00110110', '00111010', '01100000', '00101100', '00000000'],
  245: ['00000000', '01110000', '01001010', '00001000', '01011100', '01011010', '00110000', '00000000'],
  503: ['00000000', '00111000', '00100000', '00001100', '01011110', '00000110', '01110100', '00000000'],
};

// Every tag faces -Y (towards the start). u, v: position on the black square, 0..1, u to the right
// and v down as seen from the front; -1/8 and 9/8 are the outer edge of the quiet zone.
export function tagPoint(tag, u, v, sizeM = TAG_SIZE_M) {
  const [cx, cy, cz] = tag.center;
  return [cx + (u - 0.5) * sizeM, cy, cz - (v - 0.5) * sizeM];
}

// ---------- scene layouts ----------

// 2.1: three tags on a wall 3 m ahead, spread so the pilot has to scan.
export const TAG_WALL = {
  y: 3.0,
  x: [-2.2, 2.2],
  z: [0, 1.8],
  tags: [
    { id: 245, center: [-1.1, 3.0, 0.8] },
    { id: 17, center: [0.1, 3.0, 1.15] },
    { id: 503, center: [1.15, 3.0, 0.7] },
  ],
};

// 2.2: frame 210 x 70 x 70 cm (three 70 cm chambers) on the floor, entrances facing -Y,
// a tag on a white plate above each entrance.
const CELL = 0.7;
const DOCK_X0 = -1.05, DOCK_Y0 = 3.0;
const DOCK_IDS = [503, 17, 245];
function dockBars() {
  const bars = [];
  const xs = [0, 1, 2, 3].map((i) => DOCK_X0 + i * CELL);
  const y1 = DOCK_Y0 + CELL;
  for (const y of [DOCK_Y0, y1]) for (const z of [0, CELL]) bars.push([[xs[0], y, z], [xs[3], y, z]]);
  for (const x of xs) {
    for (const z of [0, CELL]) bars.push([[x, DOCK_Y0, z], [x, y1, z]]);
    for (const y of [DOCK_Y0, y1]) bars.push([[x, y, 0], [x, y, CELL]]);
  }
  return bars;
}
export const DOCK = {
  cell: CELL,
  pipeD: 0.025,
  frontY: DOCK_Y0,
  cells: DOCK_IDS.map((id, i) => {
    const xc = DOCK_X0 + (i + 0.5) * CELL;
    return { index: i, id, x0: DOCK_X0 + i * CELL, x1: DOCK_X0 + (i + 1) * CELL,
      entrance: [xc, DOCK_Y0, CELL / 2], tag: { id, center: [xc, DOCK_Y0, CELL + 0.15] } };
  }),
  bars: dockBars(), // [[p0, p1], ...] pipe centre lines
};

// 3: black line along +Y on the floor, white tape at the start and every 50 cm (start, 1, 2, final).
export const LINE = {
  x: 0,
  y: [-0.15, 1.65], // line ends
  width: 0.04,
  tapes: [0, 0.5, 1.0, 1.5], // tape centres (y)
  tapeWidth: 0.05, // along the line
  tapeLength: 0.14, // across the line (wider than the line, like real tape)
  tile: 0.5, // floor tile size, grout lines between tiles
};

// 5: three poles with a golf ball on top.
export const POLE = { height: 0.8, diameter: 0.05, ballD: 0.0427, baseD: 0.16, baseH: 0.02 };
export const POLES = [
  { color: 'red', x: -0.8, y: 3.0 },
  { color: 'yellow', x: 0.1, y: 3.5 },
  { color: 'blue', x: 0.9, y: 2.8 },
];

// 4: grey object on the floor with a black U handle on top (legs up from the lid, bar across X).
export const HOOK = {
  object: { center: [0, 0.7], size: [0.3, 0.2, 0.12] }, // x, y on the floor; size x, y, z
  handle: { width: 0.16, height: 0.1, thickness: 0.02 },
  baselineY: 0, // carry the object back across this line
};

// Start pose and camera tilt (deg down) per scene.
export const SCENES = {
  tags: { start: { x: 0, y: 0.3, heading: 0, depth: 1.0 }, camTiltDeg: 0 },
  dock: { start: { x: 0.3, y: 0.6, heading: -5, depth: 1.55 }, camTiltDeg: 0 },
  line: { start: { x: 0.12, y: -0.9, heading: 6, depth: 1.4 }, camTiltDeg: 45 },
  poles: { start: { x: 0, y: 0, heading: 0, depth: 1.3 }, camTiltDeg: 10 },
  hook: { start: { x: -0.15, y: -0.4, heading: 0, depth: 1.2 }, camTiltDeg: 45 },
};

// ---------- motion ----------

export function simInitial(scene) {
  const name = SIM_SCENES.includes(scene) ? scene : 'tags';
  return { scene: name, ...SCENES[name].start, vSurge: 0, vYaw: 0, vHeave: 0, t: 0 };
}

const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// axes {surge, yaw, heave} in -1..1 (+heave = up), dt in seconds -> next state.
// Speeds follow the keys with a first-order lag (water drag + inertia). dt is capped at 0.1 s
// so a throttled background tab does not teleport the ROV.
export function simStep(state, axes, dt) {
  const step = clamp(num(dt), 0, 0.1);
  const a = (k) => clamp(num(axes?.[k]), -1, 1);
  const k = Math.min(1, step / SPEED.tau);
  const vSurge = state.vSurge + (a('surge') * SPEED.surge - state.vSurge) * k;
  const vYaw = state.vYaw + (a('yaw') * SPEED.yawDeg - state.vYaw) * k;
  const vHeave = state.vHeave + (a('heave') * SPEED.heave - state.vHeave) * k;
  const heading = wrapDeg(state.heading + vYaw * step);
  const h = heading * RAD;
  return {
    ...state,
    vSurge, vYaw, vHeave,
    heading,
    x: clamp(state.x + Math.sin(h) * vSurge * step, POOL.xMin, POOL.xMax),
    y: clamp(state.y + Math.cos(h) * vSurge * step, POOL.yMin, POOL.yMax),
    depth: clamp(state.depth - vHeave * step, ROV.halfHeight, POOL.depth - ROV.halfHeight),
    t: state.t + step,
  };
}

// ---------- camera ----------

// Pinhole camera on the ROV: square pixels, principal point in the middle, no distortion
// (the same model the bridge uses for the tag pose). opts: {width, height, hfovDeg, tiltDeg}.
export function simCamera(state, opts = {}) {
  const width = num(opts.width, 1280), height = num(opts.height, 720);
  const hfovDeg = clamp(num(opts.hfovDeg, 70), 10, 170);
  const tiltDeg = num(opts.tiltDeg, SCENES[state.scene]?.camTiltDeg ?? 0);
  const h = state.heading * RAD, t = tiltDeg * RAD;
  const f = [Math.sin(h), Math.cos(h)]; // horizontal heading
  const fx = width / 2 / Math.tan((hfovDeg * RAD) / 2);
  return {
    width, height, hfovDeg, tiltDeg,
    fx, fy: fx, cx: width / 2, cy: height / 2,
    pos: [state.x + f[0] * ROV.camForward, state.y + f[1] * ROV.camForward, POOL.depth - state.depth],
    right: [f[1], -f[0], 0],
    down: [-f[0] * Math.sin(t), -f[1] * Math.sin(t), -Math.cos(t)],
    fwd: [f[0] * Math.cos(t), f[1] * Math.cos(t), -Math.sin(t)],
    horizonY: height / 2 - fx * Math.tan(t), // where the far floor meets the far water
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// World point -> camera frame [x right, y down, z forward] (m).
export function toCamera(cam, p) {
  const d = [p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]];
  return [dot(d, cam.right), dot(d, cam.down), dot(d, cam.fwd)];
}

// World point -> [u, v, z] (pixels, z = distance along the view axis), or null behind the camera.
export function projectPoint(cam, p, near = 0.05) {
  const [x, y, z] = toCamera(cam, p);
  if (z < near) return null;
  return [cam.fx * (x / z) + cam.cx, cam.fy * (y / z) + cam.cy, z];
}

// Flat world polygon -> image polygon [[u, v], ...], clipped at the near plane so shapes that
// pass beside or under the camera (floor, line, poles) still draw correctly. [] if all behind.
export function projectPolygon(cam, pts, near = 0.05) {
  const inCam = pts.map((p) => toCamera(cam, p));
  const clipped = [];
  for (let i = 0; i < inCam.length; i++) {
    const a = inCam[i], b = inCam[(i + 1) % inCam.length];
    if (a[2] >= near) clipped.push(a);
    if ((a[2] >= near) !== (b[2] >= near)) {
      const s = (near - a[2]) / (b[2] - a[2]);
      clipped.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, near]);
    }
  }
  return clipped.map(([x, y, z]) => [cam.fx * (x / z) + cam.cx, cam.fy * (y / z) + cam.cy]);
}
