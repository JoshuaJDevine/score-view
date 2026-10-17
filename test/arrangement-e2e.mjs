// ⟳ Read arrangement in the page against the mock arrangement:
//  * Score mode shows every track with notes after a read (preference "show all tracks", default), or keeps the
//    Tracks choice ("keep my track selection");
//  * the out-of-date dot: another track changed since the read / the track list changed; writes through
//    SV.orchestrate.writeTracks and a new read keep it current;
//  * Inspire Melody in Clip mode takes the chords of the other staves from the read.
//   PORT=8951 node test/arrangement-e2e.mjs        (SV_SHOTS=<dir> writes screenshots)
import assert from 'assert';
import fs from 'fs';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';
import { CHROME } from './lib.mjs';
import { SEL } from './selectors.mjs';

const PORT = Number(process.env.PORT || 8951);
const SHOTS = process.env.SV_SHOTS;
const BAR = 96;
const chord = (bar, pitches) => pitches.map(y => ({ ch: 0, x: bar * BAR, y, d: 4, vel: 90 }));
const strings = [0, 1, 2, 3].flatMap(b => chord(b, [48, 60, 64, 67]))   // bars 1–4 C major
  .concat([4, 5, 6, 7].flatMap(b => chord(b, [46, 58, 62, 65])));       // bars 5–8 B♭ major
const pigments = [0, 1, 2, 3].map(b => ({ ch: 0, x: b * BAR, y: 72, d: 2, vel: 100 }));
const arrangement = {
  tracks: [{ name: 'Pocket Strings' }, { name: 'Pigments' }, { name: 'Flute' }],
  home: 1,
  clips: [
    { lane: 0, track: 'Pocket Strings', start: 0, playStart: 0, playStop: 32, notes: strings },
    { lane: 1, track: 'Pigments', start: 0, playStart: 0, playStop: 16, notes: pigments },
    { lane: 2, track: 'Flute', start: 16, playStart: 0, playStop: 16, notes: [] },   // bars 5–8, empty
  ],
};

const srv = await startMockServer({ port: PORT, arrangement, markers: [] });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = body => fetch(srv.url + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    if (sessionStorage.getItem('svInit')) return;
    sessionStorage.setItem('svInit', '1');
    localStorage.clear();
    localStorage.setItem('scoreview.mode', '"score"');
    localStorage.setItem('scoreview.trackMode2', '"pinned"');
  });
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.arrangement && SV.state.liveData && document.querySelector('#paper svg'), { timeout: 30000 });
  const shownParts = () => page.evaluate(() => [...new Set((SV.state.render.staves || []).map(s => s.part.replace(/ ✎$/, '')))].sort());
  const read = async () => {
    const t = await page.evaluate(() => SV.state.baseMtime || 0);
    await page.click('#svarRead');
    await page.waitForFunction(t0 => SV.state.base && SV.state.base.source === 'crawl' && SV.state.baseMtime > t0 &&
      !document.querySelector('#svarRead').disabled, { timeout: 15000 }, t);
    await sleep(100);
  };
  const stale = () => page.evaluate(() => ({ dot: !document.querySelector('#svarStale').hidden, title: document.querySelector('#svarStale').title,
    info: document.querySelector('#svlReadInfo').textContent, reasons: SV.arrangement.staleReasons() }));

  // 1. Before the read: pinned mode with no pins shows only the selected clip's track
  assert.deepEqual(await shownParts(), ['Pigments']);
  await read();
  assert.deepEqual(await shownParts(), ['Pigments', 'Pocket Strings'], 'every track with notes after the read');
  assert.equal(await page.evaluate(() => SV.state.trackMode), 'all');
  assert.match(await page.$eval('#trackBtn', el => el.textContent), /Tracks: all/);
  assert.equal(await page.$eval('#svarShowAll', el => el.checked), true, 'preference defaults to show all');
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.click('#trackBtn');
    await page.screenshot({ path: SHOTS + '/pre-read-all-tracks.png' });
    await page.click('#paper');
  }
  let s = await stale();
  assert.equal(s.dot, false, 'fresh read is current');
  assert.match(s.info, /✓ 2 parts read/);

  // 2. Writes through SV.orchestrate.writeTracks (Inspire Continue, Orchestrate) keep the read current
  const w = await page.evaluate(() => SV.orchestrate.writeTracks([{ track: 'Pocket Strings', notes: [{ start: 0.5, dur: 0.5, pitch: 72, vel: 0.8 }] }]));
  assert.deepEqual(w.done, ['Pocket Strings'], JSON.stringify(w));
  await sleep(1800);
  assert.deepEqual((await stale()).reasons, [], 'writeTracks keeps the read current');

  // 3. Pigments changed in Bitwig while selected (not stale: it is shown live), then another clip is selected: stale
  srv.setNotes([...srv.state.data.notes.map(n => ({ ...n })), { ch: 0, x: 48, y: 76, d: 1, vel: 100, sel: false }]);
  await sleep(400);
  assert.equal((await stale()).dot, false, 'the selected clip is overlaid live');
  await post('gotoStay 0 0 ' + encodeURIComponent('Pocket Strings'));
  await page.waitForFunction(() => !document.querySelector('#svarStale').hidden, { timeout: 5000 });
  s = await stale();
  assert.deepEqual(s.reasons, ['Pigments changed']);
  assert.match(s.title, /Pigments changed/);
  assert.match(s.info, /out of date/);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: SHOTS + '/pre-read-stale.png', clip: { x: 0, y: 0, width: 1500, height: 260 } }); }

  // 4. A new read is current again; a new track makes it stale
  await read();
  assert.equal((await stale()).dot, false, 'current after reading again');
  srv.setData({ tracks: [...srv.state.data.tracks, { name: 'Harp', index: 3, sel: false, solo: false, mute: false }] });
  await page.waitForFunction(() => !document.querySelector('#svarStale').hidden, { timeout: 5000 });
  assert.deepEqual((await stale()).reasons, ['tracks changed (new: Harp)']);
  await read();
  assert.equal((await stale()).dot, false);

  // 5. Inspire Melody in Clip mode over the Flute clip (arranger bars 5–8): chords from the read (B♭ major there)
  await post('gotoStay 2 16 Flute');
  await page.waitForFunction(() => SV.state.liveData.track === 'Flute', { timeout: 5000 });
  await page.click(SEL.mode('clip'));
  await page.waitForFunction(() => SV.state.mode === 'clip');
  await page.click('#insBtn');
  await page.click('[data-open="melody"]');
  await page.waitForSelector('#insSource');
  assert.match(await page.$eval('#insSource', el => el.textContent), /the other staves of the last arrangement read/);
  await page.$eval('#insStart', el => { el.value = '1'; });
  await page.$eval('#insBars', el => { el.value = '4'; });
  await page.click('#insWrite');
  await page.waitForFunction(() => /melody, bars|No chords|error/i.test(document.querySelector('#insStatus').textContent), { timeout: 5000 });
  await sleep(500); // the adds reach the mock clip
  assert.match(await page.$eval('#insStatus', el => el.textContent), /melody, bars 1–4: [0-9]+ notes over the other staves of the last arrangement read/);
  const mel = srv.state.data.notes.slice().sort((a, b) => a.x - b.x);
  assert.ok(mel.length >= 6, 'a melody, got ' + mel.length);
  const bflat = [10, 2, 5];
  const downbeats = mel.filter(n => n.x % BAR === 0);
  assert.ok(downbeats.length >= 2, 'downbeats written');
  for (const n of downbeats) assert.ok(bflat.includes(n.y % 12), `downbeat ${n.y} fits B♭ major (clip bar ${n.x / BAR + 1} = arranger bar ${n.x / BAR + 5})`);
  await page.click('#insClose');

  // 6. Preference "keep my track selection"
  await page.click(SEL.mode('score'));
  await page.click('#trackBtn');
  await page.click('#svarShowAll');
  await page.click('input[name=trackMode][value=pinned]');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.arrangement.afterRead'))), 'keep');
  await read();
  assert.equal(await page.evaluate(() => SV.state.trackMode), 'pinned', 'track selection kept');
  assert.deepEqual(await shownParts(), ['Flute'], 'only the selected clip\'s track (no pins)');
  assert.deepEqual(errors, []);
  console.log('arrangement-e2e OK');
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
  await browser.close();
  await srv.close();
}
