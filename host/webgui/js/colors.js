// Colour ranges for the "colors" vision mode (Mission 5 poles, general colour detection).
// Pure, unit-tested.
//
// HSV in the OpenCV 8-bit convention, like host/vision/colors.py: H 0..179 (hue degrees / 2),
// S and V 0..255. A hue range with lo > hi wraps through 0 (red: [170, 10]).
//
// The ranges are for the WATER-BALANCED picture: the detector first scales each channel so that the
// water is grey (balance gains per picture row, sent back with every result), which keeps red red at
// any distance instead of drifting to brown / magenta / blue. Click-to-calibrate applies the same gains
// to the pixels it reads, so a calibration and the detector always see the same colours.

const STORAGE_KEY = 'rov.colors.v2'; // v1 held ranges for the raw camera picture: not valid any more
export const MAX_COLORS = 6;
export const NAME_RE = /^[a-z0-9_-]{1,16}$/;

// Keep equal to the defaults in host/vision/colors.py. Treat as read-only: defaultColors() gives an
// editable copy.
export const DEFAULT_COLORS = {
  red: { h: [170, 8], s: [45, 255], v: [130, 255] },
  yellow: { h: [18, 34], s: [70, 255], v: [80, 255] },
  blue: { h: [95, 135], s: [20, 255], v: [40, 255] },
};
// Why these numbers (host/vision/colors.py, tools/colors_bench.py): red poles stay at H 2..9 out to 3 m
// after the balance, but grey / black / white things close to the camera turn orange (H 9..17), so red
// stops at 8; yellow needs S >= 70 and red V >= 130 to keep pale-yellow white pipes and black weights out.

// How each colour is drawn in the GUI (boxes, chips).
export const COLOR_CSS = { red: '#ff4d4f', yellow: '#ffd43b', blue: '#4dabf7' };
export const colorCss = (name) => COLOR_CSS[name] ?? '#c084fc';

const copyRange = (r) => ({ h: [...r.h], s: [...r.s], v: [...r.v] });
export function defaultColors() {
  return Object.fromEntries(Object.entries(DEFAULT_COLORS).map(([k, r]) => [k, copyRange(r)]));
}

// OpenCV's fixed-point formula (imgproc color_hsv). Against cv2.cvtColor(COLOR_BGR2HSV) on real
// frames: H and V identical, S off by 1 in rare cases (tests/colors.test.js holds an OpenCV table).
const SHIFT = 12;
const HALF = 1 << (SHIFT - 1);
const SDIV = Array.from({ length: 256 }, (_, i) => (i ? Math.round((255 << SHIFT) / i) : 0));
const HDIV = Array.from({ length: 256 }, (_, i) => (i ? Math.round((180 << SHIFT) / (6 * i)) : 0));
const byte = (x) => Math.min(255, Math.max(0, Math.round(Number(x) || 0)));

// r, g, b 0..255 -> [h 0..179, s 0..255, v 0..255]
export function rgbToHsv(r, g, b) {
  r = byte(r); g = byte(g); b = byte(b);
  const v = Math.max(r, g, b);
  const diff = v - Math.min(r, g, b);
  const s = (diff * SDIV[v] + HALF) >> SHIFT;
  let h;
  if (v === r) h = g - b;
  else if (v === g) h = b - r + 2 * diff;
  else h = r - g + 4 * diff;
  h = (h * HDIV[diff] + HALF) >> SHIFT;
  if (h < 0) h += 180;
  return [h, s, v];
}

// ---------- water-colour balance (the gains come from host/vision/colors.py balance_gains) ----------

// Untrusted rows of [gB, gG, gR] -> a clean copy, or null.
export function sanitizeGains(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 256) return null;
  const ok = raw.every((r) => Array.isArray(r) && r.length === 3 && r.every((g) => Number.isFinite(g) && g > 0 && g <= 10));
  return ok ? raw.map((r) => [...r]) : null;
}

// The gains at a height yFrac (0 = top .. 1 = bottom), interpolated between rows the way the detector
// stretches them over the picture (OpenCV resize, INTER_LINEAR). yFrac of a pixel row y: (y + 0.5) / height.
export function gainsAt(gains, yFrac) {
  const n = gains.length;
  const pos = Math.min(n - 1, Math.max(0, yFrac * n - 0.5));
  const i0 = Math.floor(pos);
  const i1 = Math.min(n - 1, i0 + 1);
  const t = pos - i0;
  return [0, 1, 2].map((c) => gains[i0][c] * (1 - t) + gains[i1][c] * t);
}

// r, g, b of the camera picture -> the balanced r, g, b (gains in OpenCV's B, G, R order).
export function balanceRgb(r, g, b, [gb, gg, gr]) {
  return [byte(r * gr), byte(g * gg), byte(b * gb)];
}

export function inHueRange(h, [lo, hi]) {
  return lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi;
}

export function inRange([h, s, v], range) {
  return inHueRange(h, range.h) && s >= range.s[0] && s <= range.s[1] && v >= range.v[0] && v <= range.v[1];
}

// Hue width of a range, counting the wrap.
export const hueWidth = ([lo, hi]) => (lo <= hi ? hi - lo : hi + 180 - lo);

const median = (sorted) => {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
const wrapHue = (h) => ((Math.round(h) % 180) + 180) % 180;
const isHsv = (p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((x) => Number.isFinite(x));

// Unwraps hues (0..179, a circle) onto a line cut opposite their circular mean, so red samples
// around 0/179 sort next to each other.
function unwrapHues(hues) {
  let sx = 0, sy = 0;
  for (const h of hues) {
    sx += Math.cos((h * Math.PI) / 90);
    sy += Math.sin((h * Math.PI) / 90);
  }
  const mean = ((Math.atan2(sy, sx) * 90) / Math.PI + 180) % 180;
  return hues.map((h) => {
    let d = h - mean;
    if (d > 90) d -= 180;
    if (d < -90) d += 180;
    return mean + d;
  }).sort((a, b) => a - b);
}

const SAMPLE_OPTS = { hueMargin: 10, satFrac: 0.55, valFrac: 0.45, minSat: 40, minVal: 25 };
const MAX_HALF_WIDTH = 45; // never accept more than a quarter of the hue circle

// Pixels clicked on a pole -> a range around them. Hue: the circular median +- hueMargin,
// widened to the 10..90 % spread of the samples. S and V: a fraction of their median, up to 255
// (shade and distance make colours darker and paler, rarely brighter). null for no valid samples.
export function rangeFromSamples(hsvList, opts = {}) {
  const o = { ...SAMPLE_OPTS, ...opts };
  const px = (Array.isArray(hsvList) ? hsvList : []).filter(isHsv);
  if (!px.length) return null;
  const hues = unwrapHues(px.map((p) => wrapHue(p[0])));
  const mid = median(hues);
  const lo = Math.max(Math.min(mid - o.hueMargin, quantile(hues, 0.1)), mid - MAX_HALF_WIDTH);
  const hi = Math.min(Math.max(mid + o.hueMargin, quantile(hues, 0.9)), mid + MAX_HALF_WIDTH);
  const sMed = median(px.map((p) => p[1]).sort((a, b) => a - b));
  const vMed = median(px.map((p) => p[2]).sort((a, b) => a - b));
  return {
    h: [wrapHue(Math.floor(lo)), wrapHue(Math.ceil(hi))],
    s: [byte(Math.max(o.minSat, sMed * o.satFrac)), 255],
    v: [byte(Math.max(o.minVal, vMed * o.valFrac)), 255],
  };
}

// Click on a pole in the balanced picture: the DEFAULT range of that colour, widened only as far as
// needed to take in the clicked pixels (median hue +-3, 85 % of their median saturation and brightness:
// lower floors would let grey / black things near the camera in). Never narrower than the default: one click at one distance cannot know how much paler the
// pole gets further away, and the defaults were chosen on a whole range of pools and distances.
// Unknown colour names start from the samples alone. null for no valid samples.
export function calibrateBalanced(name, hsvList, base = DEFAULT_COLORS[name]) {
  const px = (Array.isArray(hsvList) ? hsvList : []).filter(isHsv);
  if (!px.length) return null;
  const hues = unwrapHues(px.map((p) => wrapHue(p[0])));
  const mid = median(hues);
  const sMed = median(px.map((p) => p[1]).sort((a, b) => a - b));
  const vMed = median(px.map((p) => p[2]).sort((a, b) => a - b));
  const pole = {
    h: [wrapHue(Math.floor(mid - 3)), wrapHue(Math.ceil(mid + 3))],
    s: [byte(Math.max(20, sMed * 0.85)), 255],
    v: [byte(Math.max(25, vMed * 0.85)), 255],
  };
  if (!base) return pole;
  return {
    h: widenRange(base, pole).h,
    s: [Math.min(base.s[0], pole.s[0]), 255],
    v: [Math.min(base.v[0], pole.v[0]), 255],
  };
}

// Shift+click: the smallest range that covers both (the shorter way round the hue circle).
const ahead = (from, to) => (((to - from) % 180) + 180) % 180;
const containsHue = (outer, inner) => ahead(outer[0], inner[0]) + hueWidth(inner) <= hueWidth(outer);
export function widenRange(a, b) {
  if (!a || !b) return a || b ? copyRange(a || b) : null;
  const h = [a.h, b.h, [a.h[0], b.h[1]], [b.h[0], a.h[1]]]
    .filter((c) => containsHue(c, a.h) && containsHue(c, b.h))
    .sort((x, y) => hueWidth(x) - hueWidth(y))[0] ?? [0, 179];
  return {
    h: [...h],
    s: [Math.min(a.s[0], b.s[0]), Math.max(a.s[1], b.s[1])],
    v: [Math.min(a.v[0], b.v[0]), Math.max(a.v[1], b.v[1])],
  };
}

// ---------- validation, persistence, files ----------

function pair(raw, max, wraps) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const xs = raw.map(Number);
  if (!xs.every(Number.isFinite)) return null;
  let [lo, hi] = xs.map((x) => Math.min(max, Math.max(0, Math.round(x))));
  if (!wraps && lo > hi) [lo, hi] = [hi, lo];
  return [lo, hi];
}

export function sanitizeRange(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const h = pair(raw.h, 179, true), s = pair(raw.s, 255, false), v = pair(raw.v, 255, false);
  return h && s && v ? { h, s, v } : null;
}

// Untrusted data (localStorage, imported file) -> a safe calibration: red, yellow, blue always
// present (a broken entry falls back to its default), plus up to 6 colours in total with valid names.
export function sanitizeColors(raw) {
  const out = defaultColors();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, entry] of Object.entries(raw)) {
    if (!NAME_RE.test(name) || name === '__proto__') continue;
    const r = sanitizeRange(entry);
    if (!r) continue;
    if (Object.hasOwn(out, name) || Object.keys(out).length < MAX_COLORS) out[name] = r;
  }
  return out;
}

export function loadColors(storage) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (text) return sanitizeColors(JSON.parse(text));
  } catch {
    // blocked storage or broken JSON: defaults
  }
  return defaultColors();
}

export function saveColors(storage, cal) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(cal));
    return true;
  } catch {
    return false;
  }
}

export function exportColors(cal) {
  return JSON.stringify({ format: 'rov-colors', version: 2, space: 'balanced', colors: sanitizeColors(cal) }, null, 2) + '\n';
}

// Accepts what exportColors writes, or a bare {name: {h, s, v}} object.
export function importColors(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (e) {
    return { ok: false, error: `not a JSON file (${e.message})` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'expected a JSON object' };
  if (raw.format === 'rov-colors' && raw.version === 1) {
    return { ok: false, error: 'this file is from before the water-colour balance (version 1): calibrate again' };
  }
  const map = raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors) ? raw.colors : raw;
  const valid = Object.entries(map).filter(([name, r]) => NAME_RE.test(name) && sanitizeRange(r));
  if (!valid.length) return { ok: false, error: 'no valid colour ranges in the file' };
  return { ok: true, colors: sanitizeColors(map) };
}
