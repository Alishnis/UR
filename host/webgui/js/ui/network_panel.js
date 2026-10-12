import { Protocol } from "../protocol/protocol.js";

// Mission 1: the ESP32 itself joins the tower Wi-Fi and fetches the text (a laptop fetching it scores 0).
// The values are given only at the venue, so they are typed here, no reflashing.
const OUT_MAX_LINES = 30;

export class NetworkPanel {
  constructor(rootEl, transport) {
    this.transport = transport;
    this.connected = false;
    this.lines = [];
    this.el = {
      ssid: rootEl.querySelector("#wifi-input"),
      pass: rootEl.querySelector("#pass-input"),
      url: rootEl.querySelector("#url-input"),
      wifi: rootEl.querySelector("#network-send"),
      get: rootEl.querySelector("#network-get"),
      status: rootEl.querySelector("#network-status"),
      out: rootEl.querySelector("#network-output"),
      result: rootEl.querySelector("#mission1-result"),
    };
    this.el.wifi.addEventListener("click", () => this._sendWifi());
    this.el.pass.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._sendWifi(); } });
    this.el.get.addEventListener("click", () => this._get());
    this._updateEnabled();
    this._render();
  }

  setConnected(connected) {
    this.connected = connected;
    this._updateEnabled();
  }

  _updateEnabled() {
    for (const k of ["ssid", "pass", "url", "wifi", "get"]) this.el[k].disabled = !this.connected;
    this.el.status.textContent = this.connected ? "" : "not connected";
  }

  _sendWifi() {
    if (!this.connected) return;
    this.transport.send(Protocol.encodeWifi(this.el.ssid.value, this.el.pass.value));
    this.el.status.textContent = `sent wifi "${this.el.ssid.value.trim()}"`;
  }

  _get() {
    if (!this.connected) return;
    if (this.el.url.value.trim()) this.transport.send(Protocol.encodeUrl(this.el.url.value));
    this.transport.send(Protocol.encodeGet());
    this.el.status.textContent = "GET sent";
  }

  push(text) {
    if (text.startsWith("got: ")) this.el.result.textContent = text.slice(5);  // the string for the referee
    this.lines.push({ stamp: new Date().toLocaleTimeString(), text });
    if (this.lines.length > OUT_MAX_LINES) this.lines.splice(0, this.lines.length - OUT_MAX_LINES);
    this._render();
  }

  _render() {
    if (!this.lines.length) {
      this.el.out.textContent = "no messages";
      this.el.out.dataset.state = "empty";
      return;
    }
    this.el.out.dataset.state = "active";
    this.el.out.textContent = this.lines.map((l) => `[${l.stamp}] ${l.text}`).join("\n");
    this.el.out.scrollTop = this.el.out.scrollHeight;
  }
}
