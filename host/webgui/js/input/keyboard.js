import { InputState } from "./input_state.js";

// W/S surge, A/D yaw, R/F heave (same keys as the Python simulators), J/K throttle, Space hold = stop,
// Esc = E-STOP (disarm). Keys are ignored while typing in a text field.

const keys = Object.create(null);
const MAG_RATE = 0.9;  // throttle change per second while J / K is held

let currentMag = InputState.magnitude;
let lastTime = 0;

// Only fields you type into swallow the driving keys. A slider or checkbox keeps the focus after a click, and
// before this fix that silently disabled W/A/S/D until you clicked somewhere else.
const TEXT_INPUTS = new Set(["text", "number", "password", "search", "email", "url", "tel"]);

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT") return TEXT_INPUTS.has(el.type);
  return tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

const isTyping = () => isEditable(document.activeElement);

function clearKeys() {
  for (const k in keys) keys[k] = false;
}

export function initKeyboard({ onEstop } = {}) {
  currentMag = InputState.magnitude;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") {  // works even while typing
      onEstop?.();
      e.preventDefault();
      return;
    }
    if (isEditable(e.target)) return;
    keys[e.code] = true;
    if (e.code === "Space") {
      InputState.hold = true;
      e.preventDefault();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (isEditable(e.target)) return;
    keys[e.code] = false;
    if (e.code === "Space") {
      InputState.hold = false;
      e.preventDefault();
    }
  });

  // window lost focus: a keyup may never arrive, so nothing may stay "held"
  window.addEventListener("blur", () => { clearKeys(); InputState.reset(); });
  document.addEventListener("focusin", (e) => { if (isEditable(e.target)) { clearKeys(); InputState.reset(); } });
  document.addEventListener("focusout", () => clearKeys());
}

export function pollKeyboard(now = performance.now()) {
  if (lastTime === 0) lastTime = now;
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (isTyping() || InputState.hold) {
    InputState.surge = InputState.yaw = InputState.heave = 0;
  } else {
    const axis = (plus, minus) => (keys[plus] ? 1 : 0) - (keys[minus] ? 1 : 0);
    InputState.surge = axis("KeyW", "KeyS");
    InputState.yaw = axis("KeyD", "KeyA");
    InputState.heave = axis("KeyR", "KeyF");
  }
  if (!isTyping()) {
    currentMag += ((keys["KeyK"] ? 1 : 0) - (keys["KeyJ"] ? 1 : 0)) * MAG_RATE * dt;
    currentMag = Math.min(1, Math.max(0, currentMag));
  }
  InputState.magnitude = currentMag;
}
