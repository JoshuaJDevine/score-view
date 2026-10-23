// Clip switches and settled data (LiveSync.java, core/net.js, core/sources.js) against the mock's burst delivery:
//  * Bitwig reports a clip switch one note at a time, the track name and the play start marker later; the page gets
//    those half-switched snapshots (unsettled) but never remembers one track's notes as another's (overlays,
//    hooks.liveSettled data, the Read's out-of-date watch);
//  * the edit of the selected clip is kept (overlay, or the Read's mirror) and hooks.liveSettled comes within ~300 ms
//    of the last change;
//  * the clip's arranger position comes from selPlayStart in the settled snapshot (no /api/transport fetch);
//  * an extension without the settled field (mock settle: false): the page's SETTLE_MS fallback and the fetch.
//   PORT=12901 node test/sync-e2e.mjs        (uses PORT and PORT+1)
import assert from 'assert';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';
import { CHROME } from './lib.mjs';

const PORT = Number(process.env.PORT || 12901);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BAR = 96;
// Violin plays high (72..84), Cello low (36..48): a note out of its staff's range is the other clip's.
const violin = [0, 1, 2, 3].flatMap(b => [{ ch: 0, x: b * BAR, y: 72 + b, d: 1, vel: 90 }, { ch: 0, x: b * BAR + 48, y: 79 + b, d: 1, vel: 90 }]);
const cello = [0, 1, 2, 3].flatMap(b => [{ ch: 0, x: b * BAR, y: 36 + b, d: 2, vel: 90 }, { ch: 0, x: b * BAR + 48, y: 43 + b, d: 1, vel: 90 }]);
const isViolin = y => y >= 72, isCello = y => y <= 48;
const arrangement = () => ({
  tracks: [{ name: 'Violin' }, { name: 'Cello' }],
  home: 0,
  clips: [
    { lane: 0, track: 'Violin', start: 0, playStart: 0, playStop: 16, notes: violin.map(n => ({ ...n })) },
    { lane: 1, track: 'Cello', start: 16, playStart: 0, playStop: 16, notes: cello.map(n => ({ ...n })) },
  ],
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
let passed = 0;
const ok = name => { passed++; console.log('  ok ' + name); };

async function open(srv) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    localStorage.clear();
    localStorage.setItem('scoreview.view', '"score"');
    localStorage.setItem('scoreview.scoreShow', '"all"');
  });
  const transportFetches = [];
  page.on('request', r => { if (r.url().includes('/api/transport')) transportFetches.push(Date.now()); });
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.arrangement && SV.state.liveData && document.querySelector('#paper svg'), { timeout: 30000 });
  // Record what the page saw: every snapshot (settled or not) and every liveSettled call with the data it got.
  await page.evaluate(() => {
    window.__seen = []; window.__settled = [];
    SV.hooks.liveData.push(d => { window.__seen.push({ t: Date.now(), settled: d.settled, track: d.track, ys: d.notes.map(n => n.y) }); });
    SV.hooks.liveSettled.push(d => { window.__settled.push({ t: Date.now(), track: d.track, ys: d.notes.map(n => n.y) }); });
  });
  // ⟳ Read arrangement: the base the live clip is placed in.
  await page.click('#svarRead');
  await page.waitForFunction(() => SV.state.base && SV.state.base.source === 'crawl' && !document.querySelector('#svarRead').disabled, { timeout: 15000 });
  await page.waitForFunction(() => SV.state.align && SV.state.align.track === 'Violin', { timeout: 5000 });
  return { page, transportFetches };
}

// Where the page keeps an edit of the selected clip: an overlay snapshot (core/sources.js rememberOverlay) or, once the
// Read's mirror harvested the settled clip (features/arrangement.js), the read itself (the overlay is then dropped).
const VIOLIN_EDIT_KEPT = `(() => {
  const o = SV.state.overlays.get('Violin@0');
  if (o && o.notes.some(n => n.pitch === 77)) return 'overlay';
  const c = SV.state.crawl && SV.state.crawl.result.find(c => c.track === 'Violin' && c.start === 0);
  return c && c.notes.some(n => n[2] === 77) ? 'mirror' : null;
})()`;

/** Edits the selected Violin clip from the page; resolves with ms from the mock's last change to the edit being kept. */
async function editViolin(page, srv) {
  await page.evaluate(() => SV.send(['add 0 24 77 100 1']));
  for (let i = 0; i < 100 && !srv.state.data.notes.some(n => n.y === 77); i++) await sleep(5);
  const changedAt = srv.sync.changedAt;
  await page.waitForFunction(VIOLIN_EDIT_KEPT, { timeout: 5000, polling: 5 });
  return Date.now() - changedAt;
}

function checkClean(seen, settled, label) {
  // the emulation really delivered half-switched data (Cello notes under the Violin name, unsettled) ...
  assert.ok(seen.some(s => s.track === 'Violin' && s.ys.some(isCello)), label + ': the burst showed half-switched data');
  // ... but nothing settled was half-switched
  settled.forEach(s => {
    const own = s.track === 'Violin' ? isViolin : isCello;
    assert.ok(s.ys.every(y => own(y) || y === 77), `${label}: settled data mixes tracks (${s.track}: ${s.ys.join(' ')})`);
  });
}

try {
  // ---------------------------------------------------------------- 1. extension with settled / selPlayStart
  {
    const srv = await startMockServer({ port: PORT, arrangement: arrangement(), markers: [] });
    const { page, transportFetches } = await open(srv);
    const overlayMs = await editViolin(page, srv);
    assert.ok(overlayMs <= 300, 'the edited clip is remembered within ~300 ms of the last change, took ' + overlayMs);
    ok(`edited clip remembered ${overlayMs} ms after the change (extension settled)`);

    await page.evaluate(() => { window.__seen = []; window.__settled = []; });
    const fetchesBefore = transportFetches.length;
    const { lastChangeAt } = await srv.switchClip(1, { noteMs: 4, trackMs: 60, playStartMs: 60 });
    await page.waitForFunction(() => window.__settled.some(s => s.track === 'Cello'), { timeout: 5000, polling: 5 });
    const seen = await page.evaluate(() => window.__seen), settled = await page.evaluate(() => window.__settled);
    const hookMs = settled.find(s => s.track === 'Cello').t - lastChangeAt;
    assert.ok(hookMs <= 300, 'liveSettled within ~300 ms of the last change of a clip switch, took ' + hookMs);
    assert.ok(seen.filter(s => s.settled === false).length >= 10, 'the page got the burst as unsettled snapshots');
    checkClean(seen, settled, 'extension');
    ok(`clip switch: ${seen.length} snapshots, liveSettled ${hookMs} ms after the last change, never mixed`);

    await sleep(150);
    const ov = await page.evaluate(() => [...SV.state.overlays.values()].map(o => ({ track: o.track, offset: o.offset, ps: o.notes.map(n => n.pitch) })));
    assert.ok(await page.evaluate(VIOLIN_EDIT_KEPT), 'the Violin overlay or the mirrored read keeps the edit: ' + JSON.stringify(ov));
    assert.ok(ov.every(o => o.ps.every(o.track === 'Violin' ? (y => isViolin(y)) : isCello)), 'no overlay holds the other track\'s notes: ' + JSON.stringify(ov));
    const violinStaff = await page.evaluate(() => {
      const p = SV.state.render.score.parts.find(x => x.name.replace(/ ✎$/, '') === 'Violin');
      return p.notes.map(n => n.pitch);
    });
    assert.ok(violinStaff.length && violinStaff.every(isViolin), 'the Violin staff shows only Violin notes: ' + violinStaff.join(' '));
    ok('the edit is kept; overlays and the Violin staff hold only Violin notes');

    const guess = await page.evaluate(() => SV.state.playStartGuess);
    assert.equal(guess && guess.beat, 16, 'the clip position comes from selPlayStart: ' + JSON.stringify(guess));
    assert.equal(transportFetches.length, fetchesBefore, 'no /api/transport fetch for the play start');
    ok('play start guess from the settled snapshot (16), no /api/transport fetch');

    const stale = await page.evaluate(() => SV.arrangement.staleReasons());
    assert.deepEqual(stale, [], 'the out-of-date watch saw no half-switched clip');
    ok('Read stays current through the switch');
    await page.close();
    await srv.close();
  }

  // ---------------------------------------------------------------- 2. an extension without the fields
  {
    const srv = await startMockServer({ port: PORT + 1, arrangement: arrangement(), markers: [], settle: false });
    const { page, transportFetches } = await open(srv);
    assert.equal(await page.evaluate(() => 'settled' in SV.state.liveData), false, 'mock settle: false sends no settled field');
    const overlayMs = await editViolin(page, srv);
    const fallback = await page.evaluate(() => SV.core.SETTLE_MS);
    assert.ok(fallback >= 150 && fallback <= 250, 'SETTLE_MS fallback in 150..250: ' + fallback);
    assert.ok(overlayMs <= fallback + 150, `fallback: remembered within SETTLE_MS (${fallback}) + slack, took ${overlayMs}`);
    ok(`fallback: edited clip remembered ${overlayMs} ms after the change`);

    await page.evaluate(() => { window.__seen = []; window.__settled = []; });
    const fetchesBefore = transportFetches.length;
    const { lastChangeAt } = await srv.switchClip(1, { noteMs: 4, trackMs: 60, playStartMs: 60 });
    await page.waitForFunction(() => window.__settled.some(s => s.track === 'Cello'), { timeout: 5000, polling: 5 });
    const seen = await page.evaluate(() => window.__seen), settled = await page.evaluate(() => window.__settled);
    const hookMs = settled.find(s => s.track === 'Cello').t - lastChangeAt;
    assert.ok(hookMs <= fallback + 150, 'fallback liveSettled took ' + hookMs);
    checkClean(seen, settled, 'fallback');
    ok(`fallback: liveSettled ${hookMs} ms after the last change, never mixed`);
    await page.waitForFunction(() => SV.state.playStartGuess && SV.state.playStartGuess.beat === 16, { timeout: 3000 });
    assert.ok(transportFetches.length > fetchesBefore, 'fallback fetches /api/transport for the play start');
    ok('fallback: play start guess from /api/transport');
    await page.close();
    await srv.close();
  }
} finally {
  await browser.close();
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
}
assert.deepEqual(errors, [], 'page errors');
console.log(`sync-e2e: ${passed} passed`);
