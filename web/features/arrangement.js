// Feature module: arrangement. Reads the whole Bitwig arrangement live (no DAWproject export needed) through the
// extension's crawler (POST op 'crawl', GET /api/crawl) and installs it as the Score-mode base layer.
// See docs/AGENTS.md for the SV hook API and docs/research.md section C for how the crawler works.
(function (root) {
  'use strict';

  /**
   * Converts a finished crawl ({stepsPerBeat, tracks:[{name, group}], result:[clip]}) into the base-score shape
   * used by Score mode ({title, timeSig, parts:[{name, group, notes}], lengthBeats, markers}).
   * Clip: {track, start (arranger beats), playStart (content offset), playStop, loop, loopStart, loopLength,
   *        notes:[[ch, x, y, durBeats, vel0to127]]}.
   * Bitwig does not expose a clip's visible length, so each clip ends at the next clip on its track, or at its
   * content end (non-looping) / one loop pass (looping) when it is the last one.
   */
  // Visible end (arranger beats) of clip c; next = the following clip on its track (or undefined). Exact when the
  // crawl measured the length; otherwise the next clip's start, or the content end / one loop pass.
  function clipEnd(c, next) {
    const loopEnd = c.loopStart + c.loopLength;
    const natural = c.loop && c.loopLength > 0 ? Math.max(loopEnd - c.playStart, c.loopLength) : c.playStop - c.playStart;
    return c.length > 0 ? c.start + c.length : Math.min(next ? next.start : Infinity, c.start + Math.max(0, natural));
  }

  function crawlToScore(crawl, { title = 'Arrangement', timeSig = { num: 4, den: 4 }, markers = [] } = {}) {
    const spb = crawl.stepsPerBeat;
    // Group of each track: the nearest group header above it in the (expanded) flat track list.
    const groupOf = new Map();
    let group = null;
    (crawl.tracks || []).forEach(t => { if (t.group) group = t.name; else if (!groupOf.has(t.name)) groupOf.set(t.name, group); });
    const order = (crawl.tracks || []).filter(t => !t.group).map(t => t.name);

    const byTrack = new Map();
    crawl.result.forEach(c => { if (!byTrack.has(c.track)) byTrack.set(c.track, []); byTrack.get(c.track).push(c); });
    let lengthBeats = 0;
    const parts = [];
    const names = [...byTrack.keys()].sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
    names.forEach((name, ti) => {
      const clips = byTrack.get(name).slice().sort((a, b) => a.start - b.start);
      const notes = [];
      clips.forEach((c, i) => {
        const loopEnd = c.loopStart + c.loopLength;
        const end = clipEnd(c, clips[i + 1]);
        // Walk the clip's timeline: content plays from playStart; a looping clip wraps from loopEnd to loopStart.
        const segs = [];
        let t = c.start, from = c.playStart;
        for (let guard = 0; t < end - 1e-9 && guard < 10000; guard++) {
          const segEnd = c.loop && c.loopLength > 0 ? loopEnd : Infinity;
          const len = Math.min(segEnd - from, end - t);
          if (len <= 0) break;
          segs.push({ from, to: from + len, at: t });
          t += len;
          from = c.loopStart;
          if (!c.loop) break;
        }
        segs.forEach(seg => c.notes.forEach(([, x, y, d, vel]) => {
          const pos = x / spb;
          if (pos < seg.from - 1e-9 || pos >= seg.to - 1e-9) return;
          const start = seg.at + (pos - seg.from);
          const dur = Math.min(d, end - start);
          if (dur <= 0) return;
          notes.push({ id: 'k' + ti + '_' + notes.length, start, dur, pitch: y, vel: vel / 127 });
          lengthBeats = Math.max(lengthBeats, start + dur);
        }));
      });
      notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      if (notes.length) parts.push({ name, group: groupOf.get(name) || undefined, notes });
    });
    return { title, timeSig, parts, lengthBeats, markers, source: 'crawl' };
  }

  // ------------------------------------------------------------------ is the read still current? (pure, node-testable)
  // The extension only reports the selected clip, so this is a heuristic: a clip seen since the read whose notes or
  // play range match no crawled clip on its track, or a changed track list, means the snapshot may be old.

  /** Order-independent signature of a clip's notes: live notes {x, y, d} or crawl rows [ch, x, y, d, vel]. */
  function noteSig(notes) {
    return (notes || []).map(n => Array.isArray(n) ? [n[1], n[2], n[3]] : [n.x, n.y, n.d])
      .map(([x, y, d]) => x + ':' + y + ':' + Math.round(d * 1000)).sort().join(',');
  }
  const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-6;
  /** What the extension says about the selected clip, reduced to what the crawl can be compared with. */
  function clipSnapshot(d) {
    return { track: d.track, sig: noteSig(d.notes), count: (d.notes || []).length, playStart: d.playStart || 0, playStop: d.length || 0 };
  }
  const sameClip = (c, snap) => noteSig(c.notes) === snap.sig && near(c.playStart, snap.playStart) && near(c.playStop, snap.playStop);
  /**
   * The crawled clip the selected clip is (crawl, liveData or snapshot) -> { clip, exact } | null: same notes and play
   * range first, then the same play range, then the only clip on that track.
   */
  function matchClip(crawl, d) {
    if (!crawl || !crawl.result || !d) return null;
    const snap = d.sig != null ? d : clipSnapshot(d);
    const cands = crawl.result.filter(c => c.track === snap.track);
    const exact = cands.find(c => sameClip(c, snap));
    if (exact) return { clip: exact, exact: true };
    const range = cands.filter(c => near(c.playStart, snap.playStart) && near(c.playStop, snap.playStop));
    if (range.length === 1) return { clip: range[0], exact: false };
    return cands.length === 1 ? { clip: cands[0], exact: false } : null;
  }
  /** True when a clip seen since the read differs from every crawled clip on its track (an empty new clip does not count). */
  function clipChanged(crawl, snap) {
    const m = matchClip(crawl, snap);
    if (m && m.exact) return false;
    const onTrack = crawl.result.filter(c => c.track === snap.track);
    return !(snap.count === 0 && !onTrack.some(c => c.notes && c.notes.length));
  }
  const trackSig = tracks => JSON.stringify((tracks || []).map(t => t.name));
  /**
   * Why the read may be out of date -> [reason] (empty = current). o: { crawl, tracksAtRead, tracksNow (liveData.tracks),
   * seen: Map(track -> clipSnapshot), current (the selected clip's track), edited: Set (tracks Score View edited; their
   * clips are overlaid live, so they stay right) }.
   */
  function staleReasons({ crawl, tracksAtRead, tracksNow, seen, current, edited }) {
    if (!crawl || !crawl.result) return [];
    const out = [];
    if (tracksAtRead && tracksNow && trackSig(tracksAtRead) !== trackSig(tracksNow)) {
      const before = new Set(tracksAtRead.map(t => t.name)), now = new Set(tracksNow.map(t => t.name));
      const added = [...now].filter(n => !before.has(n)), gone = [...before].filter(n => !now.has(n));
      out.push(added.length || gone.length ? 'tracks changed' + (added.length ? ' (new: ' + added.join(', ') + ')' : '') +
        (gone.length ? ' (gone: ' + gone.join(', ') + ')' : '') : 'tracks were reordered');
    }
    (seen || new Map()).forEach((snap, track) => {
      if (track === current || (edited && edited.has(track))) return;
      if (clipChanged(crawl, snap)) out.push(track + ' changed');
    });
    return out;
  }

  const pure = { crawlToScore, clipEnd, noteSig, clipSnapshot, matchClip, clipChanged, staleReasons };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ------------------------------------------------------------------ page UI
  const SV = root.SV;
  if (!SV) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let busy = false;

  // Preference "After reading the arrangement": 'all' shows every track with notes (default), 'keep' keeps the
  // Tracks menu / section choice as it was.
  const PREF_KEY = 'scoreview.arrangement.afterRead';
  const prefs = { afterRead: (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || 'all'; } catch (e) { return 'all'; } })() };
  const savePref = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs.afterRead)); } catch (e) { /* ignore */ } };

  SV.addStyle(`
    #svarStale { color: var(--sv-warn); font-size: 15px; line-height: 1; cursor: help; }
    #svarStale[hidden] { display: none; }
    .svar-pref { display: block; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line); color: var(--dim); white-space: nowrap; }
  `);
  const bar = SV.addToolbar(`<button class="btn" id="svarRead" title="Read every clip in Bitwig's arrangement into Score mode (no DAWproject export needed). Select any clip in the Arranger first.">⟳ Read arrangement</button>
    <span id="svarStale" hidden role="status">●</span>
    <label title="Measure each clip's visible length with Bitwig's Loop Selection (each change is undone again straight away). Only needed for clips trimmed shorter than their content."><input type="checkbox" id="svarExact"> Exact clip lengths</label>
    <button class="btn hidden" id="svarCancel">Cancel</button><span id="svarStatus" style="color:var(--dim);font-size:12px"></span>`, { cluster: 'score', order: 150 });
  const $ = id => document.getElementById(id);
  const status = t => { $('svarStatus').textContent = t; };

  // The preference lives in the Tracks ▾ panel, under the pinned / all choice it affects.
  const panel = $('trackPanel');
  if (panel) {
    const label = document.createElement('label');
    label.className = 'svar-pref';
    label.title = 'After ⟳ Read arrangement, Score mode shows every track that has notes. Off: keep the pinned tracks / section you chose.';
    label.innerHTML = '<input type="checkbox" id="svarShowAll"> After ⟳ Read arrangement: show all tracks';
    panel.insertBefore(label, $('trackList'));
    const box = label.querySelector('input');
    box.checked = prefs.afterRead === 'all';
    box.addEventListener('change', e => { e.stopPropagation(); prefs.afterRead = box.checked ? 'all' : 'keep'; savePref(); });
  }

  // Shows every staff of the new read: Tracks "All tracks", and a section view other than Full/Pinned goes back to Pinned.
  function showAllTracks() {
    if (prefs.afterRead !== 'all') return;
    SV.state.trackMode = 'all';
    try { localStorage.setItem('scoreview.trackMode2', JSON.stringify('all')); } catch (e) { /* ignore */ }
    if (SV.sections && SV.sections.showAll) SV.sections.showAll();
  }

  // ---- out-of-date indicator
  const watch = { tracksAtRead: null, seen: new Map(), base: null, quietUntil: 0, reasons: [] };
  function resetWatch() {
    watch.seen = new Map();
    watch.base = SV.state.base;
    // clip-navigation updates may still arrive from an Orchestrate/Inspire write that installed this base
    watch.quietUntil = (SV.state.baseMtime || Date.now()) + 1500;
  }
  function observe(d) {
    const S = SV.state;
    if (!S.crawl || !S.base || S.base.source !== 'crawl') { watch.reasons = []; return paintStale(); }
    if (S.base !== watch.base) resetWatch(); // orchestrate.js rebuilt the base from the updated crawl: current again
    if (!watch.tracksAtRead && d && d.tracks) watch.tracksAtRead = d.tracks.map(t => ({ name: t.name }));
    if (d && d.exists && Date.now() >= watch.quietUntil) watch.seen.set(d.track, pure.clipSnapshot(d));
    watch.reasons = pure.staleReasons({ crawl: S.crawl, tracksAtRead: watch.tracksAtRead, tracksNow: d && d.tracks,
      seen: watch.seen, current: d && d.exists ? d.track : null, edited: S.editedTracks });
    paintStale();
  }
  function paintStale() {
    const dot = $('svarStale');
    const stale = watch.reasons.length > 0;
    dot.hidden = !stale;
    dot.title = stale ? 'The arrangement may have changed since the last read (' + watch.reasons.join('; ') + '). ⟳ Read it again to update Score mode.' : '';
    $('svarRead').classList.toggle('svar-stale', stale);
    if (stale !== watch.painted) { watch.painted = stale; window.dispatchEvent(new Event('sv-read-stale')); } // layout.js: status text
  }
  SV.hooks.liveData.push(observe);

  async function read() {
    if (busy) return;
    busy = true;
    $('svarRead').disabled = true;
    $('svarCancel').classList.remove('hidden');
    try {
      status('Starting… (Bitwig\'s selection will move while it reads)');
      SV.send([$('svarExact').checked ? 'crawl exact' : 'crawl']);
      let st = null;
      for (let i = 0; i < 1200; i++) { // up to ~6 minutes
        await sleep(300);
        st = await (await fetch('/api/crawl', { cache: 'no-store' })).json();
        if (st.state === 'running') status(st.message);
        else if (i > 2 || st.state !== 'idle') break;
      }
      if (!st || st.state !== 'done') { status(st && st.message ? st.message : 'The arrangement could not be read.'); return; }
      const d = SV.state.liveData || {};
      let title = 'Arrangement';
      try { title = (await (await fetch('/api/transport', { cache: 'no-store' })).json()).project || title; } catch (e) { /* keep default */ }
      SV.state.crawl = st; // raw clips (lane, start, playStart, notes...): features/orchestrate.js writes through it
      const score = crawlToScore(st, { title, timeSig: { num: d.num || 4, den: d.den || 4 }, markers: d.markers || [] });
      showAllTracks();
      SV.setBase(score, Date.now());
      watch.tracksAtRead = d.tracks ? d.tracks.map(t => ({ name: t.name })) : null;
      resetWatch();
      observe(SV.state.liveData);
      status(`${st.message} · ${score.parts.length} parts`);
    } catch (e) {
      status('Read failed: ' + e.message);
    } finally {
      busy = false;
      $('svarRead').disabled = false;
      $('svarCancel').classList.add('hidden');
    }
  }

  $('svarRead').addEventListener('click', read);
  $('svarCancel').addEventListener('click', () => SV.send(['crawlCancel']));
  SV.arrangement = { ...pure, read, prefs,
    /** Why the last read may be out of date ([] = current, or no read). */
    staleReasons: () => watch.reasons.slice(),
    /** The crawled clip the selected clip is ({clip, exact} | null), from the last read. */
    liveClip: () => (SV.state.crawl && SV.state.liveData && SV.state.liveData.exists ? pure.matchClip(SV.state.crawl, SV.state.liveData) : null),
  };
})(this);
