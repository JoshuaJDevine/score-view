// End-to-end: the notation module in the page (issue #12). Loads the Mega Man 2 DAWproject in Score mode and
// checks tempo marks (♩ = 164, accel., ♩ = 180), the Notation menu toggles, and the Clip range re-basing.
//   PORT=8813 node test/notation-e2e.mjs
import assert from 'assert';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';
import { SEL, openMenu, setRange } from './selectors.mjs';

const port = Number(process.env.PORT || 8813);
const fixture = path.join(ROOT, 'test/fixtures/live-bass.json');

await withPage({ port, fixture, mode: 'score', height: 1100 }, async ({ page, errors }) => {
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('scoreview.notation.')) localStorage.removeItem(k); });
  await (await page.$(SEL.fileInput)).uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => window.SV.state.base && window.SV.state.render && window.SV.state.render.score.tempo, { timeout: 30000 });
  const info = () => page.evaluate(() => {
    const r = window.SV.state.render;
    return { tempo: r.score.tempo, changes: r.score.tempoChanges, text: document.getElementById('paper').textContent,
             mei: r.mei, offset: r.measureOffset, starts: r.measureStarts.slice(0, 2) };
  });
  await setRange(page, 'all');
  await new Promise(r => setTimeout(r, 500));
  let v = await info();
  assert.equal(v.tempo, 164);
  assert.ok(v.text.includes('= 164') && v.text.includes('accel.') && v.text.includes('= 180'), 'tempo marks engraved');
  console.log('ok   Score mode: ♩ = 164, accel., ♩ = 180');

  // Menu toggles: tempo marks off, then on again.
  await openMenu(page, 'notation');
  await page.click(SEL.notationOption('tempo'));
  await new Promise(r => setTimeout(r, 400));
  v = await info();
  assert.ok(!v.text.includes('= 164') && !v.mei.includes('<tempo'), 'tempo marks off');
  await page.click(SEL.notationOption('tempo'));
  await page.click(SEL.notationOption('ottava'));
  await new Promise(r => setTimeout(r, 400));
  v = await info();
  assert.ok(v.text.includes('= 164') && !v.mei.includes('<octave'), 'tempo back on, ottava lines off');
  console.log('ok   Notation menu toggles tempo marks and ottava lines');
  const stored = await page.evaluate(() => localStorage.getItem('scoreview.notation.ottava'));
  assert.equal(stored, 'false');
  await page.click(SEL.notationOption('ottava'));

  // Clip bars: the Bass clip moved to its 4th place (bar 89); the first rendered bar is the real bar and the tempo
  // there is the one in force (164, the ramp starts at bar 89).
  await setRange(page, 'clip');
  for (let i = 0; i < 3; i++) { await page.click(SEL.alignStep(1)); await new Promise(r => setTimeout(r, 300)); }
  v = await info();
  assert.equal(v.offset, 88);
  assert.equal(v.starts[0], 352);
  assert.ok(v.mei.includes('accel.') && v.tempo === 164, 'accel. from the first clip bar');
  console.log('ok   Clip bars at bar 89: measureStarts absolute (' + v.starts.join(', ') + '), ♩ = 164 then accel.');
  assert.deepEqual(errors, []);
});
console.log('notation e2e passed');
