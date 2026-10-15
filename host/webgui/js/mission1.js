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
  return null;
}

export function initialState() {
  return {
    wifi: 'idle', // idle | connecting | searching | connected | failed
    wifiText: 'not connected',
    ip: null,
    getting: false,
    received: [], // text lines of the last GET
    notes: [],    // "(cut at ...)" etc.
    error: null,  // last HTTP error text
    httpStatus: null,
  };
}

export function reduce(state, ev) {
  if (!ev) return state;
  const s = { ...state };
  switch (ev.type) {
    case 'connecting':
      s.wifi = 'connecting'; s.wifiText = `connecting to ${ev.ssid}...`; s.ip = null; break;
    case 'searching':
      s.wifi = 'searching'; s.wifiText = ev.text.replace(/^wifi: /, ''); break;
    case 'connected':
      s.wifi = 'connected'; s.ip = ev.ip; s.wifiText = `connected, ip ${ev.ip}, ${ev.rssi} dBm`; break;
    case 'wifi-failed':
      s.wifi = 'failed'; s.wifiText = ev.text.replace(/^wifi: /, ''); s.ip = null; break;
    case 'lost':
      s.wifi = 'connecting'; s.wifiText = 'connection lost, reconnecting...'; s.ip = null; break;
    case 'get':
      s.getting = true; s.received = []; s.notes = []; s.error = null; s.httpStatus = null; break;
    case 'http-ok':
      s.getting = false; s.httpStatus = ev.status; break;
    case 'got':
      s.received = [...s.received, ev.text]; break;
    case 'note':
      s.notes = [...s.notes, ev.text]; break;
    case 'http-error':
      s.getting = false; s.error = ev.text; break;
    default:
      return state;
  }
  return s;
}

// What to show big for the referee.
export function bigText(state) {
  if (state.getting) return '...';
  if (state.received.length) return state.received.join('\n');
  if (state.error) return state.error;
  return '—';
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
