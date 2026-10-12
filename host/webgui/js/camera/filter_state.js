// Image filters (CSS canvas filters). Two independent sets:
//   view     - only what the pilot sees on the big display
//   detector - applied to the frame BEFORE it is sent to the AprilTag detector (the second display shows it)
// Values are remembered in the browser (localStorage), so a pool calibration survives a page reload.

const DEFAULTS = {
  brightness: 1.0,
  contrast: 1.0,
  saturation: 1.0,
  hue: 0,
  blur: 0,
};

export function createFilterState(storageKey) {
  const state = {
    ...DEFAULTS,
    reset() { Object.assign(this, DEFAULTS); this.save(); },
    copyFrom(other) { for (const k in DEFAULTS) this[k] = other[k]; this.save(); },
    isDefault() { return Object.keys(DEFAULTS).every((k) => this[k] === DEFAULTS[k]); },
    save() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, this[k]]))));
      } catch (_) { /* private window: just not remembered */ }
    },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    for (const k in DEFAULTS) if (typeof saved[k] === "number") state[k] = saved[k];
  } catch (_) { /* storage blocked or corrupt: defaults */ }
  return state;
}

export const ViewFilters = createFilterState("ur-rov-view-filters");
export const DetectorFilters = createFilterState("ur-rov-detector-filters");

// blur is given for a 1280 px wide frame and scaled with the real width, so it looks the same on both displays
export function buildFilterString(s, width = 1280) {
  const parts = [];
  if (s.brightness !== 1) parts.push(`brightness(${s.brightness})`);
  if (s.contrast !== 1) parts.push(`contrast(${s.contrast})`);
  if (s.saturation !== 1) parts.push(`saturate(${s.saturation})`);
  if (s.hue !== 0) parts.push(`hue-rotate(${s.hue}deg)`);
  if (s.blur !== 0) parts.push(`blur(${(s.blur * width / 1280).toFixed(2)}px)`);
  return parts.length ? parts.join(" ") : "none";
}

// Safari before 18 ignores ctx.filter silently: then the detector filters would do nothing
export const canvasFiltersSupported = typeof CanvasRenderingContext2D !== "undefined"
  && "filter" in CanvasRenderingContext2D.prototype;
