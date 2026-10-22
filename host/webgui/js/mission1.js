// Mission 1 panel logic: field validation, `N ...` line parsing, state. Pure, unit-tested.
// The `N` texts are the firmware's (src/mission1.cpp, docs/PROTOCOL.md).

export const LIMITS = { ssid: 32, password: 63, line: 160 };

const PRINTABLE = /^[\x20-\x7E]*$/;
const STORAGE_KEY = 'rov.mission1.v1';

// -> error text, or null if the field is fine. Mirrors what the firmware accepts.
export function validateSsid(ssid) {
  if (!ssid) return 'SSID is empty';
  if (/\s/.test(ssid)) return 'SSID must not contain spaces (the protocol cannot send them)';
  if (!PRINTABLE.test(ssid)) return 'SSID may contain only plain ASCII characters';
  if (ssid.length > LIMITS.ssid) return `SSID is longer than ${LIMITS.ssid} characters`;
  return null;
}

export function validatePassword(password) {
  if (!PRINTABLE.test(password)) return 'password may contain only plain ASCII characters';
  if (password.length > LIMITS.password) return `password is longer than ${LIMITS.password} characters`;
  if (password.length > 0 && password.length < 8) return 'a WPA2 password has 8-63 characters (empty = open network)';
  return null;
}

export function validateUrl(url) {
  if (!url) return 'URL is empty';
  if (!/^https?:\/\//.test(url)) return 'URL must start with http:// (or https://)';
  if (!PRINTABLE.test(url) || /\s/.test(url)) return 'URL must not contain spaces or special characters';
  if (url.length + 2 > LIMITS.line) return `URL is too long (max ${LIMITS.line - 2} characters)`;
  return null;
}

export const wifiLine = (ssid, password) => (password ? `M ${ssid} ${password}` : `M ${ssid}`);
export const urlLine = (url) => `U ${url}`;
export const SCAN_LINE = 'L';

// Text after "N " -> event, or null if it is not a Mission 1 message.
const NOTE = /^\((empty body|\d+ more lines not shown|cut at \d+ bytes)\)$/;
export function parseNLine(text) {
  let m;
  if ((m = /^wifi: connecting to (.*)$/.exec(text))) return { type: 'connecting', ssid: m[1] };
  if ((m = /^wifi: connected, ip (\S+), rssi (-?\d+) dBm$/.exec(text))) {
    return { type: 'connected', ip: m[1], rssi: Number(m[2]) };
  }
  if (/^wifi: SSID ".*" not found/.test(text)) return { type: 'searching', text };
  if (/^wifi: (failed|timeout)/.test(text)) return { type: 'wifi-failed', text };
  if (/^wifi: connection lost/.test(text)) return { type: 'lost', text };
  if ((m = /^url set: (.*)$/.exec(text))) return { type: 'url', url: m[1] };
  if ((m = /^get: (.*)$/.exec(text))) return { type: 'get', url: m[1] };
  if ((m = /^http (\d+), (\d+) bytes$/.exec(text))) {
    return { type: 'http-ok', status: Number(m[1]), bytes: Number(m[2]) };
  }
  if ((m = /^got: (.*)$/.exec(text))) {
    return NOTE.test(m[1]) ? { type: 'note', text: m[1] } : { type: 'got', text: m[1] };
  }
  if ((m = /^http error(.*)$/.exec(text))) {
    return { type: 'http-error', text: `HTTP error${m[1]}`.replace(/:$/, '') };
  }
  if (text === 'scan: started') return { type: 'scan-start' };
  if ((m = /^scan: (\d+) networks$/.exec(text))) return { type: 'scan-done', total: Number(m[1]) };
  if ((m = /^scan: \((\d+) more not shown\)$/.exec(text))) return { type: 'scan-more', more: Number(m[1]) };
  if ((m = /^scan: (.*)$/.exec(text))) return { type: 'scan-note', text: m[1] }; // failed / busy / cancelled
  if ((m = /^net: (-?\d+) dBm ch (\d+) (open|secured) (.*)$/.exec(text))) {
    return { type: 'net', rssi: Number(m[1]), ch: Number(m[2]), open: m[3] === 'open', ssid: m[4] };
  }
  return null;
}

export function initialState() {
  return {
    wifi: 'idle', // idle | connecting | searching | connected | failed
    wifiText: 'not connected',
    ip: null,
    ssid: null,   // network of the last join
    rssi: null,
    getting: false,
    received: [], // text lines of the last GET
    lastGood: [], // text of the last GET that brought any: kept over refetches and errors
    collecting: false,
    notes: [],    // "(cut at ...)" etc.
    error: null,  // last HTTP error text
    httpStatus: null,
    bytes: null,
    // Wi-Fi scan (L): networks strongest first, as the firmware sends them
    scan: { running: false, nets: [], total: null, more: 0, note: null },
  };
}

export function reduce(state, ev) {
  if (!ev) return state;
  const s = { ...state };
  switch (ev.type) {
    case 'connecting':
      s.wifi = 'connecting'; s.wifiText = `connecting to ${ev.ssid}...`; s.ip = null; s.ssid = ev.ssid; s.rssi = null;
      break;
    case 'searching':
      s.wifi = 'searching'; s.wifiText = ev.text.replace(/^wifi: /, ''); break;
    case 'connected':
      s.wifi = 'connected'; s.ip = ev.ip; s.rssi = ev.rssi; s.wifiText = `connected, ip ${ev.ip}, ${ev.rssi} dBm`;
      break;
    case 'wifi-failed':
      s.wifi = 'failed'; s.wifiText = ev.text.replace(/^wifi: /, ''); s.ip = null; break;
    case 'lost':
      s.wifi = 'connecting'; s.wifiText = 'connection lost, reconnecting...'; s.ip = null; break;
    case 'get':
      s.getting = true; s.received = []; s.notes = []; s.error = null; s.httpStatus = null; s.bytes = null;
      s.collecting = true;
      break;
    case 'http-ok':
      s.getting = false; s.httpStatus = ev.status; s.bytes = ev.bytes; break;
    case 'got':
      s.received = [...s.received, ev.text];
      s.lastGood = s.collecting ? [ev.text] : [...s.lastGood, ev.text];
      s.collecting = false;
      break;
    case 'note':
      s.notes = [...s.notes, ev.text]; break;
    case 'http-error':
      s.getting = false; s.error = ev.text; break;
    case 'scan-start':
      s.scan = { running: true, nets: [], total: null, more: 0, note: null }; break;
    case 'scan-done':
      s.scan = { ...s.scan, running: false, total: ev.total }; break;
    case 'net':
      s.scan = { ...s.scan, nets: [...s.scan.nets, { rssi: ev.rssi, ch: ev.ch, open: ev.open, ssid: ev.ssid }] };
      break;
    case 'scan-more':
      s.scan = { ...s.scan, more: ev.more }; break;
    case 'scan-note':
      // "already running" keeps the scan that is under way; failed / busy / cancelled end it
      s.scan = { ...s.scan, running: s.scan.running && /already running/.test(ev.text), note: ev.text }; break;
    default:
      return state;
  }
  return s;
}

// What to show big for the referee.
// While refetching, or after a refetch failed, the last good text stays up (the referee may be
// reading it); the error then shows in the notes, see statusNote().
export function bigText(state) {
  if (state.received.length) return state.received.join('\n');
  if (state.lastGood.length) return state.lastGood.join('\n');
  if (state.getting) return '...';
  if (state.error) return state.error;
  return '—';
}

export function statusNote(state) {
  if (state.received.length || !state.lastGood.length) return '';
  if (state.getting) return 'Fetching again...';
  if (state.error) return `Last fetch failed (${state.error}); showing the previous text.`;
  return '';
}

// What survives a new join or an ESP32 restart: the scan list and the last good text.
export function keepAcrossReset(state) {
  return { ...initialState(), scan: state.scan, lastGood: state.lastGood };
}

// Fields remembered between visits (this browser only). The Wi-Fi password is a shared
// competition credential, not a personal one.
export function loadFields(storage, defaults) {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const pick = (k) => (typeof raw[k] === 'string' ? raw[k] : defaults[k]);
      return { ssid: pick('ssid'), password: pick('password'), url: pick('url') };
    }
  } catch {
    // blocked storage or broken JSON: use the defaults
  }
  return { ...defaults };
}

export function saveFields(storage, fields) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(fields));
    return true;
  } catch {
    return false;
  }
}

// ---------- Wi-Fi scan helpers ----------

// 0..4 bars from RSSI (dBm), for the scan list.
export function signalBars(rssi) {
  if (!Number.isFinite(rssi)) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}

// Advice once a scan finished: is the SSID typed in the panel among the networks the ESP32 sees?
export function scanAdvice(scan, ssid) {
  if (scan.running || scan.total === null) return null;
  if (!ssid) return { kind: 'warn', text: 'Pick the tower in the list (click it) or type its SSID.' };
  const hit = scan.nets.find((n) => n.ssid === ssid);
  if (hit) {
    const weak = signalBars(hit.rssi) <= 1 ? ' Weak signal: bring the ROV closer to the tower.' : '';
    return { kind: weak ? 'warn' : 'ok', text: `${ssid} seen at ${hit.rssi} dBm, channel ${hit.ch}.${weak}` };
  }
  const near = scan.nets.find((n) => n.ssid.toLowerCase() === ssid.toLowerCase());
  if (near) return { kind: 'bad', text: `Not "${ssid}" but "${near.ssid}": SSIDs are case-sensitive.` };
  return {
    kind: 'bad',
    text: `${ssid} not seen${scan.more ? ' among the strongest networks' : ''}: check the spelling, move closer, `
      + 'or the tower is 5 GHz (the ESP32 hears 2.4 GHz only).',
  };
}

// ---------- automatic run: Connect -> wait for Wi-Fi -> GET, retrying until text arrives ----------
//
// Pure state machine. The caller feeds it parsed N events (autoEvent) and the clock (autoTick)
// and sends the lines it returns. keep: after the first text, GET again every periodMs (the tower
// repeats its string; a new one shows up by itself).

export const AUTO_DEFAULTS = {
  joinTimeoutMs: 25000, // the firmware gives up after 15 s and says so; this is the backstop
  getTimeoutMs: 20000,  // firmware worst case: 5 s connect + 5 s answer + 5 s body
  retryMs: 3000,
  maxMs: 120000,        // give up (until the first text) after this long
  periodMs: 10000,      // keep mode
  rebootWaitMs: 5000,   // the firmware drops input for 4 s after a restart
};

export function autoInitial() {
  return { phase: 'off', startMs: 0, until: 0, next: null, tries: 0, error: null, keep: false, gotAt: null, job: null };
}

export const autoActive = (a) => a.phase === 'joining' || a.phase === 'getting' || a.phase === 'waiting';

const cfgOf = (cfg) => ({ ...AUTO_DEFAULTS, ...cfg });

function sendGet(a, now, cfg) {
  return { auto: { ...a, phase: 'getting', until: now + cfg.getTimeoutMs, tries: a.tries + 1, next: null }, send: ['G'] };
}

function sendJoin(a, now, cfg) {
  const { ssid, password, url } = a.job;
  return {
    auto: { ...a, phase: 'joining', until: now + cfg.joinTimeoutMs, next: null },
    send: [urlLine(url), wifiLine(ssid, password)],
  };
}

function retry(a, now, cfg, next, error, delay = cfg.retryMs) {
  return { auto: { ...a, phase: 'waiting', until: now + delay, next, error: error ?? a.error }, send: [] };
}

// job: {ssid, password, url} (validated by the caller); wifi: the panel state (reduce()).
export function autoStart(job, wifi, now, { keep = false, ...cfg } = {}) {
  const c = cfgOf(cfg);
  const a = { ...autoInitial(), startMs: now, keep, job: { ...job } };
  if (wifi.wifi === 'connected' && wifi.ssid === job.ssid) {
    const r = sendGet(a, now, c);
    return { auto: r.auto, send: [urlLine(job.url), ...r.send] };
  }
  return sendJoin(a, now, c);
}

export function autoStop(a) {
  return { ...a, phase: 'off', next: null };
}

export function autoEvent(a, ev, now, cfg = {}) {
  const c = cfgOf(cfg);
  if (!ev || !autoActive(a)) return { auto: a, send: [] };
  switch (ev.type) {
    case 'connected':
      if (a.phase === 'joining' || (a.phase === 'waiting' && a.next === 'connect')) return sendGet(a, now, c);
      return { auto: a, send: [] };
    case 'wifi-failed':
      if (a.phase === 'joining' || a.next === 'connect') return retry(a, now, c, 'join', ev.text.replace(/^wifi: /, ''));
      return { auto: a, send: [] };
    case 'lost':
      // the firmware reconnects by itself: wait for "connected", then GET
      return retry(a, now, c, 'connect', 'Wi-Fi connection lost', c.joinTimeoutMs);
    case 'reboot':
      // a restarted board forgot the network: join again once it accepts input (4 s arming)
      return retry(a, now, c, 'join', 'ESP32 restarted', c.rebootWaitMs);
    case 'got':
      if (a.phase !== 'getting') return { auto: a, send: [] };
      if (a.keep) return { auto: { ...a, phase: 'waiting', next: 'get', until: now + c.periodMs, gotAt: now, error: null }, send: [] };
      return { auto: { ...a, phase: 'done', next: null, gotAt: now, error: null }, send: [] };
    case 'note':
      if (a.phase === 'getting' && /empty body/.test(ev.text)) return retry(a, now, c, 'get', 'empty answer');
      return { auto: a, send: [] };
    case 'http-error':
      if (a.phase !== 'getting') return { auto: a, send: [] };
      if (/wifi not connected/.test(ev.text)) return retry(a, now, c, 'join', ev.text);
      return retry(a, now, c, 'get', ev.text);
    default:
      return { auto: a, send: [] };
  }
}

export function autoTick(a, now, cfg = {}) {
  const c = cfgOf(cfg);
  if (!autoActive(a)) return { auto: a, send: [] };
  if (a.gotAt === null && now - a.startMs > c.maxMs) {
    const why = a.error ? `: ${a.error}` : '';
    return { auto: { ...a, phase: 'failed', next: null, error: `gave up after ${Math.round(c.maxMs / 1000)} s${why}` }, send: [] };
  }
  if (now < a.until) return { auto: a, send: [] };
  if (a.phase === 'joining') return retry(a, now, c, 'join', 'no answer from the Wi-Fi join', 0);
  if (a.phase === 'getting') return retry(a, now, c, 'get', 'no answer to GET', 0);
  // waiting
  if (a.next === 'get') return sendGet(a, now, c);
  return sendJoin(a, now, c); // 'join', or 'connect' that never came back
}

// One line for the panel.
export function autoText(a, now) {
  const left = (t) => `${Math.max(0, Math.ceil((t - now) / 1000))} s`;
  switch (a.phase) {
    case 'joining': return `Auto: joining ${a.job?.ssid ?? ''}...`;
    case 'getting': return `Auto: GET (try ${a.tries})...`;
    case 'waiting':
      if (a.next === 'get' && a.gotAt !== null && !a.error) return `Auto: next GET in ${left(a.until)}`;
      if (a.next === 'connect') return 'Auto: Wi-Fi lost, waiting for it to reconnect...';
      return `Auto: ${a.error ?? 'retry'}; retry in ${left(a.until)}`;
    case 'done': return 'Auto: done, text received';
    case 'failed': return `Auto: ${a.error ?? 'failed'}`;
    default: return '';
  }
}

// ---------- history of answers (this browser) ----------

const HISTORY_KEY = 'rov.m1.history.v1';
export const HISTORY_MAX = 50;

// A GET finished with an answer (http-ok) or an error: new entry, newest first.
export function historyAdd(list, entry, max = HISTORY_MAX) {
  return [{ lines: [], ...entry }, ...list].slice(0, max);
}

// A "got:" line (or a note) of the newest answer.
export function historyAppend(list, text) {
  if (!list.length || list[0].status === 'error') return list;
  return [{ ...list[0], lines: [...list[0].lines, text] }, ...list.slice(1)];
}

const isEntry = (e) => e && typeof e === 'object' && Number.isFinite(e.at) && typeof e.url === 'string'
  && (Number.isInteger(e.status) || e.status === 'error') && Array.isArray(e.lines)
  && e.lines.every((l) => typeof l === 'string');

export function loadHistory(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(HISTORY_KEY) ?? 'null');
    if (Array.isArray(raw)) return raw.filter(isEntry).slice(0, HISTORY_MAX);
  } catch {
    // blocked storage or broken JSON: start empty
  }
  return [];
}

export function saveHistory(storage, list) {
  try {
    storage?.setItem(HISTORY_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
