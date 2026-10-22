// Colour ranges for the "colors" vision mode (Mission 5 poles, general colour detection).
// Pure, unit-tested.
//
// HSV in the OpenCV 8-bit convention, like host/vision/colors.py: H 0..179 (hue degrees / 2),
// S and V 0..255. A hue range with lo > hi wraps through 0 (red: [170, 10]).
// The defaults are rough values for air: calibrate in the pool (click the pole in the GUI).

const STORAGE_KEY = 'rov.colors.v1';
export const MAX_COLORS = 6;
export const NAME_RE = /^[a-z0-9_-]{1,16}$/;

// Keep equal to the defaults in host/vision/colors.py. Treat as read-only: defaultColors() gives an
// editable copy.
export const DEFAULT_COLORS = {
  red: { h: [170, 10], s: [100, 255], v: [70, 255] },
  yellow: { h: [18, 38], s: [100, 255], v: [100, 255] },
  blue: { h: [100, 130], s: [150, 255], v: [50, 255] }, // the pool is blue too: high saturation only
};

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
  return JSON.stringify({ format: 'rov-colors', version: 1, colors: sanitizeColors(cal) }, null, 2) + '\n';
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
  const map = raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors) ? raw.colors : raw;
  const valid = Object.entries(map).filter(([name, r]) => NAME_RE.test(name) && sanitizeRange(r));
  if (!valid.length) return { ok: false, error: 'no valid colour ranges in the file' };
  return { ok: true, colors: sanitizeColors(map) };
}
