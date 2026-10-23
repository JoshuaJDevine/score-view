// Score View front end.
//  Clip mode:  the selected Bitwig clip, live and editable.
//  Score mode: a DAWproject export (watched for re-exports) for every track, showing pinned tracks plus
//              the selected clip's track, with the selected clip overlaid live and editable.
//
// The page core is split into classic scripts (no bundler, no ES modules), loaded in this order by index.html:
//   core/guard.js      fetch wrapper adding X-ScoreView to /api requests (first script on the page)
//   core/base.js       window.SV, the internal namespace SV.core, state, preferences, feature hooks
//   core/shortcuts.js  SV.shortcuts: the keyboard shortcut registry (descriptive) and the help table
//   core/sources.js    note sources: live clip, clip placement, overlays, visible tracks, the score model
//   core/svg-inline.js Verovio glyph <use>s -> inline <path>s (window.SvgInline; also loads in Node)
//   core/chunks.js     chunked engraving plans: system breaks, hidden staves, cache keys (window.ScoreChunks; Node too)
//   core/engrave.js    the engraving engine: Web Workers (core/engrave-worker.js), main-thread fallback, SVG cache
//   core/render.js     render pipeline (render / requestRender / rendered), status line, selection + playhead paint, SV.geom
//   core/net.js        Bitwig connection: /api/notes and /api/play polling, send()
//   core/project.js    DAWproject base layer (watched file), fresh / new scores
//   core/tracks.js     the Tracks ▾ picker and pins
//   core/selection.js  live-note editing: selection, moves, resizes
//   core/keyboard.js   built-in shortcuts (after SV.hooks.keydown)
//   core/hit.js        paper clicks, noteAt, hitTest
//   core/ui.js         flash, toolbar controls, file open / drag and drop
//   core/api.js        the public SV API for feature modules (docs/AGENTS.md)
//   core/start.js      start-up: Verovio, polling, 'sv-ready'
// Each file is an IIFE that reads and adds to SV.core (internal; feature modules use the public SV.* API only).
// Cross-file calls go through SV.core at call time, so only start-up code depends on the load order.

(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const SB = window.ScoreBuilder;
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('scoreview.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('scoreview.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const state = {
    // view = the Clip / Score buttons; mode, range and trackMode follow from it (core/ui.js applyView)
    view: store.get('view', store.get('mode', 'clip')), scoreShow: store.get('scoreShow', 'all'),
    mode: store.get('mode', 'clip'), source: 'arranger', layout: 'page',
    liveData: null,
    base: null,                        // parsed DAWproject
    baseMtime: 0,
    overlays: new Map(),               // "track@offset" -> { track, offset, length, notes } snapshots of edited clips
    editedTracks: new Set(),           // tracks edited from Score View since the base was loaded
    lastEditMs: 0,                     // when Score View last sent note edits (core/net.js send)
    trackSince: 0,                     // when the selected clip's track last changed
    settledAt: 0,                      // when hooks.liveSettled last ran (core/net.js)
    align: null,                       // { track, key, offset, how: 'match'|'playhead'|'manual'|'guess'|'mirror', cands } live clip placement
    playPos: -1,                       // arranger playhead (beats), for choosing between equally good placements
    trackMode: 'all',                  // 'pinned' (pins + selected clip's track) | 'all'; set by applyView
    pinned: new Set(store.get('pinned', [])),
    range: 'all',                      // 'clip' | 'all'; set by applyView (print / export change it for one render)
    selection: new Set(),              // live note ids "Lch_x_y"
    render: null,                      // replaced by an accessor in core/render.js (a pending requestRender runs on read)
    playBeat: -1, playing: false, connected: false,
  };

  // ------------------------------------------------------------------ feature hooks (see docs/AGENTS.md)
  // Feature modules in web/features/ register here instead of editing the core.
  //
  // Order: hooks run in registration order, i.e. the order of the <script> tags in index.html, then the order of the
  // push() calls inside a module (notation.js unshift()s its transformScore hook so it runs first). For the hooks that
  // stop at the first handler returning true (keydown, noteClick, paperClick, paperMouseDown) the order decides who
  // wins a key or click, so reordering the scripts changes behaviour. test/hook-order-e2e.mjs pins the order of the
  // shipped modules (SV.hookOrder() lists the registering script of every hook); update its table on purpose only.
  const hooks = {
    transformScore: [], // fn(score, ctx) -> score|undefined   before engraving; may edit parts/notes/directions
    buildOptions: [],   // fn(buildOpts, verovioOpts, score)   before buildMEI / Verovio rendering
    afterRender: [],    // fn(render)                          after the SVG is in the page
    keydown: [],        // fn(e) -> true if handled            before built-in shortcuts
    noteClick: [],      // fn(timelineEntry, e) -> true        before built-in selection
    paperClick: [],     // fn(e, hit) -> true                  click that did not hit a note; hit = SV.hitTest(e)
    paperMouseDown: [], // fn(e, noteEl|null) -> true          any left/right press on the paper, before the built-in click
    liveData: [],       // fn(liveData)                        every change from Bitwig
    liveSettled: [],    // fn(liveData)                        once the extension reports settled data (d.settled; else SETTLE_MS of quiet): safe after a clip switch
    play: [],           // fn({playing, step, pos, ...})       ~20x per second
    visibleTracks: [],  // fn(namesSet, allNames) -> Set|undefined   score mode: which tracks to show (first Set wins)
  };
  const runHooks = (name, ...args) => {
    for (const fn of hooks[name]) {
      try { const r = fn(...args); if (r === true) return true; } catch (err) { console.error('hook ' + name, err); }
    }
    return false;
  };

  // Records which script registered each hook (document.currentScript while a classic script runs; '(runtime)' for
  // hooks added later, e.g. from an event handler). The arrays stay plain arrays: push/unshift are only wrapped.
  const hookOrigin = new WeakMap();
  const currentScriptName = () => {
    const s = document.currentScript;
    return (s && s.getAttribute('src')) || '(runtime)';
  };
  Object.keys(hooks).forEach(name => {
    const arr = hooks[name];
    ['push', 'unshift'].forEach(m => {
      Object.defineProperty(arr, m, {
        configurable: true, writable: true, enumerable: false,
        value(...fns) {
          const who = currentScriptName();
          fns.forEach(fn => { if (typeof fn === 'function' && !hookOrigin.has(fn)) hookOrigin.set(fn, who); });
          return Array.prototype[m].apply(this, fns);
        },
      });
    });
  });
  /** { hookName: [registering script, ...] } in run order, e.g. { keydown: ['features/articulations.js', ...] }. */
  const hookOrder = () => {
    const out = {};
    Object.keys(hooks).forEach(name => { out[name] = hooks[name].map(fn => hookOrigin.get(fn) || '(unknown)'); });
    return out;
  };

  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const keyName = f => ['G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯'][f + 6];

  const live = location.protocol.startsWith('http');
  // The address the page is served from (the extension's port is not fixed); outside Bitwig (file://) the default.
  const DEFAULT_HOST = 'localhost:8765';
  const serverHost = () => (live && location.host) || DEFAULT_HOST;

  const core = {
    $, SB, TPQ: SB.TPQ, live, serverHost, store, state, hooks, runHooks, hookOrder, escapeHtml, keyName,
    tk: null, // the Verovio toolkit, set by core/start.js once the engine is loaded
  };
  window.SV = { state, hooks, ScoreBuilder: SB, TPQ: SB.TPQ, hookOrder, core };
})();
