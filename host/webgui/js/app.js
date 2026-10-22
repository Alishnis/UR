// GUI wiring: state, 20 Hz command loop, status bar, thruster bars, tests, calibration, log.
// All decisions live in controller.js / mixer.js (unit-tested); this file only connects them to the DOM.

import {
  clearCalibration, defaultCalibration, loadCalibration, sanitize, saveCalibration,
} from './calibration.js';
import { CONFIG } from './config.js';
import { confirmClick } from './confirm.js';
import { Controller } from './controller.js';
import { axesFromKeys, bindKeyboard, isTypingTarget } from './controls.js';
import { BridgeLink } from './link.js';
import { fromSlots, isPermutation, NAMES } from './mixer.js';
import {
  autoActive, autoEvent, autoInitial, autoStart, autoStop, autoText, autoTick, bigText, historyAdd, historyAppend,
  initialState as m1Initial, keepAcrossReset, loadFields, loadHistory, parseNLine, reduce as m1Reduce, saveFields,
  saveHistory, scanAdvice, SCAN_LINE, signalBars, statusNote, urlLine, validatePassword, validateSsid, validateUrl,
  wifiLine,
} from './mission1.js';
import { parseLine } from './protocol.js';
import { initVision } from './vision_ui.js';

const $ = (id) => document.getElementById(id);

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked: calibration simply is not remembered
  }
}

const REBOOT_WINDOW_MS = 30000;

let cal = loadCalibration(storage());
const controller = new Controller(cal);

const state = {
  bridgeKind: null,        // 'mock' | 'serial'
  serialText: '',
  serialOk: false,
  lastEspMs: -Infinity,    // any non-bridge line
  lastPongMs: -Infinity,
  lastBootMs: -Infinity,
  bootTimes: [],           // recent boot banners, to spot a board that keeps restarting
  pingSentMs: null,
  rttMs: null,
  mode: null,              // 'LIVE' | 'DRY RUN' | null (unknown yet)
  telemetry: null,         // {us:[...], ms}
  lastSlots: [0, 0, 0],
  autoRPending: false,
  lastAutoRMs: -Infinity,
  lastPingMs: -Infinity,
  notice: null,            // {text, kind, until}
  m1: m1Initial(),         // Mission 1 panel state (see mission1.js)
  m1BusyUntil: 0,          // the firmware blocks during a GET: do not call that "no data"
  m1auto: autoInitial(),   // Mission 1 automatic run (Connect -> GET, retries)
  m1history: [],           // received answers, newest first (this browser)
  m1getSeq: 0,             // GET counter: an error after a GET's text belongs to that answer
  m1getUrl: '',
};

// ---------------------------------------------------------------------------
// Log and notices
// ---------------------------------------------------------------------------

const logEl = $('log');
const MAX_LOG = 400;

function log(text, cls = '') {
  const row = document.createElement('div');
  if (cls) row.className = cls;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toTimeString().slice(0, 8);
  row.append(t, document.createTextNode(text));
  const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
  logEl.append(row);
  while (logEl.childElementCount > MAX_LOG) logEl.firstElementChild.remove();
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function notify(text, kind = 'warn', ttlMs = 7000) {
  state.notice = { text, kind, until: performance.now() + ttlMs };
}

// ---------------------------------------------------------------------------
// Link to the bridge
// ---------------------------------------------------------------------------

// ?wsPort=18765 lets a second bridge (e.g. --mock on other ports) serve another page.
function wsPort() {
  const p = Number(new URLSearchParams(location.search).get('wsPort'));
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : CONFIG.wsPort;
}

let bridgeWasOpen = false;

const link = new BridgeLink({
  url: `ws://${location.hostname || 'localhost'}:${wsPort()}`,
  onLine: handleLine,
  onOpen() {
    bridgeWasOpen = true;
    resetEspState();
    log('bridge connected', 'B');
    link.send('S');
  },
  onClose() {
    if (!bridgeWasOpen) return; // still waiting for the bridge to start: stay quiet
    bridgeWasOpen = false;
    if (controller.armed) {
      controller.estop();
      notify('Bridge connection lost: DISARMED', 'bad', 15000);
    }
    resetEspState();
    state.bridgeKind = null;
    state.serialText = '';
    state.serialOk = false;
    log('bridge disconnected', 'err');
  },
});

function resetEspState() {
  state.lastEspMs = -Infinity;
  state.lastPongMs = -Infinity;
  state.lastBootMs = -Infinity;
  state.bootTimes = [];
  state.pingSentMs = null;
  state.rttMs = null;
  state.mode = null;
  state.telemetry = null;
  state.m1 = m1Initial();
  state.m1BusyUntil = 0;
}

function handleLine(raw) {
  const msg = parseLine(raw);
  const now = performance.now();
  if (msg.kind !== 'B') state.lastEspMs = now;

  switch (msg.kind) {
    case 'T':
      state.telemetry = { us: msg.us, ms: now };
      return;
    case 'PONG':
      state.lastPongMs = now;
      if (state.pingSentMs !== null) {
        state.rttMs = now - state.pingSentMs;
        state.pingSentMs = null;
      }
      return;
    case 'W':
      log(`W ${msg.text}`, 'W');
      if (controller.armed && msg.text.startsWith('watchdog')) {
        notify('Firmware watchdog tripped while armed: command stream was interrupted', 'bad', 10000);
      }
      return;
    case 'N':
      log(`N ${msg.text}`, 'N');
      handleMission1Line(msg.text);
      return;
    case 'B':
      handleBridgeLine(msg.text);
      return;
    case 'R':
      showSelfCheck(msg);
      state.mode = msg.dry ? 'DRY RUN' : 'LIVE';
      if (state.autoRPending) {
        state.autoRPending = false; // the automatic mode probe is not worth a log line
      } else {
        log(`R ${msg.text}`, 'R');
      }
      return;
    case 'banner':
      log(msg.text, 'B');
      if (msg.mode) state.mode = msg.mode;
      if (msg.resetBad) {
        const n = state.bootTimes.length;
        const repeats = n >= 3 ? `, ${n} times in ${REBOOT_WINDOW_MS / 1000} s` : '';
        notify(`ESP32 restarted: ${msg.resetReason}${repeats}. Check its 5 V supply, GND and the ESC red wires.`,
          'bad', 30000);
      }
      if (msg.boot) {
        state.bootTimes = state.bootTimes.filter((t) => now - t < REBOOT_WINDOW_MS);
        state.bootTimes.push(now);
        if (state.bootTimes.length >= 3) {
          notify(`ESP32 restarted ${state.bootTimes.length} times in ${REBOOT_WINDOW_MS / 1000} s: `
            + 'every restart cuts the ESC signal and makes the motors twitch. Check the power supply.',
          'bad', 30000);
        }
        state.lastBootMs = now;
        state.lastPongMs = -Infinity;
        state.mode = null;
        state.m1 = keepAcrossReset(state.m1);
        state.m1BusyUntil = 0;
        // the board forgot the network: an automatic run joins again once it accepts input
        m1AutoApply(autoEvent(state.m1auto, { type: 'reboot' }, now));
        if (controller.armed) {
          controller.estop();
          notify('ESP32 rebooted: DISARMED', 'bad', 15000);
        }
      }
      return;
    default:
      log(msg.text, 'B');
  }
}

function handleBridgeLine(text) {
  log(`B ${text}`, 'B');
  if (text.startsWith('bridge ')) {
    state.bridgeKind = text.slice(7);
  } else if (text.startsWith('rejected:')) {
    notify(`Bridge refused a line: ${text.slice(9).trim()}`, 'bad');
  } else if (text.startsWith('serial') || text.startsWith('mock')) {
    state.serialText = text;
    state.serialOk = text.includes('connected') || text.startsWith('mock');
    if (!state.serialOk && controller.armed) {
      controller.estop();
      notify(`ESP32 serial link lost: DISARMED (${text})`, 'bad', 15000);
    }
  }
}

// ---------------------------------------------------------------------------
// ARM / DISARM / E-STOP
// ---------------------------------------------------------------------------

function espAlive(now) {
  return now - state.lastEspMs < CONFIG.aliveMs;
}

function espBusy(now) {
  return now < state.m1BusyUntil && !espAlive(now);
}

function fwReady(now) {
  return state.lastPongMs > state.lastBootMs && now - state.lastPongMs < 3000;
}

function tryArm() {
  const now = performance.now();
  const refuse = (why) => notify(`ARM refused: ${why}`, 'bad');
  if (!link.isOpen) return refuse('bridge is not connected');
  if (!espAlive(now)) return refuse('the ESP32 does not answer (check USB cable, bridge log)');
  if (!fwReady(now)) return refuse('firmware not ready yet (it ignores input for 4 s after power-up)');
  if (now < state.m1BusyUntil) return refuse('the ESP32 is busy with the Mission 1 GET (thrusters held neutral)');
  const r = controller.arm();
  if (!r.ok) return refuse(r.reason);
  if (autoActive(state.m1auto)) {
    state.m1auto = autoStop(state.m1auto); // never a GET while driving: it freezes the firmware for seconds
    log('Mission 1 auto stopped: the vehicle was ARMED', 'N');
  }
  m1ShowReferee(false);
  state.notice = null;
  log(`ARMED (${state.mode ?? 'mode unknown'})`, 'W');
}

function disarm(why) {
  const was = controller.armed;
  controller.disarm();
  link.send('S');
  if (was) log(`DISARMED${why ? `: ${why}` : ''}`, 'W');
}

function estop(why = 'E-STOP') {
  const was = controller.armed;
  controller.estop();
  link.send('S'); // immediately, not at the next tick
  if (was) log(`${why}: DISARMED`, 'err');
}

$('btn-arm').addEventListener('click', (e) => {
  if (controller.armed) disarm('button');
  else tryArm();
  e.currentTarget.blur(); // a focused button must never react to Space / Enter later
});
$('btn-estop').addEventListener('pointerdown', () => estop('E-STOP button'));
$('btn-estop').addEventListener('click', (e) => {
  estop('E-STOP button');
  e.currentTarget.blur();
});

bindKeyboard({
  controller,
  onEstop() {
    document.activeElement?.blur?.();
    estop('E-STOP key');
  },
});

// Enter leaves a text field so driving keys work again.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && isTypingTarget(e.target)) e.target.blur();
});
// A <select> keeps focus after choosing, and would then swallow WASD.
document.addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT') e.target.blur();
});

// ---------------------------------------------------------------------------
// MAX throttle and magnitude
// ---------------------------------------------------------------------------

const maxSlider = $('max-slider');
maxSlider.min = '0';
maxSlider.max = String(CONFIG.maxThrottle.limit);
maxSlider.step = String(CONFIG.maxThrottle.step);
maxSlider.value = String(CONFIG.maxThrottle.default);
controller.setMaxThrottle(CONFIG.maxThrottle.default);

function updateMaxUi() {
  const v = controller.maxThrottle;
  const us = Math.round(v * CONFIG.usPerUnit);
  $('max-out').textContent = v.toFixed(2);
  const limited = us > CONFIG.firmwareMaxDeltaUs;
  $('max-hint').textContent = limited
    ? `= +-${us} us, but the firmware clamp limits output to +-${CONFIG.firmwareMaxDeltaUs} us`
    : `= +-${us} us around neutral (firmware clamp +-${CONFIG.firmwareMaxDeltaUs} us)`;
}
maxSlider.addEventListener('input', () => {
  controller.setMaxThrottle(Number(maxSlider.value));
  updateMaxUi();
});
updateMaxUi();

// ---------------------------------------------------------------------------
// Thruster bars
// ---------------------------------------------------------------------------

const barEls = {};
const barScale = CONFIG.firmwareMaxDeltaUs / CONFIG.usPerUnit; // bar full scale = firmware clamp

function buildBars() {
  const host = $('bars');
  for (const name of NAMES) {
    const wrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'bar-name';
    const label = document.createElement('span');
    label.textContent = name.toUpperCase();
    const nums = document.createElement('span');
    title.append(label, nums);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const center = document.createElement('div');
    center.className = 'bar-center';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    const real = document.createElement('div');
    real.className = 'bar-real';
    track.append(center, fill, real);
    const gpio = document.createElement('div');
    gpio.className = 'bar-gpio';
    wrap.append(title, track, gpio);
    host.append(wrap);
    barEls[name] = { nums, fill, real, gpio };
  }
}

function signed(v, digits = 3) {
  return (v >= 0 ? '+' : '') + v.toFixed(digits);
}

function renderBars(now) {
  const mapped = isPermutation(cal.outputSlot);
  const cmd = mapped ? fromSlots(state.lastSlots, cal.outputSlot) : { left: 0, right: 0, vert: 0 };
  const tel = state.telemetry && now - state.telemetry.ms < CONFIG.aliveMs ? state.telemetry : null;
  const realFrac = tel && mapped
    ? fromSlots(tel.us.map((us) => (us - CONFIG.neutralUs) / CONFIG.usPerUnit), cal.outputSlot)
    : null;
  const realUs = tel && mapped ? fromSlots(tel.us, cal.outputSlot) : null;

  for (const name of NAMES) {
    const el = barEls[name];
    const v = cmd[name];
    const half = Math.min(1, Math.abs(v) / barScale) * 50;
    el.fill.style.left = `${v >= 0 ? 50 : 50 - half}%`;
    el.fill.style.width = `${half}%`;
    el.fill.classList.toggle('rev', v < 0);
    if (realFrac) {
      const pos = 50 + Math.max(-0.98, Math.min(0.98, realFrac[name] / barScale)) * 50; // keep the marker inside the track
      el.real.style.left = `${pos}%`;
      el.real.hidden = false;
    } else {
      el.real.hidden = true;
    }
    el.nums.textContent = `cmd ${signed(v)}   ${realUs ? `${realUs[name]} us` : '-- us'}`;
    el.gpio.textContent = mapped ? `GPIO ${CONFIG.slotPins[cal.outputSlot[name]]}` : 'GPIO ?';
  }
}

// ---------------------------------------------------------------------------
// Tests (press and hold)
// ---------------------------------------------------------------------------

const testButtons = [];

function bindHold(btn, start) {
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      btn.setPointerCapture(e.pointerId); // keeps pointerup coming even if the finger slides off
    } catch {
      // not fatal: pointerleave-style loss is covered by pointercancel and the test timeout
    }
    start();
  });
  const stop = () => controller.stopTest();
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, stop);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function addTestButton(host, label, start, id) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn testbtn';
  btn.textContent = label;
  btn.dataset.test = id;
  bindHold(btn, start);
  host.append(btn);
  testButtons.push(btn);
}

function buildTests() {
  const thr = $('test-thruster');
  const letters = { left: 'L', right: 'R', vert: 'V' };
  for (const name of NAMES) {
    for (const sign of [-1, 1]) {
      addTestButton(thr, `${letters[name]}${sign < 0 ? '−' : '+'}`,
        () => controller.startThrusterTest(name, sign), `t:${name}:${sign}`);
    }
  }
  const pin = $('test-pin');
  for (let slot = 0; slot < 3; slot++) {
    for (const sign of [-1, 1]) {
      addTestButton(pin, `GPIO ${CONFIG.slotPins[slot]}${sign < 0 ? '−' : '+'}`,
        () => controller.startPinTest(slot, sign), `p:${slot}:${sign}`);
    }
  }
}

function renderTests() {
  const t = controller.test;
  for (const btn of testButtons) {
    btn.disabled = !controller.armed;
    let active = false;
    if (t) {
      const [kind, key, sign] = btn.dataset.test.split(':');
      active = t.kind === 'thruster'
        ? kind === 't' && key === t.name && Number(sign) === t.sign
        : kind === 'p' && Number(key) === t.slot && Number(sign) === t.sign;
    }
    btn.classList.toggle('active', active);
  }
}

// ---------------------------------------------------------------------------
// Pin self-check
// ---------------------------------------------------------------------------

function showSelfCheck(msg) {
  const host = $('selfcheck');
  host.replaceChildren();
  if (msg.dry) {
    const d = document.createElement('div');
    d.className = 'nosignal';
    d.textContent = 'DRY RUN firmware: pins are held LOW, no signal is expected.';
    host.append(d);
  }
  for (const o of msg.outputs) {
    const row = document.createElement('div');
    row.className = o.state;
    row.textContent = `${o.name} io${o.io} → io${o.rb}: ${o.text}`;
    host.append(row);
  }
}

$('btn-selfcheck').addEventListener('click', (e) => {
  state.autoRPending = false;
  if (!link.send('R')) notify('Bridge is not connected', 'bad');
  e.currentTarget.blur();
});

// ---------------------------------------------------------------------------
// Calibration panel
// ---------------------------------------------------------------------------

const calibInputs = {};

function buildCalibration() {
  const host = $('calib');
  for (const h of ['Thruster', 'Output', 'Invert', 'Gain', 'Dead band']) {
    const d = document.createElement('div');
    d.className = 'head';
    d.textContent = h;
    host.append(d);
  }
  for (const name of NAMES) {
    const label = document.createElement('div');
    label.textContent = name.toUpperCase();

    const slot = document.createElement('select');
    for (let s = 0; s < 3; s++) {
      const o = document.createElement('option');
      o.value = String(s);
      o.textContent = `${s} (GPIO ${CONFIG.slotPins[s]})`;
      slot.append(o);
    }
    const invert = document.createElement('input');
    invert.type = 'checkbox';
    const gain = document.createElement('input');
    gain.type = 'number';
    gain.min = '0.1'; gain.max = '2'; gain.step = '0.05';
    const dead = document.createElement('input');
    dead.type = 'number';
    dead.min = '0'; dead.max = '0.5'; dead.step = '0.01';

    for (const el of [slot, invert, gain, dead]) el.addEventListener('change', applyCalibrationForm);
    host.append(label, slot, invert, gain, dead);
    calibInputs[name] = { slot, invert, gain, dead };
  }
  $('btn-calib-reset').addEventListener('click', (e) => {
    clearCalibration(storage());
    setCalibration(defaultCalibration());
    log('calibration reset to config.js', 'B');
    e.currentTarget.blur();
  });
  fillCalibrationForm();
}

function fillCalibrationForm() {
  for (const name of NAMES) {
    const c = calibInputs[name];
    c.slot.value = String(cal.outputSlot[name]);
    c.invert.checked = cal.thrusters[name].invert;
    c.gain.value = String(cal.thrusters[name].gain);
    c.dead.value = String(cal.thrusters[name].deadBand);
  }
  const bad = !isPermutation(cal.outputSlot);
  const warn = $('calib-warn');
  warn.hidden = !bad;
  warn.textContent = bad ? 'Output slots must use each of 0, 1, 2 exactly once. ARM is refused until fixed.' : '';
}

function setCalibration(next) {
  if (!controller.setCalibration(next)) {
    notify('Disarm before changing the calibration', 'bad');
    fillCalibrationForm();
    return;
  }
  cal = next;
  fillCalibrationForm();
}

function applyCalibrationForm() {
  const raw = { outputSlot: {}, thrusters: {} };
  for (const name of NAMES) {
    const c = calibInputs[name];
    raw.outputSlot[name] = Number(c.slot.value);
    raw.thrusters[name] = {
      invert: c.invert.checked,
      gain: Number(c.gain.value),
      deadBand: Number(c.dead.value),
    };
  }
  const next = sanitize(raw);
  setCalibration(next);
  if (cal === next && !saveCalibration(storage(), cal)) {
    notify('Calibration applied but this browser cannot remember it (storage blocked)', 'warn');
  }
}

let calibWasArmed = null;
function renderCalibrationLock() {
  if (calibWasArmed === controller.armed) return;
  calibWasArmed = controller.armed;
  for (const name of NAMES) {
    for (const el of Object.values(calibInputs[name])) el.disabled = controller.armed;
  }
  $('btn-calib-reset').disabled = controller.armed;
}

// ---------------------------------------------------------------------------
// Mission 1: Wi-Fi pairing
// ---------------------------------------------------------------------------

const m1El = {
  ssid: $('m1-ssid'), password: $('m1-password'), url: $('m1-url'),
  connect: $('m1-connect'), get: $('m1-get'), scan: $('m1-scan'), wifi: $('m1-wifi'), text: $('m1-text'),
  notes: $('m1-notes'), log: $('m1-log'), hint: $('m1-hint'), meta: $('m1-meta'),
  auto: $('m1-auto'), keep: $('m1-keep'), autoState: $('m1-autostate'),
  scanBox: $('m1-scanbox'), scanMeta: $('m1-scan-meta'), nets: $('m1-nets'), advice: $('m1-scan-advice'),
  show: $('m1-show'), histCount: $('m1-hist-count'), histList: $('m1-hist-list'), histClear: $('m1-hist-clear'),
  ref: $('m1-ref'), refText: $('m1-ref-text'), refMeta: $('m1-ref-meta'), refClose: $('m1-ref-close'),
};

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function handleMission1Line(text) {
  const ev = parseNLine(text);
  if (!ev) return;
  const now = performance.now();
  state.m1 = m1Reduce(state.m1, ev);
  if (ev.type !== 'net') { // a scan sends up to 15 of these: the list shows them
    const row = document.createElement('div');
    row.textContent = `${clock(Date.now())}  ${text}`;
    m1El.log.append(row);
    while (m1El.log.childElementCount > 100) m1El.log.firstElementChild.remove();
    m1El.log.scrollTop = m1El.log.scrollHeight;
  }
  if (ev.type === 'http-ok' || ev.type === 'http-error') state.m1BusyUntil = 0;
  m1Record(ev);
  m1AutoApply(autoEvent(state.m1auto, ev, now));
}

// History: one entry per GET answer or error.
function m1Record(ev) {
  const h = state.m1history;
  let next = h;
  if (ev.type === 'get') {
    state.m1getUrl = ev.url;
  } else if (ev.type === 'http-ok') {
    next = historyAdd(h, { at: Date.now(), url: state.m1getUrl, status: ev.status, seq: state.m1getSeq });
  } else if (ev.type === 'got' || ev.type === 'note') {
    next = historyAppend(h, ev.text);
  } else if (ev.type === 'http-error') {
    next = h.length && h[0].seq === state.m1getSeq && h[0].status !== 'error'
      ? historyAppend(h, ev.text) // e.g. "body incomplete" after some text
      : historyAdd(h, { at: Date.now(), url: state.m1getUrl, status: 'error', lines: [ev.text], seq: state.m1getSeq });
  }
  if (next !== h) {
    state.m1history = next;
    saveHistory(storage(), next);
  }
}

function m1Send(lines) {
  for (const line of lines) {
    link.send(line);
    if (line === 'G') {
      state.m1getSeq++; // counted here: "wifi not connected" answers come without "N get:"
      state.m1 = m1Reduce(state.m1, { type: 'get', url: state.m1getUrl }); // shows "..." at once
      state.m1BusyUntil = performance.now() + 20000; // worst case: connect 5 s + answer 5 s + body 5 s
    }
  }
}

function m1AutoApply(r) {
  const was = state.m1auto.phase;
  state.m1auto = r.auto;
  if (r.send.length && controller.armed) { // belt and braces: tryArm already stops the run
    state.m1auto = autoStop(r.auto);
    return;
  }
  if (r.send.length) m1Send(r.send);
  if (was !== r.auto.phase && (r.auto.phase === 'done' || r.auto.phase === 'failed')) {
    log(`Mission 1: ${autoText(r.auto, performance.now())}`, r.auto.phase === 'done' ? 'N' : 'err');
    if (r.auto.phase === 'failed') notify(`Mission 1 ${autoText(r.auto, performance.now())}`, 'bad', 10000);
  }
}

function m1AutoTick(now) {
  // A G that never got an answer (serial down, sent during the firmware's 4 s boot pause)
  if (state.m1.getting && state.m1BusyUntil && now >= state.m1BusyUntil) {
    state.m1BusyUntil = 0;
    state.m1 = m1Reduce(state.m1, { type: 'http-error', text: 'HTTP error: no answer from the ESP32' });
  }
  if (!autoActive(state.m1auto)) return;
  const stop = controller.armed ? 'stopped: the vehicle was ARMED' : !link.isOpen ? 'stopped: bridge disconnected' : null;
  if (stop) {
    state.m1auto = autoStop(state.m1auto);
    log(`Mission 1 auto ${stop}`, 'err');
    notify(`Mission 1 auto ${stop}`, 'bad');
    return;
  }
  m1AutoApply(autoTick(state.m1auto, now));
}

function m1Fields() {
  return {
    ssid: m1El.ssid.value.trim(),
    password: m1El.password.value, // spaces are legal inside a password
    url: m1El.url.value.trim(),
  };
}

function m1Remember() {
  saveFields(storage(), m1Fields());
}

function m1Busy(now = performance.now()) {
  return now < state.m1BusyUntil;
}

function m1Guard() {
  if (controller.armed) {
    notify('Disarm first: the vehicle is stopped while the ESP32 talks to the network', 'bad');
    return false;
  }
  if (m1Busy()) { // the firmware throws away whatever arrives during a GET
    notify('The ESP32 is busy with a GET: wait for its answer', 'warn');
    return false;
  }
  if (!link.isOpen) {
    notify('Bridge is not connected', 'bad');
    return false;
  }
  return true;
}

// A manual command ends an automatic run: two drivers would step on each other.
function m1Manual() {
  if (!autoActive(state.m1auto)) return;
  state.m1auto = autoStop(state.m1auto);
  log('Mission 1 auto stopped (manual command)', 'N');
}

m1El.connect.addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (!m1Guard()) return;
  const f = m1Fields();
  const err = validateSsid(f.ssid) || validatePassword(f.password) || (f.url ? validateUrl(f.url) : null);
  if (err) return notify(`Mission 1: ${err}`, 'bad');
  m1Manual();
  m1Remember();
  state.m1 = keepAcrossReset(state.m1);
  if (f.url) link.send(urlLine(f.url)); // U first: M can take a moment
  link.send(wifiLine(f.ssid, f.password));
  log(`Mission 1: joining ${f.ssid}`, 'N');
});

m1El.get.addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (!m1Guard()) return;
  const f = m1Fields();
  const err = validateUrl(f.url);
  if (err) return notify(`Mission 1: ${err}`, 'bad');
  m1Manual();
  m1Remember();
  state.m1getUrl = f.url;
  link.send(urlLine(f.url));
  m1Send(['G']);
  log(`Mission 1: GET ${f.url}`, 'N');
});

m1El.scan.addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (!m1Guard()) return;
  m1Manual(); // an auto run re-joining every 3 s would cancel the scan
  link.send(SCAN_LINE);
  log('Mission 1: Wi-Fi scan', 'N');
});

m1El.auto.addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (autoActive(state.m1auto)) {
    state.m1auto = autoStop(state.m1auto);
    log('Mission 1 auto stopped', 'N');
    return;
  }
  if (!m1Guard()) return;
  const f = m1Fields();
  const err = validateSsid(f.ssid) || validatePassword(f.password) || validateUrl(f.url);
  if (err) return notify(`Mission 1: ${err}`, 'bad');
  m1Remember();
  state.m1getUrl = f.url;
  const r = autoStart(f, state.m1, performance.now(), { keep: m1El.keep.checked });
  log(`Mission 1 auto: ${f.ssid} -> ${f.url}${m1El.keep.checked ? ' (keep fetching)' : ''}`, 'N');
  m1AutoApply(r);
});

m1El.keep.addEventListener('change', () => {
  state.m1auto = { ...state.m1auto, keep: m1El.keep.checked };
});

// Click on a scanned network: take its SSID.
m1El.nets.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ssid]');
  if (!btn) return;
  btn.blur();
  if (!btn.dataset.ssid) return notify('A hidden network: type its SSID by hand', 'warn');
  m1El.ssid.value = btn.dataset.ssid;
  m1Remember();
});

// Referee view: the text huge over the whole page. Esc closes it (and is the E-STOP as always).
function m1ShowReferee(open) {
  m1El.ref.hidden = !open;
  if (open) m1El.refClose.focus();
}
m1El.show.addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (controller.armed) return notify('Disarm first: the referee view covers ARM state and E-STOP', 'bad');
  m1ShowReferee(true);
});
m1El.refClose.addEventListener('click', () => {
  m1El.refClose.blur();
  m1ShowReferee(false);
});
m1El.ref.addEventListener('click', (e) => {
  if (e.target === m1El.ref) m1ShowReferee(false);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !m1El.ref.hidden) m1ShowReferee(false);
});

m1El.histClear.addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (controller.armed) return;
  if (state.m1history.length && !confirmClick(m1El.histClear, 'Clear all? click again')) return;
  state.m1history = [];
  saveHistory(storage(), []);
});

function buildMission1() {
  const f = loadFields(storage(), CONFIG.mission1);
  m1El.ssid.value = f.ssid;
  m1El.password.value = f.password;
  m1El.url.value = f.url;
  for (const el of [m1El.ssid, m1El.password, m1El.url]) el.addEventListener('change', m1Remember);
  // seq is per page load (a GET counter): never match a new error to an old session's answer
  state.m1history = loadHistory(storage()).map(({ seq, ...e }) => e);
}

// Who fetched it, when, from where: what the referee needs to see next to the text.
function m1MetaText() {
  const m = state.m1;
  const last = state.m1history.find((e) => e.status !== 'error'); // the answer the text came from
  const parts = [];
  if (last) parts.push(`HTTP ${last.status} at ${clock(last.at)}`);
  if (m.received.length && m.bytes !== null) parts.push(`${m.bytes} bytes`);
  if (last?.url) parts.push(`from ${last.url}`);
  const wifi = m.wifi === 'connected' ? `ESP32 on Wi-Fi ${m.ssid ?? ''}, ip ${m.ip}, ${m.rssi} dBm` : null;
  return [parts.join(' · '), wifi].filter(Boolean).join('\n');
}

let m1NetsKey = '';
let m1HistKey = '';

function renderScan() {
  const sc = state.m1.scan;
  const ssid = m1El.ssid.value.trim();
  m1El.scanBox.hidden = !sc.running && sc.total === null && !sc.note;
  m1El.scan.disabled = controller.armed || !link.isOpen || sc.running || m1Busy();
  m1El.scan.textContent = sc.running ? 'Scanning…' : 'Scan';
  m1El.scanMeta.textContent = sc.running ? '(scanning, 2-4 s)'
    : sc.total !== null ? `(${sc.total} found${sc.more ? `, ${sc.more} weakest not shown` : ''})` : '';
  const key = JSON.stringify([sc.nets, ssid]);
  if (key !== m1NetsKey) {
    m1NetsKey = key;
    m1El.nets.replaceChildren(...sc.nets.map((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `m1net${n.ssid === ssid && ssid ? ' match' : ''}`;
      b.dataset.ssid = n.ssid === '(hidden)' ? '' : n.ssid;
      b.title = n.ssid === '(hidden)' ? 'Hidden network' : `Use ${n.ssid}`;
      const bars = document.createElement('span');
      bars.className = `bars4 b${signalBars(n.rssi)}`;
      bars.append(...[0, 1, 2, 3].map(() => document.createElement('i')));
      const name = document.createElement('span');
      name.className = `ssid${n.ssid === '(hidden)' ? ' hidden' : ''}`;
      name.textContent = n.ssid;
      const ch = document.createElement('small');
      ch.textContent = `${n.rssi} dBm · ch ${n.ch}`;
      const sec = document.createElement('small');
      sec.textContent = n.open ? 'open' : 'secured';
      b.append(bars, name, ch, sec);
      return b;
    }));
  }
  const adv = sc.note && !sc.running ? { kind: 'warn', text: `Scan ${sc.note}` } : scanAdvice(sc, ssid);
  m1El.advice.textContent = adv?.text ?? '';
  m1El.advice.className = `m1advice${adv ? ` ${adv.kind}` : ''}`;
}

function renderHistory() {
  const h = state.m1history;
  const key = `${h.length}:${h[0]?.at}:${h[0]?.lines.length}`;
  if (key === m1HistKey) return;
  m1HistKey = key;
  m1El.histCount.textContent = h.length ? `(${h.length})` : '';
  m1El.histList.replaceChildren(...h.map((e) => {
    const row = document.createElement('div');
    if (e.status === 'error') row.className = 'err';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = clock(e.at);
    const st = document.createElement('span');
    st.className = 's';
    st.textContent = e.status === 'error' ? 'error' : String(e.status);
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = e.lines.join('\n') || '(no text)';
    row.append(t, st, x);
    return row;
  }));
}

function renderMission1(now) {
  const m = state.m1;
  m1El.wifi.textContent = `Wi-Fi: ${m.wifiText}`;
  m1El.wifi.className = `m1wifi ${m.wifi}`;
  m1El.text.textContent = bigText(m);
  const good = m.received.length || m.lastGood.length;
  m1El.text.className = `m1text${good ? ' got' : m.getting ? ' busy' : m.error ? ' err' : ''}`;
  m1El.notes.textContent = [statusNote(m), ...m.notes].filter(Boolean).join('  ');
  m1El.meta.textContent = m.received.length || m.lastGood.length ? m1MetaText() : '';
  const blocked = controller.armed || !link.isOpen || m1Busy(now);
  const auto = autoActive(state.m1auto);
  m1El.connect.disabled = blocked;
  m1El.get.disabled = blocked;
  m1El.auto.disabled = blocked && !auto;
  m1El.show.disabled = controller.armed;
  m1El.histClear.disabled = controller.armed || !state.m1history.length;
  m1El.auto.textContent = auto ? 'Stop auto' : 'Auto: Connect + GET';
  m1El.auto.classList.toggle('on', auto);
  m1El.autoState.textContent = autoText(state.m1auto, now);
  m1El.autoState.className = `m1autostate${state.m1auto.phase === 'done' ? ' ok' : state.m1auto.phase === 'failed' ? ' bad' : ''}`;
  if (controller.armed) m1El.hint.textContent = 'DISARM first: the vehicle stops while the ESP32 uses the network.';
  else if (m.wifi === 'failed') m1El.hint.textContent = 'Joining failed, see the Wi-Fi line above. Scan to check the network name, fix it and Connect again.';
  else if (m.wifi !== 'connected') m1El.hint.textContent = 'Press Auto (or Connect, wait for green "connected", then GET). Scan shows which networks the ESP32 hears.';
  else m1El.hint.textContent = 'Connected. GET fetches the text; the ESP32 itself does the request.';
  renderScan();
  renderHistory();
  if (!m1El.ref.hidden) {
    const has = m.received.length > 0 || m.lastGood.length > 0;
    m1El.refText.textContent = has ? bigText(m) : (m.getting ? 'Fetching…' : 'No text received yet');
    m1El.refText.className = `m1reftext${has ? '' : ' none'}`;
    m1El.refMeta.textContent = has ? m1MetaText() : '';
  }
}

// ---------------------------------------------------------------------------
// Status bar and rendering
// ---------------------------------------------------------------------------

function setChip(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `chip${cls ? ` ${cls}` : ''}`;
}

function renderStatus(now) {
  const open = link.isOpen;
  setChip('chip-bridge', open ? `Bridge: ${state.bridgeKind ?? 'connected'}` : 'Bridge: DISCONNECTED',
    open ? 'ok' : 'bad');
  setChip('chip-serial', state.serialText ? `Serial: ${state.serialText.replace(/^serial /, '')}` : 'Serial: -',
    state.serialOk ? 'ok' : (open ? 'warn' : 'dim'));
  const alive = espAlive(now);
  if (alive) setChip('chip-esp', 'ESP: alive', 'ok');
  else if (espBusy(now)) setChip('chip-esp', 'ESP: busy (HTTP GET)', 'warn');
  else setChip('chip-esp', 'ESP: NO DATA', open ? 'bad' : 'dim');
  if (state.mode === 'DRY RUN') setChip('chip-fw', 'Firmware: DRY RUN', 'warn');
  else if (state.mode === 'LIVE') setChip('chip-fw', 'Firmware: LIVE', 'ok');
  else setChip('chip-fw', 'Firmware: ?', 'dim');
  setChip('chip-ping', state.rttMs === null ? 'Ping: -' : `Ping: ${Math.round(state.rttMs)} ms`,
    state.rttMs === null ? 'dim' : (state.rttMs < 100 ? 'ok' : 'warn'));
  const paused = isTypingTarget(document.activeElement);
  setChip('chip-keys', paused ? 'Keys: PAUSED (typing, Enter to leave)' : 'Keys: active', paused ? 'warn' : 'ok');
}

function renderNotice(now) {
  const el = $('notice');
  let text = null;
  let kind = 'warn';
  if (state.notice && now < state.notice.until) {
    ({ text, kind } = state.notice);
  } else if (state.mode === 'DRY RUN') {
    text = 'DRY RUN firmware: ESC pins are held LOW, motors will NOT spin. Set DRY_RUN = false in src/config.h and reflash.';
  }
  el.hidden = text === null;
  if (text !== null) {
    el.textContent = text;
    el.className = kind === 'bad' ? 'bad' : '';
  }
}

function render(now) {
  document.body.classList.toggle('armed', controller.armed);
  $('armstate').textContent = controller.armed ? 'ARMED' : 'DISARMED';
  const armBtn = $('btn-arm');
  armBtn.textContent = controller.armed ? 'DISARM' : 'ARM';
  const m = controller.magCfg;
  $('mag-fill').style.width = `${((controller.magnitude - m.min) / (m.max - m.min)) * 100}%`;
  $('mag-out').textContent = `x${controller.magnitude.toFixed(2)}`;
  renderStatus(now);
  renderNotice(now);
  renderBars(now);
  renderTests();
  renderCalibrationLock();
  renderMission1(now);
  vision.render(now);
}

// ---------------------------------------------------------------------------
// Command loop: D while armed, S while disarmed, 20 Hz
// ---------------------------------------------------------------------------

let lastTick = performance.now();

function tick() {
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  if (controller.armed && link.isOpen && !espAlive(now)) {
    estop('ESP32 stopped answering');
    notify('ESP32 stopped answering: DISARMED', 'bad', 15000);
  }

  if (link.isOpen && now - state.lastPingMs >= 1000) {
    state.lastPingMs = now;
    state.pingSentMs = now;
    link.send('P');
  }
  // Learn the firmware mode (LIVE / DRY RUN) once it is ready: R replies with it.
  if (link.isOpen && state.mode === null && fwReady(now) && now - state.lastAutoRMs > 2000) {
    state.lastAutoRMs = now;
    state.autoRPending = true;
    link.send('R');
  }

  m1AutoTick(now);
  const out = controller.step(dt);
  state.lastSlots = out.slots;
  link.send(out.line);
  render(now);
}

buildBars();
buildTests();
buildCalibration();
buildMission1();
// Camera panel and missions 2-5: display-only, never touches the command stream.
const vision = initVision({
  log, notify, storage: storage(), controller,
  isArmed: () => controller.armed,
  getAxes: () => axesFromKeys(controller.keys),
});
$('btn-log-clear').addEventListener('click', (e) => {
  logEl.replaceChildren();
  e.currentTarget.blur();
});

window.addEventListener('beforeunload', () => link.send('S'));

link.start();
setInterval(tick, 1000 / CONFIG.sendHz);
tick();

// Handle for debugging in the browser console and for automated checks.
window.rov = { controller, state, link, vision, getCal: () => cal };
