import { Config } from "../config.js";

// A frame source is either a camera (the USB ROV camera, the laptop camera, an iPhone) or a still test image
// (host/tags/sheet.png, to try Mission 2.1 without any camera). Both expose: element, width, height.

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.image = null;
  }

  async start(source = "") {
    this.stop();
    if (source.startsWith("image:")) {
      const img = new Image();
      img.src = source.slice(6);
      await img.decode();
      this.image = img;
      return;
    }
    const video = { width: { ideal: Config.cameraWidth }, height: { ideal: Config.cameraHeight } };
    if (source) video.deviceId = { exact: source };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.image = null;
  }

  // Camera names are only visible after the user allowed camera access once.
  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  isRunning() { return this.stream !== null || this.image !== null; }

  get element() { return this.image || this.video; }
  get width() { return this.image ? this.image.naturalWidth : this.video.videoWidth; }
  get height() { return this.image ? this.image.naturalHeight : this.video.videoHeight; }
}
