// Feature module: sections. See docs/AGENTS.md for the SV hook API.
//  * Section views: show one Bitwig group (Strings, Brass, ...) plus the live clip's track, everything (Full)
//    or the pinned tracks; "Follow section" switches to the group of the clip selected in Bitwig.
//  * Standard orchestral score order (or Bitwig's track order), with a bracket per family/section.
// The name matcher (scoreInfo) is pure and exported for Node tests via module.exports.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ orchestral score order

  // Families in score order; `bracket` is the bracket the family's staves share.
  const ORDER = [];
  const add = (family, bracket, entries) => entries.forEach(([id, words]) =>
    ORDER.push({ id, family, bracket, words, rank: ORDER.length }));
  add('woodwinds', 'Woodwinds', [
    ['piccolo', [['piccolo'], ['picc']]],
    ['flute', [['flute']]],
    ['altoFlute', [['alto', 'flute']]],
    ['oboe', [['oboe']]],
    ['corAnglais', [['cor', 'anglais'], ['english', 'horn']]],
    ['ebClarinet', [['eb', 'clarinet']]],
    ['clarinet', [['clarinet']]],
    ['bassClarinet', [['bass', 'clarinet'], ['bs', 'clarinet']]],
    ['saxophone', [['saxophone'], ['sax']]],
    ['bassoon', [['bassoon']]],
    ['contrabassoon', [['contrabassoon'], ['contra', 'bassoon'], ['contrafagotto']]],
    ['woodwinds', [['woodwind'], ['winds'], ['wind']]],
  ]);
  add('brass', 'Brass', [
    ['horn', [['horn'], ['cor']]],
    ['trumpet', [['trumpet'], ['cornet'], ['flugelhorn']]],
    ['trombone', [['trombone']]],
    ['bassTrombone', [['bass', 'trombone'], ['bs', 'trombone']]],
    ['tuba', [['tuba'], ['cimbasso']]],
    ['brass', [['brass']]],
  ]);
  add('timpani', 'Percussion', [['timpani', [['timpani'], ['timp'], ['timps'], ['kettledrum']]]]);
  add('percussion', 'Percussion', [['percussion', [['percussion'], ['perc'], ['drum'], ['drums'], ['snare'], ['cymbal'],
    ['cymbals'], ['glockenspiel'], ['glock'], ['xylophone'], ['marimba'], ['vibraphone'], ['triangle'], ['gong'],
    ['tamtam'], ['tam', 'tam'], ['bells'], ['chimes'], ['tambourine'], ['taiko']]]]);
  add('harp', 'Harp', [['harp', [['harp']]]]);
  add('keyboards', 'Keyboards', [['keyboards', [['celesta'], ['celeste'], ['piano'], ['organ'], ['harpsichord'], ['keyboard'], ['keys']]]]);
  add('other', 'Other', [['other', [['synth'], ['synthesizer'], ['pad'], ['lead'], ['choir'], ['voice'], ['vocals']]]]);
  add('soloStrings', 'Strings', [
    ['soloViolin', [['solo', 'violin']]], ['soloViola', [['solo', 'viola']]],
    ['soloCello', [['solo', 'cello']]], ['soloBass', [['solo', 'bass']]],
  ]);
  add('strings', 'Strings', [
    ['strings', [['strings'], ['string']]],
    ['violin1', [['violin', '#1']]],
    ['violin2', [['violin', '#2']]],
    ['viola', [['viola']]],
    ['cello', [['cello'], ['violoncello'], ['vc']]],
    ['bass', [['contrabass'], ['double', 'bass'], ['bass'], ['db'], ['cb']]],
  ]);
  const OTHER = ORDER.find(e => e.id === 'other');
  const FIRST = { 1: ['1', 'i', 'one', 'first', '1st'], 2: ['2', 'ii', 'two', 'second', '2nd'] };

  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 2;
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = t;
      }
    }
    return prev[b.length];
  }

  // Word match tolerant of plurals and one-letter typos ("Tumpets", "Basoons", "Pecussion") for longer words.
  function wordIs(token, word, fuzzy) {
    for (const form of [word, word + 's', word + 'es']) {
      if (token === form) return true;
      if (fuzzy && form.length >= 5 && token.length >= 5 && editDistance(token, form) <= 1) return true;
    }
    return false;
  }

  const tokenize = name => String(name).toLowerCase().replace(/✎/g, '').replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/).filter(Boolean);

  // Every required word must be present ('#1' / '#2' = an ordinal, for violins).
  function matches(tokens, words, fuzzy) {
    const used = new Set();
    return words.every(w => {
      if (w[0] === '#') return tokens.some(t => FIRST[w[1]].includes(t));
      const i = tokens.findIndex((t, k) => !used.has(k) && wordIs(t, w, fuzzy));
      if (i < 0) return false;
      used.add(i);
      return true;
    });
  }

  // Own matcher: { id, family, bracket, rank } for an instrument/track name (unknown names -> "other").
  // Exact words first; typo-tolerant matching only when nothing matches exactly ("Bass" is not "Brass").
  function matchName(name) {
    const tokens = tokenize(name);
    for (const fuzzy of [false, true]) {
      let best = null, bestLen = 0;
      ORDER.forEach(e => e.words.forEach(words => {
        // More specific requirements (more words) win: "Bass Clarinet" over "Bass", "English Horn" over "Horn".
        if (words.length > bestLen && matches(tokens, words, fuzzy)) { best = e; bestLen = words.length; }
      }));
      if (!best && tokens.some(t => wordIs(t, 'violin', fuzzy))) best = ORDER.find(e => e.id === 'violin1');
      if (best) return best;
    }
    return OTHER;
  }

  // Score position and bracket for a track name. `rank` comes from SV.instruments.lookup(name).scoreOrder when
  // another module provides it (`external: true`), else from the own matcher; the bracket is always our own.
  function scoreInfo(name) {
    const own = matchName(name);
    const info = { id: own.id, family: own.family, bracket: own.bracket, rank: own.rank, ownRank: own.rank };
    const ins = root.SV && root.SV.instruments && typeof root.SV.instruments.lookup === 'function'
      ? safe(() => root.SV.instruments.lookup(name)) : null;
    if (ins && typeof ins.scoreOrder === 'number') { info.rank = ins.scoreOrder; info.external = true; }
    return info;
  }
  const safe = fn => { try { return fn(); } catch (e) { return null; } };

  // Stable sort of parts into score order; returns a new array. External ranks are used only when every part
  // has one (the two scales don't mix).
  function scoreOrder(parts, nameOf) {
    nameOf = nameOf || (p => p.name);
    const infos = parts.map(p => scoreInfo(nameOf(p)));
    const ext = infos.length && infos.every(x => x.external);
    return parts.map((p, i) => ({ p, i, r: ext ? infos[i].rank : infos[i].ownRank }))
      .sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.p);
  }

  const api = { scoreInfo, scoreOrder, matchName, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.SV || !root.document) return;

  // ------------------------------------------------------------------ UI (browser only)

  const SV = root.SV;
  SV.sections = api;
  const KEY = 'scoreview.sections.';
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const prefs = {
    section: store.get('section', 'pinned'),  // 'pinned' | 'full' | <group name>
    follow: store.get('follow', false),
    order: store.get('order', 'score'),       // 'score' | 'bitwig'
  };
  const cleanName = n => String(n).replace(/ ✎$/, '');
  const groups = () => {
    const base = SV.state.base;
    return base ? [...new Set(base.parts.map(p => p.group).filter(Boolean))] : [];
  };
  const groupOf = name => {
    const base = SV.state.base, p = base && base.parts.find(x => x.name === cleanName(name));
    return p ? p.group || null : null;
  };

  SV.addStyle(`
    #svSections .seg button { padding: 3px 9px; }
    #svSections .lbl { color: var(--dim); font-size: 12px; }
    #svSections label { white-space: nowrap; }
  `);
  const bar = SV.addToolbar('<span class="lbl">Section</span><div class="seg" id="svSectionSeg"></div>' +
    '<label title="Switch to the section of the clip you select in Bitwig"><input type="checkbox" id="svSectionFollow"> Follow section</label>' +
    '<div class="seg" id="svOrderSeg"><button data-order="score" title="Standard orchestral order: woodwinds, brass, percussion, harp, keyboards, strings">Score order</button>' +
    '<button data-order="bitwig" title="Tracks in the order of the Bitwig project">Bitwig order</button></div>', { cluster: 'score', order: 30 });
  bar.id = 'svSections';
  const seg = bar.querySelector('#svSectionSeg');
  const followBox = bar.querySelector('#svSectionFollow');
  followBox.checked = prefs.follow;
  let segSig = '';

  function refreshBar() {
    const show = SV.state.mode === 'score' && !!SV.state.base;
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    const gs = groups();
    const sig = gs.join('|');
    if (sig !== segSig) {
      segSig = sig;
      const btn = (v, t, title) => `<button data-section="${esc(v)}" title="${esc(title)}">${esc(t)}</button>`;
      seg.innerHTML = btn('full', 'Full', 'All tracks') + gs.map(g => btn(g, g, g + ' + the selected clip\'s track')).join('') +
        btn('pinned', 'Pinned', 'Pinned tracks + the selected clip\'s track (Tracks menu)');
    }
    const cur = gs.includes(prefs.section) || prefs.section === 'full' ? prefs.section : 'pinned';
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.section === cur));
    bar.querySelectorAll('#svOrderSeg button').forEach(b => b.classList.toggle('on', b.dataset.order === prefs.order));
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function update() {
    refreshBar();
    if (SV.renderTrackList) SV.renderTrackList();
    SV.render();
  }

  function setSection(s) {
    prefs.section = s;
    store.set('section', s);
    update();
  }

  // features/arrangement.js after a read (preference 'show all tracks'): a group section would hide the other staves.
  api.showAll = () => { if (prefs.section !== 'full' && prefs.section !== 'pinned') setSection('full'); };
  seg.addEventListener('click', e => { const s = e.target.dataset.section; if (s) setSection(s); });
  followBox.addEventListener('change', () => {
    prefs.follow = followBox.checked;
    store.set('follow', prefs.follow);
    if (prefs.follow) followTrack(SV.currentTrack(), true);
  });
  bar.querySelector('#svOrderSeg').addEventListener('click', e => {
    const o = e.target.dataset.order;
    if (!o) return;
    prefs.order = o;
    store.set('order', o);
    update();
  });

  // Visible tracks: a section shows its group plus the live clip's track.
  SV.hooks.visibleTracks.push((shown, all) => {
    if (SV.state.mode !== 'score' || !SV.state.base || prefs.section === 'pinned') return undefined;
    if (prefs.section === 'full') return new Set(all);
    if (!groups().includes(prefs.section)) return undefined;
    const names = new Set(all.filter(n => groupOf(n) === prefs.section));
    const cur = SV.currentTrack();
    if (cur) names.add(cur);
    return names;
  });

  // Follow section: the shown section becomes the group of the clip selected in Bitwig.
  let lastTrack = null;
  function followTrack(track, force) {
    if (!track || (!force && track === lastTrack)) return;
    lastTrack = track;
    if (!prefs.follow || SV.state.mode !== 'score') return;
    const g = groupOf(track);
    if (g && g !== prefs.section) {
      prefs.section = g;
      store.set('section', g);
      refreshBar();
      if (SV.renderTrackList) SV.renderTrackList();
      // The page core renders after the liveData hooks when the clip changed; render here only when forced.
      if (force) SV.render();
    }
  }
  SV.hooks.liveData.push(d => { if (d && d.exists) followTrack(d.track, false); });

  // Score order and brackets.
  SV.hooks.transformScore.push((score, ctx) => {
    refreshBar();
    if (ctx.mode !== 'score' || !SV.state.base) return score;
    let parts = score.parts;
    if (prefs.order === 'score') parts = scoreOrder(parts, p => cleanName(p.name));
    parts = parts.map(p => {
      if (p.group) return p;
      const g = prefs.order === 'score' ? scoreInfo(cleanName(p.name)).bracket : groupOf(p.name);
      return g ? { ...p, group: g } : p;
    });
    const nGroups = new Set(parts.map(p => p.group).filter(Boolean)).size;
    return { ...score, parts, groupLabels: nGroups > 1 };
  });
  // Section names: Verovio prints a bracket's label in the same column as the staff names, so they are turned
  // vertical and moved left of the staff names (score.js marks them bold italic; room comes from the margin).
  SV.hooks.buildOptions.push((b, vrv, score) => {
    if (score.groupLabels) vrv.pageMarginLeft = (vrv.pageMarginLeft || 0) + 70;
  });
  function placeGroupLabels() {
    document.querySelectorAll('#paper g.system').forEach(sys => {
      const labels = [...sys.querySelectorAll(':scope > g.label')];
      const isGroup = g => !!g.querySelector('tspan.rend[font-style="italic"][font-weight="bold"]');
      const groupLabels = labels.filter(isGroup);
      if (!groupLabels.length) return;
      let left = Infinity;
      labels.filter(g => !isGroup(g)).forEach(g => { const bb = g.getBBox(); if (bb.width) left = Math.min(left, bb.x); });
      groupLabels.forEach(g => {
        const t = g.querySelector('text');
        const sizeEl = t.querySelector('tspan[font-size]');
        const fs = sizeEl ? parseFloat(sizeEl.getAttribute('font-size')) : 400;
        const x = (left === Infinity ? parseFloat(t.getAttribute('x')) : left) - fs * 0.6;
        const y = parseFloat(t.getAttribute('y')) - fs * 0.3;
        t.setAttribute('x', x);
        t.setAttribute('y', y);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('transform', `rotate(-90 ${x} ${y})`);
        t.style.fill = '#555';
      });
    });
  }
  SV.hooks.afterRender.push(placeGroupLabels);
  SV.hooks.afterRender.push(refreshBar);
  root.addEventListener('sv-ready', refreshBar);
  refreshBar();
})(typeof window !== 'undefined' ? window : globalThis);
