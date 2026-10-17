// Places a live clip in the arrangement by matching its notes against the DAWproject export.
// Used by alignLive() in core/sources.js; pure functions so it can be tested in Node.
//
//   ClipAlign.findPlacements(clipNotes, partNotes, { length, playPos })
//     clipNotes: [{start (beats from clip start), pitch}]   partNotes: [{start (arranger beats), pitch}]
//     -> { best: cand|null, cands: [cand, ...] }   cand = { offset, open, full }
//   best is cands[0]; cands lists every placement that fits about as well as the best (the ambiguous set),
//   best first: nearest to the arranger playhead, then earliest.
(function (root) {
  'use strict';
  const TOL = 0.07;          // beats a note may be off and still match
  const OPEN_BEATS = 16;     // the clip's "opening": its first bars ...
  const OPEN_MIN_NOTES = 16; // ... but at least this many notes
  const EPS = 0.05;          // candidates within this of the best score are equally good

  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  function findPlacements(clipNotes, partNotes, opts) {
    opts = opts || {};
    const notes = clipNotes.slice().sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    if (!notes.length || !partNotes.length) return { best: null, cands: [] };
    const byPitch = new Map();
    partNotes.forEach(n => { if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []); byPitch.get(n.pitch).push(n.start); });
    byPitch.forEach(a => a.sort((x, y) => x - y));
    const hit = (l, o) => {
      const a = byPitch.get(l.pitch);
      if (!a) return false;
      const t = l.start + o, i = lowerBound(a, t - TOL);
      return i < a.length && a[i] <= t + TOL;
    };
    let nOpen = notes.findIndex(n => n.start >= OPEN_BEATS);
    nOpen = Math.min(notes.length, Math.max(nOpen < 0 ? notes.length : nOpen, OPEN_MIN_NOTES));
    const opening = notes.slice(0, nOpen);
    const frac = (list, o) => list.reduce((s, l) => s + (hit(l, o) ? 1 : 0), 0) / list.length;

    // Candidate offsets: every offset that lines a clip note up with an export note of the same pitch,
    // voted for by the opening notes (a clip edited later still starts the same) and by all notes.
    const snap = v => Math.round(v * 8) / 8;
    const vote = list => {
      const votes = new Map();
      list.forEach(l => (byPitch.get(l.pitch) || []).forEach(b => {
        const o = snap(b - l.start);
        if (o > -0.01) votes.set(o, (votes.get(o) || 0) + 1);
      }));
      return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 60).map(e => e[0]);
    };
    const offsets = new Set([...vote(opening), ...vote(notes.slice(0, 400))]);
    const scored = [...offsets].map(o => ({ offset: Math.max(0, o), open: frac(opening, o), full: frac(notes, o) }))
      .filter(c => c.open >= 0.6 || c.full >= 0.3);
    if (!scored.length) return { best: null, cands: [] };

    const rank = c => c.open * 2 + c.full;
    const top = Math.max(...scored.map(rank));
    const len = opts.length || 0, pos = opts.playPos;
    // Closeness to the playhead: places containing it first (nearest start first), then by distance.
    const dist = o => pos == null || pos < 0 ? 0 : pos >= o && pos < o + len ? pos - o : 1e6 + (pos < o ? o - pos : pos - o - len);
    const cands = scored.filter(c => rank(c) >= top - EPS * 2)
      .sort((a, b) => dist(a.offset) - dist(b.offset) || a.offset - b.offset);
    return { best: cands[0], cands };
  }

  // Opening-match score of one offset (used to notice that a remembered placement no longer fits).
  function openingScore(clipNotes, partNotes, offset) {
    const notes = clipNotes.slice().sort((a, b) => a.start - b.start).slice(0, OPEN_MIN_NOTES);
    if (!notes.length) return 0;
    return notes.filter(l => partNotes.some(n => n.pitch === l.pitch && Math.abs(n.start - (l.start + offset)) < TOL)).length / notes.length;
  }

  const api = { findPlacements, openingScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ClipAlign = api;
})(typeof window !== 'undefined' ? window : globalThis);
