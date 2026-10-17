// Render dynamics in the page against the mock (features/dynamics.js, test/mock-curve.mjs): H / Shift+H hairpins over
// the selected notes, Ctrl+E typing "p<f" (marks + hairpin + velocities), the marks stored through /api/marks and
// engraved after a reload, H without a selection staying harmony colours, a hairpin's own shape from its popover, the
// Dynamics ▾ panel (library detected from the track's devices), Render on Pocket Strings (Timbre + Expression curves
// written in the range, status "Rendered"), Stop, a missing control, refusal while playing; screenshots
// test/out-dynamics-*.png (or SHOTS=<dir>).
//   PORT=8874 node test/dynamics-e2e.mjs
import assert from 'assert';
import path from 'path';
import { withPage } from './lib.mjs';
import { MENUS } from './selectors.mjs';

const port = Number(process.env.PORT || 8874);
const shots = process.env.SHOTS || 'test';
const shot = name => path.join(shots, (process.env.SHOTS ? 'dyn-' : 'out-dynamics-') + name + '.png');
const wait = ms => new Promise(r => setTimeout(r, ms));
const ok = msg => console.log('ok   ' + msg);

await withPage({ port }, async ({ page, srv, errors }) => {
  srv.curve.devices = { 'Violin 1': ['Pocket Strings'] };
  srv.curve.speed = 40;
  await page.waitForFunction(() => window.SV && SV.dynamics && SV.dynamics.liveOrigin(), { timeout: 10000 });

  const select = n => page.evaluate(n => {
    const d = SV.state.liveData;
    const notes = d.notes.filter(x => x.y >= 24).sort((a, b) => a.x - b.x || a.y - b.y).slice(0, n);
    SV.state.selection = new Set(notes.map(SV.liveId));
    SV.paintSelection();
    document.getElementById('main').focus();
    return notes.map(x => x.x / d.stepsPerBeat);
  }, n);
  const doc = () => page.evaluate(() => SV.dynamics.doc());
  const stored = () => JSON.parse(srv.curve.marks || '{}');

  // ---- H: crescendo over the selection, stored in the project, engraved with our id
  const beats = await select(8);
  await page.keyboard.press('h');
  await page.waitForFunction(() => document.querySelector('#paper g.hairpin[id^="dh_"]'), { timeout: 5000 });
  let d = await doc();
  const v1 = d.tracks['Violin 1'];
  assert.equal(v1.hairpins.length, 1);
  assert.equal(v1.hairpins[0].form, 'cres');
  assert.equal(v1.hairpins[0].start, beats[0]);
  await wait(400);
  assert.equal(stored().tracks['Violin 1'].hairpins.length, 1, 'saved through POST /api/marks');
  ok('H: crescendo over the selected notes, saved in the project, engraved');

  // ---- Shift+H over a later selection
  await page.evaluate(() => {
    const d = SV.state.liveData;
    const notes = d.notes.filter(x => x.y >= 24).sort((a, b) => a.x - b.x).slice(12, 20);
    SV.state.selection = new Set(notes.map(SV.liveId)); SV.paintSelection();
  });
  await page.keyboard.down('Shift'); await page.keyboard.press('h'); await page.keyboard.up('Shift');
  await page.waitForFunction(() => SV.dynamics.doc().tracks['Violin 1'].hairpins.some(h => h.form === 'dim'), { timeout: 5000 });
  ok('Shift+H: diminuendo');

  // ---- H without a selection: harmony colours, no hairpin
  await page.evaluate(() => { SV.state.selection = new Set(); SV.paintSelection(); });
  const nBefore = (await doc()).tracks['Violin 1'].hairpins.length;
  await page.keyboard.press('h');
  await wait(200);
  assert.equal((await doc()).tracks['Violin 1'].hairpins.length, nBefore);
  assert.match(await page.$eval('#flash', el => el.textContent), /Harmony/i);
  await page.keyboard.press('h'); // harmony back off
  ok('H without a selection stays harmony colours');

  // ---- Ctrl+E: type p<f over the first selection (replaces the crescendo there, sets velocities)
  await select(8);
  const edits0 = srv.edits.length;
  await page.keyboard.down('Control'); await page.keyboard.press('e'); await page.keyboard.up('Control');
  await page.waitForSelector('#svdPop', { timeout: 3000 });
  await page.type('#svdPopType', 'p<f');
  await page.screenshot({ path: shot('popover') });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#svdPop'), { timeout: 3000 });
  d = await doc();
  const t = d.tracks['Violin 1'];
  assert.deepEqual(t.marks.map(m => m.text), ['p', 'f']);
  assert.equal(t.marks[0].beat, beats[0]);
  assert.ok(Number.isInteger(t.marks[1].beat * 4) && t.marks[1].beat > beats[7], 'the f sits on a rhythmic position after the selection: ' + t.marks[1].beat);
  assert.equal(t.hairpins.filter(h => h.form === 'cres').length, 1, 'p<f replaced the earlier crescendo');
  await page.waitForFunction(() => document.querySelectorAll('#paper g.dynam[id^="dm_"]').length === 2, { timeout: 5000 });
  await wait(300);
  const vels = srv.edits.slice(edits0).filter(e => e.startsWith('vel '));
  assert.ok(vels.length > 0, 'the marks scaled the velocities of the notes they govern');
  ok(`Ctrl+E "p<f": p, crescendo, f engraved; ${vels.length} velocities set`);

  // ---- a hairpin's own shape from its popover
  const hp = await page.$('#paper g.hairpin[id^="dh_"]');
  const hb = await hp.boundingBox();
  await page.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.waitForSelector('#svdItemPop', { timeout: 3000 });
  await page.select('#svdItemShape', 'late');
  await page.screenshot({ path: shot('hairpin') });
  await page.click('#svdItemOk');
  d = await doc();
  assert.equal(d.tracks['Violin 1'].hairpins.filter(h => h.shape === 'late').length, 1);
  ok('hairpin popover: own shape (Late swell)');

  // ---- reload: the marks come back from the project
  await wait(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.dynamics && SV.dynamics.doc().tracks['Violin 1'], { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#paper g.dynam[id^="dm_"]').length === 2, { timeout: 10000 });
  ok('marks reload from /api/marks and are engraved again');
  await page.screenshot({ path: shot('score') });

  // ---- Dynamics ▾: library detected, Render on Pocket Strings
  await page.click(MENUS.dynamics.button);
  await page.waitForSelector(MENUS.dynamics.panel + ':not(.hidden)');
  await page.waitForFunction(() => /Pocket Strings/.test(document.querySelector('#svdPanel select[data-profile]').textContent), { timeout: 5000 });
  assert.equal(await page.$eval('#svdFrom', el => el.value), '1');
  assert.ok(+await page.$eval('#svdTo', el => el.value) >= 24, 'default range: the live clip\'s bars');
  await page.$eval('#svdTo', el => { el.value = '4'; });
  await page.screenshot({ path: shot('panel') });
  await page.click('#svdRender');
  await page.waitForFunction(() => /Rendered/.test(document.getElementById('svdStatus').textContent), { timeout: 15000 });
  assert.match(await page.$eval('#svdStatus', el => el.textContent), /Rendered bars 1–4 .*Ctrl\+Z/, 'status in bars');
  const run = srv.curve.runs[0];
  assert.equal(run.mode, 'render');
  assert.deepEqual([run.from, run.to], [0, 16]);
  assert.deepEqual(run.curves.map(c => c.target).sort(), ['expression', 'timbre']);
  run.curves.forEach(c => {
    assert.equal(c.track, 'Violin 1');
    assert.equal(c.profile, 'pocket-strings');
    assert.ok(c.points.length <= 40, 'sensible point density: ' + c.points.length);
  });
  const timbre = run.curves.find(c => c.target === 'timbre').points;
  const at = b => timbre.reduce((v, p) => (p.beat <= b ? p.v : v), timbre[0].v);
  assert.ok(at(beats[0] + 0.1) < at(16), 'Timbre rises from p towards f');
  assert.ok(srv.curve.written.length > 10 && srv.curve.written.every(w => w.beat >= 0 && w.beat <= 16));
  assert.ok(srv.edits.some(e => /^curveSet c1 Violin%201 pocket-strings /.test(e)) && srv.edits.includes('curveRender 0 16'));
  await page.screenshot({ path: shot('rendered') });
  ok(`Render bars 1–4: Timbre + Expression (${timbre.length} points), ${srv.curve.written.length} values written`);

  // ---- Stop
  srv.curve.speed = 0.5;
  await page.click('#svdPreview');
  await page.waitForFunction(() => !document.getElementById('svdStop').disabled, { timeout: 5000 });
  await wait(400);
  await page.click('#svdStop');
  await page.waitForFunction(() => /Stopped/.test(document.getElementById('svdStatus').textContent), { timeout: 5000 });
  assert.equal(srv.curve.state, 'stopped');
  assert.equal(srv.curve.runs[1].mode, 'preview');
  ok('Preview, then Stop');

  // ---- a missing control is reported
  srv.curve.speed = 40;
  srv.curve.missing = ['Violin 1'];
  await page.click('#svdRender');
  await page.waitForFunction(() => /Not found/.test(document.getElementById('svdStatus').textContent), { timeout: 5000 });
  assert.ok(await page.$eval('#svdStatus', el => el.classList.contains('bad')));
  srv.curve.missing = [];
  ok('missing library control: clear error');

  // ---- velocity-only profile: nothing to render
  await page.select('#svdPanel select[data-profile="Violin 1"]', 'velocity');
  await page.click('#svdRender');
  await page.waitForFunction(() => /velocity only/.test(document.getElementById('svdStatus').textContent), { timeout: 3000 });
  await page.select('#svdPanel select[data-profile="Violin 1"]', '');
  ok('velocity-only profile refuses Render with a hint');

  // ---- refused while playing
  srv.setPlay({ playing: true });
  await page.waitForFunction(() => SV.state.playing, { timeout: 5000 });
  const runs = srv.curve.runs.length;
  await page.click('#svdRender');
  await wait(300);
  assert.match(await page.$eval('#svdStatus', el => el.textContent), /Stop playback first/);
  assert.equal(srv.curve.runs.length, runs);
  srv.setPlay({ playing: false });
  ok('Render refused while playing');

  assert.deepEqual(errors, []);
});
console.log('dynamics-e2e OK');
