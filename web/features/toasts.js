// Feature module: toasts — messages stack at the bottom of the page and are kept in a history.
// SV.flash(msg, { kind, ms }?) still writes #flash (the newest message; tests read it); this module listens to the core's
// 'sv-flash' event: a message still showing when the next arrives stays above it until its own time is up (at most
// three), and every message goes into a history (newest first, 100 kept) opened from "Messages" in the status bar.
// Preference: how long a message shows, scoreview.toasts.ms (2500 default, 6000 = long).
// Also loads in Node (module.exports) for the unit test: createHistory, guessKind.
(function (root) {
  'use strict';

  /** Ring of the last `max` messages, newest first: add(msg, kind, t) -> entry, list(), clear(), size(). */
  function createHistory(max = 100) {
    let items = [];
    return {
      add(msg, kind, t) {
        const e = { msg: String(msg), kind: kind || guessKind(msg), t: t == null ? Date.now() : t };
        items.unshift(e);
        if (items.length > max) items.length = max;
        return e;
      },
      list: () => items.slice(),
      clear() { items = []; },
      size: () => items.length,
    };
  }

  /** A kind for a message sent without one: 'err' for failures, 'warn' for "No … / nothing …", else 'info'. */
  function guessKind(msg) {
    const s = String(msg);
    if (/\b(fail(ed|s)?|error|could not|couldn't|cannot|can't|refused|not found)\b/i.test(s)) return 'err';
    if (/^(no|nothing)\b/i.test(s.trim()) || /\bout of date\b/i.test(s)) return 'warn';
    return 'info';
  }

  const DURATIONS = { 2500: 'Short (2.5 s)', 6000: 'Long (6 s)' };
  const api = { createHistory, guessKind, DURATIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const SV = root.SV;
  if (!SV || typeof document === 'undefined') return;

  const KEY = 'scoreview.toasts.ms';
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const loadMs = () => { try { const v = JSON.parse(localStorage.getItem(KEY)); return DURATIONS[v] ? v : 2500; } catch (e) { return 2500; } };
  const history = createHistory(100);
  let unseen = 0;

  SV.addStyle(`
    #svToasts { position: fixed; left: 50%; bottom: 44px; transform: translateX(-50%); z-index: var(--sv-z-toast);
      display: flex; flex-direction: column; align-items: center; gap: var(--sv-space-2); pointer-events: none; max-width: 70vw; }
    #svToasts #flash, #svToasts .svt-old { position: static; transform: none; pointer-events: auto; max-width: 70vw;
      box-shadow: var(--sv-shadow-pop); border-left: 3px solid var(--sv-info); }
    #svToasts .svt-old { background: var(--sv-surface-2); color: var(--sv-text); padding: var(--sv-space-3) 14px;
      border-radius: var(--sv-radius-md); font-size: var(--sv-fs-control); transition: opacity var(--sv-motion); }
    #svToasts .svt-old.svt-gone { opacity: 0; }
    #svToasts [data-kind="ok"] { border-left-color: var(--sv-ok); }
    #svToasts [data-kind="warn"] { border-left-color: var(--sv-warn); }
    #svToasts [data-kind="err"] { border-left-color: var(--sv-err); }
    #svToastBtn .svt-count { display: inline-block; min-width: 16px; padding: 0 4px; margin-left: 4px; border-radius: 8px;
      background: var(--sv-surface-raised); color: var(--sv-text-strong); font-size: var(--sv-fs-small); text-align: center; }
    #svToastBtn .svt-count:empty { display: none; }
    #svToastPop { position: fixed; right: 12px; bottom: 34px; width: min(460px, 90vw); max-height: 50vh; display: flex; flex-direction: column;
      background: var(--sv-surface-1); border: 1px solid var(--sv-border); border-radius: var(--sv-radius-md);
      box-shadow: var(--sv-shadow-pop); z-index: var(--sv-z-pop); font-size: var(--sv-fs-control); }
    #svToastPop .svt-head { display: flex; align-items: center; gap: var(--sv-space-4); padding: var(--sv-space-3) 10px;
      border-bottom: 1px solid var(--sv-border); color: var(--sv-text-dim); }
    #svToastPop .svt-head b { color: var(--sv-text); margin-right: auto; }
    #svToastPop ol { list-style: none; margin: 0; padding: var(--sv-space-2) 0; overflow: auto; }
    #svToastPop li { display: flex; gap: var(--sv-space-4); padding: 3px 10px; border-left: 3px solid transparent; }
    #svToastPop li[data-kind="err"] { border-left-color: var(--sv-err); }
    #svToastPop li[data-kind="warn"] { border-left-color: var(--sv-warn); }
    #svToastPop li[data-kind="ok"] { border-left-color: var(--sv-ok); }
    #svToastPop li time { color: var(--sv-text-faint); font-family: var(--sv-font-mono); font-size: var(--sv-fs-small); flex: none; }
    #svToastPop .svt-empty { color: var(--sv-text-dim); padding: 10px; }
  `);

  // ---- the stack: #flash is the newest; older messages still on their time sit above it
  const stack = document.createElement('div');
  stack.id = 'svToasts';
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  stack.appendChild($('flash'));
  SV.flash.ms = loadMs();
  let current = null; // { msg, kind, until }

  window.addEventListener('sv-flash', e => {
    const { msg, ms } = e.detail;
    const kind = e.detail.kind || guessKind(msg);
    $('flash').dataset.kind = kind;
    const now = Date.now();
    if (current && current.until > now + 150) keepOld(current, current.until - now);
    current = { msg, kind, until: now + (ms || SV.flash.ms) };
    history.add(msg, kind, now);
    unseen++;
    updateCount();
    if (pop) renderPop();
  });

  function keepOld(t, left) {
    const old = document.createElement('div');
    old.className = 'svt-old';
    old.dataset.kind = t.kind;
    old.textContent = t.msg;
    stack.insertBefore(old, $('flash'));
    const olds = stack.querySelectorAll('.svt-old');
    if (olds.length > 3) olds[0].remove();
    setTimeout(() => { old.classList.add('svt-gone'); setTimeout(() => old.remove(), 200); }, left);
  }

  // ---- the history popover, opened from the status bar
  const btn = document.createElement('button');
  btn.id = 'svToastBtn';
  btn.className = 'svs-btn';
  btn.title = 'Message history';
  btn.innerHTML = 'Messages<span class="svt-count"></span>';
  const right = $('svStatusRight');
  (right || $('svStatusBar') || document.body).appendChild(btn);
  function updateCount() { btn.querySelector('.svt-count').textContent = unseen ? String(Math.min(unseen, 99)) : ''; }

  let pop = null;
  const time = t => new Date(t).toTimeString().slice(0, 8);
  function renderPop() {
    const items = history.list();
    const ms = SV.flash.ms;
    pop.innerHTML = '<div class="svt-head"><b>Messages</b>' +
      `<label>Show for <select id="svToastMs">${Object.entries(DURATIONS).map(([v, t]) => `<option value="${v}" ${+v === ms ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` +
      '<button class="btn" id="svToastClear">Clear</button></div>' +
      (items.length ? '<ol>' + items.map(e => `<li data-kind="${e.kind}"><time>${time(e.t)}</time><span>${esc(e.msg)}</span></li>`).join('') + '</ol>'
        : '<div class="svt-empty">No messages yet.</div>');
  }
  function open() {
    if (pop) return;
    pop = document.createElement('div');
    pop.id = 'svToastPop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Message history');
    document.body.appendChild(pop);
    renderPop();
    unseen = 0;
    updateCount();
    pop.addEventListener('change', e => {
      if (e.target.id !== 'svToastMs') return;
      SV.flash.ms = +e.target.value;
      try { localStorage.setItem(KEY, JSON.stringify(SV.flash.ms)); } catch (err) { /* ignore */ }
    });
    pop.addEventListener('click', e => { if (e.target.id === 'svToastClear') { history.clear(); renderPop(); } });
    pop.addEventListener('keydown', e => e.stopPropagation());
  }
  function close() { if (pop) { pop.remove(); pop = null; } }
  btn.addEventListener('click', () => { if (pop) close(); else open(); btn.blur(); });
  document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', e => { if (pop && e.key === 'Escape') { close(); e.stopPropagation(); } }, true);

  SV.toasts = Object.assign({}, api, {
    history: () => history.list(), clear: () => { history.clear(); if (pop) renderPop(); },
    open, close, isOpen: () => !!pop,
    duration: () => SV.flash.ms,
    setDuration(ms) { if (DURATIONS[ms]) { SV.flash.ms = ms; try { localStorage.setItem(KEY, JSON.stringify(ms)); } catch (e) { /* ignore */ } } return SV.flash.ms; },
  });
})(typeof window !== 'undefined' ? window : globalThis);
