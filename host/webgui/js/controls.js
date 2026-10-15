// Keyboard helpers. The pure parts are unit-tested; bindKeyboard() touches the DOM.
//
// Keys are matched by event.code (physical key), so they work on any layout,
// including the Russian one.

export const DRIVE_KEYS = {
  KeyW: { axis: 'surge', dir: +1 },
  KeyS: { axis: 'surge', dir: -1 },
  KeyD: { axis: 'yaw', dir: +1 }, // left = surge + yaw, so +yaw turns right
  KeyA: { axis: 'yaw', dir: -1 },
  KeyR: { axis: 'heave', dir: +1 },
  KeyF: { axis: 'heave', dir: -1 },
};
export const KEY_ZERO = 'Space';
export const KEY_ESTOP = 'Escape';
export const KEY_MAG_DOWN = 'KeyJ';
export const KEY_MAG_UP = 'KeyK';

export const HANDLED_CODES = new Set([
  ...Object.keys(DRIVE_KEYS), KEY_ZERO, KEY_MAG_DOWN, KEY_MAG_UP,
]);

// held: Set of key codes -> {surge, yaw, heave}. Opposite keys cancel out.
export function axesFromKeys(held) {
  const axes = { surge: 0, yaw: 0, heave: 0 };
  for (const [code, { axis, dir }] of Object.entries(DRIVE_KEYS)) {
    if (held.has(code)) axes[axis] += dir;
  }
  return axes;
}

// Input types where WASD must type text. A focused slider, checkbox, radio or
// button must NOT swallow driving keys (lesson learned).
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'time', 'week', '',
]);

// el: anything with tagName, type, isContentEditable (a DOM element or a plain object in tests).
export function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true; // select: type-ahead would eat letters
  if (el.isContentEditable) return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
  return false;
}

// Wires keyboard events to the controller. Returns an unbind function.
//   win/doc: window and document (injectable for tests)
export function bindKeyboard({ win = window, doc = document, controller, onEstop }) {
  const typing = () => isTypingTarget(doc.activeElement);

  function onKeyDown(e) {
    // Esc is the E-STOP: always works, even while typing.
    if (e.code === KEY_ESTOP) {
      onEstop();
      return;
    }
    if (!HANDLED_CODES.has(e.code)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // keep Cmd+R, Ctrl+S etc. for the browser
    if (typing()) return;
    e.preventDefault(); // Space must not click a focused button, S must not scroll/search
    if (e.repeat) return;
    controller.keyDown(e.code);
  }

  function onKeyUp(e) {
    if (!HANDLED_CODES.has(e.code)) return;
    if (e.code === KEY_ZERO && !typing()) e.preventDefault(); // Firefox clicks buttons on keyup
    controller.keyUp(e.code); // releasing always works, even if focus moved meanwhile
  }

  const clear = () => controller.clearKeys();
  const onFocusIn = () => {
    if (typing()) controller.clearKeys(); // entering a text field: stop driving
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      controller.clearKeys();
      onEstop(); // hidden tabs get throttled timers: D at 1 Hz would make the motors stutter
    }
  };

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', clear);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', clear);
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
