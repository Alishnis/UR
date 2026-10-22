// Mission 4 hold timer and the 20-minute attempt clock. Pure, unit-tested: the caller passes the
// time in. The attempt clock takes Date.now() (wall clock) so a saved, running clock is still right
// after a page reload; the hold timer may use any millisecond clock.

const ATTEMPT_KEY = 'rov.attempt.v1';
const HOLD_KEY = 'rov.m4.v1';
const DEFAULT_ATTEMPT_MS = 20 * 60 * 1000;

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ---------- Mission 4: hold the object clear of the ground for 3 continuous seconds ----------
// The pilot presses H (or the button) when the object is lifted and again when it touches down.
// bestMs is the longest single hold; once it reaches needMs the 20 points are secured and stay
// secured even if the object is dropped later (contest rule), until Reset.

export function holdInitial() {
  return { running: false, startMs: null, lastMs: 0, bestMs: 0 };
}

export function holdStart(s, now) {
  if (s.running) return s;
  return { ...s, running: true, startMs: now, lastMs: 0 };
}

export function holdStop(s, now) {
  if (!s.running) return s;
  const held = Math.max(0, now - s.startMs);
  return { ...s, running: false, startMs: null, lastMs: held, bestMs: Math.max(s.bestMs, held) };
}

export const holdReset = () => holdInitial();

// -> {running, elapsedMs (current hold, or the last one when stopped), progress 0..1, secured, bestMs}
export function holdView(s, now, needMs = 3000) {
  const elapsedMs = s.running ? Math.max(0, now - s.startMs) : s.lastMs;
  const bestMs = Math.max(s.bestMs, s.running ? elapsedMs : 0);
  return {
    running: s.running,
    elapsedMs,
    progress: needMs > 0 ? Math.min(1, elapsedMs / needMs) : 1,
    secured: bestMs >= needMs,
    bestMs,
  };
}

// Only the result is kept across a reload; a hold that was running is not resumed.
export function loadHold(storage) {
  const s = holdInitial();
  try {
    const raw = JSON.parse(storage?.getItem(HOLD_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      s.bestMs = Math.max(0, num(raw.bestMs, 0));
      s.lastMs = Math.max(0, num(raw.lastMs, 0));
    }
  } catch {
    // blocked storage or broken JSON
  }
  return s;
}

export function saveHold(storage, s) {
  try {
    storage?.setItem(HOLD_KEY, JSON.stringify({ bestMs: s.bestMs, lastMs: s.lastMs }));
    return true;
  } catch {
    return false;
  }
}

// ---------- attempt clock (counts down, may go over) ----------

export function attemptInitial(totalMs = DEFAULT_ATTEMPT_MS) {
  return { totalMs: num(totalMs, 0) > 0 ? totalMs : DEFAULT_ATTEMPT_MS, running: false, startedAt: null, usedMs: 0 };
}

export function attemptStart(s, now) {
  if (s.running) return s;
  return { ...s, running: true, startedAt: now };
}

export function attemptPause(s, now) {
  if (!s.running) return s;
  return { ...s, running: false, startedAt: null, usedMs: s.usedMs + Math.max(0, now - s.startedAt) };
}

export const attemptReset = (s) => attemptInitial(s?.totalMs);

const pad = (n) => String(n).padStart(2, '0');

// -> {remainingMs (negative = over time), running, text 'mm:ss' ('-mm:ss' over time), kind}
export function attemptView(s, now) {
  const used = s.usedMs + (s.running ? Math.max(0, now - s.startedAt) : 0);
  const remainingMs = s.totalMs - used;
  const secs = Math.ceil(remainingMs / 1000); // a countdown shows 20:00 until a full second has gone
  const abs = Math.abs(secs);
  const text = `${secs < 0 ? '-' : ''}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  const kind = remainingMs < 60_000 ? 'bad' : remainingMs < 300_000 ? 'warn' : 'ok';
  return { remainingMs, running: s.running, text, kind };
}

// totalMs: the configured attempt length. It replaces the saved one unless an attempt is under way.
export function loadAttempt(storage, totalMs = DEFAULT_ATTEMPT_MS) {
  const fresh = attemptInitial(totalMs);
  try {
    const raw = JSON.parse(storage?.getItem(ATTEMPT_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return fresh;
    const usedMs = Math.max(0, num(raw.usedMs, 0));
    const running = raw.running === true && Number.isFinite(raw.startedAt);
    if (!running && usedMs === 0) return fresh;
    return {
      totalMs: num(raw.totalMs, 0) > 0 ? raw.totalMs : fresh.totalMs,
      running,
      startedAt: running ? raw.startedAt : null,
      usedMs,
    };
  } catch {
    return fresh; // blocked storage or broken JSON
  }
}

export function saveAttempt(storage, s) {
  try {
    storage?.setItem(ATTEMPT_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
