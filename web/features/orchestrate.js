// Feature module: orchestrate. Writes material into OTHER tracks' clips: Explode (spread a chord/passage over
// several instruments), Double (copy a line at unison/octave/third/sixth) and Reduce (merge staves onto one track).
// Bitwig lets the extension write only into the selected clip, so every target clip is reached with the
// extension's clip navigator: one batch per target track = goto <lane> <start> <track> → add … → gotoHome
// (ClipNavigator.java, GET /api/nav). Needs a live arrangement read (SV.state.crawl, features/arrangement.js).
// See docs/orchestration.md. The pure core loads in Node for unit tests: require('web/features/orchestrate.js').
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ pure core

  const EPS = 1e-6;
  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  const tonicOf = fifths => (((fifths || 0) * 7) % 12 + 12) % 12;
  function toDia(p, fifths) {
    const rel = p - tonicOf(fifths), oct = Math.floor(rel / 12), r = rel - oct * 12;
    let i = 6;
    while (SCALE[i] > r) i--;
    return { d: oct * 7 + i, alt: r - SCALE[i] };
  }
  function fromDia(d, alt, fifths) {
    const oct = Math.floor(d / 7), i = d - oct * 7;
    return tonicOf(fifths) + oct * 12 + SCALE[i] + (alt || 0);
  }
  // Diatonic interval the way an engraver thinks: spell the note as the score does (B♮, E♭ …), move by letter,
  // and give the new letter the key signature's accidental (B♮ + a third in E♭ = D, not D♯).
  const SBuild = (typeof window !== 'undefined' && window.ScoreBuilder) || (typeof require === 'function' ? require('../score.js') : null);
  const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'], NATURAL = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const keyAlter = (letter, fifths) => {
    if (fifths > 0 && 'fcgdaeb'.slice(0, fifths).includes(letter)) return 1;
    if (fifths < 0 && 'beadgcf'.slice(0, -fifths).includes(letter)) return -1;
    return 0;
  };
  function diaShift(p, steps, fifths) {
    if (!SBuild) { const q = toDia(p, fifths); return fromDia(q.d + steps, 0, fifths); }
    const sp = SBuild.makeSpeller(fifths || 0)(p);
    const d = sp.oct * 7 + LETTERS.indexOf(sp.pname) + steps, oct = Math.floor(d / 7), letter = LETTERS[d - oct * 7];
    return (oct + 1) * 12 + NATURAL[letter] + keyAlter(letter, fifths || 0);
  }
  const fmt = v => String(Math.round(v * 1e6) / 1e6);
  const barOf = (beat, measureBeats) => Math.floor(beat / measureBeats + EPS) + 1;

  // Moves p by octaves into range [lo, hi] (the nearest octave); null when the range is narrower than needed.
  function fitRange(p, range) {
    if (!range) return p;
    const [lo, hi] = range;
    let q = p;
    while (q < lo) q += 12;
    while (q > hi) q -= 12;
    return q >= lo && q <= hi ? q : null;
  }

  // Notes grouped by onset, each group's pitches high to low.
  function onsetGroups(notes) {
    const groups = [];
    [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch).forEach(n => {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.start - n.start) < EPS) g.notes.push(n); else groups.push({ start: n.start, notes: [n] });
    });
    return groups;
  }

  // Top-down order for voicing: higher instruments first (range middle), then score order (t.rank, e.g. Vln I
  // before Vln II), then the given order.
  function orderTargets(targets) {
    const mid = t => t.range ? (t.range[0] + t.range[1]) / 2 : 60;
    const rank = t => Number.isFinite(t.rank) ? t.rank : 0;
    return targets.map((t, i) => ({ t, i })).sort((a, b) => mid(b.t) - mid(a.t) || rank(a.t) - rank(b.t) || a.i - b.i).map(x => x.t);
  }

  /**
   * Explode: distributes each onset's notes over the targets, top-down (targets: [{name, range?, bass?}] in
   * top-down order, see orderTargets). One note per instrument: with more notes than instruments the top notes
   * and the bass are kept (inner notes dropped); with fewer, instruments double (Vln I+II on the top note…).
   * opts.bassOctave: targets flagged `bass` (double basses) play the lowest note an octave lower.
   * opts.keepRanges: notes are moved by octaves into the target's range (or dropped when that is impossible).
   * Returns { byTarget: Map(name -> notes), dropped, refit, outOfRange }.
   */
  function explode(notes, targets, { bassOctave = true, keepRanges = true } = {}) {
    const byTarget = new Map(targets.map(t => [t.name, []]));
    let dropped = 0, refit = 0, outOfRange = 0;
    let basses = bassOctave && targets.length > 1 ? targets.filter(t => t.bass) : [];
    let upper = targets.filter(t => !basses.includes(t));
    if (!upper.length) { upper = targets; basses = []; }
    const put = (t, n, pitch) => {
      const q = keepRanges ? fitRange(pitch, t.range) : pitch;
      if (q == null || q < 0 || q > 127) { outOfRange++; return; }
      if (q !== pitch) refit++;
      const list = byTarget.get(t.name);
      if (!list.some(m => Math.abs(m.start - n.start) < EPS && m.pitch === q)) list.push({ start: n.start, dur: n.dur, pitch: q, vel: n.vel });
    };
    onsetGroups(notes).forEach(g => {
      const seen = new Set(), P = g.notes.filter(n => !seen.has(n.pitch) && seen.add(n.pitch)); // high -> low, unique
      const n = P.length, k = upper.length;
      upper.forEach((t, i) => {
        let idx;
        if (n >= k) idx = k === 1 ? 0 : i < k - 1 ? i : n - 1;
        else idx = Math.floor(i * n / k);
        put(t, P[idx], P[idx].pitch);
      });
      if (n > k) dropped += n - k;
      basses.forEach(t => put(t, P[n - 1], P[n - 1].pitch - 12));
    });
    return { byTarget, dropped, refit, outOfRange };
  }

  const INTERVALS = {
    unison: { label: 'Unison', semis: 0 },
    octUp: { label: 'Octave above', semis: 12 },
    octDown: { label: 'Octave below', semis: -12 },
    twoOctDown: { label: 'Two octaves below', semis: -24 },
    thirdUp: { label: 'Third above (diatonic)', steps: 2 },
    thirdDown: { label: 'Third below (diatonic)', steps: -2 },
    sixthUp: { label: 'Sixth above (diatonic)', steps: 5 },
    sixthDown: { label: 'Sixth below (diatonic)', steps: -5 },
  };

  /** Double: the notes at an interval (INTERVALS key; thirds/sixths follow the key `fifths`), fitted to range. */
  function double(notes, { interval = 'unison', fifths = 0, range = null, keepRanges = true } = {}) {
    const iv = INTERVALS[interval] || INTERVALS.unison;
    let refit = 0, outOfRange = 0;
    const out = [];
    const raw = notes.map(n => iv.steps ? diaShift(n.pitch, iv.steps, fifths) : n.pitch + iv.semis);
    // Keep the line's shape: move it as a whole by the octave that fits most notes, then fit the rest one by one.
    let shift = 0;
    if (keepRanges && range) {
      let best = -1;
      [0, -12, 12, -24, 24, -36, 36].forEach(s => {
        const fit = raw.filter(p => p + s >= range[0] && p + s <= range[1]).length;
        if (fit > best) { best = fit; shift = s; }
      });
    }
    notes.forEach((n, i) => {
      const p = raw[i];
      const q = keepRanges ? fitRange(p + shift, range) : p;
      if (q == null || q < 0 || q > 127) { outOfRange++; return; }
      if (q !== p) refit++;
      out.push({ start: n.start, dur: n.dur, pitch: q, vel: n.vel });
    });
    return { notes: out, refit, outOfRange };
  }

  /** Reduce: merges several note lists into one (same onset + pitch once, the longest), optionally fitted to range. */
  function reduce(lists, { range = null, keepRanges = false } = {}) {
    const byKey = new Map();
    let refit = 0, outOfRange = 0;
    lists.flat().forEach(n => {
      const q = keepRanges ? fitRange(n.pitch, range) : n.pitch;
      if (q == null) { outOfRange++; return; }
      if (q !== n.pitch) refit++;
      const k = Math.round(n.start * 1e6) + ':' + q, old = byKey.get(k);
      if (!old || n.dur > old.dur) byKey.set(k, { start: n.start, dur: n.dur, pitch: q, vel: n.vel });
    });
    return { notes: [...byKey.values()].sort((a, b) => a.start - b.start || b.pitch - a.pitch), refit, outOfRange };
  }

  // ---- clips and writes

  /** Clips per track (sorted by start), each as { clip, end } with the visible end in arranger beats. */
  function clipIndex(crawl, clipEnd) {
    const by = new Map();
    (crawl.result || []).forEach(c => { if (!by.has(c.track)) by.set(c.track, []); by.get(c.track).push(c); });
    const out = new Map();
    by.forEach((list, track) => {
      list.sort((a, b) => a.start - b.start);
      out.set(track, list.map((c, i) => ({ clip: c, end: clipEnd(c, list[i + 1]) })));
    });
    return out;
  }

  // Arranger beat where a looping clip's first pass ends (later passes repeat the loop region).
  const firstPassEnd = c => c.loop && c.loopLength > 0 ? c.start + (c.loopStart + c.loopLength - c.playStart) : Infinity;

  /**
   * Plans writing notes (arranger beats: {start, dur, pitch, vel 0..1}) into track's clips:
   * { track, writes:[{clip, lane, adds:[{ch, x, y, vel (0-127), d}]}] } or { track, error }.
   * A note needs a clip that covers its start (x = round((beat - clip.start + clip.playStart) * stepsPerBeat));
   * it is shortened to the clip's end. Clips that loop more than once are refused (a note would repeat).
   */
  function planTarget(crawl, track, notes, { clipEnd, measureBeats = 4, index } = {}) {
    const spb = crawl.stepsPerBeat || 24;
    const spans = (index || clipIndex(crawl, clipEnd)).get(track) || [];
    const writes = new Map();
    for (const n of [...notes].sort((a, b) => a.start - b.start)) {
      const s = spans.find(sp => sp.clip.start <= n.start + EPS && n.start < sp.end - EPS);
      if (!s) return { track, error: `No clip on ${track} at bar ${barOf(n.start, measureBeats)} — create one in Bitwig (or lengthen it), then Read project again` };
      const c = s.clip;
      if (s.end > firstPassEnd(c) + EPS) {
        return { track, error: `The clip on ${track} at bar ${barOf(c.start, measureBeats)} loops — notes written into it would repeat in every pass. Consolidate it (or turn its loop off) in Bitwig first` };
      }
      const x = Math.round((n.start - c.start + c.playStart) * spb);
      if (x < 0) return { track, error: `Bar ${barOf(n.start, measureBeats)} lies before the content of the clip on ${track}` };
      const d = Math.max(1 / spb, Math.min(n.dur, s.end - n.start));
      const vel = Math.max(1, Math.min(127, Math.round((n.vel == null ? 0.8 : n.vel) * 127)));
      if (!writes.has(c)) writes.set(c, { clip: c, lane: c.lane, adds: [] });
      const w = writes.get(c);
      const i = w.adds.findIndex(a => a.x === x && a.y === n.pitch);
      const add = { ch: 0, x, y: n.pitch, vel, d };
      if (i >= 0) { if (d > w.adds[i].d) w.adds[i] = add; } else w.adds.push(add);
    }
    return { track, writes: [...writes.values()] };
  }

  /** One navigator batch: goto each clip, add its notes, return to the original clip. */
  function batchLines(plan, homeLane) {
    const lines = [];
    plan.writes.forEach(w => {
      lines.push(`goto ${w.lane} ${w.clip.start} ${encodeURIComponent(w.clip.track)}`);
      w.adds.forEach(a => lines.push(`add ${a.ch} ${a.x} ${a.y} ${a.vel} ${fmt(a.d)}`));
    });
    lines.push(homeLane == null || homeLane < 0 ? 'gotoHome' : 'gotoHome ' + homeLane);
    return lines;
  }

  /** Puts a plan's notes into the crawl's clips (so the score can be rebuilt without reading Bitwig again). */
  function applyToCrawl(plan) {
    plan.writes.forEach(w => w.adds.forEach(a => {
      const notes = w.clip.notes;
      const i = notes.findIndex(n => n[0] === a.ch && n[1] === a.x && n[2] === a.y);
      const row = [a.ch, a.x, a.y, a.d, a.vel];
      if (i >= 0) notes[i] = row; else notes.push(row);
    }));
  }

  const laneOf = (crawl, track) => { const c = (crawl.result || []).find(r => r.track === track); return c ? c.lane : -1; };

  const Core = { toDia, fromDia, diaShift, fitRange, onsetGroups, orderTargets, explode, double, reduce, INTERVALS,
                 clipIndex, firstPassEnd, planTarget, batchLines, applyToCrawl, laneOf, barOf };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
  const SV = root.SV;
  if (!SV) return;

  // ------------------------------------------------------------------ page integration

  const PREF_KEY = 'scoreview.orchestrate.prefs';
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  // stayOpen: a click in the score (to select the source notes) keeps the panel open; any other outside click closes it.
  const prefs = Object.assign({ op: 'explode', interval: 'octDown', bassOctave: true, keepRanges: true, reduceFit: false,
                                targets: {}, reduceTarget: '', stayOpen: true }, load(PREF_KEY, {}));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const live = () => location.protocol.startsWith('http');
  let busy = false;

  const crawlOk = () => { const st = SV.state; return st.crawl && st.base && st.base.source === 'crawl' ? st.crawl : null; };
  const clipEndFn = () => (SV.arrangement && SV.arrangement.clipEnd) || ((c, next) => next ? next.start : c.start + c.playStop - c.playStart);
  const measureBeats = () => { const ts = (SV.state.base && SV.state.base.timeSig) || { num: 4, den: 4 }; return ts.num * 4 / ts.den; };
  const autoFifths = () => (SV.state.render ? SV.state.render.keyFifths : 0) || 0;
  const fifths = () => (prefs.keyFifths != null && prefs.keyFifths !== 'auto' ? Number(prefs.keyFifths) : autoFifths());
  const KEY_NAMES = ['G♭ / e♭m', 'D♭ / b♭m', 'A♭ / fm', 'E♭ / cm', 'B♭ / gm', 'F / dm', 'C / am', 'G / em', 'D / bm', 'A / f♯m', 'E / c♯m', 'B / g♯m', 'F♯ / d♯m'];

  function instInfo(name) {
    const ins = SV.instruments;
    let info = null;
    try { info = ins && ins.forPart ? ins.forPart({ name, notes: [] }) : null; } catch (e) { info = null; }
    const inst = info && info.inst;
    return { name, range: inst && inst.range && !inst.auto ? inst.range : null, bass: !!(inst && inst.id === 'doublebass'),
             rank: info ? info.scoreOrder : undefined };
  }
  // Tracks that have clips, in score order when the sections module is there.
  function crawlTracks() {
    const crawl = crawlOk();
    if (!crawl) return [];
    const names = [...new Set(crawl.result.map(c => c.track))];
    const order = (crawl.tracks || []).map(t => t.name);
    names.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
    const S = SV.sections;
    return S && S.scoreOrder ? S.scoreOrder(names, n => n) : names;
  }
  const bracketOf = name => { const S = SV.sections; try { return S && S.scoreInfo ? S.scoreInfo(name).bracket : null; } catch (e) { return null; } };

  // Selected live notes in arranger beats (Score mode places the live clip at state.align.offset).
  function selectedSource() {
    const d = SV.state.liveData, a = SV.state.align;
    if (!d || !d.exists) return { error: 'Select a clip in Bitwig first' };
    if (SV.state.mode !== 'score' || !a) return { error: 'Switch to Score mode (the selected clip must be placed in the score)' };
    const spb = d.stepsPerBeat || 24, sel = SV.state.selection;
    const notes = d.notes.filter(n => sel.has(SV.liveId(n)))
      .map(n => ({ start: a.offset + n.x / spb - (d.playStart || 0), dur: n.d, pitch: n.y, vel: (n.vel == null ? 100 : n.vel) / 127 }));
    if (!notes.length) return { error: 'Select some notes first (or choose staves and bars as the source)' };
    return { notes, track: d.track };
  }
  // Notes of a staff in arranger beats: the base, with the live clip's current notes in its place.
  function staffNotes(name) {
    const st = SV.state, base = st.base && st.base.parts.find(p => p.name === name);
    let notes = base ? base.notes.map(n => ({ start: n.start, dur: n.dur, pitch: n.pitch, vel: n.vel == null ? 0.8 : n.vel })) : [];
    const d = st.liveData, a = st.align;
    if (d && d.exists && a && d.track === name) {
      const spb = d.stepsPerBeat || 24;
      notes = notes.filter(n => n.start < a.offset - EPS || n.start >= a.offset + d.length - EPS)
        .concat(d.notes.map(n => ({ start: a.offset + n.x / spb, dur: n.d, pitch: n.y, vel: (n.vel == null ? 100 : n.vel) / 127 })));
    }
    return notes.filter(n => n.pitch >= 24); // keyswitches stay where they are
  }
  function stavesSource(names, fromBar, toBar) {
    if (!names.length) return { error: 'Choose at least one source staff' };
    const mb = measureBeats(), s = (fromBar - 1) * mb, e = toBar * mb;
    if (!(e > s)) return { error: 'Check the bar range' };
    const lists = names.map(n => staffNotes(n).filter(q => q.start >= s - EPS && q.start < e - EPS).map(q => ({ ...q, dur: Math.min(q.dur, e - q.start) })));
    if (!lists.some(l => l.length)) return { error: `No notes in bars ${fromBar}–${toBar} of the chosen staves` };
    return { lists, notes: lists.flat(), track: names[0] };
  }

  /** Computes the per-target notes for an operation. Returns { results:[{track, notes}], info, error? }. */
  function compute(op, src, opts) {
    if (op === 'explode') {
      const targets = orderTargets(opts.targets.map(instInfo));
      if (!targets.length) return { error: 'Choose the target tracks' };
      const r = explode(src.notes, targets, opts);
      const info = [];
      if (r.dropped) info.push(r.dropped + ' inner note' + (r.dropped > 1 ? 's' : '') + ' left out (more notes than instruments)');
      if (r.refit) info.push(r.refit + ' moved by octaves into range');
      if (r.outOfRange) info.push(r.outOfRange + ' out of range, left out');
      return { results: targets.map(t => ({ track: t.name, notes: r.byTarget.get(t.name) })), info };
    }
    if (op === 'double') {
      if (!opts.targets.length) return { error: 'Choose the target tracks' };
      const info = [];
      const results = opts.targets.map(name => {
        const r = double(src.notes, { interval: opts.interval, fifths: fifths(), range: instInfo(name).range, keepRanges: opts.keepRanges });
        if (r.refit) info.push(`${name}: ${r.refit} moved by octaves into range`);
        if (r.outOfRange) info.push(`${name}: ${r.outOfRange} out of range, left out`);
        return { track: name, notes: r.notes };
      });
      return { results, info };
    }
    if (op === 'reduce') {
      const target = opts.reduceTarget;
      if (!target) return { error: 'Choose the target track' };
      const r = reduce(src.lists || [src.notes], { range: instInfo(target).range, keepRanges: opts.reduceFit });
      const info = [];
      if (r.refit) info.push(r.refit + ' moved by octaves into range');
      if (r.outOfRange) info.push(r.outOfRange + ' out of range, left out');
      return { results: [{ track: target, notes: r.notes }], info };
    }
    return { error: 'Unknown operation ' + op };
  }

  /** Plans every target: [{track, notes, writes?, error?}]. */
  function planAll(computed) {
    const crawl = crawlOk(), index = clipIndex(crawl, clipEndFn()), mb = measureBeats();
    return computed.results.map(r => {
      if (!r.notes.length) return { track: r.track, notes: r.notes, error: 'nothing to write' , empty: true };
      return { notes: r.notes, ...planTarget(crawl, r.track, r.notes, { clipEnd: clipEndFn(), measureBeats: mb, index }) };
    });
  }

  async function navStatus() { return (await fetch('/api/nav', { cache: 'no-store' })).json(); }

  // Sends one batch and waits until the navigator has handled its gotoHome. Returns the nav status.
  async function runBatch(lines) {
    const before = (await navStatus()).batches;
    await fetch('/api/edit', { method: 'POST', body: lines.join('\n') });
    const deadline = Date.now() + 20000 + lines.length * 50;
    let st;
    while (Date.now() < deadline) {
      await sleep(120);
      st = await navStatus();
      if (st.batches > before && !st.session) return st;
      if (st.state === 'running') status(st.message + '…');
    }
    return { state: 'error', message: 'No answer from the extension (timeout)', results: [] };
  }

  // The navigator returns to the clip under the play start marker; make sure that is the selected clip.
  async function homeCheck(crawl) {
    const d = SV.state.liveData;
    if (!d || !d.exists || d.source !== 'arranger') return 'Select a clip in the Arranger first (Score View must follow the Arranger)';
    if (SV.state.playing) return 'Stop playback first';
    let t;
    try { t = await (await fetch('/api/transport', { cache: 'no-store' })).json(); } catch (e) { return null; }
    if (t.playing) return 'Stop playback first';
    let ok = crawl.result.some(c => c.track === d.track && Math.abs(c.start - t.playStart) < 1e-4);
    if (!ok) {
      // A note click ("Click sets playhead", features/playback.js) leaves the marker inside the clip: put it back on
      // the clip's start so the navigator can find its way home.
      const ends = crawl.result.filter(c => c.track === d.track).sort((a, b) => a.start - b.start);
      const c = ends.find((c, i) => c.start < t.playStart && t.playStart < clipEndFn()(c, ends[i + 1]) - 1e-4);
      if (c) {
        SV.send(['position ' + c.start]);
        for (let i = 0; i < 20 && !ok; i++) {
          await new Promise(r => setTimeout(r, 50));
          try { ok = Math.abs((await (await fetch('/api/transport', { cache: 'no-store' })).json()).playStart - c.start) < 1e-4; } catch (e) { break; }
        }
      }
    }
    return ok ? null : `Click the ${d.track} clip in Bitwig again (Score View finds its way back to it by the play start marker), or Read project again`;
  }

  /**
   * Writes notes into several tracks' clips through the navigator (for other features, e.g. Inspire ▾ Continue).
   * results: [{track, notes:[{start (arranger beats), dur, pitch, vel 0..1}]}]. opts.remove: the `written` value of an
   * earlier call — those notes are deleted first (Again). Returns { done, failed, written, error? }.
   */
  async function writeTracks(results, opts = {}) {
    if (busy) return { error: 'Orchestrate is busy' };
    const crawl = crawlOk();
    if (!crawl) return { error: '⟳ Read project first' };
    if (!live()) return { error: 'Not connected to Bitwig' };
    const plans = planAll({ results });
    const bad = plans.filter(p => p.error && !p.empty);
    if (bad.length) return { error: bad.map(p => p.error).join(' · ') };
    busy = true;
    const done = [], failed = [], written = [];
    try {
      const why = await homeCheck(crawl);
      if (why) return { error: why };
      const homeLane = laneOf(crawl, SV.state.liveData.track);
      const removeBy = new Map();
      (opts.remove || []).forEach(w => { const k = w.track; if (!removeBy.has(k)) removeBy.set(k, []); removeBy.get(k).push(w); });
      const tracks = [...new Set([...plans.filter(p => p.writes).map(p => p.track), ...removeBy.keys()])];
      for (const track of tracks) {
        const p = plans.find(q => q.track === track && q.writes) || { track, writes: [] };
        const lines = [];
        (removeBy.get(track) || []).forEach(w => {
          const c = crawl.result.find(r => r.track === w.track && Math.abs(r.start - w.clipStart) < 1e-6);
          if (!c) return;
          lines.push(`goto ${c.lane} ${c.start} ${encodeURIComponent(c.track)}`);
          w.adds.forEach(a => lines.push(`del ${a.ch} ${a.x} ${a.y}`));
          c.notes = c.notes.filter(row => !w.adds.some(a => a.ch === row[0] && a.x === row[1] && a.y === row[2]));
        });
        p.writes.forEach(w => {
          lines.push(`goto ${w.lane} ${w.clip.start} ${encodeURIComponent(w.clip.track)}`);
          w.adds.forEach(a => lines.push(`add ${a.ch} ${a.x} ${a.y} ${a.vel} ${fmt(a.d)}`));
        });
        if (!lines.length) continue;
        lines.push(homeLane == null || homeLane < 0 ? 'gotoHome' : 'gotoHome ' + homeLane);
        const st = await runBatch(lines);
        const errs = (st.results || []).filter(r => !r.startsWith('ok'));
        if (st.state === 'error' && !errs.length) errs.push(st.message);
        if (errs.length) { failed.push(track + ': ' + errs.join('; ')); if (errs.some(e => /^error: home|Could not reselect/.test(e))) break; continue; }
        applyToCrawl(p);
        p.writes.forEach(w => written.push({ track, clipStart: w.clip.start, adds: w.adds.map(a => ({ ch: a.ch, x: a.x, y: a.y })) }));
        done.push(track);
      }
      if (done.length) rebuildBase(crawl, done);
    } finally {
      busy = false;
    }
    return { done, failed, written };
  }

  /** Runs an operation end to end. opts: {op, source:'selection'|'staves', staves, fromBar, toBar, targets, ...}. */
  async function apply(opts) {
    if (busy) return { error: 'busy' };
    const crawl = crawlOk();
    if (!crawl) return report({ error: '⟳ Read project first: orchestration writes through its clip list' });
    const src = opts.source === 'staves' ? stavesSource(opts.staves || [], opts.fromBar, opts.toBar) : selectedSource();
    if (src.error) return report(src);
    const computed = compute(opts.op, src, opts);
    if (computed.error) return report(computed);
    const plans = planAll(computed);
    if (!live()) return report({ error: 'Not connected to Bitwig' });
    busy = true;
    setBusy(true);
    const done = [], failed = [];
    try {
      const why = await homeCheck(crawl);
      if (why) return report({ error: why });
      const homeLane = laneOf(crawl, SV.state.liveData.track);
      for (const p of plans) {
        if (p.empty) continue;
        if (p.error) { failed.push(p.track + ': ' + p.error); continue; }
        status('Writing ' + p.track + '…');
        const st = await runBatch(batchLines(p, homeLane));
        const errs = (st.results || []).filter(r => !r.startsWith('ok'));
        if (st.state === 'error' && !errs.length) errs.push(st.message);
        if (errs.length && st.dropped) errs.push(st.dropped + ' note' + (st.dropped > 1 ? 's' : '') + ' not written');
        if (errs.length) { failed.push(p.track + ': ' + errs.join('; ')); if (errs.some(e => /^error: home|Could not reselect/.test(e))) break; continue; }
        applyToCrawl(p);
        done.push(p.track + ' (' + p.notes.length + ')');
      }
      if (done.length) rebuildBase(crawl, plans.filter(p => p.writes && !p.error).map(p => p.track));
    } finally {
      busy = false;
      setBusy(false);
    }
    return report({ done, failed, info: computed.info });
  }

  function rebuildBase(crawl, written) {
    const b = SV.state.base;
    // Show the written staves too (this session only; the Tracks menu keeps the saved pins).
    if (SV.state.trackMode === 'pinned') written.forEach(t => SV.state.pinned.add(t));
    const score = SV.arrangement.crawlToScore(crawl, { title: b.title, timeSig: b.timeSig, markers: b.markers || [] });
    SV.setBase(score, Date.now());
  }

  function report(r) {
    let msg;
    if (r.error) msg = r.error;
    else {
      const parts = [];
      if (r.done && r.done.length) parts.push('Wrote ' + r.done.join(', '));
      if (r.failed && r.failed.length) parts.push('Not written — ' + r.failed.join(' · '));
      if (r.info && r.info.length) parts.push(r.info.join(' · '));
      msg = parts.join('. ') || 'Nothing to write';
    }
    status(msg, !!(r.error || (r.failed && r.failed.length)));
    SV.flash(msg.length > 140 ? msg.slice(0, 137) + '…' : msg);
    lastReport = { ...r, message: msg };
    return lastReport;
  }
  let lastReport = null;

  // ------------------------------------------------------------------ UI

  SV.addStyle(`
    .orc { position: relative; }
    .orc-panel { position: fixed; z-index: 30; width: 440px; max-width: calc(100vw - 32px); max-height: calc(100vh - 40px); overflow-y: auto;
      background: var(--bar, #232323); border: 1px solid var(--line, #3a3a3a); border-radius: 6px; padding: 10px 12px;
      box-shadow: 0 6px 20px #0008; color: var(--text, #ddd); font-size: 13px; }
    .orc-panel h4 { margin: 8px 0 4px; font-size: 12px; font-weight: 600; color: var(--dim, #8a8a8a); text-transform: uppercase; letter-spacing: .04em; }
    .orc-ops { display: flex; gap: 4px; }
    .orc-ops button.on { background: var(--accent, #4a9eff); color: #fff; }
    .orc-list { max-height: 180px; overflow-y: auto; border: 1px solid var(--line, #3a3a3a); border-radius: 4px; padding: 4px 6px;
      display: grid; grid-template-columns: 1fr 1fr; gap: 1px 10px; }
    .orc-list label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .orc-list .orc-grp { grid-column: 1 / -1; color: var(--dim, #8a8a8a); font-size: 11px; margin-top: 3px; }
    .orc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 3px 0; }
    .orc-row input[type=number] { width: 52px; }
    .orc-preview { margin-top: 8px; font-size: 12px; color: var(--dim, #8a8a8a); white-space: pre-line; }
    .orc-preview .bad { color: #e8875b; }
    .orc-status { margin-top: 6px; font-size: 12px; }
    .orc-status.bad { color: #e8875b; }
    .orc-actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; justify-content: flex-end; }
    .orc-stay { margin-right: auto; font-size: 12px; color: var(--dim, #8a8a8a); }
  `);

  const group = SV.addToolbar('<div class="orc"><button class="btn" id="orcBtn" title="Write into other tracks: explode a chord, double a line, reduce staves (Alt+X / Alt+B / Alt+U)">Orchestrate ▾</button>'
    + '<div class="orc-panel hidden" id="orcPanel"></div></div>', { cluster: 'write', order: 70 });
  const panel = group.querySelector('#orcPanel');
  const q = sel => panel.querySelector(sel);
  const OPS = { explode: 'Explode', double: 'Double', reduce: 'Reduce' };
  const HELP = {
    explode: 'Spreads the chord(s) over the target instruments, top note to the highest instrument.',
    double: 'Copies the line to each target instrument at the chosen interval, inside its range.',
    reduce: 'Merges the source staves (bar range) onto one target track.',
  };
  let ui = { op: prefs.op, source: 'selection', staves: [], fromBar: 1, toBar: 1 };

  function defaultTargets(op, srcTrack, tracks) {
    const saved = prefs.targets[op];
    if (saved && saved.length) return saved.filter(t => tracks.includes(t));
    const br = bracketOf(srcTrack);
    let list = tracks.filter(t => t !== srcTrack && br && bracketOf(t) === br);
    if (!list.length) list = tracks.filter(t => bracketOf(t) === 'Strings' && t !== srcTrack);
    return op === 'double' ? list.slice(-1) : list;
  }

  function selectionBars() {
    const s = selectedSource();
    if (s.error) return null;
    const mb = measureBeats();
    return [barOf(Math.min(...s.notes.map(n => n.start)), mb), barOf(Math.max(...s.notes.map(n => n.start)), mb)];
  }

  function trackChecks(id, tracks, checked) {
    let html = '', last = null;
    tracks.forEach(t => {
      const br = bracketOf(t);
      if (br && br !== last) { html += `<div class="orc-grp">${esc(br)}</div>`; last = br; }
      html += `<label title="${esc(t)}"><input type="checkbox" data-${id}="${esc(t)}" ${checked.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`;
    });
    return html || '<div class="orc-grp">No tracks with clips — Read project first</div>';
  }

  function renderPanel() {
    const tracks = crawlTracks();
    const d = SV.state.liveData, srcTrack = d && d.exists ? d.track : '';
    const op = ui.op;
    if (!ui.targets || ui.targetsOp !== op) { ui.targets = defaultTargets(op, srcTrack, tracks); ui.targetsOp = op; }
    if (!ui.staves.length && srcTrack) ui.staves = [srcTrack];
    const bars = selectionBars();
    if (bars && ui.source === 'selection') { ui.fromBar = bars[0]; ui.toBar = bars[1]; }
    const reduceTarget = tracks.includes(prefs.reduceTarget) ? prefs.reduceTarget : tracks[0] || '';
    panel.innerHTML = `
      <div class="orc-ops">${Object.entries(OPS).map(([k, l]) => `<button class="btn ${k === op ? 'on' : ''}" data-op="${k}">${l}</button>`).join('')}</div>
      <div class="orc-preview">${HELP[op]}</div>
      <h4>Source</h4>
      <div class="orc-row"><label><input type="radio" name="orcSrc" value="selection" ${ui.source === 'selection' ? 'checked' : ''}> Selected notes</label>
        <label><input type="radio" name="orcSrc" value="staves" ${ui.source === 'staves' ? 'checked' : ''}> Staves, bars</label>
        <input type="number" id="orcFrom" min="1" value="${ui.fromBar}"> – <input type="number" id="orcTo" min="1" value="${ui.toBar}"></div>
      <div class="orc-list ${ui.source === 'staves' ? '' : 'hidden'}" id="orcStaves">${trackChecks('src', tracks, ui.staves)}</div>
      <h4>${op === 'reduce' ? 'Target track' : 'Target tracks'}</h4>
      ${op === 'reduce'
        ? `<div class="orc-row"><select id="orcReduceTarget">${tracks.map(t => `<option ${t === reduceTarget ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
           <label><input type="checkbox" id="orcReduceFit" ${prefs.reduceFit ? 'checked' : ''}> Fold into its range</label></div>`
        : `<div class="orc-list" id="orcTargets">${trackChecks('tgt', tracks, ui.targets)}</div>`}
      ${op === 'explode' ? `<div class="orc-row"><label><input type="checkbox" id="orcBass" ${prefs.bassOctave ? 'checked' : ''}> Basses double the bass an octave lower</label>
          <label><input type="checkbox" id="orcRanges" ${prefs.keepRanges ? 'checked' : ''}> Keep instrument ranges</label></div>` : ''}
      ${op === 'double' ? `<div class="orc-row">Interval <select id="orcInterval">${Object.entries(INTERVALS).map(([k, v]) => `<option value="${k}" ${k === prefs.interval ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
          Key <select id="orcKey" title="Thirds and sixths follow this key"><option value="auto">Auto (${KEY_NAMES[autoFifths() + 6]})</option>${KEY_NAMES.map((n, i) => `<option value="${i - 6}" ${String(i - 6) === String(prefs.keyFifths) ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <label><input type="checkbox" id="orcRanges" ${prefs.keepRanges ? 'checked' : ''}> Keep instrument ranges</label></div>` : ''}
      <div class="orc-preview" id="orcPreview"></div>
      <div class="orc-status" id="orcStatus"></div>
      <div class="orc-actions"><label class="orc-stay" title="Clicks in the score (to select notes) keep this panel open; Esc or a click anywhere else closes it"><input type="checkbox" id="orcStay" ${prefs.stayOpen ? 'checked' : ''}> Stay open while I select notes</label><button class="btn hidden" id="orcCancel">Cancel</button><button class="btn" id="orcApply">Write into Bitwig</button><button class="btn" id="orcClose">Close</button></div>`;
    preview();
  }

  function readUi() {
    const v = sel => q(sel);
    const src = panel.querySelector('input[name=orcSrc]:checked');
    ui.source = src ? src.value : 'selection';
    ui.fromBar = Math.max(1, parseInt(v('#orcFrom').value, 10) || 1);
    ui.toBar = Math.max(ui.fromBar, parseInt(v('#orcTo').value, 10) || ui.fromBar);
    ui.staves = [...panel.querySelectorAll('[data-src]')].filter(c => c.checked).map(c => c.dataset.src);
    if (v('#orcTargets')) { ui.targets = [...panel.querySelectorAll('[data-tgt]')].filter(c => c.checked).map(c => c.dataset.tgt); prefs.targets[ui.op] = ui.targets; }
    if (v('#orcReduceTarget')) prefs.reduceTarget = v('#orcReduceTarget').value;
    if (v('#orcReduceFit')) prefs.reduceFit = v('#orcReduceFit').checked;
    if (v('#orcBass')) prefs.bassOctave = v('#orcBass').checked;
    if (v('#orcRanges')) prefs.keepRanges = v('#orcRanges').checked;
    if (v('#orcStay')) prefs.stayOpen = v('#orcStay').checked;
    if (v('#orcInterval')) prefs.interval = v('#orcInterval').value;
    if (v('#orcKey')) prefs.keyFifths = v('#orcKey').value === 'auto' ? null : Number(v('#orcKey').value);
    prefs.op = ui.op;
    save(PREF_KEY, prefs);
  }

  function options() {
    return { op: ui.op, source: ui.source, staves: ui.staves, fromBar: ui.fromBar, toBar: ui.toBar, targets: ui.targets || [],
             reduceTarget: prefs.reduceTarget, reduceFit: prefs.reduceFit, bassOctave: prefs.bassOctave,
             keepRanges: prefs.keepRanges, interval: prefs.interval };
  }

  const pname = p => { const n = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][p % 12]; return n + (Math.floor(p / 12) - 1); };
  // What would be written where (and which targets have no clip), before anything is sent.
  function preview() {
    const box = q('#orcPreview');
    if (!box) return;
    const o = options();
    if (!crawlOk()) { box.innerHTML = '<span class="bad">⟳ Read project first.</span>'; return; }
    const src = o.source === 'staves' ? stavesSource(o.staves, o.fromBar, o.toBar) : selectedSource();
    if (src.error) { box.innerHTML = `<span class="bad">${esc(src.error)}</span>`; return; }
    const c = compute(o.op, src, o);
    if (c.error) { box.innerHTML = `<span class="bad">${esc(c.error)}</span>`; return; }
    box.innerHTML = planAll(c).map(p => {
      const first = p.notes.slice(0, 4).map(n => pname(n.pitch)).join(' ') + (p.notes.length > 4 ? ' …' : '');
      return p.error && !p.empty ? `<span class="bad">${esc(p.track)}: ${esc(p.error)}</span>` : `${esc(p.track)}: ${p.notes.length} note${p.notes.length === 1 ? '' : 's'}${first ? ' (' + first + ')' : ''}`;
    }).join('\n') + (c.info.length ? '\n' + c.info.map(esc).join('\n') : '');
  }

  function status(t, bad) {
    const el = q('#orcStatus');
    if (el) { el.textContent = t; el.classList.toggle('bad', !!bad); }
  }
  function setBusy(on) {
    const a = q('#orcApply'), c = q('#orcCancel');
    if (a) a.disabled = on;
    if (c) c.classList.toggle('hidden', !on);
  }

  function open(op) {
    if (op) ui.op = op;
    ui.targets = null;
    panel.classList.remove('hidden');
    renderPanel();
    // Below the button, kept inside the window (the toolbar button may sit at the right edge).
    const b = group.querySelector('#orcBtn').getBoundingClientRect();
    panel.style.top = Math.round(b.bottom + 4) + 'px';
    panel.style.left = Math.round(Math.max(16, Math.min(b.left, window.innerWidth - panel.offsetWidth - 16))) + 'px';
  }
  const close = () => panel.classList.add('hidden');
  const isOpen = () => !panel.classList.contains('hidden');

  group.querySelector('#orcBtn').addEventListener('click', e => {
    if (panel.classList.contains('hidden')) open(); else close();
    e.stopPropagation();
  });
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('keydown', e => { if (e.key === 'Escape' && !busy) close(); e.stopPropagation(); });
  panel.addEventListener('change', e => {
    if (e.target.name === 'orcSrc') { readUi(); renderPanel(); return; }
    readUi(); preview();
  });
  panel.addEventListener('input', e => { if (e.target.type === 'number') { readUi(); preview(); } });
  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.op) { readUi(); ui.op = b.dataset.op; ui.targets = null; renderPanel(); return; }
    if (b.id === 'orcClose') close();
    if (b.id === 'orcCancel') fetch('/api/edit', { method: 'POST', body: 'navCancel' });
    if (b.id === 'orcApply') { readUi(); apply(options()).then(() => preview()); }
  });
  // Esc or a press outside closes the panel, like the other popovers; with "Stay open while I select notes" a press in
  // the score does not (the source notes are picked there). While writing into Bitwig it stays open (it holds Cancel).
  let held = false; // a mouse button is down: a note drag or marquee in the score may be running
  window.addEventListener('mouseup', () => { held = false; }, true);
  window.addEventListener('blur', () => { held = false; });
  document.addEventListener('mousedown', e => {
    held = true;
    if (!isOpen() || busy || group.contains(e.target)) return;
    if (prefs.stayOpen && e.target.closest && e.target.closest('#main')) return;
    close();
  }, true);
  SV.hooks.keydown.unshift(e => { // before entry's Esc (leave entry): the popover closes first
    // Mid-drag, Esc belongs to features/mouse.js (it cancels the drag); the panel closes on the next Esc.
    if (e.key !== 'Escape' || !isOpen() || busy || held) return false;
    close();
    return true;
  });
  // While it stays open over a score selection, keep its preview current.
  document.addEventListener('mouseup', e => {
    if (panel.classList.contains('hidden') || busy || group.contains(e.target)) return;
    setTimeout(() => { if (ui.source === 'selection') renderPanel(); }, 50);
  });

  const KEYS = { KeyX: 'explode', KeyB: 'double', KeyU: 'reduce' };
  SV.hooks.keydown.push(e => {
    if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || !KEYS[e.code]) return false;
    if (!e.repeat) open(KEYS[e.code]);
    return true;
  });

  if (SV.shortcuts) {
    SV.shortcuts.register({ keys: 'Alt+X', owner: 'orchestrate', desc: 'explode the chord to instruments…' });
    SV.shortcuts.register({ keys: 'Alt+B', owner: 'orchestrate', desc: 'double the line in other tracks…' });
    SV.shortcuts.register({ keys: 'Alt+U', owner: 'orchestrate', desc: 'reduce staves into this clip…' });
    SV.shortcuts.register({ keys: 'Escape', owner: 'orchestrate', desc: 'close the Orchestrate panel', when: 'Orchestrate panel' });
  }
  SV.addHelp('Orchestrate: <kbd>Alt</kbd>+<kbd>X</kbd> explode chord to instruments · <kbd>Alt</kbd>+<kbd>B</kbd> double line · '
    + '<kbd>Alt</kbd>+<kbd>U</kbd> reduce staves (writes into other tracks\' clips; needs ⟳ Read project)');

  // rebuildBase / isBusy are shared with features/passage.js (copy/paste between staves writes through the same crawl).
  root.SV.orchestrate = { ...Core, apply, writeTracks, open, close, compute, planAll, lastReport: () => lastReport,
                          rebuildBase, isBusy: () => busy };
})(typeof window !== 'undefined' ? window : globalThis);
