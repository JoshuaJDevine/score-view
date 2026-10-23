// Feature module: layout. Loaded last. Arranges the header and the feature toolbar the other modules filled:
//  * "⟳ Read project" sits in the header as the primary action, with its read status.
//  * The feature toolbar is sorted into clusters: Score · Write · Play · File · View · More (SV.addToolbar opts).
//  * Header layout preference (scoreview.layout.header): 'compact' (default) — one app bar that never wraps, with
//    File ▾ and View ▾ menus; Key, Quantize, Page / Single line, Zoom, Shortcuts, render time and the connection dot
//    move to the status bar; the view checkboxes (Simplify rhythms, Follow, … Paper) move into View ▾; "Exact clip
//    lengths" into the small ▾ next to Read project — or 'classic': the old stacked rows (View ▾ then holds only
//    the header choice and the View cluster). The same elements move (ids unchanged) and go back where they came from.
(function () {
  'use strict';
  const SV = window.SV;
  if (!SV) return;
  const $ = id => document.getElementById(id);
  const HEADER_KEY = 'scoreview.layout.header';
  const HEADERS = { compact: 'One row, with File ▾ / View ▾ and a status bar', classic: 'The old stacked rows' };
  const loadHeader = () => { try { const v = JSON.parse(localStorage.getItem(HEADER_KEY)); return HEADERS[v] ? v : 'compact'; } catch (e) { return 'compact'; } };

  SV.addStyle(`
    .svl-read { display: flex; align-items: center; gap: 8px; margin-left: 4px; }
    #svarRead.svl-primary { background: var(--accent); color: var(--sv-on-accent); border: 0; font-weight: 700; font-size: 13.5px;
      padding: 6px 16px; border-radius: 5px; box-shadow: 0 1px 6px #ff7a1a55; cursor: pointer; }
    #svarRead.svl-primary:hover { filter: brightness(1.08); }
    #svarRead.svl-primary:disabled { opacity: .55; cursor: default; }
    #svarRead.svl-primary.svl-nudge { animation: svlPulse 1.6s ease-in-out infinite; }
    @keyframes svlPulse { 0%, 100% { box-shadow: 0 1px 6px #ff7a1a55; } 50% { box-shadow: 0 0 0 4px #ff7a1a66; } }
    .svl-read label { color: var(--dim); font-size: 12px; }
    #svlReadInfo { color: var(--dim); font-size: 12px; white-space: nowrap; }
    #svlReadInfo.svl-ok { color: #8fd18f; }
    #svlReadInfo.svl-stale { color: var(--sv-warn); }
    #featureBar { gap: 4px 0; padding: 4px 8px; }
    .svl-cluster { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 2px 12px;
      border-left: 1px solid var(--line); }
    .svl-cluster:first-child { border-left: 0; padding-left: 4px; }
    .svl-cluster[hidden] { display: none; }
    .svl-label { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--dim);
      margin-right: 2px; }

    /* menus: View ▾, File ▾, Read ▾ */
    .svl-menu { position: relative; display: flex; align-items: center; }
    .svl-pop { position: absolute; top: calc(100% + 4px); left: 0; z-index: var(--sv-z-menu); background: var(--sv-surface-1);
      border: 1px solid var(--sv-border); border-radius: var(--sv-radius-md); padding: var(--sv-space-4) 10px; min-width: 230px;
      width: max-content; max-width: min(560px, 94vw); max-height: 78vh; overflow: auto; box-shadow: var(--sv-shadow-pop); display: flex; flex-direction: column; gap: var(--sv-space-2); }
    .svl-pop.svl-right { left: auto; right: 0; }
    .svl-pop .svl-sec { display: flex; flex-direction: column; align-items: stretch; gap: var(--sv-space-2); }
    .svl-pop .svl-sec.hidden { display: none; }
    .svl-pop label { display: flex; align-items: center; gap: var(--sv-space-3); color: var(--sv-text); white-space: nowrap; padding: 2px 0; }
    .svl-pop .group { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sv-space-3); }
    .svl-pop .svl-cluster { flex-direction: column; align-items: stretch; flex-wrap: nowrap; border: 0; padding: 0; gap: var(--sv-space-3); }
    .svl-pop .svl-cluster > .svl-label { display: none; }
    .svl-pop .btn { justify-content: flex-start; white-space: nowrap; }
    .svl-pop .svl-h { font-size: var(--sv-fs-label); font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
      color: var(--sv-text-dim); margin: var(--sv-space-3) 0 var(--sv-space-1); }
    .svl-pop .svl-h:first-child { margin-top: 0; }
    .svl-pop hr { border: 0; border-top: 1px solid var(--sv-border); margin: var(--sv-space-3) 0; width: 100%; }
    .svl-pop select { max-width: 16em; }
    .svl-pop .seg { align-self: flex-start; }
    .svl-pop .seg button { min-height: var(--sv-control-h); }
    .svl-pop [hidden] { display: none !important; }
    .btn.svl-more { min-width: 0; padding: 0 6px; }
    .svl-empty-group { display: none !important; }

    /* compact header: one app bar that never wraps */
    html[data-header="compact"] body > header { flex-wrap: nowrap; gap: var(--sv-space-5); padding: 4px var(--sv-space-5); min-height: 38px; }
    html[data-header="compact"] body > header > * { flex: none; }
    html[data-header="compact"] body > header .group { flex-wrap: nowrap; }
    html[data-header="compact"] body > header .svl-read { flex: 0 1 auto; min-width: 0; gap: 4px; }
    html[data-header="compact"] #svlReadInfo { overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 280px; margin-left: 4px; flex: 0 100 auto; }
    html[data-header="compact"] .svl-read > :not(#svlReadInfo) { flex: none; white-space: nowrap; }
    html[data-header="compact"] #svarRead.svl-primary { padding: 4px 14px; }
    html[data-header="compact"] #svPaletteBtn { margin-left: auto; }
    html[data-header="compact"] #status { flex: 0 1 auto; min-width: 90px; overflow: hidden; margin-left: 0; }
    html[data-header="compact"] #title { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    html[data-header="compact"] #featureBar { padding: 2px 8px; }
    html[data-header="compact"] #featureBar .svl-cluster { flex-wrap: nowrap; gap: 6px 8px; padding: 0 10px; }
    html[data-header="compact"] #featureBar .svl-label { display: none; }
    /* "Entry off" repeats the Entry button: hidden so the feature bar stays one row (the pill returns with entry on) */
    html[data-header="compact"] #sve-pill:not(.on) { display: none; }
    html[data-header="compact"] footer#help:not(.open) { display: none; }
    html[data-header="compact"] footer#help { padding-right: var(--sv-space-5); }
    html[data-header="classic"] #svPaletteBtn kbd { display: none; }
  `);

  // ------------------------------------------------------------------ Read project → header

  function placeReadButton() {
    const btn = $('svarRead');
    if (!btn || btn.dataset.svlPlaced) return;
    const group = btn.closest('.group') || btn.parentElement;
    group.classList.add('svl-read');
    btn.classList.add('svl-primary');
    btn.textContent = '⟳ Read project';
    btn.title = 'Read every clip of the open Bitwig project into the score (click any clip in the Arranger first). ' +
      'Do this after drawing or recording clips so all staves show their notes.';
    if (!$('svlReadInfo')) { const s = document.createElement('span'); s.id = 'svlReadInfo'; group.appendChild(s); }
    const mode = $('modeSeg');
    mode.parentNode.insertBefore(group, mode.nextSibling); // right after Clip | Score
    btn.dataset.svlPlaced = '1';
  }

  function ago(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  }

  function updateReadInfo() {
    const info = $('svlReadInfo'), btn = $('svarRead');
    if (!info || !btn) return;
    const base = SV.state.base, busy = btn.disabled;
    const status = $('svarStatus');
    if (status) status.hidden = !busy; // progress text only while reading
    let text = '', ok = false, nudge = false, stale = false;
    if (busy) text = '';
    else if (base && base.source === 'crawl') {
      stale = SV.arrangement && SV.arrangement.staleReasons ? SV.arrangement.staleReasons().length > 0 : false;
      const restored = SV.arrangement && SV.arrangement.mirrorInfo && SV.arrangement.mirrorInfo().restoredAt;
      const what = base.fresh ? `new score · ${base.parts.length} staves` : `${base.parts.length} parts read`; // New: stored like a read
      text = `${stale ? '' : '✓ '}${what} · ${ago(Date.now() - (SV.state.baseMtime || Date.now()))}` +
        `${restored ? ' · restored' : ''}${stale ? ' · out of date' : ''}`;
      ok = !stale;
    }
    else if (base && base.fresh) { text = 'empty score — read once you have clips'; nudge = SV.state.mode === 'score'; }
    else if (base) text = 'showing ' + (base.title || 'a score file'); // a test fixture
    else { text = 'only the selected clip has notes — read to see every track'; nudge = SV.state.mode === 'score'; }
    info.textContent = text;
    info.classList.toggle('svl-ok', ok);
    info.classList.toggle('svl-stale', stale);
    info.title = stale ? $('svarStale').title : text;
    btn.classList.toggle('svl-nudge', nudge && !busy);
  }

  // ------------------------------------------------------------------ menus

  const menus = {};
  let closeTimer = 0; // the close after a command in a menu (after its handlers ran); cancelled when a menu opens again
  function makeMenu(key, label, title, { right = false, small = false, ids } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'svl-menu';
    wrap.innerHTML = `<button class="btn${small ? ' svl-more' : ''}" title="${title}" aria-haspopup="true" aria-expanded="false">${label}</button>` +
      `<div class="svl-pop hidden${right ? ' svl-right' : ''}"></div>`;
    const btn = wrap.firstChild, pop = wrap.lastChild;
    [wrap.id, btn.id, pop.id] = ids;
    pop.dataset.svlMenu = label.replace(/[▾\s]+$/, '').trim() || title;
    btn.addEventListener('click', () => { toggleMenu(key); btn.blur(); });
    // Buttons in a menu run and close it; checkboxes, selects and segmented controls keep it open for more changes.
    pop.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b && pop.contains(b) && !b.closest('.seg')) { clearTimeout(closeTimer); closeTimer = setTimeout(closeMenus, 0); }
    });
    menus[key] = { wrap, btn, pop };
    return menus[key];
  }
  function setOpen(m, show) { m.pop.classList.toggle('hidden', !show); m.btn.setAttribute('aria-expanded', String(show)); }
  function toggleMenu(key, open) {
    clearTimeout(closeTimer);
    const m = menus[key];
    if (!m) return;
    const show = open == null ? m.pop.classList.contains('hidden') : open;
    Object.keys(menus).forEach(k => { if (k !== key) setOpen(menus[k], false); });
    setOpen(m, show);
  }
  function closeMenus() { Object.values(menus).forEach(m => setOpen(m, false)); }
  document.addEventListener('mousedown', e => {
    Object.values(menus).forEach(m => { if (!m.wrap.contains(e.target)) setOpen(m, false); });
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = Object.values(menus).find(m => !m.pop.classList.contains('hidden'));
    if (!open) return;
    setOpen(open, false);
    // A dialog opened from the menu (e.g. Brief) holds the focus: the key is its Esc too, so let it through.
    const t = e.target;
    if (!(t && t.closest && t.closest('[role=dialog]') && !open.wrap.contains(t))) e.stopPropagation();
  }, true);

  const view = makeMenu('view', 'View ▾', 'What the score shows (rhythms, staves, names, ranges, dynamics, paper) and the header layout',
    { right: true, ids: ['svViewMenu', 'svViewBtn', 'svViewPanel'] });
  view.pop.innerHTML = '<div class="svl-h" id="svViewShowH">Show</div><div id="svViewItems" class="svl-sec"></div><div id="svViewMore" class="svl-sec"></div>' +
    '<hr id="svViewHr"><div class="svl-h">Header layout</div><div class="seg" id="svHeaderSeg">' +
    Object.keys(HEADERS).map(k => `<button data-header="${k}" title="${HEADERS[k]}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('') + '</div>';
  view.pop.querySelector('#svHeaderSeg').addEventListener('click', e => { const h = e.target.dataset.header; if (h) setHeader(h); });

  const file = makeMenu('file', 'File ▾', 'New, open, import, export, print', { right: true, ids: ['svFileMenu', 'svFileBtn', 'svFilePanel'] });
  file.pop.innerHTML = '<div class="scoreOnly hidden svl-sec" id="svFileScore"></div><div id="svFileItems" class="svl-sec"></div>';

  const readMore = makeMenu('read', '▾', 'Read options', { small: true, ids: ['svlReadMenu', 'svlReadMore', 'svlReadPop'] });

  // ------------------------------------------------------------------ feature toolbar clusters

  const CLUSTERS = [
    ['score', 'Score'], ['write', 'Write'], ['play', 'Play'], ['file', 'File'], ['view', 'View'], ['more', 'More'],
  ];
  const KEYS = CLUSTERS.map(([k]) => k);
  const has = (c, sel) => c.matches(sel) || !!c.querySelector(sel);
  // The cluster a module asked for (SV.addToolbar(el, { cluster })); calls without one are sorted by their ids.
  function clusterOf(c) {
    if (KEYS.includes(c.dataset.svCluster)) return c.dataset.svCluster;
    return guessCluster(c);
  }
  function guessCluster(c) {
    if (c.id === 'sviGroup' || c.id === 'mxGroup' || c.id === 'svpPrintGroup' || c.id === 'svpGroup' || has(c, '#svwOpen')) return 'file';
    if (c.id === 'svpbStrip') return 'play';
    if (has(c, '#mtfBtn') || has(c, '#orcBtn') || has(c, '#insBtn') || has(c, '#sve-toggle') || c.id === 'svc-open' || has(c, '.sve-toggle')) return 'write';
    if (c.id === 'svSections' || has(c, '#svaBtn') || has(c, '#hvBtn') || c.classList.contains('svn-wrap') || has(c, '#svInstrBtn')) return 'score';
    return 'more';
  }

  // Within a cluster: explicit order first (ascending), then the rest in SV.addToolbar call order.
  const rank = c => [c.dataset.svOrder != null ? +c.dataset.svOrder : Infinity, +(c.dataset.svSeq || 0)];
  function sortBox(box) {
    const items = [...box.children].filter(c => !c.classList.contains('svl-label'));
    const sorted = items.slice().sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1]; });
    if (sorted.some((c, i) => c !== items[i])) sorted.forEach(c => box.appendChild(c)); // move only when needed (keeps focus)
  }

  const boxes = {};
  CLUSTERS.forEach(([key, label]) => {
    const box = document.createElement('div');
    box.className = 'svl-cluster';
    box.dataset.k = key;
    box.innerHTML = `<span class="svl-label">${label}</span>`;
    boxes[key] = box;
  });
  // Where a cluster box lives: the View cluster in View ▾; in the compact header the File cluster in File ▾.
  const homeOf = key => key === 'view' ? view.pop.querySelector('#svViewMore') : key === 'file' && header === 'compact' ? file.pop.querySelector('#svFileItems') : $('featureBar');

  function organize() {
    const bar = $('featureBar');
    if (!bar) return;
    [...bar.children].forEach(c => { if (!c.classList.contains('svl-cluster')) boxes[clusterOf(c)].appendChild(c); });
    CLUSTERS.forEach(([key]) => {
      const box = boxes[key];
      sortBox(box);
      box.hidden = box.children.length <= 1;
      const home = homeOf(key);
      if (box.parentNode !== home || (home === bar && box !== bar.lastElementChild)) home.appendChild(box); // fixed order
    });
    const showH = view.pop.querySelector('#svViewItems').children.length > 0 || !boxes.view.hidden;
    view.pop.querySelector('#svViewShowH').hidden = !showH;
    view.pop.querySelector('#svViewHr').hidden = !showH;
  }

  // ------------------------------------------------------------------ compact / classic

  // What the compact header moves: [selector, where]. A checkbox moves with its <label>; 'group:' moves the header
  // .group around the element.
  const MOVES = [
    ['#simplify', 'view'], ['#interpret', 'view'], ['#follow', 'view'], ['#condense', 'view'], ['#hideUnused', 'view'], ['#hideKs', 'view'], ['#audition', 'view'], ['#bitwigSel', 'view'], ['#keyPreset', 'view'],
    ['#sviNames', 'view'], ['#sviTransposed', 'view'], ['#sviRanges', 'view'], ['#svaDyn', 'view'], ['#svpbMarks', 'view'], ['#svpbCue', 'view'],
    ['#svpGroup', 'view'],
    ['#freshBtn', 'fileScore'],
    ['group:#keySel', 'status'], ['group:#layoutSeg', 'status'],
    ['#helpToggle', 'right'], ['#renderTime', 'right'], ['#dot', 'right'],
  ];
  const TARGETS = { view: () => view.pop.querySelector('#svViewItems'), fileScore: () => file.pop.querySelector('#svFileScore'), read: () => readMore.pop,
    status: () => $('svStatusTools'), right: () => $('svStatusRight') };
  const moved = []; // [{ el, parent, next }] in move order
  function target(sel) {
    if (sel.startsWith('group:')) { const x = document.querySelector(sel.slice(6)); return x && x.closest('.group'); }
    const el = document.querySelector(sel);
    if (el && ((el.tagName === 'INPUT' && el.type === 'checkbox') || el.tagName === 'SELECT')) return el.closest('label') || el; // with its caption
    return el;
  }
  const markEmptyGroups = () => document.querySelectorAll('header > .group, #featureBar .svl-cluster > .group').forEach(g => {
    if (!g.dataset.svlMoved) return;
    g.classList.toggle('svl-empty-group', ![...g.children].some(c => !c.classList.contains('hidden') && !c.hidden));
  });
  function moveAll() {
    MOVES.forEach(([sel, where]) => {
      const el = target(sel), to = TARGETS[where]();
      if (!el || !to || to.contains(el)) return;
      moved.push({ el, parent: el.parentNode, next: el.nextSibling });
      if (el.parentNode.classList && el.parentNode.classList.contains('group')) el.parentNode.dataset.svlMoved = '1';
      to.appendChild(el);
    });
    const read = $('svarRead');
    if (read && readMore.pop.children.length) read.after(readMore.wrap); // Read ▾ only when something lives in it
    placeRight(true);
    markEmptyGroups();
  }
  function restoreAll() {
    for (let i = moved.length - 1; i >= 0; i--) {
      const { el, parent, next } = moved[i];
      if (next && next.parentNode === parent) parent.insertBefore(el, next); else parent.appendChild(el);
      if (parent.dataset) delete parent.dataset.svlMoved;
    }
    moved.length = 0;
    document.querySelectorAll('.svl-empty-group').forEach(g => g.classList.remove('svl-empty-group'));
    readMore.wrap.remove();
    file.wrap.remove();
    placeRight(false);
  }
  // Commands, File ▾ (compact only) and View ▾ at the right end of the header, before the title.
  function placeRight(withFile) {
    const status = $('status'), pal = $('svPaletteBtn');
    if (pal) status.before(pal);
    if (withFile) status.before(file.wrap);
    status.before(view.wrap);
  }

  let header = loadHeader();
  function applyHeader() {
    document.documentElement.dataset.header = header;
    closeMenus();
    restoreAll();
    if (header === 'compact') moveAll();
    organize();
    view.pop.querySelectorAll('#svHeaderSeg button').forEach(b => b.classList.toggle('on', b.dataset.header === header));
    file.pop.querySelector('#svFileScore').classList.toggle('hidden', SV.state.mode !== 'score');
    if (SV.geom && SV.geom.invalidate) SV.geom.invalidate();
  }
  function setHeader(v) {
    if (!HEADERS[v]) v = 'compact';
    header = v;
    try { localStorage.setItem(HEADER_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
    applyHeader();
    window.dispatchEvent(new Event('resize')); // the paper may have a different width now
    return v;
  }

  /** Opens the menu holding el (an element or selector), so it can be seen and clicked; returns the element. */
  function reveal(el) {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el) return null;
    const key = Object.keys(menus).find(k => menus[k].pop.contains(el));
    if (key && menus[key].pop.classList.contains('hidden')) toggleMenu(key, true);
    return el;
  }

  placeReadButton();
  applyHeader();
  updateReadInfo();
  window.addEventListener('sv-ready', () => setTimeout(() => { organize(); markEmptyGroups(); updateReadInfo(); }, 0));
  // Modules may add toolbar items later (e.g. sections once a score loads): keep them sorted.
  new MutationObserver(() => { const bar = $('featureBar'); if (bar && [...bar.children].some(c => !c.classList.contains('svl-cluster'))) organize(); })
    .observe($('featureBar'), { childList: true });
  SV.hooks.afterRender.push(() => updateReadInfo());
  setInterval(updateReadInfo, 15000);
  window.addEventListener('sv-read-stale', updateReadInfo); // features/arrangement.js: the read went out of date (or current)
  const btn = $('svarRead');
  if (btn) new MutationObserver(updateReadInfo).observe(btn, { attributes: true, attributeFilter: ['disabled'] });

  SV.layout = { header: () => header, setHeader, headers: Object.keys(HEADERS), reveal, openMenu: k => toggleMenu(k, true), closeMenus };
})();
