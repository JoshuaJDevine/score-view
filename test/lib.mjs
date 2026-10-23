// Shared test helpers: browser automation against the mock server, plus headless engraving.
//
//   import { withPage, loadFixtureScore, renderMEI, screenshotSvg } from './lib.mjs';
//   await withPage({ port: 8811 }, async ({ page, srv }) => { ... });
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
/**
 * The Chrome (or Chromium-based Edge) the tests drive: env CHROME_PATH, else the first installed default location
 * (Windows Chrome/Edge, macOS, Linux). Falls back to the Windows Chrome path so the error names a real location.
 */
export const CHROME = findChrome();
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pf = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA, 'C:/Program Files', 'C:/Program Files (x86)'].filter(Boolean);
  const candidates = [
    ...pf.map(d => path.join(d, 'Google/Chrome/Application/chrome.exe')),
    ...pf.map(d => path.join(d, 'Microsoft/Edge/Application/msedge.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find(c => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } })
    || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
}
export const ScoreBuilder = require('../web/score.js');

/**
 * Starts the mock server and a headless Chrome page on it, waits for the notation engine, runs fn.
 * Use a port of your own (8800-8899) so parallel test runs don't collide.
 * Console errors from the page are collected in `errors` and printed.
 * header: 'compact' (the default layout) | 'classic' (the old stacked header rows; features/layout.js).
 */
export async function withPage({ port = 8800, fixture, width = 1500, height = 900, mode = 'clip', header } = {}, fn) {
  const srv = await startMockServer({ port, fixture });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    page.on('pageerror', err => errors.push(String(err)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.evaluateOnNewDocument((m, h) => {
      try {
        localStorage.setItem('scoreview.mode', JSON.stringify(m));
        localStorage.setItem('scoreview.view', JSON.stringify(m));
        // tests see the selected clip's track + pins in Score view unless they ask for all (SV.core.setScoreShow('all'))
        if (localStorage.getItem('scoreview.scoreShow') == null) localStorage.setItem('scoreview.scoreShow', JSON.stringify('pinned'));
        if (h) localStorage.setItem('scoreview.layout.header', JSON.stringify(h));
      } catch (e) { /* ignore */ }
    }, mode, header || null);
    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#paper svg'), { timeout: 30000 });
    const result = await fn({ page, srv, errors, browser });
    // The mock refuses requests the extension would refuse (HttpGuard): a page fetch without X-ScoreView ends here.
    if (srv.rejected.length) throw new Error('mock server refused page requests: ' + JSON.stringify(srv.rejected));
    return result;
  } finally {
    if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
    await browser.close();
    await srv.close();
  }
}

/** Loads web/dawproject.js under jsdom and parses the Mega Man 2 fixture into { timeSig, parts, ... }. */
export async function loadFixtureScore(file = path.join(ROOT, 'test/fixtures/megaman2.dawproject')) {
  const { JSDOM } = await import('jsdom');
  const ctx = { fflate: require('fflate') };
  new Function('DOMParser', 'TextDecoder', fs.readFileSync(path.join(ROOT, 'web/dawproject.js'), 'utf8'))
    .call(ctx, new JSDOM('').window.DOMParser, TextDecoder);
  return ctx.DawProject.parseDawProjectFile(fs.readFileSync(file), 'Mega Man 2');
}

let toolkit;
/** Renders MEI with Verovio in Node; returns { svg, log, pages }. */
export async function renderMEI(mei, options = {}) {
  if (!toolkit) {
    const { default: createVerovioModule } = await import('verovio/wasm');
    const { VerovioToolkit } = await import('verovio/esm');
    toolkit = new VerovioToolkit(await createVerovioModule());
  }
  toolkit.setOptions({ pageWidth: 2100, pageHeight: 60000, scale: 40, adjustPageHeight: true, header: 'none', footer: 'none', ...options });
  if (!toolkit.loadData(mei)) throw new Error('Verovio could not load MEI: ' + toolkit.getLog());
  return { svg: toolkit.renderToSVG(1), log: toolkit.getLog(), pages: toolkit.getPageCount() };
}

/** Writes svg to outPng via headless Chrome (for looking at the result). */
export async function screenshotSvg(svg, outPng, { width = 1400, height = 900 } = {}) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.setContent('<body style="margin:0;background:#fff">' + svg + '</body>');
    await page.screenshot({ path: outPng, fullPage: true });
  } finally { await browser.close(); }
}
