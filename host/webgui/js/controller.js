// Controller: ARM state, held keys, throttle levels, tests, ramp and the D / S line for each tick.
// No DOM, no timers: call step(dtSeconds) from the 20 Hz loop. Unit-tested.

import { CONFIG } from './config.js';
import { axesFromKeys, DRIVE_KEYS, KEY_MAG_DOWN, KEY_MAG_UP, KEY_ZERO } from './controls.js';
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
    // 'hold': an axis is full only while its key is pressed. 'latch' (Throttle mode): a held key moves
    // the level of its axis gradually (lever) and the level stays after the key is released.
    this.driveMode = opts.driveMode === 'latch' ? 'latch' : 'hold';
    this.leverRate = opts.leverRatePerSec ?? CONFIG.driveMode.ratePerSec;
    this.lever = { surge: 0, yaw: 0, heave: 0 };
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

  // 'hold' | 'latch'. Refused while armed: the way the keys act must not change under running motors.
  setDriveMode(mode) {
    if (this.armed || (mode !== 'hold' && mode !== 'latch')) return false;
    this.driveMode = mode;
    this.zeroLever();
    return true;
  }

  zeroLever() {
    this.lever = { surge: 0, yaw: 0, heave: 0 };
  }

  // The surge / yaw / heave the vehicle is being driven with (-1..1): the lever levels in Throttle mode,
  // the held keys in Hold mode. The test-scene simulator moves with this.
  axes() {
    return this.driveMode === 'latch' ? { ...this.lever } : axesFromKeys(this.keys);
  }

  // -- ARM / DISARM / E-STOP ----------------------------------------------
  arm() {
    if (this.armed) return { ok: true };
    if (!isPermutation(this.cal.outputSlot)) {
      return { ok: false, reason: 'outputSlot must use each of 0, 1, 2 exactly once' };
    }
    this.current = [0, 0, 0];
    this.test = null;
    this.zeroLever(); // always start from stop
    this.armed = true;
    return { ok: true };
  }

  disarm() {
    this.armed = false;
    this.test = null;
    this.current = [0, 0, 0];
    this.zeroLever();
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

  // Focus lost, tab hidden or a text field entered: nobody is watching the keys, so the levels go to stop too.
  clearKeys() {
    this.keys.clear();
    this.stopTest();
    this.zeroLever();
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
      this.zeroLever();
      return { line: 'S', slots: [0, 0, 0], armed: false };
    }

    let target;
    let immediateZero = false;
    if (this.keys.has(KEY_ZERO)) {
      target = [0, 0, 0];
      immediateZero = true; // Space = brake: no ramp
      this.zeroLever();     // ... and the Throttle levels go to stop as well
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
        if (this.driveMode === 'latch') this.moveLever(dt);
        const logical = mix(this.axes(), this.magnitude);
        target = toSlots(toTargets(logical, this.cal.thrusters, this.maxThrottle), this.cal.outputSlot);
      }
    }

    const maxStep = this.rampPerSec * dt;
    this.current = this.current.map((c, i) => (immediateZero ? 0 : rampToward(c, target[i], maxStep)));
    return { line: encodeD(this.current), slots: [...this.current], armed: true };
  }

  // Throttle mode: each held drive key moves the level of its axis by leverRate per second; opposite
  // keys cancel; the level stays within -1..1 and stays where it is when the key is released.
  moveLever(dt) {
    for (const [code, { axis, dir }] of Object.entries(DRIVE_KEYS)) {
      if (this.keys.has(code)) this.lever[axis] = clamp(this.lever[axis] + dir * this.leverRate * dt, -1, 1);
    }
  }
}
