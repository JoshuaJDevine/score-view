// Score View page core: the UI shell — flash messages, the toolbar controls (mode, source, layout, range, key, grid,
// zoom...), opening a .dawproject (button, file input, drag and drop).
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, store } = C;

  // flash(msg, { kind: 'info'|'ok'|'warn'|'err', ms }?): #flash shows the newest message for flash.ms. features/toasts.js
  // sets flash.ms from a preference and, from the 'sv-flash' event, stacks older messages and keeps a history.
  let flashTimer;
  function flash(msg, opts) {
    const o = opts || {};
    $('flash').textContent = msg;
    $('flash').dataset.kind = o.kind || '';
    $('flash').classList.remove('hidden');
    clearTimeout(flashTimer);
    const ms = o.ms || flash.ms;
    flashTimer = setTimeout(() => $('flash').classList.add('hidden'), ms);
    window.dispatchEvent(new CustomEvent('sv-flash', { detail: { msg: String(msg), kind: o.kind || '', ms } }));
  }
  flash.ms = 2500;

  function markSeg(segId, attr, value) {
    document.querySelectorAll('#' + segId + ' button').forEach(b => b.classList.toggle('on', b.dataset[attr] === value));
  }

  // The two views (state.view, the Clip / Score buttons) drive the engine's mode, range and track choice:
  //   Score view: the whole song, all instruments or only the pinned ones (state.scoreShow) -> mode score, range all.
  //   Clip view: the selected clip; with other tracks pinned, their staves too in the clip's bars -> mode score,
  //   range clip, pinned tracks (needs a Read for their notes); with none, the plain clip -> mode clip.
  function applyView() {
    const cur = C.currentTrack ? C.currentTrack() : null;
    let mode;
    if (state.view === 'score') { mode = 'score'; state.range = 'all'; state.trackMode = state.scoreShow === 'pinned' ? 'pinned' : 'all'; }
    else if ([...state.pinned].some(n => n !== cur)) { mode = 'score'; state.range = 'clip'; state.trackMode = 'pinned'; }
    else mode = 'clip';
    if (mode !== state.mode) { state.mode = mode; state.selection.clear(); state.playBeat = -1; }
    store.set('mode', mode);
    markSeg('modeSeg', 'mode', state.view);
    document.querySelectorAll('.scoreOnly').forEach(el => el.classList.toggle('hidden', state.view !== 'score'));
    if (C.renderTrackList) C.renderTrackList();
    C.requestRender();
  }
  function setMode(v) {
    state.view = v === 'score' ? 'score' : 'clip';
    store.set('view', state.view);
    applyView();
  }

  $('modeSeg').addEventListener('click', e => { if (e.target.dataset.mode) setMode(e.target.dataset.mode); });
  $('srcSeg').addEventListener('click', e => {
    const s = e.target.dataset.src;
    if (!s) return;
    markSeg('srcSeg', 'src', s);
    C.send(['source ' + s]);
  });
  $('layoutSeg').addEventListener('click', e => {
    const l = e.target.dataset.layout;
    if (!l) return;
    state.layout = l;
    markSeg('layoutSeg', 'layout', l);
    C.requestRender();
  });

  ['keySel', 'gridSel', 'condense', 'hideKs', 'simplify', 'interpret'].forEach(id => $(id).addEventListener('change', () => C.requestRender()));
  // Hide unused instruments (saved) and the status bar's All staves override (this session).
  $('hideUnused').checked = store.get('hideUnused', true);
  $('hideUnused').addEventListener('change', () => { store.set('hideUnused', $('hideUnused').checked); C.requestRender(); });
  const allBtn = $('allStaves');
  const paintAll = () => { allBtn.classList.toggle('on', !!state.showAllStaves); allBtn.textContent = state.showAllStaves ? 'All staves ✓' : 'All staves'; };
  allBtn.addEventListener('click', () => { state.showAllStaves = !state.showAllStaves; paintAll(); C.requestRender(); allBtn.blur(); });
  paintAll();
  let zoomTimer;
  $('zoom').addEventListener('input', () => { clearTimeout(zoomTimer); zoomTimer = setTimeout(C.requestRender, 120); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (Math.abs($('main').clientWidth - C.lastW) > 30) { C.lastW = $('main').clientWidth; C.requestRender(); } }, 200);
  });

  $('freshBtn').addEventListener('click', () => C.freshScoreFromTracks());
  // Score View shows the open Bitwig project (⟳ Read project); a DAWproject file is only loaded by the test suites,
  // through the hidden #fileInput.
  $('fileInput').addEventListener('change', e => { if (e.target.files[0]) C.loadBaseFile(e.target.files[0]); });

  Object.assign(C, { flash, markSeg, setMode, applyView, lastW: 0 });
})();
