// Mouse editing (features/mouse.js) against the mock server: pitch drag (scale steps, Alt chromatic), collision
// safety, Shift+drag in time, length handle, marquee (+Shift), copy/paste/cut, paste at the entry caret.
// Screenshots of the previews: test/out-mouse-*.png
import assert from 'assert';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';

const PORT = Number(process.env.PORT || 8861);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: path.join(ROOT, 'test/out-mouse-' + name + '.png'), clip: { x: 0, y: 60, width: 1100, height: 360 } });
const notesOf = srv => srv.state.data.notes.map(n => n.x + '/' + n.y + '/' + n.d).join(' ');
const has = (srv, x, y) => srv.state.data.notes.some(n => n.x === x && n.y === y);

await withPage({ port: PORT, fixture: path.join(ROOT, 'test/fixtures/live-mouse.json'), width: 1200, height: 800 }, async ({ page, srv, errors }) => {
  // Notehead centre/box and staff geometry of a live note.
  const geo = id => page.evaluate(id => {
    const t = SV.state.render.bySrc.get(id)[0];
    const el = document.getElementById(t.svgId);
    const h = (el.querySelector('.notehead') || el).getBoundingClientRect();
    const lines = [...el.closest('g.staff').querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect())
      .filter(b => b.width > 20).sort((a, b) => a.top - b.top);
    return { cx: h.left + h.width / 2, cy: h.top + h.height / 2, left: h.left, right: h.right,
             gap: (lines[4].top - lines[0].top) / 4, top: lines[0].top, bottom: lines[4].top };
  }, id);
  const beatX = beat => page.evaluate(b => SV.mouse.beatPos(b, 1).x, beat);
  const waitNote = (x, y) => page.waitForFunction(id => SV.state.render && SV.state.render.bySrc.has(id), { timeout: 5000 }, `L0_${x}_${y}`);
  const ctrl = async k => { await page.keyboard.down('Control'); await page.keyboard.press(k); await page.keyboard.up('Control'); };
  const drag = async (from, to, steps = 6) => {
    await page.mouse.move(from[0], from[1]); await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps });
  };

  // ---- 1. Drag C5 up two staff steps -> E5, with a ghost preview
  let g = await geo('L0_0_72');
  await drag([g.cx, g.cy], [g.cx, g.cy - g.gap]);
  await sleep(100);
  assert.equal(await page.$$eval('#svm-layer .svm-ghost', els => els.length), 1, 'one ghost notehead while dragging');
  const tagText = await page.$eval('#svm-layer .svm-tag', el => el.textContent);
  assert.match(tagText, /^E5/, 'tag shows the target pitch: ' + tagText);
  await shot(page, 'pitch');
  await page.mouse.up();
  await waitNote(0, 76);
  assert(has(srv, 0, 76) && !has(srv, 0, 72), 'C5 moved to E5: ' + notesOf(srv));
  assert(srv.edits.includes('move 0 0 72 0 4'), 'one move op: ' + srv.edits.join(' | '));
  assert(await page.evaluate(() => SV.state.selection.has('L0_0_76')), 'moved note stays selected');

  // ---- 1b. Alt-drag one half-space: chromatic E5 -> F5; then plain drag down one step: F5 -> E5
  g = await geo('L0_0_76');
  await page.keyboard.down('Alt'); // Alt+press on a selected note (Alt elsewhere = play from bar, playback.js)
  await drag([g.cx, g.cy], [g.cx, g.cy - g.gap * 0.5]);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await waitNote(0, 77);
  g = await geo('L0_0_77');
  await drag([g.cx, g.cy], [g.cx, g.cy + g.gap * 0.5]);
  await page.mouse.up();
  await waitNote(0, 76);

  // ---- 2. Collision: A4 in the chord at beat 6 dragged up two steps would land on the chord's C5 -> blocked
  g = await geo('L0_144_69');
  await drag([g.cx, g.cy], [g.cx, g.cy - g.gap]);
  await page.mouse.up();
  await sleep(500);
  assert(has(srv, 144, 69) && has(srv, 144, 72), 'collision blocked: ' + notesOf(srv));
  assert(!srv.edits.some(e => e.startsWith('move 0 144 69')), 'no move sent onto the taken place');
  assert.match(await page.$eval('#flash', el => el.textContent), /not moved/);

  // ---- 3. Shift+drag in time: D5 at beat 1 -> beat 2.5 (snapped to the 16th grid)
  g = await geo('L0_24_74');
  await page.mouse.click(g.cx, g.cy);
  const x1 = await beatX(1), x25 = await beatX(2.5);
  await page.keyboard.down('Shift');
  await drag([g.cx, g.cy], [g.cx + (x25 - x1) + 1, g.cy + 3], 8);
  await sleep(100);
  assert.match(await page.$eval('#svm-layer .svm-tag', el => el.textContent), /bar 1, beat 3\.5/);
  await shot(page, 'time');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await waitNote(60, 74);
  assert(has(srv, 60, 74) && !has(srv, 24, 74), 'moved in time to step 60: ' + notesOf(srv));
  assert(await page.evaluate(() => SV.state.selection.size === 1 && SV.state.selection.has('L0_60_74')), 'dragged note selected');

  // ---- 4. Length handle: G4 half note (beat 4, 2 beats) -> 3 beats
  await page.keyboard.press('Escape');
  g = await geo('L0_96_67');
  const end6 = await beatX(6) - g.gap * 0.5, end7 = await beatX(7) - g.gap * 0.5;
  await page.mouse.move(g.cx, g.cy); await sleep(80);
  await page.mouse.move(end6, g.cy); await sleep(150);
  assert(await page.evaluate(() => document.body.classList.contains('svm-cur-ew')), 'resize cursor over the end handle');
  assert(await page.$('#svm-layer .svm-handle.on'), 'handle highlighted');
  await shot(page, 'hover');
  await drag([end6, g.cy], [end7 + 1, g.cy]);
  await sleep(100);
  assert.match(await page.$eval('#svm-layer .svm-tag', el => el.textContent), /^3 beats/);
  await shot(page, 'resize');
  await page.mouse.up();
  await sleep(500);
  assert.equal(srv.state.data.notes.find(n => n.x === 96 && n.y === 67).d, 3, 'G4 is 3 beats: ' + srv.edits.slice(-2));

  // ---- 5. Marquee over two notes of bar 1, then Shift+marquee adds F5; a click on empty paper clears
  await page.waitForFunction(() => SV.state.render.bySrc.has('L0_96_67'));
  const a = await geo('L0_0_76'), b = await geo('L0_48_76'), f = await geo('L0_72_77');
  const top = a.top - a.gap * 6;
  await drag([a.left - 30, top], [b.right + 4, a.bottom + a.gap * 4]);
  await sleep(100);
  await shot(page, 'marquee');
  await page.mouse.up();
  let sel = await page.evaluate(() => [...SV.state.selection].sort());
  assert.deepEqual(sel, ['L0_0_76', 'L0_48_76'], 'marquee selects the two notes: ' + sel);
  await page.keyboard.down('Shift');
  await drag([f.left - 6, top], [f.right + 6, f.bottom + f.gap * 4]);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  sel = await page.evaluate(() => [...SV.state.selection].sort());
  assert.deepEqual(sel, ['L0_0_76', 'L0_48_76', 'L0_72_77'], 'Shift+marquee adds: ' + sel);
  await page.mouse.click(a.left - 30, top);
  assert.equal(await page.evaluate(() => SV.state.selection.size), 0, 'click on empty paper clears');

  // ---- 6. Copy + paste right after the selection (end = beat 3): E5 at steps 72 and 120
  await page.evaluate(() => { SV.state.selection = new Set(['L0_0_76', 'L0_48_76']); SV.paintSelection(); });
  await page.focus('#main');
  await ctrl('c');
  await ctrl('v');
  await waitNote(120, 76);
  assert(has(srv, 72, 76) && has(srv, 120, 76) && has(srv, 72, 77) && has(srv, 0, 76), 'pasted: ' + notesOf(srv));
  await page.waitForFunction(() => SV.state.render.bySrc.has('L0_72_76'));
  sel = await page.evaluate(() => [...SV.state.selection].sort());
  assert.deepEqual(sel, ['L0_120_76', 'L0_72_76'], 'pasted notes selected: ' + sel);
  await shot(page, 'paste');

  // ---- 7. Cut, then paste at the entry caret (the second note would be past the clip end)
  await ctrl('x');
  await sleep(500);
  assert(!has(srv, 72, 76) && !has(srv, 120, 76), 'cut removed them: ' + notesOf(srv));
  await page.evaluate(() => { SV.entry.toggle(true); SV.entry.setCaret(168); });
  await ctrl('v');
  await sleep(600);
  assert(has(srv, 168, 76), 'pasted at the caret: ' + notesOf(srv));
  assert(!has(srv, 216, 76), 'note past the clip end left out');
  await page.evaluate(() => SV.entry.toggle(false));

  // ---- 8. Clicking a selected note of a multi-selection without dragging selects just that note
  await page.evaluate(() => { SV.state.selection = new Set(['L0_0_76', 'L0_48_76']); SV.paintSelection(); });
  g = await geo('L0_48_76');
  await page.mouse.click(g.cx, g.cy);
  assert.deepEqual(await page.evaluate(() => [...SV.state.selection]), ['L0_48_76']);

  assert.deepEqual(errors, []);
  console.log('mouse e2e OK; edits:', srv.edits.filter(e => !/^(select|audition)/.test(e)).join(' | '));
});
