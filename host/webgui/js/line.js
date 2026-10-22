// Mission 3 (line following): steering advice and the checkpoint counter. Pure, unit-tested.
//
// Manual piloting is mandatory: everything here is a hint for the pilot, never a motor command.
// Course: white tape = start, then a white tape every 50 cm (checkpoint 1, 2, final).

const STORAGE_KEY = 'rov.m3.v1';
const TAPE_MATCH = 0.15; // a tape moves at most this much (fraction of image height) between results

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// line: the "line" field of a result (or null). cfg: {steerDead, angleGain, offsetGain}.
// lastSide ('left'|'right'|null): where the line was last seen, for the LINE LOST hint.
// -> {steer -1..1 (+ = yaw right), text, kind, side, lost}
export function steerView(line, cfg, lastSide = cfg?.lastSide ?? null) {
  cfg ??= {};
  const known = lastSide === 'left' || lastSide === 'right' ? lastSide : null;
  if (!line || typeof line !== 'object') {
    const hint = known ? ` · last seen ${known.toUpperCase()}` : '';
    return { steer: 0, text: `LINE LOST${hint}`, kind: 'bad', side: known, lost: true };
  }
  const dead = num(cfg.steerDead, 0.08);
  const offset = num(line.offset, 0);
  const steer = clamp(num(cfg.offsetGain, 1) * offset + num(cfg.angleGain, 1 / 45) * num(line.angleDeg, 0), -1, 1);
  const side = offset > 0 ? 'right' : offset < 0 ? 'left' : known;
  if (Math.abs(steer) <= dead) return { steer, text: 'ON LINE', kind: 'ok', side, lost: false };
  return { steer, text: steer > 0 ? 'YAW RIGHT' : 'YAW LEFT', kind: 'warn', side, lost: false };
}

// ---------- checkpoint counter ----------

export function checkpointsInitial() {
  return { count: 0, tapesY: [], lastCountMs: -Infinity, auto: true };
}

// tapesYNorm: tape positions in this result, 0 (top) .. 1 (bottom) of the image.
// A tape that moves from above triggerRow to at/below it between two updates is one checkpoint
// passed (the ROV moves forward, so the floor moves down the image). Tapes are matched to the
// previous update by the nearest y. Debounced, never above total. A tape that was counted must go
// back above the trigger by REARM before it can count again, so a ROV hovering on a tape (detector
// jitter) does not count it twice. With auto off only the positions are remembered.
const REARM = 0.1;
export function checkpointsUpdate(state, tapesYNorm, nowMs, cfg = {}) {
  const trigger = num(cfg?.triggerRow, 0.85);
  const debounceMs = num(cfg?.debounceMs, 1500);
  const total = Math.max(0, Math.round(num(cfg?.total, 3)));
  const tapes = (Array.isArray(tapesYNorm) ? tapesYNorm : [])
    .filter((y) => typeof y === 'number' && Number.isFinite(y))
    .sort((a, b) => a - b);

  const prevY = state.tapesY ?? [];
  const prevArmed = state.tapesArmed ?? prevY.map((y) => y < trigger);
  const free = prevY.map((y, i) => ({ y, armed: prevArmed[i] ?? y < trigger }));
  const armed = [];
  let crossed = false;
  for (const y of tapes) {
    let best = -1;
    for (let i = 0; i < free.length; i++) {
      const d = Math.abs(free[i].y - y);
      if (d <= TAPE_MATCH && (best < 0 || d < Math.abs(free[best].y - y))) best = i;
    }
    if (best < 0) {
      armed.push(y < trigger); // new tape: only one that appears above the trigger can count
      continue;
    }
    const prev = free.splice(best, 1)[0];
    if (prev.armed && prev.y < trigger && y >= trigger) {
      crossed = true;
      armed.push(false);
    } else {
      armed.push(prev.armed || y < trigger - REARM);
    }
  }

  const next = { ...state, tapesY: tapes, tapesArmed: armed };
  if (state.auto && crossed && state.count < total && nowMs - state.lastCountMs >= debounceMs) {
    next.count = state.count + 1;
    next.lastCountMs = nowMs;
  }
  return next;
}

// Manual -1 / +1 (the counter is a helper; the pilot has the last word).
export function checkpointsAdjust(state, delta, total = 3) {
  const count = clamp(Math.round(state.count + num(delta, 0)), 0, Math.max(0, Math.round(num(total, 3))));
  return { ...state, count };
}

// New run. Keeps the auto-count choice when the old state is given.
export function checkpointsReset(state) {
  return { ...checkpointsInitial(), auto: state ? state.auto !== false : true };
}

// count = white tapes crossed, the START tape included (it looks like every other tape), so the
// counter needs checkpoints + 1 tapes in all: tapesTotal(checkpoints).
export const tapesTotal = (checkpoints = 3) => checkpoints + 1;

export function checkpointLabel(count, checkpoints = 3, spacingCm = 50) {
  if (count <= 0) return 'Before the start tape';
  if (count === 1) return 'Start tape passed';
  const cp = count - 1;
  if (cp >= checkpoints) return `FINAL · ${checkpoints * spacingCm} cm`;
  return `Checkpoint ${cp} · ${cp * spacingCm} cm`;
}

// ---------- persistence: count and auto only (tape positions are live data) ----------

export function loadLine(storage, total = Infinity) {
  const s = checkpointsInitial();
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (Number.isInteger(raw.count) && raw.count >= 0) s.count = Math.min(raw.count, total);
      if (typeof raw.auto === 'boolean') s.auto = raw.auto;
    }
  } catch {
    // blocked storage or broken JSON: start from zero
  }
  return s;
}

export function saveLine(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ count: state.count, auto: state.auto }));
    return true;
  } catch {
    return false;
  }
}
