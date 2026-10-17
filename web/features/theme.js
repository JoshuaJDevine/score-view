// Paper theme: light paper (default), dark paper (warm near-black with cream ink, for long sessions) or Bitwig
// (Bitwig's dark grey panels with its light-grey ink). Applied as a class on <html>; Verovio's SVG inherits the ink
// through fill/color, so engraving needs no re-render. Coloured notes from features/harmony.js keep their hues
// but get lighter variants that read on dark paper; selection/playhead/caret colours are re-tuned too.
// Printing (features/print.js) always uses white paper. Preference: localStorage scoreview.theme.paper.
// Chrome (the bars and panels around the paper, tokens in web/style.css) is a separate preference: dark (default) or
// light, html[data-chrome]; density normal (28 px controls, default) or compact (24 px), html[data-density].
// Both are saved (scoreview.theme.chrome / .density) and set with SV.theme.setChrome / setDensity; no toolbar control yet.
(function (root) {
  'use strict';
  const MODES = { light: 'Light paper', dark: 'Dark paper', bitwig: 'Bitwig dark' };
  const KEY = 'scoreview.theme.paper';
  const CHROMES = { dark: 'Dark', light: 'Light' }, CHROME_KEY = 'scoreview.theme.chrome';
  const DENSITIES = { normal: 'Normal', compact: 'Compact' }, DENSITY_KEY = 'scoreview.theme.density';

  // harmony.js PALETTE (cream-paper hues) -> lighter versions of the same hues for dark paper.
  const HARMONY_DARK = {
    '#d4213d': '#ff6b80', '#d39e00': '#ffd34d', '#1d5bd6': '#7aa7ff', '#22963a': '#5fd37a', '#8a3cc8': '#c28bff',
    '#f07206': '#ffa04d', '#00acc8': '#4fdcf2', '#e0168c': '#ff6ec0', '#a2a2a2': '#c4c4c4',
  };

  function css() {
    const swap = Object.entries(HARMONY_DARK).map(([from, to]) =>
      `html.svp-dark #paper [fill="${from}"] { fill: ${to}; } html.svp-dark #paper [color="${from}"] { color: ${to}; }` +
      ` html.svp-dark #paper [stroke="${from}"] { stroke: ${to}; }`).join('\n');
    return `
      html.svp-dark { --svp-ink: #e8e2d2; --sv-paper: #1f1d1a; --sv-sel: #ff9a4d; --sv-play: #5cb8ff; }
      html.svp-dark.svp-bitwig { --svp-ink: #d9d9d9; --sv-paper: #2f2f2f; --sv-sel: #ff8a2a; --sv-play: #5cb3ff; }
      html.svp-dark #paper { box-shadow: 0 2px 14px #000c; color: var(--svp-ink); }
      html.svp-dark #paper svg { fill: var(--svp-ink); color: var(--svp-ink); }
      html.svp-dark #paper svg .definition-scale { color: var(--svp-ink); }
      html.svp-dark #paper #empty { color: #8a8a8a; }
      ${swap}
      /* harmony.js: text halos use the paper colour; its selection/playhead turn notes black */
      html.svp-dark #paper [stroke="#fbfaf6"] { stroke: var(--paper); }
      html.svp-dark #paper.hv-on .sel, html.svp-dark #paper.hv-on .sel * { fill: #fff !important; stroke: #fff; }
      html.svp-dark #paper.hv-on .play, html.svp-dark #paper.hv-on .play * { fill: #fff !important; }
      html.svp-dark #paper.hv-on g.note.sel { filter: drop-shadow(0 0 2px #ff7a1a) drop-shadow(0 0 2px #ff7a1a); }
      html.svp-dark #paper.hv-on g.note.play { filter: drop-shadow(0 0 3px #5cb8ff) drop-shadow(0 0 1px #5cb8ff); }
      /* sections.js vertical group labels (inline fill #555) */
      html.svp-dark #paper g.label text[style*="fill"] { fill: #a8a294 !important; }
      html.svp-dark #paper g.staff.sv-reading > path { stroke: #e0a050; }
      #svpSel { max-width: 9em; }
    `;
  }

  function load(key, allowed, dflt) {
    try { const v = JSON.parse(localStorage.getItem(key)); return allowed[v] ? v : dflt; } catch (e) { return dflt; }
  }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  const get = () => load(KEY, MODES, 'light');
  const getChrome = () => load(CHROME_KEY, CHROMES, 'dark');
  const getDensity = () => load(DENSITY_KEY, DENSITIES, 'normal');
  function setChrome(v) { if (!CHROMES[v]) v = 'dark'; save(CHROME_KEY, v); document.documentElement.dataset.chrome = v; return v; }
  function setDensity(v) { if (!DENSITIES[v]) v = 'normal'; save(DENSITY_KEY, v); document.documentElement.dataset.density = v; return v; }

  function apply(mode) {
    const html = document.documentElement;
    html.classList.toggle('svp-dark', mode !== 'light');
    html.classList.toggle('svp-bitwig', mode === 'bitwig');
    html.dataset.paper = mode;
  }

  function set(mode) {
    if (!MODES[mode]) mode = 'light';
    save(KEY, mode);
    apply(mode);
    const sel = document.getElementById('svpSel');
    if (sel) sel.value = mode;
    return mode;
  }

  const SV = root.SV;
  apply(get()); // before the first render, so the paper never flashes light
  document.documentElement.dataset.chrome = getChrome();
  document.documentElement.dataset.density = getDensity();
  if (!SV) return;
  SV.addStyle(css());
  const g = SV.addToolbar('<label for="svpSel">Paper</label><select id="svpSel" title="Paper colour (dark paper with light ink for long sessions)">' +
    Object.entries(MODES).map(([v, t]) => `<option value="${v}">${t}</option>`).join('') + '</select>', { cluster: 'file', order: 180 });
  g.id = 'svpGroup';
  const sel = document.getElementById('svpSel');
  sel.value = get();
  sel.addEventListener('change', () => { set(sel.value); sel.blur(); });
  SV.theme = {
    get, set, modes: Object.keys(MODES), isDark: () => get() !== 'light',
    chrome: getChrome, setChrome, chromes: Object.keys(CHROMES),
    density: getDensity, setDensity, densities: Object.keys(DENSITIES),
  };
})(this);
