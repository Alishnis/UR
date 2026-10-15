// Controller: ARM state, held keys, tests, ramp and the D / S line for each tick.
// No DOM, no timers: call step(dtSeconds) from the 20 Hz loop. Unit-tested.

import { CONFIG } from './config.js';
import { axesFromKeys, KEY_MAG_DOWN, KEY_MAG_UP, KEY_ZERO } from './controls.js';
import {
  clamp, encodeD, isPermutation, mix, pinTestSlots, rampToward, thrusterTestSlots,
  toSlots, toTargets,
} from './mixer.js';

export class Controller {
  // cal: {outputSlot, thrusters}; opts override CONFIG values (used by tests).
  constructor(cal, opts = {}) {
    this.cal = cal;
    this.rampPerSec = opts.rampPerSec ?? CONFIG.rampPerSec;
    this.magCfg = opts.magnitude ?? CONFIG.magnitude;
    this.testMaxMs = opts.testMaxMs ?? CONFIG.testMaxMs;
    this.maxThrottle = opts.maxThrottle ?? CONFIG.maxThrottle.default;
    this.maxLimit = opts.maxLimit ?? CONFIG.maxThrottle.limit;
    this.magnitude = this.magCfg.default;
    this.armed = false;
    this.keys = new Set();
    this.test = null; // {kind:'thruster', name, sign} | {kind:'pin', slot, sign}
    this.testAgeMs = 0;
    this.current = [0, 0, 0]; // what we send, firmware order (after the ramp)
  }

  // -- configuration ---------------------------------------------------
  setCalibration(cal) {
    if (this.armed) return false; // never change the mapping under running motors
    this.cal = cal;
    return true;
  }

  setMaxThrottle(v) {
    this.maxThrottle = clamp(Number(v) || 0, 0, this.maxLimit);
  }

  // -- ARM / DISARM / E-STOP ----------------------------------------------
  arm() {
    if (this.armed) return { ok: true };
    if (!isPermutation(this.cal.outputSlot)) {
      return { ok: false, reason: 'outputSlot must use each of 0, 1, 2 exactly once' };
    }
    this.current = [0, 0, 0];
    this.test = null;
    this.armed = true;
    return { ok: true };
  }

  disarm() {
    this.armed = false;
    this.test = null;
    this.current = [0, 0, 0];
  }

  estop() {
    this.disarm();
    this.keys.clear();
  }

  // -- keyboard -------------------------------------------------------
  keyDown(code) {
    this.keys.add(code);
  }

  keyUp(code) {
    this.keys.delete(code);
  }

  clearKeys() {
    this.keys.clear();
    this.stopTest();
  }

  // -- tests (only while armed; the caller stops them on release) --------
  startThrusterTest(name, sign) {
    if (!this.armed) return false;
    this.test = { kind: 'thruster', name, sign: Math.sign(sign) };
    this.testAgeMs = 0;
    return true;
  }

  startPinTest(slot, sign) {
    if (!this.armed) return false;
    this.test = { kind: 'pin', slot, sign: Math.sign(sign) };
    this.testAgeMs = 0;
    return true;
  }

  stopTest() {
    this.test = null;
  }

  // -- one tick -----------------------------------------------------------
  // Returns {line, slots, armed}. slots = values in the line, firmware order.
  step(dt) {
    dt = clamp(dt, 0, 0.1); // a stalled page must not produce a big ramp step

    // J / K: smooth magnitude change, within [min, max].
    const { min, max, ratePerSec } = this.magCfg;
    if (this.keys.has(KEY_MAG_DOWN)) this.magnitude -= ratePerSec * dt;
    if (this.keys.has(KEY_MAG_UP)) this.magnitude += ratePerSec * dt;
    this.magnitude = clamp(this.magnitude, min, max);

    if (!this.armed) {
      this.current = [0, 0, 0];
      return { line: 'S', slots: [0, 0, 0], armed: false };
    }

    let target;
    let immediateZero = false;
    if (this.keys.has(KEY_ZERO)) {
      target = [0, 0, 0];
      immediateZero = true; // Space = brake: no ramp
    } else if (this.test) {
      this.testAgeMs += dt * 1000;
      if (this.testAgeMs > this.testMaxMs) this.test = null; // stuck button protection
    }

    if (!immediateZero) {
      if (this.test) {
        const { kind, sign } = this.test;
        if (kind === 'pin') {
          // raw: ignores outputSlot, invert, gain and dead band
          target = pinTestSlots(this.test.slot, sign * this.maxThrottle);
        } else {
          target = thrusterTestSlots(this.test.name, sign, {
            outputSlot: this.cal.outputSlot,
            thrusters: this.cal.thrusters,
            maxThrottle: this.maxThrottle,
          });
        }
      } else {
        const axes = axesFromKeys(this.keys);
        const logical = mix(axes, this.magnitude);
        target = toSlots(toTargets(logical, this.cal.thrusters, this.maxThrottle), this.cal.outputSlot);
      }
    }

    const maxStep = this.rampPerSec * dt;
    this.current = this.current.map((c, i) => (immediateZero ? 0 : rampToward(c, target[i], maxStep)));
    return { line: encodeD(this.current), slots: [...this.current], armed: true };
  }
}
