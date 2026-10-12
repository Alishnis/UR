// Header status line: bridge, ESP32, camera, AprilTag service.
export class StatusPanel {
  constructor() {
    this.els = {
      bridge: document.getElementById("transport-status"),
      esp: document.getElementById("esp-status"),
      camera: document.getElementById("camera-status"),
      vision: document.getElementById("vision-status"),
    };
    this.cameraState = "off";
    this.fps = null;
  }

  _set(key, label, value, state) {
    this.els[key].textContent = `${label}: ${value}`;
    this.els[key].dataset.state = state;
  }

  setTransport(s) {
    this._set("bridge", "bridge", s, s === "connected" ? "ok" : s === "connecting" ? "warn" : "bad");
  }

  setEsp(alive, text = "") {
    this._set("esp", "esp32", alive ? (text || "alive") : "silent", alive ? "ok" : "bad");
  }

  setCamera(s) {
    this.cameraState = s;
    const value = s === "running" && this.fps !== null ? `running @ ${this.fps} fps` : s;
    this._set("camera", "camera", value, s === "running" ? "ok" : s === "off" ? "bad" : "warn");
  }

  setFps(fps) {
    this.fps = fps;
    if (this.cameraState === "running") this.setCamera("running");
  }

  setVision(s) {
    this._set("vision", "april-tag", s, s.startsWith("ok") ? "ok" : s === "connecting" ? "warn" : "bad");
  }
}
