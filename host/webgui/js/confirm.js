// Two-click confirmation on a button instead of window.confirm(): a modal dialog freezes the page,
// and with it the 20 Hz motor command loop and the E-STOP key, for as long as it is open.
//
//   if (!confirmClick(btn, 'Reset? click again')) return;   // first click: asks on the button
//   ...do it...                                               // second click within 3 s: go

const PENDING_MS = 3000;
const pending = new WeakMap(); // button -> {label, timer}

function clear(btn) {
  const p = pending.get(btn);
  if (!p) return;
  clearTimeout(p.timer);
  btn.textContent = p.label;
  btn.classList.remove('confirming');
  pending.delete(btn);
}

// true = confirmed (second click within PENDING_MS), false = now asking.
export function confirmClick(btn, question) {
  if (pending.has(btn)) {
    clear(btn);
    return true;
  }
  pending.set(btn, { label: btn.textContent, timer: setTimeout(() => clear(btn), PENDING_MS) });
  btn.textContent = question;
  btn.classList.add('confirming');
  return false;
}
