// Feature module: arrangement. Reads the whole Bitwig arrangement live (no DAWproject export needed) through the
// extension's crawler (POST op 'crawl', GET /api/crawl) and installs it as the Score-mode base layer. The read is a
// once-per-project step: it is stored per project (GET/POST /api/arrangement, IndexedDB as a fallback) and restored on
// page load, and kept current as a mirror (features/arrangement-mirror.js): the clip selected in Bitwig is harvested
// into it once its data has settled, and the out-of-date dot offers a targeted re-read of the tracks it cannot fix.
// While Score view plays, it listens (features/arrangement-listen.js, GET /api/listen) and marks tracks whose playback
// no longer matches the read. See docs/AGENTS.md for the SV hook API and docs/research.md section C for the crawler.
(function (root) {
  'use strict';
  const node = typeof module !== 'undefined' && module.exports;
  const M = node ? require('./arrangement-mirror.js') : root.SVArrangementMirror;
  const L = node ? require('./arrangement-listen.js') : root.SVArrangementListen;

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

  // The tracks with clips, in Bitwig's track order (unknown tracks last), and each track's group.
  function trackOrder(crawl) {
    const groupOf = new Map();
    let group = null;
    (crawl.tracks || []).forEach(t => { if (t.group) group = t.name; else if (!groupOf.has(t.name)) groupOf.set(t.name, group); });
    const order = (crawl.tracks || []).filter(t => !t.group).map(t => t.name);
    // a staff in a project made with New: instrument tracks (effect, master and audio tracks have no notation)
    const staff = new Set((crawl.tracks || []).filter(t => !t.group && (!t.type || /instrument|hybrid/i.test(t.type))).map(t => t.name));
    // A project made with New (crawl.fresh) keeps every track as a staff, also those without clips yet.
    const names = [...new Set((crawl.fresh ? order.filter(n => staff.has(n)) : []).concat(crawl.result.map(c => c.track)))]
      .sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
    return { names, groupOf };
  }
  // A track's part in the base: only with notes, except in a project made with New (an empty staff to write into).
  const keepPart = (crawl, notes) => notes.length > 0 || !!crawl.fresh;
  const freshLength = (crawl, ends) => Math.max(0, (crawl.fresh && crawl.fresh.lengthBeats) || 0, ...Object.values(ends));

  // One track's notes on the arranger time line, and where its last clip ends. ti = the track's index in trackOrder
  // (note ids 'k<ti>_<n>').
  function trackNotes(crawl, name, ti) {
    const spb = crawl.stepsPerBeat;
    const clips = crawl.result.filter(c => c.track === name).sort((a, b) => a.start - b.start);
    const notes = [];
    let end = 0;
    clips.forEach((c, i) => {
      const loopEnd = c.loopStart + c.loopLength;
      const cEnd = clipEnd(c, clips[i + 1]);
      if (Number.isFinite(cEnd)) end = Math.max(end, cEnd); // the song runs to the last clip's end, not its last note
      // Walk the clip's timeline: content plays from playStart; a looping clip wraps from loopEnd to loopStart.
      const segs = [];
      let t = c.start, from = c.playStart;
      for (let guard = 0; t < cEnd - 1e-9 && guard < 10000; guard++) {
        const segEnd = c.loop && c.loopLength > 0 ? loopEnd : Infinity;
        const len = Math.min(segEnd - from, cEnd - t);
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
        const dur = Math.min(d, cEnd - start);
        if (dur <= 0) return;
        notes.push({ id: 'k' + ti + '_' + notes.length, start, dur, pitch: y, vel: vel / 127 });
        end = Math.max(end, start + dur);
      }));
    });
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    return { notes, end };
  }

  function crawlToScore(crawl, { title = 'Arrangement', timeSig = { num: 4, den: 4 }, markers = [] } = {}) {
    const { names, groupOf } = trackOrder(crawl);
    const parts = [], ends = {};
    names.forEach((name, ti) => {
      const { notes, end } = trackNotes(crawl, name, ti);
      ends[name] = end;
      if (keepPart(crawl, notes)) parts.push({ name, group: groupOf.get(name) || undefined, notes });
    });
    const f = crawl.fresh;
    return { title, timeSig: (f && f.timeSig) || timeSig, parts, lengthBeats: freshLength(crawl, ends),
             markers: markers.length || !f ? markers : f.markers || [], source: 'crawl', fresh: !!f, trackNames: names, ends };
  }

  /**
   * The base score after some tracks of the crawl changed: only those parts are rebuilt (a harvested clip costs one
   * track, not the whole arrangement). Falls back to a full crawlToScore when the set or order of tracks changed.
   * -> { score (a new object), full }.
   */
  function updateScore(score, crawl, tracks) {
    const { names, groupOf } = trackOrder(crawl);
    if (!score || !score.ends || !score.trackNames || JSON.stringify(names) !== JSON.stringify(score.trackNames))
      return { score: crawlToScore(crawl, { title: score && score.title, timeSig: score && score.timeSig, markers: (score && score.markers) || [] }), full: true };
    const ends = { ...score.ends };
    let parts = score.parts.slice();
    [...new Set(tracks)].forEach(name => {
      const ti = names.indexOf(name);
      parts = parts.filter(p => p.name !== name);
      if (ti < 0) { delete ends[name]; return; }
      const { notes, end } = trackNotes(crawl, name, ti);
      ends[name] = end;
      if (keepPart(crawl, notes)) parts.push({ name, group: groupOf.get(name) || undefined, notes });
    });
    parts.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
    return { score: { ...score, parts, ends, lengthBeats: freshLength(crawl, ends) }, full: false };
  }

  // ------------------------------------------------------------------ is the read still current? (pure, node-testable)
  // The extension only reports the selected clip, so this is a heuristic: a clip seen since the read whose notes or
  // play range match no crawled clip on its track, or a changed track list, means the snapshot may be old. With the
  // mirror, a seen clip is harvested once settled, so what remains is what the mirror could not fix.

  const noteSig = M.noteSig;
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
   * Why the read may be out of date, and what a targeted re-read would fix -> { reasons:[text] (empty = current),
   * refresh:[track names to re-read], added, gone, reordered }. o: { crawl, tracksAtRead, tracksNow (liveData.tracks),
   * seen: Map(track -> clipSnapshot), current (the selected clip's track), edited: Set (tracks Score View edited; their
   * clips are overlaid live, so they stay right), unsure: Set (tracks with a clip the mirror could not place),
   * heard: Map(track -> bar) (listening found its playback no longer matches the read from that bar on),
   * barOf(beat) -> bar number for the suspect texts }.
   */
  function staleInfo({ crawl, tracksAtRead, tracksNow, seen, current, edited, unsure, heard, barOf }) {
    const out = { reasons: [], refresh: [], added: [], gone: [], reordered: false };
    if (!crawl || !crawl.result) return out;
    const refresh = new Set();
    if (tracksAtRead && tracksNow && trackSig(tracksAtRead) !== trackSig(tracksNow)) {
      const before = new Set(tracksAtRead.map(t => t.name)), now = new Set(tracksNow.map(t => t.name));
      out.added = [...now].filter(n => !before.has(n));
      out.gone = [...before].filter(n => !now.has(n));
      out.reordered = !out.added.length && !out.gone.length;
      out.reasons.push(!out.reordered ? 'tracks changed' + (out.added.length ? ' (new: ' + out.added.join(', ') + ')' : '') +
        (out.gone.length ? ' (gone: ' + out.gone.join(', ') + ')' : '') : 'tracks were reordered');
      out.added.forEach(n => refresh.add(n));
    }
    (seen || new Map()).forEach((snap, track) => {
      if (track === current || (edited && edited.has(track))) return;
      if (clipChanged(crawl, snap)) { out.reasons.push(track + ' changed'); refresh.add(track); }
    });
    const bar = b => (barOf ? 'bar ' + barOf(b) : 'beat ' + Math.round(b * 100) / 100);
    crawl.result.filter(c => c.suspect).forEach(c => {
      out.reasons.push(c.track + ': the clip at ' + bar(c.start) + ' may have moved');
      refresh.add(c.track);
    });
    (unsure || new Set()).forEach(track => {
      if (refresh.has(track)) return;
      out.reasons.push(track + ': a clip the read does not have may have been selected');
      refresh.add(track);
    });
    (heard || new Map()).forEach((n, track) => {
      if (refresh.has(track) || (edited && edited.has(track))) return;
      out.reasons.push(track + ' changed at bar ' + n + ' (heard while playing)');
      refresh.add(track);
    });
    const exists = tracksNow ? new Set(tracksNow.map(t => t.name)) : null;
    out.refresh = [...refresh].filter(n => !exists || exists.has(n));
    return out;
  }
  /** Why the read may be out of date -> [reason] (empty = current); see staleInfo. */
  const staleReasons = o => staleInfo(o).reasons;

  const pure = { crawlToScore, updateScore, clipEnd, noteSig, clipSnapshot, matchClip, clipChanged, staleInfo, staleReasons, mirror: M, listen: L };
  if (node) { module.exports = pure; return; }

  // ------------------------------------------------------------------ page UI
  const SV = root.SV;
  if (!SV) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getJson = async url => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); };
  let busy = false;


  SV.addStyle(`
    #svarStale { color: var(--sv-warn); font-size: 15px; line-height: 1; cursor: pointer; background: none; border: 0; padding: 0 2px; }
    #svarStale[hidden] { display: none; }
    #svarPop { position: fixed; z-index: var(--sv-z-pop); min-width: 260px; max-width: 420px; padding: var(--sv-space-4) var(--sv-space-5);
      background: var(--sv-surface-2); color: var(--sv-text); border: 1px solid var(--sv-border); border-radius: var(--sv-radius-md);
      box-shadow: var(--sv-shadow-pop); font-size: var(--sv-fs-control); }
    #svarPop[hidden] { display: none; }
    #svarPop ul { margin: 0 0 var(--sv-space-4); padding-left: 18px; color: var(--sv-text-dim); }
    #svarPop .svar-row { display: flex; gap: var(--sv-space-3); flex-wrap: wrap; }
    #svarFail { position: fixed; z-index: var(--sv-z-pop); max-width: 420px; padding: var(--sv-space-4) var(--sv-space-5);
      background: var(--sv-surface-2); color: var(--sv-text); border: 1px solid var(--sv-warn); border-radius: var(--sv-radius-md);
      box-shadow: var(--sv-shadow-pop); font-size: var(--sv-fs-control); }
    #svarFail[hidden] { display: none; }
    #svarFail b { color: var(--sv-warn); }
    #svarFail p { margin: 0 0 var(--sv-space-4); }
    .svar-pref { display: block; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line); color: var(--dim); white-space: normal; }
  `);
  const bar = SV.addToolbar(`<button class="btn" id="svarRead" title="Read every clip of the open Bitwig project into the score. Click any clip in Bitwig's Arranger first.">⟳ Read project</button>
    <span id="svarStale" hidden role="button" tabindex="0" aria-haspopup="dialog">●</span>

    <button class="btn hidden" id="svarCancel">Cancel</button><span id="svarStatus" style="color:var(--dim);font-size:12px"></span>`, { cluster: 'score', order: 150 });
  const $ = id => document.getElementById(id);
  const status = t => { $('svarStatus').textContent = t; };
  const pop = document.createElement('div');
  pop.id = 'svarPop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.innerHTML = `<div id="svarWhy"></div><div class="svar-row">
      <button class="btn" id="svarRefresh" title="Read only these tracks again (Bitwig's selection moves while it reads)">Refresh</button>
      <button class="btn" id="svarReadAll">Read everything</button></div>
    <label class="svar-pref"><input type="checkbox" id="svarAuto"> Refresh out-of-date tracks by itself when playback stops and
      nothing changes for a few seconds (moves Bitwig's selection)</label>
    <label class="svar-pref"><input type="checkbox" id="svarListen"> Listen while playing: compare what Bitwig plays in Score
      view with the read and list tracks that changed (changes nothing in Bitwig)</label>`;
  document.body.appendChild(pop);

  // ---- a read that could not start or stopped: a prompt under the Read button that says what to do, with Try again.
  // fix (ArrangementCrawler statusJson): 'clickClip' = Bitwig's focus is not on the Arranger timeline; 'stop' = playing.
  // While it is open, selecting another clip in Bitwig (clickClip) or stopping playback (stop) tries again by itself.
  const fail = document.createElement('div');
  fail.id = 'svarFail';
  fail.hidden = true;
  fail.setAttribute('role', 'alertdialog');
  fail.innerHTML = `<p><b>The project could not be read.</b> <span id="svarFailWhy"></span></p><p id="svarFailHint"></p>
    <div class="svar-row"><button class="btn" id="svarRetry">Try again</button><button class="btn" id="svarFailClose">Close</button></div>`;
  document.body.appendChild(fail);
  const failing = { fix: '', key: null, retry: null };
  // A read ended without a result: Cancel says so in the status, anything else opens the prompt.
  function failed(st, retryFn) {
    if (st && /^cancel/i.test(st.message || '')) { status('Cancelled'); return; }
    status('');
    const fix = (st && st.fix) || '', d = SV.state.liveData;
    Object.assign(failing, { fix, key: d && d.exists ? clipKey(d) : null, retry: retryFn });
    $('svarFailWhy').textContent = (st && st.message) || 'Bitwig did not answer.';
    const selInBitwig = document.getElementById('bitwigSel');
    $('svarFailHint').textContent = fix === 'clickClip'
      ? 'In Bitwig, click any clip in the Arranger timeline (the clip itself, not a note inside it). Score View tries again when you select another clip, or press Try again.'
        + (selInBitwig && selInBitwig.checked ? ' "Select in Bitwig too" (View ▾) is on: it selects notes in Bitwig, which causes this; turn it off.' : '')
      : fix === 'stop' ? 'Score View tries again when playback stops.' : '';
    fail.hidden = false;
    const r = $('svarRead').getBoundingClientRect();
    fail.style.left = Math.max(8, Math.min(r.left, window.innerWidth - fail.offsetWidth - 8)) + 'px';
    fail.style.top = (r.bottom + 6) + 'px';
  }
  function closeFail() { fail.hidden = true; failing.fix = ''; failing.retry = null; }
  function retry() { const fn = failing.retry; closeFail(); if (fn) fn(); }
  $('svarRetry').addEventListener('click', retry);
  $('svarFailClose').addEventListener('click', closeFail);
  document.addEventListener('keydown', e => { if (!fail.hidden && e.key === 'Escape') { closeFail(); e.stopPropagation(); } }, true);
  function retryWhenFixed(d) {
    if (fail.hidden || busy || !failing.retry || !d) return;
    if (failing.fix === 'stop' && !SV.state.playing) retry();
    else if (failing.fix === 'clickClip' && d.exists && d.settled !== false && clipKey(d) !== failing.key) retry();
  }

  const PREF_AUTO = 'scoreview.arrangement.autoRefresh', PREF_LISTEN = 'scoreview.arrangement.listen';
  const stored = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const prefs = { autoRefresh: stored(PREF_AUTO) === 'true', listen: stored(PREF_LISTEN) !== 'false' };
  $('svarAuto').checked = prefs.autoRefresh;
  $('svarListen').checked = prefs.listen;
  const prefToggle = (id, key, pref, after) => $(id).addEventListener('change', e => {
    prefs[pref] = e.target.checked;
    try { localStorage.setItem(key, String(prefs[pref])); } catch (err) { /* private mode */ }
    if (after) after();
  });
  const listener = L.createListener();
  prefToggle('svarAuto', PREF_AUTO, 'autoRefresh');
  prefToggle('svarListen', PREF_LISTEN, 'listen', () => { if (!prefs.listen) { listener.reset(); observe(SV.state.liveData); } });

  // (A Read no longer changes which tracks are shown: the Clip / Score view and Instruments ▾ decide that.)

  // ---- out-of-date indicator
  const watch = { tracksAtRead: null, seen: new Map(), base: null, quietUntil: 0, info: staleInfo({}) };
  function resetWatch() {
    watch.seen = new Map();
    watch.base = SV.state.base;
    // clip-navigation updates may still arrive from an Orchestrate/Inspire write that installed this base
    watch.quietUntil = (SV.state.baseMtime || Date.now()) + 1500;
    if (!mirror.installing) schedulePersist(); // orchestrate.js / passage.js wrote into the crawl and rebuilt the base
  }
  function barOf(beat) {
    const ts = (SV.state.base && SV.state.base.timeSig) || { num: 4, den: 4 };
    return Math.floor(beat / (ts.num * 4 / ts.den) + 1e-6) + 1;
  }
  function observe(d) {
    const S = SV.state;
    if (!S.crawl || !S.base || S.base.source !== 'crawl') { watch.info = staleInfo({}); return paintStale(); }
    if (S.base !== watch.base) resetWatch(); // orchestrate.js rebuilt the base from the updated crawl: current again
    if (!watch.tracksAtRead && d && d.tracks) watch.tracksAtRead = d.tracks.map(t => ({ name: t.name }));
    // Only settled data (when the extension says so): mid-switch the new clip's notes can arrive under the old
    // track's name, and that snapshot would mark the old track changed.
    if (d && d.exists && d.settled !== false && Date.now() >= watch.quietUntil) watch.seen.set(d.track, clipSnapshot(d));
    watch.info = staleInfo({ crawl: S.crawl, tracksAtRead: watch.tracksAtRead, tracksNow: d && d.tracks,
      seen: watch.seen, current: d && d.exists ? d.track : null, edited: S.editedTracks, unsure: mirror.unsure,
      heard: prefs.listen ? listener.flagged() : null, barOf });
    paintStale();
  }
  function paintStale() {
    const dot = $('svarStale');
    const why = watch.info.reasons;
    const stale = why.length > 0;
    dot.hidden = !stale;
    dot.title = stale ? 'The arrangement may have changed since the last read (' + why.join('; ') + '). Click to refresh.' : '';
    $('svarRead').classList.toggle('svar-stale', stale);
    if (!stale) closePop(); else if (!pop.hidden) fillPop();
    if (stale !== watch.painted) { watch.painted = stale; window.dispatchEvent(new Event('sv-read-stale')); } // layout.js: status text
  }

  // ---- the dot's popover: why, Refresh N tracks, Read everything, the auto-refresh preference
  function fillPop() {
    const info = watch.info, n = info.refresh.length;
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    $('svarWhy').innerHTML = '<ul>' + info.reasons.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>';
    $('svarRefresh').textContent = n ? 'Refresh ' + n + ' track' + (n === 1 ? '' : 's') : 'Update the track list';
    $('svarRefresh').title = n ? 'Read ' + info.refresh.join(', ') + ' again (Bitwig\'s selection moves while it reads)'
      : 'Take in the new track order (no read needed)';
    $('svarRefresh').disabled = busy;
    $('svarReadAll').disabled = busy;
  }
  function openPop() {
    fillPop();
    pop.hidden = false;
    const r = $('svarStale').getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
  }
  function closePop() { pop.hidden = true; }
  $('svarStale').addEventListener('click', () => (pop.hidden ? openPop() : closePop()));
  $('svarStale').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPop(); } });
  document.addEventListener('mousedown', e => { if (!pop.hidden && !pop.contains(e.target) && e.target !== $('svarStale')) closePop(); }, true);
  document.addEventListener('keydown', e => { if (!pop.hidden && e.key === 'Escape') { closePop(); e.stopPropagation(); } }, true);
  $('svarRefresh').addEventListener('click', () => { closePop(); refreshTracks(watch.info.refresh); });
  $('svarReadAll').addEventListener('click', () => { closePop(); read(); });

  // ------------------------------------------------------------------ the mirror
  // installing: a base install by this module (restore / read), which must not be posted back as a change.
  // restoredAt: the read was restored from storage then (0 = read in this page); confirmed: clips ('track@start') seen
  // in Bitwig since. Bitwig may have changed while the page was closed, so a restored clip is unconfirmed until it is
  // harvested (selected) or re-read; passage.js does not paste into unconfirmed clips.
  const mirror = { memo: null, unsure: new Set(), project: null, readAt: 0, restoredAt: 0, confirmed: new Set(), installing: false, saveTimer: 0,
                   harvestTimer: 0, placedAt: 0, restoredFor: undefined, wasPlaying: false, stoppedAt: 0, autoTried: '' };
  // Harvest: once the selected clip's data has been quiet this long, it goes into the mirror (a second look at the
  // play start marker CONFIRM_MS later must agree). An extension that reports d.settled (perf/sync-settled) skips both,
  // and with d.selPlayStart the /api/transport fetch too.
  const HARVEST_QUIET_MS = 300, CONFIRM_MS = 150, SAVE_MS = 1000, AUTO_QUIET_MS = 4000;
  const clipKey = d => [d.track, d.length, d.playStart, d.loopStart, d.loopLength].join('|');
  const usable = () => { const S = SV.state; return !!(S.crawl && S.crawl.result && S.base && S.base.source === 'crawl'); };

  const idb = {
    open: () => new Promise((res, rej) => {
      const r = indexedDB.open('scoreview-arrangement', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }),
    async get(k) { const db = await this.open(); return new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); },
    async set(k, v) { const db = await this.open(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); },
  };

  /** Stores the mirror (extension + IndexedDB) a moment after the last change. */
  function schedulePersist() {
    clearTimeout(mirror.saveTimer);
    if (!usable()) return;
    mirror.saveTimer = setTimeout(persist, SAVE_MS);
  }
  async function persist() {
    const S = SV.state;
    if (!usable()) return;
    const project = mirror.project || (S.liveData && S.liveData.project);
    if (!project) return;
    const doc = M.makeDoc({ project, crawl: S.crawl, readAt: mirror.readAt || S.baseMtime, tracksAtRead: watch.tracksAtRead });
    try { await idb.set('mirror:' + project, doc); } catch (e) { /* no IndexedDB (private window) */ }
    try {
      await fetch('/api/arrangement?project=' + encodeURIComponent(project), { method: 'POST', body: JSON.stringify(doc) });
    } catch (e) { /* an older extension without the endpoint: IndexedDB has it */ }
  }

  /** Installs a crawl as the base (a read, or a stored one) and starts watching it. */
  function install(crawl, { readAt, tracksAtRead, title, project, restored = false }) {
    const S = SV.state, d = S.liveData || {};
    S.crawl = crawl; // raw clips (lane, start, playStart, notes...): features/orchestrate.js writes through it
    mirror.readAt = readAt;
    mirror.restoredAt = restored ? Date.now() : 0;
    mirror.confirmed.clear();
    mirror.memo = null;
    mirror.unsure.clear();
    listener.reset(); // a new read: baselines are learned again on the next pass
    if (project) mirror.project = project;
    const score = crawlToScore(crawl, { title: title || project || 'Arrangement', timeSig: { num: d.num || 4, den: d.den || 4 }, markers: d.markers || [] });
    mirror.installing = true;
    try {
      SV.setBase(score, readAt);
      watch.tracksAtRead = tracksAtRead && tracksAtRead.length ? tracksAtRead.map(t => ({ name: t.name })) : (d.tracks ? d.tracks.map(t => ({ name: t.name })) : null);
      resetWatch();
    } finally { mirror.installing = false; }
    observe(S.liveData);
    return score;
  }

  /** Puts an updated crawl in place, rebuilding only the given tracks' parts. opts: { place, render, drop }. */
  function applyMirror(crawl, tracks, { place = null, render = true, drop = null } = {}) {
    const S = SV.state;
    S.crawl = crawl;
    listener.resetTracks(tracks); // what was heard about these tracks compared them with their old clips
    const u = updateScore(S.base, crawl, tracks);
    watch.base = u.score; // the same read, kept current: not a new one for the watch
    SV.updateBase(u.score, { drop: drop || tracks.map(track => ({ track })), place, render: render || u.full });
    schedulePersist();
    observe(S.liveData);
  }

  // ---- restore the stored read on page load and when another project opens
  async function restore() {
    const S = SV.state, d = S.liveData || {};
    let project = d.project || null, server = null;
    try {
      const r = await fetch('/api/arrangement', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); project = j.project || project; server = j.doc; }
    } catch (e) { /* older extension: IndexedDB only */ }
    if (!project) { try { project = (await getJson('/api/transport')).project || null; } catch (e) { /* none */ } }
    if (!project) return;
    let local = null;
    try { local = await idb.get('mirror:' + project); } catch (e) { /* no IndexedDB */ }
    const doc = M.pickDoc([server, local], project);
    mirror.project = project;
    // Not over a read made meanwhile, an opened export, or another project's score.
    if (!doc || busy || S.crawl || (S.base && S.base.source !== 'crawl') || (S.liveData && S.liveData.project && S.liveData.project !== project)) return;
    if (!M.tracksAgree(doc, S.liveData && S.liveData.tracks)) { status('A stored read of "' + project + '" has other tracks: not restored'); return; }
    install(doc.crawl, { readAt: doc.readAt, tracksAtRead: doc.tracksAtRead, project, restored: true });
    status(`Restored the read from ${new Date(doc.readAt).toLocaleString()} · ${S.base.parts.length} parts`);
    if (doc !== server) schedulePersist(); // the extension did not have it (restarted, or older than IndexedDB's copy)
  }
  // Once on the first update from Bitwig, then whenever another project opens (core/net.js has dropped the score).
  function maybeRestore(d) {
    const key = (d && d.project) || '';
    if (mirror.restoredFor === key) return;
    const first = mirror.restoredFor === undefined;
    mirror.restoredFor = key;
    if (!first) { mirror.project = null; mirror.memo = null; mirror.unsure.clear(); }
    restore();
  }

  // ---- harvest: the selected clip, once settled, goes into the mirror
  function scheduleHarvest(d) {
    clearTimeout(mirror.harvestTimer);
    if (!usable() || !d || !d.exists || d.source !== 'arranger') return;
    if (d.settled === true) { harvest(d); return; } // the extension vouches for the data (perf/sync-settled)
    mirror.harvestTimer = setTimeout(() => harvest(d), HARVEST_QUIET_MS);
  }
  async function harvest(d) {
    const S = SV.state;
    const still = () => d === S.liveData && usable() && !busy && !S.playing;
    if (!still()) return;
    let t, nav = null;
    try {
      // Settled data with selPlayStart (perf/sync-settled) already holds the play start marker of this very snapshot:
      // no /api/transport round trip, and no mid-switch check (the extension waited out the switch).
      const vouched = d.settled === true && d.selPlayStart != null;
      [t, nav] = await Promise.all([vouched ? { playStart: d.selPlayStart, playing: !!S.playing } : getJson('/api/transport'),
                                    getJson('/api/nav').catch(() => null)]);
      if (d.settled !== true && d.selPlayStart == null) { // Bitwig moves the marker a moment after the notes: look twice
        await sleep(CONFIRM_MS);
        if (!still()) return;
        if (!near((await getJson('/api/transport')).playStart, t.playStart)) return; // still moving: a later update harvests
      }
    } catch (e) { return; }
    if (!still() || t.playing) return;
    if (t.clip && (t.clip.exists === false || t.clip.track !== d.track || !near(t.clip.length, d.length))) return; // mid-switch
    const crawl = S.crawl;
    const r = M.placeSelected(mirror.memo, {
      track: d.track, sig: noteSig(d.notes), key: clipKey(d), notes: d.notes, ps: d.selPlayStart != null ? d.selPlayStart : t.playStart,
      edited: (S.lastEditMs || 0) > mirror.placedAt, stepsPerBeat: d.stepsPerBeat,
      nav, clipAt: (track, beat) => crawl.result.find(c => c.track === track && near(c.start, beat)) || null,
      clipsOf: track => crawl.fresh ? null : crawl.result.filter(c => c.track === track),
    });
    mirror.memo = r.memo;
    mirror.placedAt = Date.now();
    if (r.skip) {
      if (r.unsure && !mirror.unsure.has(d.track)) { mirror.unsure.add(d.track); observe(S.liveData); }
      return;
    }
    if (mirror.unsure.delete(d.track)) observe(S.liveData);
    const old = crawl.result.find(c => c.track === d.track && near(c.start, r.start));
    const up = M.upsertClip(crawl, M.clipFromLive(d, r.start));
    mirror.confirmed.add(up.clip.track + '@' + up.clip.start);
    if (up.action === 'none') return;
    // Nothing visible changes when the live clip is already drawn there over a clip of the same span: no re-render.
    const placed = S.align && S.align.track === d.track && near(S.align.offset, r.start);
    const invisible = placed && !up.suspects.length && (!old || near(M.span(old), M.span(up.clip)));
    applyMirror(up.crawl, [d.track], { place: { track: d.track, start: r.start }, render: S.mode === 'score' && !invisible,
                                       drop: [{ track: d.track, start: r.start }] });
    if (up.action === 'add' || up.suspects.length)
      status(`${d.track}: clip at bar ${barOf(r.start)} taken into the score` + (up.suspects.length ? ` (${up.suspects.length} clip${up.suspects.length > 1 ? 's' : ''} may have moved)` : ''));
  }

  // ---- auto-refresh (optional): stale tracks are re-read once playback stopped and Bitwig has been quiet a while
  function autoTick() {
    const S = SV.state;
    if (failing.fix === 'stop') retryWhenFixed(S.liveData); // stopping playback changes no clip data
    if (S.playing) { mirror.wasPlaying = true; mirror.stoppedAt = 0; return; }
    if (mirror.wasPlaying) { mirror.wasPlaying = false; mirror.stoppedAt = Date.now(); }
    if (!prefs.autoRefresh || !mirror.stoppedAt || busy || !usable()) return;
    const quiet = Date.now() - Math.max(mirror.stoppedAt, S.liveChangedAt || 0);
    const list = watch.info.refresh;
    if (quiet < AUTO_QUIET_MS || !list.length) return;
    mirror.stoppedAt = 0; // once per stop
    if (mirror.autoTried === list.join('\n')) return; // the same tracks failed or came back stale: wait for the user
    mirror.autoTried = list.join('\n');
    refreshTracks(list, { auto: true });
  }
  setInterval(autoTick, 500);

  // ---- listen while playing: what Bitwig plays, compared with the read (GET /api/listen; arrangement-listen.js)
  const LISTEN_POLL_MS = 250;
  const hear = { seq: -1, busy: false, off: false, base: null, expected: null };
  // Every track of the read with its engraved onsets (cached per base: a harvest or re-read installs a new one).
  function expectedNow() {
    const S = SV.state;
    if (hear.base !== S.base) {
      hear.base = S.base;
      hear.expected = new Map((S.crawl.tracks || []).filter(t => !t.group).map(t => [t.name, []]));
      S.base.parts.forEach(p => hear.expected.set(p.name, L.expectedOnsets(p.notes)));
    }
    return hear.expected;
  }
  // Tracks that say nothing about their clips now: the live clip's (harvested when it settles), edited ones, groups,
  // muted ones and, while anything is soloed, the others.
  function skipNow() {
    const S = SV.state, d = S.liveData || {}, skip = new Set(S.editedTracks);
    if (d.exists && d.track) skip.add(d.track);
    const ts = d.tracks || [], solo = ts.some(t => t.solo);
    ts.forEach(t => { if (t.group || t.mute || (solo && !t.solo)) skip.add(t.name); });
    return skip;
  }
  async function listenTick() {
    const S = SV.state;
    const on = prefs.listen && !hear.off && usable() && S.view === 'score' && !busy;
    if (!on) { if (listener.running()) listener.feed({ playing: false }, null); return; }
    // Stopped: look once a second, so "since" is current when playback starts (its first notes count).
    const idle = !S.playing && !listener.running();
    if (hear.busy || (idle && Date.now() - (hear.idleAt || 0) < 1000)) return;
    if (idle) hear.idleAt = Date.now();
    hear.busy = true;
    try {
      const r = await fetch('/api/listen?since=' + hear.seq, { cache: 'no-store' });
      if (r.status === 404) { hear.off = true; return; } // an extension without the endpoint
      if (!r.ok) return;
      const resp = await r.json();
      const first = hear.seq < 0;
      hear.seq = resp.seq;
      if (first || !usable()) return; // the first answer only says where "now" is
      const ts = (S.base && S.base.timeSig) || { num: 4, den: 4 };
      const changed = listener.feed(resp, { expected: expectedNow(), barBeats: ts.num * 4 / ts.den, skip: skipNow() });
      if (changed.length) observe(S.liveData);
    } catch (e) { /* not connected: the next tick tries again */ } finally { hear.busy = false; }
  }
  setInterval(listenTick, LISTEN_POLL_MS);

  SV.hooks.liveData.push(d => {
    retryWhenFixed(d);
    followFreshTracks(d);
    observe(d);
    maybeRestore(d);
    scheduleHarvest(d);
  });

  // ---- reads
  async function runCrawl(op, accept) {
    SV.send([op]); // looping clips are measured by the extension (Loop Selection, undone at once)
    let st = null;
    for (let i = 0; i < 1200; i++) { // up to ~6 minutes
      await sleep(300);
      st = await getJson('/api/crawl');
      if (st.state === 'running') status(st.message);
      else if ((i > 2 || st.state !== 'idle') && accept(st)) break;
    }
    return st;
  }
  function setBusy(on) {
    busy = on;
    $('svarRead').disabled = on;
    $('svarCancel').classList.toggle('hidden', !on);
    if (!pop.hidden) fillPop();
  }

  async function read() {
    if (busy) return;
    closeFail();
    setBusy(true);
    try {
      status('Starting… (Bitwig\'s selection will move while it reads)');
      const st = await runCrawl('crawl', s => s.state !== 'done' || !s.subset);
      if (!st || st.state !== 'done') { failed(st, read); return; }
      const d = SV.state.liveData || {};
      let project = d.project || null;
      try { project = (await getJson('/api/transport')).project || project; } catch (e) { /* keep */ }
      const score = install(st, { readAt: Date.now(), tracksAtRead: d.tracks, project });
      schedulePersist();
      status(`${st.message} · ${score.parts.length} parts`);
    } catch (e) {
      failed({ message: e.message }, read);
    } finally {
      setBusy(false);
    }
  }

  /**
   * A project just made with New (features/wizard.js): stored like a read, with no clips and every instrument track an
   * empty staff, so F5 or reopening the project restores it without a Read. fresh = { title, timeSig, lengthBeats,
   * markers }. Returns the installed score, or null while a read runs, before Bitwig reported its tracks, or when the
   * project already has a read with clips (New added tracks to an existing project: that read is not replaced).
   */
  function adoptNew({ title, timeSig, lengthBeats, markers } = {}) {
    const S = SV.state, d = S.liveData || {};
    if (busy || !d.tracks || (S.crawl && S.crawl.result && S.crawl.result.length)) return null;
    closeFail();
    const crawl = M.freshCrawl(d.tracks, { timeSig, lengthBeats, markers: markers || [] }, d.stepsPerBeat || 24);
    const score = install(crawl, { readAt: Date.now(), tracksAtRead: d.tracks, title, project: d.project || null });
    schedulePersist();
    status('New score · ' + score.parts.length + ' staves');
    return score;
  }
  // In a project made with New, tracks added, renamed or removed in Bitwig become staves at once (no read needed).
  function followFreshTracks(d) {
    const S = SV.state;
    if (busy || !d || !d.tracks || !S.crawl || !S.crawl.fresh || !usable()) return;
    const sig = ts => ts.map(t => t.name + (t.group ? '/g' : '') + '|' + (t.type || '')).join('\n');
    if (sig(d.tracks) === sig(S.crawl.tracks || [])) return;
    watch.tracksAtRead = d.tracks.map(t => ({ name: t.name }));
    applyMirror(M.syncTracks(S.crawl, d.tracks), d.tracks.map(t => t.name));
  }

  /** Reads only these tracks again and merges them into the mirror; with no names, only takes in the track list. */
  async function refreshTracks(names, { auto = false } = {}) {
    const S = SV.state;
    if (busy || !usable()) return;
    const d = S.liveData || {};
    const gone = watch.info.gone.slice();
    if (!names.length) {
      if (d.tracks) applyMirror(M.syncTracks(S.crawl, d.tracks), gone);
      watch.tracksAtRead = d.tracks ? d.tracks.map(t => ({ name: t.name })) : watch.tracksAtRead;
      observe(S.liveData);
      return;
    }
    setBusy(true);
    try {
      status((auto ? 'Refreshing by itself: ' : 'Refreshing ') + names.join(', ') + '… (Bitwig\'s selection moves while it reads)');
      const want = JSON.stringify(names);
      const st = await runCrawl('crawl tracks ' + names.map(encodeURIComponent).join(' '), s => s.state !== 'done' || JSON.stringify(s.subset) === want);
      if (!st || st.state !== 'done' || JSON.stringify(st.subset) !== want) {
        if (auto) status(st && st.message ? st.message : 'The tracks could not be read.');
        else failed(st, () => refreshTracks(names));
        return;
      }
      const m = M.mergeSubset(S.crawl, st);
      const now = SV.state.liveData || d;
      const crawl = now.tracks ? M.syncTracks(m.crawl, now.tracks) : m.crawl;
      if (st.complete) {
        if (now.tracks) watch.tracksAtRead = now.tracks.map(t => ({ name: t.name }));
        names.forEach(n => { watch.seen.delete(n); mirror.unsure.delete(n); });
      } else m.tracks.forEach(n => { watch.seen.delete(n); mirror.unsure.delete(n); });
      mirror.memo = null;
      applyMirror(crawl, m.tracks.concat(gone));
      status(st.message);
    } catch (e) {
      status('Refresh failed: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  $('svarRead').addEventListener('click', read);
  $('svarCancel').addEventListener('click', () => SV.send(['crawlCancel']));
  SV.arrangement = { ...pure, read, refreshTracks, adoptNew, prefs,
    /** Why the last read may be out of date ([] = current, or no read). */
    staleReasons: () => watch.info.reasons.slice(),
    /** The tracks a targeted re-read would fix (the popover's Refresh N tracks). */
    staleTracks: () => watch.info.refresh.slice(),
    /** The crawled clip the selected clip is ({clip, exact} | null), from the last read. */
    liveClip: () => (SV.state.crawl && SV.state.liveData && SV.state.liveData.exists ? pure.matchClip(SV.state.crawl, SV.state.liveData) : null),
    /** Mirror state for tests and the status: { project, readAt, restoredAt (0 = read in this page), unsure: [tracks] }. */
    mirrorInfo: () => ({ project: mirror.project, readAt: mirror.readAt, restoredAt: mirror.restoredAt, unsure: [...mirror.unsure] }),
    /**
     * The clips of the read (crawl clips) that may be out of date because the read was restored from storage and they
     * have not been seen in Bitwig since (selected and harvested, or re-read). [] for a read made in this page.
     */
    unconfirmed: clips => (mirror.restoredAt ? clips.filter(c => c && !(c.seenAt >= mirror.restoredAt) &&
      !mirror.confirmed.has(c.track + '@' + c.start)) : []),
    /** Listening state: { on, pass, running, tracks: { name: { baseline, ignored, flagged, bad:[bars] } } }. */
    listenInfo: () => ({ on: prefs.listen && !hear.off, ...listener.info() }),
  };
})(this);
