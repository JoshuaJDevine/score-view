// ⟳ Read arrangement in the page against the mock arrangement:
//  * Score mode shows every track with notes after a read (preference "show all tracks", default), or keeps the
//    Tracks choice ("keep my track selection");
//  * the out-of-date dot: the track list changed; a clip changed while selected is taken into the read by the mirror,
//    and writes through SV.orchestrate.writeTracks and a new read keep it current;
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
    localStorage.setItem('scoreview.view', '"score"');
    localStorage.setItem('scoreview.scoreShow', '"pinned"');
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

  // 1. Score view, "Pinned only" with no pins: only the selected clip's track. A Read keeps that choice;
  //    "All instruments" (Instruments ▾) shows every track with notes.
  assert.deepEqual(await shownParts(), ['Pigments']);
  await read();
  assert.deepEqual(await shownParts(), ['Pigments'], 'a Read keeps the view');
  await page.evaluate(() => SV.core.setScoreShow('all'));
  await page.waitForFunction(() => SV.state.render.score.parts.length === 2, { timeout: 5000 });
  assert.deepEqual(await shownParts(), ['Pigments', 'Pocket Strings'], 'all instruments');
  assert.equal(await page.evaluate(() => SV.state.trackMode), 'all');
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: SHOTS + '/read-all-instruments.png' });
  }
  // Clip bars: the selected Pigments clip (bars 1–4) widened to the overlapping Pocket Strings clip (bars 1–8).
  await page.evaluate(() => { SV.state.range = 'clip'; SV.render(); });
  assert.equal(await page.evaluate(() => SV.state.render.measures), 8, 'Clip bars cover the overlapping clips on the shown staves');
  await page.evaluate(() => { SV.state.range = 'all'; SV.render(); });
  // A pinned track gets a pin beside its staff name.
  await page.evaluate(() => { SV.state.pinned.add('Pocket Strings'); SV.render(); });
  await page.waitForFunction(() => document.querySelectorAll('#paper .svpb-pin').length >= 1, { timeout: 5000 });
  await page.evaluate(() => { SV.state.pinned.delete('Pocket Strings'); SV.render(); });
  assert.equal(await page.evaluate(() => document.querySelectorAll('#paper .svpb-pin').length), 0, 'unpinned: no pin');

  let s = await stale();
  assert.equal(s.dot, false, 'fresh read is current');
  assert.match(s.info, /✓ 2 parts read/);

  // 2. Writes through SV.orchestrate.writeTracks (Inspire Continue, Orchestrate) keep the read current
  const w = await page.evaluate(() => SV.orchestrate.writeTracks([{ track: 'Pocket Strings', notes: [{ start: 0.5, dur: 0.5, pitch: 72, vel: 0.8 }] }]));
  assert.deepEqual(w.done, ['Pocket Strings'], JSON.stringify(w));
  await sleep(1800);
  assert.deepEqual((await stale()).reasons, [], 'writeTracks keeps the read current');

  // 3. Pigments changed in Bitwig while selected: once settled, the mirror (features/arrangement.js harvest) takes
  //    the clip into the read, so selecting another clip leaves the read current. ("<track> changed" for a clip the
  //    mirror could not place is covered by test/arrangement-stale-test.mjs and test/arrangement-mirror-e2e.mjs.)
  srv.setNotes([...srv.state.data.notes.map(n => ({ ...n })), { ch: 0, x: 48, y: 76, d: 1, vel: 100, sel: false }]);
  await page.waitForFunction(() => SV.state.crawl.result.some(c => c.track === 'Pigments' && c.notes.some(n => n[2] === 76)), { timeout: 5000 });
  assert.equal((await stale()).dot, false, 'the selected clip is harvested into the read');
  await post('gotoStay 0 0 ' + encodeURIComponent('Pocket Strings'));
  await page.waitForFunction(() => SV.state.liveData.track === 'Pocket Strings' && SV.state.liveData.settled !== false, { timeout: 5000 });
  await sleep(300);
  s = await stale();
  assert.deepEqual(s.reasons, [], 'the harvested clip matches: the read stays current');
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

  // 6. Clip view with a pinned track: the selected clip plus the pinned track; a Read stays in Clip view.
  await page.click(SEL.mode('clip'));
  await page.evaluate(() => SV.core.setPinned('Pocket Strings', true));
  await read();
  assert.equal(await page.evaluate(() => SV.state.view + '/' + SV.state.mode + '/' + SV.state.range), 'clip/score/clip', 'still Clip view');
  assert.deepEqual(await shownParts(), ['Flute', 'Pocket Strings'], 'the selected clip\'s track + the pinned one');
  assert.match(await page.$eval('#pinBtn', el => el.textContent), /Pin$/, 'Flute itself is not pinned');
  await page.evaluate(() => SV.core.setPinned('Flute', true));
  assert.ok(await page.$eval('#pinBtn', el => el.classList.contains('on') && /Pinned/.test(el.textContent)), 'the Pin toggle lights up');

  // 7. A read that cannot start (Bitwig's focus is on notes in the clip editor): a prompt says what to do; selecting
  //    another clip in Bitwig tries again by itself. Try again / Close work too.
  const failShown = () => page.evaluate(() => !document.querySelector('#svarFail').hidden);
  srv.failCrawl('Bitwig is stepping through the notes inside the clip, not through clips.', 'clickClip');
  const before = await page.evaluate(() => SV.state.baseMtime);
  await page.click('#svarRead');
  await page.waitForFunction(() => !document.querySelector('#svarFail').hidden, { timeout: 10000 });
  assert.match(await page.$eval('#svarFail', el => el.textContent), /could not be read.*stepping through the notes.*click any clip in the Arranger/is);
  assert.equal(await page.evaluate(() => SV.state.baseMtime), before, 'no new read installed');
  srv.selectClip(0); // the user clicks the Pocket Strings clip in Bitwig
  await page.waitForFunction(t0 => SV.state.baseMtime > t0 && !document.querySelector('#svarRead').disabled, { timeout: 15000 }, before);
  assert.equal(await failShown(), false, 'the retry closed the prompt');
  srv.failCrawl('Bitwig action not found: Select Next');
  await page.click('#svarRead');
  await page.waitForFunction(() => !document.querySelector('#svarFail').hidden, { timeout: 10000 });
  await page.click('#svarRetry');
  await page.waitForFunction(() => document.querySelector('#svarFail').hidden && !document.querySelector('#svarRead').disabled, { timeout: 15000 });
  srv.failCrawl('Bitwig action not found: Select Next');
  await page.click('#svarRead');
  await page.waitForFunction(() => !document.querySelector('#svarFail').hidden, { timeout: 10000 });
  await page.click('#svarFailClose');
  assert.equal(await failShown(), false, 'Close');
  // fix 'stop': the mock is not playing, so the prompt tries again by itself (the 500 ms tick) and the read lands
  const beforeStop = await page.evaluate(() => SV.state.baseMtime);
  srv.failCrawl('Stop playback first.', 'stop');
  await page.click('#svarRead');
  await page.waitForFunction(t0 => SV.state.baseMtime > t0 && document.querySelector('#svarFail').hidden &&
    !document.querySelector('#svarRead').disabled, { timeout: 15000 }, beforeStop);
  assert.deepEqual(errors, []);
  console.log('arrangement-e2e OK');
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
  await browser.close();
  await srv.close();
}
