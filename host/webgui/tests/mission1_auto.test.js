import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_DEFAULTS, autoActive, autoEvent, autoInitial, autoStart, autoStop, autoText, autoTick, bigText, historyAdd,
  historyAppend, HISTORY_MAX, initialState, keepAcrossReset, loadHistory, parseNLine, reduce, saveHistory,
  scanAdvice, SCAN_LINE, signalBars, statusNote,
} from '../js/mission1.js';

const JOB = { ssid: 'UR_Field', password: '12345678', url: 'http://192.168.4.1/' };
const ev = (text) => parseNLine(text);

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// ---- scan ----------------------------------------------------------------------

test('parseNLine: scan lines', () => {
  assert.deepEqual(ev('scan: started'), { type: 'scan-start' });
  assert.deepEqual(ev('scan: 7 networks'), { type: 'scan-done', total: 7 });
  assert.deepEqual(ev('scan: (3 more not shown)'), { type: 'scan-more', more: 3 });
  assert.deepEqual(ev('scan: failed (timeout)'), { type: 'scan-note', text: 'failed (timeout)' });
  assert.deepEqual(ev('net: -48 dBm ch 6 secured UR_Field'),
    { type: 'net', rssi: -48, ch: 6, open: false, ssid: 'UR_Field' });
  assert.deepEqual(ev('net: -71 dBm ch 11 open Cafe Free WiFi'),
    { type: 'net', rssi: -71, ch: 11, open: true, ssid: 'Cafe Free WiFi' });
  assert.equal(SCAN_LINE, 'L');
});

test('reduce: a scan collects the list; notes end it, "already running" does not', () => {
  let s = initialState();
  for (const t of ['scan: started', 'net: -48 dBm ch 6 secured UR_Field']) s = reduce(s, ev(t));
  assert.equal(s.scan.running, true);
  s = reduce(s, ev('scan: already running'));
  assert.equal(s.scan.running, true);
  for (const t of ['scan: 20 networks', 'net: -60 dBm ch 1 open x', 'scan: (5 more not shown)']) s = reduce(s, ev(t));
  assert.equal(s.scan.running, false);
  assert.equal(s.scan.total, 20);
  assert.equal(s.scan.more, 5);
  assert.deepEqual(s.scan.nets.map((n) => n.ssid), ['UR_Field', 'x']);
  s = reduce(s, ev('scan: started'));
  assert.deepEqual(s.scan.nets, []);
  s = reduce(s, ev('scan: cancelled (joining Wi-Fi)'));
  assert.equal(s.scan.running, false);
  assert.equal(s.scan.note, 'cancelled (joining Wi-Fi)');
});

test('signalBars and scanAdvice', () => {
  assert.deepEqual([-40, -60, -70, -80, -90, NaN].map(signalBars), [4, 3, 2, 1, 0, 0]);
  let s = initialState();
  assert.equal(scanAdvice(s.scan, 'UR_Field'), null); // no scan yet
  for (const t of ['scan: started', 'net: -48 dBm ch 6 secured UR_Field', 'net: -88 dBm ch 1 secured Far',
    'scan: 2 networks']) s = reduce(s, ev(t));
  assert.equal(scanAdvice(s.scan, 'UR_Field').kind, 'ok');
  assert.match(scanAdvice(s.scan, 'Far').text, /Weak signal/);
  assert.match(scanAdvice(s.scan, 'ur_field').text, /case-sensitive/);
  assert.match(scanAdvice(s.scan, 'Tower5G').text, /5 GHz/);
  assert.equal(scanAdvice(s.scan, '').kind, 'warn');
});

// ---- automatic run ----------------------------------------------------------------

test('auto: not connected -> U + M, connected -> G, text -> done', () => {
  let r = autoStart(JOB, initialState(), 0);
  assert.deepEqual(r.send, ['U http://192.168.4.1/', 'M UR_Field 12345678']);
  assert.equal(r.auto.phase, 'joining');
  r = autoEvent(r.auto, ev('wifi: connected, ip 192.168.4.2, rssi -48 dBm'), 900);
  assert.deepEqual(r.send, ['G']);
  assert.equal(r.auto.phase, 'getting');
  r = autoEvent(r.auto, ev('http 200, 75 bytes'), 1000);
  assert.deepEqual(r.send, []);
  r = autoEvent(r.auto, ev('got: Congratulations!!!'), 1000);
  assert.equal(r.auto.phase, 'done');
  assert.equal(autoActive(r.auto), false);
  assert.equal(autoText(r.auto, 1000), 'Auto: done, text received');
});

test('auto: already connected to that SSID -> U + G at once', () => {
  let s = initialState();
  s = reduce(s, ev('wifi: connecting to UR_Field'));
  s = reduce(s, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'));
  const r = autoStart(JOB, s, 0);
  assert.deepEqual(r.send, ['U http://192.168.4.1/', 'G']);
  // connected to ANOTHER network: join first
  assert.deepEqual(autoStart({ ...JOB, ssid: 'Other' }, s, 0).send.at(-1), 'M Other 12345678');
});

test('auto: HTTP errors and empty answers retry the GET after retryMs', () => {
  let r = autoStart(JOB, initialState(), 0);
  r = autoEvent(r.auto, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'), 0);
  r = autoEvent(r.auto, ev('http error: connection refused'), 1000);
  assert.equal(r.auto.phase, 'waiting');
  assert.deepEqual(autoTick(r.auto, 1000 + AUTO_DEFAULTS.retryMs - 1).send, []);
  r = autoTick(r.auto, 1000 + AUTO_DEFAULTS.retryMs);
  assert.deepEqual(r.send, ['G']);
  assert.equal(r.auto.tries, 2);
  r = autoEvent(r.auto, ev('http 200, 0 bytes'), 5000);
  r = autoEvent(r.auto, ev('got: (empty body)'), 5000);
  assert.equal(r.auto.phase, 'waiting');
  assert.equal(r.auto.error, 'empty answer');
  assert.match(autoText(r.auto, 5000), /empty answer; retry in 3 s/);
});

test('auto: "wifi not connected" and a failed join retry the join', () => {
  let r = autoStart(JOB, initialState(), 0);
  r = autoEvent(r.auto, ev('wifi: failed, wrong password?'), 1000);
  assert.equal(r.auto.next, 'join');
  r = autoTick(r.auto, 1000 + AUTO_DEFAULTS.retryMs);
  assert.deepEqual(r.send, ['U http://192.168.4.1/', 'M UR_Field 12345678']);
  r = autoEvent(r.auto, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'), 5000);
  r = autoEvent(r.auto, ev('http error: wifi not connected (send M first)'), 5100);
  r = autoTick(r.auto, 5100 + AUTO_DEFAULTS.retryMs);
  assert.equal(r.send.at(-1), 'M UR_Field 12345678');
});

test('auto: lost Wi-Fi waits for the firmware to reconnect, then GETs', () => {
  let r = autoStart(JOB, initialState(), 0);
  r = autoEvent(r.auto, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'), 0);
  r = autoEvent(r.auto, ev('wifi: connection lost, reconnecting'), 500);
  assert.equal(r.auto.next, 'connect');
  r = autoEvent(r.auto, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'), 2000);
  assert.deepEqual(r.send, ['G']);
});

test('auto: no answer at all -> timeouts retry; gives up after maxMs', () => {
  let r = autoStart(JOB, initialState(), 0);
  r = autoTick(r.auto, AUTO_DEFAULTS.joinTimeoutMs);
  assert.equal(r.auto.phase, 'waiting');
  r = autoTick(r.auto, AUTO_DEFAULTS.joinTimeoutMs);
  assert.equal(r.send.at(-1), 'M UR_Field 12345678');
  r = autoTick(r.auto, AUTO_DEFAULTS.maxMs + 1);
  assert.equal(r.auto.phase, 'failed');
  assert.match(r.auto.error, /gave up after 120 s: no answer from the Wi-Fi join/);
  assert.deepEqual(autoTick(r.auto, AUTO_DEFAULTS.maxMs + 5000).send, []);
});

test('auto keep: GET again every periodMs, never gives up after the first text', () => {
  let r = autoStart(JOB, initialState(), 0, { keep: true });
  r = autoEvent(r.auto, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'), 0);
  r = autoEvent(r.auto, ev('got: hello'), 100);
  assert.equal(r.auto.phase, 'waiting');
  assert.match(autoText(r.auto, 100), /next GET in 10 s/);
  r = autoTick(r.auto, 100 + AUTO_DEFAULTS.periodMs);
  assert.deepEqual(r.send, ['G']);
  r = autoTick(r.auto, AUTO_DEFAULTS.maxMs * 3); // getting timed out long ago: retry, not "failed"
  assert.equal(r.auto.phase, 'waiting');
  assert.equal(autoStop(r.auto).phase, 'off');
  assert.deepEqual(autoEvent(autoStop(r.auto), ev('got: x'), 0).send, []);
});

test('auto: events while off or for manual commands change nothing', () => {
  const a = autoInitial();
  assert.equal(autoEvent(a, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'), 0).auto, a);
  assert.equal(autoTick(a, 1e9).auto, a);
  assert.equal(autoText(a, 0), '');
});

// ---- history ----------------------------------------------------------------------

test('history: newest first, lines appended to the newest answer, capped, persisted', () => {
  let h = historyAdd([], { at: 1, url: 'http://a/', status: 200 });
  h = historyAppend(h, 'line 1');
  h = historyAppend(h, 'line 2');
  h = historyAdd(h, { at: 2, url: 'http://a/', status: 'error', lines: ['HTTP error: refused'] });
  assert.deepEqual(historyAppend(h, 'x'), h); // never into an error entry
  assert.deepEqual(h.map((e) => e.lines), [['HTTP error: refused'], ['line 1', 'line 2']]);
  for (let i = 0; i < 60; i++) h = historyAdd(h, { at: 10 + i, url: 'u', status: 200 });
  assert.equal(h.length, HISTORY_MAX);
  const st = memoryStorage();
  assert.equal(saveHistory(st, h), true);
  assert.deepEqual(loadHistory(st), h);
  st.setItem('rov.m1.history.v1', JSON.stringify([{ at: 'x' }, ...h.slice(0, 2), 5]));
  assert.equal(loadHistory(st).length, 2);
  st.setItem('rov.m1.history.v1', '{broken');
  assert.deepEqual(loadHistory(st), []);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadHistory(throwing), []);
  assert.equal(saveHistory(throwing, h), false);
});

test('last good text stays up while refetching and after a failed refetch', () => {
  let s = initialState();
  for (const t of ['get: u', 'http 200, 9 bytes', 'got: one', 'got: two']) s = reduce(s, ev(t));
  s = reduce(s, ev('get: u'));
  assert.equal(bigText(s), 'one\ntwo');
  assert.equal(statusNote(s), 'Fetching again...');
  s = reduce(s, ev('http error: connection refused'));
  assert.equal(bigText(s), 'one\ntwo');
  assert.match(statusNote(s), /Last fetch failed \(HTTP error: connection refused\)/);
  for (const t of ['get: u', 'http 200, 3 bytes', 'got: new']) s = reduce(s, ev(t));
  assert.equal(bigText(s), 'new'); // a new text replaces the old one completely
  assert.equal(statusNote(s), '');
  const kept = keepAcrossReset(s);
  assert.equal(kept.wifi, 'idle');
  assert.deepEqual(kept.lastGood, ['new']);
  assert.equal(bigText(kept), 'new');
});

test('auto: an ESP32 restart re-joins after rebootWaitMs, not after the reconnect wait', () => {
  let r = autoStart(JOB, initialState(), 0);
  r = autoEvent(r.auto, ev('wifi: connected, ip 1.2.3.4, rssi -50 dBm'), 0);
  r = autoEvent(r.auto, { type: 'reboot' }, 1000);
  assert.equal(r.auto.next, 'join');
  assert.equal(r.auto.until, 1000 + AUTO_DEFAULTS.rebootWaitMs);
  assert.equal(autoTick(r.auto, 1000 + AUTO_DEFAULTS.rebootWaitMs).send.at(-1), 'M UR_Field 12345678');
});
