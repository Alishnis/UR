// Calibration values: defaults from config.js, edited in the GUI, kept in localStorage.
// Pure apart from the injected storage object. Unit-tested.

import { CONFIG } from './config.js';
import { clamp, NAMES } from './mixer.js';

const STORAGE_KEY = 'rov.calibration.v1';
const GAIN_RANGE = [0.1, 2];
const DEADBAND_RANGE = [0, 0.5];

export function defaultCalibration(cfg = CONFIG) {
  return {
    outputSlot: { ...cfg.outputSlot },
    thrusters: Object.fromEntries(NAMES.map((n) => [n, { ...cfg.thrusters[n] }])),
  };
}

function num(v, fallback, [lo, hi]) {
  const x = Number(v);
  return Number.isFinite(x) ? clamp(x, lo, hi) : fallback;
}

// Takes untrusted data (localStorage, user input) and returns a safe calibration.
// outputSlot is NOT forced into a permutation: the GUI shows the problem and
// ARM refuses it, which is better than silently "fixing" the user's choice.
export function sanitize(raw, fallback = defaultCalibration()) {
  const out = defaultCalibration({ outputSlot: fallback.outputSlot, thrusters: fallback.thrusters });
  if (!raw || typeof raw !== 'object') return out;
  for (const n of NAMES) {
    const slot = raw.outputSlot?.[n];
    if (Number.isInteger(slot) && slot >= 0 && slot <= 2) out.outputSlot[n] = slot;
    const t = raw.thrusters?.[n];
    if (t && typeof t === 'object') {
      out.thrusters[n] = {
        invert: typeof t.invert === 'boolean' ? t.invert : fallback.thrusters[n].invert,
        gain: num(t.gain, fallback.thrusters[n].gain, GAIN_RANGE),
        deadBand: num(t.deadBand, fallback.thrusters[n].deadBand, DEADBAND_RANGE),
      };
    }
  }
  return out;
}

export function loadCalibration(storage) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (text) return sanitize(JSON.parse(text));
  } catch {
    // storage blocked or corrupted JSON: fall back to config.js
  }
  return defaultCalibration();
}

export function saveCalibration(storage, cal) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(cal));
    return true;
  } catch {
    return false;
  }
}

export function clearCalibration(storage) {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
