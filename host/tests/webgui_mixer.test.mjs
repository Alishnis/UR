// Run: node --test host/tests/webgui_mixer.test.mjs  (also run by pytest, tests/test_bridge.py)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mix, shapeThruster, thrusterCommands, Ramp, toSlots, fromSlots, outputSlotProblem } from "../webgui/js/control/mixer.js";
import { Protocol } from "../webgui/js/protocol/protocol.js";

const plain = { invert: false, gain: 1, deadBand: 0 };
const cfg = { thrusters: { left: plain, right: plain, vert: plain } };
const input = (surge, yaw, heave, magnitude = 1) => ({ surge, yaw, heave, magnitude });

test("forward pushes both, turn right = left forward and right back", () => {
  assert.deepEqual(mix(input(1, 0, 0)), { left: 1, right: 1, vert: 0 });
  assert.deepEqual(mix(input(0, 1, 0)), { left: 1, right: -1, vert: 0 });
  const fwdRight = mix(input(1, 1, 0));  // keeps the ratio instead of clipping
  assert.equal(fwdRight.left, 1);
  assert.equal(fwdRight.right, 0);
  assert.equal(mix(input(0, 0, -1, 0.5)).vert, -0.5);
});

test("throttle never exceeds MAX, invert and dead band", () => {
  const out = thrusterCommands(input(1, 1, 1), cfg, 0.3);
  for (const v of Object.values(out)) assert.ok(Math.abs(v) <= 0.3 + 1e-9);
  assert.equal(shapeThruster(0.5, { ...plain, invert: true }, 1), -0.5);
  assert.equal(shapeThruster(0, { ...plain, deadBand: 0.1 }, 1), 0);  // zero stays zero
  assert.ok(Math.abs(shapeThruster(0.01, { ...plain, deadBand: 0.1 }, 1) - 0.109) < 1e-9);
});

test("ramp limits the change per second", () => {
  const ramp = new Ramp(1.5);
  const a = ramp.step({ left: 0.3, right: 0.3, vert: 0 }, 0.05);
  assert.ok(Math.abs(a.left - 0.075) < 1e-9);
  for (let i = 0; i < 10; i++) ramp.step({ left: 0.3, right: 0.3, vert: 0 }, 0.05);
  assert.ok(Math.abs(ramp.value.left - 0.3) < 1e-9);
});

test("protocol lines", () => {
  assert.equal(Protocol.encodeDrive(0.1, -0.25, 0), "D 0.100 -0.250 0.000");
  assert.equal(Protocol.encodeWifi("UR Field", "1234\n5678"), "M URField 1234 5678");
  assert.deepEqual(Protocol.parseLine("T 1550 1450 1500"), { type: "telemetry", us: [1550, 1450, 1500] });
  assert.equal(Protocol.parseLine("N got: hello world").text, "got: hello world");
});

test("thruster test runs exactly one thruster, with its invert", () => {
  const out = thrusterCommands({ ...input(1, 1, 1, 0.5), test: { name: "right", sign: 1 } }, cfg, 0.3);
  assert.deepEqual(out, { left: 0, right: 0.15, vert: 0 });  // the W/D/R keys are ignored during a test
  const inv = { thrusters: { ...cfg.thrusters, vert: { ...plain, invert: true } } };
  assert.equal(thrusterCommands({ ...input(0, 0, 0, 1), test: { name: "vert", sign: 1 } }, inv, 0.3).vert, -0.3);
});

test("output slots: remap without reflashing", () => {
  const swapped = { left: 1, right: 0, vert: 2 };  // left motor plugged into GPIO 5
  assert.deepEqual(toSlots({ left: 0.1, right: -0.2, vert: 0.3 }, swapped), [-0.2, 0.1, 0.3]);
  assert.deepEqual(fromSlots([1400, 1600, 1500], swapped), [1600, 1400, 1500]);
  assert.equal(outputSlotProblem({ left: 0, right: 1, vert: 2 }), null);
  assert.ok(outputSlotProblem({ left: 0, right: 0, vert: 2 }));  // two thrusters on one ESC
});

test("pin test: one raw output, ignoring invert and the thruster names", () => {
  const swapped = { left: 2, right: 0, vert: 1 };
  const inv = { outputSlot: swapped, thrusters: { left: { ...plain, invert: true }, right: plain, vert: plain } };
  const out = thrusterCommands({ ...input(1, 0, 0, 0.5), pinTest: { slot: 2, sign: 1 } }, inv, 0.3);
  assert.deepEqual(toSlots(out, swapped), [0, 0, 0.15]);  // GPIO 6 only, positive although left is inverted
});
