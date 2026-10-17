// Orchestrate in the page against the mock's arrangement + clip navigator:
// explode a 4-note chord to 4 string tracks, double a line an octave down to the cellos, a missing clip,
// and a goto that fails in the extension (its notes must not land in another clip).
//   PORT=8931 node test/orchestrate-e2e.mjs
import assert from 'assert';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';
import { CHROME, ROOT } from './lib.mjs';

const PORT = Number(process.env.PORT || 8931);
const clip = (lane, track, start, playStop, notes = [], extra = {}) =>
  ({ lane, track, start, playStart: 0, playStop, loop: false, loopStart: 0, loopLength: playStop, notes, ...extra });
const n = (x, y, d) => ({ ch: 0, x, y, d, vel: 100 });
const arrangement = {
  tracks: [{ name: 'Strings', group: true }, { name: 'Violins 1' }, { name: 'Violins 2' }, { name: 'Violas' }, { name: 'Cellos' },
           { name: 'Basses' }, { name: 'Piano' }],
  home: 0,
  clips: [
    clip(7, 'Piano', 0, 16, [n(0, 48, 4), n(0, 64, 4), n(0, 67, 4), n(0, 72, 4), n(96, 67, 1), n(120, 69, 1), n(144, 71, 1), n(168, 72, 1)]),
    clip(2, 'Violins 1', 0, 16),
    clip(3, 'Violins 2', 0, 16),
    clip(4, 'Violas', 0, 16, [], { playStart: 4, playStop: 20, loopLength: 20 }), // content offset: x = (beat + 4) * 24
    clip(5, 'Cellos', 0, 16),
    clip(6, 'Basses', 32, 8), // nothing at bar 1
  ],
};

const srv = await startMockServer({ port: PORT, arrangement, markers: [] });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
const clipOf = t => srv.arrangement.clips.find(c => c.track === t);
const notesOf = t => clipOf(t).notes.map(q => [q.x, q.y, q.d]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.setItem('scoreview.mode', '"score"'); });
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && window.SV.orchestrate && window.SV.state.liveData, { timeout: 30000 });

  // Read the arrangement (mock crawl) -> Score mode base + SV.state.crawl; the Piano clip gets placed at beat 0.
  await page.click('#svarRead');
  await page.waitForFunction(() => SV.state.crawl && SV.state.base && SV.state.align && document.querySelector('#paper svg'), { timeout: 15000 });

  // ---- 1. Explode the chord via the dialog (Alt+X), Basses unticked.
  await page.evaluate(() => {
    SV.state.selection = new Set(SV.state.liveData.notes.filter(q => q.x === 0).map(SV.liveId));
    SV.paintSelection();
  });
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyX'); await page.keyboard.up('Alt');
  await page.waitForSelector('#orcPanel:not(.hidden)');
  const defaults = await page.$$eval('[data-tgt]', els => els.filter(e => e.checked).map(e => e.dataset.tgt));
  assert.deepEqual(defaults, ['Violins 1', 'Violins 2', 'Violas', 'Cellos', 'Basses'], 'default targets: the string section');
  await page.click('[data-tgt="Basses"]');
  const preview = await page.$eval('#orcPreview', e => e.textContent);
  assert.match(preview, /Violins 1: 1 note \(C5\)/);
  assert.match(preview, /Cellos: 1 note \(C3\)/);
  await page.screenshot({ path: path.join(ROOT, 'test/out.orchestrate-panel.png') });
  await page.click('#orcApply');
  await page.waitForFunction(() => SV.orchestrate.lastReport() && /Wrote/.test(SV.orchestrate.lastReport().message), { timeout: 15000 });
  let rep = await page.evaluate(() => SV.orchestrate.lastReport());
  assert.deepEqual(rep.failed, [], JSON.stringify(rep));
  assert.deepEqual(notesOf('Violins 1'), [[0, 72, 4]]);
  assert.deepEqual(notesOf('Violins 2'), [[0, 67, 4]]);
  assert.deepEqual(notesOf('Violas'), [[96, 64, 4]], 'content offset honoured');
  assert.deepEqual(notesOf('Cellos'), [[0, 48, 4]]);
  assert.equal(srv.state.data.track, 'Piano', 'back on the original clip');
  assert.equal(srv.nav.session, false);
  assert.equal(srv.edits.filter(l => l.startsWith('goto ')).length, 4);
  assert(srv.edits.includes('goto 4 0 Violas'));
  // The score shows the result without reading Bitwig again.
  const v1 = await page.evaluate(() => SV.state.base.parts.find(p => p.name === 'Violins 1').notes.map(q => [q.start, q.pitch]));
  assert.deepEqual(v1, [[0, 72]]);
  await page.click('#orcClose');

  // ---- 2. Double the melody an octave lower in the cellos.
  await page.waitForFunction(() => SV.state.align && SV.state.liveData.track === 'Piano');
  rep = await page.evaluate(async () => {
    SV.state.selection = new Set(SV.state.liveData.notes.filter(q => q.x >= 96).map(SV.liveId));
    return SV.orchestrate.apply({ op: 'double', source: 'selection', targets: ['Cellos'], interval: 'octDown', keepRanges: true });
  });
  assert.deepEqual(rep.failed, [], JSON.stringify(rep));
  assert.deepEqual(notesOf('Cellos'), [[0, 48, 4], [96, 55, 1], [120, 57, 1], [144, 59, 1], [168, 60, 1]]);

  // ---- 3. Missing clip: Basses have no clip at bar 1 -> reported, nothing sent for them, the rest written.
  const before = srv.edits.length;
  rep = await page.evaluate(async () => {
    SV.state.selection = new Set(SV.state.liveData.notes.filter(q => q.x === 0).map(SV.liveId));
    return SV.orchestrate.apply({ op: 'explode', source: 'selection', targets: ['Violins 1', 'Violins 2', 'Violas', 'Cellos', 'Basses'],
                                  bassOctave: true, keepRanges: true });
  });
  assert.equal(rep.failed.length, 1);
  assert.match(rep.failed[0], /^Basses: No clip on Basses at bar 1 — create one in Bitwig/);
  assert(!srv.edits.slice(before).some(l => l.includes('Basses')));
  assert.deepEqual(notesOf('Basses'), []);

  // ---- 4. The clip moved in Bitwig after the read: the goto fails and its notes are dropped, not written elsewhere.
  clipOf('Violins 2').start = 4;
  const pianoBefore = notesOf('Piano');
  rep = await page.evaluate(async () => {
    SV.state.selection = new Set(SV.state.liveData.notes.filter(q => q.x === 0).map(SV.liveId));
    return SV.orchestrate.apply({ op: 'explode', source: 'selection', targets: ['Violins 1', 'Violins 2', 'Violas', 'Cellos'], keepRanges: true });
  });
  assert.equal(rep.failed.length, 1, JSON.stringify(rep));
  assert.match(rep.failed[0], /Violins 2: .*No clip on Violins 2 starting at beat 0/);
  assert.deepEqual(notesOf('Piano'), pianoBefore, 'nothing landed in the original clip');
  assert.deepEqual(notesOf('Violins 2'), [[0, 67, 4]]);
  assert.match(rep.failed[0], /1 note not written/);
  assert.equal(srv.state.data.track, 'Piano');

  clipOf('Violins 2').start = 0;

  // ---- 5. Reduce: Violins 1 + Violas, bar 1 (staves as the source) merged onto Violins 2.
  rep = await page.evaluate(async () => SV.orchestrate.apply({ op: 'reduce', source: 'staves', staves: ['Violins 1', 'Violas'], fromBar: 1, toBar: 1,
                                                               reduceTarget: 'Violins 2', reduceFit: false }));
  assert.deepEqual(rep.failed, [], JSON.stringify(rep));
  assert.deepEqual(notesOf('Violins 2'), [[0, 64, 4], [0, 67, 4], [0, 72, 4]]);

  await page.screenshot({ path: path.join(ROOT, 'test/out.orchestrate-score.png') });
  assert.deepEqual(errors, []);
  console.log('orchestrate e2e passed');
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
  await browser.close();
  await srv.close();
}
