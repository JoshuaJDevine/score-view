// Feature module: New Score wizard (issue #14, docs/wizard.md). Builds an ensemble's tracks in the open Bitwig
// project (names, groups, colours, articulation-map Note FX, instrument plug-in) through the extension's wizard job
// (POST/GET /api/wizard, NewScoreWizard.java), and swaps the instrument library of one track.
// Data: features/wizard-templates.js (templates, palette, plan text) + features/wizard-plugins.js (installed plug-ins).
(function (root) {
  'use strict';
  const SV = root.SV, T = root.SV_WIZARD_TEMPLATES;
  if (!SV || !T || typeof document === 'undefined') return;
  const INV = root.SV_WIZARD_PLUGINS || { plugins: [], noteFx: [], presets: [] };
  const HARVEST = root.SV_WIZARD_PRESETS || { presets: [] }; // patch presets (tools/harvest-presets.mjs)
  const KEY = 'scoreview.wizard.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  SV.addStyle(`
    .svw-back { position: fixed; inset: 0; background: #0009; z-index: 60; display: flex; align-items: center; justify-content: center; }
    .svw-dlg { background: var(--bar, #232323); color: var(--text, #ddd); border: 1px solid var(--line, #3a3a3a); border-radius: 8px;
               box-shadow: 0 10px 40px #000c; width: min(1280px, 96vw); max-height: 92vh; display: flex; flex-direction: column; font-size: 12px; }
    .svw-dlg > header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line, #3a3a3a); }
    .svw-dlg h3 { margin: 0; font-size: 15px; color: #fff; flex: 1; }
    .svw-dlg section { padding: 10px 14px; overflow: auto; }
    .svw-dlg .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
    .svw-dlg .dim { color: var(--dim, #888); }
    .svw-dlg input[type=text], .svw-dlg select { background: var(--bar2, #2d2d2d); color: inherit; border: 1px solid var(--line, #3a3a3a);
               border-radius: 4px; padding: 3px 5px; font: inherit; }
    .svw-dlg input[type=color] { width: 28px; height: 22px; padding: 0; border: 1px solid var(--line, #3a3a3a); background: none; }
    .svw-table { border-collapse: collapse; width: 100%; }
    .svw-table th { text-align: left; color: var(--dim, #888); font-weight: normal; padding: 2px 4px; position: sticky; top: 0; background: var(--bar, #232323); }
    .svw-table td { padding: 2px 4px; border-top: 1px solid #2b2b2b; vertical-align: middle; }
    .svw-table input.nm { width: 150px; } .svw-table input.gr { width: 100px; } .svw-table select.sv { width: 130px; } .svw-table select.art { width: 140px; }
    .svw-table textarea.pt { width: 290px; height: 30px; font-family: inherit; font-size: 11px; line-height: 1.25; resize: vertical; background: var(--bar2, #2d2d2d); color: #ffd8a8; border: 1px solid var(--line, #3a3a3a); border-radius: 4px; padding: 2px 5px; }
    .svw-table .lib { min-width: 150px; max-width: 200px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .svw-table .lib.none { color: var(--dim, #888); font-style: italic; }
    .svw-table .warn { color: #f08c00; cursor: help; }
    .svw-mini { background: none; border: 0; color: var(--dim, #888); cursor: pointer; padding: 0 3px; font-size: 13px; }
    .svw-mini:hover { color: var(--accent, #ff7a1a); }
    .svw-dlg footer { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--line, #3a3a3a); }
    .svw-dlg footer .grow { flex: 1; }
    .svw-dlg .btn.primary { background: var(--accent, #ff7a1a); color: #111; border-color: var(--accent, #ff7a1a); font-weight: 600; }
    .svw-warnings { color: #f08c00; margin-top: 6px; }
    .svw-confirm { font-size: 13px; line-height: 1.5; }
    .svw-confirm b { color: #fff; }
    .svw-bar { height: 8px; background: var(--bar2, #2d2d2d); border-radius: 4px; overflow: hidden; margin: 10px 0; }
    .svw-bar > div { height: 100%; background: var(--accent, #ff7a1a); width: 0; transition: width .2s; }
    .svw-sum li { margin: 2px 0; } .svw-sum .ok { color: #69db7c; } .svw-sum .bad { color: #ff6b6b; }
    .svw-sum ul { padding-left: 18px; margin: 4px 0 10px; }
    .svw-cur { margin: 0 0 8px; padding: 6px 8px; background: var(--bar2, #2d2d2d); border-radius: 4px; }
    .svw-cur:empty { display: none; }
    .svw-cur details { margin-top: 2px; } .svw-cur summary { cursor: pointer; color: var(--dim, #888); }
    .svw-pick { display: grid; grid-template-columns: 170px minmax(210px, 280px) 1fr; gap: 12px; min-height: 420px; }
    .svw-pick[hidden] { display: none; }
    .svw-cats { display: flex; flex-direction: column; gap: 2px; }
    .svw-cat { background: none; border: 0; color: inherit; text-align: left; padding: 5px 8px; border-radius: 4px; cursor: pointer; font: inherit; display: flex; }
    .svw-cat span { margin-left: auto; color: var(--dim, #888); } .svw-cat:hover { background: var(--bar2, #2d2d2d); }
    .svw-cat.on { background: var(--accent, #ff7a1a); color: #111; } .svw-cat.on span { color: #111; }
    .svw-list { overflow: auto; max-height: 64vh; border-right: 1px solid var(--line, #3a3a3a); padding-right: 8px; }
    .svw-lcat { color: var(--dim, #888); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; margin: 8px 0 3px; }
    .svw-card { display: block; padding: 5px 8px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; }
    .svw-card b { display: block; color: #fff; font-weight: 600; } .svw-card span { color: var(--dim, #888); font-size: 11px; }
    .svw-card:hover { border-color: var(--line, #3a3a3a); } .svw-card.on { border-color: var(--accent, #ff7a1a); background: #ff7a1a1a; }
    .svw-preview { overflow: auto; max-height: 64vh; padding-right: 4px; }
    .svw-preview h4, .svw-sheet h3 { margin: 0 0 2px; font-size: 15px; color: #fff; }
    .svw-bline { margin: 8px 0 4px; font-size: 13px; color: #fff; }
    .svw-form { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 8px; }
    .svw-form .sec { background: var(--bar2, #2d2d2d); border: 1px solid var(--line, #3a3a3a); border-radius: 4px; padding: 2px 6px; }
    .svw-form .sec i { color: var(--dim, #888); font-style: normal; font-size: 10px; margin-left: 4px; }
    .svw-prompt { line-height: 1.5; margin: 6px 0 10px; max-width: 70ch; }
    .svw-ptable { border-collapse: collapse; width: 100%; font-size: 11.5px; }
    .svw-ptable th { text-align: left; color: var(--dim, #888); font-weight: normal; padding: 2px 6px 2px 0; }
    .svw-ptable td { border-top: 1px solid #2b2b2b; padding: 3px 6px 3px 0; vertical-align: top; }
    .svw-ptable td:first-child { white-space: nowrap; color: #fff; } .svw-ptable td:nth-child(2) { white-space: nowrap; } .svw-ptable td.patch { color: #ffd8a8; }
    .svw-opts { border: 1px solid var(--line, #3a3a3a); border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
    .svw-opts label { display: block; margin-top: 4px; }
    .svw-load { color: #ffd8a8; font-size: 11.5px; margin: 1px 0 3px 18px; }
    .svw-sumbrief { border-top: 1px solid var(--line, #3a3a3a); margin-top: 10px; padding-top: 8px; }
    .svw-badge { display: block; font-size: 10px; color: #f08c00; margin-top: 1px; white-space: nowrap; }
    .svw-badge.ok { color: #69db7c; }
    .svw-help { margin-top: 6px; } .svw-help code { color: #ffd8a8; }
    .svw-sheet { position: fixed; right: 12px; top: 56px; z-index: 55; width: min(560px, 94vw); max-height: 80vh; overflow: auto;
                 background: var(--bar, #232323); color: var(--text, #ddd); border: 1px solid var(--line, #3a3a3a); border-radius: 8px;
                 box-shadow: 0 10px 40px #000c; padding: 10px 14px; font-size: 12px; outline: none; }
    .svw-sheet header { display: flex; align-items: center; } .svw-sheet header h3 { flex: 1; }
    .svw-sheet footer { margin-top: 10px; display: flex; gap: 8px; align-items: center; }
    .svw-pal { position: fixed; z-index: 70; background: var(--bar, #232323); color: var(--text, #ddd); border: 1px solid var(--line, #3a3a3a);
               border-radius: 6px; box-shadow: 0 6px 20px #000a; padding: 8px; width: 300px; max-height: 60vh; display: flex; flex-direction: column; font-size: 12px; }
    .svw-pal h4 { margin: 0 0 6px; font-size: 12px; color: #fff; }
    .svw-pal input { background: var(--bar2, #2d2d2d); color: inherit; border: 1px solid var(--line, #3a3a3a); border-radius: 4px; padding: 3px 6px; margin-bottom: 6px; font: inherit; }
    .svw-pal .list { overflow: auto; flex: 1; }
    .svw-pal .ven { color: var(--dim, #888); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; margin: 6px 0 2px; cursor: pointer; }
    .svw-pal .ven::before { content: '▸ '; } .svw-pal .ven.open::before { content: '▾ '; }
    .svw-pal a { display: block; padding: 2px 8px; border-radius: 3px; cursor: pointer; }
    .svw-pal a:hover, .svw-pal a.on { background: var(--accent, #ff7a1a); color: #111; }
    .svw-pal .fmt { color: var(--dim, #888); font-size: 10px; margin-left: 4px; }
    .svw-pal .opts { border-top: 1px solid var(--line, #3a3a3a); margin-top: 6px; padding-top: 6px; }
  `);

  // ------------------------------------------------------------------ job API (extension or mock)

  async function wizardStatus() {
    return (await fetch('/api/wizard', { cache: 'no-store' })).json();
  }

  /** Starts a plan and polls it; onProgress(status) on each poll; resolves with the final status. */
  async function runPlan(plan, onProgress) {
    const r = await (await fetch('/api/wizard', { method: 'POST', body: plan })).json();
    if (!r.ok) throw new Error(r.error || 'The wizard job could not start.');
    for (let i = 0; i < 6000; i++) { // up to ~30 minutes (large templates load many plug-ins)
      await sleep(i < 4 ? 120 : 300);
      const st = await wizardStatus();
      if (onProgress) onProgress(st);
      if (st.state !== 'running' && st.state !== 'queued') return st;
    }
    throw new Error('The wizard job did not finish.');
  }
  const cancelJob = () => fetch('/api/wizard?cancel', { method: 'POST', body: '' });

  // ------------------------------------------------------------------ library palette (popover)

  let pal = null;
  const closePalette = () => { if (pal) { pal.remove(); pal = null; } };
  document.addEventListener('mousedown', e => { if (pal && !pal.contains(e.target)) closePalette(); }, true);

  /**
   * Opens the palette of installed instruments (grouped by vendor) at (x, y). onPick(lib | null).
   * opts.extra: HTML appended under the list (e.g. swap options); opts.current: selected lib id.
   */
  function openPalette(x, y, onPick, opts = {}) {
    closePalette();
    const groups = T.palette(INV, HARVEST);
    pal = document.createElement('div');
    pal.className = 'svw-pal';
    pal.innerHTML = `<h4>${esc(opts.title || 'Choose a library')}</h4><input type="text" placeholder="Filter (name or vendor)…">` +
      `<div class="list"></div>${opts.extra || ''}`;
    document.body.appendChild(pal);
    const list = pal.querySelector('.list'), input = pal.querySelector('input');
    const open = new Set(store.get('openVendors', ['Spitfire Audio']));
    const draw = () => {
      const f = input.value.trim().toLowerCase();
      let html = opts.allowNone === false ? '' : `<a data-k="-1" class="${opts.current ? '' : 'on'}">— No instrument —</a>`;
      groups.forEach((g, gi) => {
        const items = g.items.map((it, ii) => [it, ii]).filter(([it]) => !f || (it.label + ' ' + g.vendor).toLowerCase().includes(f));
        if (!items.length) return;
        const isOpen = f || open.has(g.vendor);
        html += `<div class="ven ${isOpen ? 'open' : ''}" data-v="${esc(g.vendor)}">${esc(g.vendor)} (${items.length})</div>`;
        if (isOpen) items.forEach(([it, ii]) => {
          html += `<a data-k="${gi}:${ii}" class="${opts.current === it.id ? 'on' : ''}">${esc(it.label)}<span class="fmt">${esc(it.kind === 'file' ? 'preset' : it.kind.toUpperCase())}</span></a>`;
        });
      });
      list.innerHTML = html || '<div class="dim">Nothing matches.</div>';
    };
    draw();
    input.addEventListener('input', draw);
    pal.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') closePalette();
      if (e.key === 'Enter' && e.target === input) { const a = list.querySelector('a[data-k]:not([data-k="-1"])'); if (a) a.click(); }
    });
    list.addEventListener('click', e => {
      const v = e.target.closest('.ven');
      if (v) { if (open.has(v.dataset.v)) open.delete(v.dataset.v); else open.add(v.dataset.v); store.set('openVendors', [...open]); draw(); return; }
      const a = e.target.closest('a[data-k]');
      if (!a) return;
      let lib = null;
      if (a.dataset.k !== '-1') { const [gi, ii] = a.dataset.k.split(':').map(Number); lib = groups[gi].items[ii]; }
      const p = pal;
      onPick(lib, p);
      if (pal === p && !opts.keepOpen) closePalette();
    });
    const r = pal.getBoundingClientRect();
    pal.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + 'px';
    pal.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
    input.focus();
    return pal;
  }

  // ------------------------------------------------------------------ brief rendering (picker preview, summary, Brief panel)

  /** HTML of a brief: tempo/meter/key line, the form with bar numbers, the prompt. */
  function briefHtml(b) {
    if (!b) return '<p class="dim">No starter brief: an empty ensemble to fill in yourself.</p>';
    const marks = T.formMarkers(b.form);
    return `<div class="svw-bline">${esc(T.briefLine(b))}</div>` +
      `<div class="svw-form">${marks.map((m, i) => `<span class="sec" title="bar ${m.bar}"><b>${esc(m.name)}</b> ${b.form[i][1]}<i>bar ${m.bar}</i></span>`).join('')}</div>` +
      `<p class="svw-prompt">${esc(b.prompt)}</p>`;
  }

  /** Whether a real patch preset loads for a row (✓ patch preset) or only the plug-in (load the patch by hand). */
  function badge(r) {
    if (!r.lib) return '';
    if (r.presetLoaded || (r.lib.kind === 'file' && r.lib.plugin)) return '<span class="svw-badge ok" title="A harvested preset: the plug-in opens with this patch">✓ patch preset</span>';
    if (r.presetPatch) return `<span class="svw-badge" title="No harvested preset for this patch yet">plug-in only — load “${esc(r.presetPatch)}” manually</span>`;
    return '';
  }

  /** HTML table of tracks: name, library, patch hint. */
  function tracksHtml(list) {
    return `<table class="svw-ptable"><tr><th>Track</th><th>Library</th><th>Load inside it</th></tr>` + list.map(t =>
      `<tr><td>${esc(t.name)}</td><td>${esc(t.lib || '—')}${t.badge || ''}</td><td class="patch">${esc(t.patch || '')}</td></tr>`).join('') + '</table>';
  }

  // ------------------------------------------------------------------ dialog

  let dlg = null, rows = [], busy = false, pickCat = 'All', pickId = null;
  const svInstruments = () => (SV.instruments && SV.instruments.all ? SV.instruments.all() : []);
  const currentTemplate = () => T.templateById(store.get('template', T.TEMPLATES[0].id));

  function loadTemplate(id) {
    rows = T.resolveTemplate(id, INV, HARVEST);
    store.set('template', id);
    saveDraft();
  }
  const saveDraft = () => store.set('draft', rows);

  const templateOptions = () => T.byCategory().map(g => `<optgroup label="${esc(g.category)}">` +
    g.templates.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('') + '</optgroup>').join('');

  function open(opts = {}) {
    if (dlg) return;
    const draft = store.get('draft', null);
    if (draft && draft.length) rows = draft; else loadTemplate(store.get('template', T.TEMPLATES[0].id));
    dlg = document.createElement('div');
    dlg.className = 'svw-back';
    dlg.innerHTML = `<div class="svw-dlg" role="dialog" aria-label="New Score">
      <header><h3>New Score</h3><span class="dim">${INV.plugins.length} instruments installed · scanned ${esc(INV.generated || '?')}</span>
        <button class="svw-mini" data-act="close" title="Close (Esc)">✕</button></header>
      <section class="svw-edit">
        <div class="row">Template <select id="svwTpl">${templateOptions()}</select>
          <button class="btn" data-act="load" title="Replace the list with the template">Load</button>
          <button class="btn" data-act="browse" title="Browse the templates by category and read their briefs">Browse ideas…</button>
          <span class="dim" id="svwNote"></span></div>
        <div class="svw-cur" id="svwCur"></div>
        <table class="svw-table"><thead><tr><th></th><th>Track</th><th>Group</th><th></th><th>Notation</th><th>Library</th><th>Patch to load inside it</th><th>Articulation map</th><th></th></tr></thead>
          <tbody id="svwRows"></tbody></table>
        <div class="row" style="margin-top:6px"><button class="btn" data-act="add">+ Add instrument</button>
          <span class="grow"></span>Insert at <select id="svwPos"><option value="-1">end of project</option><option value="0">start of project</option></select></div>
        <div class="dim svw-help">✓ patch preset = the plug-in opens on that patch. More patches: load them in Bitwig, export a DAWproject, then run
          <code>node tools/harvest-presets.mjs &lt;file&gt;</code> and rebuild.</div>
        <div class="svw-warnings" id="svwWarn"></div>
      </section>
      <section class="svw-pick" hidden>
        <div class="svw-cats" id="svwCats"></div>
        <div class="svw-list" id="svwList"></div>
        <div class="svw-preview" id="svwPreview"></div>
      </section>
      <section class="svw-confirm" hidden></section>
      <section class="svw-run" hidden><div id="svwMsg">Starting…</div><div class="svw-bar"><div id="svwBar"></div></div><div class="dim" id="svwStep"></div></section>
      <section class="svw-sum" hidden></section>
      <footer><span class="dim grow" id="svwCount"></span>
        <button class="btn" data-act="back" hidden>Back</button>
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="pickLoad" hidden>Load this template</button>
        <button class="btn primary" data-act="create">Create in Bitwig…</button></footer>
    </div>`;
    document.body.appendChild(dlg);
    const q = s => dlg.querySelector(s);
    q('#svwTpl').value = store.get('template', T.TEMPLATES[0].id);
    q('#svwPos').value = String(store.get('position', -1));
    const showNote = () => { const t = T.templateById(q('#svwTpl').value); q('#svwNote').textContent = t ? t.note : ''; };
    showNote();
    q('#svwTpl').addEventListener('change', showNote);
    q('#svwPos').addEventListener('change', () => store.set('position', +q('#svwPos').value));
    dlg.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' && !busy && !pal) { if (!q('.svw-pick').hidden) view('edit'); else close(); }
    });
    dlg.addEventListener('mousedown', e => { if (e.target === dlg && !busy) close(); });
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onInput);
    drawRows();
    if (opts.browse) openPicker(); else view('edit');
  }

  function close() {
    closePalette();
    if (dlg) { dlg.remove(); dlg = null; }
  }

  /** Switches the dialog between edit / pick / confirm / run / sum. */
  function view(name) {
    const q = s => dlg.querySelector(s);
    ['edit', 'pick', 'confirm', 'run', 'sum'].forEach(v => { q('.svw-' + v).hidden = v !== name; });
    q('[data-act=back]').hidden = name !== 'confirm' && name !== 'pick';
    q('[data-act=pickLoad]').hidden = name !== 'pick';
    q('[data-act=create]').hidden = name === 'run' || name === 'sum' || name === 'pick';
    q('[data-act=create]').textContent = name === 'confirm' ? `Yes, add ${rows.length} tracks` : 'Create in Bitwig…';
    q('[data-act=cancel]').textContent = name === 'run' ? 'Stop' : name === 'sum' ? 'Close' : 'Cancel';
    q('#svwCount').style.visibility = name === 'pick' ? 'hidden' : '';
  }

  // ---- template picker: categories, list, brief preview

  function openPicker() {
    pickId = pickId || store.get('template', T.TEMPLATES[0].id);
    const t = T.templateById(pickId);
    if (t && pickCat !== 'All' && t.category !== pickCat) pickCat = 'All';
    drawPicker();
    view('pick');
  }

  function drawPicker() {
    const q = s => dlg.querySelector(s);
    const groups = T.byCategory();
    q('#svwCats').innerHTML = [['All', T.TEMPLATES.length], ...groups.map(g => [g.category, g.templates.length])].map(([c, n]) =>
      `<button class="svw-cat ${c === pickCat ? 'on' : ''}" data-act="cat" data-cat="${esc(c)}">${esc(c)}<span>${n}</span></button>`).join('');
    q('#svwList').innerHTML = groups.filter(g => pickCat === 'All' || g.category === pickCat).map(g =>
      `<div class="svw-lcat">${esc(g.category)}</div>` + g.templates.map(t =>
        `<a class="svw-card ${t.id === pickId ? 'on' : ''}" data-act="pick" data-id="${t.id}"><b>${esc(t.name)}</b>` +
        `<span>${esc(t.brief ? T.briefLine(t.brief) : t.rows.length + ' tracks')}</span></a>`).join('')).join('');
    const t = T.templateById(pickId);
    if (!t) { q('#svwPreview').innerHTML = ''; return; }
    const resolved = T.resolveTemplate(t.id, INV, HARVEST);
    q('#svwPreview').innerHTML = `<h4>${esc(t.name)}</h4><div class="dim">${esc(t.category)} · ${esc(t.note)}</div>` + briefHtml(t.brief) +
      tracksHtml(resolved.map(r => ({ name: r.name, lib: r.lib ? r.lib.label : '', patch: r.patch, badge: badge(r) })));
  }

  // ---- edit view

  function drawCurrent() {
    const q = s => dlg.querySelector(s);
    const t = currentTemplate();
    q('#svwCur').innerHTML = t && t.brief ? `<b>${esc(t.name)}</b> <span class="dim">${esc(T.briefLine(t.brief))} · ${esc(T.formText(t.brief.form))}</span>` +
      `<details><summary>Starter brief</summary><p class="svw-prompt">${esc(t.brief.prompt)}</p></details>` : '';
  }

  function drawRows() {
    const q = s => dlg.querySelector(s);
    const insts = svInstruments();
    const artOpts = sel => `<option value="">— none —</option>` + INV.noteFx.map((n, i) =>
      `<option value="${i}" ${sel && sel.path === n.path ? 'selected' : ''}>${esc(n.name.replace(/^Articulation Map\s+/, ''))}</option>`).join('');
    q('#svwRows').innerHTML = rows.map((r, i) => `<tr data-i="${i}">
      <td><button class="svw-mini" data-act="up" title="Move up">▲</button><button class="svw-mini" data-act="down" title="Move down">▼</button></td>
      <td><input type="text" class="nm" value="${esc(r.name)}"></td>
      <td><input type="text" class="gr" value="${esc(r.group)}" placeholder="(no group)" list="svwGroups"></td>
      <td><input type="color" class="co" value="${esc(r.color || '#888888')}" title="Track colour"></td>
      <td><select class="sv"><option value="">Automatic</option>${insts.map(x => `<option value="${x.id}" ${x.id === r.sv ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td>
      <td><button class="btn lib ${r.lib ? '' : 'none'}" data-act="lib" title="${esc(r.lib ? r.lib.label + ' (' + (r.lib.kind === 'file' ? r.lib.id : r.lib.kind.toUpperCase()) + ')' : 'No instrument: the track is created empty')}">${esc(r.lib ? r.lib.label : 'no instrument')}</button>${badge(r)}</td>
      <td><textarea class="pt" rows="2" spellcheck="false" placeholder="(nothing to choose)" title="What to load inside the plug-in (shown in the summary and the Brief)">${esc(r.patch || '')}</textarea></td>
      <td><select class="art">${artOpts(r.art)}</select></td>
      <td>${(r.warnings || []).length ? `<span class="warn" title="${esc(r.warnings.join('\n'))}">⚠</span>` : ''}<button class="svw-mini" data-act="del" title="Remove">✕</button></td>
    </tr>`).join('') + `<datalist id="svwGroups">${[...new Set(rows.map(r => r.group).filter(Boolean))].map(g => `<option value="${esc(g)}">`).join('')}</datalist>`;
    drawCurrent();
    updateSummary();
  }

  function updateSummary() {
    const q = s => dlg.querySelector(s);
    const groups = new Set(rows.map(r => r.group.trim()).filter(Boolean));
    q('#svwCount').textContent = `${plural(rows.length, 'track')} · ${plural(groups.size, 'group')} · ${rows.filter(r => r.lib).length} with an instrument`;
    const warn = T.checkRows(rows);
    if (!rows.length) warn.push('Add at least one instrument.');
    q('#svwWarn').innerHTML = warn.map(esc).join('<br>');
  }

  function onInput(e) {
    const t = e.target;
    if (t.id === 'svwOptTempo' || t.id === 'svwOptMarkers') { store.set(t.id === 'svwOptTempo' ? 'optTempo' : 'optMarkers', t.checked); return; }
    const tr = t.closest('tr[data-i]');
    if (!tr || !tr.closest('#svwRows')) return;
    const r = rows[+tr.dataset.i];
    if (t.classList.contains('nm')) r.name = t.value;
    else if (t.classList.contains('gr')) r.group = t.value;
    else if (t.classList.contains('co')) r.color = t.value;
    else if (t.classList.contains('sv')) r.sv = t.value;
    else if (t.classList.contains('pt')) r.patch = t.value;
    else if (t.classList.contains('art')) r.art = t.value === '' ? null : { path: INV.noteFx[+t.value].path, label: INV.noteFx[+t.value].name };
    else return;
    saveDraft();
    updateSummary();
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, tr = b.closest('tr[data-i]'), i = tr ? +tr.dataset.i : -1;
    const q = s => dlg.querySelector(s);
    switch (act) {
      case 'close': if (!busy) close(); break;
      case 'load': loadTemplate(q('#svwTpl').value); drawRows(); break;
      case 'browse': pickId = q('#svwTpl').value; openPicker(); break;
      case 'cat': pickCat = b.dataset.cat; drawPicker(); break;
      case 'pick': pickId = b.dataset.id; drawPicker(); break;
      case 'pickLoad':
        if (!pickId) break;
        loadTemplate(pickId);
        q('#svwTpl').value = pickId;
        q('#svwTpl').dispatchEvent(new Event('change'));
        drawRows();
        view('edit');
        break;
      case 'add': {
        const last = rows[rows.length - 1];
        rows.push({ name: 'Instrument ' + (rows.length + 1), group: last ? last.group : '', color: last ? last.color : T.COLORS.synth,
                    sv: '', lib: last ? last.lib : null, art: null, patch: '', warnings: [] });
        saveDraft(); drawRows();
        const inputs = dlg.querySelectorAll('input.nm');
        inputs[inputs.length - 1].select();
        break;
      }
      case 'del': rows.splice(i, 1); saveDraft(); drawRows(); break;
      case 'up': case 'down': {
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= rows.length) break;
        [rows[i], rows[j]] = [rows[j], rows[i]];
        saveDraft(); drawRows();
        break;
      }
      case 'lib': {
        const br = b.getBoundingClientRect();
        openPalette(br.left, br.bottom + 2, lib => {
          const r = rows[i];
          r.lib = lib;
          r.warnings = [];
          r.presetLoaded = !!(lib && lib.kind === 'file' && lib.plugin);
          if (r.art && !(lib && (lib.plugin || lib.label) === 'BBC Symphony Orchestra')) r.warnings.push('The articulation map is meant for BBC SO.');
          saveDraft(); drawRows();
        }, { current: rows[i].lib && rows[i].lib.id, title: 'Library for ' + rows[i].name });
        break;
      }
      case 'create':
        if (q('.svw-edit').hidden) run(); else confirmView();
        break;
      case 'back': view('edit'); break;
      case 'cancel':
        if (busy) { cancelJob(); q('#svwMsg').textContent = 'Stopping after the current step…'; }
        else close();
        break;
      default: break;
    }
  }

  /** Starter settings the user chose in the confirmation: { tempo, meter, markers } (empty when none). */
  function starterOptions() {
    const t = currentTemplate(), b = t && t.brief;
    if (!b || !dlg) return {};
    const tempoBox = dlg.querySelector('#svwOptTempo'), markBox = dlg.querySelector('#svwOptMarkers');
    const out = {};
    if (tempoBox && tempoBox.checked) { out.tempo = b.tempo; out.meter = b.meter; }
    if (markBox && markBox.checked) out.markers = T.formMarkers(b.form);
    return out;
  }

  function confirmView() {
    if (!rows.length) return;
    const q = s => dlg.querySelector(s);
    const groups = [...new Set(rows.map(r => r.group.trim()).filter(Boolean))];
    const plugins = rows.filter(r => r.lib).length;
    const t = currentTemplate(), b = t && t.brief;
    const marks = b ? T.formMarkers(b.form) : [];
    q('.svw-confirm').innerHTML = `<p>This changes the project that is open in Bitwig: it adds <b>${rows.length} instrument tracks</b>` +
      (groups.length ? ` in <b>${plural(groups.length, 'group')}</b> (${groups.map(esc).join(', ')})` : '') +
      ` and loads <b>${plugins} plug-in instance${plugins === 1 ? '' : 's'}</b>` +
      (rows.some(r => r.art) ? ' plus their articulation maps' : '') + '.</p>' +
      (b ? `<div class="svw-opts"><b>Starter settings from “${esc(t.name)}”</b>` +
        `<label><input type="checkbox" id="svwOptTempo" ${store.get('optTempo', true) ? 'checked' : ''}> Set tempo &amp; meter: ` +
        `<b>${b.tempo} BPM, ${T.meterText(b.meter)}</b> <span class="dim">(the project’s tempo and time signature)</span></label>` +
        `<label><input type="checkbox" id="svwOptMarkers" ${store.get('optMarkers', true) ? 'checked' : ''}> Add section markers: ` +
        `<b>${marks.map(m => `${esc(m.name)} (bar ${m.bar})`).join(', ')}</b> <span class="dim">(arranger cue markers; skipped while playing)</span></label></div>` : '') +
      '<p>Large libraries take a while to load; Bitwig\'s track selection moves while the wizard works. Every step is a normal ' +
      'Bitwig change, so <b>Edit → Undo</b> in Bitwig removes them again (one step at a time).</p>' +
      '<p class="dim">Tip: try it in a new, empty project first (File → New in Bitwig).</p>';
    view('confirm');
  }

  async function run() {
    const q = s => dlg.querySelector(s);
    const starter = starterOptions();
    busy = true;
    view('run');
    const plan = T.buildPlan(rows, { position: +q('#svwPos').value, ...starter });
    const planned = rows.map(r => ({ ...r }));
    let st;
    try {
      st = await runPlan(plan, s => {
        if (!dlg) return;
        q('#svwMsg').textContent = s.message || '';
        q('#svwStep').textContent = s.steps ? `Step ${s.step} of ${s.steps}` : '';
        q('#svwBar').style.width = (s.steps ? Math.round(100 * s.step / s.steps) : 0) + '%';
      });
    } catch (err) {
      st = { state: 'error', message: err.message, tracks: [], groups: [], settings: [], errors: [err.message], notes: [] };
    }
    busy = false;
    let sheet = null;
    if (st.state === 'done' || st.state === 'error' || st.state === 'cancelled') {
      applyNotation(planned, st);
      const made = planned.filter((r, i) => ((st.tracks || [])[i] || {}).created);
      if (made.length) { sheet = T.starterSheet(currentTemplate(), made); store.set('sheet', sheet); }
      if (made.length && (st.tracks || []).some(t => t.created) && SV.newScore) startFreshScore(currentTemplate(), made);
    }
    if (!dlg) return;
    q('.svw-sum').innerHTML = summaryHtml(st, planned, sheet);
    view('sum');
  }

  /**
   * A new ensemble gets a fresh, empty score in Score View: its staves (with groups), the template's meter,
   * its form length and section names as rehearsal marks — nothing from the previous project.
   */
  function startFreshScore(t, made) {
    const b = t && t.brief;
    const meter = b && b.meter ? { num: b.meter[0], den: b.meter[1] } : null;
    const ts = meter || { num: (SV.state.liveData && SV.state.liveData.num) || 4, den: (SV.state.liveData && SV.state.liveData.den) || 4 };
    const barBeats = ts.num * 4 / ts.den;
    const bars = b && b.form ? T.formBars(b.form) : 8;
    const markers = [];
    if (b && b.form) { let bar = 0; b.form.forEach(([name, n]) => { markers.push({ beat: bar * barBeats, name }); bar += Math.max(1, n | 0); }); }
    SV.newScore({ title: t ? t.name : 'New score', timeSig: ts, lengthBeats: bars * barBeats, markers,
      parts: made.map(r => ({ name: r.name, group: r.group || undefined })) });
  }

  /** Remembers each created track's notation instrument (instruments.js override) when the name alone would not find it. */
  function applyNotation(planned, st) {
    const I = SV.instruments;
    if (!I || !I.setOverride) return;
    planned.forEach((r, i) => {
      const t = (st.tracks || [])[i];
      if (!r.sv || !t || !t.created) return;
      const auto = I.lookup(r.name, r.group);
      if (!auto || auto.id !== r.sv) I.setOverride(r.name, r.sv);
    });
  }

  function summaryHtml(st, planned, sheet) {
    const tracks = st.tracks || [];
    const ok = tracks.filter(t => t.created).length;
    let html = `<p><b>${esc(st.message || st.state)}</b></p>`;
    if ((st.settings || []).length) html += '<ul class="svw-set">' + st.settings.map(s =>
      `<li><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✗'}</span> ${esc(s.text)}</li>`).join('') + '</ul>';
    html += '<ul>' + tracks.map((t, i) => {
      const devs = (t.devices || []).map(d => `<span class="${d.ok ? 'ok' : 'bad'}">${d.ok ? '✓' : '✗'} ${esc(d.text)}</span>`).join(', ');
      const grp = t.group ? (t.grouped ? ` <span class="dim">in ${esc(t.group)}</span>` : ` <span class="bad">not in ${esc(t.group)}${t.groupMsg ? ': ' + esc(t.groupMsg) : ''}</span>`) : '';
      const patch = t.created && planned[i] && planned[i].patch ? `<div class="svw-load">→ load: ${esc(planned[i].patch)}</div>` : '';
      return `<li><span class="${t.created ? 'ok' : 'bad'}">${t.created ? '✓' : '✗'}</span> ${esc(t.name)}${grp}${devs ? ' — ' + devs : ''}${patch}</li>`;
    }).join('') + '</ul>';
    if ((st.groups || []).some(g => !g.ok)) html += '<p class="bad">Groups: ' + st.groups.filter(g => !g.ok).map(g => esc(g.name + (g.msg ? ' — ' + g.msg : ''))).join('; ') + '</p>';
    if ((st.errors || []).length) html += '<p><b>Problems</b></p><ul>' + st.errors.map(e => `<li class="bad">${esc(e)}</li>`).join('') + '</ul>';
    if ((st.notes || []).length) html += '<ul class="dim">' + st.notes.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>';
    const plugins = planned.filter(r => r.lib && r.lib.kind !== 'file').map(r => r.lib.label);
    if (ok && plugins.length) html += '<p class="dim">Next: choose the patch inside each plug-in (the "→ load" lines). The API cannot pick patches ' +
      'inside plug-ins; to automate it, save each configured instrument as a Bitwig preset and pick it under "Presets" in the library palette.</p>';
    if (sheet && sheet.brief) html += `<div class="svw-sumbrief"><b>${esc(sheet.name)}</b>${briefHtml(sheet.brief)}</div>`;
    if (sheet) html += '<p class="dim">Saved as the starter sheet: open it any time with <b>Brief</b> in the toolbar.</p>';
    return html;
  }

  // ------------------------------------------------------------------ starter sheet panel (Brief button)

  let sheetEl = null;
  const closeSheet = () => { if (sheetEl) { sheetEl.remove(); sheetEl = null; } };

  function openSheet() {
    if (sheetEl) { closeSheet(); return; }
    const sheet = store.get('sheet', null);
    sheetEl = document.createElement('div');
    sheetEl.className = 'svw-sheet';
    sheetEl.setAttribute('role', 'dialog');
    sheetEl.innerHTML = `<header><h3>${esc(sheet ? sheet.name : 'Starter brief')}</h3><button class="svw-mini" data-act="x" title="Close (Esc)">✕</button></header>` +
      (sheet ? `<div class="dim">${esc([sheet.category, sheet.created].filter(Boolean).join(' · '))}</div>` + briefHtml(sheet.brief) + tracksHtml(sheet.tracks) +
        '<footer><button class="btn" data-act="copy">Copy as text</button><span class="dim" id="svwCopied"></span></footer>'
        : '<p>No starter sheet yet. Create tracks from a template with <b>New Score…</b>: its brief (tempo, form, prompt) and the patch ' +
          'to load in each plug-in are kept here while you compose.</p><footer><button class="btn" data-act="browse">Browse ideas…</button></footer>');
    document.body.appendChild(sheetEl);
    sheetEl.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeSheet(); });
    sheetEl.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'x') closeSheet();
      else if (b.dataset.act === 'browse') { closeSheet(); open({ browse: true }); }
      else if (b.dataset.act === 'copy') {
        const done = msg => { const s = sheetEl && sheetEl.querySelector('#svwCopied'); if (s) s.textContent = msg; };
        try { navigator.clipboard.writeText(T.sheetText(sheet)).then(() => done('Copied.'), () => done('Copy failed.')); } catch (err) { done('Copy failed.'); }
      }
    });
    sheetEl.tabIndex = -1;
    sheetEl.focus();
  }

  // ------------------------------------------------------------------ swap library (per staff)

  /** Track index (extension bank) for a part name, from the live track list. */
  function trackIndexOf(name) {
    const clean = String(name).replace(/\s*✎\s*$/, '').trim();
    const t = ((SV.state.liveData || {}).tracks || []).find(x => x.name === clean);
    return t ? { index: t.index, name: t.name } : null;
  }

  function openSwap(partName, x, y) {
    const t = trackIndexOf(partName);
    if (!t) { SV.flash('Swap library: "' + partName + '" is not a track in the open Bitwig project.'); return; }
    const mode = store.get('swapMode', 'disable');
    const extra = `<div class="opts"><label><input type="radio" name="svwMode" value="disable" ${mode === 'disable' ? 'checked' : ''}> Keep the old instrument, disabled</label><br>` +
      `<label><input type="radio" name="svwMode" value="replace" ${mode === 'replace' ? 'checked' : ''}> Replace it</label>` +
      `<div class="dim" style="margin-top:4px">Changes the track in Bitwig (undo with Edit → Undo).</div></div>`;
    openPalette(x, y, async (lib, p) => {
      if (!lib) return;
      const m = (p.querySelector('input[name=svwMode]:checked') || {}).value || 'disable';
      store.set('swapMode', m);
      SV.flash(`Loading ${lib.label} on ${t.name}…`);
      try {
        const st = await runPlan(T.buildSwapPlan({ trackIndex: t.index, trackName: t.name, lib, mode: m }));
        const errs = (st.errors || []).join('; ');
        SV.flash(st.state === 'done' ? `${t.name}: ${lib.label} loaded` + (m === 'disable' ? ' (old instrument disabled)' : '') : `${t.name}: swap failed — ${errs || st.message}`);
      } catch (err) {
        SV.flash('Swap failed: ' + err.message);
      }
    }, { title: 'Swap library — ' + t.name, extra, allowNone: false });
  }

  // ------------------------------------------------------------------ toolbar

  const bar = SV.addToolbar('<button class="btn" id="svwOpen" title="Create an ensemble\'s tracks in Bitwig (names, groups, colours, libraries, articulation maps) from a template">New Score…</button>' +
    '<button class="btn" id="svwBriefBtn" title="Starter brief of the last New Score: tempo, form, compositional prompt and what to load in each plug-in">Brief</button>', { cluster: 'file', order: 200 });
  bar.querySelector('#svwOpen').addEventListener('click', () => open());
  bar.querySelector('#svwBriefBtn').addEventListener('click', openSheet);
  document.addEventListener('mousedown', e => {
    if (sheetEl && !sheetEl.contains(e.target) && e.target.id !== 'svwBriefBtn') closeSheet();
  }, true);
  SV.wizard = { open, close, openSwap, openPalette, runPlan, status: wizardStatus, rows: () => rows, openSheet, closeSheet,
    sheet: () => store.get('sheet', null) };
})(typeof window !== 'undefined' ? window : this);
