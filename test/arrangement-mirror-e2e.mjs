// The arrangement mirror in the page against the mock arrangement (web/features/arrangement.js + arrangement-mirror.js):
//  * a Read is stored (GET/POST /api/arrangement) and a reload restores it without reading again;
//  * a clip changed in Bitwig and then selected updates the score without a read; a clip moved to a new start is taken
//    in there and its old place becomes suspect: the out-of-date dot offers "Refresh 1 track" (op 'crawl tracks …');
//  * another project drops the read, coming back restores it; an extension without the endpoint: IndexedDB.
//   PORT=8952 node test/arrangement-mirror-e2e.mjs        (uses PORT and PORT+1; SV_SHOTS=<dir> writes screenshots)
import assert from 'assert';
import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';
import { CHROME } from './lib.mjs';

const PORT = Number(process.env.PORT || 8952);
const SHOTS = process.env.SV_SHOTS;
const BAR = 96;
const chord = (bar, pitches) => pitches.map(y => ({ ch: 0, x: bar * BAR, y, d: 4, vel: 90 }));
const arrangement = () => ({
  tracks: [{ name: 'Pocket Strings' }, { name: 'Pigments' }, { name: 'Flute' }],
  home: 1,
  clips: [
    { lane: 0, track: 'Pocket Strings', start: 0, playStart: 0, playStop: 32, notes: [0, 1, 2, 3].flatMap(b => chord(b, [48, 60, 64, 67])) },
    { lane: 1, track: 'Pigments', start: 0, playStart: 0, playStop: 16, notes: [0, 1, 2, 3].map(b => ({ ch: 0, x: b * BAR, y: 72, d: 2, vel: 100 })) },
    { lane: 2, track: 'Flute', start: 16, playStart: 0, playStop: 16, notes: [] },
  ],
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openPage(srv) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    if (sessionStorage.getItem('svInit')) return;
    sessionStorage.setItem('svInit', '1');
    localStorage.clear();
    localStorage.setItem('scoreview.view', '"score"');
  });
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await ready(page);
  return page;
}
const ready = page => page.waitForFunction(() => window.SV && SV.arrangement && SV.state.liveData && document.querySelector('#paper svg'), { timeout: 30000 });
async function read(page) {
  const t = await page.evaluate(() => SV.state.baseMtime || 0);
  await page.click('#svarRead');
  await page.waitForFunction(t0 => SV.state.base && SV.state.base.source === 'crawl' && SV.state.baseMtime > t0 &&
    !document.querySelector('#svarRead').disabled, { timeout: 15000 }, t);
}
const crawls = srv => srv.edits.filter(l => /^crawl\b/.test(l));
const baseNotes = (page, track) => page.evaluate(t => ((SV.state.base.parts.find(p => p.name === t) || {}).notes || [])
  .map(n => n.start + ':' + n.pitch), track);
const mirrorClips = page => page.evaluate(() => SV.state.crawl.result.map(c => c.track + '@' + c.start + (c.suspect ? '?' : '')).sort());
const stale = page => page.evaluate(() => ({ dot: !document.querySelector('#svarStale').hidden, reasons: SV.arrangement.staleReasons(),
  refresh: SV.arrangement.staleTracks() }));

const srv = await startMockServer({ port: PORT, arrangement: arrangement(), markers: [] });
srv.setProject('Song A');
try {
  // 1. Read once: the extension stores it, the page posts its mirror too
  let page = await openPage(srv);
  assert.equal(await page.evaluate(() => SV.state.crawl), null, 'nothing stored yet');
  await read(page);
  assert.ok(srv.mirror.has('Song A'), 'the extension stored the read');
  await page.waitForFunction(() => true);
  await sleep(1400);
  assert.ok(srv.mirrorPosts.length >= 1, 'the page posted its mirror');
  assert.equal(await page.evaluate(() => SV.arrangement.prefs.autoRefresh), false, 'auto-refresh is off by default');

  // 2. Reload (F5): the read comes back without reading again, with its age
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForFunction(() => SV.state.base && SV.state.base.source === 'crawl' && SV.state.crawl, { timeout: 10000 });
  assert.equal(crawls(srv).length, 1, 'no second read');
  assert.deepEqual(await page.evaluate(() => SV.state.base.parts.map(p => p.name).sort()), ['Pigments', 'Pocket Strings']);
  assert.match(await page.$eval('#svarStatus', el => el.textContent), /Restored the read from/);
  assert.match(await page.$eval('#svlReadInfo', el => el.textContent), /2 parts read/);
  assert.equal((await stale(page)).dot, false);
  // ... but Bitwig may have changed while the page was closed: a paste into a restored clip not seen since is refused
  assert.match(await page.$eval('#svlReadInfo', el => el.textContent), /restored/);
  const unconfirmed = () => page.evaluate(() => SV.arrangement.unconfirmed(SV.state.crawl.result).map(c => c.track + '@' + c.start).sort());
  assert.deepEqual(await unconfirmed(), ['Flute@16', 'Pigments@0', 'Pocket Strings@0']);
  const pasted = await page.evaluate(() => SV.passage.pasteAt({ beats: 4, bars: 1, from: 1, keyswitches: false,
    staves: [{ track: 'Pigments', notes: [{ start: 0, dur: 1, pitch: 74, vel: 0.8 }] }] }, 1, { tracks: ['Pigments'] }));
  assert.match(pasted.error || '', /restored .* not been seen since .*Pigments bar 1/, JSON.stringify(pasted));
  assert.equal(srv.edits.filter(l => /^goto/.test(l)).length, 0, 'nothing sent');

  // 3. Pocket Strings edited in Bitwig (not selected), then clicked: the score takes it in without a read
  const strings = srv.arrangement.clips[0];
  strings.notes.push({ ch: 0, x: 48, y: 76, d: 1, vel: 100 });
  assert.ok(!(await baseNotes(page, 'Pocket Strings')).includes('2:76'));
  srv.selectClip(0);
  await page.waitForFunction(() => (SV.state.base.parts.find(p => p.name === 'Pocket Strings') || { notes: [] }).notes
    .some(n => n.start === 2 && n.pitch === 76), { timeout: 5000 });
  assert.equal(await page.evaluate(() => SV.state.align && SV.state.align.how + '@' + SV.state.align.offset), 'mirror@0', 'placed exactly');
  assert.deepEqual(await unconfirmed(), ['Flute@16', 'Pigments@0'], 'the harvested clip is confirmed');
  srv.selectClip(1);
  await sleep(900);
  assert.deepEqual((await stale(page)).reasons, [], 'nothing out of date: the mirror has the edit');
  assert.equal(crawls(srv).length, 1, 'still no read');

  // 3b. The selected Pigments clip humanized, then quantized in Bitwig (every note moves a little; live 2026-10-18 the
  // read kept the old timing and the score drew the clip a 16th early): each version is taken in, placed at its clip
  const pigTimed = t => [0, 1, 2, 3].map(b => ({ ch: 0, x: b * BAR + t(b), y: 72, d: 2, vel: 100, sel: false }));
  const pigStarts = () => page.evaluate(() => SV.state.base.parts.find(p => p.name === 'Pigments').notes.map(n => +n.start.toFixed(3)));
  srv.setNotes(pigTimed(b => [2, 1, -3, 2][b])); // humanized: a step (a 24th of a beat) to a 32nd off the beat
  await page.waitForFunction(() => SV.state.base.parts.find(p => p.name === 'Pigments').notes.some(n => Math.abs(n.start - 7.875) < 1e-3), { timeout: 5000 });
  srv.setNotes(pigTimed(() => 0)); // quantized
  await page.waitForFunction(() => SV.state.base.parts.find(p => p.name === 'Pigments').notes.every(n => Number.isInteger(n.start)), { timeout: 5000 });
  assert.deepEqual(await pigStarts(), [0, 4, 8, 12]);
  assert.equal(await page.evaluate(() => SV.state.align && SV.state.align.how + '@' + SV.state.align.offset), 'mirror@0', 'drawn at its clip');
  assert.deepEqual(await page.evaluate(() => SV.arrangement.mirrorInfo().unsure), [], 'a quantize is not "unsure"');

  // 4. Pigments moved to bar 9 in Bitwig and clicked there: taken in at bar 9; bar 1 is now suspect
  const pig = srv.arrangement.clips[1];
  pig.start = 32;
  srv.selectClip(2); // something else first (the Flute clip), then Pigments at its new place
  await sleep(700);
  srv.selectClip(1);
  await page.waitForFunction(() => SV.state.crawl.result.some(c => c.track === 'Pigments' && c.start === 32), { timeout: 5000 });
  assert.deepEqual(await mirrorClips(page), ['Flute@16', 'Pigments@0?', 'Pigments@32', 'Pocket Strings@0']);
  await page.waitForFunction(() => !document.querySelector('#svarStale').hidden, { timeout: 5000 });
  let s = await stale(page);
  assert.deepEqual(s.reasons, ['Pigments: the clip at bar 1 may have moved']);
  assert.deepEqual(s.refresh, ['Pigments']);
  // the popover offers to read just that track
  await page.click('#svarStale');
  await page.waitForSelector('#svarPop:not([hidden])');
  assert.equal(await page.$eval('#svarRefresh', el => el.textContent), 'Refresh 1 track');
  assert.match(await page.$eval('#svarWhy', el => el.textContent), /Pigments: the clip at bar 1 may have moved/);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: SHOTS + '/mirror-popover.png', clip: { x: 0, y: 0, width: 1500, height: 320 } }); }
  await page.click('#svarRefresh');
  await page.waitForFunction(() => document.querySelector('#svarStale').hidden && !document.querySelector('#svarRead').disabled, { timeout: 10000 });
  assert.deepEqual(crawls(srv).slice(1), ['crawl tracks Pigments'], 'only Pigments was read');
  assert.deepEqual(await mirrorClips(page), ['Flute@16', 'Pigments@32', 'Pocket Strings@0']);
  assert.deepEqual(await baseNotes(page, 'Pigments'), ['32:72', '36:72', '40:72', '44:72']);

  // 5. A new track: the dot lists it; Refresh reads it and takes in the track list
  srv.arrangement.tracks.push({ name: 'Harp' });
  srv.arrangement.clips.push({ lane: 3, track: 'Harp', start: 0, playStart: 0, playStop: 8, notes: [{ ch: 0, x: 0, y: 55, d: 8, vel: 80 }] });
  srv.setData({ tracks: [...srv.state.data.tracks, { name: 'Harp', index: 3, sel: false, solo: false, mute: false }] });
  await page.waitForFunction(() => SV.arrangement.staleTracks().join() === 'Harp', { timeout: 5000 });
  await page.evaluate(() => SV.arrangement.refreshTracks(SV.arrangement.staleTracks()));
  assert.equal(crawls(srv).at(-1), 'crawl tracks Harp');
  assert.deepEqual(await baseNotes(page, 'Harp'), ['0:55']);
  assert.equal((await stale(page)).dot, false);

  // 6. The mirror survives a reload with what was harvested and refreshed
  await sleep(1300); // the save is debounced
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForFunction(() => SV.state.crawl && SV.state.base && SV.state.base.source === 'crawl', { timeout: 10000 });
  assert.deepEqual(await mirrorClips(page), ['Flute@16', 'Harp@0', 'Pigments@32', 'Pocket Strings@0']);
  assert.ok((await baseNotes(page, 'Pocket Strings')).includes('2:76'));
  assert.equal(crawls(srv).filter(l => l === 'crawl').length, 1, 'still read once');

  // 7. Another project: its own (no) read; back again: restored
  srv.setProject('Song B');
  await page.waitForFunction(() => !SV.state.crawl, { timeout: 5000 });
  await sleep(500);
  assert.equal(await page.evaluate(() => SV.state.crawl), null, 'Song B has no read');
  srv.setProject('Song A');
  await page.waitForFunction(() => SV.state.crawl && SV.state.base && SV.state.base.source === 'crawl', { timeout: 5000 });

  // 7b. Pigments duplicated in Bitwig (the copy at bar 13 is selected, the marker moves there; same notes): unsure.
  // Score View then edits the copy: the clip at bar 9 must not get the copy's notes (an edited copy and the old clip
  // edited after a ruler click cannot be told apart), the track stays offered for a refresh.
  const pigNotes = () => pig.notes.map(n => ({ ...n }));
  srv.selectClip(1);
  await sleep(600);
  srv.arrangement.clips.push({ lane: 1, track: 'Pigments', start: 48, playStart: 0, playStop: 16, notes: pigNotes() });
  srv.selectClip(srv.arrangement.clips.length - 1);
  await page.waitForFunction(() => SV.arrangement.mirrorInfo().unsure.includes('Pigments'), { timeout: 5000 });
  await page.evaluate(() => SV.send(['add 0 24 77 100 1']));
  await sleep(900);
  assert.deepEqual(await mirrorClips(page), ['Flute@16', 'Harp@0', 'Pigments@32', 'Pocket Strings@0'], 'the copy is not written anywhere');
  assert.deepEqual(await baseNotes(page, 'Pigments'), ['32:72', '36:72', '40:72', '44:72'], 'bar 9 keeps its notes');
  assert.deepEqual((await stale(page)).refresh, ['Pigments']);
  await page.evaluate(() => SV.arrangement.refreshTracks(['Pigments']));
  assert.deepEqual(await mirrorClips(page), ['Flute@16', 'Harp@0', 'Pigments@32', 'Pigments@48', 'Pocket Strings@0']);

  // 7c. Another Pigments clip with other notes selected while the play start marker lags behind the settle window:
  // the settled snapshot still has the old marker (bar 9); its notes must not go over the clip at bar 9. When the
  // marker arrives the new clip is taken in at its own start.
  srv.selectClip(1);
  await sleep(600);
  srv.arrangement.clips.push({ lane: 1, track: 'Pigments', start: 64, playStart: 0, playStop: 16,
    notes: [0, 1, 2, 3].map(b => ({ ch: 0, x: b * BAR, y: 60 + b, d: 2, vel: 100 })) });
  await srv.switchClip(srv.arrangement.clips.length - 1, { playStartMs: 700 });
  await page.waitForFunction(() => SV.state.crawl.result.some(c => c.track === 'Pigments' && c.start === 64), { timeout: 5000 });
  assert.deepEqual((await baseNotes(page, 'Pigments')).filter(n => +n.split(':')[0] < 48), ['32:72', '36:72', '40:72', '44:72'],
    'bar 9 was not overwritten');
  await page.waitForFunction(() => !SV.arrangement.mirrorInfo().unsure.length, { timeout: 5000 });
  await page.close();
} finally {
  await srv.close();
}

// 8. An extension without /api/arrangement: the page keeps the read in IndexedDB
const old = await startMockServer({ port: PORT + 1, arrangement: arrangement(), markers: [], mirror: false });
try {
  const page = await openPage(old);
  await read(page);
  await sleep(1300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForFunction(() => SV.state.crawl && SV.state.base && SV.state.base.source === 'crawl', { timeout: 10000 });
  assert.equal(crawls(old).length, 1, 'restored from IndexedDB, not read again');
  assert.deepEqual(errors, []);
  console.log('arrangement-mirror-e2e OK');
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
  await browser.close();
  await old.close();
}
