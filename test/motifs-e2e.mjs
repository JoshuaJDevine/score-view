// End-to-end test of the Motif menu/shortcuts against the mock server (the mock applies the edits,
// so srv.state.data.notes is the resulting "clip").   PORT=8862 node test/motifs-e2e.mjs
import assert from 'assert';
import { withPage } from './lib.mjs';

const PORT = Number(process.env.PORT || 8862);
const n = (x, y, d = 0.5, vel = 100) => ({ ch: 0, x, y, d, vel, sel: false });
const FIG = [n(0, 72), n(12, 74), n(24, 76), n(36, 79)]; // C D E G eighths in C major
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shots = [];

await withPage({ port: PORT, width: 1300, height: 700 }, async ({ page, srv, errors }) => {
  const clip = () => srv.state.data.notes.map(q => [q.x, q.y, q.d]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const synced = () => page.waitForFunction(v => SV.state.liveData && SV.state.liveData.v >= v && SV.state.render, { timeout: 5000 }, srv.state.v);
  async function reset(notes) {
    srv.setNotes(notes.map(q => ({ ...q })));
    await synced(); await sleep(150);
  }
  async function select(xys) {
    await page.evaluate(ids => { SV.state.selection = new Set(ids); SV.paintSelection(); document.getElementById('main').focus(); },
      xys.map(([x, y]) => `L0_${x}_${y}`));
  }
  async function press(code, shift = false) {
    const before = srv.edits.length;
    await page.keyboard.down('Alt');
    if (shift) await page.keyboard.down('Shift');
    await page.keyboard.press(code);
    if (shift) await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    for (let i = 0; i < 50 && srv.edits.length === before; i++) await sleep(20);
    await synced(); await sleep(150);
  }
  const selection = () => page.evaluate(() => [...SV.state.selection].sort());
  const flashText = () => page.$eval('#flash', el => el.textContent);
  async function shot(name) { const p = `test/out-motifs-${name}.png`; await page.screenshot({ path: p }); shots.push(p); }

  // Fixed key: C major.
  await page.select('#keySel', '0');
  await reset(FIG);

  // 1. Sequence up twice (chains from the newest copy), then down a step.
  await select(FIG.map(q => [q.x, q.y]));
  await press('KeyS');
  assert.match(await flashText(), /Sequence up a step — 4 notes/);
  await press('KeyS');
  await press('KeyS', true);
  assert.deepEqual(clip(), [
    [0, 72, .5], [12, 74, .5], [24, 76, .5], [36, 79, .5],
    [48, 74, .5], [60, 76, .5], [72, 77, .5], [84, 81, .5],
    [96, 76, .5], [108, 77, .5], [120, 79, .5], [132, 83, .5],
    [144, 74, .5], [156, 76, .5], [168, 77, .5], [180, 81, .5]]);
  assert.deepEqual(await selection(), ['L0_144_74', 'L0_156_76', 'L0_168_77', 'L0_180_81'].sort());
  const seqEdits = srv.edits.filter(e => e.startsWith('add'));
  assert.equal(seqEdits.length, 12);
  await shot('sequence');

  // 2. Collision: an existing note where the copy lands is left alone (not overwritten).
  await reset([...FIG, n(60, 76, 2, 50)]);
  await select(FIG.map(q => [q.x, q.y]));
  srv.edits.length = 0;
  await press('KeyS');
  assert(!srv.edits.some(e => e.startsWith('add 0 60 76')), srv.edits.join('|'));
  assert.deepEqual(srv.state.data.notes.find(q => q.x === 60 && q.y === 76).d, 2);
  assert.match(await flashText(), /1 skipped/);

  // 3. Diatonic inversion around the first note: C D E G -> C B A F.
  await reset(FIG);
  await select(FIG.map(q => [q.x, q.y]));
  await press('KeyI');
  assert.deepEqual(clip(), [[0, 72, .5], [12, 71, .5], [24, 69, .5], [36, 65, .5]]);
  assert.deepEqual(await selection(), ['L0_0_72', 'L0_12_71', 'L0_24_69', 'L0_36_65'].sort());
  await shot('invert');

  // 4. Retrograde keeps the reversed rhythm: C(1) D(.5) E(.5) -> E(.5) D(.5) C(1).
  await reset([n(0, 72, 1), n(24, 74), n(36, 76)]);
  await select([[0, 72], [24, 74], [36, 76]]);
  await press('KeyR');
  assert.deepEqual(clip(), [[0, 76, .5], [12, 74, .5], [24, 72, 1]]);
  // Retrograde of a palindrome-ish figure with a cycle (C D C, unequal lengths).
  await reset([n(0, 72), n(12, 74, .25), n(24, 72)]);
  await select([[0, 72], [12, 74], [24, 72]]);
  await press('KeyR');
  assert.deepEqual(clip(), [[0, 72, .5], [18, 74, .25], [24, 72, .5]]);

  // 5. Augment, then diminish the result (chained through the selection) back to the original.
  await reset(FIG.map(q => ({ ...q, x: q.x + 24 })));
  await select(FIG.map(q => [q.x + 24, q.y]));
  await press('KeyA');
  assert.deepEqual(clip(), [[24, 72, 1], [48, 74, 1], [72, 76, 1], [96, 79, 1]]);
  await shot('augment');
  await press('KeyD');
  assert.deepEqual(clip(), [[24, 72, .5], [36, 74, .5], [48, 76, .5], [60, 79, .5]]);

  // 6. Orchestration helpers.
  await reset(FIG);
  await select(FIG.map(q => [q.x, q.y]));
  await press('KeyO');
  assert.deepEqual(await selection(), ['L0_0_84', 'L0_12_86', 'L0_24_88', 'L0_36_91'].sort());
  await select(FIG.map(q => [q.x, q.y]));
  await press('KeyO', true);
  await select(FIG.map(q => [q.x, q.y]));
  await press('Digit3', true);              // Alt+Shift+3: third below (Alt+3 is a third above)
  assert.deepEqual(clip().map(q => q[1]), [60, 69, 72, 84, 62, 71, 74, 86, 64, 72, 76, 88, 67, 76, 79, 91]);
  await shot('double-third');
  await reset(FIG);
  await select(FIG.map(q => [q.x, q.y]));
  await press('Digit6', true);
  assert.deepEqual(clip(), [[0, 64, .5], [0, 72, .5], [12, 65, .5], [12, 74, .5], [24, 67, .5], [24, 76, .5], [36, 71, .5], [36, 79, .5]]);

  // 7. Menu: chromatic inversion.
  await reset(FIG);
  await select(FIG.map(q => [q.x, q.y]));
  await page.click('#mtfBtn');
  await shot('menu');
  await page.click('#mtfPanel [data-act="invertChrom"]');
  await synced(); await sleep(200);
  assert.deepEqual(clip().map(q => q[1]), [72, 70, 68, 65]);

  // 8. Motif library: save with Alt+M + inline name field, insert after a selected note.
  await reset(FIG);
  await select(FIG.map(q => [q.x, q.y]));
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyM'); await page.keyboard.up('Alt');
  await page.waitForSelector('#mtfName', { visible: true });
  await page.$eval('#mtfName', el => { el.value = ''; });
  await page.type('#mtfName', 'Fate');
  await shot('save');
  await page.keyboard.press('Enter');
  const lib = await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.motifs.library')));
  assert.equal(lib.length, 1);
  assert.equal(lib[0].name, 'Fate');
  assert.deepEqual(lib[0].notes.map(q => [q.on, q.dur, q.steps, q.semis]), [[0, .5, 0, 0], [.5, .5, 1, 2], [1, .5, 2, 4], [1.5, .5, 4, 7]]);
  assert(await page.$eval('#mtfSave', el => el.classList.contains('hidden')));
  // Select just G (beat 1.5) and insert: starts on the next beat (2), diatonically from G: G A B D.
  await select([[36, 79]]);
  await page.click('#mtfBtn');
  await page.click('#mtfPanel [data-ins="Fate"]');
  await synced(); await sleep(200);
  assert.deepEqual(clip().slice(4), [[48, 79, .5], [60, 81, .5], [72, 83, .5], [84, 86, .5]]);
  await shot('insert');

  // 9. Fit to harmony (with a stand-in harmony module): generated pitches are snapped.
  await page.evaluate(() => { SV.harmony = { snap: (p, beat, mode) => (mode === 'chord' && p === 77 ? 76 : p) }; });
  await page.click('#mtfBtn');
  await page.select('#mtfHarm', 'chord');
  await page.click('#mtfBtn');
  await reset(FIG);
  await select(FIG.map(q => [q.x, q.y]));
  await press('KeyS');
  assert.deepEqual(clip().slice(4).map(q => q[1]), [74, 76, 76, 81]);
  assert.match(await flashText(), /fit to chord/);

  assert.deepEqual(errors, []);
  console.log('motifs e2e OK; screenshots:', shots.join(', '));
});
