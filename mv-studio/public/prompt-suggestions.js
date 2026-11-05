// Example prompts are placeholders only: they never become user input.
export function startPromptSuggestions(field, examples, env = {}) {
  if (!field) return { setExamples() {}, destroy() {} };
  const doc = env.document || document;
  const view = env.window || window;
  const schedule = env.setTimeout || setTimeout;
  const cancel = env.clearTimeout || clearTimeout;
  const motion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  let options = examples.filter(Boolean), fallback = field.placeholder;
  let timer = null, index = 0, length = 0, deleting = false, disposed = false;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const later = delay => { clear(); timer = schedule(tick, delay); };
  function tick() {
    timer = null;
    if (disposed) return;
    if (field.isConnected === false) return destroy();
    if (doc.activeElement === field) { field.placeholder = fallback; return; }
    if (!options.length) { field.placeholder = fallback; return; }
    if (motion?.matches) { field.placeholder = options[0]; return; }
    if (doc.hidden || field.disabled || field.value || !field.getClientRects().length) {
      field.placeholder = fallback;
      index = 0; length = 0; deleting = false;
      later(800);
      return;
    }
    const chars = Array.from(options[index]);
    length += deleting ? -1 : 1;
    field.placeholder = chars.slice(0, length).join('') + '_';
    if (!deleting && length >= chars.length) { deleting = true; later(2200); }
    else if (deleting && length <= 0) { deleting = false; index = (index + 1) % options.length; later(500); }
    else later(deleting ? 45 : 90);
  }
  function reset() {
    clear(); index = 0; length = 0; deleting = false;
    field.placeholder = fallback;
    if (doc.activeElement !== field) later(400);
  }
  function onFocus() { clear(); field.placeholder = fallback; }
  function onChange() { if (doc.activeElement !== field) reset(); }
  function destroy() {
    if (disposed) return;
    disposed = true; clear(); field.placeholder = fallback;
    field.removeEventListener('focus', onFocus);
    field.removeEventListener('blur', reset);
    field.removeEventListener('input', onChange);
    doc.removeEventListener('visibilitychange', onChange);
    motion?.removeEventListener?.('change', onChange);
  }
  field.addEventListener('focus', onFocus);
  field.addEventListener('blur', reset);
  field.addEventListener('input', onChange);
  doc.addEventListener('visibilitychange', onChange);
  motion?.addEventListener?.('change', onChange);
  reset();
  return { setExamples(next, placeholder = fallback) { options = next.filter(Boolean); fallback = placeholder; reset(); }, destroy };
}
