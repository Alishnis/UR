// Video sources for the camera panel: a USB / built-in camera (getUserMedia) or the practice
// simulator (a canvas drawn by testscene.js, turned into a stream with captureStream). Either way the
// picture ends up in the same <video>, so the overlay and the detector do not care which it is.

// getUserMedia / captureStream error -> a sentence the pilot can act on.
export function cameraErrorText(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission denied: allow it in the address bar';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Camera not found: is it plugged in? Pick another source';
    case 'NotReadableError':
    case 'AbortError':
      return 'Camera busy (another app?): close it and press Start again';
    default:
      return `Camera error: ${e?.message || e?.name || String(e)}`;
  }
}

export class CameraSource {
  // video: the <video> element; onEnded(): the source stopped by itself (camera unplugged).
  constructor(video, { onEnded } = {}) {
    this.video = video;
    this.onEnded = onEnded;
    this.stream = null;
    this.kind = null;      // 'camera' | 'test' | null
    this.deviceId = null;
    this.timer = null;
    this.gen = 0;          // a newer start/stop wins over a start still waiting for permission
  }

  get running() {
    return this.stream !== null;
  }

  // Cameras. Labels (and sometimes ids) stay empty until camera access was allowed once.
  async listDevices() {
    try {
      const all = await navigator.mediaDevices?.enumerateDevices?.();
      return (all ?? []).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  // Resolves to the stream, or null if stop() / another start came first. Throws an Error with a
  // friendly message.
  async startCamera(deviceId, { width = 1280, height = 720 } = {}) {
    this.stop();
    const gen = this.gen;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('No camera access on this page: open it as http://localhost:... (not a file or LAN address)');
    }
    const video = { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      throw new Error(cameraErrorText(e));
    }
    if (gen !== this.gen) {
      for (const t of stream.getTracks()) t.stop();
      return null;
    }
    this.kind = 'camera';
    this.deviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? deviceId ?? null;
    await this.attach(stream);
    return stream;
  }

  // drawFn(ctx, dtSeconds) paints one frame; it is called fps times a second.
  startTestScene(drawFn, { width = 1280, height = 720, fps = 30 } = {}) {
    this.stop();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (typeof canvas.captureStream !== 'function') {
      throw new Error('This browser cannot stream a canvas (captureStream): use Chrome for the test scene');
    }
    const ctx = canvas.getContext('2d', { alpha: false });
    let last = performance.now();
    let failed = false;
    const frame = () => {
      const now = performance.now();
      try {
        drawFn(ctx, (now - last) / 1000);
      } catch (e) {
        if (!failed) console.error('test scene', e); // once, not 30 times a second
        failed = true;
      }
      last = now;
    };
    frame();
    const stream = canvas.captureStream(fps);
    this.timer = setInterval(frame, 1000 / fps);
    this.kind = 'test';
    this.canvas = canvas; // keeps the canvas alive while it is streamed
    this.attach(stream);
    return stream;
  }

  async attach(stream) {
    this.stream = stream;
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.stop();
        this.onEnded?.();
      });
    }
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {
      // muted + playsinline autoplays; an AbortError here only means the source changed meanwhile
    }
  }

  stop() {
    this.gen++;
    clearInterval(this.timer);
    this.timer = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.kind = null;
    this.canvas = null;
    this.video.srcObject = null;
  }
}
