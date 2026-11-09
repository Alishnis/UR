import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attitude, balanceReport, cameraPose, computeBody, DEFAULT_PARAMS, DEFAULT_PARTS, levelBallast, physInitial,
  physStep, thrustFromCommand,
} from '../js/rovphys.js';
import { POOL } from '../js/sim.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} != ${b} +- ${eps}`);
const copy = (parts) => parts.map((p) => ({ ...p, pos: [...p.pos], size: [...p.size] }));
const run = (state, body, cmd, seconds, prm = DEFAULT_PARAMS) => {
  let s = state;
  for (let t = 0; t < seconds; t += 0.02) s = physStep(s, body, cmd, 0.02, prm);
  return s;
};
const STOP = { left: 0, right: 0, vert: 0 };
// a symmetric, level, slightly buoyant ROV: everything on the centre line, ballast under the CoB
function symmetric() {
  const parts = copy(DEFAULT_PARTS);
  for (const p of parts) if (p.id !== 'thrL' && p.id !== 'thrR') p.pos[0] = 0;
  return levelBallast(parts);
}

test('computeBody: mass, volume, centres from the parts', () => {
  const b = computeBody(DEFAULT_PARTS);
  near(b.mass, 1.59, 1e-9);
  near(b.volume, 2.88e-3, 1e-12);
  near(b.com[2], (450 * 3 + 130 * 9) / 1590 / 100, 1e-9);
  near(b.netBuoyancyN, (2.88 - 1.59) * 9.81, 1e-6);
  assert.equal(b.corners.length, 16);
  assert.ok(b.inertia.every((i) => i > 0));
});

test('thrust: dead band, firmware clamp, weaker backwards', () => {
  assert.equal(thrustFromCommand(0), 0);
  assert.equal(thrustFromCommand(0.03), 0);
  near(thrustFromCommand(0.3), DEFAULT_PARAMS.thrustN, 1e-9);
  near(thrustFromCommand(0.6), DEFAULT_PARAMS.thrustN, 1e-9);               // clamped like the firmware
  near(thrustFromCommand(-0.3), -DEFAULT_PARAMS.thrustN * 0.7, 1e-9);
  assert.ok(thrustFromCommand(0.15) > 0 && thrustFromCommand(0.15) < thrustFromCommand(0.2));
  assert.equal(thrustFromCommand(NaN), 0);
});

test('the default (unballasted) estimate floats: it rises to the surface and stays there', () => {
  const body = computeBody(DEFAULT_PARTS);
  const r = balanceReport(body);
  assert.ok(r.floats && r.netG > 1000 && !r.canHoldDepth);
  assert.ok(r.ballastForNeutralG > 1000);
  let s = physInitial({ depth: 1.2 });
  s = run(s, body, STOP, 20);
  assert.ok(s.wet < 1, `wet ${s.wet}`);                       // part of it out of the water
  assert.ok(attitude(s).depth < 0.25 && s.c[2] < POOL.depth + 0.2);
  s = run(s, body, { left: 0, right: 0, vert: -0.3 }, 8);    // full down cannot pull it under
  assert.ok(attitude(s).depth < 0.4);
});

test('levelBallast: +40 g of float and level (CoB straight above the CoM)', () => {
  const parts = levelBallast(DEFAULT_PARTS);
  const body = computeBody(parts);
  const r = balanceReport(body);
  near(r.netG, 40, 2);
  assert.ok(r.stable);
  near(r.restPitchDeg, 0, 1);
  near(r.restRollDeg, 0, 1);
  assert.equal(DEFAULT_PARTS.find((p) => p.id === 'ballast').mass, 0); // input not changed
});

test('neutral and level: it hangs still, rising only slowly', () => {
  const body = computeBody(symmetric());
  const s = run(physInitial({ depth: 1.2 }), body, STOP, 10);
  const a = attitude(s);
  assert.ok(a.depth > 0.6 && a.depth < 1.2, `depth ${a.depth}`);
  near(a.pitch, 0, 2, 'pitch');
  near(a.roll, 0, 2, 'roll');
});

test('forward goes forward and the nose dips when the thrust line is above the CoM', () => {
  const body = computeBody(symmetric());
  const r = balanceReport(body);
  assert.ok(r.thrustLineAboveComCm > 0 && r.forwardPitchDeg < 0);
  const s = run(physInitial({ depth: 1.2 }), body, { left: 0.3, right: 0.3, vert: 0 }, 5);
  const a = attitude(s);
  assert.ok(s.c[1] > 0.8, `y ${s.c[1]}`);
  near(a.heading, 0, 3, 'heading');
  assert.ok(a.pitch < -3, `pitch ${a.pitch}`);
});

test('left thruster forward, right back: turns right (heading grows)', () => {
  const body = computeBody(symmetric());
  const s = run(physInitial({ depth: 1.2 }), body, { left: 0.3, right: -0.3, vert: 0 }, 2);
  assert.ok(attitude(s).heading > 30, `heading ${attitude(s).heading}`);
});

test('up thruster: up and down', () => {
  const body = computeBody(symmetric());
  const up = run(physInitial({ depth: 1.2 }), body, { left: 0, right: 0, vert: 0.3 }, 2);
  const down = run(physInitial({ depth: 1.2 }), body, { left: 0, right: 0, vert: -0.3 }, 2);
  assert.ok(attitude(up).depth < 0.9 && attitude(down).depth > 1.3);
});

test('buoyancy forward of the CoM lifts the nose; CoB below the CoM tips it over', () => {
  const parts = symmetric();
  parts.find((p) => p.id === 'ballast').pos[1] -= 8; // ballast to the back
  let s = run(physInitial({ depth: 1.2 }), computeBody(parts), STOP, 8);
  assert.ok(attitude(s).pitch > 5, `pitch ${attitude(s).pitch}`);
  const top = symmetric();
  top.find((p) => p.id === 'ballast').pos[2] = 25; // heavy ballast ABOVE the box
  const body = computeBody(top);
  assert.equal(balanceReport(body).stable, false);
  s = physInitial({ depth: 1.2 });
  s = { ...s, w: [0.2, 0, 0] }; // a small nudge
  s = run(s, body, STOP, 10);
  const a = attitude(s);
  assert.ok(Math.abs(a.roll) > 45 || Math.abs(a.pitch) > 45, `pitch ${a.pitch} roll ${a.roll}`);
});

test('heavy robot lands on the floor and does not sink through it', () => {
  const parts = symmetric();
  parts.find((p) => p.id === 'ballast').mass += 800;
  const s = run(physInitial({ depth: 1.2 }), computeBody(parts), STOP, 15);
  assert.ok(s.onFloor);
  assert.ok(s.c[2] > 0.05 && s.c[2] < 0.4, `z ${s.c[2]}`);
});

test('the camera looks 20 deg down from the front of the box', () => {
  const body = computeBody(symmetric());
  const cam = cameraPose(physInitial({ depth: 1 }), body);
  near(Math.asin(-cam.fwd[2]) * (180 / Math.PI), 20, 1e-6);
  assert.ok(cam.pos[1] > 0.1);
  near(cam.right[0], 1, 1e-9);
});

test('never NaN: zero and huge time steps, junk commands', () => {
  const body = computeBody(symmetric());
  let s = physInitial({ depth: 1 });
  s = physStep(s, body, STOP, 0);
  s = physStep(s, body, { left: NaN, right: 'x', vert: undefined }, 5);
  assert.ok([...s.c, ...s.v, ...s.w].every(Number.isFinite));
});
