// Print / PDF: a print view with real pages (A4 or Letter, portrait or landscape), a title/composer header, page
// numbers, and either the full score or one part. It engraves the current score model (state.render.score, after
// every transformScore hook) again with its own Verovio toolkit, paginated at the paper size: scale 100 makes one
// Verovio unit 0.1 mm, so pageWidth/pageHeight are the paper in tenths of a millimetre and `unit` sets the staff size
// (staff height = 8 units). The pages live in #svPrint; @media print hides everything else, so the browser's print
// dialog ("Save as PDF") gets exactly these pages. Preferences: localStorage scoreview.print.*.
(function (root) {
  'use strict';
  const SV = root.SV;
  if (!SV) return;

  const PAPER = { a4: { w: 2100, h: 2970, css: 'A4' }, letter: { w: 2159, h: 2794, css: 'letter' } };
  const STAFF_MM = [3.6, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8];
  const PREF = 'scoreview.print.';
  const pref = (k, d) => { try { const v = localStorage.getItem(PREF + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(PREF + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cleanName = n => String(n || '').replace(/\s*✎\s*$/, '').trim();
  const $ = id => document.getElementById(id);

  let lastBuildOpts = null;
  SV.hooks.buildOptions.push(b => { lastBuildOpts = b; });

  SV.addStyle(`
    #svPrint { position: fixed; inset: 0; z-index: 45; background: #3b3b3b; overflow: auto; }
    #svPrint .svp-bar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px;
                        padding: 8px 14px; background: var(--bar); border-bottom: 1px solid #111; color: var(--text); }
    #svPrint .svp-bar label { color: var(--dim); }
    #svPrint .svp-bar .group { display: flex; align-items: center; gap: 6px; }
    #svPrint .svp-bar input[type=text] { background: var(--bar2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; font: inherit; width: 13em; }
    #svPrint .svp-bar .primary { background: var(--accent); color: #111; font-weight: 600; border-color: var(--accent); }
    #svPrint .svp-info { color: var(--dim); font-size: 12px; }
    #svPrintPages { display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 24px 0 40px; }
    .svp-page { background: #fff; color: #000; box-shadow: 0 4px 18px #000a; overflow: hidden; position: relative; }
    .svp-page > svg { display: block; width: 100%; height: 100%; }
    @media print {
      html, body { height: auto !important; background: #fff !important; display: block !important; overflow: visible !important; }
      body > *:not(#svPrint) { display: none !important; }
      #svPrint { position: static; overflow: visible; background: none; }
      #svPrint .svp-bar { display: none !important; }
      #svPrintPages { display: block; padding: 0; }
      .svp-page { box-shadow: none; margin: 0; break-after: page; page-break-after: always; }
      .svp-page:last-child { break-after: auto; page-break-after: auto; }
    }
  `);
  const pageStyle = document.createElement('style');
  document.head.appendChild(pageStyle);

  const g = SV.addToolbar('<button class="btn" id="svpPrintBtn" title="Print the score or a part, or save it as PDF (Ctrl+P)">Print / PDF…</button>', { cluster: 'file', order: 170 });
  g.id = 'svpPrintGroup';
  $('svpPrintBtn').addEventListener('click', () => open());
  SV.hooks.keydown.push(e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      if ($('svPrint')) root.print(); else open();
      return true;
    }
    return false;
  });

  if (SV.shortcuts) SV.shortcuts.register({ keys: 'Ctrl+P', owner: 'print', desc: 'print view (again: print)' });

  let tk = null;
  const toolkit = () => tk || (tk = new root.verovio.toolkit());

  // Current score model, optionally for the whole song (score mode). SV.scoreModel (core/api.js) builds it without
  // engraving; the whole-song model is cached while the print view is open.
  let wholeCache = null;
  function currentScore(whole) {
    const st = SV.state;
    if (!whole || st.mode !== 'score' || !st.base || st.range === 'all') return st.render && st.render.score;
    if (!wholeCache) wholeCache = SV.scoreModel ? SV.scoreModel({ range: 'all' }) : st.render.score;
    return wholeCache;
  }

  function defaultTitle(score) {
    const st = SV.state;
    return (st.mode === 'score' && st.base && st.base.title) || cleanName(score && score.title) || cleanName(SV.currentTrack()) || 'Score';
  }

  // Written-pitch transposition for a part (via features/musicxml.js + instruments.js when present).
  function writtenTranspose(p) {
    if (p.transpose) return 0;
    const mx = SV.musicxml;
    if (!mx || !mx.instrumentTranspose) return 0;
    const t = mx.instrumentTranspose(cleanName(p.label || p.name), SV.instruments) || 0;
    const clefDis = p.clef && !Array.isArray(p.clef) && p.clef.dis;
    return t % 12 === 0 && clefDis ? 0 : t;
  }

  /**
   * Builds the print MEI. opts: { part (name or ''), title, composer, written, colours }.
   * Returns { mei, score } or null.
   */
  function printScore(src, opts) {
    if (!src || !src.parts || !src.parts.length) return null;
    let parts = src.parts;
    if (opts.part) parts = parts.filter(p => p.name === opts.part);
    if (!parts.length) return null;
    parts = parts.map(p => {
      let q = { ...p };
      if (!opts.colours) q.notes = p.notes.map(n => (n.color ? { ...n, color: undefined } : n));
      if (opts.written) { const t = writtenTranspose(q); if (t) q.transpose = t; }
      if (opts.part) q.group = undefined;
      return q;
    });
    const score = { ...src, title: opts.title, parts, groupLabels: false };
    const built = SV.ScoreBuilder.buildMEI(score, { ...(lastBuildOpts || { grid: 2, simplify: true, interpret: true }) });
    let mei = built.mei;
    // A part has its name in the header: no instrument labels or single-staff bracket on every system.
    if (opts.part) mei = mei.replace(/<label>[\s\S]*?<\/label><labelAbbr>[\s\S]*?<\/labelAbbr>/g, '')
      .replace('<staffGrp symbol="bracket" bar.thru="false">', '<staffGrp bar.thru="false">');
    const partName = opts.part ? cleanName((parts[0].label || parts[0].name)) : '';
    const head = `<pgHead>` +
      (partName ? `<rend halign="left" valign="top"><rend fontsize="large" fontweight="bold">${esc(partName)}</rend></rend>` : '') +
      `<rend halign="center" valign="top"><rend fontsize="xx-large">${esc(opts.title)}</rend></rend>` +
      (opts.composer ? `<rend halign="right" valign="bottom">${esc(opts.composer)}</rend>` : '') + `</pgHead>`;
    const foot = `<pgFoot><rend halign="left"><rend fontsize="small">${esc(partName ? opts.title + ' — ' + partName : opts.title)}</rend></rend>` +
      `<rend halign="right"><rend fontsize="small"><num label="page">1</num></rend></rend></pgFoot>`;
    mei = mei.replace(/<scoreDef([^>]*)>/, `<scoreDef$1>${head}${foot}`);
    if (opts.composer) mei = mei.replace('</titleStmt>', `<respStmt><persName role="composer">${esc(opts.composer)}</persName></respStmt></titleStmt>`);
    return { mei, score, built };
  }

  /** Engraves the pages; returns { svgs:[...], pages, paper: {w, h} (tenths of mm) }. */
  function paginate(mei, opts) {
    const paper = PAPER[opts.paper] || PAPER.a4;
    const land = opts.orientation === 'landscape';
    const w = land ? paper.h : paper.w, h = land ? paper.w : paper.h;
    const t = toolkit();
    t.setOptions({
      scale: 100, pageWidth: w, pageHeight: h, adjustPageHeight: false, unit: opts.staffMm * 1.25,
      pageMarginLeft: 150, pageMarginRight: 120, pageMarginTop: 110, pageMarginBottom: 110,
      header: 'encoded', footer: 'encoded', usePgFooterForAll: true, breaks: 'auto', breaksNoWidow: true,
      condense: opts.condense ? 'auto' : 'none', condenseFirstPage: false, justifyVertically: !opts.part,
      spacingSystem: opts.part ? 12 : 16, spacingStaff: opts.part ? 8 : 10, mnumInterval: 0,
    });
    const tl = performance.now();
    if (!t.loadData(mei)) throw new Error('Verovio could not engrave the print: ' + t.getLog());
    const loadMs = performance.now() - tl;
    const pages = t.getPageCount(), svgs = [];
    // glyph <use>s -> inline <path>s, as on the paper (core/svg-inline.js): a full score's style recalc drops from seconds
    const inline = window.SvgInline && window.SvgInline.enabled() ? window.SvgInline.inlineGlyphs : s => s;
    for (let p = 1; p <= pages; p++) svgs.push(inline(t.renderToSVG(p)));
    return { svgs, pages, w, h, loadMs };
  }

  // ------------------------------------------------------------------ print view

  const cur = {
    paper: pref('paper', 'a4'), orientation: pref('orientation', 'portrait'), part: '', whole: pref('whole', false),
    staffScore: pref('staffScore', 5), staffPart: pref('staffPart', 7), composer: pref('composer', ''), title: '',
    colours: pref('colours', false), writtenParts: pref('writtenParts', true), writtenScore: pref('writtenScore', false),
  };

  function open() {
    if (!SV.state.render) { SV.flash('Nothing to print yet'); return; }
    close();
    const box = document.createElement('div');
    box.id = 'svPrint';
    box.tabIndex = -1;
    const scoreMode = SV.state.mode === 'score' && !!SV.state.base;
    box.innerHTML = `<div class="svp-bar">
      <div class="group"><button class="btn primary" id="svpGo" title="Opens the print dialog — choose “Save as PDF” for a PDF">Print…</button>
        <button class="btn" id="svpClose">Close</button></div>
      <div class="group"><label>Print</label><select id="svpPart"></select>
        ${scoreMode ? '<select id="svpWhole"><option value="0">Current view</option><option value="1">Whole song</option></select>' : ''}</div>
      <div class="group"><select id="svpPaper"><option value="a4">A4</option><option value="letter">Letter</option></select>
        <select id="svpOrient"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>
        <label for="svpStaff">Staff</label><select id="svpStaff">${STAFF_MM.map(s => `<option value="${s}">${s} mm</option>`).join('')}</select></div>
      <div class="group"><input type="text" id="svpTitle" placeholder="Title"><input type="text" id="svpComposer" placeholder="Composer"></div>
      <div class="group"><label title="Transposing instruments in written pitch"><input type="checkbox" id="svpWritten"> Transposed</label>
        <label title="Keep coloured notes (e.g. harmony colours)"><input type="checkbox" id="svpColours"> Colours</label></div>
      <span class="svp-info" id="svpInfo"></span>
    </div><div id="svPrintPages"></div>`;
    document.body.appendChild(box);
    box.focus();
    const src0 = SV.state.render.score;
    cur.title = defaultTitle(src0);
    fillParts(src0);
    $('svpTitle').value = cur.title;
    $('svpComposer').value = cur.composer;
    $('svpPaper').value = cur.paper;
    $('svpOrient').value = cur.orientation;
    if ($('svpWhole')) $('svpWhole').value = cur.whole ? '1' : '0';
    $('svpColours').checked = cur.colours;
    syncPartControls();
    box.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    $('svpClose').addEventListener('click', close);
    $('svpGo').addEventListener('click', () => root.print());
    box.querySelector('.svp-bar').addEventListener('change', e => {
      const id = e.target.id;
      if (id === 'svpPart') { cur.part = e.target.value; syncPartControls(); }
      if (id === 'svpStaff') { cur[cur.part ? 'staffPart' : 'staffScore'] = parseFloat(e.target.value); setPref(cur.part ? 'staffPart' : 'staffScore', parseFloat(e.target.value)); }
      if (id === 'svpWritten') { cur[cur.part ? 'writtenParts' : 'writtenScore'] = e.target.checked; setPref(cur.part ? 'writtenParts' : 'writtenScore', e.target.checked); }
      if (id === 'svpPaper') setPref('paper', cur.paper = e.target.value);
      if (id === 'svpOrient') setPref('orientation', cur.orientation = e.target.value);
      if (id === 'svpWhole') { setPref('whole', cur.whole = e.target.value === '1'); }
      if (id === 'svpColours') setPref('colours', cur.colours = e.target.checked);
      if (id === 'svpTitle') cur.title = e.target.value;
      if (id === 'svpComposer') setPref('composer', cur.composer = e.target.value);
      build();
    });
    build();
  }

  function fillParts(score) {
    const sel = $('svpPart');
    const names = score.parts.map(p => p.name);
    if (cur.part && !names.includes(cur.part)) cur.part = '';
    sel.innerHTML = '<option value="">Full score</option>' +
      score.parts.map(p => `<option value="${esc(p.name)}">Part: ${esc(cleanName(p.label || p.name))}</option>`).join('');
    sel.value = cur.part;
  }

  function syncPartControls() {
    $('svpStaff').value = String(cur.part ? cur.staffPart : cur.staffScore);
    $('svpWritten').checked = cur.part ? cur.writtenParts : cur.writtenScore;
  }

  function close() { wholeCache = null; const b = $('svPrint'); if (b) b.remove(); }

  function build() {
    const out = $('svPrintPages'), info = $('svpInfo');
    if (!out) return null;
    const t0 = performance.now();
    try {
      const src = currentScore(cur.whole);
      const t1 = performance.now();
      const opts = { part: cur.part, title: cur.title || defaultTitle(src), composer: cur.composer, colours: cur.colours,
                     written: cur.part ? cur.writtenParts : cur.writtenScore };
      const ps = printScore(src, opts);
      const t2 = performance.now();
      if (!ps) { out.innerHTML = ''; info.textContent = 'Nothing to print'; return null; }
      const res = paginate(ps.mei, { paper: cur.paper, orientation: cur.orientation, staffMm: cur.part ? cur.staffPart : cur.staffScore,
                                     part: !!cur.part, condense: !cur.part && $('condense') && $('condense').checked });
      const wmm = res.w / 10, hmm = res.h / 10;
      pageStyle.textContent = `@page { size: ${PAPER[cur.paper].css} ${cur.orientation}; margin: 0; }
        .svp-page { width: ${wmm}mm; height: ${hmm}mm; }
        @media print { .svp-page { width: ${wmm}mm; height: ${hmm - 0.3}mm; } }`;
      const t3 = performance.now();
      out.innerHTML = res.svgs.map((s, i) => `<div class="svp-page" data-page="${i + 1}">${s}</div>`).join('');
      out.querySelectorAll('.svp-page > svg').forEach(svg => {
        svg.removeAttribute('width'); svg.removeAttribute('height');
        svg.setAttribute('viewBox', `0 0 ${res.w} ${res.h}`);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      });
      numberPages(out, res.pages);
      info.textContent = `${res.pages} page${res.pages > 1 ? 's' : ''} · ${ps.score.parts.length} part${ps.score.parts.length > 1 ? 's' : ''} · ${Math.round(performance.now() - t0)} ms`;
      api.last = { pages: res.pages, mei: ps.mei, opts, ms: { score: t1 - t0, mei: t2 - t1, engrave: t3 - t2, layoutOnly: res.loadMs, dom: performance.now() - t3 } };
      return res;
    } catch (err) {
      console.error('print', err);
      out.innerHTML = '';
      info.textContent = 'Print failed: ' + err.message;
      return null;
    }
  }

  // Verovio renders the footer's <num> once ("page 1") and repeats that footer on every page: write "n / N" into
  // the number (the last numeric text in the footer) of each page.
  function numberPages(out, total) {
    out.querySelectorAll('.svp-page').forEach(pg => {
      const n = pg.dataset.page;
      const tspans = [...pg.querySelectorAll('g.pgFoot tspan')].filter(t => !t.children.length && /^\d+$/.test(t.textContent.trim()));
      const t = tspans[tspans.length - 1];
      if (t) t.textContent = total > 1 ? n + ' / ' + total : n;
    });
  }

  const api = { open, close, build, printScore, paginate, PAPER, last: null };
  SV.print = api;
  SV.addHelp('<b>Print / PDF…</b> (<kbd>Ctrl</kbd>+<kbd>P</kbd>) shows the score or one part on A4/Letter pages with title and page numbers; Print… opens the browser dialog — choose “Save as PDF” for a PDF.');
})(this);
