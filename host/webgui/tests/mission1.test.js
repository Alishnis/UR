import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bigText, initialState, loadFields, parseNLine, reduce, saveFields, urlLine, validatePassword,
  validateSsid, validateUrl, wifiLine,
} from '../js/mission1.js';
import { parseLine } from '../js/protocol.js';

test('validateSsid', () => {
  assert.equal(validateSsid('UR_Field'), null);
  assert.equal(validateSsid('a'.repeat(32)), null);
  assert.match(validateSsid(''), /empty/);
  assert.match(validateSsid('my wifi'), /spaces/);
  assert.match(validateSsid('tab\there'), /spaces/);
  assert.match(validateSsid('a'.repeat(33)), /longer than 32/);
  assert.match(validateSsid('café'), /ASCII/);
});

test('validatePassword: may be empty (open network), limited to 63 printable chars, may contain spaces', () => {
  assert.equal(validatePassword(''), null);
  assert.equal(validatePassword('12345678'), null);
  assert.equal(validatePassword('with spaces ok'), null);
  assert.equal(validatePassword('p'.repeat(63)), null);
  assert.match(validatePassword('p'.repeat(64)), /longer than 63/);
  assert.match(validatePassword('ü'), /ASCII/);
  assert.match(validatePassword('1234567'), /8-63 characters/); // WiFi.begin() refuses it
  assert.equal(validatePassword('12345678'), null);
});

test('validateUrl', () => {
  assert.equal(validateUrl('http://192.168.4.1/'), null);
  assert.equal(validateUrl('https://x.y/z'), null);
  assert.match(validateUrl(''), /empty/);
  assert.match(validateUrl('192.168.4.1'), /http/);
  assert.match(validateUrl('ftp://x'), /http/);
  assert.match(validateUrl('http://a b'), /spaces/);
  assert.equal(validateUrl('http://' + 'a'.repeat(151)), null); // "U " + 158 = 160
  assert.match(validateUrl('http://' + 'a'.repeat(152)), /too long/);
});

test('lines sent to the firmware', () => {
  assert.equal(wifiLine('UR_Field', '12345678'), 'M UR_Field 12345678');
  assert.equal(wifiLine('Open', ''), 'M Open');
  assert.equal(urlLine('http://192.168.4.1/'), 'U http://192.168.4.1/');
});

test('parseNLine: every message the firmware / mock can send', () => {
  assert.deepEqual(parseNLine('wifi: connecting to UR_Field'), { type: 'connecting', ssid: 'UR_Field' });
  assert.deepEqual(parseNLine('wifi: connected, ip 192.168.4.2, rssi -48 dBm'),
    { type: 'connected', ip: '192.168.4.2', rssi: -48 });
  assert.equal(parseNLine('wifi: SSID "UR_Field" not found (still trying; 2.4 GHz only, check spelling)').type, 'searching');
  assert.equal(parseNLine('wifi: failed, wrong password?').type, 'wifi-failed');
  assert.equal(parseNLine('wifi: timeout after 15 s (SSID not found): check SSID, password, 2.4 GHz network').type, 'wifi-failed');
  assert.equal(parseNLine('wifi: connection lost, reconnecting').type, 'lost');
  assert.deepEqual(parseNLine('url set: http://x/'), { type: 'url', url: 'http://x/' });
  assert.deepEqual(parseNLine('get: http://x/'), { type: 'get', url: 'http://x/' });
  assert.deepEqual(parseNLine('http 200, 77 bytes'), { type: 'http-ok', status: 200, bytes: 77 });
  assert.deepEqual(parseNLine('got: Congratulations!!!'), { type: 'got', text: 'Congratulations!!!' });
  assert.deepEqual(parseNLine('got: (empty body)'), { type: 'note', text: '(empty body)' });
  assert.deepEqual(parseNLine('got: (5 more lines not shown)'), { type: 'note', text: '(5 more lines not shown)' });
  assert.deepEqual(parseNLine('got: (cut at 2048 bytes)'), { type: 'note', text: '(cut at 2048 bytes)' });
  assert.deepEqual(parseNLine('http error 404'), { type: 'http-error', text: 'HTTP error 404' });
  assert.deepEqual(parseNLine('http error: connection refused'), { type: 'http-error', text: 'HTTP error: connection refused' });
  assert.equal(parseNLine('http error: wifi not connected (send M first)').type, 'http-error');
  assert.equal(parseNLine('something else'), null);
});

test('a real message that merely starts with a parenthesis is still text', () => {
  assert.deepEqual(parseNLine('got: (hello) world'), { type: 'got', text: '(hello) world' });
  assert.deepEqual(parseNLine('got: (cut at 5 bytes) extra'), { type: 'got', text: '(cut at 5 bytes) extra' });
});

test('works end to end with the protocol parser (N lines arrive as kind N)', () => {
  const msg = parseLine('N got: hello');
  assert.equal(msg.kind, 'N');
  assert.deepEqual(parseNLine(msg.text), { type: 'got', text: 'hello' });
});

const run = (events) => events.reduce((s, e) => reduce(s, parseNLine(e)), initialState());

test('state: successful join and GET shows the text', () => {
  let s = run([
    'wifi: connecting to UR_Field',
    'wifi: connected, ip 192.168.4.2, rssi -48 dBm',
  ]);
  assert.equal(s.wifi, 'connected');
  assert.equal(s.ip, '192.168.4.2');
  s = reduce(s, parseNLine('get: http://x/'));
  assert.equal(s.getting, true);
  assert.equal(bigText(s), '...'); // nothing received yet
  for (const e of ['http 200, 77 bytes', 'got: Congratulations!!! This is the message.']) s = reduce(s, parseNLine(e));
  assert.equal(s.getting, false);
  assert.equal(bigText(s), 'Congratulations!!! This is the message.');
});

test('state: a new GET clears the previous text; multi-line text is kept in order', () => {
  let s = run(['get: u', 'http 200, 9 bytes', 'got: one', 'got: two', 'got: (3 more lines not shown)']);
  assert.equal(bigText(s), 'one\ntwo');
  assert.deepEqual(s.notes, ['(3 more lines not shown)']);
  s = reduce(s, parseNLine('get: u'));
  assert.deepEqual(s.received, []);
  assert.deepEqual(s.notes, []);
});

test('state: HTTP error is shown and ends "getting"', () => {
  const s = run(['get: u', 'http error: connection refused']);
  assert.equal(s.getting, false);
  assert.equal(bigText(s), 'HTTP error: connection refused');
  assert.equal(s.error, 'HTTP error: connection refused');
});

test('state: wifi failures and loss', () => {
  let s = run(['wifi: connecting to X', 'wifi: failed, wrong password?']);
  assert.equal(s.wifi, 'failed');
  assert.match(s.wifiText, /wrong password/);
  s = run(['wifi: connecting to X', 'wifi: connected, ip 1.2.3.4, rssi -50 dBm', 'wifi: connection lost, reconnecting']);
  assert.equal(s.wifi, 'connecting');
  assert.equal(s.ip, null);
  s = run(['wifi: connecting to X', 'wifi: SSID "X" not found (still trying; 2.4 GHz only, check spelling)']);
  assert.equal(s.wifi, 'searching');
});

test('state: unknown events leave the state untouched', () => {
  const s = initialState();
  assert.equal(reduce(s, null), s);
  assert.equal(reduce(s, { type: 'nope' }), s);
  assert.equal(bigText(s), '—');
});

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

test('fields: defaults, save/load round trip, broken storage', () => {
  const defaults = { ssid: 'UR_Field', password: '12345678', url: '' };
  assert.deepEqual(loadFields(fakeStorage(), defaults), defaults);
  const st = fakeStorage();
  assert.equal(saveFields(st, { ssid: 'A', password: 'B', url: 'http://c/' }), true);
  assert.deepEqual(loadFields(st, defaults), { ssid: 'A', password: 'B', url: 'http://c/' });
  assert.deepEqual(loadFields(fakeStorage({ 'rov.mission1.v1': '{bad' }), defaults), defaults);
  assert.deepEqual(loadFields(fakeStorage({ 'rov.mission1.v1': '{"ssid":5}' }), defaults), defaults);
  assert.deepEqual(loadFields(null, defaults), defaults);
  const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  assert.deepEqual(loadFields(throwing, defaults), defaults);
  assert.equal(saveFields(throwing, defaults), false);
});
