// Vision WebSocket protocol (docs/PROTOCOL.md, "Vision WebSocket (:8766)"). Pure, unit-tested.
//
// Browser -> bridge: one binary message per frame
//   uint32 big-endian N | N bytes of UTF-8 JSON header | JPEG bytes
// Bridge -> browser: text JSON (hello / result / error / pong).

export const VISION_VERSION = 1;
export const VISION_MODES = ['tags', 'line', 'colors'];
export const MAX_HEADER_BYTES = 4096;
export const MAX_JPEG_BYTES = 4_000_000;

const encoder = new TextEncoder();

// header: {id, mode, params}; jpeg: Uint8Array (or ArrayBuffer). Throws if a limit is broken,
// so a bad frame is caught here instead of coming back as an error from the bridge.
export function packFrame(header, jpeg) {
  const head = encoder.encode(JSON.stringify(header));
  if (head.length < 1 || head.length > MAX_HEADER_BYTES) {
    throw new Error(`vision header is ${head.length} bytes (max ${MAX_HEADER_BYTES})`);
  }
  let body = jpeg;
  if (jpeg instanceof ArrayBuffer) body = new Uint8Array(jpeg);
  if (!(body instanceof Uint8Array)) throw new Error('JPEG must be a Uint8Array');
  if (body.length < 1 || body.length > MAX_JPEG_BYTES) {
    throw new Error(`JPEG is ${body.length} bytes (1 .. ${MAX_JPEG_BYTES})`);
  }
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length, false);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Text from the bridge -> message object, or null for anything we do not understand.
// Fields the drawing code relies on are normalised (arrays are arrays, line is an object or null).
export function parseVisionMessage(text) {
  if (typeof text !== 'string') return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(msg)) return null;
  switch (msg.type) {
    case 'pong':
      return { type: 'pong' };
    case 'hello':
      return {
        ...msg,
        available: msg.available === true,
        modes: Array.isArray(msg.modes) ? msg.modes.filter((m) => typeof m === 'string') : [],
        reason: typeof msg.reason === 'string' ? msg.reason : '',
      };
    case 'error':
      return { ...msg, id: isNum(msg.id) ? msg.id : null, text: String(msg.text ?? 'unknown error') };
    case 'result': {
      if (!isNum(msg.id) || !isNum(msg.w) || !isNum(msg.h) || typeof msg.mode !== 'string') return null;
      if (msg.w <= 0 || msg.h <= 0) return null;
      const out = { ...msg, ms: isNum(msg.ms) ? msg.ms : null };
      if (msg.mode === 'tags') {
        out.tags = Array.isArray(msg.tags) ? msg.tags.filter(isObj) : [];
        out.weak = Array.isArray(msg.weak) ? msg.weak.filter(isObj) : []; // seen, not trusted: display only
      }
      if (msg.mode === 'colors') out.blobs = Array.isArray(msg.blobs) ? msg.blobs.filter(isObj) : [];
      if (msg.mode === 'line') {
        out.line = isObj(msg.line) ? { ...msg.line, tapes: Array.isArray(msg.line.tapes) ? msg.line.tapes : [] } : null;
      }
      if (typeof out.mask !== 'string' || !out.mask.startsWith('data:image/')) delete out.mask;
      return out;
    }
    default:
      return null;
  }
}
