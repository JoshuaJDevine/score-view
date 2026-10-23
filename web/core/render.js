// Score View page core: the render pipeline (score model -> buildMEI -> Verovio -> SVG), the status line, selection
// and playhead painting, and SV.geom (hit-test boxes cached per render).
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, SB, state, hooks, runHooks, live, store } = C;
  const SC = window.ScoreChunks;

  // ------------------------------------------------------------------ render / requestRender
  // render() (SV.render) builds the score model at once: SV.state.render (timeline, staves, score, mei, …) is current
  // when it returns, as feature modules rely on. The engraving (Verovio -> SVG on the paper) is at once too when it is
  // small or cached; a big one runs in Web Workers (core/engrave.js) while the paper keeps the previous SVG, and
  // state.render.drawn turns true (afterRender hooks run, SV.rendered() resolves) when the new one is on the paper.
  // requestRender() coalesces: any number of requests before the next animation frame give one render.
  // A hidden page gets no animation frames, so a timer stands in. Reading SV.state.render while a request is
  // pending renders at once, so a reader never sees a stale render.
  //
  // Big scores in page layout are engraved in chunks (core/chunks.js): one system each, each its own SVG in a
  // <div class="svc" data-a data-b> on the paper, cached by its MEI, so an edit re-engraves one chunk. Chunks in view
  // come first; the others follow (placeholders until then, nearest first). localStorage scoreview.chunked = false
  // engraves the whole score as one document (as in line layout, and for small scores).
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
    try { renderNow(); } finally { rendering--; }
  }

  // Bars x staves engraved on the main thread at once (~0.7 ms each: ~100 ms); more goes to the workers.
  const SYNC_CELLS = 150;
  // Page layout from this many bars x staves is engraved in chunks.
  const CHUNK_CELLS = 400;

  function renderNow() {
    const paper = $('paper'), main = $('main');
    const score = C.transformedScore();
    updateStatus();
    if (!score) {
      drop();
      state.render = null;
      const d = state.liveData;
      paper.innerHTML = '<div id="empty">' + (
          !live && state.mode === 'clip' ? 'Open this page from Bitwig at <b>http://' + C.escapeHtml(C.serverHost()) + '</b> for live mode.'
        : live && !state.connected ? 'Waiting for Bitwig… (is the <b>Score View</b> controller enabled?)'
        : state.mode === 'score' && !state.base ? 'Click any clip in Bitwig’s Arranger, then <b>⟳ Read project</b> to see every track.'
        : !(d && d.exists) ? 'Select a clip in Bitwig' + (state.source === 'arranger' ? ' (click a clip in the Arranger).' : ' (select a launcher clip).')
        : 'Nothing to show for the selected tracks.') + '</div>';
      geom.invalidate();
      shown = null;
      wake();
      return;
    }
    const t0 = performance.now();
    const buildOpts = { grid: parseInt($('gridSel').value, 10), simplify: $('simplify').checked, interpret: $('interpret').checked };
    const scale = parseInt($('zoom').value, 10);
    const width = Math.max(600, main.clientWidth - 52); // paper margins + room for a scrollbar
    const vrvOpts = {
      scale, pageWidth: Math.round(width * 100 / scale), pageHeight: 60000, adjustPageHeight: true,
      breaks: state.layout === 'line' ? 'none' : 'auto', pageMarginLeft: 60, pageMarginRight: 40, pageMarginTop: 40,
      // A fresh (empty) score shows every staff; otherwise empty staves may be hidden.
      header: 'none', footer: 'none', condense: $('condense').checked && !state.showAllStaves && !(state.base && state.base.fresh) ? 'auto' : 'none', condenseFirstPage: true,
      justifyVertically: false, spacingSystem: 14, mnumInterval: 1,
    };
    hooks.buildOptions.forEach(fn => { try { fn(buildOpts, vrvOpts, score); } catch (err) { console.error('buildOptions', err); } });
    const times = {}, lap = (k, t) => { const n = performance.now(); times[k] = Math.round(n - t); return n; };
    let t1 = performance.now();
    const built = SB.buildMEI(score, buildOpts);
    t1 = lap('buildMEI', t1);

    const bySrc = new Map(), bySvg = new Map();
    built.timeline.forEach(t => {
      bySvg.set(t.svgId, t);
      if (!bySrc.has(t.srcId)) bySrc.set(t.srcId, []);
      bySrc.get(t.srcId).push(t);
    });
    const r = { ...built, bySrc, bySvg, score, times, drawn: false };
    state.render = r;
    if ($('keySel').value === 'auto') $('keySel').options[0].textContent = 'Auto (' + C.keyName(built.keyFifths) + ')';
    const plan = planEngraving(built, vrvOpts);
    lap('plan', t1);
    show(r, plan, t0);
  }

  // ------------------------------------------------------------------ engraving plan
  // [{ key, a, b, mei, opts, inline, cells, hide }]: one item for the whole score, or one per chunk (core/chunks.js).
  let lastPlan = null; // { ctx, ranges }: the previous chunk breaks, kept where they still fit
  const inlineOn = () => !!window.SvgInline && window.SvgInline.enabled();
  function planEngraving(built, vrvOpts) {
    const inline = inlineOn(), staves = built.staves.length, cells = built.measures * staves;
    const optsKey = o => SC.hash(JSON.stringify(o)) + (inline ? 'i' : '');
    if (!SC || vrvOpts.breaks !== 'auto' || cells < CHUNK_CELLS || store.get('chunked', true) === false) {
      return [{ key: SC ? SC.hash(built.mei) + optsKey(vrvOpts) : String(Math.random()), a: 0, b: built.measures - 1, mei: built.mei,
                opts: vrvOpts, inline, cells, single: true }];
    }
    const ctx = JSON.stringify([vrvOpts.pageWidth, vrvOpts.pageMarginLeft, vrvOpts.pageMarginRight, built.chunks.labels]);
    const ranges = SC.plan(built.chunks, { pageWidth: vrvOpts.pageWidth, marginLeft: vrvOpts.pageMarginLeft, marginRight: vrvOpts.pageMarginRight },
      lastPlan, ctx);
    lastPlan = { ctx, ranges };
    const condense = vrvOpts.condense === 'auto';
    return ranges.map((c, i) => {
      const last = i === ranges.length - 1;
      const hide = condense ? SC.hidden(built.chunks, c.a, c.b, i === 0 && !vrvOpts.condenseFirstPage) : null;
      const mei = built.chunks.mei(c.a, c.b, { abbr: i > 0, hide, system: true });
      // One system per chunk ('encoded' + the <sb/> before its first bar), justified like a full system except the
      // score's last one. Chunks after the first are spaced by their top margin: half of spacingSystem in staff spaces
      // (18 page units each) on top of what sticks out of the systems gives the gaps a full render has (13-16 spaces).
      const opts = { ...vrvOpts, breaks: 'encoded', condense: 'none', minLastJustification: last ? 0.8 : 0,
        pageMarginTop: i ? Math.round((vrvOpts.spacingSystem || 14) * 9) : vrvOpts.pageMarginTop, pageMarginBottom: last ? 40 : 0 };
      return { key: SC.hash(mei) + optsKey(opts), a: c.a, b: c.b, mei, opts, inline, hide,
               cells: (c.b - c.a + 1) * (staves - (hide ? hide.size : 0)) };
    });
  }

  // ------------------------------------------------------------------ putting the engraving on the paper
  let shown = null;    // the render whose SVG is on the paper
  let showing = null;  // the render being engraved for the paper (async): { r, plan, t0, need, placed, fill }
  const waiters = [];  // SV.rendered() promises
  const E = () => C.engrave;

  // Small or cached: engraved now. Big: the chunks the viewport needs go first, the paper switches when they are in.
  function show(r, plan, t0) {
    drop();
    const paper = $('paper');
    const onPaper = new Set([...paper.querySelectorAll(':scope > .svc:not(.svc-wait):not(.svc-stale)')].map(n => n.dataset.key));
    const missing = plan.filter(c => !onPaper.has(c.key) && !E().cached(c.key));
    const cost = missing.reduce((s, c) => s + c.cells, 0);
    r.times.chunks = plan.length;
    r.times.engraved = missing.length;
    // (without workers the queue below runs on the main thread, one chunk per task: the page still answers in between)
    if (!missing.length || cost <= SYNC_CELLS) {
      const t = performance.now();
      for (const c of missing) {
        const res = E().now(c);
        if (!res.ok) { failed(res.log); return; }
      }
      r.times.engrave = Math.round(performance.now() - t);
      place(r, plan);
      done(r, t0);
      return;
    }
    const st = { r, plan, t0, need: new Set(), placed: false, fill: new Set() };
    showing = st;
    const win = viewWindow(plan);
    missing.forEach(c => { if (win.has(c.key)) st.need.add(c.key); });
    E().request(order(plan, missing, win), (c, res) => arrived(st, c, res));
    if (!st.need.size && showing === st) { place(r, plan); st.placed = true; afterPlace(st); }
  }

  // Keys of the plan's chunks inside the viewport (+ a margin), from known heights (the paper's, the cache's) or
  // estimates (staves x a staff height learned from engraved chunks).
  function viewWindow(plan) {
    const main = $('main'), paper = $('paper');
    const nodes = new Map(), bars = new Map(); // by key; by bar range (the engraving of the same bars before an edit)
    paper.querySelectorAll(':scope > .svc').forEach(n => { nodes.set(n.dataset.key, n); bars.set(n.dataset.a + ':' + n.dataset.b, n); });
    const top = main.scrollTop - paper.offsetTop - 200, bottom = main.scrollTop - paper.offsetTop + main.clientHeight + 200;
    const keys = new Set();
    let y = 0;
    plan.forEach(c => {
      const h = heightOf(c, nodes.get(c.key) || bars.get(c.a + ':' + c.b));
      if (y + h >= top && y <= bottom) keys.add(c.key);
      y += h + GAP;
    });
    return keys;
  }
  const GAP = 0; // px between chunks (their own margins space them)
  let staffPx = 0; // learned px per shown staff
  function heightOf(c, node) {
    if (node && !node.classList.contains('svc-wait')) return node.offsetHeight;
    const hit = E().cached(c.key);
    if (hit && hit.h) return hit.h;
    const staves = c.single ? 1 : Math.max(1, (c.cells / (c.b - c.a + 1)) || 1);
    return staves * (staffPx || 10 * 18 * (c.opts.scale || 55) / 100) + 40;
  }
  function learn(c, h) {
    if (c.single || !h) return;
    const staves = c.cells / (c.b - c.a + 1);
    if (staves >= 1) staffPx = staffPx ? staffPx * 0.8 + 0.2 * (h / staves) : h / staves;
  }

  // Engraving order: the chunks in view, then outwards from them.
  function order(plan, missing, win) {
    const idx = new Map(plan.map((c, i) => [c.key, i]));
    const inView = plan.map((c, i) => (win.has(c.key) ? i : -1)).filter(i => i >= 0);
    const centre = inView.length ? inView[0] : 0;
    return missing.slice().sort((a, b) => {
      const va = win.has(a.key) ? 0 : 1, vb = win.has(b.key) ? 0 : 1;
      return va - vb || Math.abs(idx.get(a.key) - centre) - Math.abs(idx.get(b.key) - centre);
    });
  }

  function arrived(st, c, res) {
    if (st !== showing) return; // a newer render took over (the result stays cached)
    if (!res.ok) { failed(res.log); return; }
    if (!st.placed) {
      st.need.delete(c.key);
      if (st.need.size) return;
      place(st.r, st.plan);
      st.placed = true;
      afterPlace(st, true);
      return;
    }
    st.fill.add(c.key);
    scheduleFill(st);
  }

  // After the paper switched with chunks still missing: their placeholders fill in batches (one per frame), the
  // afterRender hooks run again at most every FILL_HOOK_MS while chunks near the view stream in (hooks measure the
  // whole paper: a run for chunks nobody sees forces their style and layout, which content-visibility would skip),
  // and once more at the end.
  const FILL_HOOK_MS = 400;
  const nearView = new Set(); // keys of placeholders within the IntersectionObserver's margin of the view
  let fillRaf = 0, fillTimer = 0, lastHooks = 0;
  function scheduleFill(st) {
    if (fillRaf || fillTimer) return;
    const run = () => { cancelAnimationFrame(fillRaf); clearTimeout(fillTimer); fillRaf = fillTimer = 0; fill(st); };
    fillRaf = requestAnimationFrame(run);
    fillTimer = setTimeout(run, 100);
  }
  function fill(st) {
    if (st !== showing) return;
    const paper = $('paper'), tp = performance.now();
    // (no scroll restore: the browser's scroll anchoring keeps the systems in view where they are when a placeholder
    // above them becomes a taller or shorter engraving)
    let near = false;
    st.fill.forEach(key => {
      if (nearView.has(key)) near = true;
      const node = paper.querySelector(`:scope > .svc-wait[data-key="${key}"], :scope > .svc-stale[data-key="${key}"]`);
      const hit = E().cached(key);
      const c = st.plan.find(x => x.key === key);
      if (node && hit && c) { node.replaceWith(chunkNode(c, hit)); learn(c, hit.h); }
    });
    st.fill.clear();
    geom.invalidate();
    st.r.times.dom = (st.r.times.dom || 0) + Math.round(performance.now() - tp);
    afterPlace(st, near);
  }
  // seen: chunks in or near the view changed (the paper just switched, or such a chunk filled in).
  function afterPlace(st, seen) {
    const left = $('paper').querySelectorAll(':scope > .svc-wait, :scope > .svc-stale').length;
    if (!left) { done(st.r, st.t0); return; }
    if (!st.r.times.visible) st.r.times.visible = Math.round(performance.now() - st.t0);
    paintSelection();
    paintPlayhead(true);
    watchWaiting();
    if (seen && performance.now() - lastHooks >= FILL_HOOK_MS) hooksNow(st.r);
  }

  // The paper shows the render: its chunks in plan order, reusing the nodes already there (an unchanged chunk keeps its
  // DOM, and what afterRender hooks added to it). A chunk not engraved yet keeps the previous engraving of the same bars
  // where there is one (.svc-stale: an edit off-screen does not blank its system) or becomes a placeholder of its
  // estimated height (.svc-wait).
  function place(r, plan) {
    const paper = $('paper'), main = $('main'), sx = main.scrollLeft, sy = main.scrollTop, tp = performance.now();
    const old = new Map(), keys = new Set(plan.map(c => c.key)), sameBars = new Map();
    [...paper.children].forEach(n => {
      if (!n.classList.contains('svc') || n.classList.contains('svc-wait')) return;
      if (!n.classList.contains('svc-stale')) old.set(n.dataset.key, n);
      if (!keys.has(n.dataset.key) || n.classList.contains('svc-stale')) sameBars.set(n.dataset.a + ':' + n.dataset.b, n);
    });
    let cursor = paper.firstChild;
    plan.forEach(c => {
      let node = old.get(c.key);
      if (node) old.delete(c.key);
      else {
        const hit = E().cached(c.key), stale = !hit && sameBars.get(c.a + ':' + c.b);
        if (stale) {
          old.delete(stale.dataset.key);
          stale.dataset.key = c.key;
          stale.classList.add('svc-stale');
          node = stale;
        } else node = hit ? chunkNode(c, hit) : waitNode(c);
        if (hit) learn(c, hit.h);
      }
      while (cursor && cursor !== node && !(cursor.classList && cursor.classList.contains('svc') && keepNode(cursor, old))) {
        const next = cursor.nextSibling;
        cursor.remove();
        cursor = next;
      }
      if (cursor === node) cursor = cursor.nextSibling;
      else paper.insertBefore(node, cursor);
    });
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    old.forEach(n => n.remove());
    geom.invalidate();
    main.scrollLeft = sx; main.scrollTop = sy; // the style recalc and layout of the new SVG happen here
    shown = r;
    r.times.dom = (r.times.dom || 0) + Math.round(performance.now() - tp);
  }
  // A node still wanted later in the plan stays where it is (it is moved when its turn comes).
  const keepNode = (n, old) => old.has(n.dataset.key);

  function chunkNode(c, hit) {
    const d = document.createElement('div');
    d.className = 'svc';
    d.dataset.key = c.key; d.dataset.a = c.a; d.dataset.b = c.b;
    if (hit.h) d.style.containIntrinsicSize = `auto ${hit.h}px`;
    d.innerHTML = hit.svg;
    return d;
  }
  function waitNode(c) {
    const d = document.createElement('div');
    d.className = 'svc svc-wait';
    d.dataset.key = c.key; d.dataset.a = c.a; d.dataset.b = c.b;
    d.style.height = Math.round(heightOf(c, null)) + 'px';
    d.innerHTML = `<span>Bars ${c.a + 1 + (shownOffset())}–${c.b + 1 + shownOffset()} …</span>`;
    return d;
  }
  const shownOffset = () => (current && current.measureOffset) || 0;

  // Placeholders scrolled into view go to the front of the engraving queue.
  let io = null;
  function watchWaiting() {
    if (!window.IntersectionObserver) return;
    if (!io) {
      io = new IntersectionObserver(entries => {
        entries.forEach(e => (e.isIntersecting ? nearView.add(e.target.dataset.key) : nearView.delete(e.target.dataset.key)));
        const st = showing;
        if (!st || !entries.some(e => e.isIntersecting)) return;
        const win = new Set(entries.filter(e => e.isIntersecting).map(e => e.target.dataset.key));
        const missing = st.plan.filter(c => !E().cached(c.key));
        E().request(order(st.plan, missing, win), (c, res) => arrived(st, c, res));
      }, { root: $('main'), rootMargin: '200px' });
    }
    io.disconnect(); // (observing again reports every node afresh: nearView stays current)
    $('paper').querySelectorAll(':scope > .svc-wait, :scope > .svc-stale').forEach(n => io.observe(n));
  }

  function done(r, t0) {
    if (showing && showing.r === r) showing = null;
    if (io) io.disconnect();
    nearView.clear();
    r.drawn = true;
    r.times.total = Math.round(performance.now() - t0);
    if (!r.times.visible) r.times.visible = r.times.total;
    $('renderTime').textContent = r.times.total + ' ms';
    paintSelection();
    paintPlayhead(true);
    hooksNow(r);
    r.times.total = Math.round(performance.now() - t0);
    wake();
  }
  function hooksNow(r) {
    const t = performance.now();
    runHooks('afterRender', r);
    r.times.afterRender = (r.times.afterRender || 0) + Math.round(performance.now() - t);
    lastHooks = performance.now();
  }

  // A newer render (or none) replaces the one being engraved: its chunks still waiting for a worker are dropped.
  function drop() {
    if (showing) E().request([]);
    showing = null;
    cancelAnimationFrame(fillRaf); clearTimeout(fillTimer); fillRaf = fillTimer = 0;
    if (io) io.disconnect();
  }
  function failed(log) {
    drop();
    $('paper').innerHTML = '<div id="empty">Render failed: ' + C.escapeHtml(log || '') + '</div>';
    geom.invalidate();
    shown = null;
    if (current) current.drawn = true;
    wake();
  }

  /** Resolves with SV.state.render once its SVG is on the paper (at once when it already is). */
  function rendered() {
    return new Promise(res => {
      const check = () => {
        const r = state.render; // flushes a pending requestRender
        if (!r || r.drawn) res(r); else waiters.push(check);
      };
      check();
    });
  }
  function wake() { waiters.splice(0).forEach(fn => fn()); }

  // ------------------------------------------------------------------ status line

  function updateStatus() {
    const d = state.liveData;
    let t, nav = false;
    if (live && !state.connected) t = 'Not connected';
    else if (state.mode === 'clip') t = d && d.exists ? d.track : 'No clip selected';
    else {
      const parts = [];
      if (state.base) parts.push(state.base.title);
      if (d && d.exists) {
        const a = state.align;
        const ts = state.base ? state.base.timeSig : { num: 4, den: 4 };
        let where = '';
        if (a) {
          where = ' @ bar ' + (Math.floor(a.offset / (ts.num * 4 / ts.den)) + 1);
          const list = [...new Set([...(a.cands || []), a.offset])].sort((x, y) => x - y);
          if (list.length > 1) { where += ' (' + (list.indexOf(a.offset) + 1) + ' of ' + list.length + ')'; nav = true; }
        } else if (state.base && state.base.fresh) where = ' (⟳ Read project or play it to place it in the score)';
        else if (state.base) where = ' (not found in the read — ⟳ Read project again, or play it once)';
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

  // For afterRender hooks that measure (getBBox, getBoundingClientRect): a chunk the browser skips (content-visibility:
  // auto, off-screen) costs a forced style + layout when measured. skipped(node): node is inside such a chunk (false
  // when the browser cannot tell); whenShown(node, fn): fn() once its chunk is rendered (at once when it is).
  const chunkOf = node => (node && node.closest ? node.closest('#paper > .svc') : null);
  function skipped(node) {
    const c = chunkOf(node);
    const inner = node === c ? c && c.firstElementChild : node; // (the chunk itself is not skipped, its content is)
    if (!c || !inner || !inner.checkVisibility) return false;
    try { return !inner.checkVisibility({ contentVisibilityAuto: true }); } catch (e) { return false; }
  }
  function whenShown(node, fn) {
    const c = chunkOf(node);
    if (!c || !skipped(node)) { fn(); return; }
    if (!c.__svShown) {
      c.__svShown = [];
      c.addEventListener('contentvisibilityautostatechange', e => {
        if (e.skipped || !c.__svShown) return;
        const fns = c.__svShown;
        c.__svShown = null;
        fns.forEach(f => { try { f(); } catch (err) { console.error('whenShown', err); } });
      });
    }
    c.__svShown.push(fn);
  }

  Object.assign(C, { skipped, whenShown, render, requestRender, flushRender, rendered, shownRender: () => shown, updateStatus, paintSelection, paintPlayhead, scrollToEl, geom });
})();
