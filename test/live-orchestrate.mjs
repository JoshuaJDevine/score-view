// Live orchestration check (crawl-test copy only): read the arrangement, double the selected clip's notes an
// octave down into a target track, read again and verify that ONLY the target clip changed.
//   node test/live-orchestrate.mjs [targetTrack]
import puppeteer from 'puppeteer-core';
import { CHROME } from './lib.mjs';

const TARGET = process.argv[2] || 'Tn Trombones a3';
const t = await (await fetch('http://localhost:8765/api/transport')).json();
if (!/crawl/i.test(t.project)) { console.error('Refusing: project is ' + t.project); process.exit(2); }
if (!t.clip.exists) { console.error('Select a clip in the Arranger first'); process.exit(2); }
console.log(`source clip: ${t.clip.track} @ beat ${t.playStart} (${t.clip.notes} notes); target: ${TARGET}`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => { localStorage.setItem('scoreview.mode', '"score"'); localStorage.setItem('scoreview.range', '"clip"'); });
  await page.goto('http://localhost:8765/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.arrangement && SV.state.liveData, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  const read = async label => {
    const t0 = Date.now();
    await page.evaluate(() => SV.arrangement.read());
    const crawl = await page.evaluate(() => SV.state.crawl && SV.state.crawl.result.map(c => ({ track: c.track, start: c.start, n: c.notes.length })));
    console.log(`${label}: ${crawl ? crawl.length : 0} clips in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return crawl;
  };
  const before = await read('read 1');

  // Select every playing note of the live (selected) clip and double it an octave down into the target.
  const sel = await page.evaluate(() => {
    SV.state.selection = new Set(SV.liveNotes().filter(n => n.pitch >= 24).map(n => n.id));
    SV.paintSelection();
    return SV.state.selection.size;
  });
  console.log('selected', sel, 'notes; doubling…');
  const t1 = Date.now();
  const rep = await page.evaluate(target => SV.orchestrate.apply({ op: 'double', targets: [target], interval: 'octDown', keepRanges: true }), TARGET);
  console.log(`apply took ${((Date.now() - t1) / 1000).toFixed(1)} s; report:`, JSON.stringify(rep).slice(0, 600));
  const nav = await (await fetch('http://localhost:8765/api/nav')).json();
  console.log('nav:', JSON.stringify({ state: nav.state, session: nav.session, batches: nav.batches, dropped: nav.dropped, results: nav.results }).slice(0, 400));
  const home = await (await fetch('http://localhost:8765/api/transport')).json();
  console.log(`selection after: ${home.clip.track} @ ${home.playStart}`, home.clip.track === t.clip.track && home.playStart === t.playStart ? '(HOME OK)' : '(NOT HOME!)');

  const after = await read('read 2');
  const key = c => c.track + '@' + c.start;
  const b = new Map(before.map(c => [key(c), c.n]));
  const changed = after.filter(c => b.get(key(c)) !== c.n).map(c => `${key(c)}: ${b.get(key(c))} -> ${c.n}`);
  console.log('changed clips:', changed.length ? changed.join(' | ') : 'none');
  const stray = changed.filter(s => !s.startsWith(TARGET + '@'));
  console.log(stray.length ? 'FAIL: notes landed outside the target: ' + stray.join(' | ') : 'PASS: only ' + TARGET + ' changed');
  await page.screenshot({ path: 'test/out-live-orchestrate.png' });
} finally {
  await browser.close();
  console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'no page errors');
}
