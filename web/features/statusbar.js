// Feature module: status bar — the line at the bottom of the page (#svStatusBar, markup in index.html).
// Left: what is selected ("1 note · Violin 1 · bar 5 beat 2 · F♯4 · dotted quarter · legato"), and the entry duration
// while note entry is on. Right: the controls features/layout.js moves there in the compact header (Key, Quantize,
// Page / Single line, Zoom), Messages (features/toasts.js), Shortcuts, render time and the connection dot.
// Refreshes on a light timer (selection changes do not re-render), so it registers no SV hooks.
// Also loads in Node (module.exports) for the unit test: pitchName, durName, barBeat, summary.
(function (root) {
  'use strict';

  const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
  /** 'F♯4' for MIDI pitch p; spell = ScoreBuilder.makeSpeller(fifths) (else sharps). */
  function pitchName(p, spell) {
    if (spell) { const s = spell(p); return s.pname.toUpperCase() + ACC[s.alter] + s.oct; }
    return ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  }

  const DUR_NAMES = [[4, 'whole'], [3, 'dotted half'], [2, 'half'], [1.5, 'dotted quarter'], [4 / 3, 'half triplet'],
    [1, 'quarter'], [0.75, 'dotted 8th'], [2 / 3, 'quarter triplet'], [0.5, '8th'], [0.375, 'dotted 16th'],
    [1 / 3, '8th triplet'], [0.25, '16th'], [1 / 6, '16th triplet'], [0.125, '32nd'], [6, 'dotted whole'], [8, 'two whole notes']];
  /** A note value name for a length in quarter beats ('dotted quarter'), else '2.25 beats'. */
  function durName(beats) {
    const hit = DUR_NAMES.find(([b]) => Math.abs(b - beats) < 1e-3);
    if (hit) return hit[1];
    const r = Math.round(beats * 100) / 100;
    return r + (r === 1 ? ' beat' : ' beats');
  }

  const num = x => { const r = Math.round(x * 100) / 100; return String(r); };
  /** 'bar 5 beat 2.5' for an absolute score beat; render = SV.state.render, SB = ScoreBuilder (measureAt/measureSpan). */
  function barBeat(beat, render, SB) {
    if (!render || !SB) return 'beat ' + num(beat + 1);
    const m = SB.measureAt(render, beat), span = SB.measureSpan(render, m);
    return 'bar ' + m + ' beat ' + num(beat - span.start + 1);
  }

  /**
   * The selection readout. sel: [{ pitch, start (absolute beat), dur (beats), artic (name|null) }], track,
   * opts { render, SB, spell }. Returns { text, parts:[strings] }.
   */
  function summary(sel, track, opts) {
    const o = opts || {};
    if (!sel.length) return { text: track ? track + ' · nothing selected' : 'Nothing selected', parts: [] };
    const parts = [sel.length + (sel.length === 1 ? ' note' : ' notes')];
    if (track) parts.push(track);
    const byStart = sel.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    const first = byStart[0], last = byStart[byStart.length - 1];
    parts.push(barBeat(first.start, o.render, o.SB) + (last.start > first.start + 1e-6 ? ' – ' + barBeat(last.start, o.render, o.SB) : ''));
    const lo = Math.min(...sel.map(n => n.pitch)), hi = Math.max(...sel.map(n => n.pitch));
    parts.push(lo === hi ? pitchName(lo, o.spell) : pitchName(lo, o.spell) + '–' + pitchName(hi, o.spell));
    const durs = new Set(sel.map(n => Math.round(n.dur * 1000)));
    parts.push(durs.size === 1 ? durName(sel[0].dur) : 'mixed lengths');
    const arts = new Set(sel.map(n => n.artic).filter(a => a));
    if (arts.size === 1) parts.push([...arts][0]); else if (arts.size > 1) parts.push('mixed articulations');
    return { text: parts.join(' · '), parts };
  }

  /** The key signature (fifths) in force at an absolute beat: render.keyFifths, then render.keyChanges [{ beat, fifths }]. */
  function keyAt(render, beat) {
    if (!render) return 0;
    let f = render.keyFifths != null ? render.keyFifths : 0;
    (render.keyChanges || []).forEach(k => { if (k.beat <= beat + 1e-9) f = k.fifths; });
    return f;
  }

  const api = { pitchName, durName, barBeat, summary, keyAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const SV = root.SV;
  if (!SV || typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const bar = $('svStatusBar');
  if (!bar) return;

  SV.addStyle(`
    #svStatusBar { display: flex; align-items: center; gap: var(--sv-space-5); min-height: 28px; padding: 0 var(--sv-space-5);
      background: var(--sv-surface-1); border-top: 1px solid var(--sv-divider); color: var(--sv-text-dim);
      font-size: var(--sv-fs-control); white-space: nowrap; overflow: hidden; }
    #svSelInfo { overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
    #svSelInfo.svs-has { color: var(--sv-text); }
    #svEntryInfo { color: var(--sv-accent); font-weight: 600; flex: none; }
    #svEntryInfo[hidden] { display: none; }
    #svStatusBar .svs-spacer { flex: 1 1 0; min-width: 0; }
    #svStatusTools, #svStatusRight { display: flex; align-items: center; gap: var(--sv-space-5); flex: none; }
    #svStatusTools:empty { display: none; }
    #svStatusTools .group { display: flex; align-items: center; gap: var(--sv-space-3); }
    #svStatusTools select, #svStatusTools .seg { min-height: 22px; }
    #svStatusTools .seg button { padding: 0 var(--sv-space-4); }
    #svStatusTools select { padding: 0 2px; }
    #svStatusTools label { color: var(--sv-text-dim); }
    #svStatusTools #zoom { width: 90px; }
    #svStatusBar .svs-btn, #svStatusBar #helpToggle { position: static; background: transparent; color: var(--sv-text-dim);
      border: 1px solid transparent; border-radius: var(--sv-radius-sm); font: var(--sv-fs-control) var(--sv-font);
      padding: 1px var(--sv-space-3); cursor: pointer; }
    #svStatusBar .svs-btn:hover, #svStatusBar #helpToggle:hover { color: var(--sv-text); border-color: var(--sv-border); }
    #svStatusBar .svs-btn:focus-visible { outline: none; box-shadow: var(--sv-focus); }
  `);

  const ksMax = 24; // notes below C1 are keyswitches (articulations.js KS_MAX)
  function selectedNotes() {
    const S = SV.state, d = S.liveData, r = S.render;
    if (!d || !d.exists || !S.selection.size) return [];
    const spb = d.stepsPerBeat || 24;
    const byId = new Map(d.notes.map(n => [SV.liveId(n), n]));
    let arts = null;
    const A = SV.articulations;
    if (A && A.mapFor && A.resolve) {
      try {
        const info = A.mapFor(d.track);
        if (info && info.map) {
          const all = d.notes.map(n => ({ id: SV.liveId(n), start: n.x / spb, dur: n.d, pitch: n.y }));
          arts = A.resolve(all.filter(n => n.pitch >= ksMax), all.filter(n => n.pitch < ksMax), info.map, A.settings || {});
        }
      } catch (e) { arts = null; }
    }
    const out = [];
    S.selection.forEach(id => {
      const n = byId.get(id);
      if (!n) return;
      const t = r && r.bySrc && r.bySrc.get(id);
      out.push({ pitch: n.y, dur: n.d, start: t && t[0] ? t[0].start : n.x / spb, artic: arts ? arts.get(id) || null : null });
    });
    return out;
  }

  function entryText() {
    const E = SV.entry && SV.entry.state;
    if (!E || !E.on) return '';
    const D = SV.entry.DURS && SV.entry.DURS[E.digit];
    const dur = (E.dot ? 'dotted ' : '') + (D ? D.name : '') + (E.triplet ? ' triplet' : '');
    return ['Entry', dur, E.chordMode ? 'chord' : '', E.tie ? 'tie' : '', E.rhythmFirst ? 'rhythm first' : ''].filter(Boolean).join(' · ');
  }

  let sig = '';
  function refresh() {
    const S = SV.state, E = SV.entry && SV.entry.state;
    const s = [[...S.selection].join(','), S.liveData && S.liveData.v, S.render && S.render.timeline && S.render.timeline.length,
      E && [E.on, E.digit, E.dot, E.triplet, E.chordMode, E.tie, E.rhythmFirst].join()].join('|');
    if (s === sig) return;
    sig = s;
    const notes = selectedNotes();
    const r = S.render, SB = SV.ScoreBuilder;
    const fifths = keyAt(r, notes.length ? Math.min(...notes.map(n => n.start)) : 0);
    const res = summary(notes, SV.currentTrack(), { render: r, SB, spell: SB && SB.makeSpeller ? SB.makeSpeller(fifths) : null });
    const info = $('svSelInfo');
    info.textContent = res.text;
    info.title = res.text;
    info.classList.toggle('svs-has', notes.length > 0);
    const et = entryText(), ei = $('svEntryInfo');
    ei.textContent = et;
    ei.hidden = !et;
  }
  setInterval(refresh, 200);
  ['mouseup', 'keyup'].forEach(t => document.addEventListener(t, () => setTimeout(refresh, 0)));
  window.addEventListener('sv-ready', refresh);
  refresh();

  SV.statusbar = Object.assign({}, api, { refresh: () => { sig = ''; refresh(); }, text: () => $('svSelInfo').textContent });
})(typeof window !== 'undefined' ? window : globalThis);
