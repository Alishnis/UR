// Mission 5 (pole colours): the referee's order, balls dropped so far, which blob is which pole and
// approach advice. Pure, unit-tested. Advice only: the pilot drives.

const STORAGE_KEY = 'rov.m5.v1';
export const POLE_COLORS = ['red', 'yellow', 'blue'];
const LETTER = { red: 'R', yellow: 'Y', blue: 'B' };

// Letters and words the order may be typed with. К/И/Н are the R/B/Y keys on the Russian layout,
// so "R-B-Y" typed with the wrong layout still works.
const TOKENS = {
  r: 'red', red: 'red', к: 'red',
  y: 'yellow', yellow: 'yellow', н: 'yellow',
  b: 'blue', blue: 'blue', и: 'blue',
};

// "R-B-Y", "rby", "R B Y", "r,b,y", "red blue yellow" -> ['red', 'blue', 'yellow'], or null.
// Must name each colour exactly once.
export function parseOrder(text) {
  const clean = String(text ?? '').trim().toLowerCase();
  if (!clean) return null;
  let parts = clean.split(/[\s,;.\-–—>/|_]+/).filter(Boolean);
  if (parts.length === 1 && [...parts[0]].length === 3) parts = [...parts[0]];
  const order = parts.map((p) => TOKENS[p]);
  if (order.length !== 3 || order.some((c) => !c) || new Set(order).size !== 3) return null;
  return order;
}

export const isOrder = (order) => Array.isArray(order) && order.length === 3
  && new Set(order).size === 3 && order.every((c) => POLE_COLORS.includes(c));

export function orderText(order) {
  return isOrder(order) ? order.map((c) => LETTER[c]).join('-') : '';
}

export function polesInitial() {
  return { order: null, done: 0 };
}

// A new order starts the count again. null clears it; anything else invalid is ignored.
export function polesSetOrder(state, order) {
  if (order !== null && !isOrder(order)) return state;
  return { ...state, order: order && [...order], done: 0 };
}

export const polesHit = (state) => ({ ...state, done: Math.min(3, state.done + 1) });
export const polesUndo = (state) => ({ ...state, done: Math.max(0, state.done - 1) });
export const polesReset = (state) => ({ ...state, done: 0 });

export function nextColor(state) {
  return isOrder(state.order) && state.done < 3 ? state.order[state.done] : null;
}

// blobs from a "colors" result -> the most likely pole of each colour, or null.
// Poles are tall: a blob at least minAspect times taller than wide scores full area, others half.
export function pickPoles(blobs, cfg = {}) {
  const minAspect = Number.isFinite(cfg?.minAspect) ? cfg.minAspect : 1.2;
  const best = { red: null, yellow: null, blue: null };
  const score = {};
  for (const b of Array.isArray(blobs) ? blobs : []) {
    if (!b || typeof b.color !== 'string' || b.color === '__proto__' || !Number.isFinite(b.area)) continue;
    const s = b.area * ((b.aspect ?? 0) >= minAspect ? 1 : 0.5);
    if (!Object.hasOwn(score, b.color) || s > score[b.color]) {
      score[b.color] = s;
      best[b.color] = b;
    }
  }
  return best;
}

// Where is the blob's centre x (falls back to the box)?
function centerX(blob) {
  if (Array.isArray(blob.center) && Number.isFinite(blob.center[0])) return blob.center[0];
  if (Array.isArray(blob.box)) return blob.box[0] + blob.box[2] / 2;
  return null;
}

// blob: the target pole (or null), w/h: frame size of the result. cfg: {alignFrac, closeFrac}.
export function approachView(blob, w, h, cfg = {}) {
  const alignFrac = Number.isFinite(cfg?.alignFrac) ? cfg.alignFrac : 0.08;
  const closeFrac = Number.isFinite(cfg?.closeFrac) ? cfg.closeFrac : 0.6;
  const cx = blob ? centerX(blob) : null;
  if (!blob || cx === null || !(w > 0) || !(h > 0)) return { text: 'SEARCH: turn slowly', kind: 'warn', turn: null };
  const off = (cx - w / 2) / (w / 2);
  if (Math.abs(off) > alignFrac) {
    const turn = off > 0 ? 'right' : 'left';
    return { text: `YAW ${turn.toUpperCase()}`, kind: 'warn', turn };
  }
  const boxH = Array.isArray(blob.box) ? blob.box[3] : 0;
  if (boxH >= closeFrac * h) return { text: 'CLOSE: hit it', kind: 'ok', turn: null };
  return { text: 'FORWARD', kind: 'ok', turn: null };
}

// ---------- persistence ----------

export function loadPoles(storage) {
  const s = polesInitial();
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (isOrder(raw.order)) s.order = [...raw.order];
      if (Number.isInteger(raw.done) && raw.done >= 0) s.done = Math.min(3, raw.done);
    }
  } catch {
    // blocked storage or broken JSON: start empty
  }
  return s;
}

export function savePoles(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ order: state.order, done: state.done }));
    return true;
  } catch {
    return false;
  }
}
