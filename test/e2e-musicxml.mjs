// End-to-end: the "Export MusicXML" button in the page produces a MusicXML download.
// The download is intercepted (URL.createObjectURL + <a download>.click) and its content checked.
//   PORT=8882 node test/e2e-musicxml.mjs
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';
import { clickIn } from './selectors.mjs';

const port = Number(process.env.PORT || 8882);

// Installs the interceptor, clicks Export, returns { name, type, text }.
async function clickExport(page, range) {
  await page.evaluate(() => {
    window.__mx = null;
    const blobs = new Map();
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { const u = orig(b); blobs.set(u, b); return u; };
    HTMLAnchorElement.prototype.click = function () {
      const b = blobs.get(this.href);
      if (b) b.text().then(text => { window.__mx = { name: this.download, type: b.type, text }; });
    };
  });
  await page.select('#mxRange', range);
  await clickIn(page, '#mxExport');
  await page.waitForFunction(() => window.__mx, { timeout: 60000 });
  return page.evaluate(() => window.__mx);
}

const count = (xml, re) => (xml.match(re) || []).length;

// Clip mode: the live clip.
await withPage({ port, mode: 'clip' }, async ({ page, errors }) => {
  const r = await clickExport(page, 'view');
  assert.match(r.name, /\.musicxml$/);
  assert.equal(r.type, 'application/vnd.recordare.musicxml+xml');
  assert.match(r.text, /<score-partwise version="4.0">/);
  const shown = await page.$$eval('#paper g.note', els => els.length);
  const notes = count(r.text, /<pitch>/g);
  assert(notes >= shown && notes > 50, `exported ${notes} pitches for ${shown} engraved notes`);
  fs.writeFileSync(path.join(ROOT, 'test/out-e2e-clip.musicxml'), r.text);
  assert.deepEqual(errors, []);
  console.log(`clip export OK: ${r.name}, ${notes} notes, ${count(r.text, /<measure /g)} measures`);
});

// Score mode with the Mega Man 2 DAWproject: current view (clip bars) vs whole song, all tracks.
await withPage({ port, mode: 'score', height: 1200 }, async ({ page, errors }) => {
  const input = await page.$('#fileInput');
  await input.uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => window.SV.state.base && window.SV.state.render && window.SV.state.render.measures > 0, { timeout: 30000 });
  await page.evaluate(() => { window.SV.state.range = 'clip'; window.SV.render(); });
  const before = await page.evaluate(() => ({ range: SV.state.range, trackMode: SV.state.trackMode, measures: SV.state.render.measures, offset: SV.state.render.measureOffset }));

  const view = await clickExport(page, 'view');
  const viewMeasures = count(view.text.split('</part>')[0], /<measure /g);
  assert.equal(viewMeasures, before.measures, 'view export has the shown bars');
  const title = await page.evaluate(() => SV.state.base.title);
  assert.equal(view.name, `${title} - bars ${before.offset + 1}-${before.offset + before.measures}.musicxml`);

  const song = await clickExport(page, 'songAll');
  const songMeasures = count(song.text.split('</part>')[0], /<measure /g);
  const parts = count(song.text, /<score-part /g);
  assert.equal(song.name, title + '.musicxml');
  assert(songMeasures >= 128, 'whole song has all bars: ' + songMeasures);
  assert(parts >= 20, 'all tracks exported: ' + parts);
  const after = await page.evaluate(() => ({ range: SV.state.range, trackMode: SV.state.trackMode, measures: SV.state.render.measures, offset: SV.state.render.measureOffset }));
  assert.deepEqual(after, before, 'view restored after whole-song export');
  assert.match(song.text, /<transpose><diatonic>-1<\/diatonic><chromatic>-2<\/chromatic><\/transpose>/, 'Clarinet exported in written pitch');
  fs.writeFileSync(path.join(ROOT, 'test/out-e2e-song.musicxml'), song.text);
  await page.screenshot({ path: path.join(ROOT, 'test/out-e2e-musicxml.png') });
  assert.deepEqual(errors, []);
  console.log(`score export OK: view ${view.name} (${viewMeasures} bars); song ${song.name} (${songMeasures} bars, ${parts} parts)`);
});
