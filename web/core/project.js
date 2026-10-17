// Score View page core: the DAWproject base layer of Score mode (a watched export file, remembered in IndexedDB),
// fresh scores from the project's tracks and new scores from the New Score wizard.
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, store } = C;

  const idb = {
    open: () => new Promise((res, rej) => {
      const r = indexedDB.open('scoreview', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }),
    async get(k) { const db = await this.open(); return new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); },
    async set(k, v) { const db = await this.open(); return new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); },
  };

  // Installs a parsed score ({title, timeSig, parts, lengthBeats, markers}) as the base layer for Score mode.
  function setBase(score, mtime, project) {
    state.base = score;
    state.editedTracks.clear(); // the new base already contains earlier edits
    state.baseMtime = mtime || 0;
    state.baseProject = project !== undefined ? project : (state.liveData && state.liveData.project) || null;
    state.overlays.clear(); // the new base already contains earlier edits
    state.align = null;
    if (state.mode !== 'score') C.setMode('score');
    $('reconnectBtn').classList.add('hidden');
    C.renderTrackList();
    C.render();
  }

  /** Clears everything tied to the previous project's score (base layer, crawl, pins, remembered export). */
  function forgetScore() {
    state.base = null;
    state.baseProject = null;
    state.baseHandle = null;
    state.crawl = null;
    state.overlays.clear();
    state.align = null;
    idb.set('base', null);
    idb.set('baseProject', null);
    $('reconnectBtn').classList.add('hidden');
  }

  function dropProjectScore(project) {
    forgetScore();
    C.flash('Project changed to "' + project + '" — showing its clips; ⟳ Read arrangement for the full score');
    C.renderTrackList();
    C.requestRender();
  }

  /**
   * Starts a fresh, empty score for a new ensemble (New Score wizard): every part as an empty staff, nothing
   * from the previous project. score = { title, timeSig, parts:[{name, group}], lengthBeats?, markers? }.
   */
  function newScore(score) {
    forgetScore();
    state.trackMode = 'all';
    store.set('trackMode2', 'all');
    state.range = 'all';
    store.set('range', 'all');
    C.markSeg('rangeSeg', 'range', 'all');
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

  async function loadBaseFile(file) {
    try {
      setBase(DawProject.parseDawProjectFile(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, '')), file.lastModified, state.restoringProject);
      state.restoringProject = undefined;
      if (state.baseHandle) idb.set('baseProject', state.baseProject);
    } catch (err) {
      $('title').textContent = 'Could not read ' + file.name + ': ' + err.message;
    }
  }

  async function openBase() {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'DAWproject', accept: { 'application/zip': ['.dawproject'] } }] });
        state.baseHandle = h;
        idb.set('base', h);
        loadBaseFile(await h.getFile());
      } catch (e) { /* cancelled */ }
    } else $('fileInput').click();
  }

  async function restoreBase() {
    if (!window.showOpenFilePicker) return;
    const h = await idb.get('base').catch(() => null);
    if (!h) return;
    state.baseHandle = h;
    state.restoringProject = (await idb.get('baseProject').catch(() => null)) || null; // the project this export belongs to
    if (!state.restoringProject) { state.baseHandle = null; idb.set('base', null); return; } // unknown project: don't guess
    if (await h.queryPermission({ mode: 'read' }) === 'granted') loadBaseFile(await h.getFile());
    else { $('reconnectBtn').textContent = 'Reload ' + h.name; $('reconnectBtn').classList.remove('hidden'); }
  }

  async function watchBase() {
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const h = state.baseHandle;
      if (!h || !state.base) continue;
      try {
        const f = await h.getFile();
        if (f.lastModified !== state.baseMtime) loadBaseFile(f);
      } catch (e) { /* file busy while Bitwig writes it; retry */ }
    }
  }

  Object.assign(C, { idb, setBase, forgetScore, dropProjectScore, newScore, freshScoreFromTracks, loadBaseFile, openBase, restoreBase, watchBase });
})();
