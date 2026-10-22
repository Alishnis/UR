// Drawing on the camera view: detections, guidance and the HUD. Touches nothing but the 2D context
// it is given, so the geometry helpers are unit-tested (tests/overlay.test.js).
//
// Three coordinate systems:
//   frame   pixels of the JPEG that was sent to the detector (results come back in these)
//   css     CSS pixels of the overlay canvas; the video sits inside it with object-fit: contain,
//           so there may be black bars left/right or top/bottom (letterbox)
//   device  canvas pixels = css * devicePixelRatio (what the 2D context draws in)

import { colorCss } from './colors.js';

// Same colours as the CSS variables in style.css (a canvas cannot read var(--x) directly).
export const INK = {
  ok: '#3ecf8e', warn: '#f5b942', bad: '#ff5d5d', accent: '#4aa3ff', text: '#e6ebf0', dim: '#8b97a5',
  cyan: '#22d3ee', backing: 'rgba(8, 11, 15, 0.78)', shadow: 'rgba(0, 0, 0, 0.75)',
};
export const KIND_INK = { ok: INK.ok, warn: INK.warn, bad: INK.bad, idle: INK.text, dim: INK.dim };
// kind: ok | warn | bad | idle | dim, or a '#rrggbb' colour
export const kindInk = (kind) => KIND_INK[kind] ?? (/^#[0-9a-f]{6}$/i.test(kind) ? kind : INK.text);

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isPt = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

// ---------- geometry (pure) ----------

// Where a srcW x srcH picture lands inside a boxW x boxH box with object-fit: contain.
// Without a picture size the whole box is returned.
export function fitRect(srcW, srcH, boxW, boxH) {
  const bw = Math.max(0, Number(boxW) || 0), bh = Math.max(0, Number(boxH) || 0);
  if (!(srcW > 0 && srcH > 0 && bw > 0 && bh > 0)) return { x: 0, y: 0, w: bw, h: bh };
  const s = Math.min(bw / srcW, bh / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

// Everything the drawing functions need: the video rectangle in css and device pixels and a size
// unit k (device pixels per "design pixel": text and lines grow with the stage, within limits).
export function makeView({ cssW, cssH, dpr = 1, videoW = 0, videoH = 0 }) {
  const w = Math.max(0, Number(cssW) || 0), h = Math.max(0, Number(cssH) || 0);
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const css = fitRect(videoW, videoH, w, h);
  const hasVideo = videoW > 0 && videoH > 0;
  const k = d * clamp(Math.min(css.w / 960, css.h / 540) || 1, 0.62, 1.6);
  return {
    dpr: d, cssW: w, cssH: h, W: Math.round(w * d), H: Math.round(h * d), k, hasVideo, css,
    rect: { x: css.x * d, y: css.y * d, w: css.w * d, h: css.h * d },
  };
}

// frame pixel -> device pixel. The JPEG is a scaled copy of the whole video frame, so only the
// frame size (fw x fh) is needed.
export function frameMapper(view, fw, fh) {
  const sx = fw > 0 ? view.rect.w / fw : 0, sy = fh > 0 ? view.rect.h / fh : 0;
  return ([x, y]) => [view.rect.x + x * sx, view.rect.y + y * sy];
}

// Picture position [u, v] (0..1) -> device pixel.
export const pictureToDevice = (view, [u, v]) => [view.rect.x + u * view.rect.w, view.rect.y + v * view.rect.h];

// Pointer position in css pixels of the canvas -> [u, v] 0..1 of the picture, or null on the black
// bars / without a picture.
export function cssToPicture(view, x, y) {
  const r = view.css;
  if (!view.hasVideo || !(r.w > 0) || !(r.h > 0)) return null;
  const u = (x - r.x) / r.w, v = (y - r.y) / r.h;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
}

// ---------- primitives ----------

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Text on a rounded dark backing, readable over any picture. (x, y) is the anchor of the box:
// align left|center|right, valign top|middle|bottom; o.within: a rect the box is kept inside
// horizontally (a tag at the picture edge must not get a half-hidden label). Returns the box.
export function labelSize(ctx, text, o = {}) {
  const size = o.size ?? 16;
  const pad = o.pad ?? size * 0.45;
  ctx.font = `${o.weight ?? 700} ${size}px ${o.mono ? MONO : FONT}`;
  return { w: ctx.measureText(text).width + pad * 2, h: size * 1.3 + pad * 0.8, size, pad };
}

export function label(ctx, text, x, y, o = {}) {
  const { w, h, size, pad } = labelSize(ctx, text, o);
  let bx = x;
  if (o.align === 'center') bx = x - w / 2;
  else if (o.align === 'right') bx = x - w;
  if (o.within) bx = Math.max(o.within.x, Math.min(bx, o.within.x + o.within.w - w));
  let by = y;
  if (o.valign === 'middle') by = y - h / 2;
  else if (o.valign === 'bottom') by = y - h;
  roundRectPath(ctx, bx, by, w, h, o.radius ?? size * 0.35);
  ctx.fillStyle = o.bg ?? INK.backing;
  ctx.fill();
  if (o.border) {
    ctx.lineWidth = o.borderWidth ?? Math.max(1, size / 9);
    ctx.strokeStyle = o.border;
    ctx.stroke();
  }
  ctx.fillStyle = o.color ?? INK.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + pad, by + h / 2 + size * 0.04);
  return { x: bx, y: by, w, h };
}

// A line with a dark outline under it, so it shows on bright and dark water alike.
function strokePath(ctx, build, color, width, dash = null) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  build();
  ctx.lineWidth = width + Math.max(2, width * 0.6);
  ctx.strokeStyle = INK.shadow;
  ctx.stroke();
  if (dash) ctx.setLineDash(dash);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([]);
}

function polyPath(ctx, pts, close = true) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

function arrow(ctx, [x0, y0], [x1, y1], color, width) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1) return;
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
  const head = Math.min(len * 0.6, width * 3.2);
  const bx = x1 - ux * head, by = y1 - uy * head;
  strokePath(ctx, () => polyPath(ctx, [[x0, y0], [bx, by]], false), color, width);
  polyPath(ctx, [[x1, y1], [bx - uy * head * 0.75, by + ux * head * 0.75], [bx + uy * head * 0.75, by - ux * head * 0.75]]);
  ctx.lineWidth = Math.max(2, width * 0.5);
  ctx.strokeStyle = INK.shadow;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
}

// Bottom of the HUD's top row (ARMED badge, clock): labels above it would hide under the HUD.
const hudTop = (view) => view.rect.y + 48 * view.k;

function hline(ctx, view, y, color, width, dash) {
  const r = view.rect;
  strokePath(ctx, () => polyPath(ctx, [[r.x, y], [r.x + r.w, y]], false), color, width, dash);
}

// ---------- missions ----------

// 2.1 / 2.2: one quad per tag. o: {confirmed: Set, ignored: Set, selected: id|null,
// selectedLabel: 'SELECTED'|'TARGET', hits: {id: n}, need: n}
//   amber = seen, green = confirmed, thick cyan = selected/target, red = ignored (after Undo)
// Returns the device-pixel rectangles drawn on ([x0, y0, x1, y1]), for drawBanner(avoid).
export function drawTags(ctx, view, res, o = {}) {
  const map = frameMapper(view, res.w, res.h);
  const k = view.k;
  const rects = [];
  // seen but not trusted (low margin / corrected bits): thin dashed grey, never counted
  const trusted = new Set((res.tags ?? []).map((t) => t.id));
  for (const t of res.weak ?? []) {
    if (trusted.has(t.id) || !Array.isArray(t.corners) || t.corners.length !== 4 || !t.corners.every(isPt)) continue;
    const pts = t.corners.map(map);
    strokePath(ctx, () => polyPath(ctx, pts), INK.dim, 2 * k, [6 * k, 5 * k]);
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
    label(ctx, `ID ${t.id}?`, cx, Math.max(...pts.map((p) => p[1])) + 6 * k,
      { size: 14 * k, color: INK.dim, align: 'center', bg: INK.backing, within: view.rect });
  }
  for (const t of res.tags ?? []) {
    if (!Array.isArray(t.corners) || t.corners.length !== 4 || !t.corners.every(isPt)) continue;
    const pts = t.corners.map(map);
    let color = INK.warn, width = 3, text = `ID ${t.id}`, size = 17;
    if (o.ignored?.has(t.id)) {
      color = INK.bad;
      text = `ID ${t.id} ignored`;
    } else if (t.id === o.selected) {
      color = INK.cyan;
      width = 6;
      size = 22;
      text = `${o.selectedLabel ?? 'SELECTED'} ID ${t.id}`;
    } else if (o.confirmed?.has(t.id)) {
      color = INK.ok;
      width = 4;
    } else if (o.need) {
      text = `ID ${t.id}  ${Math.min(o.need, o.hits?.[t.id] ?? 0)}/${o.need}`;
    }
    strokePath(ctx, () => polyPath(ctx, pts), color, width * k);
    const top = Math.min(...pts.map((p) => p[1]));
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
    const style = {
      size: size * k, color: t.id === o.selected ? '#001018' : color, align: 'center',
      bg: t.id === o.selected ? INK.cyan : INK.backing, within: view.rect,
    };
    const above = top - 8 * k - labelSize(ctx, text, style).h >= hudTop(view);
    const box = above ? label(ctx, text, cx, top - 8 * k, { ...style, valign: 'bottom' })
      : label(ctx, text, cx, Math.max(...pts.map((p) => p[1])) + 8 * k, style); // under the HUD row: below
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    rects.push([Math.min(box.x, ...xs), Math.min(box.y, ...ys), Math.max(box.x + box.w, ...xs), Math.max(box.y + box.h, ...ys)]);
  }
  return rects;
}

// 2.2: crosshair, the "aligned" circle (alignDeg around the image centre), a ring on the target
// and an arrow from the crosshair to the aim point while not aligned.
// o: {alignDeg, hfovDeg, aim: [x, y] frame px of the chamber entrance when it is not the tag itself}
// dv: dockingView() result; tag: the target detection or null. Returns the rectangles drawn on.
export function drawDocking(ctx, view, res, tag, dv, o = {}) {
  const r = view.rect, k = view.k;
  const c = [r.x + r.w / 2, r.y + r.h / 2];
  const f = r.w / 2 / Math.tan(((o.hfovDeg ?? 70) * Math.PI) / 360);
  const alignR = Math.max(10 * k, f * Math.tan(((o.alignDeg ?? 5) * Math.PI) / 180));
  const ok = dv?.kind === 'ok';
  ctx.beginPath();
  ctx.arc(c[0], c[1], alignR, 0, Math.PI * 2);
  ctx.lineWidth = 2 * k;
  ctx.setLineDash([6 * k, 6 * k]);
  ctx.strokeStyle = ok ? INK.ok : 'rgba(230, 235, 240, 0.7)';
  ctx.stroke();
  ctx.setLineDash([]);
  const g = 10 * k, L = 34 * k;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    strokePath(ctx, () => polyPath(ctx, [[c[0] + dx * g, c[1] + dy * g], [c[0] + dx * (g + L), c[1] + dy * (g + L)]], false),
      INK.text, 2.5 * k);
  }
  if (!tag || !isPt(tag.center) || !res) return [];
  const map = frameMapper(view, res.w, res.h);
  const t = map(tag.center);
  const corners = Array.isArray(tag.corners) && tag.corners.every(isPt) ? tag.corners.map(map) : null;
  const size = corners ? Math.max(...corners.map((p) => Math.hypot(p[0] - t[0], p[1] - t[1]))) : 30 * k;
  const ringR = Math.max(size * 1.35, 18 * k);
  const color = ok ? INK.ok : INK.cyan;
  const ring = (p, R, col, w, dash = null) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], R, 0, Math.PI * 2);
    ctx.setLineDash([]);
    ctx.lineWidth = w + 4;
    ctx.strokeStyle = INK.shadow;
    ctx.stroke();
    if (dash) ctx.setLineDash(dash);
    ctx.lineWidth = w;
    ctx.strokeStyle = col;
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const aim = isPt(o.aim) ? map(o.aim) : null;
  ring(t, ringR, color, (aim ? 3 : 5) * k, aim ? [8 * k, 6 * k] : null);
  const rects = [[t[0] - ringR, t[1] - ringR, t[0] + ringR, t[1] + ringR]];
  const goal = aim ?? t;
  const goalR = aim ? 22 * k : ringR;
  if (aim) {
    ring(aim, goalR, color, 5 * k);
    strokePath(ctx, () => polyPath(ctx, [[t[0], t[1] + ringR], [aim[0], aim[1] - goalR]], false), color, 2 * k, [4 * k, 6 * k]);
    label(ctx, 'ENTRANCE', aim[0], aim[1] + goalR + 6 * k, { size: 14 * k, color, align: 'center', within: view.rect });
    rects.push([aim[0] - goalR, aim[1] - goalR, aim[0] + goalR, aim[1] + goalR + 30 * k]);
  }
  const d = Math.hypot(goal[0] - c[0], goal[1] - c[1]);
  if (!ok && d > goalR + alignR) {
    const ux = (goal[0] - c[0]) / d, uy = (goal[1] - c[1]) / d;
    arrow(ctx, [c[0] + ux * alignR, c[1] + uy * alignR], [goal[0] - ux * goalR, goal[1] - uy * goalR], INK.warn, 6 * k);
  }
  // after the arrow, so the arrow never hides the number
  if (Number.isFinite(dv?.dist)) {
    label(ctx, `${dv.dist.toFixed(2)} m`, goal[0] + goalR + 8 * k, goal[1], { size: 18 * k, color, valign: 'middle', within: view.rect });
  }
  return rects;
}

// 3: the line (thick), the reference row with the image centre and the line's crossing, the
// trigger row (dashed amber) where a tape counts, tapes as white ticks, a steering arrow.
// sv: steerView() result; o: {triggerRow}
export function drawLine(ctx, view, res, sv, o = {}) {
  const r = view.rect, k = view.k;
  const map = frameMapper(view, res.w, res.h);
  const trig = r.y + clamp(o.triggerRow ?? 0.85, 0, 1) * r.h;
  hline(ctx, view, trig, INK.warn, 2.5 * k, [12 * k, 9 * k]);
  label(ctx, 'checkpoint row', r.x + r.w - 8 * k, trig - 6 * k, { size: 13 * k, color: INK.warn, align: 'right', valign: 'bottom' });

  const refY = Number.isFinite(res.refY) ? map([0, res.refY])[1] : null;
  if (refY !== null) {
    if (Math.abs(refY - trig) > 4 * k) hline(ctx, view, refY, 'rgba(230, 235, 240, 0.8)', 1.5 * k, [5 * k, 7 * k]);
    const cx = r.x + r.w / 2;
    strokePath(ctx, () => polyPath(ctx, [[cx, refY - 16 * k], [cx, refY + 16 * k]], false), INK.text, 3 * k);
  }
  const line = res.line;
  if (!line || !isPt(line.p0) || !isPt(line.p1)) return;
  const color = sv?.kind === 'ok' ? INK.ok : INK.accent;
  const p0 = map(line.p0), p1 = map(line.p1);
  strokePath(ctx, () => polyPath(ctx, [p0, p1], false), color, 7 * k);
  if (refY !== null && Number.isFinite(line.offset)) {
    const x = r.x + r.w / 2 + (line.offset * r.w) / 2;
    if (x >= r.x && x <= r.x + r.w) {
      ctx.beginPath();
      ctx.arc(x, refY, 8 * k, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2.5 * k;
      ctx.strokeStyle = INK.shadow;
      ctx.stroke();
    }
  }
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
  const nx = -(p1[1] - p0[1]) / len, ny = (p1[0] - p0[0]) / len; // across the line
  const half = Math.max(14 * k, (Number(line.widthPx) || 0) * (r.w / res.w) * 1.6);
  for (const tp of line.tapes ?? []) {
    if (!isPt(tp)) continue;
    const [x, y] = map(tp);
    strokePath(ctx, () => polyPath(ctx, [[x - nx * half, y - ny * half], [x + nx * half, y + ny * half]], false), '#ffffff', 5 * k);
  }
  if (sv && !sv.lost) {
    const base = [r.x + r.w / 2, r.y + r.h - 64 * k];
    if (sv.kind === 'ok') arrow(ctx, [base[0], base[1] + 22 * k], [base[0], base[1] - 30 * k], INK.ok, 7 * k);
    else {
      const dir = sv.steer > 0 ? 1 : -1;
      const L = (40 + Math.min(1, Math.abs(sv.steer)) * 150) * k;
      arrow(ctx, [base[0] - dir * 10 * k, base[1]], [base[0] + dir * L, base[1]], INK.warn, 8 * k);
    }
  }
}

// Vertical dashed lines at +-frac of the half width: "aligned" band (Mission 5 approach).
export function drawAlignBand(ctx, view, frac) {
  const r = view.rect, k = view.k;
  for (const s of [-1, 1]) {
    const x = r.x + r.w / 2 + (s * frac * r.w) / 2;
    strokePath(ctx, () => polyPath(ctx, [[x, r.y + r.h * 0.18], [x, r.y + r.h * 0.82]], false),
      'rgba(230, 235, 240, 0.55)', 1.5 * k, [6 * k, 8 * k]);
  }
}

// 5: colour blobs. The blob picked as each colour's pole is solid, other blobs dashed. The NEXT
// pole gets a thick pulsing frame and a NEXT tag. o: {picks: {color: blob}, next: color|null, t: s}
export function drawBlobs(ctx, view, res, o = {}) {
  const map = frameMapper(view, res.w, res.h);
  const k = view.k;
  const rects = [];
  const picked = new Set(Object.values(o.picks ?? {}).filter(Boolean));
  for (const b of res.blobs ?? []) {
    if (!Array.isArray(b.box) || b.box.length !== 4 || !b.box.every(Number.isFinite)) continue;
    const [x0, y0] = map([b.box[0], b.box[1]]);
    const [x1, y1] = map([b.box[0] + b.box[2], b.box[1] + b.box[3]]);
    const color = colorCss(b.color);
    const isNext = o.next && picked.has(b) && b.color === o.next;
    if (isNext) {
      const pulse = 0.5 + 0.5 * Math.sin((o.t ?? 0) * 7);
      const pad = (6 + pulse * 6) * k;
      strokePath(ctx, () => polyPath(ctx, [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]]),
        color, (5 + pulse * 4) * k);
      const style = { size: 22 * k, color: '#0b0e12', bg: color, align: 'center', weight: 800, within: view.rect };
      const above = y0 - pad - 8 * k - labelSize(ctx, 'NEXT', style).h >= hudTop(view);
      const tagBox = above ? label(ctx, 'NEXT', (x0 + x1) / 2, y0 - pad - 8 * k, { ...style, valign: 'bottom' })
        : label(ctx, 'NEXT', (x0 + x1) / 2, y1 + pad + 8 * k, style);
      rects.push([Math.min(x0 - pad, tagBox.x), Math.min(y0 - pad, tagBox.y), Math.max(x1 + pad, tagBox.x + tagBox.w),
        Math.max(y1 + pad, tagBox.y + tagBox.h)]);
    } else {
      strokePath(ctx, () => polyPath(ctx, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), color,
        (picked.has(b) ? 3.5 : 2) * k, picked.has(b) ? null : [7 * k, 6 * k]);
      label(ctx, String(b.color), x0, y0 - 5 * k, { size: 14 * k, color, valign: 'bottom', within: view.rect });
      if (picked.has(b)) rects.push([x0, y0 - 24 * k, x1, y1]);
    }
  }
  return rects;
}

// 4: where the hook is in the picture (set by clicking the video). p: [u, v] 0..1.
export function drawReticle(ctx, view, p, o = {}) {
  if (!isPt(p)) return;
  const k = view.k;
  const [x, y] = pictureToDevice(view, p);
  const color = o.color ?? INK.warn;
  const R = 26 * k;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.lineWidth = 3.5 * k + 3;
  ctx.strokeStyle = INK.shadow;
  ctx.stroke();
  ctx.lineWidth = 3.5 * k;
  ctx.strokeStyle = color;
  ctx.stroke();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    strokePath(ctx, () => polyPath(ctx, [[x + dx * R * 0.45, y + dy * R * 0.45], [x + dx * R * 1.5, y + dy * R * 1.5]], false),
      color, 2.5 * k);
  }
  label(ctx, o.label ?? 'HOOK', x, y + R * 1.6, { size: 15 * k, color, align: 'center', within: view.rect });
}

// A small ring where the colour was sampled (fades out). age 0..1.
export function drawSampleMark(ctx, view, p, age, color) {
  if (!isPt(p)) return;
  const [x, y] = pictureToDevice(view, p);
  ctx.globalAlpha = clamp(1 - age, 0, 1);
  ctx.beginPath();
  ctx.arc(x, y, (10 + 20 * age) * view.k, 0, Math.PI * 2);
  ctx.lineWidth = 3 * view.k;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// A detector mask (already tinted, transparent where empty) stretched over the picture.
export function drawMask(ctx, view, image, alpha = 0.6) {
  if (!image) return;
  const r = view.rect;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(image, r.x, r.y, r.w, r.h);
  ctx.restore();
}

// Overlap area of a box with a list of [x0, y0, x1, y1] rectangles.
export function overlapArea(box, rects) {
  let sum = 0;
  for (const [x0, y0, x1, y1] of rects ?? []) {
    sum += Math.max(0, Math.min(box.x + box.w, x1) - Math.max(box.x, x0))
      * Math.max(0, Math.min(box.y + box.h, y1) - Math.max(box.y, y0));
  }
  return sum;
}

// Big guidance text for the pilot, who looks at the video, not the panel: top centre of the
// picture, or bottom centre when the top would cover something in avoid (detections).
export function drawBanner(ctx, view, text, kind = 'idle', sub = '', avoid = []) {
  if (!text) return;
  const r = view.rect, k = view.k;
  const ink = kindInk(kind);
  const main = { size: 34 * k, color: ink, border: ink, borderWidth: 3 * k, align: 'center', weight: 800 };
  const small = { size: 16 * k, color: INK.text, align: 'center', weight: 600 };
  const a = labelSize(ctx, text, main);
  const b = sub ? labelSize(ctx, sub, small) : { w: 0, h: 0 };
  const gap = sub ? 6 * k : 0;
  const w = Math.max(a.w, b.w), h = a.h + gap + b.h;
  const x = r.x + r.w / 2 - w / 2;
  const top = { x, y: r.y + 52 * k, w, h };
  const bottom = { x, y: r.y + r.h - 50 * k - h, w, h };
  const over = overlapArea(top, avoid);
  const pos = over > 0 && overlapArea(bottom, avoid) < over ? bottom : top;
  const box = label(ctx, text, r.x + r.w / 2, pos.y, main);
  if (sub) label(ctx, sub, r.x + r.w / 2, box.y + box.h + gap, small);
}

// HUD: ARMED/DISARMED (top left), attempt clock (top right), mission (bottom left), detector
// time (bottom right). h: {armed, sim, clock: {text, kind, running}, mission, det}
export function drawHud(ctx, view, h) {
  const k = view.k;
  const r = view.hasVideo ? view.rect : { x: 0, y: 0, w: view.W, h: view.H };
  const m = 12 * k;
  const badge = h.armed
    ? label(ctx, 'ARMED', r.x + m, r.y + m, { size: 20 * k, color: '#ffffff', bg: '#c62828', border: '#ff8a80', weight: 800 })
    : label(ctx, 'DISARMED', r.x + m, r.y + m, { size: 20 * k, color: INK.dim, border: INK.dim, weight: 800 });
  if (h.sim) {
    label(ctx, 'SIMULATOR', badge.x + badge.w + 8 * k, r.y + m, {
      size: 20 * k, color: INK.accent, border: INK.accent, weight: 800,
    });
  }
  if (h.clock) {
    const ink = h.clock.running ? kindInk(h.clock.kind) : INK.dim;
    label(ctx, h.clock.text, r.x + r.w - m, r.y + m, { size: 24 * k, color: ink, border: ink, align: 'right', mono: true });
  }
  if (h.mission) label(ctx, h.mission, r.x + m, r.y + r.h - m, { size: 16 * k, valign: 'bottom' });
  if (h.det) label(ctx, h.det, r.x + r.w - m, r.y + r.h - m, { size: 14 * k, color: INK.dim, align: 'right', valign: 'bottom', mono: true });
}
