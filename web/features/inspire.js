// Feature module: Inspire. Quick starting material written into the selected clip. First item:
// "Underscore string chords…" — fills N bars with a sustained, voice-led chord pad from a mood library
// (features/inspire-library.js). One clip, one staff (divisi); spreading it over a section is Orchestrate ▾ Explode.
// Existing notes in the range are replaced (preference: keep). "Again" swaps the last roll for another one.
// See docs/library-profiles.md for where this is heading. The pure core loads in Node: require('web/features/inspire.js').
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ pure core

  const LIB = (typeof window !== 'undefined' && window.SVInspireLibrary) || (typeof require === 'function' ? require('./inspire-library.js') : null);
  const MODES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
  const ROMAN = ['vii', 'vi', 'iv', 'v', 'iii', 'ii', 'i']; // longest first for parsing
  const DEGREE = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
  const SUFFIX = { '': [], '7': [10], maj7: [11], '6': [9], add9: [14] };
  const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const pc = p => ((p % 12) + 12) % 12;

  /** 'Iadd9' / 'i' / '♭II' / 'vii°' / 'Vsus4' / 'imaj7' in a mode -> { root (semitones above the tonic), tones, third, colors }. */
  function parseNumeral(s, mode) {
    let str = String(s).trim(), shift = 0;
    if (/^[♭b]/.test(str) && /^[♭b][ivIV]/.test(str)) { shift = -1; str = str.slice(1); }
    else if (/^[#♯]/.test(str)) { shift = 1; str = str.slice(1); }
    const low = str.toLowerCase();
    const rn = ROMAN.find(r => low.startsWith(r));
    if (!rn) throw new Error('Bad numeral ' + s);
    const written = str.slice(0, rn.length);
    let rest = str.slice(rn.length);
    const minor = written === written.toLowerCase();
    let dim = false;
    if (/^[°o]/.test(rest)) { dim = true; rest = rest.slice(1); }
    let third = dim || minor ? 3 : 4, fifth = dim ? 6 : 7, sus = 0;
    const m = rest.match(/^(sus2|sus4)?(maj7|7|6|add9)?$/);
    if (!m) throw new Error('Bad chord suffix ' + s);
    if (m[1]) { sus = m[1] === 'sus2' ? 2 : 5; third = null; }
    const colors = SUFFIX[m[2] || ''];
    const root = pc((MODES[mode] || MODES.major)[DEGREE[rn]] + shift);
    const tones = [0, third != null ? third : sus, fifth, ...colors].map(pc);
    return { numeral: String(s), root, third: third != null ? third : sus, fifth, colors: colors.map(pc), tones: [...new Set(tones)] };
  }

  function rng(seed) { // mulberry32
    let a = (seed >>> 0) || 1;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function combos(arr, k, start = 0, acc = [], out = []) {
    if (acc.length === k) { out.push(acc.slice()); return out; }
    for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); combos(arr, k, i + 1, acc, out); acc.pop(); }
    return out;
  }

  /** Best voicing (sorted pitches) of a chord inside [lo, hi], led smoothly from `prev`. */
  function voiceChord(chord, tonic, { lo, hi, voices, prev, rand, bassRoot = true }) {
    const rootPc = pc(tonic + chord.root);
    const pcs = new Set(chord.tones.map(t => pc(rootPc + t)));
    const pool = [];
    for (let p = lo; p <= hi; p++) if (pcs.has(pc(p))) pool.push(p);
    const n = Math.min(voices, pool.length);
    if (!n) return [];
    const thirdPc = pc(rootPc + chord.third), colorPcs = chord.colors.map(c => pc(rootPc + c));
    let best = null, bestScore = Infinity;
    for (const c of combos(pool, n)) {
      const cp = c.map(pc);
      let s = 0;
      if (!cp.includes(rootPc)) s += 30;
      if (!cp.includes(thirdPc)) s += 20;
      colorPcs.forEach(x => { if (!cp.includes(x)) s += 6; });
      if (cp.filter(x => x === thirdPc).length > 1) s += 8;
      if (bassRoot && cp[0] !== rootPc) s += 8;
      for (let i = 1; i < c.length; i++) {
        const gap = c[i] - c[i - 1];
        if (gap > 12) s += 10;
        if (gap === 1) s += 6;
      }
      if (c[c.length - 1] - c[0] > 24) s += 10;
      if (prev && prev.length === c.length) s += c.reduce((a, p, i) => a + Math.abs(p - prev[i]), 0);
      else s += Math.abs(c[c.length - 1] - (hi - 3)) * 0.6 + Math.abs(c[0] - (lo + 3)) * 0.3;
      s += rand() * 1.5;
      if (s < bestScore) { bestScore = s; best = c; }
    }
    return best;
  }

  /** Register window inside an instrument's comfortable range. */
  function windowFor(range, register) {
    const [lo, hi] = range && range.length === 2 ? range : [48, 84];
    const span = Math.min(19, hi - lo);
    if (register === 'low') return { lo, hi: lo + span };
    if (register === 'high') return { lo: hi - span, hi };
    const c = Math.round((lo + hi) / 2);
    return { lo: Math.max(lo, c - 10), hi: Math.min(hi, c - 10 + span) };
  }

  /**
   * Plans an underscore pad. opts: { mood, tonic (pitch class), bars, barSteps, startStep, range [lo,hi], seed,
   *   progression? (numerals, overrides the mood's), prev? (voicing to lead on from) }.
   * Returns { notes:[{x, y, d (steps), vel}], chords:[{numeral, name, x}], progression, mood }.
   */
  function plan(opts) {
    const mood = typeof opts.mood === 'string' ? LIB.byId(opts.mood) : opts.mood;
    if (!mood) throw new Error('Unknown mood');
    const seed = opts.seed || 1, rand = rng(seed * 7919 + 13);
    const progression = opts.progression || mood.progressions[(seed - 1) % mood.progressions.length];
    const chordSteps = mood.barsPerChord * opts.barSteps, end = opts.startStep + opts.bars * opts.barSteps;
    const win = windowFor(opts.range, mood.register);
    const tonic = pc(opts.tonic);
    const names = opts.flats === false ? SHARPS : FLATS;
    const notes = [], chords = [];
    let pedal = null, upLo = win.lo, upHi = win.hi;
    if (mood.pedal) {
      pedal = win.lo + pc(tonic - win.lo);
      upLo = pedal + 3; upHi = Math.max(win.hi, upLo + 14);
      if (opts.range) upHi = Math.min(upHi, opts.range[1]);
      notes.push({ x: opts.startStep, y: pedal, d: end - opts.startStep, vel: mood.velocity });
    }
    let prev = opts.prev && opts.prev.length === mood.voices ? opts.prev.slice().sort((a, b) => a - b) : null, held = [];
    for (let x = opts.startStep, i = 0; x < end; x += chordSteps, i++) {
      const chord = parseNumeral(progression[i % progression.length], mood.mode);
      const v = voiceChord(chord, tonic, { lo: upLo, hi: upHi, voices: mood.voices, prev, rand, bassRoot: !pedal });
      const d = Math.min(chordSteps, end - x);
      const rootName = names[pc(tonic + chord.root)];
      const suffix = chord.numeral.replace(/^[♭b#♯]?[ivIV]+/, '');
      const rootPc = pc(tonic + chord.root);
      chords.push({ numeral: chord.numeral, name: rootName + (chord.third === 3 && !/^[°o]/.test(suffix) ? (suffix === 'maj7' ? 'm(maj7)' : 'm' + suffix) : suffix),
                    x, end: x + d, root: rootPc, third: pc(rootPc + chord.third), pcs: chord.tones.map(t => pc(rootPc + t)) });
      const next = [];
      v.forEach((p, k) => {
        const h = held[k];
        if (h && h.y === p && h.x + h.d === x) { h.d += d; next.push(h); return; } // common tone: hold it
        const note = { x, y: p, d, vel: mood.velocity };
        notes.push(note); next.push(note);
      });
      held = next; prev = v;
    }
    return { notes, chords, progression, mood };
  }

  // ------------------------------------------------------------------ melody over chords

  /** Scale of the key, bent towards the chord's own tones (E major over A minor's V gives G♯, not G).
   *  A neighbour a semitone away gives way, unless it is the tonic (scale[0]) or itself a chord tone. */
  function localScale(scale, chordPcs) {
    const out = new Set(scale);
    chordPcs.forEach(c => {
      if (out.has(c)) return;
      [pc(c - 1), pc(c + 1)].forEach(nb => { if (nb !== scale[0] && !chordPcs.includes(nb)) out.delete(nb); });
      out.add(c);
    });
    return out;
  }
  function melodyWindow(range, register) {
    const [lo, hi] = range && range.length === 2 ? range : [60, 88];
    const span = hi - lo, mid = Math.round(lo + span / 2);
    if (register === 'high') return { lo: Math.max(lo, mid - 3), hi };
    if (register === 'low') return { lo, hi: Math.min(hi, mid + 5) };
    return { lo: Math.round(lo + span * 0.2), hi: Math.round(lo + span * 0.85) };
  }
  // Where in the window the line aims, by position u (0..1) in the phrase.
  function contourAt(shape, u) {
    if (shape === 'fall') return 0.78 - 0.5 * u;
    if (shape === 'flat') return 0.3 + 0.08 * Math.sin(Math.PI * 2 * u);
    const w = u < 0.6 ? u / 0.6 * 0.5 : 0.5 + (u - 0.6) / 0.4 * 0.5; // arch: peak at 60% of the phrase
    return 0.3 + 0.55 * Math.sin(Math.PI * w);
  }
  const scaleCell = (cell, barBeats) => { const sum = cell.reduce((a, b) => a + Math.abs(b), 0); return cell.map(b => b * barBeats / sum); };

  /**
   * Plans a melody over a chord timeline.
   * opts: { mood, chords:[{x, end, pcs, root, third}] (steps), tonic, startStep, bars, barSteps, spb, range [lo,hi], seed,
   *   prev? (pitch to lead on from), barOffset? (bars already sung in this phrase), finalPc? (pitch class of the very last note) }.
   * Returns { notes:[{x, y, d, vel}] }. Phrases are 4 bars: motif A, A again (new pitches), contrast B, cadence.
   */
  function planMelody(opts) {
    const mood = typeof opts.mood === 'string' ? LIB.byId(opts.mood) : opts.mood;
    const M = mood.melody, rand = rng((opts.seed || 1) * 104729 + 7);
    const scale = MODES[mood.mode].map(s => pc(opts.tonic + s));
    const win = melodyWindow(opts.range, M.register);
    const spb = opts.spb, barBeats = opts.barSteps / spb, end = opts.startStep + opts.bars * opts.barSteps;
    const pick = list => list[Math.floor(rand() * list.length)];
    const chordAt = x => { let c = null; for (const k of opts.chords) if (k.x <= x && x < k.end) c = k; return c; };
    const phraseBars = Math.min(4, opts.bars);
    const notes = [];
    let prev = opts.prev != null ? opts.prev : null, lastLeap = 0, cellA = null, cellB = null;
    const off = opts.barOffset || 0;
    for (let bar = 0; bar < opts.bars; bar++) {
      const inPhrase = (bar + off) % phraseBars;
      const lastOfPhrase = inPhrase === phraseBars - 1 || bar === opts.bars - 1;
      if (inPhrase === 0 || cellA == null) { cellA = pick(M.cells); cellB = pick(M.cells.filter(c => c !== cellA).concat(M.cells.length > 1 ? [] : [cellA])); }
      const cell = scaleCell(lastOfPhrase ? pick(M.cadences) : inPhrase === 2 ? cellB : cellA, barBeats);
      let beat = 0;
      cell.forEach((len, k) => {
        const at = beat;
        beat += Math.abs(len);
        const x = opts.startStep + bar * opts.barSteps + Math.round(at * spb), d = Math.round(Math.abs(len) * spb);
        if (len < 0 || x >= end) return; // rest
        const chord = chordAt(x);
        const u = (inPhrase + at / barBeats) / phraseBars;
        const target = win.lo + (win.hi - win.lo) * contourAt(M.contour, u);
        const strong = Math.round(at * spb) % Math.round(opts.barSteps / 2) === 0 || Math.abs(len) >= 1.5;
        const isEnd = lastOfPhrase && k === cell.length - 1;
        const isFinal = isEnd && bar === opts.bars - 1 && opts.finalPc != null;
        const tones = chord ? chord.pcs : scale;
        const sc = chord ? localScale(scale, chord.pcs) : new Set(scale);
        let best = null, bestCost = Infinity;
        for (let p = win.lo; p <= win.hi; p++) {
          const c = pc(p), chordTone = tones.includes(c);
          const allowed = strong || isEnd ? chordTone : sc.has(c) || (M.chromatic && prev != null && Math.abs(p - prev) === 1);
          if (!allowed || (isFinal && c !== pc(opts.finalPc))) continue;
          let cost = Math.abs(p - target) * 0.5;
          if (prev != null) {
            const iv = Math.abs(p - prev);
            cost += iv <= 2 ? 0 : iv <= 4 ? 1 : iv <= 7 ? 3 : 8;
            if (iv === 0) cost += M.chromatic ? -0.5 : 2.5;
            if (Math.abs(lastLeap) > 4 && Math.sign(p - prev) === Math.sign(lastLeap)) cost += 4; // answer a leap with a step back
          }
          if (isEnd && chord) cost -= c === chord.third ? 2 : c === chord.root ? (bar === opts.bars - 1 && c === pc(opts.tonic) ? 4 : 1.5) : 0;
          cost += rand() * 1.5;
          if (cost < bestCost) { bestCost = cost; best = p; }
        }
        if (best == null) return;
        const vel = Math.max(1, Math.min(127, Math.round(M.velocity + 10 * Math.sin(Math.PI * u) - 4 + rand() * 4 + (strong ? 3 : 0))));
        const dur = Math.min(d, end - x);
        // Sigh: a long strong note leans in from the scale step above, then resolves down onto the chord tone.
        const above = [best + 1, best + 2].find(q => sc.has(pc(q)));
        if (strong && !isEnd && dur >= spb * 1.5 && above != null && above <= win.hi && !tones.includes(pc(above)) && rand() < M.sigh) {
          const half = Math.round(dur / 2);
          notes.push({ x, y: above, d: half, vel: Math.min(127, vel + 4) }, { x: x + half, y: best, d: dur - half, vel: Math.max(1, vel - 6) });
        } else notes.push({ x, y: best, d: dur, vel });
        lastLeap = prev != null ? best - prev : 0;
        prev = best;
      });
    }
    return { notes, mood };
  }

  /**
   * The progression of an answering phrase: `count` chords. Parallel = restate the question's opening, then the mood's
   * cadential tail (seed picks which); contrasting = the opening of another of the mood's progressions instead.
   */
  function answerProgression(mood, question, count, seed, parallel) {
    const tails = mood.answers || [['V', 'I']];
    const tail = tails[(seed - 1) % tails.length];
    if (tail.length >= count) return tail.slice(tail.length - count);
    const need = count - tail.length;
    let opening;
    if (parallel && question && question.length) opening = Array.from({ length: need }, (_, i) => question[i % question.length]);
    else {
      const src = mood.progressions[seed % mood.progressions.length];
      opening = Array.from({ length: need }, (_, i) => src[i % src.length]);
    }
    return opening.concat(tail);
  }

  const Core = { parseNumeral, voiceChord, windowFor, plan, planMelody, answerProgression, localScale, melodyWindow, rng, MODES };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
  const SV = root.SV;
  if (!SV || !LIB) return;

  // ------------------------------------------------------------------ page integration

  const S = SV.state;
  const PREF_KEY = 'scoreview.inspire.prefs';
  const load = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } };
  const prefs = Object.assign({ mood: 'hopeful', melodyMood: 'hopeful', contMood: '', contStyle: 'parallel', contChords: '', contMelody: null,
                               bars: 8, key: 'auto', existing: 'replace' }, load());
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const live = () => { const d = S.liveData; return d && d.exists ? d : null; };
  const keyOf = n => n.ch + '_' + n.x + '_' + n.y;
  let lastRoll = null; // { keys:Set, opts } of the notes the last Write put down
  let seed = 1;
  let view = 'menu'; // 'menu' | 'underscore' | 'melody'

  function geometry() {
    const d = live();
    if (!d) return null;
    const spb = d.stepsPerBeat || 24, barSteps = Math.round(((d.num || 4) * 4 / (d.den || 4)) * spb);
    const first = Math.round((d.playStart || 0) * spb), len = Math.round(d.length * spb);
    return { d, spb, barSteps, first, len };
  }
  function defaultStartBar() {
    const g = geometry();
    if (!g) return 1;
    const sel = g.d.notes.filter(n => S.selection.has(SV.liveId(n)));
    if (!sel.length) return 1;
    const endStep = Math.max(...sel.map(n => n.x + Math.round(n.d * g.spb)));
    return Math.max(1, Math.ceil((endStep - g.first) / g.barSteps - 1e-6) + 1);
  }
  function autoTonic(mood) {
    const f = (S.render && S.render.keyFifths) || 0, major = pc(f * 7);
    return mood.mode === 'minor' ? pc(major + 9) : major;
  }
  function rangeFor(track) {
    try {
      const r = SV.instruments && SV.instruments.forPart ? SV.instruments.forPart({ name: track, notes: [] }) : null;
      if (r && !r.inst.unpitched) return r.comfort || r.range || null;
    } catch (e) { /* fall through */ }
    return null;
  }

  // The last pad Inspire wrote (clip steps), so a melody can be written over it from another clip in Clip mode.
  const PAD_KEY = 'scoreview.inspire.lastPad';
  const loadPad = () => { try { return JSON.parse(localStorage.getItem(PAD_KEY)); } catch (e) { return null; } };

  /**
   * Chords to write a melody over: the harmony of the other staves (Score mode); in Clip mode the other staves of the
   * last ⟳ Read project (placed by the crawled clip of the selected one); else the last Inspire pad.
   */
  function chordSource(g) {
    // score: {timeSig, parts, ...} in arranger beats; origin: the arranger beat of the clip's content step 0.
    const fromScore = (score, parts, origin, fifths, label) => {
      const chords = SV.harmony.analyze({ ...score, parts }).map(r => {
        const root = pc(r.root), pcs = r.chordPcs.map(pc);
        return { x: Math.round((r.start - origin) * g.spb), end: Math.round((r.end - origin) * g.spb), root, pcs,
                 third: pcs.includes(pc(root + 4)) ? pc(root + 4) : pc(root + 3) };
      }).filter(c => c.end > g.first && c.x < g.len);
      if (!chords.length) return null;
      const minorTonic = pc(fifths * 7 + 9);
      return { chords, label, tonic: chords[0].root === minorTonic ? minorTonic : pc(fifths * 7),
               mode: chords[0].root === minorTonic ? 'minor' : 'major' };
    };
    if (S.mode === 'score' && SV.harmony && SV.scoreModel) {
      const score = SV.scoreModel();
      const parts = score ? score.parts.filter(p => !/ ✎$/.test(p.name) && p.notes.length) : [];
      if (parts.length) {
        const src = fromScore(score, parts, SV.contentOrigin ? SV.contentOrigin() : 0, score.keyFifths || 0, 'the harmony of the other staves');
        if (src) return src;
      }
    }
    const crawled = crawlSource(g);
    if (crawled) {
      const src = fromScore(crawled.score, crawled.score.parts, crawled.origin, (S.render && S.render.keyFifths) || 0,
        'the other staves of the last arrangement read');
      if (src) return src;
    }
    const pad = loadPad();
    if (pad && pad.chords && pad.chords.length && pad.spb === g.spb) {
      const m = LIB.byId(pad.mood);
      return { chords: pad.chords, label: `the chords Inspire wrote on ${pad.track} (same clip bars)`, tonic: pad.tonic,
               mode: m ? m.mode : 'major', mood: pad.mood };
    }
    return null;
  }

  /**
   * Clip mode with a recent ⟳ Read project: the other tracks' notes under the selected clip, in arranger beats ->
   * { score, origin } | null. origin = the arranger beat of the clip's content step 0 (crawled clip start - play start).
   */
  function crawlSource(g) {
    const base = S.base;
    if (!base || base.source !== 'crawl' || !S.crawl || !SV.harmony || !SV.arrangement || !SV.arrangement.liveClip) return null;
    const m = SV.arrangement.liveClip();
    if (!m) return null;
    const origin = m.clip.start - (m.clip.playStart || 0);
    const from = origin + g.first / g.spb, to = origin + g.len / g.spb;
    const parts = base.parts.filter(p => p.name !== g.d.track)
      .map(p => ({ ...p, notes: p.notes.filter(n => n.pitch >= 24 && n.start < to && n.start + n.dur > from) })) // no keyswitches
      .filter(p => p.notes.length);
    return parts.length ? { score: { ...base, parts }, origin } : null;
  }

  // Deletes what Again/replace says to, adds the new notes, selects them. Returns the added notes.
  function commit(g, notes, startStep, end, again) {
    const lines = [], gone = new Set();
    const del = n => { const k = keyOf(n); if (!gone.has(k)) { gone.add(k); lines.push(`del ${n.ch} ${n.x} ${n.y}`); } };
    if (again && lastRoll) g.d.notes.filter(n => lastRoll.keys.has(keyOf(n))).forEach(del);
    if (prefs.existing === 'replace') g.d.notes.filter(n => n.x >= startStep && n.x < end).forEach(del);
    const present = new Set(g.d.notes.map(keyOf).filter(k => !gone.has(k)));
    const adds = notes.filter(n => !present.has('0_' + n.x + '_' + n.y));
    adds.forEach(n => lines.push(`add 0 ${n.x} ${n.y} ${n.vel} ${+(n.d / g.spb).toFixed(6)}`));
    SV.send(lines);
    const ids = adds.map(n => 'L0_' + n.x + '_' + n.y);
    SV.expectIds(ids);
    S.selection = new Set(ids);
    SV.paintSelection();
    lastRoll = { keys: new Set(adds.map(n => '0_' + n.x + '_' + n.y)) };
    q('insAgain').disabled = false;
    return adds;
  }

  // Reads the dialog's bar fields; returns { startBar, bars, useBars, startStep, end } or null (reported).
  function barsFromDialog(g) {
    const bars = Math.max(1, Math.min(256, Math.round(Number(q('insBars').value) || prefs.bars)));
    const startBar = Math.max(1, Math.round(Number(q('insStart').value) || 1));
    const startStep = g.first + (startBar - 1) * g.barSteps;
    const fit = Math.floor((g.len - startStep) / g.barSteps);
    if (fit < 1) { report(`Bar ${startBar} lies after the end of the clip — lengthen the clip in Bitwig first`, true); return null; }
    const useBars = Math.min(bars, fit);
    return { startBar, bars, useBars, startStep, end: startStep + useBars * g.barSteps };
  }
  const leftOut = r => (r.useBars < r.bars ? ` · ${r.bars - r.useBars} bar${r.bars - r.useBars > 1 ? 's' : ''} past the clip end left out` : '');

  function writeMelody(again) {
    const g = geometry();
    if (!g) return report('Select a clip in Bitwig first', true);
    const src = chordSource(g);
    if (!src) return report('No chords to write over. ⟳ Read project (the other tracks give the chords), or write a pad with Underscore string chords first.', true);
    const r = barsFromDialog(g);
    if (!r) return null;
    seed = again ? seed + 1 : seed;
    const style = LIB.byId(prefs.melodyMood) || LIB.MOODS[0];
    const mood = { ...style, mode: src.mode }; // the chords decide the scale; the mood decides the character
    const p = planMelody({ mood, chords: src.chords, tonic: src.tonic, startStep: r.startStep, bars: r.useBars,
                           barSteps: g.barSteps, spb: g.spb, range: rangeFor(g.d.track), seed });
    const adds = commit(g, p.notes, r.startStep, r.end, again);
    report(`${style.name} melody, bars ${r.startBar}–${r.startBar + r.useBars - 1}: ${adds.length} notes over ${src.label}` + leftOut(r));
    SV.flash(`Inspire: ${style.name} melody · ${adds.length} notes`);
    return p;
  }

  // ------------------------------------------------------------------ continue the phrase (answer a question)

  let lastWritten = null; // what the last Continue wrote (SV.orchestrate.writeTracks' `written`), removed by Again
  const EPS = 1e-6;
  const crawled = () => S.mode === 'score' && S.base && S.base.source === 'crawl' && S.crawl;
  const mbOf = () => { const ts = (S.base && S.base.timeSig) || { num: 4, den: 4 }; return ts.num * 4 / ts.den; };

  // A staff's notes in arranger beats: the arrangement read, with the live clip's current notes in its place.
  function staffNotes(name) {
    const base = S.base && S.base.parts.find(p => p.name === name);
    let notes = base ? base.notes.map(n => ({ start: n.start, dur: n.dur, pitch: n.pitch })) : [];
    const d = S.liveData, a = S.align;
    if (d && d.exists && a && d.track === name) {
      const spb = d.stepsPerBeat || 24, from = a.offset, to = a.offset + d.length - (d.playStart || 0);
      notes = notes.filter(n => n.start < from - EPS || n.start >= to - EPS)
        .concat(d.notes.map(n => ({ start: a.offset + n.x / spb - (d.playStart || 0), dur: n.d, pitch: n.y })));
    }
    return notes.filter(n => n.pitch >= 24).sort((x, y) => x.start - y.start || x.pitch - y.pitch);
  }
  // How chordal a staff is: average number of notes sounding at each onset.
  function density(notes) {
    if (!notes.length) return 0;
    const onsets = [...new Set(notes.map(n => Math.round(n.start * 96)))];
    return onsets.reduce((a, o) => a + notes.filter(n => n.start * 96 <= o + 0.5 && (n.start + n.dur) * 96 > o + 0.5).length, 0) / onsets.length;
  }
  function continueContext() {
    if (!crawled()) return { error: 'Switch to Score mode and ⟳ Read project first: Continue writes into both tracks through the arrangement.' };
    const staves = S.base.parts.map(p => p.name).filter(n => staffNotes(n).length);
    if (!staves.length) return { error: 'No notes in the arrangement yet' };
    const pad = loadPad();
    const byDensity = staves.map(n => ({ n, d: density(staffNotes(n)) })).sort((a, b) => b.d - a.d);
    const chordTrack = staves.includes(prefs.contChords) ? prefs.contChords : (pad && staves.includes(pad.track) ? pad.track : byDensity[0].n);
    const others = byDensity.filter(x => x.n !== chordTrack).sort((a, b) => a.d - b.d);
    const melodyTrack = prefs.contMelody === '' ? '' : staves.includes(prefs.contMelody) && prefs.contMelody !== chordTrack ? prefs.contMelody : (others[0] ? others[0].n : '');
    const all = [chordTrack, melodyTrack].filter(Boolean).flatMap(staffNotes);
    const mb = mbOf();
    const qStart = Math.floor(Math.min(...all.map(n => n.start)) / mb + EPS) * mb;
    const qEnd = Math.ceil(Math.max(...all.map(n => n.start + n.dur)) / mb - EPS) * mb;
    const question = pad && pad.track === chordTrack ? pad.chords.map(c => c.numeral) : null;
    return { staves, chordTrack, melodyTrack, mb, qStart, qEnd, bars: Math.round((qEnd - qStart) / mb), question, pad };
  }
  // The answer ends on the tonic chord (I / i, with any colour) → the melody's last note is the tonic.
  const endsOnTonic = numeral => /^[iI](add9|maj7|7|6|sus2|sus4)?$/.test(numeral);

  let lastCtx = null; // Again answers the same question (not the question plus the answer just written)
  async function writeContinue(again) {
    const ctx = again && lastCtx ? lastCtx : continueContext();
    if (!ctx.error) lastCtx = ctx;
    if (ctx.error) return report(ctx.error, true);
    if (!SV.orchestrate || !SV.orchestrate.writeTracks) return report('Needs the Orchestrate module', true);
    const style = LIB.byId(prefs.contMood) || LIB.MOODS[0];
    const answerBars = Math.max(1, Math.min(64, Math.round(Number(q('insBars').value) || ctx.bars)));
    const parallel = prefs.contStyle !== 'contrasting' && !!ctx.question;
    seed = again ? seed + 1 : 1;
    const fromPad = ctx.pad && ctx.pad.track === ctx.chordTrack;
    const mood = { ...style, mode: fromPad ? (LIB.byId(ctx.pad.mood) || style).mode : style.mode };
    const tonic = fromPad ? ctx.pad.tonic : autoTonic(mood);
    const spb = 24, barSteps = Math.round(ctx.mb * spb);
    const count = Math.ceil(answerBars / mood.barsPerChord);
    const progression = answerProgression(mood, ctx.question, count, seed, parallel);
    // Lead on from the question's last chord, as voiced.
    let lastChord = staffNotes(ctx.chordTrack).filter(n => n.start < ctx.qEnd - 0.25 && n.start + n.dur > ctx.qEnd - 0.25)
      .map(n => n.pitch).sort((a, b) => a - b);
    if (mood.pedal) lastChord = lastChord.slice(1);
    const pad = plan({ mood, tonic, bars: answerBars, barSteps, startStep: 0, range: rangeFor(ctx.chordTrack), seed, progression,
                       prev: lastChord, flats: ((S.render && S.render.keyFifths) || 0) <= 0 });
    const results = [{ track: ctx.chordTrack, notes: pad.notes.map(n => ({ start: ctx.qEnd + n.x / spb, dur: n.d / spb, pitch: n.y, vel: n.vel / 127 })) }];
    let melodyCount = 0;
    if (ctx.melodyTrack) {
      const mel = staffNotes(ctx.melodyTrack).filter(n => n.start >= ctx.qStart - EPS && n.start < ctx.qEnd - EPS);
      // Parallel period: the melody's first two bars come back as sung (the chords under them are the same).
      const motifBars = parallel && answerBars > 3 ? 2 : 0, motifEnd = ctx.qStart + motifBars * ctx.mb;
      const motif = mel.filter(n => n.start < motifEnd - EPS)
        .map(n => ({ start: ctx.qEnd + (n.start - ctx.qStart), dur: Math.min(n.dur, motifEnd - n.start), pitch: n.pitch, vel: 0.65 }));
      const prevPitch = motif.length ? motif[motif.length - 1].pitch : (mel.length ? mel[mel.length - 1].pitch : null);
      const rest = planMelody({ mood: { ...mood, melody: style.melody }, chords: pad.chords, tonic, startStep: motifBars * barSteps,
                                bars: answerBars - motifBars, barSteps, spb, range: rangeFor(ctx.melodyTrack), seed, prev: prevPitch,
                                barOffset: motifBars, finalPc: endsOnTonic(progression[progression.length - 1]) ? tonic : null });
      const notes = motif.concat(rest.notes.map(n => ({ start: ctx.qEnd + n.x / spb, dur: n.d / spb, pitch: n.y, vel: n.vel / 127 })));
      melodyCount = notes.length;
      results.push({ track: ctx.melodyTrack, notes });
    }
    q('insWrite').disabled = true; q('insAgain').disabled = true;
    report('Writing the answer…');
    let r;
    try { r = await SV.orchestrate.writeTracks(results, { remove: again && lastWritten ? lastWritten : [] }); }
    finally { q('insWrite').disabled = false; }
    const from = Math.round(ctx.qEnd / ctx.mb) + 1, to = from + answerBars - 1;
    if (r.error) return report(r.error.replace(/ — create one in Bitwig \(or lengthen it\)/g, ` — lengthen the clip in Bitwig so it reaches bar ${to + 1}`), true);
    if (r.failed && r.failed.length) report('Not written — ' + r.failed.join(' · '), true);
    lastWritten = r.written;
    q('insAgain').disabled = false;
    const names = pad.chords.map(c => c.name).join(' ');
    report(`${parallel ? 'Parallel' : 'Contrasting'} answer, bars ${from}–${to}: ${progression.join(' – ')}  (${names})`
      + (ctx.melodyTrack ? ` · ${melodyCount} melody notes on ${ctx.melodyTrack}` : ''));
    SV.flash(`Inspire: answer ${progression.join(' – ')}`);
    return { pad, progression };
  }

  /** Writes a roll. again=true removes the previous roll first and uses the next seed. */
  function write({ again = false } = {}) {
    if (view === 'melody') return writeMelody(again);
    if (view === 'continue') return writeContinue(again);
    const g = geometry();
    if (!g) return report('Select a clip in Bitwig first', true);
    const mood = LIB.byId(prefs.mood);
    const r = barsFromDialog(g);
    if (!r) return null;
    prefs.bars = r.bars; savePrefs();
    seed = again ? seed + 1 : seed;
    const tonic = prefs.key === 'auto' ? autoTonic(mood) : Number(prefs.key);
    const flats = ((S.render && S.render.keyFifths) || 0) <= 0;
    const p = plan({ mood, tonic, bars: r.useBars, barSteps: g.barSteps, startStep: r.startStep, range: rangeFor(g.d.track), seed, flats });
    commit(g, p.notes, r.startStep, r.end, again);
    try { localStorage.setItem(PAD_KEY, JSON.stringify({ track: g.d.track, spb: g.spb, tonic, mood: mood.id, chords: p.chords })); } catch (e) { /* ignore */ }
    const prog = p.chords.map(c => c.numeral).join(' – '), names = p.chords.map(c => c.name).join(' ');
    report(`${mood.name}, bars ${r.startBar}–${r.startBar + r.useBars - 1}: ${prog}  (${names})` + leftOut(r));
    SV.flash(`Inspire: ${mood.name} · ${prog}`);
    return p;
  }

  // ------------------------------------------------------------------ UI

  SV.addStyle(`
    .ins { position: relative; }
    .ins-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; width: 360px; max-width: calc(100vw - 32px);
      background: var(--bar, #232323); border: 1px solid var(--line, #3a3a3a); border-radius: 6px; padding: 8px 10px;
      box-shadow: 0 6px 20px #0008; color: var(--text, #ddd); font-size: 13px; }
    .ins-item { display: block; width: 100%; text-align: left; background: none; border: 0; color: inherit; padding: 6px 8px; border-radius: 4px; cursor: pointer; font: inherit; }
    .ins-item:hover, .ins-item:focus-visible { background: var(--line, #3a3a3a); outline: none; }
    .ins-h { font-size: 11px; font-weight: 600; color: var(--dim, #8a8a8a); text-transform: uppercase; letter-spacing: .05em; margin: 2px 0 6px; }
    .ins-row { display: grid; grid-template-columns: 92px 1fr; align-items: center; gap: 6px; margin: 5px 0; }
    .ins-row input[type=number] { width: 64px; }
    .ins-blurb { color: var(--dim, #8a8a8a); font-size: 12px; margin: 2px 0 6px 98px; }
    .ins-status { margin-top: 8px; font-size: 12px; white-space: pre-line; }
    .ins-status.bad { color: #e8875b; }
    .ins-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
  `);

  const group = SV.addToolbar('<div class="ins"><button class="btn" id="insBtn" title="Inspire: quick starting material for the selected clip">Inspire ▾</button>'
    + '<div class="ins-panel hidden" id="insPanel"></div></div>', { cluster: 'write', order: 80 });
  const panel = group.querySelector('#insPanel');
  const q = id => panel.querySelector('#' + id);
  const KEYS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

  function showMenu() {
    panel.innerHTML = '<div class="ins-h">Inspire</div>'
      + '<button class="ins-item" data-open="underscore">Underscore string chords…</button>'
      + '<button class="ins-item" data-open="melody">Melody over the chords…</button>'
      + '<button class="ins-item" data-open="continue">Continue the phrase…</button>';
  }
  function showContinue() {
    const ctx = continueContext();
    if (!LIB.byId(prefs.contMood)) prefs.contMood = ctx.pad && LIB.byId(ctx.pad.mood) ? ctx.pad.mood : LIB.MOODS[0].id;
    const opt = (v, label, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
    const staves = ctx.staves || [];
    const ends = ctx.question ? ctx.question[ctx.question.length - 1] : null;
    const qa = ctx.error ? 0 : Math.round(ctx.qEnd / ctx.mb);
    const source = ctx.error ? esc(ctx.error)
      : `Question: bars ${Math.round(ctx.qStart / ctx.mb) + 1}–${qa}${ends ? ', ending on ' + esc(ends) : ''}. The answer starts at bar ${qa + 1}: `
        + 'the clips must reach that far (lengthen them in Bitwig, then Read project).';
    panel.innerHTML = '<div class="ins-h">Continue the phrase</div>'
      + `<label class="ins-row">Mood <select id="insMood">${LIB.MOODS.map(m => opt(m.id, m.name, m.id === prefs.contMood)).join('')}</select></label>`
      + `<label class="ins-row">Answer <select id="insStyle">${opt('parallel', 'Parallel: restate the opening, then cadence', prefs.contStyle !== 'contrasting')}`
      + `${opt('contrasting', 'Contrasting: new material, then cadence', prefs.contStyle === 'contrasting')}</select></label>`
      + `<label class="ins-row">Chords on <select id="insChords">${staves.map(n => opt(n, n, n === ctx.chordTrack)).join('')}</select></label>`
      + `<label class="ins-row">Melody on <select id="insMelody">${opt('', '— none —', !ctx.melodyTrack)}${staves.map(n => opt(n, n, n === ctx.melodyTrack)).join('')}</select></label>`
      + `<label class="ins-row">Bars <input type="number" id="insBars" min="1" max="64" value="${ctx.bars || 8}"></label>`
      + `<div class="ins-blurb" id="insSource">${source}</div>`
      + '<div class="ins-actions"><button class="btn" id="insAgain" disabled title="Replace the last answer with another one">Again</button>'
      + '<button class="btn" id="insWrite">Write</button><button class="btn" id="insClose">Close</button></div>'
      + '<div class="ins-status" id="insStatus"></div>';
    q('insMood').addEventListener('change', e => { prefs.contMood = e.target.value; lastWritten = null; q('insAgain').disabled = true; savePrefs(); });
    q('insStyle').addEventListener('change', e => { prefs.contStyle = e.target.value; savePrefs(); });
    q('insChords').addEventListener('change', e => { prefs.contChords = e.target.value; savePrefs(); showContinue(); });
    q('insMelody').addEventListener('change', e => { prefs.contMelody = e.target.value; savePrefs(); showContinue(); });
    q('insWrite').addEventListener('click', () => { lastWritten = null; lastCtx = null; write(); });
    q('insAgain').addEventListener('click', () => write({ again: true }));
    q('insClose').addEventListener('click', close);
    if (ctx.error) q('insWrite').disabled = true;
    q('insWrite').focus();
  }
  function showMelody() {
    const g = geometry(), src = g ? chordSource(g) : null;
    if (src && src.mood && LIB.byId(src.mood)) prefs.melodyMood = src.mood;
    if (!LIB.byId(prefs.melodyMood)) prefs.melodyMood = LIB.MOODS[0].id;
    let start = defaultStartBar(), bars = prefs.bars;
    if (src && g) {
      const first = Math.max(g.first, Math.min(...src.chords.map(c => c.x))), last = Math.min(g.len, Math.max(...src.chords.map(c => c.end)));
      start = Math.max(1, Math.floor((first - g.first) / g.barSteps) + 1);
      bars = Math.max(1, Math.ceil((last - (g.first + (start - 1) * g.barSteps)) / g.barSteps - 1e-6));
    }
    panel.innerHTML = '<div class="ins-h">Melody over the chords</div>'
      + `<label class="ins-row">Mood <select id="insMood">${LIB.MOODS.map(m => `<option value="${m.id}" ${m.id === prefs.melodyMood ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`
      + '<div class="ins-blurb" id="insBlurb"></div>'
      + `<label class="ins-row">Bars <input type="number" id="insBars" min="1" max="256" value="${bars}"></label>`
      + `<label class="ins-row">Start at bar <input type="number" id="insStart" min="1" value="${start}"></label>`
      + `<label class="ins-row">Existing notes <select id="insExisting"><option value="replace" ${prefs.existing === 'replace' ? 'selected' : ''}>Replace them</option><option value="keep" ${prefs.existing === 'keep' ? 'selected' : ''}>Keep them</option></select></label>`
      + `<div class="ins-blurb" id="insSource">${src ? 'Chords: ' + esc(src.label) : 'No chords found yet — ⟳ Read project (the other tracks give the chords), or write a pad first.'}</div>`
      + '<div class="ins-actions"><button class="btn" id="insAgain" disabled title="Replace the last melody with another one in the same mood">Again</button>'
      + '<button class="btn" id="insWrite">Write</button><button class="btn" id="insClose">Close</button></div>'
      + '<div class="ins-status" id="insStatus"></div>';
    const blurb = () => { const m = LIB.byId(prefs.melodyMood); q('insBlurb').textContent = MELODY_BLURB[m.melody.contour] || ''; };
    blurb();
    q('insMood').addEventListener('change', e => { prefs.melodyMood = e.target.value; seed = 1; lastRoll = null; q('insAgain').disabled = true; savePrefs(); blurb(); });
    q('insExisting').addEventListener('change', e => { prefs.existing = e.target.value; savePrefs(); });
    q('insWrite').addEventListener('click', () => { seed = 1; lastRoll = null; write(); });
    q('insAgain').addEventListener('click', () => write({ again: true }));
    q('insClose').addEventListener('click', close);
    q('insWrite').focus();
  }
  const MELODY_BLURB = { arch: 'Singing line in four-bar phrases, rising to a peak and settling on a chord tone.',
    fall: 'Falling, sighing line: long notes lean in from the step above and resolve down.',
    flat: 'Sparse and low: rests, repeated notes and creeping semitone neighbours.' };
  function showUnderscore() {
    const moods = LIB.MOODS;
    if (!LIB.byId(prefs.mood)) prefs.mood = moods[0].id;
    panel.innerHTML = '<div class="ins-h">Underscore string chords</div>'
      + `<label class="ins-row">Mood <select id="insMood">${moods.map(m => `<option value="${m.id}" ${m.id === prefs.mood ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`
      + '<div class="ins-blurb" id="insBlurb"></div>'
      + `<label class="ins-row">Bars <input type="number" id="insBars" min="1" max="256" value="${prefs.bars}"></label>`
      + `<label class="ins-row">Start at bar <input type="number" id="insStart" min="1" value="${defaultStartBar()}"></label>`
      + `<label class="ins-row">Key <select id="insKey"><option value="auto">Auto (from the key signature)</option>${KEYS.map((k, i) => `<option value="${i}" ${String(i) === String(prefs.key) ? 'selected' : ''}>${k}</option>`).join('')}</select></label>`
      + `<label class="ins-row">Existing notes <select id="insExisting"><option value="replace" ${prefs.existing === 'replace' ? 'selected' : ''}>Replace them</option><option value="keep" ${prefs.existing === 'keep' ? 'selected' : ''}>Keep them</option></select></label>`
      + '<div class="ins-actions"><button class="btn" id="insAgain" disabled title="Replace the last chords with another progression/voicing from the same mood">Again</button>'
      + '<button class="btn" id="insWrite">Write</button><button class="btn" id="insClose">Close</button></div>'
      + '<div class="ins-status" id="insStatus"></div>';
    const blurb = () => { q('insBlurb').textContent = LIB.byId(prefs.mood).blurb; };
    blurb();
    q('insMood').addEventListener('change', e => { prefs.mood = e.target.value; seed = 1; lastRoll = null; q('insAgain').disabled = true; savePrefs(); blurb(); });
    q('insKey').addEventListener('change', e => { prefs.key = e.target.value; savePrefs(); });
    q('insExisting').addEventListener('change', e => { prefs.existing = e.target.value; savePrefs(); });
    q('insWrite').addEventListener('click', () => { seed = 1; lastRoll = null; write(); });
    q('insAgain').addEventListener('click', () => write({ again: true }));
    q('insClose').addEventListener('click', close);
    q('insWrite').focus();
  }
  function report(msg, bad) {
    const st = panel.querySelector('#insStatus');
    if (st) { st.textContent = msg; st.classList.toggle('bad', !!bad); }
    if (bad) SV.flash(msg);
    return null;
  }
  function open(v) {
    view = v;
    panel.classList.remove('hidden');
    view = view || 'menu';
    if (view === 'underscore') showUnderscore(); else if (view === 'melody') showMelody(); else if (view === 'continue') showContinue(); else showMenu();
  }
  function close() {
    panel.classList.add('hidden');
    const m = document.getElementById('main'); if (m) m.focus();
  }

  group.querySelector('#insBtn').addEventListener('click', e => {
    if (panel.classList.contains('hidden')) open(); else close();
    e.stopPropagation();
  });
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('click', e => {
    const b = e.target.closest('[data-open]');
    if (b) { view = b.dataset.open; if (view === 'melody') showMelody(); else if (view === 'continue') showContinue(); else showUnderscore(); }
    e.stopPropagation();
  });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && q('insWrite')) { q('insWrite').click(); e.preventDefault(); }
    e.stopPropagation();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) close(); }, true);
  document.addEventListener('mousedown', e => { if (!group.contains(e.target) && !panel.classList.contains('hidden')) close(); });

  if (SV.shortcuts) {
    SV.shortcuts.register({ keys: 'Escape', owner: 'inspire', desc: 'close the Inspire panel', when: 'Inspire panel' });
    SV.shortcuts.register({ keys: 'Enter', owner: 'inspire', desc: 'write into the clip', when: 'Inspire panel' });
  }
  SV.addHelp('<b>Inspire ▾</b> Underscore string chords: fills bars of the selected clip with a voice-led chord pad from a mood library · <b>Again</b> rolls another one');

  root.SV.inspire = { ...Core, open, close, write, library: LIB };
})(typeof window !== 'undefined' ? window : globalThis);
