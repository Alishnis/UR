import { InputState } from "../input/input_state.js";

// THRUSTER TEST buttons (data-test): while held, only that thruster runs, through config outputSlot / invert.
// PIN TEST buttons (data-pin): while held, a raw signal goes to that one ESP32 pin only - checks the wiring.
// Both at the J / K throttle within MAX.
export function initThrusterTest(root, { isArmed, onNotArmed }) {
  const release = () => { InputState.test = null; InputState.pinTest = null; };
  root.querySelectorAll("button[data-test], button[data-pin]").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => {
      if (!isArmed()) { onNotArmed(); return; }
      btn.setPointerCapture(e.pointerId);  // the pointerup arrives here even if the mouse slides off
      const sign = Number(btn.dataset.sign);
      if (btn.dataset.pin !== undefined) InputState.pinTest = { slot: Number(btn.dataset.pin), sign };
      else InputState.test = { name: btn.dataset.test, sign };
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) btn.addEventListener(ev, release);
    btn.addEventListener("click", () => btn.blur());  // keep Space / W A S D for driving
  });
  window.addEventListener("blur", release);
}
