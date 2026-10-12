// Left: the pilot's surge / yaw vector (scaled by the J / K throttle). Right: the three thruster commands
// actually sent (after MAX limit and ramp), the GPIO each one goes to (config outputSlot) and the pulse widths the
// ESP32 reports back (T lines, already in left / right / vert order).
export class ThrusterDisplay {
  constructor(canvasEl, config) {
    this.config = config;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.w = 0;
    this.h = 0;
  }

  _ensureSize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = rect.width;
      this.h = rect.height;
    }
  }

  update(input, output, maxThrottle, armed, telemetryUs) {
    this._ensureSize();
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const green = armed ? "#00e676" : "#666";

    // --- vector (left half)
    const cx = w * 0.27, cy = h / 2, r = Math.min(w * 0.22, h * 0.38);
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
    ctx.stroke();
    const len = Math.hypot(input.surge, input.yaw);
    if (len > 0) {
      const ex = cx + (input.yaw / len) * input.magnitude * r;
      const ey = cy - (input.surge / len) * input.magnitude * r;
      ctx.strokeStyle = green;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    } else {
      ctx.fillStyle = green;
      ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#888";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`throttle ${input.magnitude.toFixed(2)}`, 6, 6);
    ctx.fillText(`heave ${input.heave > 0 ? "UP" : input.heave < 0 ? "DOWN" : "-"}`, 6, h - 18);

    // --- thruster bars (right half), full bar height = MAX
    const names = [["L", "left"], ["R", "right"], ["V", "vert"]];
    const top = 34, bottom = h - 34, mid = (top + bottom) / 2, half = (bottom - top) / 2;
    names.forEach(([label, key], i) => {
      const x = w * 0.58 + i * w * 0.14, bw = w * 0.09;
      ctx.strokeStyle = "#333";
      ctx.strokeRect(x, top, bw, bottom - top);
      ctx.beginPath(); ctx.moveTo(x - 3, mid); ctx.lineTo(x + bw + 3, mid); ctx.stroke();
      const v = maxThrottle > 0 ? output[key] / maxThrottle : 0;
      ctx.fillStyle = green;
      ctx.fillRect(x + 1, mid, bw - 2, -v * half);
      ctx.fillStyle = "#aaa";
      ctx.textAlign = "center";
      ctx.fillText(label, x + bw / 2, 6);
      ctx.fillStyle = "#666";
      ctx.fillText(`io${this.config.slotPins[this.config.outputSlot[key]]}`, x + bw / 2, 19);
      ctx.fillStyle = "#aaa";
      ctx.fillText(telemetryUs ? String(telemetryUs[i]) : "----", x + bw / 2, h - 28);
    });
    ctx.textAlign = "right";
    ctx.fillStyle = "#777";
    ctx.fillText(`MAX ${maxThrottle.toFixed(2)}  us from ESP`, w - 4, h - 14);
  }
}
