// Helpers of features/arrangement.js: the arrangement mirror. A Read (the crawl) is kept as a mirror of the arrangement
// that stays current without reading again: the clip selected in Bitwig is harvested into it once its data has settled,
// targeted re-reads ('crawl tracks …') replace a few tracks, and the whole mirror is stored per project (extension:
// GET/POST /api/arrangement, ArrangementMirror.java; IndexedDB as a fallback). Pure; loads in Node:
// require('web/features/arrangement-mirror.js'). In the page: window.SVArrangementMirror.
//
// Mirror = the crawl object ({stepsPerBeat, tracks:[{name, group}], result:[clip]}); clips may carry
//   seenAt  (ms) when the clip was last harvested from Bitwig or re-read
//   suspect true: the mirror can no longer vouch for this clip (the same content turned up at another start, or another
//           clip now starts inside it); still engraved, listed by the out-of-date dot until its track is re-read.
// Stored document: { v: 1, project, readAt (last full read, ms), savedAt (ms), tracksAtRead:[{name}], crawl }.
(function (root) {
  'use strict';
  const EPS = 1e-6;
  const near = (a, b) => Math.abs((a || 0) - (b || 0)) < EPS;

  /** Order-independent signature of a clip's notes: live notes {x, y, d} or crawl rows [ch, x, y, d, vel]. */
  function noteSig(notes) {
    return (notes || []).map(n => Array.isArray(n) ? [n[1], n[2], n[3]] : [n.x, n.y, n.d])
      .map(([x, y, d]) => x + ':' + y + ':' + Math.round(d * 1000)).sort().join(',');
  }

  /** The selected clip (liveData) as a mirror clip at arranger beat `start`. */
  function clipFromLive(d, start, lane = 0) {
    return { lane, track: d.track, start, playStart: d.playStart || 0, playStop: d.length || 0, loop: !!d.loop,
             loopStart: d.loopStart || 0, loopLength: d.loopLength || 0,
             notes: (d.notes || []).map(n => [n.ch, n.x, n.y, n.d, n.vel]) };
  }

  /** Same notes, play range and loop: the clip Bitwig reports is the mirrored one, unchanged. */
  function sameContent(a, b) {
    return noteSig(a.notes) === noteSig(b.notes) && near(a.playStart, b.playStart) && near(a.playStop, b.playStop) &&
      !!a.loop === !!b.loop && (!a.loop || (near(a.loopStart, b.loopStart) && near(a.loopLength, b.loopLength)));
  }

  /** How much two clips' notes agree (0..1, Jaccard on position + pitch). */
  function similarity(a, b) {
    const key = n => (Array.isArray(n) ? n[1] + ':' + n[2] : n.x + ':' + n.y);
    const A = new Set((a || []).map(key)), B = new Set((b || []).map(key));
    if (!A.size && !B.size) return 1;
    let both = 0;
    A.forEach(k => { if (B.has(k)) both++; });
    return both / (A.size + B.size - both);
  }

  /** How many notes (position + pitch) one clip has and the other has not, both ways (a moved note counts 2). */
  function changedNotes(a, b) {
    const key = n => (Array.isArray(n) ? n[1] + ':' + n[2] : n.x + ':' + n.y);
    const A = new Set((a || []).map(key)), B = new Set((b || []).map(key));
    let both = 0;
    A.forEach(k => { if (B.has(k)) both++; });
    return A.size + B.size - 2 * both;
  }

  /**
   * The same notes moved a little in time: same count, each pitch keeps its notes in order, none moved more than tol
   * steps. An edit of the clip itself (Bitwig's quantize, humanize, a nudge), not another clip: position + pitch
   * similarity calls a quantized clip mostly new.
   */
  function nudged(a, b, tol) {
    if (!a || !b || !a.length || a.length !== b.length) return false;
    const byPitch = ns => {
      const m = new Map();
      ns.forEach(n => { const y = Array.isArray(n) ? n[2] : n.y, x = Array.isArray(n) ? n[1] : n.x; (m.get(y) || m.set(y, []).get(y)).push(x); });
      m.forEach(xs => xs.sort((p, q) => p - q));
      return m;
    };
    const A = byPitch(a), B = byPitch(b);
    if (A.size !== B.size) return false;
    for (const [y, xs] of A) {
      const ys = B.get(y);
      if (!ys || ys.length !== xs.length || xs.some((x, i) => Math.abs(x - ys[i]) > tol)) return false;
    }
    return true;
  }

  /** A clip's span in the arranger when nothing follows it (exact when the crawl measured it). */
  function span(c) {
    if (c.length > 0) return c.length;
    if (c.loop && c.loopLength > 0) return Math.max(c.loopStart + c.loopLength - c.playStart, c.loopLength);
    return Math.max(0, c.playStop - c.playStart);
  }

  /** The lane a track's clips are on (the clip navigator's hint; it scans when wrong). */
  const laneOf = (crawl, track) => { const c = crawl.result.find(r => r.track === track); return c ? c.lane : 0; };

  /**
   * Puts a clip seen in Bitwig into the mirror: the clip on its track at the same start is replaced (or confirmed);
   * otherwise it is added. Other clips on that track become suspect when they hold the same content (it may have been
   * moved here; the mirror cannot tell a move from a copy) or start inside the new clip (Bitwig never overlaps clips on
   * a lane). clip = mirror clip (clipFromLive); returns { crawl (a new object, or the same one when nothing changed),
   * action: 'none' | 'confirm' | 'update' | 'add', clip, suspects:[clip] }.
   */
  function upsertClip(crawl, clip, now = Date.now()) {
    const result = crawl.result.slice();
    const i = result.findIndex(c => c.track === clip.track && near(c.start, clip.start));
    let action, put;
    if (i >= 0) {
      const old = result[i];
      if (sameContent(old, clip)) {
        if (!old.suspect) return { crawl, action: 'none', clip: old, suspects: [] };
        put = { ...old, seenAt: now };
        delete put.suspect;
        action = 'confirm';
      } else {
        // The crawl measured a looping clip's visible length; Bitwig keeps it when the content or the loop changes.
        put = { ...clip, lane: old.lane, seenAt: now };
        if (old.length > 0) put.length = old.length;
        action = 'update';
      }
      result[i] = put;
    } else {
      put = { ...clip, lane: laneOf(crawl, clip.track), seenAt: now };
      result.push(put);
      action = 'add';
    }
    const suspects = [];
    const end = put.start + span(put);
    result.forEach((o, j) => {
      if (o === put || o.track !== put.track || o.suspect) return;
      const inside = o.start > put.start + EPS && o.start < end - EPS;
      const moved = action === 'add' && sameContent(o, put) && (o.notes || []).length > 0;
      if (inside || moved) { result[j] = { ...o, suspect: true }; suspects.push(result[j]); }
    });
    return { crawl: { ...crawl, result }, action, clip: put, suspects };
  }

  /**
   * Merges a targeted read ({subset, found, complete, tracks, result}) into the mirror: the tracks it found are
   * replaced by what it read; a wanted track it did not find has no clips any more, but only when the read looked at
   * every lane (complete). The read's track list is the current one. -> { crawl, tracks: [names replaced] }.
   */
  function mergeSubset(crawl, sub, now = Date.now()) {
    const found = new Set(sub.found || []);
    const replaced = new Set(found);
    if (sub.complete) (sub.subset || []).forEach(n => replaced.add(n));
    const result = crawl.result.filter(c => !replaced.has(c.track))
      .concat((sub.result || []).filter(c => replaced.has(c.track)).map(c => ({ ...c, seenAt: now })));
    return { crawl: { ...crawl, tracks: sub.tracks && sub.tracks.length ? sub.tracks : crawl.tracks, result }, tracks: [...replaced] };
  }

  /**
   * The mirror with the current track list (names + group flags from liveData.tracks, and the track type, which tells a
   * project made with New which tracks are staves) and gone tracks' clips dropped.
   */
  function syncTracks(crawl, tracksNow) {
    const now = new Set(tracksNow.map(t => t.name));
    return { ...crawl, tracks: tracksNow.map(t => ({ name: t.name, group: !!t.group, ...(t.type ? { type: t.type } : {}) })),
             result: crawl.result.filter(c => now.has(c.track)) };
  }

  /**
   * The read of a project just made with New: no clips, every instrument track an empty staff (crawl.fresh keeps
   * them while clips arrive). tracks = liveData.tracks; fresh = { timeSig, lengthBeats, markers } from the template.
   */
  function freshCrawl(tracks, fresh, stepsPerBeat = 24) {
    return { state: 'done', stepsPerBeat, result: [], fresh, ...syncTracks({ result: [] }, tracks || []) };
  }

  /** At least this share of the notes the same (similarity): an edit of the clip seen before, not another clip. */
  const SAME_CLIP = 0.6;

  /**
   * Where the settled selected clip starts in the arrangement, or why the mirror should not trust it now.
   * Bitwig often moves the play start marker to a clip you select, so the marker is the clip's start, except:
   *   * while Score View navigates (goto / gotoStay sessions): skip;
   *   * after a gotoStay that left the marker where it was: the navigator says where it stayed (nav.stayed);
   *   * the mirror has exactly these notes on this track at the marker: there (whatever happened before);
   *   * the marker moved but the clip did not change (you clicked the ruler, or selected a copy, e.g. just duplicated):
   *     skip with unsure: true (the page offers to re-read that track). The clip stays "unsure" while it is selected
   *     and edited: an edited copy and the old clip edited after a ruler click cannot be told apart;
   *   * the marker moved and the clip changed: another clip when its notes are mostly new (or the mirrored clip at
   *     the marker looks more like them than the clip seen before); otherwise unsure (an edit after the marker moved,
   *     or an edited copy);
   *   * the marker did not move, same track, but the notes are mostly new (more than one note changed) and Score View
   *     did not edit the clip meanwhile: another clip of this track whose play start marker has not arrived yet (or a
   *     big edit in Bitwig): skip with unsure: true, keeping the memo of the clip seen before, so the marker arriving
   *     later places it (and clears the unsure mark);
   *   * the marker is only taken where the read agrees (markerOrContent): Bitwig does not move it on every click (the
   *     marker at beat 28 with the bar 9 clip selected, live 2026-10-23), and a clip written at the wrong place shows
   *     wrong notes in the score. Otherwise the one clip of the track with exactly these notes, else unsure.
   * obs = { track, sig (noteSig), key (track|length|playStart|loop), notes (live), ps (play start marker),
   *         edited (Score View sent edits since the previous call),
   *         nav ({session, batches, stayed}) | null, clipAt(track, beat) -> the mirrored clip there | null,
   *         clipsOf(track) -> the mirrored clips of the track (optional: without it the marker is trusted) };
   * memo = the previous call's memo.
   * -> { start, via: 'marker'|'nav'|'content' } or { skip: reason, unsure? }, plus memo (pass it to the next call).
   */
  function placeSelected(memo, obs) {
    const nav = obs.nav || null;
    const navDone = nav && memo && memo.navBatches != null && nav.batches !== memo.navBatches;
    const base = { track: obs.track, key: obs.key, sig: obs.sig, notes: obs.notes, ps: obs.ps, navBatches: nav ? nav.batches : memo && memo.navBatches };
    const keep = why => ({ skip: why, memo: memo ? { ...memo, navBatches: base.navBatches } : { ...base, start: null, via: null } });
    const at = (start, via) => ({ start, via, memo: { ...base, start, via } });
    // Not placed, and no placement to measure the next snapshots against (a later edit is not "the clip seen before").
    const unsure = why => ({ skip: why, unsure: true, memo: { ...base, start: null, via: null, unsure: true } });
    if (nav && nav.session) return keep('Score View is writing into clips');
    const stayed = nav && nav.stayed && nav.stayed.track === obs.track ? nav.stayed : null;
    if (navDone && stayed) return at(stayed.start, 'nav');
    if (!memo && stayed && !near(stayed.start, obs.ps)) return keep('not sure where this clip is (pasted into from Score View)');
    if (navDone) return at(obs.ps, 'marker');
    if (!memo) return markerOrContent(obs, memo, at, unsure);
    const sameTrack = memo.track === obs.track, sameClip = sameTrack && memo.key === obs.key, moved = !near(memo.ps, obs.ps);
    if (memo.via === 'nav' && sameClip && !moved) return at(memo.start, 'nav');
    const there = obs.clipAt(obs.track, obs.ps);
    if (there && noteSig(there.notes) === obs.sig) return at(obs.ps, 'marker');
    const like = similarity(memo.notes, obs.notes);
    if (sameClip && memo.unsure && !moved) return unsure('not sure where this clip is (the play start marker moved away from it)');
    if (sameClip && moved) {
      if (memo.sig === obs.sig) return unsure('the play start marker moved, the clip did not');
      if (there ? similarity(there.notes, obs.notes) <= like : like >= SAME_CLIP)
        return unsure('the play start marker moved and the clip changed (an edit, or another clip)');
    }
    // Quantized / humanized in Bitwig (same clip, marker still on it, every note within half a beat): this clip, edited.
    if (sameClip && !moved && nudged(memo.notes, obs.notes, (obs.stepsPerBeat || 24) / 2)) return markerOrContent(obs, memo, at, unsure);
    if (sameTrack && !moved && !obs.edited && like < SAME_CLIP && changedNotes(memo.notes, obs.notes) > 2)
      return { skip: 'another clip of this track, its play start not known yet (or a big edit)', unsure: true,
               memo: { ...memo, navBatches: base.navBatches } };
    return markerOrContent(obs, memo, at, unsure);
  }

  /**
   * The marker as the selected clip's start when the read agrees: the track has no clip in the read yet (a new score
   * or track), the clip placed before is still the selected one (same key, marker unmoved: its place again), the clip
   * of the track at the marker is this one (same notes, the same notes nudged, mostly the same notes), or the marker
   * moved when another clip was selected (live 2026-10-23 it stayed where it was on some clicks: at 48 from a Clarinets
   * clip while a Sketch clip at bar 53.5 was selected). Else the one clip of the track with exactly these notes
   * ('content': the marker was left elsewhere), else unsure.
   */
  function markerOrContent(obs, memo, at, unsure) {
    const mine = obs.clipsOf ? obs.clipsOf(obs.track) : null;
    if (!mine || !mine.length) return at(obs.ps, 'marker');
    if (memo && memo.start != null && memo.track === obs.track && memo.key === obs.key && near(memo.ps, obs.ps))
      return at(memo.start, memo.via || 'marker');
    const there = obs.clipAt(obs.track, obs.ps);
    if (there && (noteSig(there.notes) === obs.sig || similarity(there.notes, obs.notes) >= SAME_CLIP ||
                  nudged(there.notes, obs.notes, (obs.stepsPerBeat || 24) / 2))) return at(obs.ps, 'marker');
    // Another clip selected (other track, span or mostly other notes) and the marker went somewhere new with it: Bitwig
    // put it on this clip (a moved clip, or the marker arriving late).
    if (memo && !near(memo.ps, obs.ps) && (memo.track !== obs.track || memo.key !== obs.key || similarity(memo.notes, obs.notes) < SAME_CLIP))
      return at(obs.ps, 'marker');
    const same = mine.filter(c => noteSig(c.notes) === obs.sig);
    if (same.length === 1) return at(same[0].start, 'content');
    return unsure(there ? 'the clip of this track at the play start marker has other notes (the marker may not be on the selected clip)'
      : 'the play start marker is not on a clip of this track in the read');
  }

  // ---- stored documents

  /** The document stored for a project (extension and IndexedDB). */
  function makeDoc({ project, crawl, readAt, tracksAtRead, savedAt = Date.now() }) {
    return { v: 1, project, readAt: readAt || savedAt, savedAt, tracksAtRead: (tracksAtRead || []).map(t => ({ name: t.name })), crawl };
  }

  /** A stored document that can be installed for this project (or for any project when project is unknown). */
  function validDoc(doc, project) {
    return !!(doc && typeof doc === 'object' && doc.v === 1 && doc.crawl && Array.isArray(doc.crawl.result) &&
      doc.crawl.stepsPerBeat > 0 && (!project || doc.project === project));
  }

  /**
   * True when a stored document plausibly belongs to the open project: at least half of today's tracks were there at
   * the read (two unsaved projects can share a name such as "Untitled"). Unknown on either side = true.
   */
  function tracksAgree(doc, tracksNow) {
    const had = new Set(((doc && doc.tracksAtRead) || []).map(t => t.name));
    if (!had.size || !tracksNow || !tracksNow.length) return true;
    return tracksNow.filter(t => had.has(t.name)).length >= tracksNow.length / 2;
  }

  /** The newest valid document of the candidates (extension, IndexedDB), or null. */
  function pickDoc(docs, project) {
    return docs.filter(d => validDoc(d, project)).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0] || null;
  }

  const api = { noteSig, clipFromLive, sameContent, similarity, nudged, span, upsertClip, mergeSubset, syncTracks, placeSelected,
                makeDoc, validDoc, pickDoc, tracksAgree, freshCrawl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SVArrangementMirror = api;
})(typeof window !== 'undefined' ? window : globalThis);
