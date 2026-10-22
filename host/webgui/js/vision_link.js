// WebSocket client to the vision service in the bridge (docs/PROTOCOL.md, "Vision WebSocket (:8766)").
//
// At most one frame in flight: the next frame is captured only after the answer (or a timeout), so
// frames never queue up and what the overlay shows is at most one round trip old. An answer that
// comes after its timeout is dropped (its slot was already given to a newer frame).

import { packFrame, parseVisionMessage } from './vision_proto.js';

const MAX_ID = 2 ** 31 - 1;
const RATE_WINDOW_MS = 1000;

export class VisionLink {
  // onResult(msg, meta): a result for the frame in flight; meta = what begin() got + capturedAt, sentAt.
  // onError(msg): an error from the service (or a frame that could not be packed).
  // onHello(msg), onOpen(), onClose(): connection events.
  // WebSocketImpl / now: injectable for tests.
  constructor({
    url, timeoutMs = 2000, retryMs = 1000, onResult, onError, onHello, onOpen, onClose,
    WebSocketImpl = globalThis.WebSocket, now = () => performance.now(),
  }) {
    Object.assign(this, { url, timeoutMs, retryMs, onResult, onError, onHello, onOpen, onClose, WebSocketImpl, now });
    this.ws = null;
    this.timer = null;
    this.stopped = true;
    this.hello = null;      // last hello message on this connection
    this.inFlight = null;   // {id, capturedAt, sentAt, ...meta}
    this.nextId = 1;
    this.lastMs = null;     // detector time of the last result (ms, from the service)
    this.rttMs = null;      // capture -> result in the browser (ms)
    this.resultTimes = [];
    this.timeouts = 0;
  }

  get isOpen() {
    return this.ws !== null && this.ws.readyState === 1; // WebSocket.OPEN
  }

  // null = not known yet (not connected or no hello yet)
  get available() {
    return this.isOpen && this.hello ? this.hello.available : null;
  }

  get reason() {
    return this.hello?.reason ?? '';
  }

  get ready() {
    return this.available === true;
  }

  get busy() {
    this.expire();
    return this.inFlight !== null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.reset();
    ws?.close();
  }

  connect() {
    if (this.stopped || this.ws) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws === ws) this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws && typeof ev.data === 'string') this.handle(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.reset();
      this.onClose?.();
      this.scheduleRetry();
    };
    ws.onerror = () => {}; // onclose follows and does the work
  }

  reset() {
    this.ws = null;
    this.hello = null;
    this.inFlight = null;
  }

  scheduleRetry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.retryMs);
  }

  // A frame that got no answer within timeoutMs frees the slot.
  expire(now = this.now()) {
    if (this.inFlight && now - this.inFlight.capturedAt > this.timeoutMs) {
      this.inFlight = null;
      this.timeouts++;
    }
  }

  // Reserves the slot before the (asynchronous) JPEG encoding. Returns the frame id, or null when
  // the service is not ready or a frame is still in flight. meta is handed back with the result.
  begin(meta = {}) {
    if (!this.ready || this.busy) return null;
    const id = this.nextId;
    this.nextId = id >= MAX_ID ? 0 : id + 1;
    this.inFlight = { ...meta, id, capturedAt: this.now(), sentAt: null };
    return id;
  }

  // Gives the slot back without sending (encoding failed, mission changed meanwhile).
  cancel(id) {
    if (this.inFlight?.id === id) this.inFlight = null;
  }

  // Sends the frame reserved with begin(). header: {mode, params}. false if the slot timed out,
  // the socket closed meanwhile, or the frame breaks a protocol limit.
  send(id, header, jpeg) {
    this.expire();
    if (this.inFlight?.id !== id || !this.isOpen) {
      this.cancel(id);
      return false;
    }
    let data;
    try {
      data = packFrame({ id, mode: header.mode, params: header.params ?? {} }, jpeg);
    } catch (e) {
      this.cancel(id);
      this.onError?.({ type: 'error', id, text: e.message, local: true });
      return false;
    }
    try {
      this.ws.send(data);
    } catch {
      this.cancel(id);
      return false;
    }
    this.inFlight.sentAt = this.now();
    return true;
  }

  handle(text) {
    const msg = parseVisionMessage(text);
    if (!msg) return;
    if (msg.type === 'hello') {
      this.hello = msg;
      this.onHello?.(msg);
    } else if (msg.type === 'result') {
      const meta = this.inFlight;
      if (!meta || meta.id !== msg.id) return; // late answer for a frame that already timed out
      this.inFlight = null;
      const now = this.now();
      this.lastMs = msg.ms;
      this.rttMs = now - meta.capturedAt;
      this.resultTimes.push(now);
      this.trimRate(now);
      this.onResult?.(msg, meta);
    } else if (msg.type === 'error') {
      // Answers come strictly in order: an error without an id (bad header) also answers the frame
      // in flight.
      if (this.inFlight && (msg.id === null || msg.id === this.inFlight.id)) this.inFlight = null;
      this.onError?.(msg);
    }
  }

  trimRate(now) {
    while (this.resultTimes.length && now - this.resultTimes[0] > RATE_WINDOW_MS) this.resultTimes.shift();
  }

  // Results received during the last second.
  resultsPerSec(now = this.now()) {
    this.trimRate(now);
    return this.resultTimes.length;
  }
}
