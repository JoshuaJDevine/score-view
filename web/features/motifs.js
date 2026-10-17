// Feature module: motifs. See docs/AGENTS.md for the SV hook API.
// Treats the selected live notes as a figure and develops it: sequence, inversion, retrograde,
// augmentation/diminution, octave/third/sixth doubling, and a library of saved motifs.
// The pure motif logic (Core) also loads in Node for unit tests: require('web/features/motifs.js').
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ pure core

  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  const tonicOf = fifths => (((fifths || 0) * 7) % 12 + 12) % 12;
  const key = n => n.ch + '_' + n.x + '_' + n.y;
  const idOf = n => 'L' + key(n);
  const stepsOf = (d, spb) => Math.max(1, Math.round(d * spb));
  const fmt = v => String(Math.round(v * 1e6) / 1e6);
  const byTime = (a, b) => a.x - b.x || a.y - b.y;

  // Pitch -> { d: diatonic number in the major key, alt: semitones above that scale tone }.
  // Chromatic notes are spelled as the scale tone below plus a sharp, so they survive diatonic moves.
  function toDia(p, fifths) {
    const t = tonicOf(fifths), rel = p - t;
    const oct = Math.floor(rel / 12), r = rel - oct * 12;
    let i = 6;
    while (SCALE[i] > r) i--;
    return { d: oct * 7 + i, alt: r - SCALE[i] };
  }
  function fromDia(d, alt, fifths) {
    const oct = Math.floor(d / 7), i = d - oct * 7;
    return tonicOf(fifths) + oct * 12 + SCALE[i] + (alt || 0);
  }
  const diaShift = (p, steps, fifths) => { const q = toDia(p, fifths); return fromDia(q.d + steps, q.alt, fifths); };

  // Figure start/end in steps (end = latest note end).
  function bounds(notes, spb) {
    let s = Infinity, e = -Infinity;
    notes.forEach(n => { s = Math.min(s, n.x); e = Math.max(e, n.x + stepsOf(n.d, spb)); });
    return { s, e };
  }
  // Figure length rounded up to whole beats (at least one beat): where a sequence copy starts.
  const beatLen = (notes, spb) => { const b = bounds(notes, spb); return Math.max(1, Math.ceil((b.e - b.s) / spb - 1e-6)) * spb; };

  const snapWith = (snap, spb) => (p, x) => snap ? snap(p, x / spb) : p;

  // Each op returns { moves: [{from, to}] } (in place) or { adds: [note] } (new notes).
  const ops = {
    sequence(sel, { spb, fifths, dir = 1, snap }) {
      const off = beatLen(sel, spb), sn = snapWith(snap, spb);
      return { adds: sel.map(n => ({ ...n, x: n.x + off, y: sn(diaShift(n.y, dir, fifths), n.x + off) })) };
    },
    invert(sel, { spb, fifths, chromatic, snap }) {
      const sorted = [...sel].sort(byTime), axis = sorted[0], sn = snapWith(snap, spb);
      const a = toDia(axis.y, fifths);
      return { moves: sel.map(n => {
        if (n === axis) return { from: n, to: { ...n } };
        if (chromatic) return { from: n, to: { ...n, y: 2 * axis.y - n.y } };
        const q = toDia(n.y, fifths);
        return { from: n, to: { ...n, y: sn(fromDia(2 * a.d - q.d, a.alt * 2 - q.alt, fifths), n.x) } };
      }) };
    },
    retrograde(sel, { spb }) {
      const { s, e } = bounds(sel, spb);
      return { moves: sel.map(n => ({ from: n, to: { ...n, x: s + e - (n.x + stepsOf(n.d, spb)) } })) };
    },
    scaleTime(sel, { spb, factor }) {
      const { s } = bounds(sel, spb);
      return { moves: sel.map(n => ({ from: n, to: { ...n, x: s + Math.round((n.x - s) * factor), d: Math.max(1 / spb, n.d * factor) } })) };
    },
    transpose(sel, { semis }) {
      return { adds: sel.map(n => ({ ...n, y: n.y + semis })) };
    },
    diatonic(sel, { spb, fifths, steps, snap }) {
      const sn = snapWith(snap, spb);
      return { adds: sel.map(n => ({ ...n, y: sn(diaShift(n.y, steps, fifths), n.x) })) };
    },
  };

  // Motif library entries: rhythm (beats from the first onset, durations) + intervals from the first note,
  // both diatonic (steps + alteration) and chromatic (semitones).
  function makeMotif(name, sel, spb, fifths) {
    const sorted = [...sel].sort(byTime), first = sorted[0], f = toDia(first.y, fifths);
    return {
      name, fifths, pitch: first.y, created: Date.now(),
      notes: sorted.map(n => {
        const q = toDia(n.y, fifths);
        return { on: (n.x - first.x) / spb, dur: n.d, vel: n.vel, semis: n.y - first.y, steps: q.d - f.d, alt: q.alt - f.alt };
      }),
    };
  }
  // Realises a saved motif starting at step x on pitch `pitch`, transposed diatonically in the current key.
  function placeMotif(m, { x, pitch, ch = 0, spb, fifths, snap, chromatic }) {
    const p0 = toDia(pitch, fifths), sn = snapWith(snap, spb);
    return { adds: m.notes.map(n => {
      const nx = x + Math.round(n.on * spb);
      const y = chromatic ? pitch + n.semis : sn(fromDia(p0.d + n.steps, p0.alt + n.alt, fifths), nx);
      return { ch, x: nx, y, d: n.dur, vel: n.vel == null ? 100 : n.vel };
    }) };
  }

  const valid = n => n.x >= 0 && n.y >= 0 && n.y <= 127 && Number.isInteger(n.x) && Number.isInteger(n.y);

  // Turns an op result into edit lines for the clip, safely ordered:
  //  * deletes first (merged/rewritten sources), then moves in an order where no note lands on one that
  //    has not moved away yet (cycles fall back to delete + add), then adds;
  //  * notes whose duration changes are rewritten (del + add) since Bitwig can't address a just-moved note;
  //  * targets that land on a note that stays put are not written (the pitch is already sounding there).
  // Returns { lines, ids (resulting notes of the figure), notes (expected clip), skipped, merged } or { error }.
  function plan(clip, { moves = [], adds = [] }) {
    const bad = moves.filter(m => !valid(m.to)).length;
    if (bad) return { error: bad + ' note' + (bad > 1 ? 's' : '') + ' would leave the clip or the MIDI range' };
    const sources = new Set(moves.map(m => key(m.from)));
    const stationary = new Map(clip.filter(n => !sources.has(key(n))).map(n => [key(n), n]));
    const taken = new Set(), ids = [], dels = [], moveList = [], addList = [];
    let skipped = 0, merged = 0;
    moves.forEach(m => {
      const k = key(m.to);
      const same = k === key(m.from) && Math.abs(m.to.d - m.from.d) < 1e-9;
      if (stationary.has(k) || taken.has(k)) { dels.push(m.from); merged++; if (!taken.has(k)) ids.push(k); taken.add(k); return; }
      taken.add(k); ids.push(k);
      if (same) return;
      if (Math.abs(m.to.d - m.from.d) > 1e-9) { dels.push(m.from); addList.push(m.to); } else moveList.push(m);
    });
    adds.forEach(n => {
      const k = key(n);
      if (!valid(n)) { skipped++; return; }
      if (taken.has(k)) return;
      taken.add(k); ids.push(k);
      if (stationary.has(k)) { skipped++; return; }
      addList.push(n);
    });

    const lines = dels.map(n => `del ${n.ch} ${n.x} ${n.y}`);
    const occupied = new Set(clip.map(key));
    dels.forEach(n => occupied.delete(key(n)));
    let pending = moveList;
    while (pending.length) {
      const ready = pending.filter(m => !occupied.has(key(m.to)));
      if (ready.length) {
        // A ready move may free the target of another; emit one at a time.
        const m = ready[0];
        lines.push(`move ${m.from.ch} ${m.from.x} ${m.from.y} ${m.to.x - m.from.x} ${m.to.y - m.from.y}`);
        occupied.delete(key(m.from)); occupied.add(key(m.to));
        pending = pending.filter(p => p !== m);
      } else {
        const m = pending[0]; // cycle: take one note out and write it back at the end
        lines.push(`del ${m.from.ch} ${m.from.x} ${m.from.y}`);
        occupied.delete(key(m.from));
        addList.unshift(m.to);
        pending = pending.slice(1);
      }
    }
    addList.forEach(n => lines.push(`add ${n.ch} ${n.x} ${n.y} ${Math.round(n.vel == null ? 100 : n.vel)} ${fmt(n.d)}`));

    const result = new Map(stationary);
    moves.forEach(m => { const k = key(m.to); if (!result.has(k)) result.set(k, { ...m.to }); });
    adds.forEach(n => { const k = key(n); if (valid(n) && !result.has(k)) result.set(k, { ...n }); });
    return { lines, ids: ids.map(k => 'L' + k), notes: [...result.values()].sort(byTime), skipped, merged };
  }

  const Core = { toDia, fromDia, diaShift, bounds, beatLen, ops, makeMotif, placeMotif, plan, idOf };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
  const SV = root.SV;
  if (!SV) return;

  // ------------------------------------------------------------------ page integration

  const LIB_KEY = 'scoreview.motifs.library';
  const PREF_KEY = 'scoreview.motifs.prefs';
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const prefs = Object.assign({ harmony: 'off' }, load(PREF_KEY, {}));

  // Expected clip contents after our last edit, used until Bitwig reports a newer version
  // (so fast repeated presses chain correctly), and ids to keep selected while the edit lands.
  let expected = null, want = null;

  const spb = () => (SV.state.liveData && SV.state.liveData.stepsPerBeat) || 24;
  const fifths = () => (SV.state.render ? SV.state.render.keyFifths : 0) || 0;
  function clipNotes() {
    const d = SV.state.liveData;
    if (!d || !d.exists) return [];
    if (expected && expected.v === d.v) return expected.notes;
    return d.notes.map(n => ({ ch: n.ch, x: n.x, y: n.y, d: n.d, vel: n.vel }));
  }
  function selectedNotes() {
    const byId = new Map(clipNotes().map(n => [idOf(n), n]));
    return [...SV.state.selection].filter(SV.isLive).map(id => byId.get(id)).filter(Boolean);
  }
  function harmonySnap() {
    const h = root.SV.harmony;
    if (prefs.harmony === 'off' || !h || typeof h.snap !== 'function') return null;
    return (p, beat) => {
      // beat is clip-relative; SV.harmony works in rendered (arrangement) beats, so add the clip's placement in Score mode.
      const st = root.SV.state, off = root.SV.contentOrigin ? root.SV.contentOrigin() : (st.mode === 'score' && st.align ? st.align.offset : 0);
      try { const q = h.snap(p, beat + off, prefs.harmony); return Number.isFinite(q) ? Math.round(q) : p; } catch (e) { return p; }
    };
  }

  function commit(result, label) {
    const r = plan(clipNotes(), result);
    if (r.error) { SV.flash(label + ': ' + r.error + ' — nothing changed'); return false; }
    if (r.lines.length) SV.send(r.lines);
    const d = SV.state.liveData;
    expected = { v: d && d.v, notes: r.notes };
    want = { ids: new Set(r.ids), until: Date.now() + 4000 };
    SV.state.selection = new Set(r.ids);
    SV.paintSelection();
    const extra = [];
    if (r.merged) extra.push(r.merged + ' merged with existing notes');
    if (r.skipped) extra.push(r.skipped + ' skipped (already there or out of range)');
    SV.flash(label + ' — ' + r.ids.length + ' note' + (r.ids.length === 1 ? '' : 's') + (extra.length ? ' · ' + extra.join(', ') : ''));
    return true;
  }

  function run(name) {
    const a = ACTIONS[name];
    if (!a) return false;
    if (a.noSel) { a.fn(); return true; }
    const sel = selectedNotes();
    if (!sel.length) { SV.flash('Motif: select some notes first'); return true; }
    const ctx = { spb: spb(), fifths: fifths(), snap: a.harmonic ? harmonySnap() : null };
    commit(a.fn(sel, ctx), a.label + (ctx.snap ? ' (fit to ' + prefs.harmony + ')' : ''));
    return true;
  }

  const ACTIONS = {
    seqUp: { label: 'Sequence up a step', key: 'Alt+S', harmonic: true, fn: (s, c) => ops.sequence(s, { ...c, dir: 1 }) },
    seqDown: { label: 'Sequence down a step', key: 'Alt+Shift+S', harmonic: true, fn: (s, c) => ops.sequence(s, { ...c, dir: -1 }) },
    invert: { label: 'Invert (diatonic)', key: 'Alt+I', harmonic: true, fn: (s, c) => ops.invert(s, c) },
    invertChrom: { label: 'Invert (chromatic)', key: 'Alt+Shift+I', fn: (s, c) => ops.invert(s, { ...c, chromatic: true }) },
    retro: { label: 'Retrograde', key: 'Alt+R', fn: (s, c) => ops.retrograde(s, c) },
    augment: { label: 'Augment ×2', key: 'Alt+A', fn: (s, c) => ops.scaleTime(s, { ...c, factor: 2 }) },
    diminish: { label: 'Diminish ÷2', key: 'Alt+D', fn: (s, c) => ops.scaleTime(s, { ...c, factor: 0.5 }) },
    octUp: { label: 'Double octave above', key: 'Alt+O', fn: (s, c) => ops.transpose(s, { ...c, semis: 12 }) },
    octDown: { label: 'Double octave below', key: 'Alt+Shift+O', fn: (s, c) => ops.transpose(s, { ...c, semis: -12 }) },
    thirdUp: { label: 'Add third above', key: 'Alt+3', harmonic: true, fn: (s, c) => ops.diatonic(s, { ...c, steps: 2 }) },
    third: { label: 'Add third below', key: 'Alt+Shift+3', harmonic: true, fn: (s, c) => ops.diatonic(s, { ...c, steps: -2 }) },
    sixthUp: { label: 'Add sixth above', key: 'Alt+6', harmonic: true, fn: (s, c) => ops.diatonic(s, { ...c, steps: 5 }) },
    sixth: { label: 'Add sixth below', key: 'Alt+Shift+6', harmonic: true, fn: (s, c) => ops.diatonic(s, { ...c, steps: -5 }) },
    saveMotif: { label: 'Save selection as motif…', key: 'Alt+M', noSel: true, fn: () => openSave() },
  };
  const KEYMAP = {
    KeyS: e => e.shiftKey ? 'seqDown' : 'seqUp', KeyI: e => e.shiftKey ? 'invertChrom' : 'invert',
    KeyR: () => 'retro', KeyA: () => 'augment', KeyD: () => 'diminish',
    KeyO: e => e.shiftKey ? 'octDown' : 'octUp', KeyM: () => 'saveMotif',
  };
  const INTERVAL_NAMES = { 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh', 8: 'octave', 9: 'ninth' };
  // Alt+2…9 (Shift: below): a diatonic interval added to every selected note, as in Sibelius / Dorico (Alt+3 = third above).
  // In note entry the entry module takes these keys for the note just entered (features/entry.js).
  function addInterval(n, dir) {
    if (!INTERVAL_NAMES[n]) return false;
    const sel = selectedNotes();
    if (!sel.length) { SV.flash('Motif: select some notes first'); return true; }
    const snap = harmonySnap();
    const ctx = { spb: spb(), fifths: fifths(), snap, steps: dir * (n - 1) };
    commit(ops.diatonic(sel, ctx), 'Add ' + INTERVAL_NAMES[n] + (dir > 0 ? ' above' : ' below') + (snap ? ' (fit to ' + prefs.harmony + ')' : ''));
    return true;
  }
  const entryOn = () => !!(root.SV.entry && root.SV.entry.state && root.SV.entry.state.on);

  SV.hooks.keydown.push(e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) { want = null; return false; }
    const dg = /^Digit([2-9])$/.exec(e.code);
    if (dg) {
      if (entryOn()) return false;               // note entry adds the interval to its last note
      if (!e.repeat) addInterval(+dg[1], e.shiftKey ? -1 : 1);
      return true;
    }
    const f = KEYMAP[e.code];
    if (!f) return false;
    if (!e.repeat) run(f(e));
    return true;
  });
  if (SV.shortcuts) {
    Object.keys(ACTIONS).forEach(k => {
      const key = ACTIONS[k].key;
      if (key && !/Alt\+(Shift\+)?\d/.test(key)) SV.shortcuts.register({ keys: key, owner: 'motifs', desc: ACTIONS[k].label.replace(/…$/, '') });
    });
    SV.shortcuts.register({ keys: ['2', '3', '4', '5', '6', '7', '8', '9'].flatMap(d => ['Alt+' + d, 'Alt+Shift+' + d]), owner: 'motifs', when: 'normal',
      desc: 'add an interval above the selected notes (Shift: below): 3 = third … 8 = octave', label: 'Alt+2–9 / Alt+Shift+2–9' });
  }
  // Keep the new figure selected while Bitwig catches up (the app drops ids it doesn't see yet).
  SV.hooks.liveData.push(d => {
    if (!want) return;
    if (Date.now() > want.until) { want = null; return; }
    const present = new Set(d.notes.map(idOf));
    want.ids.forEach(id => { if (present.has(id)) SV.state.selection.add(id); });
  });
  document.addEventListener('mousedown', () => { want = null; }, true);

  // ------------------------------------------------------------------ library

  const library = () => load(LIB_KEY, []);
  function saveMotif(name) {
    const sel = selectedNotes();
    if (!sel.length) { SV.flash('Motif: select the notes of the motif first'); return false; }
    const lib = library().filter(m => m.name !== name);
    lib.push(makeMotif(name, sel, spb(), fifths()));
    save(LIB_KEY, lib);
    renderMenu();
    SV.flash('Saved motif “' + name + '” (' + sel.length + ' notes)');
    return true;
  }
  function deleteMotif(name) { save(LIB_KEY, library().filter(m => m.name !== name)); renderMenu(); }

  // Where an inserted motif goes: the entry caret if the entry module has one, else after the selection.
  function insertPoint() {
    const sel = selectedNotes().sort(byTime);
    const c = root.SV.entry && root.SV.entry.caret;
    const last = sel.length ? sel.filter(n => n.x === Math.max(...sel.map(q => q.x))).pop() : null;
    let x = null, pitch = last ? last.y : null, ch = last ? last.ch : 0;
    if (c) {
      if (Number.isFinite(c.x)) x = c.x;
      else if (Number.isFinite(c.step)) x = c.step;
      else if (Number.isFinite(c.beat)) x = Math.round(c.beat * spb());
      if (pitch == null && Number.isFinite(c.pitch)) pitch = c.pitch;
      if (!last && Number.isFinite(c.ch)) ch = c.ch;
    }
    if (x == null && sel.length) x = Math.ceil(bounds(sel, spb()).e / spb() - 1e-6) * spb(); // next beat after the selection
    return x == null ? null : { x, pitch, ch };
  }
  function insertMotif(name) {
    const m = library().find(q => q.name === name);
    if (!m) return;
    const at = insertPoint();
    if (!at) { SV.flash('Motif: select a note (or place the entry caret) to insert “' + name + '”'); return; }
    const pitch = at.pitch == null ? m.pitch || 72 : at.pitch;
    const snap = harmonySnap();
    commit(placeMotif(m, { x: at.x, pitch, ch: at.ch, spb: spb(), fifths: fifths(), snap }), 'Inserted “' + name + '”');
  }

  // ------------------------------------------------------------------ UI

  SV.addStyle(`
    .mtf { position: relative; }
    .mtf-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 25; min-width: 270px; background: var(--bar, #232323);
      border: 1px solid var(--line, #3a3a3a); border-radius: 6px; padding: 4px 0; box-shadow: 0 6px 20px #0008; }
    .mtf-panel button.mtf-item { display: flex; justify-content: space-between; gap: 16px; width: 100%; background: none; border: 0;
      color: var(--text, #ddd); font: inherit; padding: 4px 12px; text-align: left; cursor: pointer; }
    .mtf-panel button.mtf-item:hover { background: var(--bar2, #2d2d2d); }
    .mtf-panel kbd { color: var(--dim, #8a8a8a); font: 11px ui-monospace, monospace; }
    .mtf-panel hr { border: 0; border-top: 1px solid var(--line, #3a3a3a); margin: 4px 0; }
    .mtf-panel .mtf-row { display: flex; align-items: center; gap: 8px; padding: 4px 12px; color: var(--dim, #8a8a8a); }
    .mtf-panel .mtf-lib { display: flex; align-items: center; }
    .mtf-panel .mtf-lib button.mtf-item { flex: 1; }
    .mtf-panel .mtf-del { background: none; border: 0; color: var(--dim, #8a8a8a); cursor: pointer; padding: 2px 10px; font: inherit; }
    .mtf-panel .mtf-del:hover { color: #e66; }
    .mtf-save { display: flex; align-items: center; gap: 6px; }
    .mtf-save input { background: var(--bar, #232323); color: var(--text, #ddd); border: 1px solid var(--accent, #4a9eff); border-radius: 4px;
      font: inherit; padding: 2px 6px; width: 160px; }
  `);

  const group = SV.addToolbar('<div class="mtf"><button class="btn" id="mtfBtn" title="Motif operations on the selected notes">Motif ▾</button>'
    + '<div class="mtf-panel hidden" id="mtfPanel"></div></div>'
    + '<div class="mtf-save hidden" id="mtfSave"><input id="mtfName" placeholder="Motif name" maxlength="40">'
    + '<button class="btn" id="mtfOk">Save</button><button class="btn" id="mtfCancel">Cancel</button></div>', { cluster: 'write', order: 60 });
  const $ = id => group.querySelector('#' + id);
  const panel = $('mtfPanel');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function renderMenu() {
    const item = n => `<button class="mtf-item" data-act="${n}"><span>${ACTIONS[n].label}</span><kbd>${ACTIONS[n].key}</kbd></button>`;
    const hasHarmony = !!(root.SV.harmony && typeof root.SV.harmony.snap === 'function');
    const lib = library();
    panel.innerHTML = ['seqUp', 'seqDown'].map(item).join('') + '<hr>'
      + ['invert', 'invertChrom', 'retro', 'augment', 'diminish'].map(item).join('') + '<hr>'
      + ['octUp', 'octDown', 'thirdUp', 'third', 'sixthUp', 'sixth'].map(item).join('') + '<hr>'
      + `<label class="mtf-row" title="${hasHarmony ? 'Adjust generated pitches to the harmony under them' : 'Needs the harmony module'}">Fit to harmony
           <select id="mtfHarm" ${hasHarmony ? '' : 'disabled'}>
             ${['off', 'scale', 'chord'].map(v => `<option value="${v}" ${prefs.harmony === v ? 'selected' : ''}>${v}</option>`).join('')}
           </select></label><hr>`
      + item('saveMotif')
      + (lib.length ? lib.map(m => `<div class="mtf-lib"><button class="mtf-item" data-ins="${esc(m.name)}" title="Insert after the selection, starting on the selected pitch">`
          + `<span>▸ ${esc(m.name)}</span><kbd>${m.notes.length} notes</kbd></button>`
          + `<button class="mtf-del" data-delm="${esc(m.name)}" title="Delete from library">×</button></div>`).join('')
        : '<div class="mtf-row">No saved motifs yet</div>');
    const harm = panel.querySelector('#mtfHarm');
    harm.addEventListener('change', () => { prefs.harmony = harm.value; save(PREF_KEY, prefs); });
  }

  $('mtfBtn').addEventListener('click', e => {
    if (panel.classList.contains('hidden')) renderMenu();
    panel.classList.toggle('hidden');
    e.stopPropagation();
  });
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act) { panel.classList.add('hidden'); run(b.dataset.act); }
    else if (b.dataset.ins) { panel.classList.add('hidden'); insertMotif(b.dataset.ins); }
    else if (b.dataset.delm) deleteMotif(b.dataset.delm);
    e.stopPropagation();
  });
  document.addEventListener('click', e => { if (!group.contains(e.target)) panel.classList.add('hidden'); });

  // Inline name field instead of window.prompt.
  const saveBox = $('mtfSave'), nameInput = $('mtfName');
  function openSave() {
    if (!selectedNotes().length) { SV.flash('Motif: select the notes of the motif first'); return; }
    saveBox.classList.remove('hidden');
    nameInput.value = 'Motif ' + (library().length + 1);
    nameInput.focus(); nameInput.select();
  }
  function closeSave() { saveBox.classList.add('hidden'); const m = document.getElementById('main'); if (m) m.focus(); }
  function confirmSave() { const n = nameInput.value.trim(); if (n && saveMotif(n)) closeSave(); }
  $('mtfOk').addEventListener('click', confirmSave);
  $('mtfCancel').addEventListener('click', closeSave);
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { confirmSave(); e.preventDefault(); }
    if (e.key === 'Escape') { closeSave(); e.preventDefault(); }
    e.stopPropagation();
  });

  SV.addHelp('Motif: <kbd>Alt</kbd>+<kbd>S</kbd>/<kbd>Shift</kbd>+<kbd>S</kbd> sequence up/down · <kbd>Alt</kbd>+<kbd>I</kbd> invert · '
    + '<kbd>Alt</kbd>+<kbd>R</kbd> retrograde · <kbd>Alt</kbd>+<kbd>A</kbd>/<kbd>D</kbd> augment/diminish · '
    + '<kbd>Alt</kbd>+<kbd>O</kbd> (+<kbd>Shift</kbd>) octave · <kbd>Alt</kbd>+<kbd>2</kbd>–<kbd>9</kbd> add an interval above (+<kbd>Shift</kbd> below) · <kbd>Alt</kbd>+<kbd>M</kbd> save motif');

  root.SV.motifs = { ...Core, run, addInterval, saveMotif, insertMotif, deleteMotif, library, actions: ACTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
