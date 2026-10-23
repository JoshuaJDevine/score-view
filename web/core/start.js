// Score View page core: start-up. Runs before the feature modules load; the rest waits for Verovio, then the first
// render, polling and the 'sv-ready' event.
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, store, live } = C;

  // Shortcut help: one line by default, expandable; remembered per browser.
  $('helpToggle').addEventListener('click', () => {
    const open = $('help').classList.toggle('open');
    $('helpToggle').textContent = open ? 'Shortcuts ▴' : 'Shortcuts ▾';
    store.set('helpOpen', open);
  });
  if (store.get('helpOpen', false)) $('helpToggle').click();

  C.applyView(); // the Clip / Score view sets the mode, bars and tracks
  // Start once Verovio's runtime is up AND every <script> has run (feature modules register hooks and 'sv-ready'
  // listeners as they load). Verovio compiles its wasm asynchronously while the scripts load one by one, so it may
  // be ready before this file runs (Emscripten sets calledRun just before calling onRuntimeInitialized) or before the
  // feature modules have loaded; either way the start waits for the other half.
  let runtime = !!verovio.module.calledRun, parsed = document.readyState !== 'loading';
  const maybeStart = () => { if (runtime && parsed && !C.tk) start(); };
  if (!runtime) verovio.module.onRuntimeInitialized = () => { runtime = true; maybeStart(); };
  if (!parsed) document.addEventListener('DOMContentLoaded', () => { parsed = true; maybeStart(); });
  maybeStart();

  function start() {
    C.tk = new verovio.toolkit();
    C.engrave.warm(); // the engraving worker compiles its own Verovio meanwhile (big scores engrave there)
    C.lastW = $('main').clientWidth;
    C.setMode(live ? state.mode : 'score');
    C.flushRender(); // the first render happens before 'sv-ready', as before
    C.renderTrackList();
    if (live) { C.pollNotes(); C.pollPlay(); }
    window.dispatchEvent(new Event('sv-ready'));
  }
})();
