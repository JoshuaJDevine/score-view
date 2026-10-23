// Helpers of features/arrangement.js: listen while playing. The extension reports every note Bitwig plays on each track
// (GET /api/listen, NoteListen.java: Channel.addNoteObserver, stamped with the arranger beat). While Score view plays
// with a stored read (the mirror), the page compares the heard onsets with the read, per track and bar; a track whose
// bars stop matching is listed by the out-of-date dot as "changed at bar N" and offered for a targeted re-read. It only
// listens: nothing in Bitwig changes. Pure; loads in Node: require('web/features/arrangement-listen.js'). In the page:
// window.SVArrangementListen.
//
// Whether the observer reports a track's notes before or after its Note FX is not known (articulation maps send extra
// keyswitches; arpeggiators or harmonisers change the notes). So keyswitches (below C1) are left out on both sides, and
// each track first learns a baseline: the median share of matching onsets per bar over its first bars after a read.
// A track whose baseline is low (its Note FX change what it plays) is ignored; for the others only bars well below
// their baseline count (any unmatched onset on a track that matched cleanly), and only consistently: the same bar on
// two hearings, or two neighbouring bars far off in one pass (a clip moved or deleted).
(function (root) {
  'use strict';

  const KS_MAX = 24;          // keyswitches sit below C1 (the same threshold as "Hide keyswitches")
  const TOL = 0.15;           // beats an onset may be off (stamping jitter) and still match
  const LATE = 0.3;           // a bar is judged once the playhead is this far past its end (late events, jitter)
  const MIN_BASE_BARS = 4;    // bars with notes a track needs before its baseline is learned
  const MIN_BASELINE = 0.6;   // a baseline below this: the track's output is not its notes (Note FX); ignored
  const DEVIATION = 0.3;      // a bar this far below the baseline disagrees (far off: counts for the one-pass rule)
  const CLEAN = 0.95, CLEAN_SLACK = 0.02; // a track whose baseline is at least CLEAN: any unmatched onset disagrees
  const JUMP_BACK = 0.5, JUMP_AHEAD = 32; // beats: a playhead moving back (loop, relocate) or far ahead starts a new pass

  /** Onsets of engraved notes worth comparing: [{beat, key}] sorted, keyswitches left out. notes: [{start, pitch}]. */
  function expectedOnsets(notes) {
    return (notes || []).filter(n => n.pitch >= KS_MAX).map(n => ({ beat: n.start, key: n.pitch })).sort((a, b) => a.beat - b.beat);
  }

  /** Heard onsets of /api/listen events [seq, on, key, vel, beat, t, playing]: note-ons while playing, no keyswitches. */
  function heardOnsets(events) {
    return (events || []).filter(e => e[1] === 1 && e[3] > 0 && e[6] === 1 && e[2] >= KS_MAX).map(e => ({ beat: e[4], key: e[2] }));
  }

  /**
   * How well the heard onsets match the expected ones, per bar -> [{bar, exp, heard, matched, score (0..1)}] for the bars
   * with any onset. bars: [{bar, start, end}] (beats, consecutive). An onset matches one of the other side with the same
   * key within tol (each used once, earliest first); matching runs over the whole window, so a note stamped just across
   * a bar line still matches. A matched pair counts in its expected onset's bar, anything unmatched in its own bar.
   * score = 2 * matched / (exp + heard).
   */
  function barScores(expected, heard, bars, tol = TOL) {
    if (!bars.length) return [];
    const from = bars[0].start, to = bars[bars.length - 1].end;
    const inWin = o => o.beat >= from - tol && o.beat < to + tol;
    const byKey = list => {
      const m = new Map();
      list.filter(inWin).forEach(o => { if (!m.has(o.key)) m.set(o.key, []); m.get(o.key).push(o); });
      m.forEach(v => v.sort((a, b) => a.beat - b.beat));
      return m;
    };
    const E = byKey(expected), H = byKey(heard);
    const barOf = beat => { for (const b of bars) if (beat >= b.start - 1e-9 && beat < b.end - 1e-9) return b.bar; return null; };
    const stats = new Map(bars.map(b => [b.bar, { bar: b.bar, exp: 0, heard: 0, matched: 0 }]));
    const count = (beat, field, n = 1) => { const b = barOf(beat); if (b != null) stats.get(b)[field] += n; };
    E.forEach((exps, key) => {
      const hs = H.get(key) || [];
      const used = new Array(hs.length).fill(false);
      let j = 0;
      exps.forEach(e => {
        while (j < hs.length && (used[j] || hs[j].beat < e.beat - tol)) j++;
        if (j < hs.length && Math.abs(hs[j].beat - e.beat) <= tol) {
          used[j] = true;
          if (barOf(e.beat) != null) { count(e.beat, 'exp'); count(e.beat, 'heard'); count(e.beat, 'matched'); }
          j++;
        } else count(e.beat, 'exp');
      });
      hs.forEach((h, i) => { if (!used[i]) count(h.beat, 'heard'); });
    });
    H.forEach((hs, key) => { if (!E.has(key)) hs.forEach(h => count(h.beat, 'heard')); });
    return [...stats.values()].filter(s => s.exp + s.heard > 0).map(s => ({ ...s, score: 2 * s.matched / (s.exp + s.heard) }));
  }

  const median = xs => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /** A track's listening state: baseline (learned once), bars that disagreed and how often, the bar it changed at. */
  function newTrack() {
    return { base: null, learn: [], bad: new Map(), pass: -1, passBad: new Set(), held: [], flagged: null };
  }

  /**
   * Judges one track's bar scores from a stretch of pass `pass` (mutates t) -> true when its flag appeared or moved to
   * an earlier bar. heardAny: the track has sounded in this pass; until it does its scores are held (a muted or silent
   * track says nothing about its clips) and a pass that ends silent drops them.
   */
  function judge(t, scores, { pass, heardAny }) {
    if (pass !== t.pass) { t.pass = pass; t.passBad = new Set(); t.held = []; }
    if (!heardAny) { t.held.push(...scores); return false; }
    let list = t.held.concat(scores);
    t.held = [];
    if (!t.base) {
      t.learn.push(...list);
      if (t.learn.length < MIN_BASE_BARS) return false;
      const rate = median(t.learn.map(s => s.score));
      t.base = { rate, bars: t.learn.length, ignored: rate < MIN_BASELINE };
      list = t.learn; // the learning bars are judged against the baseline too (a change made before the first pass)
      t.learn = [];
    }
    if (t.base.ignored) return false;
    // A track that matched cleanly notices one changed note; a noisier one only bars well below its usual.
    const slack = t.base.rate >= CLEAN ? CLEAN_SLACK : DEVIATION;
    list.forEach(s => {
      if (s.score >= t.base.rate - slack) { t.bad.delete(s.bar); return; }
      t.bad.set(s.bar, (t.bad.get(s.bar) || 0) + 1);
      if (s.score < t.base.rate - DEVIATION) t.passBad.add(s.bar);
    });
    // Consistent: the same bar on two hearings, or two neighbouring bars far off in one pass (a clip moved or deleted).
    const sure = [...t.bad].filter(([, n]) => n >= 2).map(([bar]) => bar);
    t.passBad.forEach(bar => { if (t.passBad.has(bar + 1)) sure.push(bar); });
    if (!sure.length) return false;
    const bar = Math.min(...sure);
    if (t.flagged != null && t.flagged <= bar) return false;
    t.flagged = bar;
    return true;
  }

  /**
   * The listener: feed it each /api/listen response; it tracks passes (contiguous play runs), collects heard onsets,
   * judges every bar once the playhead is LATE past its end, and keeps each track's state.
   * feed(resp, ctx) -> [track names whose flag appeared or moved]
   *   resp = { playing, pos, tracks:[{index, name, events}] }
   *   ctx  = { expected: Map(name -> onsets) (every track of the read; [] when it has no notes), barBeats,
   *            skip: Set(names) (the live track, edited, muted / soloed-out, groups) }
   */
  function createListener() {
    let tracks = new Map(), run = null, passId = 0;
    const track = name => { if (!tracks.has(name)) tracks.set(name, newTrack()); return tracks.get(name); };

    function startRun(resp) {
      // The first response of a run may carry notes played before its position was read: start at the earliest of them.
      let from = resp.pos;
      (resp.tracks || []).forEach(t => (t.events || []).forEach(e => {
        if (e[6] === 1 && e[4] < from && e[4] > resp.pos - 8) from = e[4];
      }));
      run = { id: ++passId, from, to: resp.pos, heard: new Map(), heardAny: new Set(), done: new Set() };
    }

    function feed(resp, ctx) {
      if (!resp || !resp.playing) { run = null; return []; }
      if (!run || resp.pos < run.to - JUMP_BACK || resp.pos > run.to + JUMP_AHEAD) startRun(resp);
      (resp.tracks || []).forEach(t => {
        if (!t.name) return;
        const evs = (t.events || []).filter(e => e[6] === 1 && e[4] >= run.from - TOL);
        if (evs.some(e => e[1] === 1)) run.heardAny.add(t.name);
        const on = heardOnsets(evs);
        if (on.length) run.heard.set(t.name, (run.heard.get(t.name) || []).concat(on));
      });
      run.to = Math.max(run.to, resp.pos);
      const bb = ctx.barBeats > 0 ? ctx.barBeats : 4;
      const bars = [];
      for (let k = Math.max(0, Math.floor(run.from / bb + 1e-9)); (k + 1) * bb <= run.to - LATE; k++) {
        const b = { bar: k + 1, start: k * bb, end: (k + 1) * bb };
        if (b.end > run.from + 1e-9 && !run.done.has(b.bar)) bars.push(b);
      }
      if (!bars.length) return [];
      bars.forEach(b => run.done.add(b.bar));
      const changed = [];
      ctx.expected.forEach((onsets, name) => {
        if (ctx.skip && ctx.skip.has(name)) return;
        // notes before the run's start were not played in it
        const exp = onsets.filter(o => o.beat >= run.from - 1e-6);
        const scores = barScores(exp, run.heard.get(name) || [], bars);
        if (!scores.length) return;
        if (judge(track(name), scores, { pass: run.id, heardAny: run.heardAny.has(name) })) changed.push(name);
      });
      return changed;
    }

    return {
      feed,
      /** A new read: forget everything (baselines are learned again on the next pass). */
      reset() { tracks = new Map(); run = null; },
      /** These tracks were re-read or harvested: drop their evidence and flags (the baseline stays). */
      resetTracks(names) {
        (names || []).forEach(n => { const t = tracks.get(n); if (t) Object.assign(t, { bad: new Map(), passBad: new Set(), held: [], flagged: null }); });
      },
      running: () => !!run,
      /** Map(track -> bar) of the tracks that changed. */
      flagged() { const m = new Map(); tracks.forEach((t, n) => { if (t.flagged != null) m.set(n, t.flagged); }); return m; },
      /** For tests and the status: { pass, tracks: { name: { baseline, ignored, flagged, bad:[bars] } } }. */
      info() {
        const out = {};
        tracks.forEach((t, n) => {
          out[n] = { baseline: t.base ? Math.round(t.base.rate * 1000) / 1000 : null, ignored: !!(t.base && t.base.ignored),
                     flagged: t.flagged, bad: [...t.bad.keys()].sort((a, b) => a - b) };
        });
        return { pass: passId, running: !!run, tracks: out };
      },
    };
  }

  const api = { KS_MAX, TOL, LATE, MIN_BASE_BARS, MIN_BASELINE, DEVIATION, expectedOnsets, heardOnsets, barScores, newTrack, judge, createListener };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SVArrangementListen = api;
})(typeof window !== 'undefined' ? window : globalThis);
