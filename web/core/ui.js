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

  function setMode(m) {
    state.mode = m;
    store.set('mode', m);
    markSeg('modeSeg', 'mode', m);
    document.querySelectorAll('.scoreOnly').forEach(el => el.classList.toggle('hidden', m !== 'score'));
    state.selection.clear();
    state.playBeat = -1;
    C.requestRender();
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
  $('rangeSeg').addEventListener('click', e => {
    const r = e.target.dataset.range;
    if (!r) return;
    state.range = r;
    store.set('range', r);
    markSeg('rangeSeg', 'range', r);
    C.requestRender();
  });
  ['keySel', 'gridSel', 'condense', 'hideKs', 'simplify'].forEach(id => $(id).addEventListener('change', () => C.requestRender()));
  let zoomTimer;
  $('zoom').addEventListener('input', () => { clearTimeout(zoomTimer); zoomTimer = setTimeout(C.requestRender, 120); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (Math.abs($('main').clientWidth - C.lastW) > 30) { C.lastW = $('main').clientWidth; C.requestRender(); } }, 200);
  });

  $('openBtn').addEventListener('click', () => C.openBase());
  $('freshBtn').addEventListener('click', () => C.freshScoreFromTracks());
  $('reconnectBtn').addEventListener('click', async () => {
    const h = state.baseHandle;
    if (h && await h.requestPermission({ mode: 'read' }) === 'granted') C.loadBaseFile(await h.getFile());
  });
  $('fileInput').addEventListener('change', e => { if (e.target.files[0]) { state.baseHandle = null; C.loadBaseFile(e.target.files[0]); } });
  let dragDepth = 0;
  document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (item && item.getAsFileSystemHandle) {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === 'file') { state.baseHandle = h; C.idb.set('base', h); C.loadBaseFile(await h.getFile()); return; }
    }
    if (e.dataTransfer.files[0]) { state.baseHandle = null; C.loadBaseFile(e.dataTransfer.files[0]); }
  });

  Object.assign(C, { flash, markSeg, setMode, lastW: 0 });
})();
