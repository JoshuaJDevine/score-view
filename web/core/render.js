// Score View page core: the render pipeline (score model -> buildMEI -> Verovio -> SVG), the status line, selection
// and playhead painting, and SV.geom (hit-test boxes cached per render).
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, SB, state, hooks, runHooks, live } = C;

  // ------------------------------------------------------------------ render / requestRender
  // render() engraves synchronously (SV.render; feature modules rely on SV.state.render being current right after
  // it). requestRender() coalesces: any number of requests before the next animation frame give one render.
  // A hidden page gets no animation frames, so a timer stands in. Reading SV.state.render while a request is
  // pending renders at once, so a reader never sees a stale render.
  let pending = false, raf = 0, timer = 0, rendering = 0, current = null;

  function cancelRequest() {
    if (!pending) return;
    pending = false;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  }
  function flushRender() { if (pending) render(); }
  function requestRender() {
    if (pending) return;
    pending = true;
    raf = requestAnimationFrame(flushRender);
    timer = setTimeout(flushRender, 100);
  }
  Object.defineProperty(state, 'render', {
    configurable: true, enumerable: true,
    get() { if (pending && !rendering) flushRender(); return current; },
    set(v) { current = v; },
  });

  function render() {
    cancelRequest();
    if (!C.tk) return;
    rendering++;
    try { renderNow(C.tk); } finally { rendering--; }
  }

  function renderNow(tk) {
    const paper = $('paper'), main = $('main');
    const score = C.transformedScore();
    updateStatus();
    if (!score) {
      state.render = null;
      const d = state.liveData;
      paper.innerHTML = '<div id="empty">' + (
          !live && state.mode === 'clip' ? 'Open this page from Bitwig at <b>http://' + C.escapeHtml(C.serverHost()) + '</b> for live mode.'
        : live && !state.connected ? 'Waiting for Bitwig… (is the <b>Score View</b> controller enabled?)'
        : state.mode === 'score' && !state.base ? 'Open a <b>.dawproject</b> export (Bitwig: <i>File → Export → DAWproject…</i>) to see all tracks.<br>Re-exporting to the same file reloads it automatically.'
        : !(d && d.exists) ? 'Select a clip in Bitwig' + (state.source === 'arranger' ? ' (click a clip in the Arranger).' : ' (select a launcher clip).')
        : 'Nothing to show for the selected tracks.') + '</div>';
      geom.invalidate();
      return;
    }
    const t0 = performance.now();
    const buildOpts = { grid: parseInt($('gridSel').value, 10), simplify: $('simplify').checked };
    const scale = parseInt($('zoom').value, 10);
    const width = Math.max(600, main.clientWidth - 52); // paper margins + room for a scrollbar
    const vrvOpts = {
      scale, pageWidth: Math.round(width * 100 / scale), pageHeight: 60000, adjustPageHeight: true,
      breaks: state.layout === 'line' ? 'none' : 'auto', pageMarginLeft: 60, pageMarginRight: 40, pageMarginTop: 40,
      // A fresh (empty) score shows every staff; otherwise empty staves may be hidden.
      header: 'none', footer: 'none', condense: $('condense').checked && !(state.base && state.base.fresh) ? 'auto' : 'none', condenseFirstPage: true,
      justifyVertically: false, spacingSystem: 14, mnumInterval: 1,
    };
    hooks.buildOptions.forEach(fn => { try { fn(buildOpts, vrvOpts, score); } catch (err) { console.error('buildOptions', err); } });
    const built = SB.buildMEI(score, buildOpts);
    tk.setOptions(vrvOpts);
    if (!tk.loadData(built.mei)) { paper.innerHTML = '<div id="empty">Render failed: ' + tk.getLog() + '</div>'; geom.invalidate(); return; }
    const sx = main.scrollLeft, sy = main.scrollTop;
    let svg = '';
    for (let p = 1; p <= tk.getPageCount(); p++) svg += tk.renderToSVG(p);
    paper.innerHTML = svg;
    geom.invalidate();
    main.scrollLeft = sx; main.scrollTop = sy;

    const bySrc = new Map(), bySvg = new Map();
    built.timeline.forEach(t => {
      bySvg.set(t.svgId, t);
      if (!bySrc.has(t.srcId)) bySrc.set(t.srcId, []);
      bySrc.get(t.srcId).push(t);
    });
    state.render = { ...built, bySrc, bySvg, score };
    if ($('keySel').value === 'auto') $('keySel').options[0].textContent = 'Auto (' + C.keyName(built.keyFifths) + ')';
    paintSelection();
    paintPlayhead(true);
    $('renderTime').textContent = Math.round(performance.now() - t0) + ' ms';
    runHooks('afterRender', state.render);
  }

  // ------------------------------------------------------------------ status line

  function updateStatus() {
    const d = state.liveData;
    let t, nav = false;
    if (live && !state.connected) t = 'Not connected';
    else if (state.mode === 'clip') t = d && d.exists ? d.track : 'No clip selected';
    else {
      const parts = [];
      if (state.base) parts.push(state.base.title + (state.baseHandle ? ' ⟳' : ''));
      if (d && d.exists) {
        const a = state.align;
        const ts = state.base ? state.base.timeSig : { num: 4, den: 4 };
        let where = '';
        if (a) {
          where = ' @ bar ' + (Math.floor(a.offset / (ts.num * 4 / ts.den)) + 1);
          const list = [...new Set([...(a.cands || []), a.offset])].sort((x, y) => x - y);
          if (list.length > 1) { where += ' (' + (list.indexOf(a.offset) + 1) + ' of ' + list.length + ')'; nav = true; }
        } else if (state.base && state.base.fresh) where = ' (⟳ Read arrangement or play it to place it in the score)';
        else if (state.base) where = ' (not found in export — play it once or re-export)';
        parts.push('✎ ' + d.track + where);
      }
      t = parts.join(' · ') || '—';
    }
    $('title').textContent = t;
    alignNav().classList.toggle('hidden', !nav);
  }

  let alignNavEl = null;
  function alignNav() {
    if (alignNavEl) return alignNavEl;
    alignNavEl = document.createElement('span');
    alignNavEl.id = 'alignNav';
    alignNavEl.innerHTML = '<button class="btn" data-dir="-1" title="Previous place where this clip fits">◀</button>' +
      '<button class="btn" data-dir="1" title="Next place where this clip fits">▶</button>';
    alignNavEl.style.cssText = 'display:inline-flex;gap:2px';
    [...alignNavEl.children].forEach(b => { b.style.padding = '0 6px'; });
    alignNavEl.addEventListener('click', e => { const dir = Number(e.target.dataset.dir); if (dir) C.cycleAlign(dir); });
    $('title').after(alignNavEl);
    return alignNavEl;
  }

  // ------------------------------------------------------------------ selection and playhead paint

  function setClass(svgIds, cls, on) {
    svgIds.forEach(id => { const el = document.getElementById(id); if (el) el.classList.toggle(cls, on); });
  }

  function paintSelection() {
    document.querySelectorAll('#paper .sel').forEach(el => el.classList.remove('sel'));
    if (!state.render) return;
    state.selection.forEach(src => (state.render.bySrc.get(src) || []).forEach(t => setClass([t.svgId], 'sel', true)));
  }

  let lastPlayIds = [], lastMeasure = -1;
  function paintPlayhead(force) {
    const r = state.render;
    setClass(lastPlayIds, 'play', false);
    lastPlayIds = [];
    if (!r || state.playBeat < 0) return;
    const b = state.playBeat;
    r.timeline.forEach(t => { if (t.start <= b && b < t.end) lastPlayIds.push(t.svgId); });
    setClass(lastPlayIds, 'play', true);
    const m = SB.measureAt(r, b); // meter changes: bars of different lengths
    if ($('follow').checked && state.playing && (m !== lastMeasure || force)) {
      const el = document.getElementById('m' + m);
      if (el) scrollToEl(el);
    }
    lastMeasure = m;
  }

  function scrollToEl(el) {
    const main = $('main'), r = el.getBoundingClientRect(), mr = main.getBoundingClientRect();
    if (state.layout === 'line') {
      if (r.left < mr.left + 40 || r.right > mr.right - 40) main.scrollLeft += r.left - mr.left - mr.width * 0.25;
    } else if (r.top < mr.top || r.bottom > mr.bottom) {
      main.scrollTop += r.top - mr.top - 30;
    }
  }

  // ------------------------------------------------------------------ SV.geom: hit-test boxes cached per render
  // getBoundingClientRect on SVG elements is costly and the hit tests measure every note / staff line per mouse
  // event. Boxes of elements inside #paper are measured once per render relative to the paper, and returned in
  // current viewport coordinates (the paper's own box is measured per call, so scrolling needs no invalidation).
  // The cache drops itself on a new render, on window resize and on any structural or geometric SVG change in
  // #paper (MutationObserver, checked synchronously on every call). Changes made through CSS classes are not
  // seen: call SV.geom.invalidate() after one that moves things.
  const geom = (() => {
    let cache = new Map(), mo = null;
    const invalidate = () => { cache = new Map(); };
    function check() {
      if (!mo) {
        mo = new MutationObserver(invalidate);
        mo.observe($('paper'), { childList: true, subtree: true, attributes: true,
          attributeFilter: ['transform', 'x', 'y', 'width', 'height', 'd', 'points', 'viewBox', 'style', 'font-size', 'display', 'visibility'] });
      } else if (mo.takeRecords().length) invalidate();
    }
    function box(el, o) {
      let c = cache.get(el);
      if (!c) {
        const b = el.getBoundingClientRect();
        c = { l: b.left - o.left, t: b.top - o.top, w: b.width, h: b.height };
        cache.set(el, c);
      }
      const left = c.l + o.left, top = c.t + o.top;
      return { left, top, right: left + c.w, bottom: top + c.h, width: c.w, height: c.h, x: left, y: top };
    }
    return {
      /** Box of one element inside #paper ({left, top, right, bottom, width, height}, viewport coordinates). */
      rect(el) { check(); return box(el, $('paper').getBoundingClientRect()); },
      /** Boxes of several elements (array or NodeList), in the same order. */
      rects(els) { check(); const o = $('paper').getBoundingClientRect(); return Array.from(els, el => box(el, o)); },
      invalidate,
    };
  })();
  window.addEventListener('resize', geom.invalidate);

  Object.assign(C, { render, requestRender, flushRender, updateStatus, paintSelection, paintPlayhead, scrollToEl, geom });
})();
