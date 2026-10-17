// Inspire ▾ Continue the phrase against the mock arrangement + clip navigator: a Hopeful 8-bar question (pad on Strings,
// melody on Flute) gets a parallel answer in bars 9–16 written into both tracks; Again replaces it; too few clip bars
// gives a clear message.   PORT=8941 node test/inspire-continue-e2e.mjs
import assert from 'assert';
import { createRequire } from 'module';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';
import { CHROME } from './lib.mjs';
const require = createRequire(import.meta.url);
const C = require('../web/features/inspire.js'), L = require('../web/features/inspire-library.js');

const PORT = Number(process.env.PORT || 8941);
const BAR = 96, pc = p => ((p % 12) + 12) % 12;
const mood = L.byId('hopeful');
const question = C.plan({ mood, tonic: 0, bars: 8, barSteps: BAR, startStep: 0, range: [55, 93], seed: 2 }); // IV I V vi ×2
const tune = C.planMelody({ mood, chords: question.chords, tonic: 0, startStep: 0, bars: 8, barSteps: BAR, spb: 24, range: [60, 96], seed: 1 });
const toClip = ns => ns.map(n => ({ ch: 0, x: n.x, y: n.y, d: n.d / 24, vel: n.vel }));
const clip = (lane, track, notes) => ({ lane, track, start: 0, playStart: 0, playStop: 64, loop: false, loopStart: 0, loopLength: 64, notes });
const arrangement = {
  tracks: [{ name: 'Flute' }, { name: 'Strings' }],
  home: 0,
  clips: [clip(0, 'Flute', toClip(tune.notes)), clip(1, 'Strings', toClip(question.notes))],
};
const pad = { track: 'Strings', spb: 24, tonic: 0, mood: 'hopeful', chords: question.chords };

const srv = await startMockServer({ port: PORT, arrangement, markers: [] });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
const notesOf = t => srv.arrangement.clips.find(c => c.track === t).notes;
const inBars = (t, a, b) => notesOf(t).filter(n => n.x >= a * BAR && n.x < b * BAR).sort((p, q) => p.x - q.x || p.y - q.y);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(p => { localStorage.clear(); localStorage.setItem('scoreview.mode', '"score"');
    localStorage.setItem('scoreview.inspire.lastPad', JSON.stringify(p)); }, pad);
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && window.SV.inspire && window.SV.state.liveData, { timeout: 30000 });
  await page.click('#svarRead');
  await page.waitForFunction(() => SV.state.crawl && SV.state.base && SV.state.align && document.querySelector('#paper svg'), { timeout: 15000 });

  await page.click('#insBtn');
  await page.click('[data-open="continue"]');
  await page.waitForSelector('#insSource');
  assert.equal(await page.$eval('#insChords', e => e.value), 'Strings', 'chords detected on the pad track');
  assert.equal(await page.$eval('#insMelody', e => e.value), 'Flute', 'melody detected on the other track');
  assert.equal(await page.$eval('#insMood', e => e.value), 'hopeful');
  assert.match(await page.$eval('#insSource', e => e.textContent), /Question: bars 1–8, ending on vi\. The answer starts at bar 9/);
  assert.equal(await page.$eval('#insBars', e => e.value), '8');

  const status = () => page.$eval('#insStatus', e => e.textContent);
  await page.click('#insWrite');
  await page.waitForFunction(() => /answer, bars|Not written|lengthen|error/i.test(document.querySelector('#insStatus').textContent), { timeout: 30000 });
  const s1 = await status();
  assert.match(s1, /^Parallel answer, bars 9–16: IVadd9 – Iadd9 – V – vi – IV – V – Iadd9 – Iadd9/, s1);
  assert.equal(srv.state.data.track, 'Flute', 'back on the original clip');

  // Strings: 8 bars of answer, ending on a C chord
  const strings = inBars('Strings', 8, 16);
  assert.ok(strings.length >= 8, 'pad written: ' + strings.length);
  const lastChord = strings.filter(n => n.x <= 15 * BAR && n.x + n.d * 24 > 15 * BAR).map(n => pc(n.y));
  assert.ok(lastChord.includes(0) && lastChord.includes(4), 'final chord is C major: ' + lastChord);
  // Flute: bars 9–10 restate bars 1–2; the line ends on C
  const flute = inBars('Flute', 8, 16);
  const motif = inBars('Flute', 0, 2).map(n => [n.x, n.y]);
  assert.deepEqual(inBars('Flute', 8, 10).map(n => [n.x - 8 * BAR, n.y]), motif, 'parallel period: the opening returns');
  assert.equal(pc(flute[flute.length - 1].y), 0, 'melody ends on the tonic');
  flute.forEach((n, i) => i && assert.ok(flute[i - 1].x < n.x, 'melody stays one line'));
  // The question is untouched
  assert.equal(inBars('Strings', 0, 8).length, question.notes.length);

  // Again: another answer replaces this one
  const before = JSON.stringify(inBars('Strings', 8, 16).map(n => [n.x, n.y]));
  await page.click('#insAgain');
  await page.waitForFunction(prev => document.querySelector('#insStatus').textContent !== prev && /answer, bars/.test(document.querySelector('#insStatus').textContent), { timeout: 30000 }, s1).catch(async e => { console.log('STATUS:', await status(), 'ERRORS:', errors, 'EDITS:', srv.edits.slice(-8)); throw e; });
  assert.match(await status(), /IVadd9 – Iadd9 – V – vi – ii – V – Iadd9 – Iadd9/);
  assert.notEqual(JSON.stringify(inBars('Strings', 8, 16).map(n => [n.x, n.y])), before, 'Again rewrote the pad');
  const flute2 = inBars('Flute', 8, 16);
  flute2.forEach((n, i) => i && assert.ok(flute2[i - 1].x < n.x, 'no leftovers from the first answer'));

  // Write again: continues after the answer (bars 17–28), past the clips' end: clear message, nothing written
  const count = notesOf('Strings').length;
  await page.$eval('#insBars', e => { e.value = '12'; });
  await page.click('#insWrite');
  await page.waitForFunction(() => /lengthen the clip/.test(document.querySelector('#insStatus').textContent), { timeout: 30000 });
  assert.match(await status(), /No clip on Strings at bar 17 — lengthen the clip in Bitwig so it reaches bar 29/, 'Write continues from the new end (the answer is now part of the question)');
  assert.equal(notesOf('Strings').length, count);

  assert.deepEqual(errors, []);
  console.log('inspire-continue-e2e OK');
} finally {
  await browser.close();
  await srv.close();
}
