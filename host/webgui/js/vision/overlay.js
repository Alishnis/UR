// Mission 2.1 drawing on the video: a box and a big ID on every tag (green = confirmed, orange = not yet,
// magenta = the selected one), and the SELECTED line large enough for the referee to read.

const COLORS = { confirmed: "#00e676", pending: "#ffb300", selected: "#ff40ff" };

function text(ctx, str, x, y, size, color, align = "left") {
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.lineWidth = Math.max(3, size / 6);
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(str, x, y);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

// sizes below are for a 1280 px wide frame and scale with the real width
const scale = (ctx) => ctx.canvas.width / 1280;

export function drawTags(ctx, result, sx, sy) {
  if (!result || result.type !== "tags") return;
  const k = scale(ctx);
  const confirmed = new Set(result.confirmed);
  for (const d of result.detections) {
    const color = d.id === result.selected ? COLORS.selected : confirmed.has(d.id) ? COLORS.confirmed : COLORS.pending;
    const pts = d.corners.map(([x, y]) => [x * sx, y * sy]);
    ctx.lineWidth = (d.id === result.selected ? 8 : 4) * k;
    ctx.strokeStyle = color;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    const top = Math.min(...pts.map((p) => p[1]));
    const bottom = Math.max(...pts.map((p) => p[1]));
    text(ctx, `ID ${d.id}`, d.center[0] * sx, Math.max(top - 14 * k, 40 * k), 40 * k, color, "center");
    text(ctx, `margin ${Math.round(d.margin)}`, d.center[0] * sx, bottom + 24 * k, 16 * k, "#bbb", "center");
  }
}

export function drawMissionBanner(ctx, state) {
  if (!state || !state.confirmed) return;
  const k = scale(ctx);
  const n = state.confirmed.length;
  const rule = state.rule ? state.rule.toUpperCase() : null;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, 640 * k, 150 * k);
  text(ctx, rule ? `RULE: ${rule}` : "RULE: NOT SET", 16 * k, 38 * k, 28 * k, rule ? "#fff" : "#ff5252");
  const countColor = n === state.expected ? "#00e676" : n > state.expected ? "#ff5252" : "#ffb300";
  text(ctx, `TAGS (${n}/${state.expected}): ${n ? state.confirmed.join(", ") : "-"}`, 16 * k, 76 * k, 28 * k,
       countColor);
  if (state.selected !== null && state.selected !== undefined) {
    text(ctx, `SELECTED: ID ${state.selected}`, 16 * k, 132 * k, 48 * k, "#ffeb3b");
  } else if (n > state.expected) {
    text(ctx, "SELECTED: ???  (too many tags - Undo the false one)", 16 * k, 128 * k, 26 * k, "#ff5252");
  } else {
    text(ctx, "SELECTED: ---", 16 * k, 130 * k, 40 * k, "#888");
  }
}

export function drawArmState(ctx, armed, width) {
  const k = scale(ctx);
  text(ctx, armed ? "ARMED" : "DISARMED", width - 16 * k, 40 * k, 30 * k, armed ? "#ff5252" : "#888", "right");
}
