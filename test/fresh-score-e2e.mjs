// A New Score starts an empty score (nothing from the previous project); switching Bitwig projects drops the old score.
import assert from 'assert';
import { withPage, loadFixtureScore } from './lib.mjs';
import { clickIn } from './selectors.mjs';

const base = await loadFixtureScore();
await withPage({ port: Number(process.env.PORT || 8960), mode: 'score' }, async ({ page, srv, errors }) => {
  srv.setData({ project: 'Mega Man 2' });
  await page.waitForFunction(() => SV.state.liveData && SV.state.liveData.project === 'Mega Man 2');
  await page.evaluate(b => { SV.setBase(b, 1); SV.state.pinned.add('Viola'); }, base);
  await page.waitForFunction(() => document.querySelectorAll('#paper g.note').length > 50);

  // The wizard created a string quartet: fresh, empty, 4 staves, section marks, no pins.
  await page.evaluate(() => SV.newScore({
    title: 'String quartet', timeSig: { num: 3, den: 4 }, lengthBeats: 24,
    markers: [{ beat: 0, name: 'A' }, { beat: 12, name: 'B' }],
    parts: [{ name: 'Violin 1' }, { name: 'Violin 2' }, { name: 'Viola' }, { name: 'Cello' }],
  }));
  srv.setData({ track: 'Violin 1', notes: [], exists: true, length: 16 });
  await page.waitForFunction(() => SV.state.base && SV.state.base.fresh && document.querySelectorAll('#paper g.staff').length > 0);
  await new Promise(r => setTimeout(r, 800));
  const view = await page.evaluate(() => ({
    notes: document.querySelectorAll('#paper g.note').length,
    staves: SV.state.render.staves.map(s => s.part.replace(/ ✎$/, '')),
    pinned: SV.state.pinned.size, base: SV.state.base.title, crawl: SV.state.crawl,
    marks: [...document.querySelectorAll('#paper g.reh')].map(e => e.textContent.trim()),
  }));
  console.log(JSON.stringify(view));
  assert.equal(view.notes, 0, 'no notes in a fresh score');
  assert.deepEqual(view.staves, ['Violin 1', 'Violin 2', 'Viola', 'Cello']);
  // pins are kept across scores/projects (a pin for a missing track is simply ignored)
  assert.equal(view.base, 'String quartet');
  await page.screenshot({ path: 'test/out-fresh-score.png' });

  // Switching to another Bitwig project drops that score.
  srv.setData({ project: 'Something Else' });
  await page.waitForFunction(() => SV.state.base === null, { timeout: 5000 });
  // "New empty score" from the project's instrument tracks (groups kept, effect/master/audio left out).
  srv.setData({ project: 'Hand made', tracks: [
    { name: 'Strings', group: true, type: 'Group', index: 0 }, { name: 'Violin', group: false, type: 'Instrument', index: 1 },
    { name: 'Cello', group: false, type: 'Instrument', index: 2 }, { name: 'Vox take', group: false, type: 'Audio', index: 3 },
    { name: 'Reverb', group: false, type: 'Effect', index: 4 }, { name: 'Master', group: false, type: 'Master', index: 5 } ] });
  await page.waitForFunction(() => SV.state.liveData.project === 'Hand made');
  await clickIn(page, '#freshBtn'); // in File ▾ (compact header)
  await page.waitForFunction(() => SV.state.base && SV.state.base.fresh && SV.state.base.title === 'Hand made');
  const parts = await page.evaluate(() => SV.state.base.parts.map(p => p.name + ':' + (p.group || '')));
  assert.deepEqual(parts, ['Violin:Strings', 'Cello:Strings']);
  assert.deepEqual(errors, []);
  console.log('fresh score e2e OK');
});
