// End-to-end test of section views, score order and clip placement against the mock server:
// loads the Mega Man 2 DAWproject into the page with the Bass clip live, then checks the Strings, Brass and
// Full views and the ◀ ▶ placement cycling. Screenshots: test/out.sections-{strings,brass,full}.png
//   PORT=8812 node test/sections-e2e.mjs
import assert from 'assert';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';

const port = Number(process.env.PORT || 8812);
const fixture = path.join(ROOT, 'test/fixtures/live-bass.json');

await withPage({ port, fixture, mode: 'score', height: 1100 }, async ({ page, srv, errors }) => {
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('scoreview.sections.')) localStorage.removeItem(k); });
  await (await page.$('#fileInput')).uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => window.SV.state.base && document.querySelector('#svSectionSeg button[data-section="Strings"]'), { timeout: 30000 });

  const view = async section => {
    await page.click(`#svSectionSeg button[data-section="${section}"]`);
    await page.waitForFunction(s => document.querySelector(`#svSectionSeg button[data-section="${s}"]`).classList.contains('on'), {}, section);
    await new Promise(r => setTimeout(r, 300));
    return page.evaluate(() => ({
      parts: window.SV.state.render.score.parts.map(p => p.name),
      groups: [...new Set(window.SV.state.render.score.parts.map(p => p.group))],
      title: document.getElementById('title').textContent,
      nav: !document.getElementById('alignNav').classList.contains('hidden'),
    }));
  };

  // Placement: the Bass clip fits at bars 1, 25, 57 and 89; bar 1 first, cycle with ▶.
  let v = await view('Strings');
  assert.deepEqual(v.parts, ['Violin Solo', 'Violin 1', 'Violin 2', 'Viola', 'Cello', 'Bass ✎']);
  assert.match(v.title, /Bass @ bar 1 \(1 of 4\)/);
  assert.ok(v.nav, 'placement arrows shown');
  await page.screenshot({ path: 'test/out.sections-strings.png' });

  await page.click('#alignNav button[data-dir="1"]');
  await new Promise(r => setTimeout(r, 300));
  assert.match(await page.$eval('#title', e => e.textContent), /Bass @ bar 25 \(2 of 4\)/);
  await page.click('#alignNav button[data-dir="-1"]');
  await new Promise(r => setTimeout(r, 300));
  assert.match(await page.$eval('#title', e => e.textContent), /Bass @ bar 1 \(1 of 4\)/);
  assert.equal(await page.evaluate(() => window.SV.state.align.how), 'manual');

  // The playhead while playing beats any match or manual choice, and stays after stopping.
  srv.state.play = { playing: true, step: 24 * 8, pos: 96 + 8, tempo: 120 };
  await page.waitForFunction(() => window.SV.state.align && window.SV.state.align.how === 'playhead', { timeout: 5000 });
  // pos and step are observed separately in Bitwig: readings ~0.1 beat apart must keep the clip on the beat (a clip
  // drawn 1/8 beat off engraves as tuplets) and must not re-render it.
  // (the render that moved the clip to the playhead may still be engraving chunks in the workers: let it finish first)
  await page.evaluate(() => window.SV.rendered());
  await page.evaluate(() => { window.__renders = 0; window.SV.hooks.afterRender.push(() => window.__renders++); });
  for (const jitter of [0.11, -0.09, 0.2, -0.17]) {
    srv.state.play = { playing: true, step: 24 * 8, pos: 96 + 8 + jitter, tempo: 120 };
    await new Promise(r => setTimeout(r, 150));
    assert.equal(await page.evaluate(() => window.SV.state.align.offset), 96, 'playhead placement snaps to the beat');
  }
  assert.equal(await page.evaluate(() => window.__renders), 0, 'jitter does not re-render');
  srv.state.play = { playing: false, step: -1, pos: 96 + 8, tempo: 120 };
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => window.SV.render());
  assert.match(await page.$eval('#title', e => e.textContent), /Bass @ bar 25 \(2 of 4\)/);
  await page.click('#alignNav button[data-dir="-1"]');
  await new Promise(r => setTimeout(r, 300));
  assert.match(await page.$eval('#title', e => e.textContent), /Bass @ bar 1 \(1 of 4\)/);

  // Brass + the live clip's track (Bass), in score order: brass above strings.
  await page.evaluate(() => { SV.state.range = 'clip'; }); // the selected clip's bars (as in Clip view with pins)
  v = await view('Brass');
  // Hide unused instruments (default): horns and bass trombones play nothing in these bars
  assert.deepEqual(v.parts, ['Tumpet', 'Tumpets a3', 'Tn Trombones a3', 'Tuba', 'Bass ✎']);
  await page.evaluate(() => { const b = document.getElementById('hideUnused'); b.checked = false; b.dispatchEvent(new Event('change')); });
  v = await view('Brass');
  assert.deepEqual(v.parts, ['Horns a4', 'Tumpet', 'Tumpets a3', 'Tn Trombones a3', 'Bs Trombones a2', 'Tuba', 'Bass ✎']);
  assert.deepEqual(v.groups, ['Brass', 'Strings']);
  await page.screenshot({ path: 'test/out.sections-brass.png' });

  v = await view('full');
  assert.equal(v.parts.length, 23);
  assert.equal(v.parts[0], 'Flute');
  assert.equal(v.parts[22], 'Bass ✎');
  await page.screenshot({ path: 'test/out.sections-full.png' });

  // Bitwig order puts the strings first again and brackets by Bitwig group.
  await page.click('#svOrderSeg button[data-order="bitwig"]');
  await new Promise(r => setTimeout(r, 300));
  v = await page.evaluate(() => window.SV.state.render.score.parts.map(p => p.name));
  assert.equal(v[0], 'Violin Solo');
  await page.click('#svOrderSeg button[data-order="score"]');

  // Follow section: the section follows the selected clip's track group.
  await page.click('#svSectionFollow');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(await page.$eval('#svSectionSeg button[data-section="Strings"]', b => b.classList.contains('on')), 'follow -> Strings');

  // Pinned keeps the old behaviour (pins + selected track).
  v = await view('pinned');
  assert.deepEqual(v.parts, ['Bass ✎']);
  assert.deepEqual(errors, []);
  console.log('sections e2e OK');
});
