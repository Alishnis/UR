// Camera panel and missions 2-5: video source, capture loop to the vision service, overlay and the
// mission side panels. The mission decisions live in the pure, unit-tested modules (tags.js, line.js,
// poles.js, colors.js, timers.js); this file only connects them to the DOM and the video.
//
// Vision is display-only assistance: nothing here sends to the ESP32 or changes a motor command.
// Keyboard: the only key added is H (Mission 4 hold timer); every new button blurs itself after a
// click so Space / Enter can never press it later.

import { confirmClick } from './confirm.js';
import { CameraSource } from './camera.js';
import {
  colorCss, defaultColors, exportColors, importColors, inRange, loadColors, rangeFromSamples, rgbToHsv, saveColors,
  widenRange,
} from './colors.js';
import { CONFIG } from './config.js';
import { isTypingTarget } from './controls.js';
import {
  checkpointLabel, checkpointsAdjust, checkpointsReset, checkpointsUpdate, loadLine, saveLine, steerView, tapesTotal,
} from './line.js';
import * as ov from './overlay.js';
import {
  approachView, loadPoles, nextColor, orderText, parseOrder, pickPoles, polesHit, polesReset, polesSetOrder,
  polesUndo, savePoles,
} from './poles.js';
import {
  dockingView, isTagId, loadTags, saveTags, selectTag, selectionView, tagsReset, tagsSetRule, tagsUndo, tagsUpdate,
} from './tags.js';
import { DOCK } from './sim.js';
import { SCENE_LABELS, TestScene } from './testscene.js';
import {
  attemptPause, attemptReset, attemptStart, attemptView, holdReset, holdStart, holdStop, holdView, loadAttempt,
  loadHold, saveAttempt, saveHold,
} from './timers.js';
import { VisionLink } from './vision_link.js';

const $ = (id) => document.getElementById(id);

// config.js values with safe fallbacks (an old config.js must not break the page).
const C = {
  visionPort: CONFIG.visionPort ?? 8766,
  camera: { width: 1280, height: 720, hfovDeg: 70, underwater: true, ...CONFIG.camera },
  vision: {
    sendHz: 10, jpegQuality: 0.8, timeoutMs: 2000, ...CONFIG.vision,
    sendWidth: { tags: 1280, line: 640, colors: 640, ...CONFIG.vision?.sendWidth },
  },
  m21: { expected: 3, confirmFrames: 5, minMargin: 10, maxHamming: 1, clahe: true, ...CONFIG.mission21 },
  m22: { alignDeg: 5, alignVertM: 0.08, slowDistM: 1.0, aimBelowM: 0, ...CONFIG.mission22 },
  m3: { checkpoints: 3, spacingCm: 50, darkThresh: 25, refRow: 0.75, triggerRow: 0.75, steerDead: 0.08, ...CONFIG.mission3 },
  m4: { holdMs: 3000, ...CONFIG.mission4 },
  m5: { minAreaFrac: 0.0008, minAspect: 1.2, alignFrac: 0.08, closeFrac: 0.6, ...CONFIG.mission5 },
  attemptMs: (Number(CONFIG.attemptMinutes) > 0 ? Number(CONFIG.attemptMinutes) : 20) * 60000,
};

// Mission tab -> detector mode (null = no frames are sent) and practice scene.
const TABS = {
  drive: { title: 'Drive', mode: null, scene: null },
  m21: { title: '2.1 AprilTag scan', mode: 'tags', scene: 'tags' },
  m22: { title: '2.2 Chamber docking', mode: 'tags', scene: 'dock' },
  m3: { title: '3 Line following', mode: 'line', scene: 'line' },
  m4: { title: '4 Object retrieval', mode: null, scene: 'hook' },
  m5: { title: '5 Pole colours', mode: 'colors', scene: 'poles' },
};

const STALE_MS = 1000;        // never draw detections older than this
const TAG_SIZE_M = 0.162;     // contest tags: 16.2 cm black square
const TEST_SOURCE = 'test';
// In the simulator each tag sits this far above its chamber entrance (sim.js layout).
const SIM_AIM_BELOW_M = DOCK.cells[0].tag.center[2] - DOCK.cells[0].entrance[2];
const PREFS_KEY = 'rov.vision.v1';
const LINE_MASK_TINT = [255, 79, 216]; // magenta: stands out on the blue pool
const FILTERS = { brightness: [50, 250], contrast: [50, 250], saturation: [0, 300] };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const numIn = (v, [lo, hi], fallback) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const signed = (v, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Effective horizontal FOV: a flat port in water narrows the view by the refractive index.
export function effectiveHfov(hfovDeg, underwater) {
  if (!underwater) return hfovDeg;
  return (2 * Math.atan(Math.tan((hfovDeg * Math.PI) / 360) / 1.333) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Per-browser preferences (tab, source, filters, lens, detector tuning)
// ---------------------------------------------------------------------------

function defaultPrefs() {
  return {
    tab: 'drive',
    source: '',
    running: false,
    big: false,
    filters: { brightness: 100, contrast: 100, saturation: 100 },
    hfovDeg: numIn(C.camera.hfovDeg, [20, 170], 70),
    underwater: C.camera.underwater !== false,
    clahe: C.m21.clahe !== false,
    tagMargin: numIn(C.m21.minMargin, [0, 200], 10), // was minMargin (default 20) before 2026-10-21: reset
    target: null,
    darkThresh: numIn(C.m3.darkThresh, [5, 120], 25),
    lineMask: false,
    colorSel: 'red',
    colorMask: false,
    calibSeen: false,
    hook: null,
  };
}

function loadPrefs(store) {
  const p = defaultPrefs();
  let raw = null;
  try {
    raw = JSON.parse(store?.getItem(PREFS_KEY) ?? 'null');
  } catch {
    return p;
  }
  if (!raw || typeof raw !== 'object') return p;
  if (Object.hasOwn(TABS, raw.tab)) p.tab = raw.tab;
  if (typeof raw.source === 'string' && raw.source.length < 512) p.source = raw.source;
  for (const k of ['running', 'big', 'underwater', 'clahe', 'lineMask', 'colorMask', 'calibSeen']) {
    if (typeof raw[k] === 'boolean') p[k] = raw[k];
  }
  for (const [k, range] of Object.entries(FILTERS)) p.filters[k] = numIn(raw.filters?.[k], range, p.filters[k]);
  p.hfovDeg = numIn(raw.hfovDeg, [20, 170], p.hfovDeg);
  p.tagMargin = numIn(raw.tagMargin, [0, 200], p.tagMargin);
  p.darkThresh = numIn(raw.darkThresh, [5, 120], p.darkThresh);
  if (isTagId(raw.target)) p.target = raw.target;
  if (typeof raw.colorSel === 'string' && /^[a-z0-9_-]{1,16}$/.test(raw.colorSel)) p.colorSel = raw.colorSel;
  const h = raw.hook;
  if (Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) p.hook = [...h];
  return p;
}

// ---------------------------------------------------------------------------
// Module state (one camera panel per page)
// ---------------------------------------------------------------------------

let env = null;   // {log, notify, store, isArmed}
let prefs = null;
let el = null;    // DOM elements
let camera = null;
let link = null;
let scene = null;

const S = {
  tab: 'drive',
  m21: null, m3: null, m4: null, m5: null, colors: null, attempt: null,
  last: null,          // {msg, tab, capturedAt, at}: last result for the active tab
  steer: null,         // steerView() of the last line result
  lastSide: null,      // where the line was last seen (LINE LOST hint)
  mask: null,          // {capturedAt, tab}: maskCanvas holds the picture
  maskSeq: 0,
  aiming: false,       // Mission 4: next click on the video sets the hook point
  sampling: false,     // Mission 5: clicks on the video sample a colour
  sampleMark: null,    // {p, at, color}
  starting: false,
  camError: '',
  lostAt: null,        // camera signal lost at (performance.now): reconnecting until it is back
  reconnectTimer: null,
  lastFrameAt: null,   // last frame the video showed (frozen-picture check)
  securedLogged: false,
  error: null,         // {text, at}: last vision error
  errorLogMs: -Infinity,
  errorsQuiet: 0,
  visionWasOpen: false,
  fps: { frames: 0, t0: 0, value: null },
  cssW: 0, cssH: 0,
  view: null,
  overlayFailed: false,
};

let maskCanvas = null;
let captureCanvas = null;
let sampleCanvas = null;

function savePrefs() {
  try {
    env.store?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // blocked or full: preferences are a convenience
  }
}

// Mission state must survive a reload: say so once if the browser refuses to keep it.
let storageWarned = false;
// Practice in the simulator works on throw-away copies: it must never leave confirmed tags, a tape
// count or sampled colours behind for the real attempt. 'real' | 'sim'.
let stateSet = 'real';

function useStateSet(set) {
  if (set === stateSet) return;
  stateSet = set;
  if (set === 'sim') { // start clean, keep the rule / order so practice looks like the real thing
    S.m21 = tagsReset(S.m21);
    S.m3 = checkpointsReset(S.m3);
    S.m4 = holdReset();
    S.m5 = polesReset(S.m5);
  } else { // back to the camera: what was saved for the real attempt
    S.m21 = loadTags(env.store);
    S.m3 = loadLine(env.store, tapesTotal(C.m3.checkpoints));
    S.m4 = loadHold(env.store);
    S.m5 = loadPoles(env.store);
    S.colors = loadColors(env.store);
  }
  S.securedLogged = holdView(S.m4, 0, C.m4.holdMs).secured;
}

function persist(save, value) {
  if (stateSet === 'sim' && save !== saveAttempt) return; // the attempt clock is the same in both
  if (save(env.store, value) || storageWarned) return;
  storageWarned = true;
  env.notify('This browser cannot remember mission state (storage blocked or full)', 'warn');
}

const effHfov = () => clamp(effectiveHfov(prefs.hfovDeg, prefs.underwater), 20, 170);
const isArmed = () => {
  try {
    return Boolean(env.isArmed());
  } catch {
    return false;
  }
};

// A button that cannot keep focus: Space / Enter must never press it later (lesson from app.js).
function onClick(btn, fn) {
  btn.addEventListener('click', (e) => {
    e.currentTarget.blur();
    fn(e);
  });
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// setAttribute, not className: className is read-only on SVG elements (the hold ring).
function setKind(node, base, kind) {
  const cls = kind ? `${base} ${kind}` : base;
  if (node.getAttribute('class') !== cls) node.setAttribute('class', cls);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Returns {render(now), ...}: call render at the GUI tick (status chips and side panels). The overlay
// has its own requestAnimationFrame loop. Never throws: a broken camera panel must not take the
// drive controls down with it.
let api = null;
export function initVision(opts = {}) {
  if (api) return api;
  try {
    api = setup(opts);
  } catch (e) {
    console.error('camera panel', e);
    opts.log?.(`camera panel disabled: ${e.message}`, 'err');
    api = { render() {} };
  }
  return api;
}

function setup({ log, notify, storage, controller, isArmed: armedFn, getAxes }) {
  if (!$('panel-camera')) return { render() {} }; // a page without the camera panel
  const store = typeof storage === 'function' ? storage() : storage ?? null;
  env = {
    log: log ?? (() => {}),
    notify: notify ?? (() => {}),
    store,
    isArmed: armedFn ?? (() => controller?.armed ?? false),
  };
  if (!store) env.log('camera: this browser blocks storage, mission state is not remembered over a reload', 'W');

  prefs = loadPrefs(store);
  S.m21 = loadTags(store);
  S.m3 = loadLine(store, tapesTotal(C.m3.checkpoints));
  S.m4 = loadHold(store);
  S.securedLogged = holdView(S.m4, 0, C.m4.holdMs).secured;
  S.m5 = loadPoles(store);
  S.colors = loadColors(store);
  S.attempt = loadAttempt(store, C.attemptMs);

  collectElements();
  captureCanvas = document.createElement('canvas');
  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = sampleCanvas.height = 9;
  maskCanvas = document.createElement('canvas');

  camera = new CameraSource(el.video, { onEnded: onCameraEnded });
  scene = new TestScene({
    getAxes: () => (getAxes ? getAxes() : { surge: 0, yaw: 0, heave: 0 }),
    getHfov: effHfov,
  });
  link = new VisionLink({
    url: `ws://${location.hostname || 'localhost'}:${visionPort()}`,
    timeoutMs: C.vision.timeoutMs,
    onResult,
    onError: onVisionError,
    onHello: onVisionHello,
    onClose: onVisionClose,
  });

  buildHeader();
  buildStage();
  buildDrive();
  buildM21();
  buildM22();
  buildM3();
  buildM4();
  buildM5();
  setTab(prefs.tab);
  setBig(prefs.big);
  bindKeys();

  link.start();
  setInterval(captureTick, 1000 / clamp(Number(C.vision.sendHz) || 10, 1, 30));
  requestAnimationFrame(frameLoop);
  watchVideoFrames();
  refreshSources().then(() => {
    if (!prefs.running) return;
    // page reloaded mid-mission: bring the picture back; a camera that is not there yet is retried
    startSource({ auto: true }).then((ok) => {
      if (ok === false && el.source.value !== TEST_SOURCE) onCameraEnded(); // null = superseded, not lost
    });
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    refreshSources();
    if (S.lostAt !== null) scheduleReconnect(100); // the camera may be back: try at once
  });

  return { render, get link() { return link; }, get camera() { return camera; }, get scene() { return scene; }, state: S };
}

function visionPort() {
  const p = Number(new URLSearchParams(location.search).get('visionPort'));
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : C.visionPort;
}

function collectElements() {
  const ids = {
    tabs: 'cam-tabs', source: 'cam-source', start: 'cam-start', big: 'cam-big',
    clockText: 'clock-text', clockStart: 'clock-start', clockReset: 'clock-reset',
    stage: 'cam-stage', video: 'cam-video', canvas: 'cam-overlay', placeholder: 'cam-placeholder',
    bright: 'cam-bright', contrast: 'cam-contrast', sat: 'cam-sat',
    brightOut: 'cam-bright-out', contrastOut: 'cam-contrast-out', satOut: 'cam-sat-out', filterReset: 'cam-filter-reset',
    simBar: 'sim-bar', simScene: 'sim-scene', simReset: 'sim-reset',
    hfov: 'cam-hfov', underwater: 'cam-underwater', hfovEff: 'cam-hfov-eff',
    m21Big: 'm21-big', m21Sub: 'm21-sub', m21Count: 'm21-count', m21Confirmed: 'm21-confirmed', m21InView: 'm21-inview',
    m21Undo: 'm21-undo', m21Reset: 'm21-reset', m21Status: 'm21-status', m21Clahe: 'm21-clahe', m21Margin: 'm21-margin',
    m21Rule: 'm21-rule',
    m22Target: 'm22-target', m22Use: 'm22-use', m22From21: 'm22-from21', m22Big: 'm22-big', m22Hint: 'm22-hint',
    m22Dist: 'm22-dist', m22Bearing: 'm22-bearing', m22Vert: 'm22-vert', m22Yaw: 'm22-yaw',
    m3Big: 'm3-big', m3Dead: 'm3-dead', m3Needle: 'm3-needle', m3Angle: 'm3-angle', m3Offset: 'm3-offset',
    m3Conf: 'm3-conf', m3Track: 'm3-track', m3Label: 'm3-label', m3Minus: 'm3-minus', m3Plus: 'm3-plus',
    m3Reset: 'm3-reset', m3Auto: 'm3-auto', m3Dark: 'm3-dark', m3DarkOut: 'm3-dark-out', m3Mask: 'm3-mask',
    m4Ring: 'm4-ring', m4Time: 'm4-time', m4Need: 'm4-need', m4Toggle: 'm4-toggle', m4ToggleText: 'm4-toggle-text',
    m4Secured: 'm4-secured', m4Best: 'm4-best', m4Reset: 'm4-reset', m4Aim: 'm4-aim', m4AimHint: 'm4-aim-hint',
    m5Order: 'm5-order', m5Set: 'm5-set', m5Seq: 'm5-seq', m5Big: 'm5-big', m5Hint: 'm5-hint', m5Hit: 'm5-hit',
    m5Undo: 'm5-undo', m5Reset: 'm5-reset', m5Calib: 'm5-calib', m5Color: 'm5-color', m5Sample: 'm5-sample',
    m5Swatch: 'm5-swatch', m5Sliders: 'm5-sliders', m5Mask: 'm5-mask', m5ColorReset: 'm5-color-reset',
    m5Export: 'm5-export', m5Import: 'm5-import', m5File: 'm5-file',
  };
  el = {};
  for (const [key, id] of Object.entries(ids)) {
    const node = $(id);
    if (!node) throw new Error(`camera panel: #${id} is missing in index.html`);
    el[key] = node;
  }
  el.ctx = el.canvas.getContext('2d');
}

// ---------------------------------------------------------------------------
// Header: tabs, source, attempt clock, big view
// ---------------------------------------------------------------------------

function buildHeader() {
  for (const btn of el.tabs.querySelectorAll('[data-tab]')) onClick(btn, () => setTab(btn.dataset.tab));

  el.source.addEventListener('change', () => {
    prefs.source = el.source.value;
    savePrefs();
    if (camera.running || S.starting || S.lostAt !== null) startSource();
  });
  onClick(el.start, () => {
    if (camera.running || S.starting || S.lostAt !== null) stopSource(); // Stop also ends a reconnect
    else startSource();
  });

  onClick(el.clockStart, () => {
    const now = Date.now();
    S.attempt = S.attempt.running ? attemptPause(S.attempt, now) : attemptStart(S.attempt, now);
    persist(saveAttempt, S.attempt);
    env.log(`attempt clock ${S.attempt.running ? 'started' : 'paused'} at ${attemptView(S.attempt, now).text}`, 'N');
  });
  onClick(el.clockReset, () => {
    const used = S.attempt.running || S.attempt.usedMs > 0;
    if (used && !confirmClick(el.clockReset, 'Reset? click again')) return;
    S.attempt = attemptReset(S.attempt);
    persist(saveAttempt, S.attempt);
    env.log('attempt clock reset', 'N');
  });

  onClick(el.big, () => setBig(!prefs.big));
  // Big view sits under the sticky status bar: follow its height (it wraps on narrow windows).
  const bar = $('statusbar');
  const setBarH = () => document.documentElement.style.setProperty('--sb-h', `${bar?.offsetHeight ?? 0}px`);
  setBarH();
  if (bar && typeof ResizeObserver === 'function') new ResizeObserver(setBarH).observe(bar);
}

function setTab(tab) {
  if (!Object.hasOwn(TABS, tab)) tab = 'drive';
  S.tab = tab;
  S.last = null;
  S.mask = null;
  S.steer = null;
  setAiming(false);
  setSampling(false);
  for (const btn of el.tabs.querySelectorAll('[data-tab]')) {
    const on = btn.dataset.tab === tab;
    btn.setAttribute('aria-selected', String(on));
    btn.classList.toggle('active', on);
  }
  for (const name of Object.keys(TABS)) {
    const pane = $(`side-${name}`);
    if (pane) pane.hidden = name !== tab;
  }
  if (TABS[tab].scene) scene.setScene(TABS[tab].scene);
  prefs.tab = tab;
  savePrefs();
}

function setBig(on) {
  prefs.big = Boolean(on);
  document.body.classList.toggle('bigview', prefs.big);
  el.big.setAttribute('aria-pressed', String(prefs.big));
  el.big.textContent = prefs.big ? 'Exit big view' : 'Big view';
  savePrefs();
}

// ---------------------------------------------------------------------------
// Video source
// ---------------------------------------------------------------------------

async function refreshSources() {
  const cams = await camera.listDevices();
  const opts = [];
  const seen = new Set();
  cams.forEach((d, i) => {
    const value = `cam:${d.deviceId ?? ''}`;
    if (seen.has(value)) return;
    seen.add(value);
    opts.push([value, d.label || (d.deviceId ? `Camera ${i + 1}` : 'Camera (default)')]);
  });
  if (!opts.length) opts.push(['cam:', 'Camera (default)']);
  if (prefs.source.startsWith('cam:') && !seen.has(prefs.source) && prefs.source !== 'cam:') {
    opts.push([prefs.source, 'Camera (last used)']);
  }
  opts.push([TEST_SOURCE, 'Test scene (simulator)']);
  const key = opts.map((o) => o.join('=')).join('|');
  if (el.source.dataset.key !== key) {
    el.source.dataset.key = key;
    el.source.replaceChildren(...opts.map(([value, text]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    }));
  }
  const want = opts.some(([v]) => v === prefs.source) ? prefs.source : opts[0][0];
  if (el.source.value !== want) el.source.value = want;
}

// Resolves to true when the picture is running. reconnect: a retry after a lost signal (quiet on failure).
async function startSource({ auto = false, reconnect = false } = {}) {
  if (!reconnect) cancelReconnect();
  const src = el.source.value || TEST_SOURCE;
  S.camError = '';
  S.last = null;
  S.mask = null;
  useStateSet(src === TEST_SOURCE ? 'sim' : 'real');
  try {
    if (src === TEST_SOURCE) {
      camera.startTestScene((ctx, dt) => scene.draw(ctx, dt), { width: 1280, height: 720, fps: 30 });
      env.log(`camera: test scene, ${SCENE_LABELS[scene.scene] ?? scene.scene}`, 'B');
    } else {
      S.starting = true;
      const stream = await camera.startCamera(src.slice(4) || null, { width: C.camera.width, height: C.camera.height });
      if (!stream) return null; // superseded: Stop or another source was chosen while waiting for permission
      const track = stream.getVideoTracks()[0];
      const s = track?.getSettings?.() ?? {};
      env.log(`camera: ${track?.label || 'camera'} ${s.width ?? '?'}x${s.height ?? '?'} @ ${Math.round(s.frameRate ?? 0) || '?'} fps`, 'B');
      if (camera.deviceId) prefs.source = `cam:${camera.deviceId}`;
      refreshSources(); // labels are known now
    }
    prefs.running = true;
    savePrefs();
    S.lastFrameAt = performance.now();
    return true;
  } catch (e) {
    if (reconnect) {
      if (S.lostAt !== null) S.camError = `${LOST_TEXT} (${e.message})`; // not after a Stop meanwhile
      return false; // keep prefs.running: the retry goes on
    }
    S.camError = e.message;
    prefs.running = false;
    savePrefs();
    env.log(`camera: ${e.message}`, 'err');
    if (!auto) env.notify(e.message, 'bad');
    return false;
  } finally {
    S.starting = false;
  }
}

function stopSource() {
  cancelReconnect();
  S.camError = '';
  camera.stop();
  S.starting = false;
  S.last = null;
  S.mask = null;
  prefs.running = false;
  savePrefs();
}

// A loose USB cable drops the camera for a moment (the track ends) or freezes the picture.
// Either way: retry the same camera every RECONNECT_MS (and at once when a device appears)
// until it is back, or until Stop / another source is chosen.
const RECONNECT_MS = 500;
const STALL_MS = 2500;
const LOST_TEXT = 'Camera signal lost: reconnecting… check the camera cable';

function onCameraEnded() {
  S.last = null;
  S.mask = null;
  if (S.lostAt === null) {
    S.lostAt = performance.now();
    env.notify('Camera signal lost: reconnecting automatically', 'bad', 5000);
    env.log('camera: signal lost, reconnecting', 'err');
  }
  S.camError = LOST_TEXT;
  scheduleReconnect(RECONNECT_MS);
}

function scheduleReconnect(delayMs) {
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = setTimeout(tryReconnect, delayMs);
}

function cancelReconnect() {
  clearTimeout(S.reconnectTimer);
  S.reconnectTimer = null;
  S.lostAt = null;
}

async function tryReconnect() {
  S.reconnectTimer = null;
  if (S.lostAt === null || camera.running || S.starting) return;
  const ok = await startSource({ auto: true, reconnect: true });
  if (S.lostAt === null) return; // Stop or another source meanwhile
  if (ok && camera.running) { // running: the track may have ended again while play() was starting
    const sec = ((performance.now() - S.lostAt) / 1000).toFixed(1);
    S.lostAt = null;
    env.log(`camera: back after ${sec} s`, 'B');
    env.notify(`Camera back after ${sec} s`, 'warn', 3000);
  } else {
    scheduleReconnect(RECONNECT_MS);
  }
}

// Frozen picture (the camera is still "connected" but sends nothing): restart it. Only while the
// page is visible: hidden tabs throttle the frame callbacks.
function checkStall(now) {
  if (camera.kind !== 'camera' || S.starting || S.lostAt !== null || S.lastFrameAt === null) return;
  if (document.visibilityState !== 'visible') {
    S.lastFrameAt = now;
    return;
  }
  if (now - S.lastFrameAt > STALL_MS) {
    env.log(`camera: no picture for ${(STALL_MS / 1000).toFixed(1)} s, restarting it`, 'err');
    camera.stop();
    onCameraEnded();
  }
}

// Camera frames per second, counted on the frames the video element really shows.
function watchVideoFrames() {
  const v = el.video;
  if (typeof v.requestVideoFrameCallback !== 'function') return;
  const cb = () => {
    S.fps.frames++;
    S.lastFrameAt = performance.now();
    v.requestVideoFrameCallback(cb);
  };
  v.requestVideoFrameCallback(cb);
}

// ---------------------------------------------------------------------------
// Stage: filters, overlay canvas size, clicks on the picture, simulator bar
// ---------------------------------------------------------------------------

function buildStage() {
  const sliders = [[el.bright, el.brightOut, 'brightness'], [el.contrast, el.contrastOut, 'contrast'], [el.sat, el.satOut, 'saturation']];
  const apply = () => {
    const f = prefs.filters;
    const css = `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturation}%)`;
    el.video.style.filter = css === 'brightness(100%) contrast(100%) saturate(100%)' ? '' : css;
    for (const [input, out, key] of sliders) {
      input.value = String(f[key]);
      out.textContent = `${f[key]}%`;
    }
  };
  for (const [input, , key] of sliders) {
    input.addEventListener('input', () => {
      prefs.filters[key] = numIn(Number(input.value), FILTERS[key], 100);
      apply();
    });
    input.addEventListener('change', savePrefs);
  }
  onClick(el.filterReset, () => {
    prefs.filters = defaultPrefs().filters;
    apply();
    savePrefs();
  });
  apply();

  const measure = () => {
    S.cssW = el.stage.clientWidth;
    S.cssH = el.stage.clientHeight;
  };
  measure();
  if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(el.stage);
  else window.addEventListener('resize', measure);

  el.canvas.addEventListener('pointerdown', onPictureClick);
  onClick(el.simReset, () => scene.reset());
}

function onPictureClick(e) {
  if (e.button !== 0 || !S.view) return;
  if (!(S.aiming && S.tab === 'm4') && !(S.sampling && S.tab === 'm5')) return;
  const rect = el.canvas.getBoundingClientRect();
  const p = ov.cssToPicture(S.view, e.clientX - rect.left, e.clientY - rect.top);
  if (!p) return; // on the black bars
  if (S.tab === 'm4') {
    prefs.hook = p;
    savePrefs();
    setAiming(false);
  } else {
    sampleColor(p, e.shiftKey);
  }
}

// ---------------------------------------------------------------------------
// Capture loop: one frame in flight, only while a vision mission is active
// ---------------------------------------------------------------------------

function tagParams() {
  return {
    clahe: prefs.clahe, minMargin: prefs.tagMargin, maxHamming: numIn(C.m21.maxHamming, [0, 2], 1),
    expect: C.m21.expected,
  };
}

function paramsFor(tab) {
  switch (tab) {
    case 'm21':
      return { ...tagParams(), tagSizeM: TAG_SIZE_M };
    case 'm22':
      return { ...tagParams(), tagSizeM: TAG_SIZE_M, hfovDeg: Math.round(effHfov() * 10) / 10 };
    case 'm3':
      return { darkThresh: prefs.darkThresh, refRow: C.m3.refRow, mask: prefs.lineMask };
    case 'm5':
      return {
        colors: S.colors, minAreaFrac: C.m5.minAreaFrac, maxBlobs: 3,
        mask: prefs.colorMask && Object.hasOwn(S.colors, prefs.colorSel) ? prefs.colorSel : null,
      };
    default:
      return {};
  }
}

function captureTick() {
  const tab = S.tab;
  const mode = TABS[tab].mode;
  const v = el.video;
  if (!mode || !camera.running || !link.ready || link.busy) return;
  if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
  const w = Math.min(Number(C.vision.sendWidth[mode]) || 640, v.videoWidth);
  const h = Math.max(1, Math.round((w * v.videoHeight) / v.videoWidth));
  const id = link.begin({ mode, tab });
  if (id === null) return;
  try {
    if (captureCanvas.width !== w) captureCanvas.width = w;
    if (captureCanvas.height !== h) captureCanvas.height = h;
    captureCanvas.getContext('2d', { alpha: false }).drawImage(v, 0, 0, w, h); // raw frame: no view filters
  } catch {
    link.cancel(id);
    return;
  }
  // toDataURL, not toBlob: Chrome encodes toBlob in idle time, and on a busy page (overlay, test
  // scene, command loop) that took seconds. toDataURL costs a few ms, always.
  let jpeg;
  try {
    jpeg = dataUrlBytes(captureCanvas.toDataURL('image/jpeg', clamp(Number(C.vision.jpegQuality) || 0.8, 0.3, 1)));
  } catch {
    jpeg = null;
  }
  if (!jpeg || jpeg.length < 100) {
    link.cancel(id);
    return;
  }
  link.send(id, { mode, params: paramsFor(tab) }, jpeg);
}

function dataUrlBytes(url) {
  const b64 = url.slice(url.indexOf(',') + 1);
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Vision results
// ---------------------------------------------------------------------------

function onResult(msg, meta) {
  if (meta.tab !== S.tab || msg.mode !== TABS[S.tab].mode) return; // answer for another mission
  const now = performance.now();
  S.last = { msg, tab: meta.tab, capturedAt: meta.capturedAt, at: now };
  S.error = null;
  if (msg.mask) setMask(msg.mask, meta);

  if (meta.tab === 'm21') {
    const ids = msg.tags.map((t) => t.id);
    const r = tagsUpdate(S.m21, ids, C.m21.confirmFrames);
    if (r.state !== S.m21) {
      S.m21 = r.state;
      persist(saveTags, S.m21);
    }
    for (const id of r.newly) env.log(`2.1: tag ID ${id} confirmed (${S.m21.confirmed.length} / ${C.m21.expected})`, 'N');
  } else if (meta.tab === 'm3') {
    const tapes = (msg.line?.tapes ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[1])).map((p) => p[1] / msg.h);
    const before = S.m3.count;
    S.m3 = checkpointsUpdate(S.m3, tapes, now, { triggerRow: C.m3.triggerRow, debounceMs: 1500, total: tapesTotal(C.m3.checkpoints) });
    if (S.m3.count !== before) {
      persist(saveLine, S.m3);
      env.log(`3: ${checkpointLabel(S.m3.count, C.m3.checkpoints, C.m3.spacingCm)} (tape counted)`, 'N');
    }
    S.steer = steerView(msg.line, steerCfg(), S.lastSide);
    S.lastSide = S.steer.side;
  }
}

const steerCfg = () => ({ steerDead: C.m3.steerDead, angleGain: C.m3.angleGain ?? 1 / 45, offsetGain: C.m3.offsetGain ?? 1 });

// The result for the active tab, if it is fresh enough to draw.
function fresh(now) {
  const L = S.last;
  return L && L.tab === S.tab && now - L.capturedAt <= STALE_MS ? L : null;
}

// Mask PNG (white = detected) -> a tinted, transparent picture for the overlay.
function setMask(dataUrl, meta) {
  const seq = ++S.maskSeq;
  const img = new Image();
  img.onload = () => {
    if (seq !== S.maskSeq || meta.tab !== S.tab) return; // a newer mask came meanwhile
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      if (maskCanvas.width !== w) maskCanvas.width = w;
      if (maskCanvas.height !== h) maskCanvas.height = h;
      const g = maskCanvas.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, w, h);
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, w, h);
      const tint = meta.tab === 'm3' ? LINE_MASK_TINT : hexRgb(colorCss(prefs.colorSel));
      for (let i = 0; i < d.data.length; i += 4) {
        const a = d.data[i];
        d.data[i] = tint[0];
        d.data[i + 1] = tint[1];
        d.data[i + 2] = tint[2];
        d.data[i + 3] = a;
      }
      g.putImageData(d, 0, 0);
      S.mask = { capturedAt: meta.capturedAt, tab: meta.tab };
    } catch {
      S.mask = null;
    }
  };
  img.onerror = () => {};
  img.src = dataUrl;
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);

function onVisionError(msg) {
  const now = performance.now();
  S.error = { text: msg.text, at: now };
  if (now - S.errorLogMs < 5000) {
    S.errorsQuiet++;
    return;
  }
  const more = S.errorsQuiet ? ` (+${S.errorsQuiet} more)` : '';
  S.errorsQuiet = 0;
  S.errorLogMs = now;
  env.log(`vision error: ${msg.text}${more}`, 'err');
}

function onVisionHello(msg) {
  S.visionWasOpen = true;
  if (msg.available) env.log(`vision: connected (${msg.modes.join(', ') || 'no modes'})`, 'B');
  else env.log(`vision: UNAVAILABLE in the bridge: ${msg.reason || 'unknown reason'}`, 'err');
}

function onVisionClose() {
  S.last = null;
  if (!S.visionWasOpen) return; // the bridge may simply not be started yet: stay quiet
  S.visionWasOpen = false;
  env.log('vision: disconnected', 'err');
}

// Why there is no fresh detection, or null when there is one (or the tab needs none).
function detectorStatus(now) {
  const mode = TABS[S.tab].mode;
  if (!mode) return null;
  if (!camera.running) return { text: 'NO VIDEO', sub: 'Pick a source and press Start', kind: 'idle' };
  if (!link.isOpen) return { text: 'VISION OFF', sub: `No vision service on port ${visionPort()}: is the bridge running?`, kind: 'bad' };
  if (link.available === null) return { text: 'CONNECTING', sub: 'Waiting for the vision service', kind: 'idle' };
  if (link.available === false) return { text: 'VISION UNAVAILABLE', sub: link.reason || 'OpenCV / pupil-apriltags missing in the bridge', kind: 'bad' };
  if (fresh(now)) return null;
  if (S.error && now - S.error.at < 3000) return { text: 'DETECTOR ERROR', sub: S.error.text, kind: 'bad' };
  const slow = link.rttMs !== null && link.rttMs > STALE_MS;
  return { text: 'WAITING FOR DETECTOR', sub: slow ? `answers take ${Math.round(link.rttMs)} ms: too slow to draw` : '', kind: 'warn' };
}

// ---------------------------------------------------------------------------
// Drive tab: lens
// ---------------------------------------------------------------------------

function buildDrive() {
  el.hfov.value = String(prefs.hfovDeg);
  el.underwater.checked = prefs.underwater;
  el.hfov.addEventListener('change', () => {
    const v = Number(el.hfov.value);
    if (Number.isFinite(v) && v >= 20 && v <= 170) prefs.hfovDeg = v;
    else env.notify('HFOV must be 20 .. 170 degrees', 'bad');
    el.hfov.value = String(prefs.hfovDeg);
    savePrefs();
  });
  el.underwater.addEventListener('change', () => {
    prefs.underwater = el.underwater.checked;
    el.underwater.blur();
    savePrefs();
  });
}

// ---------------------------------------------------------------------------
// 2.1 AprilTag scan
// ---------------------------------------------------------------------------

function buildM21() {
  for (const btn of el.m21Rule.querySelectorAll('[data-rule]')) {
    onClick(btn, () => {
      S.m21 = tagsSetRule(S.m21, btn.dataset.rule);
      persist(saveTags, S.m21);
      env.log(`2.1: rule ${btn.dataset.rule.toUpperCase()}`, 'N');
    });
  }
  onClick(el.m21Undo, () => {
    const id = S.m21.confirmed.at(-1);
    if (id === undefined) return;
    S.m21 = tagsUndo(S.m21);
    persist(saveTags, S.m21);
    env.log(`2.1: tag ID ${id} removed, ignored until Reset`, 'W');
  });
  onClick(el.m21Reset, () => {
    if (S.m21.confirmed.length && !confirmClick(el.m21Reset, 'Forget all tags? click again')) return;
    S.m21 = tagsReset(S.m21);
    persist(saveTags, S.m21);
    env.log('2.1: tags reset', 'N');
  });
  el.m21Clahe.checked = prefs.clahe;
  el.m21Clahe.addEventListener('change', () => {
    prefs.clahe = el.m21Clahe.checked;
    el.m21Clahe.blur();
    savePrefs();
  });
  el.m21Margin.value = String(prefs.tagMargin);
  el.m21Margin.addEventListener('change', () => {
    const v = Number(el.m21Margin.value);
    if (Number.isFinite(v)) prefs.tagMargin = clamp(Math.round(v), 0, 200);
    el.m21Margin.value = String(prefs.tagMargin);
    savePrefs();
  });
}

// Chips from [{text, cls, title}], rebuilt only when they change.
function renderChips(host, items, empty = '–') {
  const key = JSON.stringify(items);
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren(...(items.length ? items : [{ text: empty, cls: 'none' }]).map((it) => {
    const s = document.createElement('span');
    s.className = `tagchip ${it.cls ?? ''}`;
    s.textContent = it.text;
    if (it.title) s.title = it.title;
    return s;
  }));
}

function renderM21(now) {
  const view = selectionView(S.m21, C.m21.expected);
  setText(el.m21Big, view.big);
  setKind(el.m21Big, 'vbig', view.kind);
  setText(el.m21Sub, view.sub);
  const k = S.m21.confirmed.length;
  setText(el.m21Count, `${k} / ${C.m21.expected}`);
  setKind(el.m21Count, 'count', k === C.m21.expected ? 'ok' : k > C.m21.expected ? 'bad' : '');
  const selected = view.final ? selectTag(S.m21.confirmed, S.m21.rule) : null;
  renderChips(el.m21Confirmed, S.m21.confirmed.map((id) => ({
    text: id === selected ? `ID ${id} ★` : `ID ${id}`, cls: id === selected ? 'sel' : 'ok',
  })));
  const L = fresh(now);
  const need = C.m21.confirmFrames;
  renderChips(el.m21InView, (L?.msg.tags ?? []).map((t) => {
    if (S.m21.ignored.includes(t.id)) return { text: `ID ${t.id} ignored`, cls: 'bad' };
    if (S.m21.confirmed.includes(t.id)) return { text: `ID ${t.id}`, cls: 'ok' };
    return { text: `ID ${t.id} ${Math.min(need, S.m21.seen[t.id] ?? 0)}/${need}`, cls: 'warn' };
  }).concat((L?.msg.weak ?? []).map((t) => ({ text: `ID ${t.id}? weak`, cls: 'none' }))), L ? 'none' : '–');
  for (const btn of el.m21Rule.querySelectorAll('[data-rule]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.rule === S.m21.rule));
  }
  el.m21Undo.disabled = k === 0;
  const st = detectorStatus(now);
  setText(el.m21Status, st ? `Detector: ${st.text.toLowerCase()}${st.sub ? `. ${st.sub}` : ''}` : '');
}

// ---------------------------------------------------------------------------
// 2.2 Chamber docking
// ---------------------------------------------------------------------------

function from21() {
  return selectTag(S.m21.confirmed, S.m21.rule);
}

function buildM22() {
  if (prefs.target !== null) el.m22Target.value = String(prefs.target);
  el.m22Target.addEventListener('change', () => {
    const raw = el.m22Target.value.trim();
    const v = Number(raw);
    if (raw === '') prefs.target = null;
    else if (isTagId(v)) prefs.target = v;
    else env.notify('Target tag ID must be a whole number 0 .. 586', 'bad');
    el.m22Target.value = prefs.target === null ? '' : String(prefs.target);
    savePrefs();
  });
  onClick(el.m22Use, () => {
    const id = from21();
    if (id === null) {
      env.notify('2.1 has no result yet: pick the rule and confirm tags first', 'warn');
      return;
    }
    prefs.target = id;
    el.m22Target.value = String(id);
    savePrefs();
    env.log(`2.2: target tag ID ${id} (from 2.1)`, 'N');
  });
}

// How far the chamber entrance is below its tag: the docking advice aims there, not at the tag.
const aimBelow = () => (camera?.kind === 'test' ? SIM_AIM_BELOW_M : numIn(C.m22.aimBelowM, [-2, 2], 0));

// The target tag in the fresh result (with the frame size for the pixel fallback), or null.
// Its pose is moved down to the entrance (camera y points down; the ROV is assumed level).
function dockTarget(L) {
  if (!L || prefs.target === null) return null;
  const t = L.msg.tags.find((x) => x.id === prefs.target);
  if (!t) return null;
  const below = aimBelow();
  const p = t.pose;
  if (!below || !p || ![p.x, p.y, p.z].every(Number.isFinite)) return { ...t, w: L.msg.w, h: L.msg.h };
  const y = p.y + below;
  return { ...t, w: L.msg.w, h: L.msg.h, pose: { ...p, y, dist: Math.hypot(p.x, y, p.z) }, aimed: true };
}

// Where the aim point is in the picture (frame px), or null when aiming at the tag itself.
function aimPixel(tag) {
  if (!tag?.aimed || !(tag.pose.z > 0)) return null;
  const f = tag.w / 2 / Math.tan((effHfov() * Math.PI) / 360);
  return [tag.w / 2 + (f * tag.pose.x) / tag.pose.z, tag.h / 2 + (f * tag.pose.y) / tag.pose.z];
}

function dockView(L) {
  return dockingView(dockTarget(L), { ...C.m22, hfovDeg: effHfov() });
}

function renderM22(now) {
  const L = fresh(now);
  const id21 = from21();
  setText(el.m22From21, id21 === null ? '2.1 has no selected tag yet.' : `2.1 result: ID ${id21}${id21 === prefs.target ? ' (in use)' : ''}`);
  const st = detectorStatus(now);
  const dv = dockView(L);
  let big = dv.text, kind = dv.kind, hint = dv.hint;
  if (prefs.target === null) {
    big = 'SET THE TARGET ID';
    kind = 'warn';
    hint = 'Type it, or take the 2.1 result';
  } else if (st) {
    big = st.text;
    kind = st.kind;
    hint = st.sub;
  } else if (!hint && dv.dist !== null) {
    const below = aimBelow();
    hint = below ? `Aiming ${Math.round(below * 100)} cm below tag ${prefs.target}: the entrance`
      : `Target ID ${prefs.target} at ${dv.dist.toFixed(2)} m`;
  }
  setText(el.m22Big, big);
  setKind(el.m22Big, 'vbig', kind);
  setText(el.m22Hint, hint);
  const live = !st && prefs.target !== null;
  setText(el.m22Dist, live && dv.dist !== null ? `${dv.dist.toFixed(2)} m` : '–');
  setText(el.m22Bearing, live && dv.bearingDeg !== null
    ? `${Math.abs(dv.bearingDeg).toFixed(1)}° ${dv.bearingDeg >= 0 ? 'right' : 'left'}` : '–');
  let vert = '–';
  if (live && dv.vertM !== null) vert = `${Math.abs(dv.vertM * 100).toFixed(0)} cm ${dv.vertM >= 0 ? 'below' : 'above'}`;
  else if (live && dv.vertDeg !== null) vert = `${Math.abs(dv.vertDeg).toFixed(1)}° ${dv.vertDeg >= 0 ? 'below' : 'above'}`;
  setText(el.m22Vert, vert);
  const pose = dockTarget(L)?.pose;
  setText(el.m22Yaw, live && dv.tagYawDeg !== null
    ? `${signed(dv.tagYawDeg)}°${pose?.yawOk === false ? ' (unsure)' : ''}` : '–');
}

// ---------------------------------------------------------------------------
// 3 Line following
// ---------------------------------------------------------------------------

function buildM3() {
  const total = tapesTotal(C.m3.checkpoints);
  const pips = [];
  for (let i = 0; i < total; i++) {
    const p = document.createElement('div');
    p.className = 'pip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const lab = document.createElement('small');
    lab.textContent = i === 0 ? 'start' : `${i * C.m3.spacingCm} cm`;
    p.append(dot, lab);
    pips.push(p);
  }
  el.m3Track.replaceChildren(...pips);
  el.m3Pips = pips;

  const adjust = (delta) => {
    S.m3 = checkpointsAdjust(S.m3, delta, total);
    persist(saveLine, S.m3);
    env.log(`3: ${checkpointLabel(S.m3.count, C.m3.checkpoints, C.m3.spacingCm)} (manual ${delta > 0 ? '+1' : '−1'})`, 'N');
  };
  onClick(el.m3Minus, () => adjust(-1));
  onClick(el.m3Plus, () => adjust(+1));
  onClick(el.m3Reset, () => {
    if (S.m3.count > 0 && !confirmClick(el.m3Reset, 'Reset count? click again')) return;
    S.m3 = checkpointsReset(S.m3);
    persist(saveLine, S.m3);
    env.log('3: checkpoints reset', 'N');
  });
  el.m3Auto.checked = S.m3.auto;
  el.m3Auto.addEventListener('change', () => {
    S.m3 = { ...S.m3, auto: el.m3Auto.checked };
    el.m3Auto.blur();
    persist(saveLine, S.m3);
  });
  el.m3Dark.value = String(prefs.darkThresh);
  el.m3DarkOut.textContent = String(prefs.darkThresh);
  el.m3Dark.addEventListener('input', () => {
    prefs.darkThresh = numIn(Number(el.m3Dark.value), [5, 120], 25);
    el.m3DarkOut.textContent = String(prefs.darkThresh);
  });
  el.m3Dark.addEventListener('change', savePrefs);
  el.m3Mask.checked = prefs.lineMask;
  el.m3Mask.addEventListener('change', () => {
    prefs.lineMask = el.m3Mask.checked;
    if (!prefs.lineMask) S.mask = null;
    el.m3Mask.blur();
    savePrefs();
  });
  const dead = clamp(Number(C.m3.steerDead) || 0, 0, 1);
  el.m3Dead.style.left = `${50 - dead * 50}%`;
  el.m3Dead.style.width = `${dead * 100}%`;
}

function renderM3(now) {
  const L = fresh(now);
  const st = detectorStatus(now);
  const sv = L ? S.steer : null;
  const big = st ?? sv ?? { text: 'LINE LOST', kind: 'bad' };
  setText(el.m3Big, big.text);
  setKind(el.m3Big, 'vbig', big.kind);
  const steer = sv && !sv.lost ? sv.steer : null;
  el.m3Needle.hidden = steer === null;
  if (steer !== null) el.m3Needle.style.left = `${50 + clamp(steer, -1, 1) * 50}%`;
  setKind(el.m3Needle, 'gauge-needle', sv?.kind ?? '');
  const line = L?.msg.line;
  setText(el.m3Angle, line && Number.isFinite(line.angleDeg) ? `${signed(line.angleDeg)}°` : '–');
  setText(el.m3Offset, line && Number.isFinite(line.offset) ? `${signed(line.offset, 2)} (${line.offset >= 0 ? 'right' : 'left'})` : '–');
  setText(el.m3Conf, line && Number.isFinite(line.confidence) ? `${Math.round(line.confidence * 100)} %` : '–');
  const n = S.m3.count;
  el.m3Pips.forEach((p, i) => {
    p.classList.toggle('done', i < n); // pip i = tape i + 1 (pip 0 = the start tape)
    p.classList.toggle('here', i === n - 1);
  });
  const label = checkpointLabel(n, C.m3.checkpoints, C.m3.spacingCm);
  setText(el.m3Label, label);
  setKind(el.m3Label, 'vmid', n >= tapesTotal(C.m3.checkpoints) ? 'ok' : '');
  el.m3Minus.disabled = n <= 0;
  el.m3Plus.disabled = n >= tapesTotal(C.m3.checkpoints);
  if (el.m3Auto.checked !== S.m3.auto) el.m3Auto.checked = S.m3.auto;
}

// ---------------------------------------------------------------------------
// 4 Object retrieval: hold timer and hook reticle
// ---------------------------------------------------------------------------

const RING_LEN = 2 * Math.PI * 52;

function toggleHold() {
  const now = performance.now();
  if (S.m4.running) {
    S.m4 = holdStop(S.m4, now);
    persist(saveHold, S.m4);
    env.log(`4: released after ${(S.m4.lastMs / 1000).toFixed(1)} s (best ${(S.m4.bestMs / 1000).toFixed(1)} s)`, 'N');
  } else {
    S.m4 = holdStart(S.m4, now);
    env.log('4: hooked, hold timer running', 'N');
  }
}

function setAiming(on) {
  S.aiming = Boolean(on);
  el.m4Aim.setAttribute('aria-pressed', String(S.aiming));
  el.m4Aim.textContent = S.aiming ? 'Click the video…' : 'Set hook point';
  el.canvas.classList.toggle('picking', S.aiming || S.sampling);
}

function buildM4() {
  el.m4Ring.style.strokeDasharray = `${RING_LEN}`;
  setText(el.m4Need, `s / ${(C.m4.holdMs / 1000).toFixed(1)} s`);
  onClick(el.m4Toggle, toggleHold);
  onClick(el.m4Reset, () => {
    if (S.m4.bestMs > 0 && !confirmClick(el.m4Reset, 'Reset result? click again')) return;
    S.m4 = holdReset();
    S.securedLogged = false;
    persist(saveHold, S.m4);
    env.log('4: hold timer reset', 'N');
  });
  onClick(el.m4Aim, () => {
    if (!S.aiming && prefs.hook && !camera.running) {
      prefs.hook = null; // without a picture the button clears the old point
      savePrefs();
      return;
    }
    setAiming(!S.aiming);
  });
}

function renderM4(now) {
  const v = holdView(S.m4, now, C.m4.holdMs);
  setText(el.m4Time, (v.elapsedMs / 1000).toFixed(1));
  el.m4Ring.style.strokeDashoffset = String(RING_LEN * (1 - v.progress));
  setKind(el.m4Ring, 'ring-fg', v.running ? (v.progress >= 1 ? 'ok' : 'run') : v.secured ? 'ok' : '');
  setText(el.m4ToggleText, v.running ? 'Released: stop' : 'Hooked: start');
  el.m4Toggle.classList.toggle('running', v.running);
  setText(el.m4Secured, v.secured ? '20 pts secured ✓' : `Hold ${(C.m4.holdMs / 1000).toFixed(0)} s clear of the ground`);
  setKind(el.m4Secured, 'secured', v.secured ? 'ok' : '');
  setText(el.m4Best, v.bestMs > 0 ? `${(v.bestMs / 1000).toFixed(1)} s` : '–');
  if (v.secured && !S.securedLogged) {
    S.securedLogged = true;
    // save it now, not only on release: a reload mid-hold must not lose the 20 pts
    S.m4 = { ...S.m4, bestMs: Math.max(S.m4.bestMs, v.elapsedMs) };
    persist(saveHold, S.m4);
    env.log('4: object held 3 s: 20 pts secured', 'N');
  }
  setText(el.m4AimHint, S.aiming
    ? 'Click the video where the hook is.'
    : prefs.hook ? 'Hook point set (amber reticle). Set hook point again to move it.'
      : 'Set hook point, then click the video where the hook is: a reticle stays there.');
}

// ---------------------------------------------------------------------------
// 5 Pole colours: order, balls dropped, colour calibration
// ---------------------------------------------------------------------------

const SLIDERS = [
  { key: 'h', i: 0, label: 'H lo', max: 179 }, { key: 'h', i: 1, label: 'H hi', max: 179 },
  { key: 's', i: 0, label: 'S lo', max: 255 }, { key: 's', i: 1, label: 'S hi', max: 255 },
  { key: 'v', i: 0, label: 'V lo', max: 255 }, { key: 'v', i: 1, label: 'V hi', max: 255 },
];

function setSampling(on) {
  S.sampling = Boolean(on);
  el.m5Sample.setAttribute('aria-pressed', String(S.sampling));
  el.m5Sample.textContent = S.sampling ? 'Sampling: click the pole' : 'Sample: click the pole';
  el.canvas.classList.toggle('picking', S.aiming || S.sampling);
}

function buildM5() {
  const applyOrder = () => {
    const text = el.m5Order.value.trim();
    if (!text) return;
    const order = parseOrder(text);
    if (!order) {
      env.notify('Order: type the three colours like R-B-Y (each once)', 'bad');
      return;
    }
    if (orderText(order) === orderText(S.m5.order)) {
      el.m5Order.value = orderText(order);
      return;
    }
    if (S.m5.done > 0 && !confirmClick(el.m5Set, 'Balls restart from 0: click again')) return;
    S.m5 = polesSetOrder(S.m5, order);
    el.m5Order.value = orderText(order);
    persist(savePoles, S.m5);
    env.log(`5: order ${orderText(order)}`, 'N');
  };
  el.m5Order.value = orderText(S.m5.order);
  el.m5Order.addEventListener('change', applyOrder);
  onClick(el.m5Set, applyOrder);
  onClick(el.m5Hit, () => {
    const color = nextColor(S.m5);
    if (!color) {
      env.notify(S.m5.order ? 'All three balls are already dropped' : 'Set the order first (R-B-Y)', 'warn');
      return;
    }
    S.m5 = polesHit(S.m5);
    persist(savePoles, S.m5);
    env.log(`5: ball on ${color.toUpperCase()} dropped (${S.m5.done} / 3)`, 'N');
  });
  onClick(el.m5Undo, () => {
    if (!S.m5.done) return;
    S.m5 = polesUndo(S.m5);
    persist(savePoles, S.m5);
    env.log(`5: undo, ${S.m5.done} / 3 dropped`, 'W');
  });
  onClick(el.m5Reset, () => {
    if (S.m5.done && !confirmClick(el.m5Reset, 'Reset balls? click again')) return;
    S.m5 = polesReset(S.m5);
    persist(savePoles, S.m5);
    env.log('5: balls reset', 'N');
  });

  // Calibration: open until the pilot closes it once, so nobody misses it. (Setting .open also
  // fires 'toggle': only a close counts.)
  el.m5Calib.open = !prefs.calibSeen;
  el.m5Calib.addEventListener('toggle', () => {
    if (prefs.calibSeen || el.m5Calib.open) return;
    prefs.calibSeen = true;
    savePrefs();
  });
  fillColorSelect();
  el.m5Color.addEventListener('change', () => {
    prefs.colorSel = el.m5Color.value;
    S.mask = null;
    savePrefs();
    fillSliders();
  });
  el.m5Sliders.replaceChildren(...SLIDERS.map((s) => {
    const row = document.createElement('label');
    row.className = 'slider';
    const name = document.createElement('span');
    name.textContent = s.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(s.max);
    input.step = '1';
    input.setAttribute('aria-label', s.label);
    const out = document.createElement('output');
    input.addEventListener('input', () => {
      const r = S.colors[prefs.colorSel];
      if (!r) return;
      const v = clamp(Math.round(Number(input.value)), 0, s.max);
      const next = { h: [...r.h], s: [...r.s], v: [...r.v] };
      next[s.key][s.i] = v;
      if (s.key !== 'h' && next[s.key][0] > next[s.key][1]) next[s.key][1 - s.i] = v; // S/V: lo <= hi
      S.colors = { ...S.colors, [prefs.colorSel]: next };
      fillSliders();
    });
    input.addEventListener('change', () => persist(saveColors, S.colors));
    s.input = input;
    s.out = out;
    row.append(name, input, out);
    return row;
  }));
  fillSliders();
  onClick(el.m5Sample, () => setSampling(!S.sampling));
  el.m5Mask.checked = prefs.colorMask;
  el.m5Mask.addEventListener('change', () => {
    prefs.colorMask = el.m5Mask.checked;
    if (!prefs.colorMask) S.mask = null;
    el.m5Mask.blur();
    savePrefs();
  });
  onClick(el.m5ColorReset, () => {
    const def = defaultColors()[prefs.colorSel];
    if (!def) return;
    S.colors = { ...S.colors, [prefs.colorSel]: def };
    persist(saveColors, S.colors);
    fillSliders();
    env.log(`5: ${prefs.colorSel} range back to the default`, 'N');
  });
  onClick(el.m5Export, exportColorFile);
  onClick(el.m5Import, () => el.m5File.click());
  el.m5File.addEventListener('change', async () => {
    const file = el.m5File.files?.[0];
    el.m5File.value = '';
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch (e) {
      env.notify(`Import failed: ${e.message}`, 'bad');
      return;
    }
    const r = importColors(text);
    if (!r.ok) {
      env.notify(`Import failed: ${r.error}`, 'bad');
      return;
    }
    S.colors = r.colors;
    persist(saveColors, S.colors);
    fillColorSelect();
    fillSliders();
    env.log(`5: colours imported from ${file.name} (${Object.keys(S.colors).join(', ')})`, 'N');
  });
}

function fillColorSelect() {
  const names = Object.keys(S.colors);
  if (!names.includes(prefs.colorSel)) prefs.colorSel = names[0];
  el.m5Color.replaceChildren(...names.map((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = cap(n);
    return o;
  }));
  el.m5Color.value = prefs.colorSel;
}

function fillSliders() {
  const r = S.colors[prefs.colorSel];
  if (!r) return;
  for (const s of SLIDERS) {
    const v = r[s.key][s.i];
    if (s.input.value !== String(v)) s.input.value = String(v);
    s.out.textContent = String(v);
  }
  // Swatch: the hue range (through the wrap) at the middle of the S and V ranges.
  const width = r.h[0] <= r.h[1] ? r.h[1] - r.h[0] : r.h[1] + 180 - r.h[0];
  const s = (r.s[0] + r.s[1]) / 2 / 255, v = (r.v[0] + r.v[1]) / 2 / 255;
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  const stops = [];
  for (let i = 0; i <= 8; i++) {
    const h = ((r.h[0] + (width * i) / 8) % 180) * 2;
    stops.push(`hsl(${h.toFixed(0)} ${(sl * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`);
  }
  el.m5Swatch.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  el.m5Swatch.title = `H ${r.h[0]}..${r.h[1]}  S ${r.s[0]}..${r.s[1]}  V ${r.v[0]}..${r.v[1]}`;
}

// Pixels of the current frame as [h, s, v]: a w x h copy of the region (sx, sy, sw, sh).
function frameHsv(sx, sy, sw, sh, w, h) {
  if (sampleCanvas.width !== w) sampleCanvas.width = w;
  if (sampleCanvas.height !== h) sampleCanvas.height = h;
  const g = sampleCanvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(el.video, sx, sy, sw, sh, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = [];
  for (let i = 0; i < d.length; i += 4) out.push(rgbToHsv(d[i], d[i + 1], d[i + 2]));
  return out;
}

const BG_W = 128, BG_H = 72;  // background check resolution
const BG_MAX = 0.02;          // a colour range may match at most this much of the background
const BG_BAND = 0.1;          // +- this much of the width around the click is the pole, not background
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

// The pool is blue and bright: a range taken from one pole can easily include the water too, and
// then the whole picture is one big blob. Raise S lo, then V lo, until the background (the picture
// minus a vertical band around the click) stops matching, but never above 90 % of what the pole
// itself showed. -> {range, cover (fraction of the background still matching), raised}
function tightenAgainstBackground(range, samples, clickU) {
  const bg = [];
  frameHsv(0, 0, el.video.videoWidth, el.video.videoHeight, BG_W, BG_H).forEach((px, i) => {
    if (Math.abs((i % BG_W) / BG_W - clickU) > BG_BAND) bg.push(px);
  });
  const cover = (r) => (bg.length ? bg.reduce((n, px) => n + (inRange(px, r) ? 1 : 0), 0) / bg.length : 0);
  const r = { h: [...range.h], s: [...range.s], v: [...range.v] };
  const sCap = median(samples.map((px) => px[1])) * 0.9, vCap = median(samples.map((px) => px[2])) * 0.9;
  const s0 = r.s[0], v0 = r.v[0];
  while (cover(r) > BG_MAX && r.s[0] + 5 <= Math.min(sCap, r.s[1])) r.s[0] += 5;
  while (cover(r) > BG_MAX && r.v[0] + 5 <= Math.min(vCap, r.v[1])) r.v[0] += 5;
  return { range: r, cover: cover(r), raised: r.s[0] !== s0 || r.v[0] !== v0 };
}

// Click on the pole: 9 x 9 pixels of the raw frame -> a new range (Shift: widen the current one),
// then checked against the background.
function sampleColor(p, widen) {
  const v = el.video;
  const name = prefs.colorSel;
  if (!v.videoWidth || !S.colors[name]) return;
  let hsv, next, check;
  try {
    const x = clamp(Math.round(p[0] * v.videoWidth) - 4, 0, Math.max(0, v.videoWidth - 9));
    const y = clamp(Math.round(p[1] * v.videoHeight) - 4, 0, Math.max(0, v.videoHeight - 9));
    hsv = frameHsv(x, y, 9, 9, 9, 9);
    const r = rangeFromSamples(hsv);
    if (!r) return;
    next = widen ? widenRange(S.colors[name], r) : r;
    check = tightenAgainstBackground(next, hsv, p[0]);
  } catch (e) {
    env.notify(`Cannot read the picture: ${e.message}`, 'bad');
    return;
  }
  next = check.range;
  S.colors = { ...S.colors, [name]: next };
  persist(saveColors, S.colors);
  fillSliders();
  S.sampleMark = { p, at: performance.now(), color: colorCss(name) };
  const note = check.raised ? ' (raised to keep the water out)' : '';
  env.log(`5: ${name} ${widen ? 'widened' : 'sampled'}: H ${next.h[0]}..${next.h[1]} S ${next.s[0]}.. V ${next.v[0]}..${note}`, 'N');
  if (check.cover > BG_MAX) {
    env.notify(`${cap(name)} range also matches ${Math.round(check.cover * 100)} % of the background: `
      + 'click the pole itself, or raise S lo (Show mask helps)', 'warn');
  }
}

function exportColorFile() {
  try {
    const url = URL.createObjectURL(new Blob([exportColors(S.colors)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rov_colors.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) {
    env.notify(`Export failed: ${e.message}`, 'bad');
  }
}

function poleTarget(L) {
  if (!L) return { picks: {}, next: nextColor(S.m5), target: null };
  const picks = pickPoles(L.msg.blobs, { minAspect: C.m5.minAspect });
  const next = nextColor(S.m5);
  return { picks, next, target: next ? picks[next] ?? null : null };
}

function renderM5(now) {
  const order = S.m5.order;
  const items = (order ?? []).map((c, i) => ({
    text: `${c.charAt(0).toUpperCase()}${i < S.m5.done ? ' ✓' : i === S.m5.done ? ' NEXT' : ''}`,
    cls: `${c}${i < S.m5.done ? ' done' : i === S.m5.done ? ' next' : ''}`,
    title: cap(c),
  }));
  renderChips(el.m5Seq, items, 'no order yet');
  const next = nextColor(S.m5);
  let big = 'Type the referee\'s order', kind = 'idle', hint = 'Letters like R-B-Y, then Enter';
  if (order && !next) {
    big = 'ALL 3 BALLS DROPPED ✓';
    kind = 'ok';
    hint = `Order ${orderText(order)} complete`;
  } else if (next) {
    big = `NEXT: ${next.toUpperCase()}`;
    kind = next;
    const st = detectorStatus(now);
    if (st) hint = `${st.text.toLowerCase()}${st.sub ? `: ${st.sub}` : ''}`;
    else {
      const L = fresh(now);
      hint = approachView(poleTarget(L).target, L.msg.w, L.msg.h, C.m5).text;
    }
  }
  setText(el.m5Big, big);
  setKind(el.m5Big, 'vbig', kind);
  setText(el.m5Hint, hint);
  el.m5Hit.disabled = !next;
  el.m5Undo.disabled = S.m5.done === 0;
  if (document.activeElement !== el.m5Order && !el.m5Order.value && order) el.m5Order.value = orderText(order);
}

// ---------------------------------------------------------------------------
// Keyboard: H = Mission 4 hold timer (the only key the camera panel adds)
// ---------------------------------------------------------------------------

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyH' || S.tab !== 'm4') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    toggleHold();
  });
}

// ---------------------------------------------------------------------------
// Overlay (requestAnimationFrame)
// ---------------------------------------------------------------------------

function frameLoop() {
  requestAnimationFrame(frameLoop);
  try {
    drawOverlay(performance.now());
  } catch (e) {
    if (!S.overlayFailed) {
      S.overlayFailed = true; // log once, keep trying: the next frame may be fine
      env.log(`overlay error: ${e.message}`, 'err');
    }
  }
}

function hudMission() {
  const t = TABS[S.tab].title;
  switch (S.tab) {
    case 'm21': return S.m21.rule ? `${t} · ${S.m21.rule.toUpperCase()}` : t;
    case 'm22': return prefs.target !== null ? `${t} · target ID ${prefs.target}` : t;
    case 'm3': return `${t} · ${checkpointLabel(S.m3.count, C.m3.checkpoints, C.m3.spacingCm)}`;
    case 'm4': return holdView(S.m4, performance.now(), C.m4.holdMs).secured ? `${t} · 20 pts secured ✓` : t;
    case 'm5': return S.m5.order ? `${t} · ${orderText(S.m5.order)} · ${S.m5.done}/3` : t;
    default: return t;
  }
}

function drawOverlay(now) {
  const dpr = window.devicePixelRatio || 1;
  const canvas = el.canvas, ctx = el.ctx;
  const W = Math.max(1, Math.round(S.cssW * dpr)), H = Math.max(1, Math.round(S.cssH * dpr));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!S.cssW || !S.cssH) return;

  const v = el.video;
  const live = camera.running && v.videoWidth > 0;
  const view = ov.makeView({ cssW: S.cssW, cssH: S.cssH, dpr, videoW: live ? v.videoWidth : 0, videoH: live ? v.videoHeight : 0 });
  S.view = view;
  const L = fresh(now);
  const st = detectorStatus(now);
  let banner = null; // {text, kind, sub}
  let avoid = [];    // what the banner must not cover

  if (live) {
    const showMask = (S.tab === 'm3' && prefs.lineMask) || (S.tab === 'm5' && prefs.colorMask);
    if (showMask && S.mask && S.mask.tab === S.tab && now - S.mask.capturedAt <= STALE_MS) ov.drawMask(ctx, view, maskCanvas, 0.6);

    switch (S.tab) {
      case 'm21': {
        const sv = selectionView(S.m21, C.m21.expected);
        if (L) {
          avoid = ov.drawTags(ctx, view, L.msg, {
            confirmed: new Set(S.m21.confirmed), ignored: new Set(S.m21.ignored),
            selected: sv.final ? selectTag(S.m21.confirmed, S.m21.rule) : null, selectedLabel: 'SELECTED',
            hits: S.m21.seen, need: C.m21.confirmFrames,
          });
        }
        banner = { text: sv.big, kind: sv.kind, sub: st ? `${st.text}${st.sub ? `: ${st.sub}` : ''}` : sv.sub };
        break;
      }
      case 'm22': {
        const dv = dockView(L);
        const target = dockTarget(L);
        if (L) avoid = ov.drawTags(ctx, view, L.msg, { selected: prefs.target, selectedLabel: 'TARGET' });
        avoid.push(...ov.drawDocking(ctx, view, L?.msg ?? null, target, dv,
          { alignDeg: C.m22.alignDeg, hfovDeg: effHfov(), aim: aimPixel(target) }));
        if (prefs.target === null) banner = { text: 'SET THE TARGET ID', kind: 'warn', sub: '2.2 tab, or take the 2.1 result' };
        else if (st) banner = st;
        else banner = { text: dv.text, kind: dv.kind, sub: dv.hint };
        break;
      }
      case 'm3':
        if (L) ov.drawLine(ctx, view, L.msg, S.steer, { triggerRow: C.m3.triggerRow });
        banner = st ?? (S.steer ? { text: S.steer.text, kind: S.steer.kind } : null);
        if (banner) banner = { ...banner, sub: banner.sub || checkpointLabel(S.m3.count, C.m3.checkpoints, C.m3.spacingCm) };
        break;
      case 'm4': {
        if (prefs.hook) {
          ov.drawReticle(ctx, view, prefs.hook, { label: 'HOOK', color: ov.INK.warn });
          const [x, y] = ov.pictureToDevice(view, prefs.hook);
          avoid = [[x - 40 * view.k, y - 40 * view.k, x + 40 * view.k, y + 70 * view.k]];
        }
        // Only a running hold gets the big banner; "secured" stays in the HUD line (the pilot
        // still has to carry the object back and needs the picture).
        const hv = holdView(S.m4, now, C.m4.holdMs);
        // The hook and the handle are what the pilot watches: keep the banner off the middle of
        // the picture (it goes to the bottom edge).
        const r = view.rect;
        avoid.push([r.x + r.w * 0.2, r.y, r.x + r.w * 0.8, r.y + r.h * 0.6]);
        if (hv.running) {
          banner = { text: `HOLD ${(hv.elapsedMs / 1000).toFixed(1)} s`, kind: hv.secured ? 'ok' : 'warn',
            sub: hv.secured ? '20 pts secured ✓  ·  H when it touches down' : 'H when it touches down' };
        }
        if (S.aiming) banner = { text: 'CLICK THE HOOK', kind: 'warn', sub: 'Sets the reticle' };
        break;
      }
      case 'm5': {
        ov.drawAlignBand(ctx, view, C.m5.alignFrac);
        const { picks, next, target } = poleTarget(L);
        if (L) avoid = ov.drawBlobs(ctx, view, L.msg, { picks, next, t: now / 1000 });
        if (S.sampling) banner = { text: `CLICK THE ${prefs.colorSel.toUpperCase()} POLE`, kind: colorCss(prefs.colorSel), sub: 'Shift+click widens the range' };
        else if (!S.m5.order) banner = { text: 'SET THE ORDER', kind: 'warn', sub: 'Type it in the 5 Poles tab (R-B-Y)' };
        else if (!next) banner = { text: 'ALL 3 DROPPED ✓', kind: 'ok' };
        else {
          const av = L ? approachView(target, L.msg.w, L.msg.h, C.m5) : null;
          banner = { text: `NEXT: ${next.toUpperCase()}`, kind: colorCss(next), sub: st ? st.text : av?.text ?? '' };
        }
        break;
      }
      default:
        break;
    }
    const mark = S.sampleMark;
    if (mark && now - mark.at < 1000) ov.drawSampleMark(ctx, view, mark.p, (now - mark.at) / 1000, mark.color);
    if (banner) ov.drawBanner(ctx, view, banner.text, banner.kind, banner.sub ?? '', avoid);
  }

  const clock = attemptView(S.attempt, Date.now());
  const mode = TABS[S.tab].mode;
  let det = '';
  if (mode && live) det = L && link.lastMs !== null ? `det ${Math.round(link.lastMs)} ms` : 'det –';
  ov.drawHud(ctx, view, {
    armed: isArmed(), sim: camera.kind === 'test', mission: hudMission(), det,
    clock: { text: clock.text, kind: clock.kind, running: clock.running || S.attempt.usedMs > 0 },
  });
}

// ---------------------------------------------------------------------------
// render(now): side panels and status chips, at the GUI tick
// ---------------------------------------------------------------------------

function setChip(id, text, cls, title) {
  const node = $(id);
  if (!node) return;
  setText(node, text);
  setKind(node, 'chip', cls);
  if (title !== undefined && node.title !== title) node.title = title;
}

function renderChipsBar(now) {
  const mode = TABS[S.tab].mode;
  let text, cls, title = 'Vision service in the bridge (camera missions 2-5)';
  if (!link.isOpen) {
    text = 'Vision: OFF';
    cls = mode && camera.running ? 'bad' : 'dim';
    title = `No vision service at ${link.url} (bridge not running, or started with --no-vision)`;
  } else if (link.available === null) {
    text = 'Vision: …';
    cls = 'dim';
  } else if (!link.available) {
    text = 'Vision: UNAVAILABLE';
    cls = 'bad';
    title = link.reason || 'OpenCV / pupil-apriltags could not be loaded by the bridge';
  } else if (!mode) {
    text = 'Vision: ready';
    cls = 'dim';
  } else if (!camera.running) {
    text = `Vision: ${mode}, no video`;
    cls = 'warn';
  } else if (S.error && now - S.error.at < 3000) {
    text = 'Vision: ERROR';
    cls = 'bad';
    title = S.error.text;
  } else if (!fresh(now)) {
    text = `Vision: ${mode}, waiting`;
    cls = 'warn';
  } else {
    text = `Vision: ${mode} ${link.lastMs === null ? '' : `${Math.round(link.lastMs)} ms`}`.trim();
    cls = link.rttMs !== null && link.rttMs > 500 ? 'warn' : 'ok';
    title = `detector ${link.lastMs ?? '?'} ms, capture to result ${Math.round(link.rttMs ?? 0)} ms`;
  }
  setChip('chip-vision', text, cls, title);

  // camera fps from the frames the video really showed, once a second
  const f = S.fps;
  if (!f.t0) f.t0 = now;
  if (now - f.t0 >= 1000) {
    f.value = camera.running ? Math.round((f.frames * 1000) / (now - f.t0)) : null;
    f.frames = 0;
    f.t0 = now;
  }
  if (!camera.running) setChip('chip-fps', 'FPS: –', 'dim');
  else {
    const cam = f.value === null ? '…' : String(f.value);
    const det = mode && link.ready ? ` · det ${link.resultsPerSec(now)}/s` : '';
    setChip('chip-fps', `FPS: ${cam}${det}`, f.value === null ? 'dim' : f.value >= 15 ? 'ok' : 'warn');
  }
}

function renderHeader() {
  const running = camera.running;
  const reconnecting = S.lostAt !== null;
  setText(el.start, S.starting && !reconnecting ? 'Starting…' : running || reconnecting ? 'Stop' : 'Start');
  el.start.classList.toggle('on', running);
  el.placeholder.hidden = running;
  setText(el.placeholder, S.starting ? 'Starting the camera… allow it if the browser asks.'
    : S.camError || 'No camera. Pick a source and press Start.');
  setKind(el.placeholder, 'placeholder', S.camError ? 'err' : '');
  el.simBar.hidden = camera.kind !== 'test';
  if (camera.kind === 'test') setText(el.simScene, SCENE_LABELS[scene.scene] ?? scene.scene);

  const av = attemptView(S.attempt, Date.now());
  setText(el.clockText, av.text);
  setKind(el.clockText, 'clocktext', S.attempt.running || S.attempt.usedMs > 0 ? av.kind : '');
  setText(el.clockStart, S.attempt.running ? 'Pause' : S.attempt.usedMs > 0 ? 'Resume' : 'Start');
  const eff = effHfov();
  setText(el.hfovEff, prefs.underwater
    ? `Effective HFOV underwater: ${eff.toFixed(1)}° (used for the 2.2 distance and the simulator)`
    : `HFOV ${eff.toFixed(1)}° (in air)`);
}

function render(now) {
  try {
    checkStall(now);
    renderChipsBar(now);
    renderHeader();
    switch (S.tab) {
      case 'm21': renderM21(now); break;
      case 'm22': renderM22(now); break;
      case 'm3': renderM3(now); break;
      case 'm4': renderM4(now); break;
      case 'm5': renderM5(now); break;
      default: break;
    }
  } catch (e) {
    if (!S.renderFailed) {
      S.renderFailed = true; // log once: render runs 20 times a second
      env.log(`camera panel error: ${e.message}`, 'err');
      console.error(e);
    }
  }
}
