import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOR_CSS, DEFAULT_COLORS, MAX_COLORS, colorCss, defaultColors, exportColors, hueWidth, importColors,
  inHueRange, inRange, loadColors, rangeFromSamples, rgbToHsv, sanitizeColors, saveColors, widenRange,
} from '../js/colors.js';

// [r, g, b, h, s, v] from OpenCV 5.0 cv2.cvtColor(COLOR_BGR2HSV), each colour filling a 64-pixel row
// so it takes the vectorised path that real camera frames take. Made with:
//   rows -> np.repeat(..., 64, axis=1) -> cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[:, 0]
// First the hand-picked edge cases (primaries, greys, near-black, red around 0/179, the simulator
// colours), then 150 random colours (numpy default_rng(7)).
const OPENCV_HSV = [
  [0,0,0,0,0,0], [255,255,255,0,0,255], [128,128,128,0,0,128], [1,1,1,0,0,1], [254,254,254,0,0,254], [255,0,0,0,255,255],
  [0,255,0,60,255,255], [0,0,255,120,255,255], [255,255,0,30,255,255], [0,255,255,90,255,255], [255,0,255,150,255,255], [255,0,1,0,255,255],
  [255,1,0,0,255,255], [1,0,0,0,255,1], [0,1,0,60,255,1], [0,0,1,120,255,1], [2,1,1,0,127,2], [1,2,1,60,127,2],
  [255,128,0,15,255,255], [128,255,0,45,255,255], [0,255,128,75,255,255], [0,128,255,105,255,255], [128,0,255,135,255,255], [255,0,128,165,255,255],
  [255,0,4,0,255,255], [255,0,5,179,255,255], [255,0,6,179,255,255], [255,0,3,0,255,255], [200,10,12,0,242,200], [200,12,10,0,242,200],
  [208,49,45,1,200,208], [242,194,48,23,204,242], [29,79,216,112,221,216], [91,143,174,101,122,174], [53,89,107,100,129,107], [120,170,200,101,102,200],
  [10,20,30,105,170,30], [250,250,249,30,1,250], [37,0,0,0,255,37], [0,0,37,120,255,37], [100,99,100,150,3,100], [241,160,175,174,86,241],
  [229,148,198,161,90,229], [213,57,14,6,238,213], [76,72,223,121,173,223], [233,1,127,164,254,233], [210,33,204,151,215,210], [30,119,209,105,218,209],
  [77,87,71,49,47,87], [184,65,253,139,189,253], [113,122,129,103,32,129], [149,141,130,17,33,149], [254,206,202,2,52,254], [179,159,87,23,131,179],
  [253,119,55,10,200,253], [216,41,219,149,207,219], [156,29,11,4,237,156], [113,9,36,172,235,113], [131,248,119,57,133,248], [206,234,210,64,31,234],
  [161,112,131,168,78,161], [68,127,97,75,118,127], [63,254,3,53,252,254], [24,49,248,117,230,248], [177,225,51,38,197,225], [184,94,125,170,125,184],
  [0,158,212,98,255,212], [169,39,136,158,196,169], [68,247,225,86,185,247], [47,130,240,107,205,240], [216,181,163,10,63,216], [10,189,121,79,241,189],
  [23,62,138,110,213,138], [186,129,156,166,78,186], [223,175,92,19,150,223], [164,153,27,28,213,164], [15,169,99,76,232,169], [153,82,57,8,160,153],
  [38,97,208,110,208,208], [102,97,147,123,87,147], [250,100,151,170,153,250], [112,154,114,61,70,154], [163,140,173,141,49,173], [244,38,143,165,215,244],
  [112,91,61,18,116,112], [13,103,211,106,239,211], [24,103,247,109,230,247], [243,55,1,7,254,243], [171,3,76,167,251,171], [127,223,23,44,229,223],
  [169,136,33,23,205,169], [216,216,123,30,110,216], [241,155,231,153,91,241], [245,145,71,13,181,245], [37,144,49,63,189,144], [192,237,62,38,188,237],
  [141,12,46,172,233,141], [96,226,248,94,156,248], [164,149,145,6,30,164], [15,96,251,110,240,251], [105,54,61,176,124,105], [182,9,248,142,246,248],
  [224,145,119,7,120,224], [194,140,122,8,95,194], [82,114,192,111,146,192], [14,6,184,121,247,184], [95,205,7,47,246,205], [232,31,106,169,221,232],
  [247,27,168,161,227,247], [186,109,20,16,228,186], [134,110,223,126,129,223], [174,88,14,14,234,174], [151,71,175,143,152,175], [221,90,231,148,156,231],
  [132,135,195,119,82,195], [202,232,255,103,53,255], [38,105,238,110,214,238], [78,1,147,136,253,147], [192,190,207,124,21,207], [164,35,216,141,214,216],
  [107,216,208,88,129,216], [248,3,221,153,252,248], [160,124,203,134,99,203], [243,131,22,15,232,243], [185,59,57,0,176,185], [49,50,232,120,201,232],
  [92,27,45,172,180,92], [101,88,79,12,56,101], [242,221,146,23,101,242], [252,87,35,7,220,252], [69,22,243,126,232,243], [56,113,51,58,140,113],
  [250,40,131,167,214,250], [243,133,230,154,115,243], [229,196,190,5,43,229], [147,148,212,120,78,212], [109,242,224,86,140,242], [95,105,182,117,122,182],
  [236,24,17,1,237,236], [63,110,41,50,160,110], [132,138,243,118,116,243], [190,64,201,148,174,201], [206,174,173,1,41,206], [79,183,34,51,208,183],
  [161,235,248,94,89,248], [76,85,158,117,132,158], [101,187,51,49,185,187], [43,12,120,129,230,120], [54,76,234,116,196,234], [208,215,151,33,76,215],
  [28,191,154,83,218,191], [232,122,44,12,207,232], [152,116,168,141,79,168], [96,78,32,22,170,96], [246,193,119,17,132,246], [60,160,105,74,159,160],
  [162,23,47,175,219,162], [188,15,173,153,235,188], [105,0,195,136,255,195], [179,208,229,103,56,229], [186,215,28,35,222,215], [235,233,177,29,63,235],
  [205,189,224,134,40,224], [227,133,208,156,106,227], [234,76,11,9,243,234], [43,7,111,130,239,111], [5,66,64,89,236,66], [180,63,243,140,189,243],
  [48,248,145,75,206,248], [62,9,78,143,226,78], [151,27,42,176,209,151], [29,173,22,59,223,173], [5,116,79,80,244,116], [145,240,219,83,101,240],
  [137,164,207,108,86,207], [111,168,55,45,172,168], [156,60,48,3,177,156], [194,147,96,16,129,194], [10,60,205,112,243,205], [119,245,230,86,131,245],
  [218,4,12,179,250,218], [148,86,215,134,153,215], [81,39,28,6,167,81], [77,160,32,49,204,160], [204,77,80,179,159,204], [169,220,111,44,126,220],
  [204,78,33,8,214,204], [212,196,192,6,24,212], [225,127,50,13,198,225], [149,146,98,28,87,149], [163,67,155,153,150,163],
];

test('rgbToHsv matches OpenCV (H and V exactly, S within 1)', () => {
  let sOff = 0;
  for (const [r, g, b, h, s, v] of OPENCV_HSV) {
    const [H, S, V] = rgbToHsv(r, g, b);
    const at = `rgb(${r}, ${g}, ${b})`;
    assert.equal(H, h, `${at} hue`);
    assert.equal(V, v, `${at} value`);
    assert.ok(Math.abs(S - s) <= 1, `${at} saturation ${S} vs ${s}`);
    if (S !== s) sOff++;
  }
  assert.ok(sOff <= 3, `${sOff} saturations off by one`); // OpenCV's vector code rounds a few .5 cases down
});

test('rgbToHsv: primaries, greys and edge cases', () => {
  assert.deepEqual(rgbToHsv(0, 0, 0), [0, 0, 0]);
  assert.deepEqual(rgbToHsv(255, 255, 255), [0, 0, 255]);
  assert.deepEqual(rgbToHsv(77, 77, 77), [0, 0, 77]); // grey: no hue, no saturation
  assert.deepEqual(rgbToHsv(255, 0, 0), [0, 255, 255]);
  assert.deepEqual(rgbToHsv(0, 255, 0), [60, 255, 255]);
  assert.deepEqual(rgbToHsv(0, 0, 255), [120, 255, 255]);
  assert.deepEqual(rgbToHsv(255, 255, 0), [30, 255, 255]);
  assert.deepEqual(rgbToHsv(0, 255, 255), [90, 255, 255]);
  assert.deepEqual(rgbToHsv(255, 0, 255), [150, 255, 255]);
  assert.equal(rgbToHsv(255, 0, 6)[0], 179); // red just below 0 wraps to the top of the hue scale
  assert.equal(rgbToHsv(255, 6, 0)[0], 1);
  assert.equal(rgbToHsv(255, 0, 4)[0], 0); // rounds to 0, never 180
  assert.deepEqual(rgbToHsv(1, 0, 0), [0, 255, 1]);
  for (let i = 0; i < 4096; i++) { // the hue never leaves 0..179
    const h = rgbToHsv(255, i % 64, (i * 7) % 256)[0];
    assert.ok(h >= 0 && h <= 179);
  }
});

test('rgbToHsv: out-of-range and junk input is clamped', () => {
  assert.deepEqual(rgbToHsv(300, -5, 0), [0, 255, 255]);
  assert.deepEqual(rgbToHsv(NaN, undefined, '10'), rgbToHsv(0, 0, 10));
  assert.deepEqual(rgbToHsv(254.6, 0.4, 0), [0, 255, 255]);
});

test('DEFAULT_COLORS are the protocol defaults (same numbers as host/vision/colors.py)', () => {
  assert.deepEqual(DEFAULT_COLORS, {
    red: { h: [170, 10], s: [100, 255], v: [70, 255] },
    yellow: { h: [18, 38], s: [100, 255], v: [100, 255] },
    blue: { h: [100, 130], s: [150, 255], v: [50, 255] },
  });
  const copy = defaultColors();
  assert.deepEqual(copy, DEFAULT_COLORS);
  copy.red.h[0] = 1;
  assert.equal(DEFAULT_COLORS.red.h[0], 170); // a copy is a deep copy
  for (const name of Object.keys(DEFAULT_COLORS)) assert.match(COLOR_CSS[name], /^#[0-9a-f]{6}$/);
  assert.equal(colorCss('red'), COLOR_CSS.red);
  assert.match(colorCss('green'), /^#/); // any other colour still gets something to draw with
});

test('inHueRange: plain and wrapped ranges', () => {
  assert.equal(inHueRange(20, [18, 38]), true);
  assert.equal(inHueRange(18, [18, 38]), true);
  assert.equal(inHueRange(38, [18, 38]), true);
  assert.equal(inHueRange(39, [18, 38]), false);
  assert.equal(inHueRange(175, [170, 10]), true);
  assert.equal(inHueRange(0, [170, 10]), true);
  assert.equal(inHueRange(10, [170, 10]), true);
  assert.equal(inHueRange(11, [170, 10]), false);
  assert.equal(inHueRange(169, [170, 10]), false);
  assert.equal(inHueRange(90, [170, 10]), false);
  assert.equal(hueWidth([18, 38]), 20);
  assert.equal(hueWidth([170, 10]), 20);
});

test('inRange: the default ranges pick the right colour', () => {
  const which = (r, g, b) => Object.keys(DEFAULT_COLORS).filter((n) => inRange(rgbToHsv(r, g, b), DEFAULT_COLORS[n]));
  assert.deepEqual(which(220, 30, 30), ['red']);
  assert.deepEqual(which(220, 30, 60), ['red']); // hue ~176: wrapped part
  assert.deepEqual(which(240, 200, 40), ['yellow']);
  assert.deepEqual(which(20, 70, 220), ['blue']);
  assert.deepEqual(which(90, 140, 175), []); // pool water: blue but not saturated enough
  assert.deepEqual(which(128, 128, 128), []);
  assert.deepEqual(which(40, 10, 10), []); // red in the dark: too dark
});

const spread = (base, n = 81) => Array.from({ length: n }, (_, i) => [base[0], base[1], base[2]]
  .map((x, k) => x + ((i * (k + 3)) % 7) - 3)); // +-3 noise

test('rangeFromSamples: yellow patch', () => {
  const r = rangeFromSamples(spread([28, 200, 220]));
  assert.ok(r.h[0] <= 25 && r.h[0] >= 15, String(r.h));
  assert.ok(r.h[1] >= 31 && r.h[1] <= 41, String(r.h));
  assert.equal(r.s[1], 255);
  assert.equal(r.v[1], 255);
  assert.equal(r.s[0], Math.round(200 * 0.55));
  assert.equal(r.v[0], Math.round(220 * 0.45));
  for (const p of spread([28, 200, 220])) assert.ok(inRange(p, r));
});

test('rangeFromSamples: red around 0/179 gives a wrapped range', () => {
  const samples = [[178, 200, 150], [179, 210, 160], [0, 190, 155], [1, 205, 150], [2, 200, 140], [177, 195, 150]];
  const r = rangeFromSamples(samples);
  assert.ok(r.h[0] > r.h[1], `expected a wrap, got ${r.h}`);
  assert.ok(hueWidth(r.h) >= 20 && hueWidth(r.h) <= 30, String(r.h));
  for (const p of samples) assert.ok(inHueRange(p[0], r.h));
  assert.equal(inHueRange(90, r.h), false);
  // the median of [0, 1, 2, 177, 178, 179] is about 0.5, not 89.5
  assert.ok(inHueRange(0, r.h) && inHueRange(170, r.h) && inHueRange(10, r.h));
});

test('rangeFromSamples: wide samples widen the hue range, but never past a quarter circle', () => {
  const wide = Array.from({ length: 41 }, (_, i) => [90 + i - 20, 200, 200]); // hue 70..110
  const r = rangeFromSamples(wide);
  assert.ok(r.h[0] <= 74 && r.h[1] >= 106, String(r.h));
  const huge = Array.from({ length: 121 }, (_, i) => [30 + i, 200, 200]); // hue 30..150
  const r2 = rangeFromSamples(huge);
  assert.ok(hueWidth(r2.h) <= 90, String(r2.h));
});

test('rangeFromSamples: floors, options and junk', () => {
  const pale = rangeFromSamples([[60, 50, 40]]);
  assert.deepEqual(pale.s, [40, 255]); // 0.55 * 50 = 27.5 -> minSat 40
  assert.deepEqual(pale.v, [25, 255]); // 0.45 * 40 = 18 -> minVal 25
  assert.deepEqual(pale.h, [50, 70]);
  const custom = rangeFromSamples([[60, 200, 200]], { hueMargin: 5, satFrac: 0.5, valFrac: 0.5 });
  assert.deepEqual(custom, { h: [55, 65], s: [100, 255], v: [100, 255] });
  assert.equal(rangeFromSamples([]), null);
  assert.equal(rangeFromSamples(null), null);
  assert.equal(rangeFromSamples([[1, 2], 'x', [NaN, 1, 1]]), null);
  assert.deepEqual(rangeFromSamples([[60, 200, 200], 'junk']), rangeFromSamples([[60, 200, 200]]));
});

test('widenRange: covers both ranges the short way round', () => {
  const a = { h: [20, 30], s: [120, 255], v: [100, 255] };
  const b = { h: [25, 40], s: [90, 250], v: [130, 255] };
  assert.deepEqual(widenRange(a, b), { h: [20, 40], s: [90, 255], v: [100, 255] });
  const red1 = { h: [172, 5], s: [100, 255], v: [70, 255] };
  const red2 = { h: [0, 12], s: [100, 255], v: [70, 255] };
  assert.deepEqual(widenRange(red1, red2).h, [172, 12]);
  const red3 = { h: [160, 170], s: [100, 255], v: [70, 255] };
  assert.deepEqual(widenRange(red1, red3).h, [160, 5]);
  assert.deepEqual(widenRange({ h: [10, 20], s: [1, 255], v: [1, 255] }, { h: [170, 175], s: [1, 255], v: [1, 255] }).h,
    [170, 20]); // across 0 is shorter than 20 -> 170
  assert.deepEqual(widenRange(a, { ...a, h: [22, 28] }).h, [20, 30]); // contained
  assert.deepEqual(widenRange(null, a), a);
  assert.deepEqual(widenRange(a, null), a);
  assert.equal(widenRange(null, null), null);
});

test('sanitizeColors: junk falls back to the defaults', () => {
  for (const junk of [null, undefined, 5, 'x', [], { red: 'x' }, { red: { h: [1], s: [0, 1], v: [0, 1] } }]) {
    assert.deepEqual(sanitizeColors(junk), DEFAULT_COLORS);
  }
});

test('sanitizeColors: clamps, rounds, swaps S/V, keeps a hue wrap', () => {
  const s = sanitizeColors({
    red: { h: [175, 8], s: [90.6, 300], v: [-4, '255'] },
    blue: { h: [200, 120], s: [255, 140], v: [60, 255] },
  });
  assert.deepEqual(s.red, { h: [175, 8], s: [91, 255], v: [0, 255] });
  assert.deepEqual(s.blue, { h: [179, 120], s: [140, 255], v: [60, 255] });
  assert.deepEqual(s.yellow, DEFAULT_COLORS.yellow);
});

test('sanitizeColors: extra colours with valid names, at most 6 in total', () => {
  const range = { h: [40, 80], s: [80, 255], v: [60, 255] };
  const raw = { green: range, 'Bad Name': range, orange_1: range, ['x'.repeat(17)]: range, a: range, b: range, c: range };
  const s = sanitizeColors(raw);
  assert.deepEqual(Object.keys(s), ['red', 'yellow', 'blue', 'green', 'orange_1', 'a']);
  assert.equal(Object.keys(s).length, MAX_COLORS);
  const proto = sanitizeColors(JSON.parse('{"__proto__": {"h": [1, 2], "s": [1, 2], "v": [1, 2]}}'));
  assert.deepEqual(proto, DEFAULT_COLORS);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

test('persistence: round trip, junk, blocked storage', () => {
  const st = fakeStorage();
  const cal = { ...defaultColors(), red: { h: [168, 6], s: [80, 255], v: [50, 255] } };
  assert.equal(saveColors(st, cal), true);
  assert.ok(st.data['rov.colors.v1']);
  assert.deepEqual(loadColors(st), cal);
  assert.deepEqual(loadColors(fakeStorage()), DEFAULT_COLORS);
  assert.deepEqual(loadColors(fakeStorage({ 'rov.colors.v1': '{bad' })), DEFAULT_COLORS);
  assert.deepEqual(loadColors(null), DEFAULT_COLORS);
  const blocked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.deepEqual(loadColors(blocked), DEFAULT_COLORS);
  assert.equal(saveColors(blocked, cal), false);
});

test('export / import', () => {
  const cal = { ...defaultColors(), yellow: { h: [20, 34], s: [120, 255], v: [90, 255] } };
  const text = exportColors(cal);
  assert.match(text, /\n {2}"format": "rov-colors"/); // pretty printed
  assert.deepEqual(importColors(text), { ok: true, colors: cal });
  // a bare {name: range} object is fine too
  assert.deepEqual(importColors(JSON.stringify({ red: { h: [171, 9], s: [100, 255], v: [70, 255] } })).colors.red,
    { h: [171, 9], s: [100, 255], v: [70, 255] });
  let r = importColors('not json');
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/);
  r = importColors('[1, 2]');
  assert.deepEqual([r.ok, r.error], [false, 'expected a JSON object']);
  r = importColors('{"colors": {"red": "x"}}');
  assert.deepEqual([r.ok, r.error], [false, 'no valid colour ranges in the file']);
  assert.equal(importColors('{"colors": [{"h": [1, 2], "s": [1, 2], "v": [1, 2]}]}').ok, false);
  assert.equal(importColors('null').ok, false);
  assert.equal(importColors(undefined).ok, false);
});
