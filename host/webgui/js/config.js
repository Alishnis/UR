// ROV GUI configuration: the ONE place for calibration values.
//
// Edit this file at the pool and reload the page (no build, no reflash).
// The Calibration panel in the GUI overrides invert / gain / deadBand / outputSlot
// and remembers them in this browser (localStorage); "Reset" returns to the values below.
//
// Values marked "(measure)" are unknown hardware facts: see docs/HARDWARE_QUESTIONS.md.

export const CONFIG = {
  // Bridge WebSocket port (the page host is taken from the address bar).
  wsPort: 8765,

  // MAX throttle slider: fraction of the full ESC range. 0.30 = +-150 us.
  // The firmware clamp (MAX_DELTA_US in src/config.h) is the one that cannot be bypassed.
  maxThrottle: { default: 0.30, limit: 0.60, step: 0.01 },
  firmwareMaxDeltaUs: 150, // display only: keep equal to MAX_DELTA_US in src/config.h
  neutralUs: 1500,         // display only: telemetry us -> fraction
  usPerUnit: 500,          // display only: telemetry us -> fraction

  // J / K "magnitude" multiplier, applied to surge/yaw/heave before the MAX slider.
  magnitude: { default: 1.0, min: 0.1, max: 1.0, ratePerSec: 0.5 },

  // Output slew limit, fraction of full range per second. Never jump to high throttle.
  rampPerSec: 1.5,

  // Command loop: D (armed) or S (disarmed) at this rate.
  sendHz: 20,

  // ESP counts as alive if any line arrived within this many ms.
  aliveMs: 1500,

  // THRUSTER TEST / PIN TEST: a held button stops by itself after this long.
  testMaxMs: 5000,

  // Mission 1 panel defaults (the manual's sample values). SSID, password and URL are given
  // only on site: type them in the panel, they are remembered in this browser.
  mission1: { ssid: 'UR_Field', password: '12345678', url: '' },

  // Which firmware output (0, 1, 2 = ESC_PINS order) each logical thruster uses.
  // Must be a permutation of 0, 1, 2, otherwise ARM is refused.
  outputSlot: { left: 0, right: 1, vert: 2 },

  // GPIO numbers of the firmware outputs, used for labels only. Must match
  // ESC_PINS in src/config.h.
  slotPins: [1, 42, 40],

  // Per logical thruster:
  //   invert   flip the sign (fixes a motor that spins the wrong way)   (measure, Q4)
  //   gain     balance left against right, 0.1 .. 2                     (measure)
  //   deadBand fraction of full range where the motor really starts      (measure, Q3)
  //            deadBand = (starting pulse us - 1500) / 500
  thrusters: {
    left: { invert: false, gain: 1.0, deadBand: 0.0 },
    right: { invert: false, gain: 1.0, deadBand: 0.0 },
    vert: { invert: false, gain: 1.0, deadBand: 0.0 },
  },
};
