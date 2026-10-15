import test from 'node:test';
import assert from 'node:assert/strict';

import { axesFromKeys, bindKeyboard, isTypingTarget } from '../js/controls.js';

test('axesFromKeys maps the documented keys', () => {
  assert.deepEqual(axesFromKeys(new Set(['KeyW'])), { surge: 1, yaw: 0, heave: 0 });
  assert.deepEqual(axesFromKeys(new Set(['KeyS'])), { surge: -1, yaw: 0, heave: 0 });
  assert.deepEqual(axesFromKeys(new Set(['KeyD'])), { surge: 0, yaw: 1, heave: 0 });
  assert.deepEqual(axesFromKeys(new Set(['KeyA'])), { surge: 0, yaw: -1, heave: 0 });
  assert.deepEqual(axesFromKeys(new Set(['KeyR'])), { surge: 0, yaw: 0, heave: 1 });
  assert.deepEqual(axesFromKeys(new Set(['KeyF'])), { surge: 0, yaw: 0, heave: -1 });
  assert.deepEqual(axesFromKeys(new Set(['KeyW', 'KeyD', 'KeyR'])), { surge: 1, yaw: 1, heave: 1 });
});

test('axesFromKeys: opposite keys cancel, unrelated keys are ignored', () => {
  assert.deepEqual(axesFromKeys(new Set(['KeyW', 'KeyS'])), { surge: 0, yaw: 0, heave: 0 });
  assert.deepEqual(axesFromKeys(new Set(['KeyQ', 'Space', 'KeyJ'])), { surge: 0, yaw: 0, heave: 0 });
});

test('isTypingTarget: text-like fields swallow keys', () => {
  for (const type of ['text', 'password', 'url', 'number', 'search', 'email', '']) {
    assert.ok(isTypingTarget({ tagName: 'INPUT', type }), type);
  }
  assert.ok(isTypingTarget({ tagName: 'input', type: 'TEXT' }));
  assert.ok(isTypingTarget({ tagName: 'TEXTAREA' }));
  assert.ok(isTypingTarget({ tagName: 'SELECT' }));
  assert.ok(isTypingTarget({ tagName: 'DIV', isContentEditable: true }));
});

test('isTypingTarget: a focused slider, checkbox, radio or button must NOT swallow WASD', () => {
  for (const type of ['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file']) {
    assert.equal(isTypingTarget({ tagName: 'INPUT', type }), false, type);
  }
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget({}), false);
});

// ---- bindKeyboard with a tiny fake window/document ----------------------
function rig(activeElement = { tagName: 'BODY' }) {
  const handlers = { win: {}, doc: {} };
  const win = {
    addEventListener: (t, f) => { handlers.win[t] = f; },
    removeEventListener: (t) => { delete handlers.win[t]; },
  };
  const doc = {
    activeElement,
    visibilityState: 'visible',
    addEventListener: (t, f) => { handlers.doc[t] = f; },
    removeEventListener: (t) => { delete handlers.doc[t]; },
  };
  const log = [];
  const controller = {
    keyDown: (c) => log.push(['down', c]),
    keyUp: (c) => log.push(['up', c]),
    clearKeys: () => log.push(['clear']),
  };
  let estops = 0;
  const unbind = bindKeyboard({ win, doc, controller, onEstop: () => { estops++; } });
  const key = (code, extra = {}) => {
    const e = { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, prevented: false,
      preventDefault() { this.prevented = true; }, ...extra };
    return e;
  };
  return { handlers, doc, log, key, unbind, get estops() { return estops; } };
}

test('keyboard: driving keys reach the controller and are prevented', () => {
  const r = rig();
  const e = r.key('KeyW');
  r.handlers.win.keydown(e);
  assert.deepEqual(r.log, [['down', 'KeyW']]);
  assert.ok(e.prevented);
  const up = r.key('KeyW');
  r.handlers.win.keyup(up);
  assert.deepEqual(r.log.at(-1), ['up', 'KeyW']);
});

test('keyboard: works with a focused slider and checkbox (lesson learned)', () => {
  for (const type of ['range', 'checkbox']) {
    const r = rig({ tagName: 'INPUT', type });
    r.handlers.win.keydown(r.key('KeyA'));
    assert.deepEqual(r.log, [['down', 'KeyA']], type);
  }
});

test('keyboard: ignored while typing in a text field, but key release still works', () => {
  const r = rig({ tagName: 'INPUT', type: 'text' });
  const e = r.key('KeyW');
  r.handlers.win.keydown(e);
  assert.deepEqual(r.log, []);
  assert.equal(e.prevented, false);
  r.handlers.win.keyup(r.key('KeyW'));
  assert.deepEqual(r.log, [['up', 'KeyW']]);
});

test('keyboard: Esc is E-STOP, also while typing', () => {
  const r = rig({ tagName: 'INPUT', type: 'text' });
  r.handlers.win.keydown(r.key('Escape'));
  assert.equal(r.estops, 1);
});

test('keyboard: auto-repeat is ignored, Space is prevented (no button click)', () => {
  const r = rig({ tagName: 'BUTTON' });
  const e = r.key('Space', { repeat: true });
  r.handlers.win.keydown(e);
  assert.deepEqual(r.log, []);
  assert.ok(e.prevented);
  const up = r.key('Space');
  r.handlers.win.keyup(up);
  assert.ok(up.prevented);
});

test('keyboard: browser shortcuts (Cmd+R, Ctrl+S) are left alone', () => {
  const r = rig();
  const e = r.key('KeyR', { metaKey: true });
  r.handlers.win.keydown(e);
  assert.deepEqual(r.log, []);
  assert.equal(e.prevented, false);
  r.handlers.win.keydown(r.key('KeyS', { ctrlKey: true }));
  assert.deepEqual(r.log, []);
});

test('keyboard: unrelated keys are untouched', () => {
  const r = rig();
  const e = r.key('KeyQ');
  r.handlers.win.keydown(e);
  assert.deepEqual(r.log, []);
  assert.equal(e.prevented, false);
});

test('keyboard: window blur clears all held keys', () => {
  const r = rig();
  r.handlers.win.blur();
  assert.deepEqual(r.log, [['clear']]);
});

test('keyboard: focusing a text field clears held keys, focusing a slider does not', () => {
  const r = rig({ tagName: 'INPUT', type: 'range' });
  r.handlers.doc.focusin();
  assert.deepEqual(r.log, []);
  r.doc.activeElement = { tagName: 'INPUT', type: 'text' };
  r.handlers.doc.focusin();
  assert.deepEqual(r.log, [['clear']]);
});

test('keyboard: hidden tab clears keys and triggers E-STOP', () => {
  const r = rig();
  r.doc.visibilityState = 'hidden';
  r.handlers.doc.visibilitychange();
  assert.deepEqual(r.log, [['clear']]);
  assert.equal(r.estops, 1);
});

test('keyboard: unbind removes every listener', () => {
  const r = rig();
  r.unbind();
  assert.deepEqual(Object.keys(r.handlers.win), []);
  assert.deepEqual(Object.keys(r.handlers.doc), []);
});
