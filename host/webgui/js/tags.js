// Missions 2.1 (AprilTag scanning) and 2.2 (chamber docking): state and guidance. Pure, unit-tested.
//
// The bridge only reports the tags in one frame. Here we remember them across the whole attempt,
// because the camera usually sees one tag at a time: an id counts as found ("confirmed") after it
// was seen in confirmFrames frames (not necessarily in a row). A false positive is removed with
// Undo and then ignored until Reset.

const STORAGE_KEY = 'rov.m21.v1';
export const TAG_ID_MAX = 586; // tag36h11 has ids 0..586
export const RULES = ['largest', 'smallest'];

export const isTagId = (id) => Number.isInteger(id) && id >= 0 && id <= TAG_ID_MAX;
const posInt = (v, fallback) => (Number.isInteger(v) && v >= 1 ? v : fallback);

export function tagsInitial() {
  return { seen: {}, confirmed: [], ignored: [], rule: null };
}

// ids: tag ids in one frame -> {state, newly}. The state object is returned unchanged when nothing
// changed, so the caller can save only on change. A confirmed id stops counting (no endless writes).
export function tagsUpdate(state, ids, confirmFrames = 5) {
  const need = posInt(confirmFrames, 5);
  const unique = [...new Set(Array.isArray(ids) ? ids : [])].filter(isTagId);
  const newly = [];
  let seen = null;
  for (const id of unique) {
    if (state.ignored.includes(id) || state.confirmed.includes(id)) continue;
    seen ??= { ...state.seen };
    seen[id] = (seen[id] ?? 0) + 1;
    if (seen[id] >= need) newly.push(id);
  }
  if (!seen) return { state, newly };
  newly.sort((a, b) => a - b);
  return { state: { ...state, seen, confirmed: [...state.confirmed, ...newly] }, newly };
}

// Last confirmed id was wrong: forget it and ignore it from now on.
export function tagsUndo(state) {
  if (!state.confirmed.length) return state;
  const id = state.confirmed[state.confirmed.length - 1];
  const seen = { ...state.seen };
  delete seen[id];
  return {
    ...state,
    seen,
    confirmed: state.confirmed.slice(0, -1),
    ignored: state.ignored.includes(id) ? state.ignored : [...state.ignored, id],
  };
}

// New attempt: forget the tags, keep the rule the referee gave.
export function tagsReset(state) {
  return { ...tagsInitial(), rule: state?.rule ?? null };
}

export function tagsSetRule(state, rule) {
  if (rule !== null && !RULES.includes(rule)) return state;
  return { ...state, rule };
}

export function selectTag(ids, rule) {
  const valid = (Array.isArray(ids) ? ids : []).filter(isTagId);
  if (!valid.length || !RULES.includes(rule)) return null;
  return rule === 'largest' ? Math.max(...valid) : Math.min(...valid);
}

// What the big result box shows. kind: ok (final answer) | warn (operator must act) | idle (still searching).
export function selectionView(state, expected = 3) {
  const want = posInt(expected, 3);
  const k = state.confirmed.length;
  const list = [...state.confirmed].sort((a, b) => a - b).join(', ');
  if (!RULES.includes(state.rule)) {
    return {
      final: false,
      big: 'Pick LARGEST or SMALLEST',
      sub: k ? `${k} / ${want} tags confirmed: ${list}` : 'The referee assigns the rule',
      kind: 'warn',
    };
  }
  const best = selectTag(state.confirmed, state.rule);
  if (k < want) {
    return {
      final: false,
      big: `Searching: ${k} / ${want} tags`,
      sub: best === null ? 'Scan the tags slowly' : `best so far: ID ${best}`,
      kind: 'idle',
    };
  }
  if (k === want) {
    return { final: true, big: `SELECTED: ID ${best} (${state.rule.toUpperCase()})`, sub: `confirmed: ${list}`, kind: 'ok' };
  }
  return { final: false, big: `${k} tags confirmed, expected ${want}`, sub: 'Undo a wrong one', kind: 'warn' };
}

// ---------- persistence ----------

function idList(raw, exclude = []) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const id of raw) if (isTagId(id) && !out.includes(id) && !exclude.includes(id)) out.push(id);
  return out;
}

export function sanitizeTags(raw) {
  const s = tagsInitial();
  if (!raw || typeof raw !== 'object') return s;
  s.ignored = idList(raw.ignored);
  s.confirmed = idList(raw.confirmed, s.ignored);
  if (raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen)) {
    for (const [key, hits] of Object.entries(raw.seen)) {
      const id = Number(key);
      if (isTagId(id) && String(id) === key && Number.isInteger(hits) && hits > 0 && !s.ignored.includes(id)) {
        s.seen[id] = hits;
      }
    }
  }
  if (RULES.includes(raw.rule)) s.rule = raw.rule;
  return s;
}

export function loadTags(storage) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (text) return sanitizeTags(JSON.parse(text));
  } catch {
    // blocked storage or broken JSON: start empty
  }
  return tagsInitial();
}

export function saveTags(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

// ---------- 2.2 docking guidance ----------

const DEG = 180 / Math.PI;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// tag: one detection from a "tags" result ({center, pose, ...}), or null when the target is not in view.
// For the pixel fallback (pose null) the frame size comes from tag.w/h or cfg.w/h, the field of view
// from cfg.hfovDeg (default 70).
// cfg: {alignDeg, alignVertM, slowDistM, offAxisDeg?}
// Advice only, in this priority: turn -> up/down -> forward. A 3-thruster ROV cannot move sideways,
// so being off the chamber's centre line (tag yaw) is a hint, not a command.
export function dockingView(tag, cfg = {}) {
  const alignDeg = num(cfg.alignDeg) ?? 5;
  const alignVertM = num(cfg.alignVertM) ?? 0.08;
  const slowDistM = num(cfg.slowDistM) ?? 1.0;
  const offAxisDeg = num(cfg.offAxisDeg) ?? 15;
  const out = { text: 'TARGET NOT IN VIEW', kind: 'warn', turn: null, vert: null,
    bearingDeg: null, vertM: null, vertDeg: null, dist: null, tagYawDeg: null, hint: '' };
  if (!tag || typeof tag !== 'object') return out;

  const pose = tag.pose && typeof tag.pose === 'object' ? tag.pose : null;
  const x = num(pose?.x), y = num(pose?.y), z = num(pose?.z);
  if (x !== null && y !== null && z !== null && z > 0) {
    out.bearingDeg = Math.atan2(x, z) * DEG;
    out.vertM = y;
    out.vertDeg = Math.atan2(y, z) * DEG;
    out.dist = num(pose.dist) ?? Math.hypot(x, y, z);
    out.tagYawDeg = num(pose.yawDeg);
  } else {
    // No pose (no hfov sent or solvePnP failed): angles from the pixel offset only.
    const w = num(tag.w) ?? num(cfg.w), h = num(tag.h) ?? num(cfg.h);
    const c = Array.isArray(tag.center) ? tag.center : null;
    if (!w || !h || !c || num(c[0]) === null || num(c[1]) === null) {
      return { ...out, text: 'TARGET: NO POSITION' };
    }
    const t = Math.tan((num(cfg.hfovDeg) ?? 70) / 2 / DEG);
    out.bearingDeg = Math.atan(((c[0] - w / 2) / (w / 2)) * t) * DEG;
    out.vertDeg = Math.atan(((c[1] - h / 2) / (w / 2)) * t) * DEG; // square pixels: same focal length
  }

  if (Math.abs(out.bearingDeg) > alignDeg) {
    out.turn = out.bearingDeg > 0 ? 'right' : 'left';
    out.text = `TURN ${out.turn.toUpperCase()}`;
  } else if (out.vertM !== null ? Math.abs(out.vertM) > alignVertM : Math.abs(out.vertDeg) > alignDeg) {
    out.vert = (out.vertM ?? out.vertDeg) > 0 ? 'down' : 'up'; // image y points down
    out.text = out.vert.toUpperCase();
  } else {
    out.text = out.dist !== null && out.dist < slowDistM ? 'SLOW, ENTERING' : 'FORWARD';
    out.kind = 'ok';
  }
  // yawDeg > 0: the ROV is right of the tag's centre line (see host/vision/tags.py).
  if (out.tagYawDeg !== null && Math.abs(out.tagYawDeg) > offAxisDeg) {
    out.hint = `Off the centre line: you are ${out.tagYawDeg > 0 ? 'RIGHT' : 'LEFT'} of the chamber axis`;
  }
  return out;
}
