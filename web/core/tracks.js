// Score View page core: pins and the Pin toggle. Pinned tracks stay in Clip view next to the selected clip, and in
// Score view when it shows "Pinned only" (state.scoreShow). The list itself lives in Instruments ▾
// (features/instruments.js), which calls setPinned / setScoreShow.
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, store } = C;

  /** The Pin toggle: lit when the selected clip's track is pinned. (Name kept: modules call SV.renderTrackList.) */
  function renderTrackList() {
    const cur = C.currentTrack(), on = !!cur && state.pinned.has(cur);
    const btn = $('pinBtn');
    btn.classList.toggle('on', on);
    btn.disabled = !cur;
    btn.textContent = on ? '📌 Pinned' : '📌 Pin';
    btn.title = cur ? (on ? `Unpin ${cur} (P)` : `Pin ${cur}: it stays in Clip view next to whatever clip you select (P)`) : 'Select a clip in Bitwig to pin its track';
  }

  /** Pins or unpins a track, then re-applies the view (Clip view grows to the pinned tracks). */
  function setPinned(name, on) {
    if (!name) return;
    if (on) state.pinned.add(name); else state.pinned.delete(name);
    store.set('pinned', [...state.pinned]);
    renderTrackList();
    C.applyView();
  }
  function clearPins() {
    state.pinned.clear();
    store.set('pinned', []);
    renderTrackList();
    C.applyView();
  }
  /** Score view shows 'all' instruments (default) or only the 'pinned' ones (+ the selected clip's track). */
  function setScoreShow(v) {
    state.scoreShow = v === 'pinned' ? 'pinned' : 'all';
    store.set('scoreShow', state.scoreShow);
    C.applyView();
  }

  $('pinBtn').addEventListener('click', e => { C.togglePin(C.currentTrack()); e.currentTarget.blur(); });

  Object.assign(C, { renderTrackList, setPinned, clearPins, setScoreShow });
})();
