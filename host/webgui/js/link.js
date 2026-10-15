// WebSocket client to the bridge: one text line per message, auto-reconnect.

export class BridgeLink {
  constructor({ url, onLine, onOpen, onClose, retryMs = 1000 }) {
    this.url = url;
    this.onLine = onLine;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.retryMs = retryMs;
    this.ws = null;
    this.timer = null;
    this.stopped = false;
  }

  get isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.ws) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.onOpen?.();
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.onLine(ev.data);
    };
    ws.onclose = () => {
      const wasCurrent = this.ws === ws;
      if (wasCurrent) this.ws = null;
      this.onClose?.();
      this.scheduleRetry();
    };
    ws.onerror = () => {}; // onclose follows and does the work
  }

  scheduleRetry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.retryMs);
  }

  // Returns false (and sends nothing) if the socket is not open.
  send(line) {
    if (!this.isOpen) return false;
    this.ws.send(line);
    return true;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
  }
}
