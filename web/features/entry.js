// Feature module: entry — note input for the live clip ("play, then sculpt"). See docs/AGENTS.md for the SV hook API.
//
//  N toggles Entry mode. A caret sits on the live clip's staff; everything enters at the caret and advances it.
//  Input methods share one pipeline (enterPitches): letters A–G, MIDI keys/chords (Web MIDI or the Bitwig bridge), R (repeat),
//  mouse clicks with a ghost-note preview, and rhythm-first slots (digits / F1–F8 cells / tapped rhythm)
//  that pitches then fill left to right. Entering overwrites notes that start in the entered span.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ pure core (Node: require('web/features/entry.js'))

  // Duration index used everywhere inside (MuseScore's numbers): 2 = 32nd … 7 = whole. Keypad layouts map keys onto it.
  const DURS = { 2: { b: 0.125, name: '32nd' }, 3: { b: 0.25, name: '16th' }, 4: { b: 0.5, name: '8th' },
                 5: { b: 1, name: 'quarter' }, 6: { b: 2, name: 'half' }, 7: { b: 4, name: 'whole' } };
  // Keypad layouts (preference). digits: key -> DURS index | 'rest' | 'natural' | 'sharp' | 'flat' | { off: name } (a value
  // below the 32nd grid or above the whole note) | null. chars: other keys. Tables in docs/features/entry.md.
  const LAYOUTS = {
    sibelius: { name: 'Sibelius', digits: { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 'natural', 8: 'sharp', 9: 'flat', 0: 'rest' },
                chars: { '+': 'sharp', '-': 'flat', '=': 'natural' }, numpadEnter: 'tie' },
    dorico: { name: 'Dorico', digits: { 1: { off: '128th' }, 2: { off: '64th' }, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: { off: 'double whole' }, 0: 'natural' },
              chars: { '-': 'flat', '=': 'sharp', '+': 'sharp', ',': 'rest' } },
    musescore: { name: 'MuseScore', digits: { 1: { off: '64th' }, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: { off: 'double whole' }, 9: { off: 'longa' }, 0: 'rest' },
                 chars: { '+': 'sharp', '-': 'flat', '=': 'natural' } },
  };
  const DEFAULT_LAYOUT = 'sibelius';
  const layoutOf = id => LAYOUTS[id] || LAYOUTS[DEFAULT_LAYOUT];
  const ACC = { sharp: 1, flat: -1, natural: 0 };
  function valueAction(v) {
    if (typeof v === 'number') return { type: 'dur', idx: v };
    if (v === 'rest' || v === 'tie') return { type: v };
    if (typeof v === 'string' && v in ACC) return { type: 'acc', delta: ACC[v] };
    if (v && v.off) return { type: 'off', name: v.off };
    return { type: 'none' };
  }

  /**
   * What a key does in note entry under a keypad layout. ev: { key, code, shift, alt, ctrl }; opts.rowIntervals: in the
   * Sibelius layout the number row adds intervals (as in Sibelius) and only the numpad sets durations. Returns null (not
   * entry's key) or { type: 'dur', idx } | { type: 'rest' } | { type: 'tie' } | { type: 'dot' } | { type: 'acc', delta }
   *   | { type: 'off', name } | { type: 'none' } | { type: 'triplet' } | { type: 'interval', n, dir } | { type: 'octave', dir }
   *   | { type: 'bar', dir }
   */
  function keyAction(layoutId, ev, opts) {
    opts = opts || {};
    const L = layoutOf(layoutId), code = ev.code || '', key = ev.key || '';
    const pad = /^Numpad\d$/.test(code) ? +code.slice(6) : null;
    const row = pad == null ? (/^Digit\d$/.test(code) ? +code.slice(5) : /^\d$/.test(key) ? +key : null) : null;
    const digit = pad != null ? pad : row;
    if (ev.ctrl) {
      if (ev.alt || ev.shift) return null;
      if (digit === 3) return { type: 'triplet' };
      if (key === 'ArrowUp' || key === 'ArrowDown') return { type: 'octave', dir: key === 'ArrowUp' ? 1 : -1 };
      if (key === 'ArrowLeft' || key === 'ArrowRight') return { type: 'bar', dir: key === 'ArrowRight' ? 1 : -1 };
      return null;
    }
    if (ev.alt) return digit != null && digit >= 1 ? { type: 'interval', n: digit, dir: ev.shift ? -1 : 1 } : null;
    if (row != null && opts.rowIntervals && L === LAYOUTS.sibelius) return row >= 1 ? { type: 'interval', n: row, dir: ev.shift ? -1 : 1 } : { type: 'none' };
    if (digit != null) return ev.shift && pad == null ? null : valueAction(L.digits[digit]);
    if (key === '.' || code === 'NumpadDecimal') return { type: 'dot' };
    if (code === 'NumpadEnter') return L.numpadEnter ? valueAction(L.numpadEnter) : null;
    const ch = code === 'NumpadAdd' ? '+' : code === 'NumpadSubtract' ? '-' : key;
    return Object.prototype.hasOwnProperty.call(L.chars, ch) ? valueAction(L.chars[ch]) : null;
  }
  /** The key that gives a duration (DURS index) or an action ('rest', 'sharp', …) in a layout, or null. */
  function keyFor(layoutId, what) {
    const L = layoutOf(layoutId);
    const d = Object.keys(L.digits).find(k => L.digits[k] === what);
    if (d != null) return d;
    const c = Object.keys(L.chars).find(k => L.chars[k] === what);
    return c != null ? c : null;
  }

  const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11];
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B as letter indices
  function keyAlter(letter, fifths) {
    if (fifths > 0 && SHARP_ORDER.slice(0, fifths).includes(letter)) return 1;
    if (fifths < 0 && SHARP_ORDER.slice().reverse().slice(0, -fifths).includes(letter)) return -1;
    return 0;
  }
  const diaToNatural = dia => { const l = ((dia % 7) + 7) % 7; return (Math.floor(dia / 7) + 1) * 12 + NATURAL_PC[l]; };
  /**
   * Diatonic interval from a note (Sibelius / Dorico Alt+digit): natural = the white-key pitch the note is written on (its
   * letter), n = 2 (second) … 8 (octave) …, dir 1 above / -1 below. The new note takes the key signature's accidental.
   * Returns { pitch, natural } in the same (written) pitch space.
   */
  function intervalPitch(natural, n, dir, fifths) {
    const pc = ((natural % 12) + 12) % 12, li = NATURAL_PC.indexOf(pc);
    const dia = (Math.floor(natural / 12) - 1) * 7 + (li < 0 ? NATURAL_PC.filter(v => v < pc).length - 1 : li) + dir * (Math.max(1, n) - 1);
    const nat = diaToNatural(dia);
    return { pitch: nat + keyAlter(((dia % 7) + 7) % 7, fifths || 0), natural: nat };
  }

  // Articulation of a patch or keyswitch name -> 'legato' | 'short' | null (long / unknown).
  function articKind(name) {
    const s = String(name || '');
    if (/legato/i.test(s)) return /non[\s-]?legato/i.test(s) ? null : 'legato';
    if (/^\s*long\b/i.test(s)) return null;
    return /\bshort\b|stacc|spicc|pizz|col legno|\bhits?\b|marcato/i.test(s) ? 'short' : null;
  }
  // Preferences: legato overlap (beats the previous note runs into the new one) and short-note lengths.
  const OVERLAPS = { off: 0, small: 1 / 16, medium: 1 / 8, large: 1 / 4 };
  const SHORT_LENS = { off: 'as written', gap: 'small gap', half: 'half length' };
  /** Played length (beats) of a note written `beats` long under articulation kind. */
  function playedBeats(beats, kind, shortLen) {
    if (kind !== 'short') return beats;
    if (shortLen === 'half') return beats / 2;
    if (shortLen === 'gap') return beats - Math.min(beats / 4, 1 / 16);
    return beats;
  }
  /** Inverse of playedBeats: the written length (beats) of a note played `played` long (notes entry has no record of). */
  function writtenBeats(played, kind, shortLen) {
    if (kind !== 'short') return played;
    if (shortLen === 'half') return played * 2;
    if (shortLen === 'gap') return played >= 0.25 - 1 / 16 - 1e-9 ? played + 1 / 16 : played * 4 / 3;
    return played;
  }
  /**
   * Range check of entered pitches. range/comfort: [lo, hi] sounding MIDI pitches; mode 'off' | 'range' | 'comfort'.
   * -> null or { pitch, side: 'below'|'above', level: 'range'|'comfort', lo, hi }
   */
  function rangeIssue(pitches, range, comfort, mode) {
    if (!range || mode === 'off') return null;
    const out = (lim, level) => {
      const p = pitches.find(q => q < lim[0] || q > lim[1]);
      return p == null ? null : { pitch: p, side: p < lim[0] ? 'below' : 'above', level, lo: lim[0], hi: lim[1] };
    };
    return out(range, 'range') || (mode === 'comfort' && comfort ? out(comfort, 'comfort') : null);
  }

  const Pure = { DURS, LAYOUTS, DEFAULT_LAYOUT, keyAction, keyFor, intervalPitch, keyAlter, articKind, OVERLAPS, SHORT_LENS, playedBeats, writtenBeats, rangeIssue };
  if (typeof module !== 'undefined' && module.exports) module.exports = Pure;

  const SV = root.SV;
  if (!SV || typeof document === 'undefined') return;
  const SB = SV.ScoreBuilder;
  const $ = id => document.getElementById(id);
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('scoreview.entry.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('scoreview.entry.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const CARET = '#7048e8', GREY = '#9aa0a6';
  // Rhythm cells (F1–F8): beats per note, plus how to draw them.
  const CELLS = [
    { name: 'Dotted 8th + 16th', beats: [0.75, 0.25], glyph: [{ b: 0.5, dot: true }, { b: 0.25 }] },
    { name: '8th-note triplet', beats: [1 / 3, 1 / 3, 1 / 3], glyph: [{ b: 0.5 }, { b: 0.5 }, { b: 0.5 }], triplet: true },
    { name: '16-16-8', beats: [0.25, 0.25, 0.5], glyph: [{ b: 0.25 }, { b: 0.25 }, { b: 0.5 }] },
    { name: '8-16-16', beats: [0.5, 0.25, 0.25], glyph: [{ b: 0.5 }, { b: 0.25 }, { b: 0.25 }] },
    { name: 'Syncopation 8-q-8', beats: [0.5, 1, 0.5], glyph: [{ b: 0.5 }, { b: 1 }, { b: 0.5 }] },
    { name: 'Quarter', beats: [1], glyph: [{ b: 1 }] },
    { name: 'Half', beats: [2], glyph: [{ b: 2 }] },
    { name: 'Four 16ths', beats: [0.25, 0.25, 0.25, 0.25], glyph: [{ b: 0.25 }, { b: 0.25 }, { b: 0.25 }, { b: 0.25 }] },
  ];
  const LETTER_IDX = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };
  const CHORD_MS = 60;

  const E = {
    on: false, digit: 5, dot: false, triplet: false, tie: false,
    caret: 0,                 // clip step where the next entry goes
    staffN: null,             // preferred live staff (grand staff: 1 or 2)
    rhythmFirst: store.get('rhythmFirst', false),
    slots: [],                // rhythm-first slots { id, x, steps, rest, filled }
    history: [],              // undo stack for Backspace
    last: null,               // last entry { x, steps, pitches, ch }
    autoSel: new Set(),       // selection made by entry (so ←/→ still move the caret)
    expectSel: null,          // ids to select once Bitwig reports them
    midi: { status: 'off', name: '' },
    midiSrc: store.get('midiSource', 'auto'),   // 'auto' | 'web' | 'bitwig'
    recPlaying: store.get('recPlaying', false), // accept bridge notes while Bitwig's transport plays
    playing: false,
    tapKey: store.get('tapKey', 21), learnTap: false,
    chordMode: false,         // MIDI keys / letters add to the last entry's chord instead of advancing (controller action)
    capture: null,            // { taps: [ms], timer }
    tempo: 120,
    mouse: null,              // last mouse position over the paper
    notated: new Map(),       // note id -> written length in steps, for notes entry wrote shorter/longer than written
  };
  // Preferences (saved): keypad layout, Sibelius number row = intervals, legato overlap, short lengths, range warning.
  const PREF_DEFAULTS = { layout: DEFAULT_LAYOUT, rowIntervals: false, legatoOverlap: 'small', shortLen: 'gap', rangeWarn: 'range' };
  const PREF_CHOICES = { layout: Object.keys(LAYOUTS), legatoOverlap: Object.keys(OVERLAPS), shortLen: Object.keys(SHORT_LENS),
                         rangeWarn: ['off', 'range', 'comfort'] };
  const prefs = {};
  Object.keys(PREF_DEFAULTS).forEach(k => {
    const v = store.get(k, PREF_DEFAULTS[k]);
    prefs[k] = PREF_CHOICES[k] ? (PREF_CHOICES[k].includes(v) ? v : PREF_DEFAULTS[k]) : !!v;
  });
  function setPref(k, v) {
    if (!(k in PREF_DEFAULTS)) return;
    if (PREF_CHOICES[k] && !PREF_CHOICES[k].includes(v)) return;
    prefs[k] = PREF_CHOICES[k] ? v : !!v;
    store.set(k, prefs[k]);
    if (k === 'layout' || k === 'rowIntervals') { renderKeypad(); syncShortcuts(); }
    updateUI();
  }
  let slotSeq = 0;

  // ------------------------------------------------------------------ basics

  const live = () => { const d = SV.state.liveData; return d && d.exists ? d : null; };
  const spb = () => (live() ? live().stepsPerBeat : 24);
  // Score beat of the clip's content beat 0 (accounts for Score-mode placement and the clip's start offset).
  const clipOffset = () => (SV.contentOrigin ? SV.contentOrigin() : (SV.state.mode === 'score' && SV.state.align ? SV.state.align.offset : 0));
  const livePartName = () => { const d = live(); return !d ? null : SV.state.mode === 'score' ? d.track + ' ✎' : (d.track || 'Clip'); };
  const curBeats = () => DURS[E.digit].b * (E.dot ? 1.5 : 1) * (E.triplet ? 2 / 3 : 1);
  const curSteps = () => Math.max(1, Math.round(curBeats() * spb()));
  const fmt = v => String(+v.toFixed(6));
  const ksMin = () => ($('hideKs') && $('hideKs').checked ? 24 : 0);
  const audition = () => $('audition') && $('audition').checked;
  const idOf = (ch, x, y) => 'L' + ch + '_' + x + '_' + y;
  const sortNum = a => a.slice().sort((p, q) => p - q);
  const measureBeats = () => (SV.state.render ? SV.state.render.measureBeats : 4);
  const gridBeats = () => parseInt(($('gridSel') || { value: 2 }).value, 10) / SV.TPQ;

  function liveStaves() {
    const r = SV.state.render, name = livePartName();
    return r && name ? r.staves.filter(s => s.part === name) : [];
  }
  function caretStaff() {
    const st = liveStaves();
    return st.find(s => s.n === E.staffN) || st[0] || null;
  }
  const staffFifths = () => { const s = caretStaff(); return s ? s.fifths : (SV.state.render ? SV.state.render.keyFifths : 0); };

  // Diatonic number (C4 = 28) of a staff's top line, as SV.hitTest computes it.
  function topLineDia(clef) {
    const c = clef || { shape: 'G', line: 2 };
    const t = c.shape === 'G' ? 38 + (2 - c.line) * 2 : c.shape === 'F' ? 26 + (4 - c.line) * 2 : 28 + (5 - c.line) * 2;
    return t + (c.dis ? (c.disPlace === 'below' ? -7 : 7) * (c.dis / 8) : 0);
  }
  function middlePitch() {
    const s = caretStaff();
    if (!s) return 71;
    const dia = topLineDia(s.clef) - 4;
    return diaToNatural(dia) + keyAlter(((dia % 7) + 7) % 7, s.fifths);
  }
  function pitchName(p, fifths) {
    const sp = SB.makeSpeller(fifths || 0)(p);
    return sp.pname.toUpperCase() + ({ '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' })[sp.alter] + sp.oct;
  }
  function harmonySnap(pitch, absBeat) {
    const h = SV.harmony;
    if (!h || typeof h.snap !== 'function') return pitch;
    if (typeof h.snapEnabled === 'function' && !h.snapEnabled()) return pitch; // the user's "Snap to harmony" toggle
    try {
      const r = h.snap(pitch, absBeat);
      const p = typeof r === 'number' ? r : r && typeof r.pitch === 'number' ? r.pitch : pitch;
      return Number.isFinite(p) ? Math.round(p) : pitch;
    } catch (e) { return pitch; }
  }

  // ------------------------------------------------------------------ articulation-aware lengths, range

  // 'legato' | 'short' | null at clip step x: the keyswitch articulation latched there (features/articulations.js map),
  // else the track name ("Violins Legato", "Vc Spiccato").
  function articAt(x) {
    const d = live();
    if (!d) return null;
    const A = SV.articulations;
    try {
      const info = A && A.mapFor ? A.mapFor(d.track) : null;
      if (info && info.map) {
        const s = spb(), ks = d.notes.filter(n => n.y < 24 && info.map[n.y] != null);
        if (ks.length) {
          const r = A.resolve([{ id: 'x', start: x / s }], ks.map(n => ({ start: n.x / s, dur: n.d, pitch: n.y })), info.map, A.settings || {});
          const name = r.get('x');
          if (name) return articKind(name);
        }
      }
    } catch (err) { /* no articulation info: fall back to the name */ }
    return articKind(d.track);
  }
  // Played length (beats) of steps written at x, remembering the written length when it differs.
  function writeBeats(steps, x, pitches, ch) {
    const beats = steps / spb(), played = playedBeats(beats, articAt(x), prefs.shortLen);
    pitches.forEach(p => { if (played !== beats) E.notated.set(idOf(ch, x, p), { steps, d: played }); else E.notated.delete(idOf(ch, x, p)); });
    return played;
  }
  // Written length in steps of a clip note (entry's record of it, else its length).
  // Without a record (after a reload, or notes written elsewhere) it undoes the short-note gap or the legato overlap.
  // A record only counts while the note still plays the length entry gave it (not resized since, not another clip's note).
  function notatedSteps(n) {
    const kept = E.notated.get(idOf(n.ch, n.x, n.y));
    if (kept && Math.abs(kept.d - n.d) < 1e-4) return kept.steps;
    const s = spb(), ov = OVERLAPS[prefs.legatoOverlap] || 0;
    const kind = prefs.shortLen === 'off' && !ov ? null : articAt(n.x);
    let b = n.d;
    // The small gap always leaves a note off the step grid; a note on the grid was written at full length (in Bitwig).
    const onGrid = Math.abs(n.d * s - Math.round(n.d * s)) < 1e-3;
    if (kind === 'short' && !(prefs.shortLen === 'gap' && onGrid)) b = writtenBeats(n.d, kind, prefs.shortLen);
    else if (kind === 'legato' && ov) {
      const d = live(), end = n.x + (n.d - ov) * s;
      if (d && d.notes.some(m => m.x > n.x && Math.abs(m.x - end) < 0.75 && m.y >= ksMin())) b = n.d - ov;
    }
    return Math.max(1, Math.round(b * s));
  }

  // Legato: the notes that end where the new note starts run on into it by the overlap preference.
  // -> { ops, ext: [{ ch, x, y, d }] (old lengths, for undo) }
  function legatoOps(x) {
    const ov = OVERLAPS[prefs.legatoOverlap] || 0, d = live();
    if (!ov || !d || articAt(x) !== 'legato') return { ops: [], ext: [] };
    const s = spb(), min = ksMin(), ops = [], ext = [];
    d.notes.forEach(n => {
      if (n.y < min || n.x >= x || Math.abs(n.x + n.d * s - x) > ov * s + 1) return;   // cheap test first (articAt is not)
      const end = n.x + notatedSteps(n);
      if (Math.abs(end - x) > 1 || articAt(n.x) !== 'legato') return;   // both notes legato
      ops.push(`dur ${n.ch} ${n.x} ${n.y} ${fmt((x - n.x) / s + ov)}`);
      ext.push({ ch: n.ch, x: n.x, y: n.y, d: n.d });
      E.notated.set(idOf(n.ch, n.x, n.y), { steps: x - n.x, d: (x - n.x) / s + ov });
    });
    return { ops, ext };
  }
  const unextendOps = ext => (ext || []).map(n => `dur ${n.ch} ${n.x} ${n.y} ${fmt(n.d)}`);

  // Out-of-range warning (preference) for pitches just entered on the live track.
  function checkRange(pitches) {
    const d = live(), I = SV.instruments;
    if (!d || !I || !I.forPart || prefs.rangeWarn === 'off') return null;
    let info;
    try { info = I.forPart({ name: d.track, notes: [] }); } catch (err) { return null; }
    if (!info || !info.range || (info.inst && (info.inst.auto || info.inst.unpitched))) return null;
    const issue = rangeIssue(pitches, info.range, info.comfort, prefs.rangeWarn);
    E.rangeIssue = issue;
    if (!issue) return null;
    const st = caretStaff(), T = (st && st.transpose) || 0, f = staffFifths();
    const what = (info.inst && info.inst.name) || d.track;
    SV.flash(`⚠ ${pitchName(issue.pitch + T, f)} is ${issue.side} the ${what.toLowerCase()}'s ${issue.level === 'comfort' ? 'comfortable ' : ''}range ` +
      `(${pitchName(issue.lo + T, f)}–${pitchName(issue.hi + T, f)})`);
    return issue;
  }

  // ------------------------------------------------------------------ writing to the clip

  // Ops that clear [x, x+steps): delete notes starting inside, shorten notes running into it.
  function overwriteOps(x, steps, removed, truncated) {
    const d = live(), ops = [], s = spb(), min = ksMin();
    d.notes.forEach(n => {
      if (n.y < min) return;
      if (n.x >= x && n.x < x + steps) { ops.push(`del ${n.ch} ${n.x} ${n.y}`); removed.push({ ...n }); }
      else if (n.x < x && n.x + n.d * s > x + 1e-6) { ops.push(`dur ${n.ch} ${n.x} ${n.y} ${fmt((x - n.x) / s)}`); truncated.push({ ...n }); }
    });
    return ops;
  }
  const restoreOps = (removed, truncated) =>
    removed.map(n => `add ${n.ch} ${n.x} ${n.y} ${n.vel == null ? 90 : n.vel} ${fmt(n.d)}`)
      .concat(truncated.map(n => `dur ${n.ch} ${n.x} ${n.y} ${fmt(n.d)}`));

  function selectEntered(ids) {
    E.autoSel = new Set(ids);
    E.expectSel = new Set(ids);
    SV.state.selection = new Set(ids);
    SV.paintSelection();
  }

  const firstUnfilled = () => E.slots.filter(s => !s.filled).sort((a, b) => a.x - b.x)[0] || null;

  // The one entry pipeline: pitches at the next slot, or at the caret with the current duration.
  function enterPitches(pitches, vel, how, nat) {
    const d = live();
    if (!d) { SV.flash('Select a clip in Bitwig first'); return false; }
    pitches = sortNum([...new Set(pitches)]);
    if (!pitches.length) return false;
    syncLast();
    const s = spb();
    if (E.tie && E.last) {
      if (E.last.pitches.join() === pitches.join() && !firstUnfilled()) return extendLast();
      SV.flash('Tie needs the same pitch — entered a new note');
    }
    E.tie = false;
    const ops = [], removed = [], truncated = [], restSlots = [];
    let slot = null, sl;
    while ((sl = firstUnfilled()) && sl.rest) { ops.push(...overwriteOps(sl.x, sl.steps, removed, truncated)); sl.filled = true; restSlots.push(sl); }
    slot = firstUnfilled();
    const x = slot ? slot.x : E.caret, steps = slot ? slot.steps : curSteps();
    if (x >= Math.round(d.length * s)) {
      restSlots.forEach(r => { r.filled = false; });
      SV.flash('End of the clip — lengthen it in Bitwig to keep writing');
      return false;
    }
    ops.push(...overwriteOps(x, steps, removed, truncated));
    const ch = 0;
    const leg = legatoOps(x);
    ops.push(...leg.ops);
    const len = writeBeats(steps, x, pitches, ch);
    pitches.forEach(p => ops.push(`add ${ch} ${x} ${p} ${vel} ${fmt(len)}`));
    if (how !== 'midi' && audition()) pitches.slice(0, 4).forEach(p => ops.push('audition ' + p));
    SV.send(ops);
    const entry = { x, steps, pitches, ch, nat: nat || {} };
    E.history.push({ type: slot ? 'fill' : 'note', entry, removed, truncated, ext: leg.ext, prevCaret: E.caret, prevLast: E.last, slot, restSlots });
    checkRange(pitches);
    if (slot) slot.filled = true;
    else E.caret = x + steps;
    E.last = entry;
    E.staffN = staffForPitch(pitches[0]);
    selectEntered(pitches.map(p => idOf(ch, x, p)));
    afterChange(!!slot || restSlots.length);
    return true;
  }

  // T: the previous note grows by the current duration instead of a new note starting.
  function extendLast() {
    const L = E.last, s = spb(), add = curSteps(), x = L.x + L.steps;
    const removed = [], truncated = [];
    const ops = overwriteOps(x, add, removed, truncated);
    const len = writeBeats(L.steps + add, L.x, L.pitches, L.ch);
    L.pitches.forEach(p => ops.push(`dur ${L.ch} ${L.x} ${p} ${fmt(len)}`));
    SV.send(ops);
    E.history.push({ type: 'extend', entry: L, oldSteps: L.steps, removed, truncated, prevCaret: E.caret });
    L.steps += add;
    E.caret = Math.max(E.caret, L.x + L.steps);
    E.tie = false;
    selectEntered(L.pitches.map(p => idOf(L.ch, L.x, p)));
    afterChange(false);
    return true;
  }

  function addToChord(pitch, natural) {
    syncLast();
    const L = E.last;
    if (!L) { SV.flash('Enter a note first, then Shift+letter adds to its chord'); return; }
    if (L.pitches.includes(pitch)) return false;
    if (pitch < 0 || pitch > 127) return false;
    const ops = [`add ${L.ch} ${L.x} ${pitch} 90 ${fmt(writeBeats(L.steps, L.x, [pitch], L.ch))}`];
    if (audition()) ops.push('audition ' + pitch);
    SV.send(ops);
    L.pitches = sortNum(L.pitches.concat(pitch));
    if (natural != null) (L.nat = L.nat || {})[pitch] = natural;
    E.history.push({ type: 'chordAdd', entry: L, pitch });
    selectEntered(L.pitches.map(p => idOf(L.ch, L.x, p)));
    afterChange(false);
    checkRange([pitch]);
    return true;
  }

  // Alt+digit (Sibelius / Dorico): add a diatonic interval above the top note (dir 1) or below the bottom note (-1)
  // of the last entry. n: 2 = second … 8 = octave.
  function addInterval(n, dir) {
    syncLast();
    const L = E.last;
    if (!L) { SV.flash('Enter or select a note first, then Alt+digit adds an interval'); return false; }
    if (n < 2) { SV.flash('Alt+2 … Alt+9 add a 2nd … 9th (Shift: below)'); return false; }
    const fifths = staffFifths(), st = caretStaff(), T = (st && st.transpose) || 0;
    const base = dir > 0 ? L.pitches[L.pitches.length - 1] : L.pitches[0];
    const r = intervalPitch(naturalOf(L, base, fifths) + T, n, dir, fifths);
    return addToChord(r.pitch - T, r.natural - T);
  }

  function rest() {
    const d = live();
    if (!d) return;
    if (E.rhythmFirst) { laySlots([curSteps()], true); return; }
    const removed = [], truncated = [], steps = curSteps();
    SV.send(overwriteOps(E.caret, steps, removed, truncated));
    E.history.push({ type: 'rest', removed, truncated, prevCaret: E.caret });
    E.caret += steps;
    E.tie = false;
    clearAutoSel();
    afterChange(false);
  }

  function laySlots(stepsList, isRest) {
    if (!live()) { SV.flash('Select a clip in Bitwig first'); return; }
    const end = Math.round(live().length * spb());
    const made = [];
    const prevCaret = E.caret;
    stepsList.forEach(st => {
      if (E.caret >= end) return;
      made.push({ id: ++slotSeq, x: E.caret, steps: st, rest: !!isRest, filled: false });
      E.caret += st;
    });
    if (!made.length) { SV.flash('End of the clip'); return; }
    E.slots.push(...made);
    E.history.push({ type: 'slots', slots: made, prevCaret });
    clearAutoSel();
    afterChange(true);
  }

  function insertCell(i) {
    const c = CELLS[i];
    if (!c) return;
    laySlots(c.beats.map(b => Math.max(1, Math.round(b * spb()))));
    SV.flash('F' + (i + 1) + ' · ' + c.name + ' — now play or type the pitches');
  }

  function undoLast() {
    syncLast();
    const h = E.history.pop();
    if (!h) { SV.flash('Nothing to take back'); return; }
    const ops = [];
    if (h.type === 'note' || h.type === 'fill') {
      h.entry.pitches.forEach(p => ops.push(`del ${h.entry.ch} ${h.entry.x} ${p}`));
      ops.push(...restoreOps(h.removed, h.truncated), ...unextendOps(h.ext));
      if (h.slot) h.slot.filled = false; else E.caret = h.prevCaret;
      (h.restSlots || []).forEach(r => { r.filled = false; });
      E.last = h.prevLast;
    } else if (h.type === 'extend') {
      h.entry.pitches.forEach(p => ops.push(`dur ${h.entry.ch} ${h.entry.x} ${p} ${fmt(writeBeats(h.oldSteps, h.entry.x, [p], h.entry.ch))}`));
      ops.push(...restoreOps(h.removed, h.truncated));
      h.entry.steps = h.oldSteps;
      E.caret = h.prevCaret;
    } else if (h.type === 'chordAdd') {
      ops.push(`del ${h.entry.ch} ${h.entry.x} ${h.pitch}`);
      h.entry.pitches = h.entry.pitches.filter(p => p !== h.pitch);
    } else if (h.type === 'rest') {
      ops.push(...restoreOps(h.removed, h.truncated));
      E.caret = h.prevCaret;
    } else if (h.type === 'slots') {
      E.slots = E.slots.filter(s => !h.slots.includes(s));
      E.caret = h.prevCaret;
    }
    SV.send(ops);
    clearAutoSel();
    afterChange(h.type === 'slots' || h.type === 'fill');
  }

  function accidental(delta) {
    const fifths = staffFifths();
    return transposeLast((p, L) => (delta === 0 ? naturalOf(L, p, fifths) : p + delta), true);
  }

  // Moves every pitch of the last entry to fn(pitch, last). keepNat: the written natural stays (accidentals);
  // otherwise it follows the new pitch (octave / diatonic steps).
  function transposeLast(fn, keepNat) {
    syncLast();
    const L = E.last;
    if (!L) { SV.flash('Enter or select a note first'); return false; }
    const fifths = staffFifths();
    const moves = L.pitches.map(p => ({ from: p, to: fn(p, L) }))
      .filter(m => m.to !== m.from && m.to >= 0 && m.to <= 127);
    if (!moves.length) return false;
    // Move in an order that never lands on a note that hasn't moved yet.
    moves.sort((a, b) => Math.sign(a.to - a.from) * (b.from - a.from));
    const ops = moves.map(m => `move ${L.ch} ${L.x} ${m.from} 0 ${m.to - m.from}`);
    if (audition()) moves.slice(0, 4).forEach(m => ops.push('audition ' + m.to));
    SV.send(ops);
    const nat = {};
    if (keepNat) L.pitches.forEach(p => { const m = moves.find(q => q.from === p); nat[m ? m.to : p] = naturalOf(L, p, fifths); });
    L.nat = nat;
    const kept = moves.map(m => [m.to, E.notated.get(idOf(L.ch, L.x, m.from))]);
    moves.forEach(m => E.notated.delete(idOf(L.ch, L.x, m.from)));
    kept.forEach(([to, st]) => { if (st) E.notated.set(idOf(L.ch, L.x, to), st); });
    L.pitches = sortNum(L.pitches.map(p => (moves.find(m => m.from === p) || { to: p }).to));
    selectEntered(L.pitches.map(p => idOf(L.ch, L.x, p)));
    afterChange(false);
    checkRange(moves.map(m => m.to));
    return true;
  }

  // Next pitch of the staff's key (major-scale degrees with the key signature) above (dir 1) or below (-1) p.
  function diatonicStep(p, dir) {
    const fifths = staffFifths();
    const st = caretStaff(), T = (st && st.transpose) || 0;   // the key is in written pitch
    const scale = new Set(NATURAL_PC.map((pc, li) => (((pc + keyAlter(li, fifths)) % 12) + 12) % 12));
    let q = p + T + dir;
    while (!scale.has(((q % 12) + 12) % 12) && Math.abs(q - p - T) < 12) q += dir;
    return q - T;
  }

  // Selects the previous/next onset of the live clip (from the last entry, else the caret) as the "last" note,
  // so pitch / accidental / octave actions sculpt it. The caret moves after it.
  function selectAdjacent(dir) {
    const d = live();
    if (!d) return false;
    syncLast();
    const min = ksMin(), s = spb();
    const xs = [...new Set(d.notes.filter(n => n.y >= min).map(n => n.x))].sort((a, b) => a - b);
    const from = E.last ? E.last.x : dir > 0 ? E.caret - 1 : E.caret;
    const x = dir > 0 ? xs.find(v => v > from) : xs.filter(v => v < from).pop();
    if (x == null) { SV.flash(dir > 0 ? 'No later note' : 'No earlier note'); return false; }
    const here = d.notes.filter(n => n.x === x && n.y >= min);
    const steps = Math.max(...here.map(notatedSteps));
    E.last = { x, steps, pitches: sortNum(here.map(n => n.y)), ch: here[0].ch, nat: {} };
    E.caret = x + steps;
    E.tie = false;
    E.staffN = staffForPitch(here[0].y);
    selectEntered(here.map(n => idOf(n.ch, n.x, n.y)));
    afterChange(false);
    return true;
  }

  // The white-key pitch a note was written from (letter entry / +,-), else from the spelling in this key.
  const naturalOf = (L, p, fifths) => (L.nat && L.nat[p] != null ? L.nat[p] : p - SB.makeSpeller(fifths)(p).alter);

  // ↑/↓ (core) move the entered note, which renames its id; follow it so +/−/R/Shift+letter keep working.
  function syncLast() {
    const L = E.last, sel = [...SV.state.selection];
    if (!L || !sel.length) return;
    const ps = sel.map(SV.parseId);
    if (ps.every(p => p.x === L.x && p.ch === L.ch)) {
      const next = sortNum(ps.map(p => p.y));
      if (next.join() !== L.pitches.join()) L.nat = {};
      L.pitches = next;
      E.autoSel = new Set(sel);
    }
  }
  const isAutoSel = () => {
    const sel = [...SV.state.selection];
    return !sel.length || (!!E.last && sel.every(id => SV.isLive(id) && SV.parseId(id).x === E.last.x));
  };
  function clearAutoSel() {
    if ([...SV.state.selection].every(id => E.autoSel.has(id) || (E.last && SV.parseId(id).x === E.last.x))) {
      SV.state.selection.clear();
      SV.paintSelection();
    }
    E.autoSel.clear();
  }

  function staffForPitch(p) {
    const st = liveStaves();
    if (st.length < 2) return st[0] ? st[0].n : null;
    return p >= 60 ? st[0].n : st[1].n;
  }

  function afterChange(rerender) {
    if (rerender) SV.render(); else drawOverlay();
    updateUI();
    scrollCaretIntoView();
  }

  // ------------------------------------------------------------------ pitch sources

  function letterPitch(letter, above) {
    const fifths = staffFifths();
    const li = LETTER_IDX[letter];
    const pc = ((NATURAL_PC[li] + keyAlter(li, fifths)) % 12 + 12) % 12;
    // works in written pitch (what the letter names) and returns sounding pitch; its natural is written - keyAlter
    const st = caretStaff(), T = (st && st.transpose) || 0;
    if (above != null) { let p = above + T + 1; while (((p % 12) + 12) % 12 !== pc) p++; return p - T; }
    const ref = E.last ? E.last.pitches[0] + T : middlePitch();
    let best = null;
    for (let o = -1; o <= 10; o++) {
      const p = pc + 12 * o;
      if (p < 0 || p > 127) continue;
      if (best == null || Math.abs(p - ref) < Math.abs(best - ref)) best = p;
    }
    return best - T;
  }

  function caretAbsBeat() {
    const x = firstUnfilled() ? firstUnfilled().x : E.caret;
    return x / spb() + clipOffset();
  }

  function typeLetter(letter, shift) {
    syncLast();
    if (shift || (E.chordMode && E.last)) {
      if (!E.last) { SV.flash('Enter a note first, then Shift+letter adds to its chord'); return; }
      const p = letterPitch(letter, E.last.pitches[E.last.pitches.length - 1]);
      addToChord(p, p - keyAlter(LETTER_IDX[letter], staffFifths()));
      return;
    }
    const lp = letterPitch(letter), p = harmonySnap(lp, caretAbsBeat());
    enterPitches([p], 90, 'letter', p === lp ? { [p]: p - keyAlter(LETTER_IDX[letter], staffFifths()) } : null);
  }

  function repeatLast() {
    syncLast();
    if (!E.last) { SV.flash('Nothing to repeat yet'); return; }
    enterPitches(E.last.pitches.slice(), 90, 'repeat');
  }

  // ------------------------------------------------------------------ MIDI (Web MIDI; Kontrol S88 MK3 or anything else)
  //
  //  Two paths feed midiMessage: Web MIDI in the page, or the Bitwig bridge (GET /api/midi long-poll: the notes
  //  Bitwig itself receives on the selected track), for when Windows won't share the port. E.midiSrc picks one;
  //  'auto' uses Web MIDI when it opens, else the bridge. Only one path is live at a time (no double entry).

  const held = new Set();
  const BRIDGE_PORT = 'Bitwig bridge';
  let group = null;
  let pedalDown = false;

  // Raw listeners (features/controller.js): fn(data, timeMs, portName) -> true when the message was consumed.
  const rawHooks = [];
  function midiMessage(data, t, port) {
    if (!data || data.length < 1) return;
    const now = t != null ? t : performance.now();
    if (port == null) port = midiPath() === 'bridge' ? BRIDGE_PORT : E.midi.name || 'MIDI';
    for (const h of rawHooks) { try { if (h(data, now, port)) return; } catch (err) { console.error(err); } }
    const st = data[0] & 0xf0, d1 = data[1], d2 = data[2] || 0;
    if (st === 0x90 && d2 > 0) noteOn(d1, d2, now);
    else if (st === 0x80 || (st === 0x90 && d2 === 0)) noteOff(d1, now);
    else if (st === 0xb0 && d1 === 64) {
      const down = d2 >= 64;
      if (down && !pedalDown) tapInput(now);
      pedalDown = down;
    }
  }

  function noteOn(p, vel, now) {
    if (E.learnTap) {
      E.learnTap = false; E.tapKey = p; store.set('tapKey', p);
      SV.flash('Tap key: ' + pitchName(p, 0)); updateUI(); return;
    }
    if (!E.on) return;
    if (p === E.tapKey && (E.capture || E.rhythmFirst)) { tapInput(now); return; }
    held.add(p);
    if (group && now - group.t0 > CHORD_MS) { commitGroup(); }
    if (!group) group = { t0: now, pitches: [], vel: 0 };
    group.pitches.push(p);
    group.vel = Math.max(group.vel, vel);
  }

  function noteOff(p) {
    if (!held.delete(p)) return;
    if (!held.size && group) commitGroup();
  }

  function commitGroup() {
    const g = group;
    group = null;
    if (!g || !g.pitches.length) return;
    syncLast();
    if (E.chordMode && E.last) sortNum(g.pitches).forEach(p => addToChord(p));
    else enterPitches(g.pitches, g.vel || 90, 'midi');
  }

  // Which path is live: 'web' or 'bridge'.
  const midiPath = () => (E.midiSrc === 'web' ? 'web' : E.midiSrc === 'bitwig' ? 'bridge' : E.midi.status === 'ok' ? 'web' : 'bridge');

  const midiInputs = new WeakSet();
  async function initMidi() {
    if (E.midiSrc === 'bitwig') { syncBridge(); return; }
    if (E.midi.access || E.midi.status === 'requesting') return;
    if (!navigator.requestMIDIAccess) { setMidi('unsupported'); return; }
    setMidi('requesting');
    try {
      E.midi.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) { setMidi('blocked'); return; }
    E.midi.access.onstatechange = scanMidi;
    scanMidi();
  }
  function scanMidi() {
    const inputs = [...E.midi.access.inputs.values()].filter(i => i.state !== 'disconnected');
    inputs.forEach(inp => {
      if (midiInputs.has(inp)) return;
      midiInputs.add(inp);
      inp.onmidimessage = ev => { if (midiPath() === 'web') midiMessage(ev.data, ev.timeStamp, inp.name); };
      if (inp.open) inp.open().catch(() => { inp._sveBusy = true; scanMidi(); });
    });
    if (!inputs.length) { setMidi('none'); return; }
    const main = inputs.find(i => /kontrol|s88/i.test(i.name) && !/daw/i.test(i.name)) || inputs.find(i => !/daw/i.test(i.name)) || inputs[0];
    E.midi.name = main.name;
    setMidi(main._sveBusy ? 'busy' : 'ok');
  }
  function setMidi(status) { E.midi.status = status; updateUI(); }
  function webMidiText() {
    const m = E.midi;
    return { off: 'MIDI: off', requesting: 'MIDI: …', unsupported: 'MIDI: not supported', blocked: 'MIDI: blocked',
             none: 'MIDI: no device', busy: 'MIDI: ' + m.name + ' busy', ok: 'MIDI: ' + m.name + ' ✓' }[m.status];
  }
  // { text, ok, title } for the status pill.
  function midiInfo() {
    if (midiPath() === 'web') return { text: webMidiText(), ok: E.midi.status === 'ok', idle: E.midi.status === 'off' || E.midi.status === 'requesting', title: 'Web MIDI' };
    const b = bridge, why = E.midiSrc === 'auto' ? ' (Web MIDI: ' + webMidiText().replace('MIDI: ', '') + ')' : '';
    const title = 'Bitwig bridge: notes Bitwig receives on the selected track' + why;
    if (b.status === 'off') return { text: E.midi.status === 'off' && E.midiSrc === 'auto' ? 'MIDI: off' : 'MIDI: via Bitwig', idle: true, title };
    if (b.status === 'connecting') return { text: 'MIDI: via Bitwig …', idle: true, title };
    if (b.status === 'missing') return { text: 'MIDI: Bitwig bridge needs the updated extension', title };
    if (b.status === 'offline') return { text: 'MIDI: Bitwig bridge offline', title };
    if (E.playing && !E.recPlaying) return { text: 'MIDI: via Bitwig ⏸ (playing)', title: title + ' — paused while the transport plays' };
    if (!b.monitoring) return { text: 'MIDI: via Bitwig ✓ — track not monitoring', title: title + ' — turn on input monitoring (or select an instrument track) so Bitwig passes the keyboard to it' };
    return { text: 'MIDI: via Bitwig ✓', ok: true, title };
  }

  // ---- Bitwig bridge: long-poll GET /api/midi?since=<seq> -> { seq, playing, monitoring, events:[{seq, t, type, key, vel, playing}] }
  const bridge = { status: 'off', gen: 0, seq: -1, ctl: null, monitoring: true, ignored: 0 };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function setBridge(status) { if (bridge.status !== status) { bridge.status = status; updateUI(); } }
  function syncBridge() {
    const want = (E.on || E.learnTap || listenWanted()) && midiPath() === 'bridge';
    if (want && bridge.status === 'off') bridgeLoop();
    else if (!want && bridge.status !== 'off') {
      bridge.gen++;
      if (bridge.ctl) bridge.ctl.abort();
      setBridge('off');
    }
  }
  async function bridgeLoop() {
    const gen = ++bridge.gen;
    bridge.seq = -1;          // first request returns at once with the current seq: older events are not replayed
    setBridge('connecting');
    let fails = 0;
    while (gen === bridge.gen) {
      const ctl = bridge.ctl = new AbortController();
      try {
        const r = await fetch('/api/midi?since=' + bridge.seq, { cache: 'no-store', signal: ctl.signal });
        if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
        const j = await r.json();
        if (gen !== bridge.gen) break;
        fails = 0;
        bridge.monitoring = j.monitoring !== false;
        if (bridge.seq >= 0) (j.events || []).forEach(bridgeEvent);
        bridge.seq = j.seq;
        setBridge('ok');
      } catch (err) {
        if (gen !== bridge.gen) break;
        fails++;
        setBridge(err.status === 404 ? 'missing' : 'offline');
        await wait(Math.min(5000, 400 * fails));
      }
    }
  }
  // Bridge events carry Bitwig's own timestamps (ms), so chord grouping doesn't depend on poll arrival.
  function bridgeEvent(e) {
    if (e.type === 'on') {
      const playing = e.playing != null ? e.playing : E.playing;
      if (playing && !E.recPlaying) { bridge.ignored++; return; } // could be clip playback, not the player
      midiMessage([0x90, e.key, e.vel > 0 ? e.vel : 90], e.t, BRIDGE_PORT);
    } else if (e.type === 'off') midiMessage([0x80, e.key, 0], e.t, BRIDGE_PORT);
  }
  // Other modules (the controller) can keep MIDI open while entry is off: SV.entry.listeners.push(() => bool).
  const listeners = [];
  const listenWanted = () => listeners.some(f => { try { return !!f(); } catch (e) { return false; } });

  function setMidiSource(src) {
    if (!['auto', 'web', 'bitwig'].includes(src)) return;
    E.midiSrc = src;
    store.set('midiSource', src);
    held.clear(); group = null;
    if (E.on || E.learnTap || listenWanted()) initMidi();
    syncBridge();
    updateUI();
  }

  // ------------------------------------------------------------------ tapped rhythm (pedal or tap key)

  function tapInput(now) {
    if (!E.on) return;
    if (!E.capture) startCapture();
    E.capture.taps.push(now);
    clearTimeout(E.capture.timer);
    const idle = Math.max(1500, 2 * 60000 / (E.tempo || 120));
    E.capture.timer = setTimeout(finishCapture, idle);
    updateUI();
  }
  function startCapture() {
    if (E.capture) return;
    E.capture = { taps: [], timer: null };
    updateUI();
  }
  // Onsets -> slots: tempo from Bitwig's transport, quantized to the Quantize grid (or 8th triplets).
  function finishCapture() {
    const c = E.capture;
    E.capture = null;
    if (!c) return;
    clearTimeout(c.timer);
    if (!c.taps.length) { updateUI(); return; }
    const s = spb(), tempo = E.tempo || 120;
    const unit = E.triplet ? s / 3 : Math.max(1, Math.round(gridBeats() * s));
    const onsets = [...new Set(c.taps.map(t => Math.round(((t - c.taps[0]) * tempo / 60000) * s / unit) * unit))].sort((a, b) => a - b);
    const steps = onsets.map((o, i) => (i < onsets.length - 1 ? onsets[i + 1] - o : curSteps()));
    laySlots(steps.map(Math.round));
    SV.flash(onsets.length + ' taps → slots @ ' + Math.round(tempo) + ' BPM — now play the pitches');
  }

  // ------------------------------------------------------------------ geometry (caret, ghost, mouse → beat)

  let anchorsByMeasure = new Map(); // measure n -> [{beat, svgId}]
  function indexTimeline(r) {
    anchorsByMeasure = new Map();
    if (!r) return;
    const mb = r.measureBeats;
    r.timeline.forEach(t => {
      const n = Math.floor(t.start / mb + 1e-9) + 1;
      if (!anchorsByMeasure.has(n)) anchorsByMeasure.set(n, []);
      anchorsByMeasure.get(n).push(t);
    });
  }

  function staffGeom(measure, staffN) {
    const st = document.getElementById('m' + measure + 's' + staffN);
    if (!st) return null;
    const lines = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect()).filter(b => b.width > 20)
      .sort((a, b) => a.top - b.top);
    if (lines.length < 5) return null;
    const y = b => b.top + b.height / 2;
    const top = y(lines[0]), bottom = y(lines[4]), gap = (bottom - top) / 4;
    let left = lines[0].left;
    st.querySelectorAll(':scope > .clef, :scope > .keySig, :scope > .meterSig').forEach(g => {
      const b = g.getBoundingClientRect();
      if (b.width) left = Math.max(left, b.right);
    });
    return { el: st, top, bottom, gap, left: left + gap * 1.2, right: lines[0].right - gap * 0.9, lineRight: lines[0].right };
  }

  // Beat <-> x anchors for one measure: content start, every rendered note onset (notehead left), barline.
  function anchors(measure, geom) {
    const mb = measureBeats(), m0 = (measure - 1) * mb;
    const byBeat = new Map([[m0, geom.left]]);
    (anchorsByMeasure.get(measure) || []).forEach(t => {
      const el = document.getElementById(t.svgId);
      if (!el) return;
      const head = el.querySelector('.notehead') || el;
      const b = head.getBoundingClientRect();
      if (!b.width) return;
      const k = Math.round(t.start * 96) / 96;
      byBeat.set(k, Math.min(byBeat.has(k) && k !== m0 ? byBeat.get(k) : Infinity, b.left));
    });
    byBeat.set(m0 + mb, geom.right);
    return [...byBeat.entries()].map(([beat, x]) => ({ beat, x })).sort((a, b) => a.beat - b.beat);
  }

  function lerp(list, key, val, out) {
    if (val <= list[0][key]) return list[0][out];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (val <= b[key]) return b[key] === a[key] ? a[out] : a[out] + (b[out] - a[out]) * (val - a[key]) / (b[key] - a[key]);
    }
    return list[list.length - 1][out];
  }

  // Absolute (measure-based) beat -> { x, geom } on the given staff; handles the clip end barline.
  function beatPos(absBeat, staffN) {
    const mb = measureBeats();
    let measure = Math.floor(absBeat / mb + 1e-9) + 1;
    let geom = staffGeom(measure, staffN);
    if (!geom && Math.abs(absBeat - (measure - 1) * mb) < 1e-6) { measure -= 1; geom = staffGeom(measure, staffN); }
    if (!geom) return null;
    return { x: lerp(anchors(measure, geom), 'beat', absBeat, 'x'), geom, measure };
  }

  function mouseBeat(hit, clientX) {
    const st = caretStaff();
    const geom = staffGeom(hit.measure, hit.staff);
    if (!geom || !st) return hit.beat;
    const list = anchors(hit.measure, geom);
    return lerp(list, 'x', clientX - geom.gap * 0.6, 'beat');
  }

  // Mouse -> { x (clip step), absBeat, pitch, dia, staffN } snapped to the grid and key.
  function mouseTarget(e) {
    const hit = SV.hitTest(e);
    if (!hit || hit.part !== livePartName()) return null;
    const s = spb(), off = clipOffset();
    const unit = E.triplet ? Math.round(DURS[E.digit].b * 2 / 3 * s) : Math.max(1, Math.round(gridBeats() * s));
    const raw = mouseBeat(hit, e.clientX);
    let x = Math.round(((raw - off) * s) / unit) * unit;
    const d = live();
    x = Math.max(Math.round((d.playStart || 0) * s), Math.min(x, Math.round(d.length * s) - 1)); // inside the visible clip
    const absBeat = x / s + off;
    const fifths = (liveStaves().find(t => t.n === hit.staff) || {}).fifths || 0;
    const letter = ((hit.diatonic % 7) + 7) % 7;
    const pitch = harmonySnap(hit.pitch + keyAlter(letter, fifths) - (hit.transpose || 0), absBeat);
    return { x, absBeat, pitch, dia: hit.diatonic, staffN: hit.staff, fifths, transpose: hit.transpose || 0 };
  }

  // ------------------------------------------------------------------ overlay (caret, span band, ghost note)

  function overlayLayer() {
    let L = $('sve-layer');
    if (!L) {
      L = document.createElement('div');
      L.id = 'sve-layer';
      $('main').appendChild(L);
    }
    return L;
  }
  function toLocal(x, y) {
    const m = $('main'), r = m.getBoundingClientRect();
    return { x: x - r.left + m.scrollLeft, y: y - r.top + m.scrollTop };
  }

  function drawOverlay() {
    const L = overlayLayer();
    if (!E.on || !SV.state.render || !live()) { L.innerHTML = ''; return; }
    const st = caretStaff();
    if (!st) { L.innerHTML = ''; return; }
    let html = '';
    const off = clipOffset(), s = spb();
    const pos = beatPos(E.caret / s + off, st.n);
    if (pos) {
      const g = pos.geom;
      const p = toLocal(pos.x - g.gap * 0.45, g.top - g.gap * 1.6);
      const h = g.bottom - g.top + g.gap * 3.2;
      // Span the next entry will fill (stops at the end of the system).
      const endBeat = (E.caret + curSteps()) / s + off;
      const endPos = beatPos(endBeat, st.n);
      let endX = endPos && Math.abs(endPos.geom.top - g.top) < 2 ? endPos.x - g.gap * 0.45 : g.lineRight;
      if (!firstUnfilled() || E.rhythmFirst) {
        const bandL = toLocal(pos.x - g.gap * 0.45, g.top - g.gap * 0.6);
        html += `<div class="sve-band" style="left:${bandL.x}px;top:${bandL.y}px;width:${Math.max(4, endX - pos.x)}px;height:${g.bottom - g.top + g.gap * 1.2}px"></div>`;
      }
      html += `<div class="sve-caret${E.capture ? ' rec' : ''}" style="left:${p.x - 1}px;top:${p.y}px;height:${h}px"></div>`;
      const tag = toLocal(pos.x - g.gap * 0.45, g.top - g.gap * 1.6);
      html += `<div class="sve-tag" style="left:${tag.x}px;top:${tag.y}px">${E.capture ? '● ' + E.capture.taps.length : glyphSvg([{ b: DURS[E.digit].b, dot: E.dot }], { triplet: E.triplet, small: true })}${E.tie ? '<span class="sve-tie">⁀</span>' : ''}</div>`;
    }
    html += ghostHtml();
    L.innerHTML = html;
  }

  function ghostHtml() {
    const m = E.mouse;
    if (!m || !E.on) return '';
    const t = mouseTarget(m);
    if (!t) return '';
    const pos = beatPos(t.absBeat, t.staffN);
    if (!pos) return '';
    const g = pos.geom, st = liveStaves().find(x => x.n === t.staffN);
    const topDia = topLineDia(st && st.clef);
    const y = g.top + (topDia - t.dia) * g.gap / 2;
    const w = g.gap * 1.32, h = g.gap * 1.0;
    const at = toLocal(pos.x, y);
    let ledgers = '';
    const ledger = dia => {
      const ly = toLocal(0, g.top + (topDia - dia) * g.gap / 2).y;
      ledgers += `<div class="sve-ledger" style="left:${at.x - w * 0.3}px;top:${ly - 0.75}px;width:${w * 1.6}px"></div>`;
    };
    for (let dd = topDia + 2; dd <= t.dia; dd += 2) ledger(dd);
    for (let dd = topDia - 10; dd >= t.dia; dd -= 2) ledger(dd);
    const hollow = DURS[E.digit].b >= 2;
    return ledgers +
      `<svg class="sve-ghost" style="left:${at.x}px;top:${at.y - h / 2}px" width="${w}" height="${h}" viewBox="-6 -4.2 12 8.4">` +
      `<ellipse rx="5.2" ry="3.4" transform="rotate(-22)" ${hollow ? 'fill="none" stroke-width="1.7"' : ''}/></svg>` +
      `<div class="sve-gname" style="left:${at.x + w / 2}px;top:${Math.min(at.y, toLocal(0, g.top).y) - g.gap * 1.2}px">${pitchName(t.pitch + (t.transpose || 0), t.fifths)}</div>`;
  }

  function scrollCaretIntoView() {
    const st = caretStaff();
    if (!st || !E.on) return;
    const pos = beatPos(E.caret / spb() + clipOffset(), st.n);
    if (!pos) return;
    const m = $('main'), r = m.getBoundingClientRect();
    if (pos.geom.top < r.top + 20 || pos.geom.bottom > r.bottom - 20) m.scrollTop += pos.geom.top - r.top - r.height * 0.3;
    if (pos.x < r.left + 20 || pos.x > r.right - 40) m.scrollLeft += pos.x - r.left - r.width * 0.3;
  }

  // ------------------------------------------------------------------ note glyphs (status pill, keypad, cells)

  // Tiny engraved-looking rhythm: notes [{b: base beats, dot}], beamed in runs of sub-quarter notes.
  function glyphSvg(notes, { triplet = false, small = false } = {}) {
    const top = triplet ? 9 : 3, headY = top + 17, stemTop = top + 1, step = 11, pad = 5;
    const xs = [];
    let x = pad;
    notes.forEach(n => { xs.push(x); x += step + (n.dot ? 4 : 0); });
    const stemX = i => xs[i] + 3.1;
    let out = '';
    notes.forEach((n, i) => {
      const hollow = n.b >= 2;
      out += `<ellipse cx="${xs[i]}" cy="${headY}" rx="3.5" ry="2.5" transform="rotate(-20 ${xs[i]} ${headY})" ${hollow ? 'fill="none" stroke="currentColor" stroke-width="1.2"' : ''}/>`;
      if (n.b < 4) out += `<rect x="${stemX(i) - 0.5}" y="${stemTop}" width="1" height="${headY - stemTop - 0.5}"/>`;
      if (n.dot) out += `<circle cx="${xs[i] + 6.6}" cy="${headY - 1}" r="1.2"/>`;
    });
    const beams = n => (n.b <= 0.125 ? 3 : n.b <= 0.25 ? 2 : n.b <= 0.5 ? 1 : 0);
    let i = 0;
    while (i < notes.length) {
      if (beams(notes[i]) === 0) { i++; continue; }
      let j = i;
      while (j + 1 < notes.length && beams(notes[j + 1]) > 0) j++;
      if (j === i) {
        for (let k = 0; k < beams(notes[i]); k++) {
          const y = stemTop + k * 3.4;
          out += `<path d="M${stemX(i)} ${y} c0.6 3 5.2 4 4.2 9.5" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
        }
      } else {
        for (let lvl = 0; lvl < 3; lvl++) {
          const y = stemTop + lvl * 3.4;
          for (let k = i; k <= j; k++) {
            if (beams(notes[k]) <= lvl) continue;
            if (k < j && beams(notes[k + 1]) > lvl) out += `<rect x="${stemX(k) - 0.5}" y="${y}" width="${stemX(k + 1) - stemX(k) + 1}" height="2.2"/>`;
            else if (!(k > i && beams(notes[k - 1]) > lvl)) {
              const x0 = k < j ? stemX(k) : stemX(k) - 4.5;
              out += `<rect x="${x0 - 0.5}" y="${y}" width="5" height="2.2"/>`;
            }
          }
        }
      }
      i = j + 1;
    }
    if (triplet) out += `<text x="${(xs[0] + xs[xs.length - 1]) / 2 + 3}" y="${top + 0}" font-size="8.5" font-style="italic" font-weight="600" text-anchor="middle" font-family="Georgia,serif">3</text>`;
    const w = x - step + 10 + (notes[notes.length - 1].dot ? 2 : 0), h = headY + 5;
    const sc = small ? 0.8 : 1;
    return `<svg class="sve-glyph" width="${w * sc}" height="${h * sc}" viewBox="0 ${triplet ? 0 : 0} ${w} ${h}" fill="currentColor">${out}</svg>`;
  }

  // ------------------------------------------------------------------ UI

  SV.addStyle(`
    #sve-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 5; }
    .sve-caret { position: absolute; width: 2.5px; border-radius: 2px; background: ${CARET}; box-shadow: 0 0 0 1px #fff8, 0 0 8px ${CARET}88;
                 animation: sve-blink 1.1s ease-in-out infinite; }
    .sve-caret.rec { background: #e03131; box-shadow: 0 0 10px #e03131; }
    @keyframes sve-blink { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
    .sve-band { position: absolute; background: ${CARET}14; border: 1px solid ${CARET}33; border-left: 0; border-radius: 0 4px 4px 0; }
    .sve-tag { position: absolute; transform: translate(-50%, -100%); background: ${CARET}; color: #fff; border-radius: 5px; padding: 1px 4px 0;
               display: flex; align-items: center; gap: 2px; font: 600 11px system-ui; box-shadow: 0 1px 4px #0004; white-space: nowrap; }
    .sve-tag::after { content: ''; position: absolute; left: 50%; bottom: -4px; margin-left: -4px; border: 4px solid transparent; border-bottom: 0; border-top-color: ${CARET}; }
    .sve-tie { font-size: 14px; line-height: 10px; }
    .sve-ghost { position: absolute; overflow: visible; fill: ${CARET}; stroke: ${CARET}; opacity: .62; }
    .sve-ledger { position: absolute; height: 1.5px; background: ${CARET}; opacity: .55; }
    .sve-gname { position: absolute; transform: translate(-50%, -100%); font: 600 10px system-ui; color: #fff; background: ${CARET}cc; padding: 1px 5px; border-radius: 4px; }
    body.sve-on #paper { cursor: crosshair; box-shadow: 0 0 0 2px ${CARET}, 0 2px 12px #0006; }
    .sve-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 12px; background: #1b1b1b;
                border: 1px solid var(--line); color: var(--dim); font-size: 12px; white-space: nowrap; }
    .sve-pill.on { border-color: ${CARET}; color: #fff; }
    .sve-pill b { color: #b9a6ff; font-weight: 600; }
    .sve-pill .sve-glyph { color: #fff; }
    .sve-pill .flag { color: #fff; background: ${CARET}; border-radius: 3px; padding: 0 4px; font-size: 11px; }
    .sve-pill .midi.ok { color: #69db7c; }
    .sve-pill .midi.bad { color: #ffa94d; }
    .sve-btn { background: var(--bar2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px;
               cursor: pointer; font: inherit; display: inline-flex; align-items: center; gap: 4px; min-height: 26px; }
    .sve-btn:hover { border-color: ${CARET}; }
    .sve-btn.on { background: ${CARET}; border-color: ${CARET}; color: #fff; }
    .sve-btn.rec { background: #c92a2a; border-color: #c92a2a; color: #fff; }
    .sve-btn kbd, .sve-cell kbd { font: 9px ui-monospace, monospace; color: var(--dim); }
    #sve-midisrc { background: var(--bar2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; min-height: 26px; font: inherit; }
    .sve-chk { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--dim); white-space: nowrap; cursor: pointer; }
    .sve-btn.on kbd { color: #e5dbff; }
    #sve-panel { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
    #sve-panel .sve-row { display: flex; align-items: center; gap: 3px; }
    #sve-panel .sep { width: 1px; height: 22px; background: var(--line); }
    .sve-cell { background: #f4f2ec; color: #222; border: 1px solid #0000; border-radius: 5px; padding: 0 5px 0 3px; cursor: pointer;
                display: inline-flex; flex-direction: column; align-items: center; min-width: 30px; }
    .sve-cell:hover { border-color: ${CARET}; box-shadow: 0 0 0 1px ${CARET}; }
    .sve-cell kbd { color: #777; margin-top: -2px; }
    .sve-prefs { position: absolute; top: calc(100% + 4px); left: 0; z-index: var(--sv-z-menu, 30); width: 440px; max-height: 75vh; overflow: auto;
                 background: var(--sv-surface-1, var(--bar)); color: var(--text); border: 1px solid var(--line); border-radius: var(--sv-radius-md, 6px);
                 box-shadow: var(--sv-shadow-pop, 0 6px 20px #0008); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .sve-prefs.hidden { display: none; }
    .sve-prefs > label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .sve-prefs > label.sve-chk { justify-content: flex-start; }
    .sve-prefs > label.hidden { display: none; }
    .sve-prefs select { background: var(--bar2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; font: inherit; min-height: 24px; }
    .sve-ph { font-weight: 600; color: var(--text); margin-top: 2px; }
    .sve-laytable table, .sve-keys table { border-collapse: collapse; width: 100%; }
    .sve-laytable th { font: 600 11px ui-monospace, monospace; color: var(--dim); padding: 0 2px; }
    .sve-laytable td { text-align: center; padding: 1px 2px; background: #f4f2ec; color: #222; border: 1px solid var(--line); font-size: 13px; }
    .sve-laytable td .off { font-size: 8px; color: #888; }
    .sve-keys td { padding: 1px 4px; vertical-align: top; color: var(--dim); }
    .sve-keys td:first-child { white-space: nowrap; color: var(--text); }
    .sve-keys kbd { font: 11px ui-monospace, monospace; }
  `);

  const bar = SV.addToolbar('', { cluster: 'write', order: 100 });
  bar.innerHTML =
    `<button class="sve-btn" id="sve-toggle" title="Note entry mode (N)">✎ Entry <kbd>N</kbd></button>
     <span class="sve-pill" id="sve-pill"></span>
     <div id="sve-panel" class="hidden">
       <div class="sve-row" id="sve-keypad"></div><span class="sep"></span>
       <div class="sve-row">
         <button class="sve-btn" id="sve-rf" title="Rhythm → Pitch: digits and cells lay down empty slots; then MIDI or letters fill them left to right">Rhythm → Pitch</button>
         <button class="sve-btn" id="sve-tap" title="Tap a rhythm on the sustain pedal or the tap key; stops after a pause">● Tap</button>
         <button class="sve-btn" id="sve-tapkey" title="Click, then press a key on your keyboard to make it the tap key"></button>
         <button class="sve-btn" id="sve-midi" title="Reconnect MIDI">MIDI</button>
         <select id="sve-midisrc" title="MIDI source — Auto: Web MIDI if the browser can open the keyboard, else the notes Bitwig receives on the selected track">
           <option value="auto">Auto</option><option value="web">Web MIDI</option><option value="bitwig">Bitwig</option>
         </select>
         <label class="sve-chk" title="Bitwig bridge: also take notes while the transport plays (they may include clip playback)"><input type="checkbox" id="sve-recplay"> Record while playing</label>
       </div><span class="sep"></span>
       <div class="sve-row" id="sve-cells"></div>
     </div>`;
  // Keypad buttons carry the current layout's keys.
  function renderKeypad() {
    const lay = prefs.layout, K = what => keyFor(lay, what) || '';
    const tie = LAYOUTS[lay].numpadEnter === 'tie' ? 'T or numpad Enter' : 'T';
    $('sve-keypad').innerHTML = [7, 6, 5, 4, 3, 2].map(k =>
      `<button class="sve-btn" data-dur="${k}" title="${DURS[k].name} (${K(k)})">${glyphSvg([{ b: DURS[k].b }], { small: true })}<kbd>${K(k)}</kbd></button>`).join('') +
      `<button class="sve-btn" data-act="dot" title="Dot (.)">•<kbd>.</kbd></button>` +
      `<button class="sve-btn" data-act="trip" title="Triplets (Ctrl+3)">³<kbd>^3</kbd></button>` +
      `<button class="sve-btn" data-act="tie" title="Tie: the next entry of the same pitch extends the previous note (${tie})">⁀<kbd>T</kbd></button>` +
      `<button class="sve-btn" data-act="rest" title="Rest (${K('rest')})">rest<kbd>${K('rest')}</kbd></button>`;
    $('sve-prefs').querySelector('#sve-laytable').innerHTML = layoutTable(lay);
    updateUI();
  }
  // The layout's keys as a small table (shown in the preferences).
  function layoutTable(lay) {
    const L = LAYOUTS[lay], cell = v => typeof v === 'number' ? glyphSvg([{ b: DURS[v].b }], { small: true }) :
      v && v.off ? `<span class="off">${v.off}</span>` : v === 'sharp' ? '♯' : v === 'flat' ? '♭' : v === 'natural' ? '♮' : v || '';
    const keys = Object.keys(L.digits).sort((a, b) => (a === '0') - (b === '0') || a - b).concat(Object.keys(L.chars));
    return '<table><tr>' + keys.map(k => `<th>${k}</th>`).join('') + '</tr><tr>' +
      keys.map(k => `<td>${cell(k in L.digits ? L.digits[k] : L.chars[k])}</td>`).join('') + '</tr></table>';
  }
  const prefBox = document.createElement('div');
  prefBox.id = 'sve-prefs';
  prefBox.className = 'sve-prefs hidden';
  prefBox.innerHTML =
    `<div class="sve-ph">Note entry preferences</div>
     <label>Keypad layout <select id="sve-layout">${Object.keys(LAYOUTS).map(k => `<option value="${k}">${LAYOUTS[k].name}</option>`).join('')}</select></label>
     <div id="sve-laytable" class="sve-laytable"></div>
     <label class="sve-chk" id="sve-rowint-l" title="As in Sibelius: 1–9 on the number row add an interval above (Shift: below); the numpad keeps the durations. Off suits a laptop without a numpad.">
       <input type="checkbox" id="sve-rowint"> Number row adds intervals (Sibelius)</label>
     <label title="Legato patches (a legato keyswitch, or 'legato' in the track name): the previous note runs on into the next by this much, so the library plays the transition">
       Legato overlap <select id="sve-legato"><option value="off">Off</option><option value="small">Small (a 64th)</option>
       <option value="medium">Medium (a 32nd)</option><option value="large">Large (a 16th)</option></select></label>
     <label title="Short patches (staccato, spiccato, pizzicato, marcato …): how long the written note plays">
       Short notes <select id="sve-short"><option value="off">As written</option><option value="gap">Small gap</option>
       <option value="half">Half length</option></select></label>
     <label title="Warn when a note you enter is outside the instrument's range (Instruments ▾)">
       Range warning <select id="sve-range"><option value="off">Off</option><option value="range">Outside the range</option>
       <option value="comfort">Also outside the comfortable range</option></select></label>
     <div class="sve-ph">Keys in note entry</div>
     <div id="sve-keys" class="sve-keys"></div>`;
  $('sve-toggle').insertAdjacentHTML('afterend', '<button class="sve-btn" id="sve-prefs-btn" title="Note entry preferences: keypad layout, legato overlap, short notes, range warning">⚙</button>');
  bar.appendChild(prefBox);
  bar.style.position = 'relative';
  function renderKeys() {
    const box = $('sve-keys');
    if (!box || !SV.shortcuts) return;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    // Layout keys (re-registered when the layout changes, so last in the registry) right after N.
    const all = SV.shortcuts.list().filter(e => e.when === 'entry' || e.owner === 'entry');
    const lay = Object.keys(regs).map(k => all.find(e => e.owner === 'entry' && e.desc === regs[k].desc)).filter(Boolean);
    const rest = all.filter(e => !lay.includes(e));
    const n = rest.findIndex(e => e.owner === 'entry' && e.desc === 'note entry on / off');
    box.innerHTML = '<table>' + rest.slice(0, n + 1).concat(lay, rest.slice(n + 1))
      .map(e => `<tr><td>${SV.shortcuts.keyText(e).split(' / ').map(k => `<kbd>${esc(k)}</kbd>`).join(' ')}</td><td>${esc(e.desc)}</td></tr>`).join('') + '</table>';
  }
  function togglePrefs(open) {
    const show = open != null ? open : prefBox.classList.contains('hidden');
    prefBox.classList.toggle('hidden', !show);
    if (show) { renderKeys(); updateUI(); }
  }
  document.addEventListener('mousedown', e => { if (!prefBox.classList.contains('hidden') && !prefBox.contains(e.target) && e.target.id !== 'sve-prefs-btn') togglePrefs(false); });
  $('sve-cells').innerHTML = CELLS.map((c, i) =>
    `<button class="sve-cell" data-cell="${i}" title="${c.name} (F${i + 1})">${glyphSvg(c.glyph, { triplet: c.triplet, small: true })}<kbd>F${i + 1}</kbd></button>`).join('');

  bar.addEventListener('mousedown', e => { if (!e.target.closest('select, label')) e.preventDefault(); }); // keep keyboard focus on the score
  bar.addEventListener('change', e => {
    const id = e.target.id;
    if (id === 'sve-midisrc') setMidiSource(e.target.value);
    else if (id === 'sve-recplay') { E.recPlaying = e.target.checked; store.set('recPlaying', E.recPlaying); updateUI(); }
    else if (id === 'sve-layout') setPref('layout', e.target.value);
    else if (id === 'sve-rowint') setPref('rowIntervals', e.target.checked);
    else if (id === 'sve-legato') setPref('legatoOverlap', e.target.value);
    else if (id === 'sve-short') setPref('shortLen', e.target.value);
    else if (id === 'sve-range') setPref('rangeWarn', e.target.value);
    e.target.blur();
  });
  bar.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'sve-toggle') setOn(!E.on);
    else if (b.id === 'sve-prefs-btn') togglePrefs();
    else if (b.dataset.dur) { setDigit(+b.dataset.dur); }
    else if (b.dataset.act === 'dot') { E.dot = !E.dot; updateUI(); drawOverlay(); }
    else if (b.dataset.act === 'trip') { E.triplet = !E.triplet; updateUI(); drawOverlay(); }
    else if (b.dataset.act === 'tie') { E.tie = !E.tie; updateUI(); drawOverlay(); }
    else if (b.dataset.act === 'rest') rest();
    else if (b.dataset.cell) insertCell(+b.dataset.cell);
    else if (b.id === 'sve-rf') { E.rhythmFirst = !E.rhythmFirst; store.set('rhythmFirst', E.rhythmFirst); updateUI(); drawOverlay(); }
    else if (b.id === 'sve-tap') toggleTap();
    else if (b.id === 'sve-tapkey') { E.learnTap = !E.learnTap; updateUI(); if (E.learnTap) initMidi(); }
    else if (b.id === 'sve-midi') {
      E.midi.access = null; E.midi.status = 'off';
      bridge.gen++; if (bridge.ctl) bridge.ctl.abort(); bridge.status = 'off';
      initMidi(); syncBridge(); updateUI();
    }
  });

  function updateUI() {
    const pill = $('sve-pill');
    if (!pill) return;
    const durName = (E.dot ? 'dotted ' : '') + DURS[E.digit].name + (E.triplet ? ' triplet' : '');
    const mi = midiInfo();
    const flags = [E.rhythmFirst ? 'R→P' : '', E.chordMode ? 'chord' : '', E.tie ? 'tie' : '', E.capture ? '● ' + E.capture.taps.length + ' taps' : '']
      .filter(Boolean).map(f => `<span class="flag">${f}</span>`).join('');
    const open = E.slots.filter(s => !s.filled && !s.rest).length;
    pill.className = 'sve-pill' + (E.on ? ' on' : '');
    pill.innerHTML = (E.on ? '<b>ENTRY</b>' : 'Entry off') +
      ` ${glyphSvg([{ b: DURS[E.digit].b, dot: E.dot }], { triplet: E.triplet, small: true })}<span>${durName}</span>${flags}` +
      (open ? `<span>${open} slot${open > 1 ? 's' : ''} to fill</span>` : '') +
      `<span class="midi ${mi.ok ? 'ok' : mi.idle ? '' : 'bad'}" title="${mi.title.replace(/"/g, '&quot;')}">${mi.text}</span>`;
    $('sve-midisrc').value = E.midiSrc;
    $('sve-layout').value = prefs.layout;
    $('sve-rowint').checked = prefs.rowIntervals;
    $('sve-rowint-l').classList.toggle('hidden', prefs.layout !== 'sibelius');
    $('sve-legato').value = prefs.legatoOverlap;
    $('sve-short').value = prefs.shortLen;
    $('sve-range').value = prefs.rangeWarn;
    $('sve-prefs-btn').classList.toggle('on', !prefBox.classList.contains('hidden'));
    $('sve-recplay').checked = E.recPlaying;
    $('sve-recplay').parentElement.classList.toggle('hidden', midiPath() !== 'bridge');
    syncBridge();
    $('sve-toggle').classList.toggle('on', E.on);
    $('sve-panel').classList.toggle('hidden', !E.on);
    document.body.classList.toggle('sve-on', E.on);
    document.querySelectorAll('#sve-keypad [data-dur]').forEach(b => b.classList.toggle('on', +b.dataset.dur === E.digit));
    const act = (a, on) => { const b = document.querySelector(`#sve-keypad [data-act="${a}"]`); if (b) b.classList.toggle('on', on); };
    act('dot', E.dot); act('trip', E.triplet); act('tie', E.tie);
    $('sve-rf').classList.toggle('on', E.rhythmFirst);
    $('sve-tap').classList.toggle('rec', !!E.capture);
    $('sve-tap').textContent = E.capture ? '■ Stop tap' : '● Tap';
    $('sve-tapkey').textContent = E.learnTap ? 'Press a key…' : 'Tap key: ' + pitchName(E.tapKey, 0) + ' / pedal';
    $('sve-tapkey').classList.toggle('on', E.learnTap);
  }

  function setDigit(k) {
    if (!DURS[k]) return;
    E.digit = k;
    if (E.rhythmFirst) laySlots([curSteps()]);
    updateUI();
    drawOverlay();
  }

  function setOn(on) {
    if (on === E.on) return;
    if (on && !live()) { SV.flash('Select a clip in Bitwig to enter notes'); return; }
    E.on = on;
    if (on) {
      // Sibelius: with a note selected, input continues after it.
      const sel = [...SV.state.selection].filter(SV.isLive).map(SV.parseId);
      const d = live();
      if (sel.length) {
        const first = sel.sort((a, b) => b.x - a.x)[0];
        const notes = sel.filter(p => p.x === first.x);
        const n = d.notes.find(q => q.ch === first.ch && q.x === first.x && q.y === first.y);
        const steps = n ? notatedSteps(n) : curSteps();
        E.caret = first.x + steps;
        E.last = { x: first.x, steps, pitches: sortNum(notes.map(p => p.y)), ch: first.ch };
        E.staffN = staffForPitch(first.y);
      }
      E.caret = Math.max(firstStep(d), Math.min(E.caret, Math.round(d.length * spb())));
      initMidi();
    } else {
      if (E.capture) { clearTimeout(E.capture.timer); E.capture = null; }
      E.slots = []; E.history = []; E.tie = false; E.mouse = null; E.chordMode = false;
      held.clear(); group = null;
    }
    updateUI();
    SV.render();
    if (on) { const k = layoutShortcuts().dur; SV.flash('Entry: letters A–G, MIDI keys or click · ' + k.label + ' set the value (' + LAYOUTS[prefs.layout].name + ') · Esc to leave'); }
  }

  // The clip's visible start (content steps before playStart are trimmed away in Bitwig).
  const firstStep = d => Math.round(((d && d.playStart) || 0) * spb());

  function moveCaret(dir) { caretTo(E.caret + dir * curSteps()); }
  function caretTo(x) {
    const d = live();
    if (!d) return;
    E.caret = Math.max(firstStep(d), Math.min(Math.round(d.length * spb()), Math.round(x)));
    E.tie = false;
    clearAutoSel();
    drawOverlay();
    scrollCaretIntoView();
  }
  // Caret to the start of the next (dir 1) or previous (-1) bar.
  function moveBar(dir) {
    const d = live();
    if (!d) return;
    const s = spb(), off = clipOffset(), r = SV.state.render, mb = measureBeats();
    const abs = E.caret / s + off;
    const starts = r && Array.isArray(r.measureStarts) && r.measureStarts.length ? r.measureStarts.slice() : [];
    if (!starts.length) for (let b = 0; b <= d.length + off + mb; b += mb) starts.push(b);
    else starts.push(starts[starts.length - 1] + mb);
    const eps = 1e-6;
    const b = dir > 0 ? starts.find(v => v > abs + eps) : starts.filter(v => v < abs - eps).pop();
    caretTo(b == null ? (dir > 0 ? d.length * s : 0) : (b - off) * s);
  }
  // Duration index step: 2 (32nd) … 7 (whole).
  const stepDuration = dir => setDigit(Math.max(2, Math.min(7, E.digit + dir)));

  function toggleTap() {
    if (E.capture) finishCapture();
    else { startCapture(); SV.flash('Tap the rhythm on the pedal or the tap key (' + pitchName(E.tapKey, 0) + ')'); }
  }
  const toggleFlag = k => () => { E[k] = !E[k]; if (k === 'rhythmFirst') store.set('rhythmFirst', E.rhythmFirst); updateUI(); drawOverlay(); return E[k]; };

  // ------------------------------------------------------------------ hooks

  // Octave on the selection outside entry, or on a manual selection in entry (core moves notes; ids follow).
  function octaveSelection(dir) {
    if (!SV.state.selection.size || !SV.moveSelection) return false;
    SV.moveSelection(0, () => 12 * dir);
    return true;
  }
  // Interval on a selection that isn't entry's own (features/motifs.js does the work, with its harmony fit).
  function intervalSelection(n, dir) {
    if (SV.motifs && SV.motifs.addInterval) return SV.motifs.addInterval(n, dir);
    SV.flash('Select notes first');
    return true;
  }

  SV.hooks.keydown.push(e => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key, code = e.code || '';
    if (!ctrl && !e.altKey && !e.shiftKey && (k === 'n' || k === 'N')) { setOn(!E.on); return true; }
    if (!E.on) {
      // Ctrl+↑/↓ (Sibelius): octave on the selected notes.
      if (ctrl && !e.altKey && !e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) return octaveSelection(k === 'ArrowUp' ? 1 : -1);
      return false;
    }
    if (k === 'Escape' && !prefBox.classList.contains('hidden')) { togglePrefs(false); return true; }
    const act = keyAction(prefs.layout, { key: k, code, shift: e.shiftKey, alt: e.altKey, ctrl }, { rowIntervals: prefs.rowIntervals });
    if (act) {
      syncLast();
      const own = !SV.state.selection.size || isAutoSel();   // the selection is entry's last note (or nothing)
      switch (act.type) {
        case 'dur': setDigit(act.idx); return true;
        case 'rest': rest(); return true;
        case 'dot': E.dot = !E.dot; updateUI(); drawOverlay(); return true;
        case 'tie': E.tie = !E.tie; updateUI(); drawOverlay(); return true;
        case 'triplet': E.triplet = !E.triplet; updateUI(); drawOverlay(); return true;
        case 'acc': accidental(act.delta); return true;
        case 'off': SV.flash(`${act.name} notes are outside what Score View writes (32nd … whole)`); return true;
        case 'none': return true;
        case 'interval': if (!e.repeat) { if (own) addInterval(act.n, act.dir); else intervalSelection(act.n, act.dir); } return true;
        case 'octave': if (own) transposeLast(p => p + 12 * act.dir); else octaveSelection(act.dir); return true;
        case 'bar': moveBar(act.dir); return true;
      }
    }
    if (ctrl || e.altKey) return false;
    if (k === 'Escape') {
      if (E.capture) { finishCapture(); return true; }
      if (E.learnTap) { E.learnTap = false; updateUI(); return true; }
      setOn(false);
      SV.state.selection.clear(); SV.paintSelection();
      return true;
    }
    if (/^F[1-8]$/.test(k)) { insertCell(+k.slice(1) - 1); return true; }
    if (k === 'Backspace') { undoLast(); return true; }
    const lower = k.length === 1 ? k.toLowerCase() : '';
    if (lower in LETTER_IDX) { typeLetter(lower, e.shiftKey); return true; }
    if (lower === 'r' && !e.shiftKey) { repeatLast(); return true; }
    if (lower === 't' && !e.shiftKey) { E.tie = !E.tie; updateUI(); drawOverlay(); return true; }
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && !e.shiftKey) {
      syncLast();
      if (!SV.state.selection.size || isAutoSel()) { moveCaret(k === 'ArrowRight' ? 1 : -1); return true; }
    }
    return false;
  });

  // ---- shortcut registry (core/shortcuts.js). The layout-dependent entries are updated in place when the layout changes.
  const ACC_SIGN = { sharp: '♯', flat: '♭', natural: '♮' };
  // { dur: { keys, label, desc }, acc: …, rest: …, tie: …, row: … | null } for the current preferences.
  function layoutShortcuts() {
    const lay = prefs.layout, L = LAYOUTS[lay], row = prefs.rowIntervals && lay === 'sibelius';
    const durKeys = Object.keys(L.digits).filter(k => typeof L.digits[k] === 'number').sort();
    const pad = row ? 'Numpad' : '';
    const accKeys = Object.keys(L.digits).filter(k => L.digits[k] in ACC_SIGN).concat(Object.keys(L.chars).filter(k => L.chars[k] in ACC_SIGN));
    const restKey = keyFor(lay, 'rest');
    return {
      dur: { keys: durKeys.map(k => pad + k), label: (row ? 'numpad ' : '') + durKeys[0] + '–' + durKeys[durKeys.length - 1],
             desc: `duration: 32nd … whole (${L.name} layout${row ? '' : ', numpad too'})` },
      acc: { keys: accKeys.map(k => (k === '+' ? 'Plus' : k === '-' ? 'Minus' : k in L.digits ? pad + k : k)),
             label: accKeys.map(k => (k in L.digits && row ? 'numpad ' : '') + k + ' ' + ACC_SIGN[k in L.digits ? L.digits[k] : L.chars[k]]).join(' · '),
             desc: 'sharp / flat / natural on the last note' },
      rest: { keys: [restKey in L.digits ? pad + restKey : restKey], label: row && restKey in L.digits ? 'numpad ' + restKey : null, desc: 'rest' },
      tie: { keys: L.numpadEnter === 'tie' ? ['T', 'NumpadEnter'] : ['T'], label: null, desc: 'tie' },
      row: row ? { keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'].flatMap(k => [k, 'Shift+' + k]), label: '1–9 / Shift+1–9',
                   desc: 'add an interval above / below (number row, Sibelius)' } : null,
    };
  }
  const regs = {};
  function syncShortcuts() {
    if (SV.shortcuts) {
      Object.keys(regs).forEach(k => { if (SV.shortcuts.remove) SV.shortcuts.remove(regs[k]); delete regs[k]; });
      const want = layoutShortcuts();
      Object.keys(want).forEach(k => {
        if (want[k]) regs[k] = SV.shortcuts.register({ keys: want[k].keys, owner: 'entry', desc: want[k].desc, when: 'entry', label: want[k].label });
      });
    }
    renderKeys();
    renderHelp();
  }
  if (SV.shortcuts) {
    const R = (keys, desc, when = 'entry', label) => SV.shortcuts.register({ keys, owner: 'entry', desc, when, label });
    R('N', 'note entry on / off', 'always');
    syncShortcuts();
    R('.', 'dot');
    R('Ctrl+3', 'triplets');
    R(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'enter a note', 'entry', 'A–G');
    R(['Shift+A', 'Shift+B', 'Shift+C', 'Shift+D', 'Shift+E', 'Shift+F', 'Shift+G'], 'add a note to the chord', 'entry', 'Shift+A–G');
    R(['2', '3', '4', '5', '6', '7', '8', '9'].flatMap(k => ['Alt+' + k, 'Alt+Shift+' + k]),
      'add an interval above the last note (Shift: below): 3 = third … 8 = octave', 'entry', 'Alt+2–9 / Alt+Shift+2–9');
    R(['Ctrl+ArrowUp', 'Ctrl+ArrowDown'], 'octave up / down (the last entered or the selected notes)', 'always');
    R(['Ctrl+ArrowLeft', 'Ctrl+ArrowRight'], 'caret to the previous / next bar');
    R('R', 'repeat the last note or chord');
    R(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'], 'insert a rhythm cell', 'entry', 'F1–F8');
    R(['ArrowLeft', 'ArrowRight'], 'move the caret (moves selected notes instead)');
    R('Backspace', 'take back the last entry');
    R('Escape', 'stop tap capture, else leave note entry');
  }

  function clickEntry(e) {
    if (!E.on || e.button !== 0) return false;
    const t = mouseTarget(e);
    if (!t) {
      const hit = SV.hitTest(e);
      if (hit) SV.flash('Only the live clip (' + (livePartName() || '—') + ') can be written');
      return true;
    }
    E.staffN = t.staffN;
    if (e.ctrlKey || e.metaKey) {         // Ctrl+click: just place the caret
      E.caret = t.x; E.tie = false;
      clearAutoSel(); drawOverlay();
      return true;
    }
    const d = live();
    const here = d.notes.filter(n => n.x === t.x && n.y >= ksMin());
    if (here.length && !firstUnfilled()) {  // clicking on an existing onset adds to that chord (Sibelius)
      if (here.some(n => n.y === t.pitch)) { E.caret = t.x + notatedSteps(here[0]); drawOverlay(); return true; }
      E.last = { x: t.x, steps: notatedSteps(here[0]), pitches: sortNum(here.map(n => n.y)), ch: here[0].ch };
      SV.state.selection = new Set(here.map(n => idOf(n.ch, n.x, n.y)));
      addToChord(t.pitch);
      return true;
    }
    if (!firstUnfilled()) E.caret = t.x;
    enterPitches([t.pitch], 90, 'mouse');
    return true;
  }
  SV.hooks.paperClick.push(e => clickEntry(e));
  SV.hooks.noteClick.push((t, e) => clickEntry(e));

  let moveRaf = 0;
  $('paper').addEventListener('mousemove', e => {
    if (!E.on) return;
    E.mouse = { clientX: e.clientX, clientY: e.clientY, button: 0 };
    if (!moveRaf) moveRaf = requestAnimationFrame(() => { moveRaf = 0; drawOverlay(); });
  });
  $('paper').addEventListener('mouseleave', () => { if (E.on) { E.mouse = null; drawOverlay(); } });

  SV.hooks.transformScore.push(score => {
    if (!E.on || !E.slots.length) return score;
    const part = score.parts.find(p => p.name === livePartName());
    if (!part) return score;
    const s = spb(), mb = score.timeSig.num * 4 / score.timeSig.den;
    const shift = clipOffset() - (score.measureOffset || 0) * mb;
    const open = E.slots.filter(sl => !sl.filled);
    if (!open.length) return score;
    const next = open.filter(sl => !sl.rest).sort((a, b) => a.x - b.x)[0];
    const covered = x => open.some(sl => x >= sl.x && x < sl.x + sl.steps);
    const st = caretStaff();
    const pitch = middlePitch() - ((st && st.transpose) || 0); // sounding pitch; score.js re-applies the transposition
    part.notes = part.notes.filter(n => !(SV.isLive(n.id) && covered(SV.parseId(n.id).x)))
      .concat(open.filter(sl => !sl.rest).map(sl => ({
        id: 'P' + sl.id, start: sl.x / s + shift, dur: sl.steps / s, pitch, color: sl === next ? CARET : GREY,
      })));
    return score;
  });

  SV.hooks.afterRender.push(r => { indexTimeline(r); drawOverlay(); });

  SV.hooks.liveData.push(d => {
    if (E.expectSel && d && d.notes) {
      const present = new Set(d.notes.map(n => idOf(n.ch, n.x, n.y)));
      if ([...E.expectSel].every(id => present.has(id))) {
        SV.state.selection = new Set(E.expectSel);
        E.expectSel = null;
      }
    }
    if (E.on && (!d || !d.exists)) setOn(false);
  });

  SV.hooks.play.push(p => {
    if (!p) return;
    if (p.tempo) E.tempo = p.tempo;
    if (!!p.playing !== E.playing) { E.playing = !!p.playing; if (midiPath() === 'bridge') updateUI(); }
  });

  // Footer help line for entry, from the current layout (the full table is the registry's, "All keyboard shortcuts").
  function renderHelp() {
    let el = document.getElementById('sve-help');
    if (!el) { SV.addHelp('<span id="sve-help"></span>'); el = document.getElementById('sve-help'); }
    if (!el) return;
    const ks = layoutShortcuts(), kb = t => String(t).split(' ').map(w => /^[·/]$/.test(w) || /^[♯♭♮]$/.test(w) ? w : `<kbd>${w}</kbd>`).join(' ');
    el.innerHTML = `<b>Entry</b> <kbd>N</kbd> on/off · ${kb(ks.dur.label)} 32nd…whole (${LAYOUTS[prefs.layout].name}) · <kbd>.</kbd> dot · ` +
      '<kbd>Ctrl</kbd>+<kbd>3</kbd> triplets · <kbd>A</kbd>–<kbd>G</kbd> note · <kbd>Shift</kbd>+<kbd>A</kbd>–<kbd>G</kbd> add to chord · ' +
      `${kb(ks.acc.label)} · <kbd>Alt</kbd>+<kbd>2</kbd>–<kbd>9</kbd> add an interval (+<kbd>Shift</kbd> below) · ` +
      '<kbd>Ctrl</kbd>+<kbd>↑</kbd><kbd>↓</kbd> octave · <kbd>R</kbd> repeat · <kbd>T</kbd> tie · ' +
      `<kbd>${ks.rest.keys[0] === 'Comma' ? ',' : ks.rest.keys[0]}</kbd> rest · <kbd>F1</kbd>–<kbd>F8</kbd> rhythm cells · <kbd>←</kbd><kbd>→</kbd> caret · ` +
      '<kbd>Ctrl</kbd>+<kbd>←</kbd><kbd>→</kbd> bar · <kbd>Backspace</kbd> take back · click enters, <kbd>Ctrl</kbd>+click moves the caret · ' +
      'MIDI keys/chords enter at the caret · <kbd>Esc</kbd> leave · ⚙ layout and preferences';
  }

  renderKeypad();
  renderHelp();

  SV.entry = {
    state: E, cells: CELLS,
    // Preferences: prefs.layout (sibelius|dorico|musescore), rowIntervals, legatoOverlap, shortLen, rangeWarn; setPref(k, v) saves.
    prefs, setPref, LAYOUTS, keyAction: (ev, opts) => keyAction(prefs.layout, ev, opts || { rowIntervals: prefs.rowIntervals }),
    articAt, addInterval,
    toggle: setOn,
    setCaret(x) { E.caret = x; drawOverlay(); },
    // Test/automation entry point for MIDI: _midi([status, d1, d2], timeMs, portName) or _midi('on'|'off'|'cc', d1, d2, timeMs).
    _midi(a, b, c, t) {
      if (Array.isArray(a)) return midiMessage(a, b, c);
      const status = a === 'on' ? 0x90 : a === 'off' ? 0x80 : a === 'cc' ? 0xb0 : a;
      return midiMessage([status, b, c == null ? (a === 'off' ? 0 : 100) : c], t);
    },
    finishCapture,
    setMidiSource, midiPath, bridge,
    // For features/controller.js (controller-native entry).
    rawHooks, listeners, initMidi, syncBridge, BRIDGE_PORT, DURS, glyphSvg, pitchName, curSteps, spb,
    midiInputNames: () => (E.midi.access ? [...E.midi.access.inputs.values()].filter(i => i.state !== 'disconnected').map(i => i.name) : []),
    actions: {
      dur: k => setDigit(k), durNext: () => stepDuration(1), durPrev: () => stepDuration(-1),
      dot: toggleFlag('dot'), triplet: toggleFlag('triplet'), tie: toggleFlag('tie'), rhythmFirst: toggleFlag('rhythmFirst'),
      chordMode: toggleFlag('chordMode'),
      rest, repeat: repeatLast, undo: undoLast, tap: toggleTap,
      caret: dir => moveCaret(dir), caretSteps: n => caretTo(E.caret + n), bar: dir => moveBar(dir),
      accidental, octave: dir => transposeLast(p => p + 12 * dir), diatonic: dir => transposeLast(p => diatonicStep(p, dir)),
      chromatic: dir => transposeLast(p => p + dir), select: dir => selectAdjacent(dir),
      interval: (n, dir) => addInterval(n, dir),
      toggle: () => setOn(!E.on),
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
