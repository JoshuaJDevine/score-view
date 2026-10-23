// Render benchmark: the page in headless Chrome against the mock server, with the Mega Man 2 crawl
// (test/fixtures/crawl-megaman2.json: 23 parts, 216 bars, ~7000 notes) installed as the score, as after ⟳ Read
// arrangement. Scenarios:
//   Score view, cold        all parts, nothing engraved yet (the engraving cache is emptied before each run)
//   Score view, cached      the same render again (every chunk cached)
//   Edit mid-score          one note of the Read a semitone higher in bar ~100 (never cached), then a render
//   Live edit (Bitwig)      a note of the live clip moved through the mock's /api/edit: from SV.send until the moved
//                           note is on the paper (the long poll, the render, the engraving)
//   Clip view · Clip view + 4 pinned tracks (cold)
// Columns (ms): sync = the main thread inside render() (the page is frozen that long) · visible = until the systems in
// view are on the paper · drawn = until the whole score is (SV.rendered()) · longest = the longest main-thread task
// during the run (PerformanceObserver 'longtask' and sync, > 50 ms; '–' = none) · then the stages the page records in
// SV.state.render.times (buildMEI, plan, engrave = on the main thread, dom, afterRender) and chunks / engraved (how many
// engravings the render had and how many were not cached). Chrome's style / layout counters cover the whole run.
//
//   node tools/perf-bench.mjs [--port 8990] [--runs 3] [--no-inline] [--no-chunks] [--no-worker] [--root <checkout>] [--json]
//     --runs N     runs per scenario (the first one is a warm-up when N > 1; the table shows the median of the rest)
//     --no-inline  render with Verovio's glyph <use>s left in (localStorage scoreview.inlineGlyphs = false)
//     --no-chunks  engrave the whole score as one document (localStorage scoreview.chunked = false)
//     --no-worker  engrave on the main thread (localStorage scoreview.engraveWorker = false)
//     --root DIR   bench another checkout (e.g. an older commit exported next to this one, with node_modules) for
//                  before/after numbers: its mock server serves its web/; the fixture and Chrome come from this checkout.
//                  A checkout that renders synchronously (no SV.rendered) reports drawn = visible = sync.
//     --json       print the raw results as JSON
// Never runs against Bitwig: it starts its own mock server on --port.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import puppeteer from 'puppeteer-core';
import { CHROME } from '../test/lib.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(opt('--port', process.env.PORT || 8990), 10);
const RUNS = Math.max(1, parseInt(opt('--runs', 3), 10));
const INLINE = !args.includes('--no-inline'), CHUNKS = !args.includes('--no-chunks'), WORKER = !args.includes('--no-worker');
const ROOT = path.resolve(opt('--root', HERE));
const crawl = JSON.parse(fs.readFileSync(path.join(HERE, 'test/fixtures/crawl-megaman2.json'), 'utf8'));

const { startMockServer } = await import(pathToFileURL(path.join(ROOT, 'test/mock-server.mjs')).href);
const srv = await startMockServer({ port: PORT });
// Bitwig's track list = the crawled project's tracks, so every staff gets its solo / mute zone as in the real page.
srv.setData({ tracks: crawl.tracks.map((t, index) => ({ index, name: t.name, group: !!t.group, solo: false, mute: false, sel: t.name === srv.state.data.track })) });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'], protocolTimeout: 0 });
let results;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.evaluateOnNewDocument((inline, chunks, worker) => {
    try {
      localStorage.setItem('scoreview.view', '"clip"');
      localStorage.setItem('scoreview.mode', '"clip"');
      localStorage.setItem('scoreview.scoreShow', '"all"');
      localStorage.setItem('scoreview.pinned', '[]');
      localStorage.setItem('scoreview.inlineGlyphs', JSON.stringify(inline));
      localStorage.setItem('scoreview.chunked', JSON.stringify(chunks));
      localStorage.setItem('scoreview.engraveWorker', JSON.stringify(worker));
    } catch (e) { /* ignore */ }
    // long main-thread tasks, from the start
    window.__longTasks = [];
    const keep = l => l.forEach(e => window.__longTasks.push({ t: e.startTime, d: e.duration }));
    try { (window.__lto = new PerformanceObserver(l => keep(l.getEntries()))).observe({ type: 'longtask', buffered: true }); } catch (e) { /* no longtask API */ }
    window.__takeLong = () => { if (window.__lto) keep(window.__lto.takeRecords()); };
  }, INLINE, CHUNKS, WORKER);
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(n => window.SV && SV.core && SV.core.tk && document.querySelector('#paper svg') &&
    SV.state.liveData && SV.state.liveData.tracks && SV.state.liveData.tracks.length === n, { timeout: 60000 }, crawl.tracks.length);
  // the engraving workers are up (a checkout without them: nothing to wait for)
  await page.waitForFunction(() => !SV.core.engrave || SV.core.engrave.stats().broken || SV.core.engrave.stats().ready > 0, { timeout: 60000 });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

  // Per-hook times (afterRender), installed once.
  await page.evaluate(() => {
    const C = SV.core, T = window.__benchT = {};
    C.hooks.afterRender.forEach((fn, i) => {
      const who = (SV.hookOrder().afterRender[i] || '?').replace(/^features\//, '');
      C.hooks.afterRender[i] = function (...a) {
        const t = performance.now();
        try { return fn.apply(this, a); } finally { const k = 'hook ' + who; T[k] = (T[k] || 0) + performance.now() - t; }
      };
    });
    // One run: act() starts it (renders, or sends an edit); ready() says when the result is on the paper.
    window.__benchRun = async (act, ready) => {
      const T = window.__benchT;
      for (const k in T) delete T[k];
      const t0 = performance.now();
      const r0 = await act();
      const sync = performance.now() - t0;
      let r = r0;
      if (ready) { while (!(r = ready())) await new Promise(res => setTimeout(res, 5)); }
      if (SV.rendered) r = await SV.rendered();
      const drawn = performance.now() - t0;
      await new Promise(res => requestAnimationFrame(() => setTimeout(res, 0))); // the frame after: paint
      const own = (r && r.times) || {};
      await new Promise(res => setTimeout(res, 50)); // the long-task entries arrive a little later
      window.__takeLong();
      const long = window.__longTasks.filter(x => x.t >= t0 - 1).map(x => x.d);
      const hooks = Object.fromEntries(Object.entries(T).filter(([k, v]) => k.startsWith('hook ') && v > 5).map(([k, v]) => [k.slice(5), Math.round(v)]));
      const paper = document.getElementById('paper');
      return {
        sync, drawn, visible: own.visible != null && !ready ? own.visible : (own.visible != null ? null : drawn),
        stages: { buildMEI: own.buildMEI, plan: own.plan, engrave: own.engrave, dom: own.dom, afterRender: own.afterRender, chunks: own.chunks, engraved: own.engraved },
        // (a render() called from this evaluate is not reported as a long task: its sync time counts instead)
        longest: Math.round(Math.max(sync > 50 ? sync : 0, ...long)), hooks,
        nodes: paper.getElementsByTagName('*').length, uses: paper.getElementsByTagName('use').length,
      };
    };
  });

  async function scenario(label, setup, act, ready) {
    if (setup) await page.evaluate(setup, crawl);
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const m0 = await metrics();
      const r = await page.evaluate(`window.__benchRun(${act}, ${ready || 'null'})`);
      const m1 = await metrics();
      const d = k => (m1[k] || 0) - (m0[k] || 0);
      r.chrome = {
        recalcStyleMs: Math.round(d('RecalcStyleDuration') * 1000), layoutMs: Math.round(d('LayoutDuration') * 1000),
        recalcStyleCount: d('RecalcStyleCount'), layoutCount: d('LayoutCount'), scriptMs: Math.round(d('ScriptDuration') * 1000),
      };
      runs.push(r);
    }
    const use = runs.length > 1 ? runs.slice(1) : runs;
    const med = f => { const v = use.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const pick = use[use.findIndex(r => r.drawn === med(x => x.drawn))] || use[0];
    return { label, ...pick, sync: Math.round(med(r => r.sync)), drawn: Math.round(med(r => r.drawn)),
             visible: pick.visible == null ? null : Math.round(med(r => (r.visible == null ? r.drawn : r.visible))),
             longest: med(r => r.longest), drawn_all: runs.map(r => Math.round(r.drawn)) };
  }

  // cold: nothing cached and nothing on the paper to keep
  const clear = "(SV.core.engrave && SV.core.engrave.clearCache(), document.getElementById('paper').innerHTML = '', SV.core.render(), SV.state.render)";
  results = [];
  results.push(await scenario('Score view, cold', c => {
    SV.state.crawl = c;
    SV.setBase(SV.arrangement.crawlToScore(c, { title: 'Mega Man 2' }), Date.now());
    SV.core.setScoreShow('all');
    SV.core.setMode('score');
    return SV.rendered ? SV.rendered().then(() => 0) : 0;
  }, `async () => ${clear}`));
  results.push(await scenario('Score view, cached', null, 'async () => (SV.core.render(), SV.state.render)'));
  // One note in the middle of the score (a part of the Read) a semitone higher each run.
  results.push(await scenario('Edit mid-score', null, `async () => {
    const p = SV.state.base.parts.filter(p => p.notes.length > 100)[0];
    const n = p.notes.filter(n => n.start >= 396 && n.start < 400)[0] || p.notes[Math.floor(p.notes.length / 2)];
    n.pitch += 1; // a new pitch each run: never cached
    SV.core.render(); return SV.state.render; }`));
  // A note of the live clip moved through the mock (as an edit in Score View reaches Bitwig and comes back).
  results.push(await scenario('Live edit (Bitwig)', null, `async () => {
    const d = SV.state.liveData, n = d.notes.filter(n => n.y >= 40)[Math.floor(d.notes.length / 2)];
    window.__flip2 = !window.__flip2; const dy = window.__flip2 ? 1 : -1;
    window.__want = 'n' + 'L' + n.ch + '_' + n.x + '_' + (n.y + dy);
    SV.send(['move ' + n.ch + ' ' + n.x + ' ' + n.y + ' 0 ' + dy]); return null; }`,
    `() => { const r = SV.state.render; return r && r.bySvg.has(window.__want) && (!('drawn' in r) || r.drawn) && document.getElementById(window.__want) ? r : null; }`));
  results.push(await scenario('Clip view', () => { SV.core.clearPins(); SV.core.setMode('clip'); }, `async () => ${clear}`));
  results.push(await scenario('Clip view + 4 pins', () => {
    SV.state.base.parts.filter(p => p.notes.length).slice(0, 4).forEach(p => SV.core.setPinned(p.name, true));
    SV.core.setMode('clip');
  }, `async () => ${clear}`));
  results.engrave = await page.evaluate(() => SV.core.engrave && SV.core.engrave.stats());
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
} finally {
  await browser.close();
  await srv.close();
}

if (args.includes('--json')) console.log(JSON.stringify(results, null, 1));
else {
  console.log(`perf-bench  root ${ROOT}  inlining ${INLINE ? 'on' : 'off'}  chunks ${CHUNKS ? 'on' : 'off'}  worker ${WORKER ? 'on' : 'off'}  runs ${RUNS}  (ms)`);
  const cols = ['buildMEI', 'plan', 'engrave', 'dom', 'afterRender', 'chunks', 'engraved'];
  const pad = (s, n) => String(s == null ? '–' : s).padStart(n);
  console.log('scenario'.padEnd(20) + pad('sync', 7) + pad('visible', 9) + pad('drawn', 7) + pad('longest', 9) + cols.map(c => pad(c, c.length + 2)).join('') +
    pad('style', 7) + pad('layout', 8) + pad('nodes', 8));
  for (const r of results) {
    console.log(r.label.padEnd(20) + pad(r.sync, 7) + pad(r.visible, 9) + pad(r.drawn, 7) + pad(r.longest || '–', 9) + cols.map(c => pad(r.stages[c], c.length + 2)).join('') +
      pad(r.chrome.recalcStyleMs, 7) + pad(r.chrome.layoutMs, 8) + pad(r.nodes, 8));
    if (Object.keys(r.hooks).length) console.log(''.padEnd(20) + 'hooks > 5 ms: ' + Object.entries(r.hooks).map(([k, v]) => k + ' ' + v).join(' · '));
    console.log(''.padEnd(20) + 'drawn in each run: ' + r.drawn_all.join(', '));
  }
  if (results.engrave) console.log('engraving: ' + JSON.stringify(results.engrave));
  console.log('style / layout = Chrome RecalcStyle / Layout duration during the run.');
}
process.exit(0);
