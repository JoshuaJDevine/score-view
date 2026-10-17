// A clip whose start was trimmed in Bitwig (playStart / "Offset" > 0): the score starts at the visible start,
// and edits/entry map back to the right content steps.
import assert from 'assert';
import { withPage } from './lib.mjs';

const spb = 24;
// Recorded after a one-bar count-in: content notes start at beat 4. The clip start is then trimmed by one bar.
const notes = [[4, 60], [5, 62], [6, 64], [7, 65], [8, 67]].map(([b, y]) => ({ ch: 0, x: b * spb, y, d: 1, vel: 100, sel: false }));

await withPage({ port: Number(process.env.PORT || 8962), mode: 'clip' }, async ({ page, srv, errors }) => {
  srv.setData({ track: 'Take', notes, length: 12, playStart: 0, loop: false });
  await page.waitForFunction(() => SV.state.liveData && SV.state.liveData.track === 'Take' && SV.state.render);
  const before = await page.evaluate(() => Math.min(...SV.state.render.timeline.map(t => t.start)));
  assert.equal(before, 4, 'untrimmed: first note at beat 4 (after the count-in bar)');

  srv.setData({ playStart: 4 }); // trim the clip's start in Bitwig
  await page.waitForFunction(() => SV.state.liveData.playStart === 4 && SV.state.render &&
    Math.min(...SV.state.render.timeline.map(t => t.start)) === 0, { timeout: 5000 });
  const view = await page.evaluate(() => ({ measures: SV.state.render.measures, first: SV.state.render.timeline[0].start }));
  assert.equal(view.first, 0, 'trimmed: the passage starts at beat 0');
  assert.equal(view.measures, 2, 'trimmed: 8 visible beats = 2 bars');

  // Entry starts at the visible start and writes at content step 96 (beat 4).
  await page.keyboard.press('Escape');
  await page.evaluate(() => { SV.state.selection.clear(); SV.paintSelection(); });
  await page.focus('#main');
  await page.keyboard.press('n');
  await page.waitForFunction(() => SV.entry && SV.entry.state && SV.entry.state.on);
  const caret = await page.evaluate(() => SV.entry.state.caret);
  assert.equal(caret, 4 * spb, 'caret starts at the visible clip start');
  await page.keyboard.press('5');
  await page.keyboard.press('c');
  await new Promise(r => setTimeout(r, 500));
  const added = srv.edits.filter(e => e.startsWith('add'));
  assert(added.length && added[0].startsWith('add 0 96 '), 'entered note lands at content step 96: ' + JSON.stringify(added));

  // Selected-notes playhead in clip mode: content step 120 = visible beat 1.
  srv.setPlay({ playing: true, step: 5 * spb, pos: 20 });
  await page.waitForFunction(() => SV.state.playBeat === 1, { timeout: 3000 });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: 'test/out-clip-offset.png' });
  console.log('clip offset e2e OK');
});
