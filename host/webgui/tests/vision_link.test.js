import test from 'node:test';
import assert from 'node:assert/strict';

import { cameraErrorText } from '../js/camera.js';
import { VisionLink } from '../js/vision_link.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

// Stand-in for the browser WebSocket: records what is sent, lets the test play the bridge.
class FakeSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  reply(obj) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
}

function headerOf(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
}

function makeLink(extra = {}) {
  const clock = { t: 1000 };
  const events = { results: [], errors: [], hellos: [], closes: 0 };
  const link = new VisionLink({
    url: 'ws://localhost:8766',
    timeoutMs: 2000,
    WebSocketImpl: FakeSocket,
    now: () => clock.t,
    onResult: (msg, meta) => events.results.push({ msg, meta }),
    onError: (msg) => events.errors.push(msg),
    onHello: (msg) => events.hellos.push(msg),
    onClose: () => events.closes++,
    ...extra,
  });
  link.start();
  const ws = FakeSocket.last;
  return { link, ws, clock, events };
}

function ready() {
  const t = makeLink();
  t.ws.open();
  t.ws.reply({ type: 'hello', version: 1, available: true, modes: ['tags', 'line', 'colors'] });
  return t;
}

const result = (id, extra = {}) => ({ type: 'result', id, mode: 'tags', w: 640, h: 360, ms: 12.3, tags: [], ...extra });

test('not ready until the hello says available', () => {
  const { link, ws } = makeLink();
  assert.equal(link.ready, false);
  assert.equal(link.begin(), null);
  ws.open();
  assert.equal(link.available, null);
  assert.equal(link.ready, false);
  ws.reply({ type: 'hello', version: 1, available: false, modes: [], reason: 'No module named cv2' });
  assert.equal(link.available, false);
  assert.equal(link.reason, 'No module named cv2');
  assert.equal(link.begin(), null);
  link.stop();
});

test('one frame in flight: header has id, mode and params; the result frees the slot', () => {
  const { link, ws, clock, events } = ready();
  const id = link.begin({ mode: 'tags', tab: 'm21' });
  assert.equal(typeof id, 'number');
  assert.equal(link.busy, true);
  assert.equal(link.begin(), null, 'second frame refused while one is in flight');
  assert.equal(link.send(id, { mode: 'tags', params: { clahe: true } }, JPEG), true);
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(headerOf(ws.sent[0]), { id, mode: 'tags', params: { clahe: true } });
  clock.t += 80;
  ws.reply(result(id));
  assert.equal(link.busy, false);
  assert.equal(events.results.length, 1);
  assert.equal(events.results[0].meta.tab, 'm21');
  assert.equal(events.results[0].meta.capturedAt, 1000);
  assert.equal(link.lastMs, 12.3);
  assert.equal(link.rttMs, 80);
  assert.equal(link.resultsPerSec(), 1);
  link.stop();
});

test('timeout frees the slot and the late answer is ignored', () => {
  const { link, ws, clock, events } = ready();
  const a = link.begin({ mode: 'tags' });
  link.send(a, { mode: 'tags', params: {} }, JPEG);
  clock.t += 2001;
  assert.equal(link.busy, false);
  assert.equal(link.timeouts, 1);
  const b = link.begin({ mode: 'tags' });
  assert.notEqual(a, b);
  link.send(b, { mode: 'tags', params: {} }, JPEG);
  ws.reply(result(a)); // late answer for the timed-out frame
  assert.equal(events.results.length, 0);
  assert.equal(link.busy, true);
  ws.reply(result(b));
  assert.equal(events.results.length, 1);
  assert.equal(events.results[0].msg.id, b);
  link.stop();
});

test('send after the timeout is refused (slot already gone)', () => {
  const { link, ws, clock } = ready();
  const id = link.begin({ mode: 'line' });
  clock.t += 2500;
  assert.equal(link.send(id, { mode: 'line', params: {} }, JPEG), false);
  assert.equal(ws.sent.length, 0);
  link.stop();
});

test('an error answers the frame in flight (with its id or without one)', () => {
  const { link, ws, events } = ready();
  let id = link.begin();
  link.send(id, { mode: 'tags', params: {} }, JPEG);
  ws.reply({ type: 'error', id, text: 'undecodable JPEG' });
  assert.equal(link.busy, false);
  id = link.begin();
  link.send(id, { mode: 'tags', params: {} }, JPEG);
  ws.reply({ type: 'error', id: null, text: 'bad header' });
  assert.equal(link.busy, false);
  assert.deepEqual(events.errors.map((e) => e.text), ['undecodable JPEG', 'bad header']);
  link.stop();
});

test('cancel gives the slot back; an empty JPEG is reported, not sent', () => {
  const { link, ws, events } = ready();
  const a = link.begin();
  link.cancel(a);
  assert.equal(link.busy, false);
  const b = link.begin();
  assert.equal(link.send(b, { mode: 'tags', params: {} }, new Uint8Array(0)), false);
  assert.equal(ws.sent.length, 0);
  assert.equal(link.busy, false);
  assert.equal(events.errors.length, 1);
  link.stop();
});

test('junk and unknown messages are ignored', () => {
  const { link, ws, events } = ready();
  const id = link.begin();
  link.send(id, { mode: 'tags', params: {} }, JPEG);
  ws.reply('not json');
  ws.reply({ type: 'result', id: 'x' });
  ws.reply({ type: 'whatever' });
  ws.reply({ type: 'pong' });
  assert.equal(link.busy, true);
  assert.equal(events.results.length + events.errors.length, 0);
  link.stop();
});

test('connection loss clears hello and the frame in flight', () => {
  const { link, ws, events } = ready();
  link.begin();
  ws.close();
  assert.equal(events.closes, 1);
  assert.equal(link.isOpen, false);
  assert.equal(link.available, null);
  assert.equal(link.inFlight, null);
  link.stop();
});

test('frame ids stay in 0 .. 2^31-1 and wrap', () => {
  const { link, ws } = ready();
  link.nextId = 2 ** 31 - 1;
  const a = link.begin();
  link.send(a, { mode: 'tags', params: {} }, JPEG);
  ws.reply(result(a));
  const b = link.begin();
  assert.equal(a, 2 ** 31 - 1);
  assert.equal(b, 0);
  link.stop();
});

test('cameraErrorText: actionable messages for the usual getUserMedia errors', () => {
  assert.match(cameraErrorText({ name: 'NotAllowedError' }), /permission denied: allow it in the address bar/);
  assert.match(cameraErrorText({ name: 'NotFoundError' }), /not found/);
  assert.match(cameraErrorText({ name: 'NotReadableError' }), /busy \(another app\?\)/);
  assert.match(cameraErrorText({ name: 'TypeError', message: 'boom' }), /boom/);
  assert.match(cameraErrorText(undefined), /Camera error/);
});
