import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attitude, balanceReport, cameraPose, computeBody, DEFAULT_PARAMS, DEFAULT_PARTS, DEFAULT_TRIM, levelBallast,
  physInitial, physStep, thrustFromCommand, TRIMS, trimParts,
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

test('thrust: dead band, firmware clamp (60 %), weaker backwards', () => {
  assert.equal(thrustFromCommand(0), 0);
  assert.equal(thrustFromCommand(0.03), 0);
  near(thrustFromCommand(0.3), DEFAULT_PARAMS.thrustN, 1e-9);               // thrustN = thrust at +-150 us
  assert.ok(thrustFromCommand(0.5) > 2 * DEFAULT_PARAMS.thrustN);           // keeps rising up to the limit
  near(thrustFromCommand(0.6), thrustFromCommand(1), 1e-9);                 // clamped like the firmware
  near(thrustFromCommand(5), thrustFromCommand(0.6), 1e-9);
  near(thrustFromCommand(-0.3), -DEFAULT_PARAMS.thrustN * 0.7, 1e-9);
  assert.ok(thrustFromCommand(0.15) > 0 && thrustFromCommand(0.15) < thrustFromCommand(0.2));
  assert.equal(thrustFromCommand(NaN), 0);
  assert.equal(DEFAULT_PARAMS.limit, 0.6);
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

test('forward goes straight; the nose dips while speeding up, then levels out', () => {
  const body = computeBody(symmetric());
  const r = balanceReport(body);
  assert.ok(r.thrustLineAboveComCm > 0);                  // thrusters above the CoM: dip while accelerating
  assert.ok(Math.abs(r.forwardPitchDeg) < 3);             // ... but in line with the drag: small steady lean
  let s = physInitial({ depth: 1.2 });
  let minPitch = 0;
  for (let t = 0; t < 5; t += 0.02) {
    s = physStep(s, body, { left: 0.3, right: 0.3, vert: 0 }, 0.02);
    minPitch = Math.min(minPitch, attitude(s).pitch);
  }
  const a = attitude(s);
  assert.ok(s.c[1] > 0.8, `y ${s.c[1]}`);
  near(a.heading, 0, 3, 'heading');
  assert.ok(minPitch < -2, `min pitch ${minPitch}`);
  near(a.pitch, r.forwardPitchDeg, 2, 'steady pitch');
});

test('box and ballast off to one side: equal thrust still goes (nearly) straight', () => {
  const body = computeBody(levelBallast(DEFAULT_PARTS)); // box 2 cm right of centre, ballast follows it
  assert.ok(body.com[0] > 0.01);
  const s = run(physInitial({ depth: 1.2 }), body, { left: 0.3, right: 0.3, vert: 0 }, 10);
  assert.ok(Math.abs(attitude(s).heading) < 25, `heading ${attitude(s).heading}`); // was 136 deg with drag at the CoM
  assert.ok(s.c[1] > 2.5, `y ${s.c[1]}`);
});

test('trims: practice is almost neutral with a small tilt, perfect is level, raw floats', () => {
  assert.equal(DEFAULT_TRIM, 'practice');
  assert.ok(TRIMS.practice.label.includes('90'));
  const rep = (name) => balanceReport(computeBody(trimParts(DEFAULT_PARTS, name)));
  const p = rep('practice');
  assert.ok(p.stable && p.netG > 15 && p.netG < 50, `net ${p.netG}`);
  assert.ok(p.restPitchDeg > 1 && p.restPitchDeg < 5, `pitch ${p.restPitchDeg}`);
  assert.ok(Math.abs(p.restRollDeg) < 3, `roll ${p.restRollDeg}`);
  const q = rep('perfect');
  near(q.netG, 40, 2);
  near(q.restPitchDeg, 0, 1);
  assert.ok(rep('raw').netG > 1000);
  // keeps the measured parts, only the ballast changes; the input is not touched
  const mine = copy(DEFAULT_PARTS);
  mine.find((x) => x.id === 'box').vol = 2500;
  const out = trimParts(mine, 'practice');
  assert.equal(out.find((x) => x.id === 'box').vol, 2500);
  assert.equal(mine.find((x) => x.id === 'ballast').mass, 0);
  assert.equal(trimParts(out, 'raw').find((x) => x.id === 'ballast').mass, 0);
  assert.deepEqual(trimParts(DEFAULT_PARTS, 'nonsense'), trimParts(DEFAULT_PARTS, 'practice'));
});

test('practice trim: hovers, drifting up only a few cm per second; down holds it easily', () => {
  const body = computeBody(trimParts(DEFAULT_PARTS, 'practice'));
  const still = run(physInitial({ depth: 1.2 }), body, STOP, 5);
  const rise = attitude(still).depth;
  assert.ok(rise < 1.2 && rise > 0.9, `depth after 5 s ${rise}`);
  near(attitude(still).pitch, 3, 2, 'leftover nose-up tilt');
  const down = run(physInitial({ depth: 1.2 }), body, { left: 0, right: 0, vert: -0.1 }, 5); // a low level
  assert.ok(attitude(down).depth > 1.2, `depth ${attitude(down).depth}`);
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
