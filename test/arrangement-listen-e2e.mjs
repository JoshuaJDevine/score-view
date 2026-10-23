// Listening while playing in the page against the mock (web/features/arrangement.js + arrangement-listen.js, mock
// /api/listen playing its arrangement): after a Read, Score view polls /api/listen while Bitwig plays; the first pass
// learns each track's baseline; a clip changed in Bitwig (the page was not told) is heard as "changed at bar N" on the
// next passes and offered by the out-of-date dot for a targeted re-read, which clears it; a track whose Note FX
// transposes everything is ignored; the selected clip's track is not judged; switching the preference off stops it.
//   PORT=14950 node test/arrangement-listen-e2e.mjs
import assert from 'assert';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';
import { CHROME } from './lib.mjs';

const PORT = Number(process.env.PORT || 14950);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BARS = 8;
// a note on every beat for 8 bars; x in steps (24 per beat)
const line = (pitch, step = 1) => Array.from({ length: BARS * 4 / step }, (_, i) => ({ ch: 0, x: i * step * 24, y: pitch + (i % 3), d: 0.5, vel: 100 }));
const arrangement = () => ({
  tracks: [{ name: 'Piano' }, { name: 'Strings' }, { name: 'Synth' }, { name: 'Bass' }],
  home: 0,
  clips: [
    { lane: 0, track: 'Piano', start: 0, playStart: 0, playStop: 32, notes: line(60) },
    { lane: 1, track: 'Strings', start: 0, playStart: 0, playStop: 32, notes: line(48) },
    { lane: 2, track: 'Synth', start: 0, playStart: 0, playStop: 32, notes: line(72, 2) },
    { lane: 3, track: 'Bass', start: 0, playStart: 0, playStop: 32, notes: line(36, 2) },
  ],
});

const srv = await startMockServer({ port: PORT, arrangement: arrangement(), markers: [] });
srv.setProject('Listen');
srv.state.play.tempo = 480; // 8 beats a second: a pass over 8 bars takes ~4.5 s
srv.listen.transform.Synth = ev => ({ ...ev, key: ev.key + 12 }); // a Note FX that transposes: the observer reports after it
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.setItem('scoreview.view', '"score"'); });
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.arrangement && SV.state.liveData && document.querySelector('#paper svg'), { timeout: 30000 });
  await page.click('#svarRead');
  await page.waitForFunction(() => SV.state.base && SV.state.base.source === 'crawl' && !document.querySelector('#svarRead').disabled, { timeout: 15000 });
  assert.equal(await page.evaluate(() => SV.arrangement.prefs.listen), true, 'listening is on by default');
  assert.equal(await page.$eval('#svarListen', el => el.checked), true);

  const info = () => page.evaluate(() => SV.arrangement.listenInfo());
  async function pass() {
    const before = (await info()).pass;
    await page.evaluate(() => SV.send(['playFrom 0']));
    await page.waitForFunction(p => SV.arrangement.listenInfo().pass > p && SV.state.playPos > 33.5, { timeout: 15000 }, before);
    await sleep(400); // the last bars are judged LATE beats after their end
    await page.evaluate(() => SV.send(['stop']));
    await page.waitForFunction(() => !SV.state.playing && !SV.arrangement.listenInfo().running, { timeout: 5000 });
  }

  // 1. First pass: baselines learned, nothing flagged; the selected clip's track (Piano) is not judged
  await pass();
  let li = await info();
  assert.ok(srv.listen.requests > 5, 'the page polled /api/listen while playing');
  assert.equal(li.tracks.Strings.baseline, 1);
  assert.equal(li.tracks.Bass.baseline, 1);
  assert.equal(li.tracks.Synth.ignored, true, 'Synth plays transposed notes (its Note FX): ignored');
  assert.equal(li.tracks.Piano, undefined, 'the live track is harvested, not listened to');
  assert.deepEqual(await page.evaluate(() => SV.arrangement.staleReasons()), []);

  // 2. Strings changed in Bitwig (bar 3 one note higher, Synth's bar 2 emptied): the page was not told
  const strings = srv.arrangement.clips[1], synth = srv.arrangement.clips[2];
  strings.notes.find(n => n.x === 9 * 24).y += 1;
  synth.notes = synth.notes.filter(n => n.x < 4 * 24 || n.x >= 8 * 24);
  await pass();
  li = await info();
  assert.deepEqual(li.tracks.Strings.bad, [3], 'heard once: not yet out of date');
  assert.deepEqual(await page.evaluate(() => SV.arrangement.staleReasons()), []);
  await pass();
  await page.waitForFunction(() => !document.querySelector('#svarStale').hidden, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => SV.arrangement.staleReasons()), ['Strings changed at bar 3 (heard while playing)']);
  assert.deepEqual(await page.evaluate(() => SV.arrangement.staleTracks()), ['Strings'], 'Synth (ignored) is not offered');

  // 3. The popover's Refresh reads only Strings; the flag goes, the next pass is clean
  await page.click('#svarStale');
  await page.waitForSelector('#svarPop:not([hidden])');
  assert.equal(await page.$eval('#svarRefresh', el => el.textContent), 'Refresh 1 track');
  await page.click('#svarRefresh');
  await page.waitForFunction(() => document.querySelector('#svarStale').hidden && !document.querySelector('#svarRead').disabled, { timeout: 10000 });
  assert.deepEqual(srv.edits.filter(l => /^crawl\b/.test(l)), ['crawl', 'crawl tracks Strings']);
  assert.ok(await page.evaluate(() => SV.state.base.parts.find(p => p.name === 'Strings').notes.some(n => n.start === 9 && n.pitch === 49)),
    'the re-read has the changed note');
  await pass();
  li = await info();
  assert.equal(li.tracks.Strings.flagged, null);
  assert.deepEqual(li.tracks.Strings.bad, []);
  assert.deepEqual(await page.evaluate(() => SV.arrangement.staleReasons()), []);

  // 4. Preference off: no polling while playing
  await page.evaluate(() => { const cb = document.querySelector('#svarListen'); cb.checked = false; cb.dispatchEvent(new Event('change')); });
  assert.equal(await page.evaluate(() => localStorage.getItem('scoreview.arrangement.listen')), 'false');
  await sleep(1200);
  const n0 = srv.listen.requests;
  await page.evaluate(() => SV.send(['playFrom 0']));
  await sleep(1500);
  await page.evaluate(() => SV.send(['stop']));
  assert.ok(srv.listen.requests - n0 <= 1, 'not polled while the preference is off');
  assert.equal((await info()).on, false);

  assert.deepEqual(errors, []);
  console.log('arrangement-listen-e2e: all passed');
} finally {
  await browser.close();
  await srv.close();
}
