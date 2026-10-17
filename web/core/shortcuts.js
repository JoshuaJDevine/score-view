// Score View page core: the keyboard shortcut registry (SV.shortcuts). Descriptive only: modules keep their own
// SV.hooks.keydown handlers and record here which keys they take, so the help can list them and a test can catch two
// owners claiming the same key in the same context.
//
//   SV.shortcuts.register({ keys: 'Alt+S', owner: 'motifs', desc: 'sequence up', when: 'normal' })
//     keys   one key or an array ('Ctrl+Shift+Z', 'Alt+ArrowUp', 'Space', 'F1', 'Plus'); modifiers in any order, any case
//     when   'always' (default) | 'normal' (not in note entry) | 'entry' (note entry mode) | any other name for a narrower
//            context ('drag', 'Inspire panel', …) that only clashes with itself. 'always' overlaps 'normal' and 'entry'.
//     label  optional display text for a range ('A–G'); group optional heading in the help (defaults to the owner)
//   SV.shortcuts.remove(entry)  drops an entry register() returned (keys that change with a preference)
//   SV.shortcuts.list() -> [{ keys:[canonical], owner, desc, when, label }]   in registration order
//   SV.shortcuts.conflicts() -> [{ key, when, owners:[…] }]                   same key, overlapping contexts
// Also loads in Node (module.exports) for the unit test.
(function (root) {
  'use strict';
  const MODS = ['Ctrl', 'Alt', 'Shift'];
  const ALIASES = { control: 'Ctrl', ctrl: 'Ctrl', cmd: 'Ctrl', meta: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
    esc: 'Escape', escape: 'Escape', del: 'Delete', delete: 'Delete', space: 'Space', ' ': 'Space', '+': 'Plus', plus: 'Plus',
    '-': 'Minus', minus: 'Minus', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

  /** 'shift+alt+s' -> 'Alt+Shift+S'. A trailing '+' ('Ctrl++') means the Plus key. */
  function normalize(combo) {
    let s = String(combo).trim();
    let plusKey = false;
    if (s.endsWith('++')) { plusKey = true; s = s.slice(0, -2); } else if (s === '+') return 'Plus';
    const parts = s.split('+').map(p => p.trim()).filter(Boolean);
    const mods = new Set();
    let key = plusKey ? 'Plus' : null;
    parts.forEach(p => {
      const a = ALIASES[p.toLowerCase()] || p;
      if (MODS.includes(a)) mods.add(a);
      else key = a.length === 1 ? a.toUpperCase() : a[0].toUpperCase() + a.slice(1);
    });
    if (!key) throw new Error('shortcut without a key: ' + combo);
    return [...MODS.filter(m => mods.has(m)), key].join('+');
  }

  const overlaps = (a, b) => a === b || (a === 'always' && (b === 'normal' || b === 'entry')) ||
    (b === 'always' && (a === 'normal' || a === 'entry'));

  function createRegistry() {
    const entries = [];
    const listeners = [];
    function register(spec) {
      if (!spec || !spec.keys || !spec.owner) throw new Error('SV.shortcuts.register needs keys and owner');
      const e = {
        keys: (Array.isArray(spec.keys) ? spec.keys : [spec.keys]).map(normalize),
        owner: String(spec.owner), desc: String(spec.desc || ''), when: spec.when || 'always',
        label: spec.label || null, group: spec.group || null,
      };
      const clash = conflictsOf(e);
      if (clash.length && typeof console !== 'undefined')
        console.warn('Shortcut clash: ' + clash.map(c => `${c.key} (${c.when}) ${c.owners.join(' / ')}`).join('; '));
      entries.push(e);
      listeners.forEach(fn => { try { fn(e); } catch (err) { /* a broken listener must not stop registration */ } });
      return e;
    }
    function conflictsOf(e, among = entries) {
      const out = [];
      among.forEach(o => {
        if (o === e || !overlaps(o.when, e.when)) return;
        e.keys.filter(k => o.keys.includes(k)).forEach(k => out.push({ key: k, when: o.when === 'always' ? e.when : o.when, owners: [o.owner, e.owner] }));
      });
      return out;
    }
    function conflicts() {
      const out = [];
      entries.forEach((e, i) => out.push(...conflictsOf(e, entries.slice(0, i))));
      return out;
    }
    const list = () => entries.map(e => ({ ...e, keys: e.keys.slice() }));
    /** Removes an entry register() returned (a module whose keys change with a preference re-registers them). */
    function remove(e) {
      const i = entries.indexOf(e);
      if (i < 0) return false;
      entries.splice(i, 1);
      listeners.forEach(fn => { try { fn(e); } catch (err) { /* ignore */ } });
      return true;
    }
    /** Display text of an entry's keys: its label, else the keys joined with ' / '. */
    const keyText = e => e.label || e.keys.map(k => k.replace(/Arrow(Up|Down|Left|Right)/, (m, d) => ({ Up: '↑', Down: '↓', Left: '←', Right: '→' })[d])).join(' / ');
    return { register, remove, list, conflicts, normalize, keyText, onChange: fn => listeners.push(fn) };
  }

  const api = { createRegistry, normalize, overlaps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.SV || typeof document === 'undefined') return;

  const reg = createRegistry();
  root.SV.shortcuts = Object.assign(reg, { createRegistry });

  // ---- help: a table of every registered shortcut in the footer ("Shortcuts ▾"), grouped by context
  const CONTEXTS = { always: 'Everywhere', normal: 'Score (not in note entry)', entry: 'Note entry (N)' };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const kbd = e => reg.keyText(e).split(' / ').map(k => k.split('+').map(p => `<kbd>${esc(p)}</kbd>`).join('+')).join(' ');
  function renderHelp() {
    const help = document.getElementById('help');
    if (!help) return;
    let box = document.getElementById('svKeys');
    if (!box) { box = document.createElement('div'); box.id = 'svKeys'; help.appendChild(box); }
    const byWhen = new Map();
    reg.list().forEach(e => { if (!byWhen.has(e.when)) byWhen.set(e.when, []); byWhen.get(e.when).push(e); });
    const order = [...Object.keys(CONTEXTS).filter(w => byWhen.has(w)), ...[...byWhen.keys()].filter(w => !CONTEXTS[w])];
    box.innerHTML = '<div class="svk-title">All keyboard shortcuts</div>' + order.map(w =>
      `<div class="svk-ctx"><div class="svk-h">${esc(CONTEXTS[w] || w)}</div><table>` +
      byWhen.get(w).map(e => `<tr><td>${kbd(e)}</td><td>${esc(e.desc)}</td><td class="svk-own">${esc(e.group || e.owner)}</td></tr>`).join('') +
      '</table></div>').join('');
  }
  let pending = 0;
  reg.onChange(() => { if (!pending && document.readyState !== 'loading') pending = setTimeout(() => { pending = 0; renderHelp(); }, 0); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderHelp); else setTimeout(renderHelp, 0);
})(typeof window !== 'undefined' ? window : globalThis);
