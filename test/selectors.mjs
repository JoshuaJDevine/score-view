// One map of the UI selectors the e2e tests drive, plus small helpers, so a layout change edits this file only.
//
//   import { SEL, openMenu, clickTool, setRange } from './selectors.mjs';
//   await openMenu(page, 'notation');                 // clicks "Notation ▾", waits for its panel
//   await page.click(SEL.notationOption('tempo'));
//   await clickTool(page, 'print');                   // the "Print / PDF…" toolbar button
//   await clickIn(page, '#svpbMarks');                // any element: opens File ▾ / View ▾ first if it sits there
//
// Header layout (features/layout.js): 'compact' (default) puts the view checkboxes in View ▾, the File cluster and
// New empty score / Open .dawproject… in File ▾, Key / Quantize / Page / Zoom in the status bar. Ids never change, so
// reading values works anywhere; to *click* an element use clickTool / clickIn (they open its menu), or start the page
// with withPage({ header: 'classic' }) for the old stacked rows.
//
// Keep values as plain CSS selectors (strings or functions returning one). Tests that need a one-off selector inside a
// panel may still write it inline; anything a second test would need belongs here.

/** Core page (web/index.html) and feature toolbar elements. */
export const SEL = {
  paper: '#paper',
  notes: '#paper g.note',
  staffLabel: '#paper g.label',
  main: '#main',
  title: '#title',
  flash: '#flash',
  fileInput: '#fileInput',
  featureBar: '#featureBar',
  statusBar: '#svStatusBar',
  selectionInfo: '#svSelInfo',
  entryInfo: '#svEntryInfo',
  statusTools: '#svStatusTools',
  toastStack: '#svToasts',
  toastButton: '#svToastBtn',
  toastHistory: '#svToastPop',
  palette: { button: '#svPaletteBtn', box: '#svPalette', input: '#svPaletteInput', list: '#svPaletteList',
    item: '#svPaletteList li[data-i]', selected: '#svPaletteList li[aria-selected="true"]' },
  keySheet: { box: '#svKeySheet', filter: '#svKeySheetFilter', body: '#svKeySheetBody' },
  headerSeg: '#svHeaderSeg',
  header: name => `#svHeaderSeg button[data-header="${name}"]`,
  /** A cluster of the feature bar (features/layout.js), e.g. 'file', 'score'. */
  cluster: key => `#featureBar .svl-cluster[data-k="${key}"]`,

  // Segmented controls and selects in the main toolbar.
  modeSeg: '#modeSeg',
  mode: name => `#modeSeg button[data-mode="${name}"]`,
  rangeSeg: '#rangeSeg',
  range: name => `#rangeSeg button[data-range="${name}"]`,
  alignNav: '#alignNav',
  alignStep: dir => `#alignNav button[data-dir="${dir}"]`,
  keySel: '#keySel',
  gridSel: '#gridSel',
  paperSel: '#svpSel',
  hideKeyswitches: '#hideKs',

  /** A checkbox in the Notation ▾ panel by its data-k: 'clefs', 'ottava', 'tempo', 'harmonyKeys'. */
  notationOption: key => `#svnPop input[data-k="${key}"]`,

  print: { page: '.svp-page', pages: '#svPrintPages', close: '#svpClose' },
  instruments: { picker: '.svi-pop', pickerInput: '.svi-pop input', pick: id => `.svi-pop a[data-id="${id}"]`, row: '.svi-row' },
};

/** Drop-down menus: the button that opens each and the panel it shows (created on open for some). */
export const MENUS = {
  tracks: { button: '#trackBtn', panel: '#trackPanel' },
  view: { button: '#svViewBtn', panel: '#svViewPanel' },
  file: { button: '#svFileBtn', panel: '#svFilePanel' },
  read: { button: '#svlReadMore', panel: '#svlReadPop' },
  notation: { button: '#svnBtn', panel: '#svnPop' },
  instruments: { button: '#svInstrBtn', panel: '.svi-pop' },
  articulations: { button: '#svaBtn', panel: '#svaMenu' },
  motif: { button: '#mtfBtn', panel: '#mtfPanel' },
  orchestrate: { button: '#orcBtn', panel: '#orcPanel' },
  passage: { button: '#pasBtn', panel: '#pasPanel' },
  harmony: { button: '#hvBtn', panel: '#hvPanel' },
  dynamics: { button: '#svdBtn', panel: '#svdPanel' },
};

/** Single-click toolbar buttons and toggles. */
export const TOOLS = {
  freshScore: '#freshBtn',
  open: '#openBtn',
  pin: '#pinBtn',
  import: '#svImportBtn',
  print: '#svpPrintBtn',
  newScore: '#svwOpen',
  brief: '#svwBriefBtn',
  readArrangement: '#svarRead',
  exportMusicXML: '#mxExport',
  entry: '#sve-toggle',
  entryPrefs: '#sve-prefs-btn',
  play: '#svpbPlay',
  loop: '#svpbLoop',
  instrumentNames: '#sviNames',
  transposed: '#sviTransposed',
  ranges: '#sviRanges',
  marks: '#svpbMarks',
  dynamics: '#svaDyn',
  simplify: '#simplify',
  follow: '#follow',
  hideEmpty: '#condense',
  hideKeyswitches: '#hideKs',
  audition: '#audition',
  exactLengths: '#svarExact',
  palette: '#svPaletteBtn',
  messages: '#svToastBtn',
  shortcuts: '#helpToggle',
};

function lookup(table, kind, name) {
  const v = table[name];
  if (!v) throw new Error(`selectors.mjs: unknown ${kind} "${name}" (known: ${Object.keys(table).join(', ')})`);
  return v;
}

/** Clicks a menu's button and waits until its panel is visible; returns the panel selector. */
export async function openMenu(page, name, { timeout = 3000 } = {}) {
  const m = lookup(MENUS, 'menu', name);
  await page.click(m.button);
  await page.waitForSelector(m.panel, { visible: true, timeout });
  return m.panel;
}

/** Opens the File ▾ / View ▾ / Read ▾ menu holding the element, if it sits in one (SV.layout.reveal). */
export async function reveal(page, selector) {
  await page.evaluate(sel => { if (window.SV && SV.layout) SV.layout.reveal(sel); }, selector);
}

/** Clicks any element by selector, opening its menu first (see reveal). */
export async function clickIn(page, selector) {
  await reveal(page, selector);
  await page.click(selector);
}

/** Clicks a toolbar button by name (see TOOLS), opening its menu first if it sits in one. */
export async function clickTool(page, name) {
  await clickIn(page, lookup(TOOLS, 'tool', name));
}

/** Picks the bar range: 'clip' (Clip bars) or 'all' (Whole song). */
export async function setRange(page, name) {
  await page.click(SEL.range(name));
}
