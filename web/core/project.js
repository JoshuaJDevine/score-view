// Score View page core: the base layer of Score mode (a Read of the project, features/arrangement.js; a DAWproject file
// only in the test suites), fresh scores from the project's tracks and new scores from the New Score wizard.
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, store } = C;

  // Earlier versions remembered an opened DAWproject export here; nothing reads it any more.
  try { indexedDB.deleteDatabase('scoreview'); } catch (e) { /* private mode */ }

  // Installs a parsed score ({title, timeSig, parts, lengthBeats, markers}) as the base layer for Score mode.
  function setBase(score, mtime, project) {
    state.base = score;
    state.editedTracks.clear(); // the new base already contains earlier edits
    state.baseMtime = mtime || 0;
    state.baseProject = project !== undefined ? project : (state.liveData && state.liveData.project) || null;
    state.overlays.clear(); // the new base already contains earlier edits
    state.align = null;
    // A Read keeps the view (in Clip view it fills in the pinned tracks); a new score or a loaded file goes to Score view.
    if (score.source !== 'crawl' && state.view !== 'score') C.setMode('score'); else C.applyView();
    C.renderTrackList();
    C.render();
  }

  /**
   * Swaps in an updated version of the same base (features/arrangement.js: a clip harvested from Bitwig, re-read tracks)
   * without setBase's resets: the read's age, the edited tracks and the view stay. opts: { drop: [{track, start?}]
   * (remembered snapshots of edited clips the new base already holds; no start = the whole track), place: {track, start}
   * (where the selected clip is, exactly: the placement stops guessing), render (default true; false when nothing
   * visible changed) }.
   */
  function updateBase(score, { drop = [], place = null, render = true } = {}) {
    state.base = score;
    state.overlays.forEach((o, k) => {
      if (drop.some(x => x.track === o.track && (x.start == null || Math.abs(x.start - o.offset) < 1e-6))) state.overlays.delete(k);
    });
    const d = state.liveData;
    if (place && d && d.exists && d.track === place.track && !(state.align && state.align.how === 'playhead' && state.playing))
      state.align = { track: d.track, key: C.clipKey(d), offset: place.start, how: 'mirror', cands: (state.align && state.align.cands) || [] };
    C.renderTrackList();
    if (render) C.requestRender(); else C.updateStatus();
  }

  /** Clears everything tied to the previous project's score (base layer, crawl, pins). */
  function forgetScore() {
    state.base = null;
    state.baseProject = null;
    state.crawl = null;
    state.overlays.clear();
    state.align = null;
  }

  function dropProjectScore(project) {
    forgetScore();
    C.flash('Project changed to "' + project + '" — showing its clips; ⟳ Read project for the full score');
    C.renderTrackList();
    C.requestRender();
  }

  /**
   * Starts a fresh, empty score for a new ensemble (New Score wizard): every part as an empty staff, nothing
   * from the previous project. score = { title, timeSig, parts:[{name, group}], lengthBeats?, markers? }.
   */
  function newScore(score) {
    forgetScore();
    state.scoreShow = 'all';
    store.set('scoreShow', 'all');
    const ts = score.timeSig || { num: 4, den: 4 };
    setBase({
      title: score.title || 'New score', timeSig: ts, fresh: true, source: 'new',
      lengthBeats: score.lengthBeats || 8 * ts.num * 4 / ts.den, markers: score.markers || [],
      parts: (score.parts || []).map(p => ({ name: p.name, group: p.group || undefined, notes: [] })),
    }, Date.now(), (state.liveData && state.liveData.project) || null);
  }

  /** Fresh empty score from the project's current instrument tracks (groups kept), e.g. a project made by hand. */
  function freshScoreFromTracks() {
    const d = state.liveData;
    if (!d || !d.tracks) return;
    const parts = [];
    let group = null;
    d.tracks.forEach(t => {
      if (t.group) { group = t.name; return; }
      if (/effect|master/i.test(t.type || '') || /^master$/i.test(t.name)) { group = null; return; }
      if (t.type && !/instrument|hybrid/i.test(t.type)) return; // audio tracks have no notation
      parts.push({ name: t.name, group: group || undefined });
    });
    newScore({ title: d.project || 'New score', timeSig: { num: d.num || 4, den: d.den || 4 }, parts });
    C.flash('Fresh score: ' + parts.length + ' staves from the instrument tracks in this project');
  }

  /** A DAWproject file as the base (the test suites' fixtures, through the hidden #fileInput). */
  async function loadBaseFile(file) {
    try {
      setBase(DawProject.parseDawProjectFile(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, '')), file.lastModified);
    } catch (err) {
      $('title').textContent = 'Could not read ' + file.name + ': ' + err.message;
    }
  }

  Object.assign(C, { setBase, updateBase, forgetScore, dropProjectScore, newScore, freshScoreFromTracks, loadBaseFile });
})();
