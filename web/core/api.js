// Score View page core: the public API for feature modules (window.SV, documented in docs/AGENTS.md).
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, hooks } = C;
  let toolbarSeq = 0;

  Object.assign(window.SV, {
    state, hooks,
    render: C.render,               // engraves now; SV.state.render is current when it returns
    requestRender: C.requestRender, // engraves once before the next frame, however often it is called
    send: C.send, flash: C.flash, hitTest: C.hitTest, liveNotes: C.liveNotes, currentTrack: C.currentTrack,
    togglePin: C.togglePin, renderTrackList: C.renderTrackList, cycleAlign: C.cycleAlign, setBase: C.setBase,
    newScore: C.newScore, forgetScore: C.forgetScore, freshScoreFromTracks: C.freshScoreFromTracks, contentOrigin: C.contentOrigin,
    isLive: C.isLive, parseId: C.parseId, liveId: C.liveId, paintSelection: C.paintSelection,
    noteAt: C.noteAt, clickPaper: C.clickPaper, moveSelection: C.moveSelection, gridBeats: C.gridBeats,
    geom: C.geom,                   // .rect(el) / .rects(els) / .invalidate(): #paper boxes cached per render
    expectIds(ids) { ids.forEach(id => C.pendingIds.add(id)); }, // keep these selected until Bitwig reports them
    // Adds a control (element or HTML string) to the feature toolbar row; returns the element.
    // opts: { cluster: 'score'|'write'|'play'|'file'|'view'|'more', order } says where features/layout.js puts it (lower
    // order first; items without an order follow in call order). Without opts layout.js guesses from the ids.
    addToolbar(el, opts) {
      if (typeof el === 'string') { const d = document.createElement('div'); d.className = 'group'; d.innerHTML = el; el = d; }
      el.dataset.svSeq = String(toolbarSeq++);
      if (opts && opts.cluster) el.dataset.svCluster = opts.cluster;
      if (opts && Number.isFinite(opts.order)) el.dataset.svOrder = String(opts.order);
      $('featureBar').appendChild(el);
      $('featureBar').classList.remove('hidden');
      return el;
    },
    // Adds a line of shortcut help to the footer.
    addHelp(html) { const s = document.createElement('div'); s.innerHTML = html; $('help').appendChild(s); },
    addStyle(css) { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); },
  });

  // The score model render() would engrave (transformScore hooks applied), without engraving it. `overrides`
  // temporarily changes state for the call, e.g. { range: 'all', trackMode: 'all' } (features/print.js).
  window.SV.scoreModel = function scoreModel(overrides) {
    // A pending requestRender runs now, under the real state: a transformScore hook reading SV.state.render below
    // (entry.js) would otherwise engrave the page with the overrides.
    C.flushRender();
    const prev = {};
    Object.keys(overrides || {}).forEach(k => { prev[k] = state[k]; state[k] = overrides[k]; });
    try {
      return C.transformedScore();
    } finally { Object.assign(state, prev); }
  };
})();
