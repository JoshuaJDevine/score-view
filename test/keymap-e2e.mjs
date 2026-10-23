// Arrow-key layouts (core/keyboard.js, View ▾ > Keys): Score View (default), Sibelius, Dorico, Classic.
//   PORT=8871 node test/keymap-e2e.mjs
import assert from 'assert';
import { withPage } from './lib.mjs';

const port = Number(process.env.PORT || 8871);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await withPage({ port }, async ({ page, srv, errors }) => {
  await page.waitForFunction(() => window.SV && SV.keymap && SV.state.render && SV.state.render.timeline.length, { timeout: 30000 });
  assert.equal(await page.evaluate(() => SV.keymap.get()), 'scoreview', 'Score View keys by default');

  // live note ids in reading order (time, then low to high), skipping keyswitches
  const order = () => page.evaluate(() => [...SV.state.render.bySrc.values()].map(a => a[0]).filter(t => SV.isLive(t.srcId))
    .sort((a, b) => a.start - b.start || SV.parseId(a.srcId).y - SV.parseId(b.srcId).y).map(t => t.srcId));
  const sel = () => page.evaluate(() => [...SV.state.selection]);
  const selectOnly = id => page.evaluate(i => { SV.state.selection = new Set([i]); SV.paintSelection(); document.getElementById('main').focus(); }, id);
  const key = async (k, mods = []) => {
    for (const m of mods) await page.keyboard.down(m);
    await page.keyboard.press(k);
    for (const m of mods.slice().reverse()) await page.keyboard.up(m);
    await sleep(150);
  };
  const lastEdit = re => srv.edits.filter(e => re.test(e)).pop();

  // ---- Score View: ← → previous / next note, Shift extends, Ctrl next bar
  const ids = await order();
  await selectOnly(ids[5]);
  await key('ArrowRight');
  assert.deepEqual(await sel(), [ids[6]], '→ selects the next note');
  await key('ArrowLeft'); await key('ArrowLeft');
  assert.deepEqual(await sel(), [ids[4]], '← ← two notes back');
  await key('ArrowRight', ['Shift']); await key('ArrowRight', ['Shift']);
  assert.deepEqual((await sel()).sort(), [ids[4], ids[5], ids[6]].sort(), 'Shift+→ extends the selection');
  const barOf = id => page.evaluate(i => SV.ScoreBuilder.measureAt(SV.state.render, SV.state.render.bySrc.get(i)[0].start), id);
  await selectOnly(ids[0]);
  await key('ArrowRight', ['Control']);
  const [afterBar] = await sel();
  assert.ok(await barOf(afterBar) > await barOf(ids[0]), 'Ctrl+→ goes to a later bar');
  const all = await order(), bars = await Promise.all(all.map(barOf));
  assert.equal(afterBar, all[bars.indexOf(await barOf(afterBar))], 'Ctrl+→ selects the first note of that bar');
  console.log('ok   ← → note, Shift+→ extend, Ctrl+→ bar');

  // ---- Score View: Alt+→ moves in time, Shift+Alt+→ lengthens; ↑ scale step, Alt+↑ semitone, Ctrl+↑ octave
  const pick = (await order()).find(id => { const y = Number(id.split('_')[2]); return y > 40 && y < 100; });
  await selectOnly(pick);
  const [ch, x, y] = pick.slice(1).split('_').map(Number);
  srv.edits.length = 0;
  await key('ArrowRight', ['Alt']);
  assert.match(lastEdit(/^move /) || '', new RegExp(`^move ${ch} ${x} ${y} \\d+ 0$`), 'Alt+→ moves the note later: ' + srv.edits.join(' | '));
  await sleep(300);
  const moved = (await sel())[0];
  srv.edits.length = 0;
  await key('ArrowRight', ['Shift', 'Alt']);
  assert.ok(lastEdit(/^dur /), 'Shift+Alt+→ makes it longer: ' + srv.edits.join(' | '));
  await sleep(300);
  await selectOnly(moved);
  const dy = async mods => { srv.edits.length = 0; await key('ArrowUp', mods); const m = lastEdit(/^move /); await sleep(300); return m ? Number(m.split(' ')[5]) : null; };
  assert.ok([1, 2].includes(await dy([])), '↑ = a scale step');
  assert.equal(await dy(['Alt']), 1, 'Alt+↑ = a semitone');
  assert.equal(await dy(['Control']), 12, 'Ctrl+↑ = an octave');
  console.log('ok   Alt+→ move, Shift+Alt+→ length, ↑ step, Alt+↑ semitone, Ctrl+↑ octave');

  // ---- every layout registers its keys without clashes; the footer follows the layout
  for (const id of ['scoreview', 'sibelius', 'dorico', 'classic']) {
    const r = await page.evaluate(i => { SV.keymap.set(i); return { clashes: SV.shortcuts.conflicts(), help: document.getElementById('helpKeys').textContent }; }, id);
    assert.deepEqual(r.clashes, [], id + ': no key clashes');
    assert.ok(r.help.length > 10, id + ' footer: ' + r.help);
  }
  // Sibelius: ↑ semitone, Alt+↑ scale step
  await page.evaluate(() => SV.keymap.set('sibelius'));
  await selectOnly((await sel())[0] || (await order())[3]);
  assert.equal(await dy([]), 1, 'Sibelius: ↑ = a semitone');
  // Classic: → moves the note (the old behaviour)
  await page.evaluate(() => SV.keymap.set('classic'));
  srv.edits.length = 0;
  await key('ArrowRight');
  assert.ok(lastEdit(/^move /), 'Classic: → moves the note');
  // the choice is saved
  await page.evaluate(() => SV.keymap.set('dorico'));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.keys'))), 'dorico');
  console.log('ok   layouts: no clashes, Sibelius ↑ semitone, Classic → moves, choice saved');
  assert.deepEqual(errors, []);
});
console.log('keymap-e2e OK');
