export class WsTransport {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.lineHandlers = [];
    this.statusHandlers = [];
  }

  onLine(handler)   { this.lineHandlers.push(handler); }
  onStatus(handler) { this.statusHandlers.push(handler); }

  _emitLine(line)   { for (const h of this.lineHandlers) h(line); }
  _emitStatus(s)    { for (const h of this.statusHandlers) h(s); }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        reject(e);
        return;
      }

      let opened = false;
      this._emitStatus("connecting");
      this.ws.onopen = () => {
        opened = true;
        this.connected = true;
        this._emitStatus("connected");
        resolve();
      };

      this.ws.onclose = () => {
        this.connected = false;
        this._emitStatus("disconnected");
        if (!opened) reject(new Error(`cannot reach ${this.url} - is the bridge running?`));
      };

      this.ws.onerror = () => {
        this._emitStatus("error");
        // Do not reject if already resolved; onclose will fire.
      };

      this.ws.onmessage = (event) => {
        const text = typeof event.data === "string"
          ? event.data
          : "";
        for (const raw of text.split("\n")) {
          const line = raw.trim();
          if (line) this._emitLine(line);
        }
      };
    });
  }

  send(line) {
    if (!this.connected || !this.ws) return;
    this.ws.send(line + "\n");
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected() { return this.connected; }
}