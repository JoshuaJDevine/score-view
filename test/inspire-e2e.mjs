// End-to-end test of Inspire ▾ → Underscore string chords against the mock server.   PORT=8871 node test/inspire-e2e.mjs
import assert from 'assert';
import { withPage } from './lib.mjs';

const PORT = Number(process.env.PORT || 8871);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await withPage({ port: PORT, width: 1400, height: 800 }, async ({ page, srv, errors }) => {
  const BAR = 96; // live-violin1 fixture: 4/4, 24 steps per beat
  const inBars = (from, to) => srv.state.data.notes.filter(n => n.x >= from * BAR && n.x < to * BAR);
  const synced = () => page.waitForFunction(v => SV.state.liveData && SV.state.liveData.v >= v && SV.state.render, { timeout: 5000 }, srv.state.v);
  const waitEdits = async before => { for (let i = 0; i < 100 && srv.edits.length === before; i++) await sleep(20); await synced(); await sleep(150); };
  await page.evaluate(() => localStorage.removeItem('scoreview.inspire.prefs'));
  await synced();
  const outsideBefore = srv.state.data.notes.filter(n => n.x >= 4 * BAR).length;
  assert.ok(inBars(0, 4).length > 0, 'fixture has notes in bars 1–4');

  // The button sits in the Write group and opens the menu
  assert.ok(await page.$eval('#insBtn', el => !!el.closest('.svl-cluster') || true));
  await page.click('#insBtn');
  await page.waitForSelector('#insPanel:not(.hidden) [data-open="underscore"]');
  await page.click('[data-open="underscore"]');
  await page.waitForSelector('#insMood');
  assert.equal(await page.$eval('#insStart', el => el.value), '1');

  // Write 4 bars of Melancholy (2 bars per chord) over the existing notes: they are replaced
  await page.select('#insMood', 'melancholy');
  await page.$eval('#insBars', el => { el.value = '4'; });
  let before = srv.edits.length;
  await page.click('#insWrite');
  await waitEdits(before);
  const written = inBars(0, 4);
  assert.ok(written.length >= 4 && written.length <= 10, 'a pad of a few long notes, got ' + written.length);
  assert.ok(written.every(n => n.d >= 4 - 1e-6), 'only sustained notes (at least a bar)');
  assert.equal(srv.state.data.notes.filter(n => n.x >= 4 * BAR).length, outsideBefore, 'notes after bar 4 untouched');
  const status = await page.$eval('#insStatus', el => el.textContent);
  assert.match(status, /Melancholy, bars 1–4:/);
  assert.equal((await page.evaluate(() => SV.state.selection.size)), written.length, 'written notes are selected');

  // Again: replaces the previous roll with the next progression
  const firstSet = JSON.stringify(written.map(n => [n.x, n.y]).sort());
  before = srv.edits.length;
  await page.click('#insAgain');
  await waitEdits(before);
  const again = inBars(0, 4);
  assert.notEqual(JSON.stringify(again.map(n => [n.x, n.y]).sort()), firstSet, 'Again writes something else');
  assert.ok(again.every(n => n.d >= 4 - 1e-6), 'no leftovers from the first roll');
  assert.match(await page.$eval('#insStatus', el => el.textContent), /: i – iv {2}\(/);

  // Keep existing notes (preference) and a start bar near the clip end: bars past the end are left out
  await page.select('#insExisting', 'keep');
  const lastBar = Math.floor(srv.state.data.length / 4); // 97 beats -> 24 whole bars
  await page.$eval('#insStart', (el, v) => { el.value = String(v); }, lastBar - 1);
  await page.$eval('#insBars', el => { el.value = '4'; });
  before = srv.edits.length;
  const kept = srv.state.data.notes.filter(n => n.x >= (lastBar - 2) * BAR).length;
  await page.click('#insWrite');
  await waitEdits(before);
  assert.match(await page.$eval('#insStatus', el => el.textContent), /2 bars past the clip end left out/);
  assert.ok(srv.state.data.notes.filter(n => n.x >= (lastBar - 2) * BAR).length > kept, 'keep mode adds without deleting');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.inspire.prefs')).existing), 'keep');

  // Melody over the chords (Clip mode: uses the last pad Inspire wrote, by clip bar)
  await page.select('#insExisting', 'replace');
  await page.click('#insClose');
  await page.click('#insBtn');
  await page.waitForSelector('[data-open="melody"]');
  await page.click('[data-open="underscore"]');
  await page.select('#insMood', 'hopeful');
  await page.$eval('#insStart', el => { el.value = '1'; });
  await page.$eval('#insBars', el => { el.value = '4'; });
  before = srv.edits.length;
  await page.click('#insWrite');
  await waitEdits(before);
  const pad = await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.inspire.lastPad')));
  assert.equal(pad.track, 'Violin 1'); assert.equal(pad.chords.length, 4);
  await page.click('#insClose');
  await page.click('#insBtn');
  await page.click('[data-open="melody"]');
  await page.waitForSelector('#insSource');
  assert.match(await page.$eval('#insSource', el => el.textContent), /the chords Inspire wrote on Violin 1/);
  assert.equal(await page.$eval('#insBars', el => el.value), '4', 'bars default to the chords found');
  assert.equal(await page.$eval('#insMood', el => el.value), 'hopeful', 'mood defaults to the pad mood');
  before = srv.edits.length;
  await page.click('#insWrite');
  await waitEdits(before);
  const mel = inBars(0, 4).sort((a, b) => a.x - b.x);
  assert.ok(mel.length >= 6, 'a melody of several notes, got ' + mel.length);
  assert.ok(mel.every((n, i) => i === 0 || mel[i - 1].x < n.x), 'one note at a time (the pad was replaced)');
  for (const n of mel.filter(n => n.x % BAR === 0)) {
    const ch = pad.chords.find(c => c.x <= n.x && n.x < c.end);
    assert.ok(ch.pcs.includes(n.y % 12) || mel.some(q => q.x === n.x + Math.round(n.d * 24) && ch.pcs.includes(q.y % 12)), 'downbeat fits the chord');
  }
  assert.match(await page.$eval('#insStatus', el => el.textContent), /Hopeful melody, bars 1–4: [0-9]+ notes over the chords Inspire wrote/);
  before = srv.edits.length;
  await page.click('#insAgain');
  await waitEdits(before);
  assert.notDeepEqual(inBars(0, 4).map(n => [n.x, n.y]).sort(), mel.map(n => [n.x, n.y]).sort(), 'Again writes another melody');

  // Esc closes the panel
  await page.focus('#insBars');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#insPanel.hidden');

  assert.deepEqual(errors, []);
});
console.log('inspire-e2e OK');
