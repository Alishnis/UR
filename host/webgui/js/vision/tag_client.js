// Talks to the AprilTag service in the bridge: sends JPEG frames (one at a time, the next only after the answer,
// so frames never pile up), and commands (rule / reset / undo / clahe / expected) as JSON.
export class TagClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.busy = false;
    this.handlers = { result: [], status: [] };
  }

  on(event, handler) { this.handlers[event].push(handler); }
  _emit(event, value) { for (const h of this.handlers[event]) h(value); }

  connect() {
    if (this.ws) return;
    this._emit("status", "connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this._emit("status", "connected");
    ws.onclose = () => {
      this.ws = null;
      this.busy = false;
      this._emit("status", "disconnected");
      setTimeout(() => this.connect(), 2000);  // the bridge may start after the page
    };
    ws.onmessage = (event) => {
      this.busy = false;
      try {
        this._emit("result", JSON.parse(event.data));
      } catch (e) {
        console.error("bad vision message", e);
      }
    };
    this.ws = ws;
  }

  isConnected() { return this.ws !== null && this.ws.readyState === WebSocket.OPEN; }

  canSendFrame() { return this.isConnected() && !this.busy; }

  async sendFrame(canvas, quality) {
    if (!this.canSendFrame()) return;
    this.busy = true;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || !this.isConnected()) {
      this.busy = false;
      return;
    }
    this.ws.send(await blob.arrayBuffer());
  }

  command(cmd, extra = {}) {
    if (this.isConnected()) this.ws.send(JSON.stringify({ cmd, ...extra }));
  }
}
