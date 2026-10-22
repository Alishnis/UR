import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_HEADER_BYTES, MAX_JPEG_BYTES, VISION_MODES, VISION_VERSION, packFrame, parseVisionMessage,
} from '../js/vision_proto.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

// The bridge side of the layout (host/vision/frames.py), redone here to check packFrame.
function unpack(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + n)));
  return { n, header, jpeg: bytes.subarray(4 + n) };
}

test('constants match the protocol', () => {
  assert.equal(VISION_VERSION, 1);
  assert.deepEqual(VISION_MODES, ['tags', 'line', 'colors']);
  assert.equal(MAX_HEADER_BYTES, 4096);
  assert.equal(MAX_JPEG_BYTES, 4_000_000);
});

test('packFrame: big-endian length, JSON header, JPEG bytes untouched', () => {
  const header = { id: 7, mode: 'tags', params: { clahe: true, minMargin: 20 } };
  const out = packFrame(header, JPEG);
  const { n, header: back, jpeg } = unpack(out);
  const headText = JSON.stringify(header);
  assert.equal(n, headText.length);
  assert.deepEqual([...out.subarray(0, 4)], [0, 0, (n >> 8) & 0xff, n & 0xff]);
  assert.deepEqual(back, header);
  assert.deepEqual([...jpeg], [...JPEG]);
  assert.equal(out.length, 4 + n + JPEG.length);
});

test('packFrame: header length counts UTF-8 bytes, ArrayBuffer accepted', () => {
  const out = packFrame({ id: 1, mode: 'colors', params: { note: 'ü€' } }, JPEG.buffer);
  const { n, header } = unpack(out);
  assert.equal(header.params.note, 'ü€');
  assert.equal(n, new TextEncoder().encode(JSON.stringify(header)).length);
  assert.ok(n > JSON.stringify(header).length); // multi-byte characters
});

test('packFrame: limits', () => {
  const pad = (len) => ({ id: 1, mode: 'tags', params: { x: 'a'.repeat(len) } });
  const base = JSON.stringify(pad(0)).length;
  assert.doesNotThrow(() => packFrame(pad(MAX_HEADER_BYTES - base), JPEG)); // exactly 4096
  assert.throws(() => packFrame(pad(MAX_HEADER_BYTES - base + 1), JPEG), /header/);
  assert.throws(() => packFrame({ id: 1, mode: 'tags', params: {} }, new Uint8Array(0)), /JPEG/);
  assert.throws(() => packFrame({ id: 1, mode: 'tags', params: {} }, 'not bytes'), /JPEG/);
  assert.throws(() => packFrame({ id: 1, mode: 'tags', params: {} }, null), /JPEG/);
  assert.throws(() => packFrame({ id: 1, mode: 'tags', params: {} }, new Uint8Array(MAX_JPEG_BYTES + 1)), /JPEG/);
});

test('parseVisionMessage: hello (available and unavailable)', () => {
  const ok = parseVisionMessage('{"type":"hello","version":1,"available":true,"modes":["tags","line","colors"]}');
  assert.equal(ok.type, 'hello');
  assert.equal(ok.version, 1);
  assert.equal(ok.available, true);
  assert.deepEqual(ok.modes, ['tags', 'line', 'colors']);
  const off = parseVisionMessage('{"type":"hello","version":1,"available":false,"modes":[],"reason":"No module named cv2"}');
  assert.equal(off.available, false);
  assert.equal(off.reason, 'No module named cv2');
  const odd = parseVisionMessage('{"type":"hello","available":"yes","modes":"tags"}');
  assert.equal(odd.available, false); // only a real true counts
  assert.deepEqual(odd.modes, []);
});

test('parseVisionMessage: results of each mode', () => {
  const tags = parseVisionMessage(JSON.stringify({
    type: 'result', id: 3, mode: 'tags', w: 1280, h: 720, ms: 12.5,
    tags: [{ id: 17, corners: [[0, 0], [1, 0], [1, 1], [0, 1]], center: [0.5, 0.5], margin: 60, pose: null }],
  }));
  assert.equal(tags.id, 3);
  assert.equal(tags.tags.length, 1);
  assert.equal(tags.ms, 12.5);

  const line = parseVisionMessage(JSON.stringify({
    type: 'result', id: 4, mode: 'line', w: 640, h: 360, ms: 4, refY: 270,
    line: { p0: [320, 350], p1: [330, 10], angleDeg: 1.7, offset: 0.02, widthPx: 12, tapes: [[322, 200]], confidence: 0.9 },
    mask: 'data:image/png;base64,AAAA',
  }));
  assert.equal(line.line.angleDeg, 1.7);
  assert.deepEqual(line.line.tapes, [[322, 200]]);
  assert.equal(line.mask, 'data:image/png;base64,AAAA');

  const lost = parseVisionMessage('{"type":"result","id":5,"mode":"line","w":640,"h":360,"refY":270,"line":null}');
  assert.equal(lost.line, null);
  assert.equal(lost.ms, null);

  const colors = parseVisionMessage('{"type":"result","id":6,"mode":"colors","w":640,"h":360,"ms":3,"blobs":[{"color":"red"}]}');
  assert.equal(colors.blobs[0].color, 'red');
});

test('parseVisionMessage: result fields are normalised for the drawing code', () => {
  const t = parseVisionMessage('{"type":"result","id":1,"mode":"tags","w":10,"h":10,"tags":"nope"}');
  assert.deepEqual(t.tags, []);
  const t2 = parseVisionMessage('{"type":"result","id":1,"mode":"tags","w":10,"h":10,"tags":[null,5,{"id":1}]}');
  assert.deepEqual(t2.tags, [{ id: 1 }]);
  const c = parseVisionMessage('{"type":"result","id":1,"mode":"colors","w":10,"h":10}');
  assert.deepEqual(c.blobs, []);
  const l = parseVisionMessage('{"type":"result","id":1,"mode":"line","w":10,"h":10,"line":{"offset":0.1}}');
  assert.deepEqual(l.line.tapes, []);
  const l2 = parseVisionMessage('{"type":"result","id":1,"mode":"line","w":10,"h":10,"line":[1,2]}');
  assert.equal(l2.line, null);
  const m = parseVisionMessage('{"type":"result","id":1,"mode":"colors","w":10,"h":10,"mask":"javascript:alert(1)"}');
  assert.equal('mask' in m, false); // only data:image URLs may reach an <img>
});

test('parseVisionMessage: errors and pong', () => {
  assert.deepEqual(parseVisionMessage('{"type":"error","id":9,"text":"undecodable JPEG"}'),
    { type: 'error', id: 9, text: 'undecodable JPEG' });
  assert.deepEqual(parseVisionMessage('{"type":"error","id":null,"text":"bad header"}'),
    { type: 'error', id: null, text: 'bad header' });
  const noText = parseVisionMessage('{"type":"error"}');
  assert.equal(noText.id, null);
  assert.equal(noText.text, 'unknown error');
  assert.deepEqual(parseVisionMessage('{"type":"pong"}'), { type: 'pong' });
});

test('parseVisionMessage: junk is null', () => {
  for (const junk of [
    '', 'not json', '{bad', '[]', '[1,2]', 'null', '42', '"text"', '{}', '{"type":"nope"}',
    '{"type":"result","mode":"tags","w":1,"h":1}',              // no id
    '{"type":"result","id":"1","mode":"tags","w":1,"h":1}',     // id not a number
    '{"type":"result","id":1,"mode":"tags","w":"1","h":1}',     // w not a number
    '{"type":"result","id":1,"mode":"tags","w":0,"h":1}',       // empty frame
    '{"type":"result","id":1,"mode":5,"w":1,"h":1}',            // mode not a string
    '{"type":"result","id":1,"w":1,"h":1}',                     // no mode
  ]) {
    assert.equal(parseVisionMessage(junk), null, junk);
  }
  assert.equal(parseVisionMessage(null), null);
  assert.equal(parseVisionMessage(undefined), null);
  assert.equal(parseVisionMessage(new ArrayBuffer(4)), null);
});

test('parseVisionMessage: tags results carry the weak (not trusted) sightings', () => {
  const base = { type: 'result', id: 1, mode: 'tags', w: 640, h: 360, ms: 5 };
  const m = parseVisionMessage(JSON.stringify({ ...base, tags: [], weak: [{ id: 17, margin: 6 }, 'junk'] }));
  assert.deepEqual(m.weak, [{ id: 17, margin: 6 }]);
  assert.deepEqual(parseVisionMessage(JSON.stringify({ ...base, tags: [] })).weak, []);
});
