import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPromptSuggestions } from '../public/prompt-suggestions.js';

function fixture({ reduced = false } = {}) {
  const timers = new Map();
  let next = 0;
  const target = () => {
    const events = new Map();
    return {
      addEventListener(name, fn) { events.set(name, fn); },
      removeEventListener(name, fn) { if (events.get(name) === fn) events.delete(name); },
      dispatch(name) { events.get(name)?.(); },
      events,
    };
  };
  const doc = { ...target(), activeElement: null, hidden: false };
  const motion = { ...target(), matches: reduced };
  const field = { ...target(), placeholder: '描述想法', value: '', isConnected: true, disabled: false, getClientRects: () => [1] };
  const env = {
    document: doc,
    window: { matchMedia: () => motion },
    setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const run = () => { const [id, fn] = timers.entries().next().value || []; assert.ok(fn, 'expected a scheduled animation step'); timers.delete(id); fn(); };
  return { field, doc, motion, timers, env, run };
}

test('placeholder types, deletes and rotates without populating user input', () => {
  const x = fixture();
  startPromptSuggestions(x.field, ['你好', '音乐'], x.env);
  x.run(); assert.equal(x.field.placeholder, '你_');
  x.run(); assert.equal(x.field.placeholder, '你好_');
  x.run(); assert.equal(x.field.placeholder, '你_');
  x.run(); assert.equal(x.field.placeholder, '_');
  x.run(); assert.equal(x.field.placeholder, '音_');
  assert.equal(x.field.value, '');
});

test('focus, composition and existing text remain untouched; blur resumes', () => {
  const x = fixture();
  startPromptSuggestions(x.field, ['写一首歌'], x.env);
  x.run();
  x.doc.activeElement = x.field;
  x.field.dispatch('focus');
  assert.equal(x.field.placeholder, '描述想法');
  assert.equal(x.timers.size, 0);
  x.field.value = '我的创作'; x.field.dispatch('input');
  assert.equal(x.field.value, '我的创作');
  x.doc.activeElement = null; x.field.dispatch('blur'); x.run();
  assert.equal(x.field.value, '我的创作');
  assert.equal(x.field.placeholder, '描述想法');
  x.field.value = ''; x.field.dispatch('input'); x.run();
  assert.equal(x.field.placeholder, '写_');
});

test('mode changes, hidden panels, reduced motion and disposal are respected', () => {
  const x = fixture({ reduced: true });
  const control = startPromptSuggestions(x.field, ['歌曲'], x.env);
  x.run(); assert.equal(x.field.placeholder, '歌曲'); assert.equal(x.timers.size, 0);
  control.setExamples(['纯音乐'], '描述纯音乐'); x.run();
  assert.equal(x.field.placeholder, '纯音乐');
  x.motion.matches = false; x.motion.dispatch('change');
  x.doc.hidden = true; x.run(); assert.equal(x.field.placeholder, '描述纯音乐');
  x.doc.hidden = false; x.doc.dispatch('visibilitychange'); x.run();
  assert.equal(x.field.placeholder, '纯_');
  control.destroy(); assert.equal(x.timers.size, 0); assert.equal(x.field.placeholder, '描述纯音乐');
  assert.equal(x.doc.events.size, 0); assert.equal(x.motion.events.size, 0);
});
