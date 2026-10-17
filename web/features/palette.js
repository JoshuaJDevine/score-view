// Feature module: command palette (Ctrl+K or Ctrl+J) and the keyboard shortcut sheet (?).
// The palette searches every command the page offers, collected fresh each time it opens: toolbar and header buttons,
// segmented controls, checkboxes (toggle), each option of a select, the items of menus whose panels are in the page,
// and every SV.shortcuts entry (with its keys; runs it by sending the key). Fuzzy match on the words typed; with no
// query the recently run commands come first. Keyboard only: ↑/↓ (Tab) move, Enter runs, Esc closes.
// The sheet lists SV.shortcuts.list() grouped by task, with a filter.
// Preference: scoreview.palette.recent (the last 12 commands run).
// Also loads in Node (module.exports) for the unit test: fuzzyScore, rank, taskOf, groupByTask, keyInit, cleanLabel.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ pure helpers

  /**
   * How well `query` matches `text` (higher is better), or null. Every word of the query must match as a
   * subsequence (case-insensitive); consecutive letters, word starts and a whole-word prefix score higher.
   */
  function fuzzyScore(query, text) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    const t = String(text).toLowerCase();
    let total = 0;
    for (const w of words) {
      const s = wordScore(w, t);
      if (s == null) return null;
      total += s;
    }
    return total;
  }
  const isStart = (t, i) => i === 0 || /[\s\-–:·/(▸,.]/.test(t[i - 1]);
  // A word matches as a substring, or letter by letter where each letter either follows the previous one or starts a
  // word ("hks" → Hide KeySwitches); letters scattered inside words do not match.
  function wordScore(w, t) {
    const at = t.indexOf(w);
    if (at >= 0) return 10 * w.length + (isStart(t, at) ? 8 : 0) + (at === 0 ? 4 : 0);
    const memo = new Map();
    const best = (i, j) => { // w[i..] placed from t[j..]; the previous letter sat at j - 1
      if (i === w.length) return 0;
      const key = i * 4096 + j;
      if (memo.has(key)) return memo.get(key);
      let out = null;
      for (let p = j; p < t.length; p++) {
        if (t[p] !== w[i]) continue;
        const next = i > 0 && p === j ? 3 : isStart(t, p) ? 4 : -1;
        if (next < 0) continue;
        const rest = best(i + 1, p + 1);
        if (rest != null && (out == null || next + rest > out)) out = next + rest;
      }
      memo.set(key, out);
      return out;
    };
    return best(0, 0);
  }

  /**
   * Orders commands for the list. cmds: [{ id, text (searched), ... }], recent: [id] newest first.
   * Empty query: recent commands first (newest first), then the rest in their order. Otherwise the matches by score
   * (a recently run command gets a small bonus), ties in their order.
   */
  function rank(cmds, query, recent) {
    const rec = new Map((recent || []).map((id, i) => [id, i]));
    const q = String(query || '').trim();
    if (!q) {
      const first = cmds.filter(c => rec.has(c.id)).sort((a, b) => rec.get(a.id) - rec.get(b.id));
      return first.concat(cmds.filter(c => !rec.has(c.id)));
    }
    return cmds.map((c, i) => ({ c, i, s: fuzzyScore(q, c.text) }))
      .filter(x => x.s != null)
      .map(x => ({ ...x, s: x.s + (rec.has(x.c.id) ? 6 - Math.min(5, rec.get(x.c.id)) : 0) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map(x => x.c);
  }

  /** Task headings for the shortcut sheet, by the owner (module) that registered a shortcut. */
  const TASKS = [
    ['Select and edit notes', ['core', 'mouse']],
    ['Note entry', ['entry']],
    ['Articulations and dynamics', ['articulations']],
    ['Rhythm and harmony', ['rhythm', 'harmony']],
    ['Develop and orchestrate', ['motifs', 'orchestrate', 'inspire']],
    ['Playback', ['playback']],
    ['Controller', ['controller']],
    ['App', ['palette', 'print', 'toasts', 'layout']],
  ];
  const taskOf = e => { const t = TASKS.find(([, owners]) => owners.includes(e.owner)); return t ? t[0] : 'Other'; };
  /** [{ task, entries }] in TASKS order (then Other), each entry list in registration order. */
  function groupByTask(list) {
    const by = new Map();
    list.forEach(e => { const t = taskOf(e); if (!by.has(t)) by.set(t, []); by.get(t).push(e); });
    return [...TASKS.map(([t]) => t), 'Other'].filter(t => by.has(t)).map(task => ({ task, entries: by.get(task) }));
  }

  /** KeyboardEvent init for a canonical combo ('Alt+Shift+S', 'Space', 'ArrowUp', 'Escape', 'Plus'). */
  function keyInit(combo) {
    const parts = combo.split('+');
    let key = parts.pop();
    if (key === '' && combo.endsWith('+')) key = 'Plus';
    const mods = new Set(parts);
    const init = { bubbles: true, cancelable: true, ctrlKey: mods.has('Ctrl'), altKey: mods.has('Alt'), shiftKey: mods.has('Shift') };
    if (key.length === 1 && /[A-Z]/.test(key)) return { ...init, key: init.shiftKey ? key : key.toLowerCase(), code: 'Key' + key };
    if (key.length === 1 && /[0-9]/.test(key)) return { ...init, key, code: 'Digit' + key };
    const named = { Space: [' ', 'Space'], Plus: ['+', 'Equal'], Minus: ['-', 'Minus'], Period: ['.', 'Period'] };
    if (named[key]) return { ...init, key: named[key][0], code: named[key][1] };
    return { ...init, key, code: key.length === 1 ? '' : key };
  }

  /** Button / label text for the list: single-spaced, without the ▾ ▴ … decorations. */
  const cleanLabel = s => String(s || '').replace(/\s+/g, ' ').replace(/[▾▴]/g, '').replace(/…$/, '').trim();

  const api = { fuzzyScore, rank, TASKS, taskOf, groupByTask, keyInit, cleanLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const SV = root.SV;
  if (!SV || typeof document === 'undefined') return;

  // ------------------------------------------------------------------ page

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const RECENT_KEY = 'scoreview.palette.recent';
  const loadRecent = () => { try { const v = JSON.parse(localStorage.getItem(RECENT_KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const saveRecent = r => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch (e) { /* ignore */ } };

  SV.addStyle(`
    .svpl-back { position: fixed; inset: 0; background: #0006; z-index: var(--sv-z-palette); display: flex; justify-content: center;
      align-items: flex-start; padding-top: 11vh; }
    .svpl-box { width: min(640px, 92vw); background: var(--sv-surface-1); border: 1px solid var(--sv-border);
      border-radius: var(--sv-radius-lg); box-shadow: var(--sv-shadow-dlg); display: flex; flex-direction: column; max-height: 72vh;
      overflow: hidden; color: var(--sv-text); }
    .svpl-box input[type=text] { font: var(--sv-fs-title) var(--sv-font); padding: 12px 14px; border: 0; border-bottom: 1px solid var(--sv-border);
      background: transparent; color: var(--sv-text-strong); outline: none; }
    .svpl-list { overflow: auto; padding: var(--sv-space-2) 0; margin: 0; list-style: none; }
    .svpl-item { display: flex; align-items: center; gap: var(--sv-space-4); padding: 6px 14px; cursor: pointer; }
    .svpl-item[aria-selected="true"] { background: var(--sv-surface-raised); box-shadow: inset 3px 0 0 var(--sv-accent); }
    .svpl-item .svpl-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .svpl-item .svpl-ctx { color: var(--sv-text-dim); font-size: var(--sv-fs-small); }
    .svpl-item .svpl-state { color: var(--sv-text-dim); font-size: var(--sv-fs-small); min-width: 2.2em; text-align: right; }
    .svpl-item .svpl-state.on { color: var(--sv-ok); }
    .svpl-item.svpl-info .svpl-label { color: var(--sv-text-dim); }
    .svpl-item.svpl-recent .svpl-label::before { content: '↺ '; color: var(--sv-text-faint); }
    .svpl-box kbd, .svk-sheet kbd { font: var(--sv-fs-small) var(--sv-font-mono); background: var(--sv-surface-3); border: 1px solid var(--sv-border);
      border-radius: 3px; padding: 0 4px; color: var(--sv-text); white-space: nowrap; }
    .svpl-foot { display: flex; gap: var(--sv-space-6); padding: 6px 14px; border-top: 1px solid var(--sv-border); color: var(--sv-text-dim);
      font-size: var(--sv-fs-small); }
    .svpl-empty { padding: 14px; color: var(--sv-text-dim); }
    #svPaletteBtn { color: var(--sv-text-dim); gap: var(--sv-space-3); }
    #svPaletteBtn kbd { font: var(--sv-fs-small) var(--sv-font-mono); color: var(--sv-text-faint); }
    .svk-sheet { width: min(1100px, 94vw); max-height: 82vh; }
    .svk-sheet .svk-cols { overflow: auto; padding: var(--sv-space-4) 14px; columns: 3 300px; column-gap: 28px; }
    .svk-sheet .svk-task { break-inside: avoid; margin-bottom: 12px; }
    .svk-sheet h3 { margin: 4px 0; font-size: var(--sv-fs-label); letter-spacing: .08em; text-transform: uppercase; color: var(--sv-text-dim); }
    .svk-sheet table { border-collapse: collapse; width: 100%; font-size: var(--sv-fs-control); }
    .svk-sheet td { padding: 2px 6px 2px 0; vertical-align: top; }
    .svk-sheet td:first-child { white-space: nowrap; width: 1%; }
    .svk-sheet .svk-when { color: var(--sv-text-faint); font-size: var(--sv-fs-small); }
  `);

  // ---- collecting commands from the page
  const SEG_NAMES = { modeSeg: 'Mode', srcSeg: 'Source', rangeSeg: 'Bars', layoutSeg: 'Layout', svSectionSeg: 'Section', svOrderSeg: 'Order' };
  const SCOPES = () => [document.querySelector('body > header'), $('featureBar'), $('svStatusBar'), $('svViewPanel'), $('svFilePanel'), $('svlReadPop')]
    .filter(Boolean);
  // A closed menu panel still offers its items (they run without opening it); anything else hidden is not available.
  const isMenuPanel = el => el.matches('.svl-pop, #trackPanel, [id$="Panel"], [id$="Pop"], [id$="Menu"], [id$="pop"]');
  function available(el, scope) {
    for (let x = el; x && x !== scope.parentElement; x = x.parentElement) {
      const hidden = x.hidden || x.classList.contains('hidden') || (x.style && x.style.display === 'none');
      if (hidden && !(x !== el && isMenuPanel(x))) return false;
    }
    return !el.disabled;
  }
  function menuOf(el, scope) {
    for (let x = el.parentElement; x && x !== scope; x = x.parentElement) {
      if (x.dataset && x.dataset.svlMenu) return x.dataset.svlMenu;
      if (isMenuPanel(x)) {
        const opener = x.parentElement && x.parentElement.querySelector(':scope > button, :scope > .btn');
        if (opener && opener !== el) return cleanLabel(opener.textContent);
      }
    }
    return null;
  }
  function areaOf(el) {
    const c = el.closest('.svl-cluster');
    if (c && c.querySelector('.svl-label')) return c.querySelector('.svl-label').textContent;
    if (el.closest('#svStatusBar')) return 'Status bar';
    return 'Header';
  }
  const textOf = el => {
    const t = cleanLabel(el.textContent);
    return t.length > 2 ? t : cleanLabel(el.title || el.getAttribute('aria-label') || t).split(/[.(:]/)[0].trim();
  };
  function labelFor(input) {
    if (input.id) { const l = document.querySelector(`label[for="${input.id}"]`); if (l) return cleanLabel(l.textContent); }
    const l = input.closest('label');
    if (l) {
      const copy = l.cloneNode(true);
      copy.querySelectorAll('select, small, option').forEach(x => x.remove());
      const t = cleanLabel(copy.textContent);
      if (t) return t;
    }
    const prev = input.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return cleanLabel(prev.textContent);
    return cleanLabel(input.title || input.getAttribute('aria-label') || input.id || '').split(/[.(]/)[0].trim();
  }

  function collect() {
    const cmds = [], seen = new Set();
    const add = c => { if (!c.label || seen.has(c.id)) return; seen.add(c.id); c.text = [c.ctx, c.label, c.keys || ''].join(' '); cmds.push(c); };
    SCOPES().forEach(scope => {
      scope.querySelectorAll('button, input[type=checkbox], input[type=radio], select').forEach(el => {
        if (el.closest('#svToastPop') || el.id === 'svPaletteBtn' || !available(el, scope)) return;
        const menu = menuOf(el, scope), area = areaOf(el);
        const ctx = menu || area;
        if (el.tagName === 'BUTTON') {
          const seg = el.parentElement && el.parentElement.classList.contains('seg') ? el.parentElement : null;
          let label = textOf(el);
          if (seg) label = (SEG_NAMES[seg.id] ? SEG_NAMES[seg.id] + ': ' : '') + label;
          if (!label) return;
          add({ id: 'btn:' + (el.id || ctx + ':' + label), kind: 'button', label, ctx, el,
            state: seg ? (el.classList.contains('on') ? '✓' : '') : '' });
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          const label = labelFor(el);
          add({ id: el.type + ':' + (el.id || ctx + ':' + label), kind: el.type, label, ctx, el, state: el.checked ? 'on' : (el.type === 'checkbox' ? 'off' : '') });
        } else if (el.tagName === 'SELECT') {
          const name = labelFor(el) || ctx;
          [...el.options].forEach(o => {
            if (o.disabled) return;
            const label = name + ': ' + cleanLabel(o.textContent);
            add({ id: 'opt:' + (el.id || ctx + ':' + name) + '=' + o.value, kind: 'option', label, ctx, el, value: o.value, state: el.value === o.value ? '✓' : '' });
          });
        }
      });
    });
    add({ id: 'app:sheet', kind: 'app', label: 'Keyboard shortcuts (sheet)', ctx: 'App', keys: '?', run: openSheet });
    if (SV.toasts) add({ id: 'app:messages', kind: 'app', label: 'Message history', ctx: 'App', run: () => SV.toasts.open() });
    if (SV.layout && SV.layout.setHeader) {
      const other = SV.layout.header() === 'compact' ? 'classic' : 'compact';
      add({ id: 'app:header-' + other, kind: 'app', label: 'Header layout: ' + other, ctx: 'View', run: () => SV.layout.setHeader(other) });
    }
    if (SV.shortcuts) {
      const entryOn = !!(SV.entry && SV.entry.state && SV.entry.state.on);
      SV.shortcuts.list().forEach(e => {
        if (e.owner === 'palette') return;
        const keys = SV.shortcuts.keyText(e);
        const live = !e.label && (e.when === 'always' || (e.when === 'normal' && !entryOn) || (e.when === 'entry' && entryOn));
        const label = e.desc.charAt(0).toUpperCase() + e.desc.slice(1);
        add({ id: 'key:' + e.owner + ':' + e.desc, kind: live ? 'key' : 'info', label, ctx: e.group || e.owner, keys, combo: e.keys[0], when: e.when });
      });
    }
    return cmds;
  }

  // ---- running
  function run(c) {
    if (c.run) return c.run();
    if (c.kind === 'info') {
      const where = { normal: ' (outside note entry)', entry: ' (in note entry)', always: '' }[c.when];
      SV.flash('Press ' + c.keys + (where != null ? where : ' (' + c.when + ')'));
      return;
    }
    if (c.kind === 'key') {
      const main = $('main');
      if (main) main.focus();
      (main || document.body).dispatchEvent(new KeyboardEvent('keydown', keyInit(c.combo)));
      return;
    }
    const el = c.el;
    if (!el || !el.isConnected) { SV.flash(c.label + ' is not available now'); return; }
    if (c.kind === 'option') {
      el.value = c.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.click();
    if (c.kind === 'checkbox') SV.flash(c.label + ': ' + (el.checked ? 'on' : 'off'));
  }

  // ---- the palette
  let pal = null; // { back, input, list, cmds, shown, idx }
  const MAX = 80;

  function open() {
    if (pal) { pal.input.select(); return; }
    closeSheet();
    const back = document.createElement('div');
    back.className = 'svpl-back';
    back.id = 'svPalette';
    back.innerHTML = '<div class="svpl-box" role="dialog" aria-label="Command palette">' +
      '<input type="text" id="svPaletteInput" placeholder="Type a command, setting or shortcut…" autocomplete="off" spellcheck="false" ' +
      'role="combobox" aria-expanded="true" aria-controls="svPaletteList">' +
      '<ul class="svpl-list" id="svPaletteList" role="listbox"></ul>' +
      '<div class="svpl-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span>' +
      '<span><kbd>?</kbd> all shortcuts</span></div></div>';
    document.body.appendChild(back);
    pal = { back, input: back.querySelector('input'), list: back.querySelector('ul'), cmds: collect(), shown: [], idx: 0, prevFocus: document.activeElement };
    pal.input.addEventListener('input', () => { pal.idx = 0; update(); });
    pal.input.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', e => { if (e.target === back) { e.preventDefault(); close(); } });
    pal.list.addEventListener('mousedown', e => e.preventDefault()); // keep the focus in the input
    pal.list.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i); });
    update();
    pal.input.focus();
  }
  function close() {
    if (!pal) return;
    const prev = pal.prevFocus;
    pal.back.remove();
    pal = null;
    if (prev && prev.isConnected && prev !== document.body && prev.tagName !== 'INPUT') prev.focus(); else { const m = $('main'); if (m) m.focus(); }
  }
  function update() {
    const recent = loadRecent();
    const q = pal.input.value;
    pal.shown = rank(pal.cmds, q, recent).slice(0, MAX);
    const rec = new Set(recent);
    pal.list.innerHTML = pal.shown.length ? pal.shown.map((c, i) =>
      `<li class="svpl-item${c.kind === 'info' ? ' svpl-info' : ''}${!q && rec.has(c.id) ? ' svpl-recent' : ''}" role="option" id="svpl-${i}" data-i="${i}" data-id="${esc(c.id)}"` +
      ` aria-selected="${i === pal.idx}"><span class="svpl-label">${esc(c.label)}</span>` +
      `<span class="svpl-ctx">${esc(c.ctx || '')}</span>` +
      (c.keys ? `<span>${c.keys.split(' / ').map(k => `<kbd>${esc(k)}</kbd>`).join(' ')}</span>` : '') +
      (c.state ? `<span class="svpl-state${c.state === 'on' ? ' on' : ''}">${esc(c.state)}</span>` : '') + '</li>').join('')
      : '<li class="svpl-empty">No command matches.</li>';
    mark();
  }
  function mark() {
    pal.idx = Math.max(0, Math.min(pal.idx, pal.shown.length - 1));
    pal.list.querySelectorAll('li[data-i]').forEach(li => li.setAttribute('aria-selected', String(+li.dataset.i === pal.idx)));
    const cur = pal.list.querySelector(`li[data-i="${pal.idx}"]`);
    pal.input.setAttribute('aria-activedescendant', cur ? cur.id : '');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function onKey(e) {
    e.stopPropagation(); // the score's shortcuts must not see keys typed here
    const k = e.key;
    if (k === 'ArrowDown' || (k === 'Tab' && !e.shiftKey)) { pal.idx++; if (pal.idx >= pal.shown.length) pal.idx = 0; mark(); e.preventDefault(); }
    else if (k === 'ArrowUp' || (k === 'Tab' && e.shiftKey)) { pal.idx--; if (pal.idx < 0) pal.idx = pal.shown.length - 1; mark(); e.preventDefault(); }
    else if (k === 'PageDown') { pal.idx += 8; mark(); e.preventDefault(); }
    else if (k === 'PageUp') { pal.idx -= 8; mark(); e.preventDefault(); }
    else if (k === 'Enter') { choose(pal.idx); e.preventDefault(); }
    else if (k === 'Escape') { close(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyK' || e.code === 'KeyJ')) { close(); e.preventDefault(); }
  }
  function choose(i) {
    const c = pal && pal.shown[i];
    if (!c) return;
    const recent = loadRecent().filter(id => id !== c.id);
    recent.unshift(c.id);
    saveRecent(recent.slice(0, 12));
    close();
    setTimeout(() => { try { run(c); } catch (err) { console.error('palette', err); SV.flash('Could not run ' + c.label); } }, 0);
  }

  // ---- the shortcut sheet
  let sheet = null;
  const WHEN = { always: '', normal: 'not in entry', entry: 'in entry' };
  function sheetHtml(filter) {
    const q = String(filter || '').trim();
    const list = SV.shortcuts.list().filter(e => !q || fuzzyScore(q, [e.desc, SV.shortcuts.keyText(e), e.owner, taskOf(e)].join(' ')) != null);
    const kb = e => SV.shortcuts.keyText(e).split(' / ').map(k => `<kbd>${esc(k)}</kbd>`).join(' ');
    const groups = groupByTask(list);
    return groups.length ? groups.map(g => `<div class="svk-task"><h3>${esc(g.task)}</h3><table>` + g.entries.map(e =>
      `<tr><td>${kb(e)}</td><td>${esc(e.desc)}${WHEN[e.when] === '' || (e.when === 'entry' && g.task === 'Note entry') ? ''
        : ` <span class="svk-when">${esc(WHEN[e.when] || e.when)}</span>`}</td></tr>`).join('') +
      '</table></div>').join('') : '<div class="svpl-empty">No shortcut matches.</div>';
  }
  function openSheet() {
    if (sheet) return;
    close();
    const back = document.createElement('div');
    back.className = 'svpl-back';
    back.id = 'svKeySheet';
    back.innerHTML = '<div class="svpl-box svk-sheet" role="dialog" aria-label="Keyboard shortcuts">' +
      '<input type="text" id="svKeySheetFilter" placeholder="Keyboard shortcuts — type to filter" autocomplete="off" spellcheck="false">' +
      `<div class="svk-cols" id="svKeySheetBody">${sheetHtml('')}</div>` +
      '<div class="svpl-foot"><span><kbd>Esc</kbd> close</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd> run a command</span></div></div>';
    document.body.appendChild(back);
    sheet = back;
    const input = back.querySelector('input');
    input.addEventListener('input', () => { $('svKeySheetBody').innerHTML = sheetHtml(input.value); });
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === '?' && !input.value)) { closeSheet(); e.preventDefault(); }
      else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyK' || e.code === 'KeyJ')) { closeSheet(); open(); e.preventDefault(); }
    });
    back.addEventListener('mousedown', e => { if (e.target === back) { e.preventDefault(); closeSheet(); } });
    input.focus();
  }
  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    const m = $('main');
    if (m) m.focus();
  }

  // ---- keys: a capture listener, so they work in note entry and from any control
  const typing = t => t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT' && !/^(checkbox|radio|range|button)$/.test(t.type)));
  document.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.code === 'KeyJ')) {
      if (pal || sheet) return; // their own inputs handle it
      e.preventDefault(); e.stopPropagation();
      open();
    } else if (e.key === '?' && !ctrl && !e.altKey && !pal && !sheet && !typing(e.target)) {
      e.preventDefault(); e.stopPropagation();
      openSheet();
    }
  }, true);
  SV.shortcuts.register({ keys: ['Ctrl+K', 'Ctrl+J'], owner: 'palette', group: 'app', desc: 'command palette: find and run any command or setting' });
  SV.shortcuts.register({ keys: '?', owner: 'palette', group: 'app', desc: 'keyboard shortcut sheet' });

  // ---- header button (features/layout.js places it)
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.id = 'svPaletteBtn';
  btn.title = 'Find and run any command or setting (Ctrl+K or Ctrl+J). ? shows every keyboard shortcut.';
  btn.innerHTML = '⌕ Commands <kbd>Ctrl K</kbd>';
  btn.addEventListener('click', () => { btn.blur(); open(); });
  const status = $('status');
  if (status) status.parentNode.insertBefore(btn, status);

  SV.palette = Object.assign({}, api, { open, close, isOpen: () => !!pal, commands: collect, run, openSheet, closeSheet,
    sheetOpen: () => !!sheet, recent: loadRecent });
})(typeof window !== 'undefined' ? window : globalThis);
