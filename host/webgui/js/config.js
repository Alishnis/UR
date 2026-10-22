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
  slotPins: [1, 40, 42],

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

  // ---- Camera and vision (missions 2-5). Display-only: nothing here reaches the motors. ----

  // Vision WebSocket port in the bridge (--vision-port). ?visionPort=... in the address bar overrides it.
  visionPort: 8766,

  // Camera request and lens. hfovDeg = horizontal field of view IN AIR                 (measure)
  // underwater: a flat port shrinks the FOV ~1.33x, the GUI then uses 2*atan(tan(hfov/2)/1.333).
  // HFOV and underwater can also be changed in the Drive tab (remembered in this browser).
  camera: { width: 1280, height: 720, hfovDeg: 70, underwater: true },

  // Frames sent to the detector: rate, JPEG quality 0..1, how long to wait for an answer (ms),
  // JPEG width per mode (tags need detail; line and colours are fine with less).
  // More frames = more chances to catch a tag between motion blur; tags take ~20 ms each.
  vision: { sendHz: 15, jpegQuality: 0.9, timeoutMs: 2000, sendWidth: { tags: 1280, line: 640, colors: 640 } },

  // 2.1 tags: tags on the course, sightings before an id counts, detector minimum decision
  // margin (higher = fewer false ids, lower = finds faint tags; a real webcam gives small tags
  // 10-40), corrected bits allowed (0-2; tag36h11 ids differ in >= 11 bits, so 1 is safe),
  // CLAHE second pass when fewer than `expected` tags were found (faint / murky).
  mission21: { expected: 3, confirmFrames: 5, minMargin: 10, maxHamming: 1, clahe: true },

  // 2.2 docking advice: turn until the tag is within alignDeg, then up/down until within
  // alignVertM (metres), "SLOW, ENTERING" once closer than slowDistM (metres).
  // aimBelowM: how far the chamber entrance centre is BELOW its tag (metres, measure on the
  // frame); 0 = aim at the tag itself. The simulator uses its own layout.          (measure)
  mission22: { alignDeg: 5, alignVertM: 0.08, slowDistM: 1.0, aimBelowM: 0 },

  // 3 line: checkpoints after the start tape and their spacing (cm), line darkness threshold,
  // reference row for the offset and the row a tape must cross to count (fractions of the image
  // height from the top), steering dead zone (|steer| below it = ON LINE).
  // triggerRow: the detector loses a tape at ~0.9 (too little line left below it to call it a
  // gap), so the row must stay well above that or a fast tape jumps over the counting band.
  mission3: { checkpoints: 3, spacingCm: 50, darkThresh: 25, refRow: 0.75, triggerRow: 0.75, steerDead: 0.08 },

  // 4 hook: continuous hold that secures the 20 points (ms).
  mission4: { holdMs: 3000 },

  // 5 poles: smallest blob (fraction of the frame area), pole shape (box height / width),
  // "aligned" band around the image centre and "close" box height (fractions of the frame).
  mission5: { minAreaFrac: 0.0008, minAspect: 1.2, alignFrac: 0.08, closeFrac: 0.6 },

  // Attempt clock in the camera panel (contest: 20 min for the tasks).
  attemptMinutes: 20,
};
