// Browser test for the New Score wizard (web/features/wizard.js) against the mock wizard job (test/mock-wizard.mjs):
// dialog flow (template, edit rows, library palette, confirm), job progress and summary, failures, cancel, and
// "Swap library…" from the per-staff instrument picker.
//   PORT=8840 node test/wizard-e2e.mjs   -> test/out-wizard-*.png
import assert from 'assert/strict';
import { withPage } from './lib.mjs';
import { clickIn } from './selectors.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

await withPage({ port: Number(process.env.PORT || 8840), height: 1000 }, async ({ page, srv, errors }) => {
  await page.evaluate(() => { Object.keys(localStorage).filter(k => k.startsWith('scoreview.wizard.')).forEach(k => localStorage.removeItem(k)); });
  const rows = () => page.evaluate(() => SV.wizard.rows().map(r => ({ name: r.name, group: r.group, lib: r.lib && r.lib.label, art: r.art && r.art.label })));
  const act = a => page.click(`.svw-dlg [data-act="${a}"]`);
  const visible = sel => page.$eval(sel, el => !el.hidden);
  const loadTemplate = async id => { await page.select('#svwTpl', id); await act('load'); };

  // ---- open, pick a template, edit the list
  await clickIn(page, '#svwOpen');
  await page.waitForSelector('.svw-dlg');
  await loadTemplate('string-quartet');
  let r = await rows();
  assert.deepEqual(r.map(x => x.name), ['Violin 1', 'Violin 2', 'Viola', 'Cello']);
  assert.equal(r[0].lib, 'BBC Symphony Orchestra — Violins 1'); // harvested patch preset
  assert.match(await page.$eval('#svwRows tr[data-i="0"]', el => el.textContent), /✓ patch preset/);
  assert.match(await page.$eval('.svw-help', el => el.textContent), /node tools\/harvest-presets\.mjs <file>/);
  assert.equal(r[0].art, 'Articulation Map BBCSO Strings');

  // rename, group, reorder, add, remove
  const nameInput = i => `#svwRows tr[data-i="${i}"] input.nm`;
  await page.click(nameInput(0), { clickCount: 3 });
  await page.type(nameInput(0), 'Violin I');
  for (let i = 0; i < 4; i++) {
    await page.click(`#svwRows tr[data-i="${i}"] input.gr`);
    await page.type(`#svwRows tr[data-i="${i}"] input.gr`, 'Quartet');
  }
  await page.click('#svwRows tr[data-i="3"] [data-act="up"]'); // Cello above Viola
  await act('add');
  await page.type(nameInput(4), 'Synth'); // the new row's name is selected: replaced by typing
  await page.click('#svwRows tr[data-i="1"] [data-act="del"]'); // remove Violin 2
  r = await rows();
  assert.deepEqual(r.map(x => x.name), ['Violin I', 'Cello', 'Viola', 'Synth']);
  assert.ok(r.every(x => x.group === 'Quartet'));

  // library palette: filter, pick Pigments for the new row; "no instrument" for Viola
  await page.click('#svwRows tr[data-i="3"] [data-act="lib"]');
  await page.waitForSelector('.svw-pal input');
  assert.ok(await page.$$eval('.svw-pal .ven', els => els.length) > 5, 'palette grouped by vendor');
  await page.screenshot({ path: 'test/out-wizard-palette.png' });
  await page.type('.svw-pal input', 'pigments');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.svw-pal'));
  await page.click('#svwRows tr[data-i="2"] [data-act="lib"]');
  await page.waitForSelector('.svw-pal a[data-k="-1"]');
  await page.click('.svw-pal a[data-k="-1"]');
  // articulation map off for Cello
  await page.select('#svwRows tr[data-i="1"] select.art', '');
  r = await rows();
  assert.equal(r[3].lib, 'Pigments');
  assert.equal(r[2].lib, null);
  assert.equal(r[1].art, null);
  assert.match(await page.$eval('#svwCount', el => el.textContent), /4 tracks · 1 group · 3 with an instrument/);
  await page.screenshot({ path: 'test/out-wizard-edit.png' });

  // ---- confirm (nothing sent before it), then run
  await act('create');
  assert.ok(await visible('.svw-confirm'));
  assert.match(await page.$eval('.svw-confirm', el => el.textContent), /adds 4 instrument tracks in 1 group \(Quartet\) and loads 3 plug-in instances/);
  assert.equal(srv.wizard.plans.length, 0, 'nothing is sent before confirming');
  await act('back');
  assert.ok(await visible('.svw-edit'));
  await act('create');
  await act('create'); // "Yes, add 4 tracks"
  await page.waitForFunction(() => !document.querySelector('.svw-sum').hidden, { timeout: 10000 });
  const plan = srv.wizard.plans[0].trim().split('\n');
  assert.equal(plan[0], 'option\tpos=-1');
  assert.equal(plan[1].split('\t')[0], 'group');
  assert.match(plan[2], /^track\tname=Violin I\tgroup=Quartet\tcolor=#[0-9a-f]{6}\tdev=file:.*Articulation Map BBCSO Strings\.bwpreset\|Articulation Map BBCSO Strings\tdev=file:[^\t]*Violins 1\.vstpreset\|BBC Symphony Orchestra — Violins 1$/);
  assert.match(plan[3], /^track\tname=Cello\tgroup=Quartet\tcolor=#[0-9a-f]{6}\tdev=file:[^\t]*Celli\.vstpreset\|BBC Symphony Orchestra — Celli$/);
  assert.match(plan[4], /^track\tname=Viola\tgroup=Quartet\tcolor=#[0-9a-f]{6}\tdev=file:[^\t]*Strings$/); // map kept, no instrument
  assert.match(plan[5], /dev=vst3:[0-9A-F]{32}\|Pigments$/);
  const sum = await page.$eval('.svw-sum', el => el.textContent);
  assert.match(sum, /4 of 4 tracks created/);
  assert.match(sum, /Violin I in Quartet — ✓ Articulation Map BBCSO Strings, ✓ BBC Symphony Orchestra — Violins 1/);
  assert.match(sum, /choose the patch inside each plug-in/);
  await page.screenshot({ path: 'test/out-wizard-summary.png' });
  // created tracks show up in the live track list
  await page.waitForFunction(() => ['Quartet', 'Violin I', 'Synth'].every(n => SV.state.liveData.tracks.some(t => t.name === n)), { timeout: 5000 });
  // the notation instrument is remembered when the name alone would not find it
  assert.equal(await page.evaluate(() => SV.instruments.lookup('Synth', 'Quartet').id === 'synth' || !!SV.instruments.settings.overrides['Synth']), true);
  await act('cancel'); // Close
  assert.equal(await page.$('.svw-back'), null);

  // ---- Brief button before any template run: the sheet from the quartet (no brief) lists its tracks
  await clickIn(page, '#svwBriefBtn');
  await page.waitForSelector('.svw-sheet');
  assert.match(await page.$eval('.svw-sheet', el => el.textContent), /String quartet[\s\S]*Violin I/);
  await page.keyboard.press('Escape');
  assert.equal(await page.$('.svw-sheet'), null);

  // ---- template picker: categories, brief preview, load
  await clickIn(page, '#svwOpen');
  await page.waitForSelector('.svw-dlg');
  const optgroups = await page.$$eval('#svwTpl optgroup', els => els.map(e => e.label));
  assert.deepEqual(optgroups.slice(0, 2), ['Essentials', 'Retro & Chiptune']);
  assert.equal(await page.$$eval('#svwTpl option', els => els.length), 29);
  assert.equal(await page.$('#svwTpl option[value="big-band"]'), null);
  await act('browse');
  assert.ok(await visible('.svw-pick'));
  const cats = await page.$$eval('.svw-cat', els => els.map(e => e.textContent));
  assert.equal(cats[0], 'All29');
  assert.ok(cats.includes('Retro & Chiptune4') && cats.includes('Lo-fi & Chill3'), cats.join(','));
  await page.click('.svw-cat[data-cat="Retro & Chiptune"]');
  assert.equal(await page.$$eval('.svw-card', els => els.length), 4);
  await page.click('.svw-card[data-id="sac-nes"]');
  const preview = await page.$eval('#svwPreview', el => el.textContent);
  assert.match(preview, /NES 2A03 stage theme/);
  assert.match(preview, /150 BPM · 4\/4 · E minor · 28 bars/);
  assert.match(preview, /Stage A 8bar 5/);
  assert.match(preview, /Pulse 1 \(lead\)Kontakt 8 — Super Audio Cart✓ patch presetSuper Audio Cart snapshot › Authentic › NES › "Pulse 12\.5%"/);
  assert.equal(srv.wizard.plans.length, 1, 'browsing sends nothing');
  await page.screenshot({ path: 'test/out-wizard-picker.png' });
  await page.click('.svw-cat[data-cat="All"]');
  await page.click('.svw-card[data-id="sac-n64"]');
  await page.click('.svw-card[data-id="sac-nes"]');
  await act('pickLoad');
  assert.ok(await visible('.svw-edit'));
  assert.equal(await page.$eval('#svwTpl', el => el.value), 'sac-nes');
  r = await rows();
  assert.deepEqual(r.map(x => x.name), ['Pulse 1 (lead)', 'Pulse 2 (arps)', 'Triangle (bass)', 'Noise (drums)', 'DPCM (samples)']);
  assert.ok(r.every(x => x.lib === 'Kontakt 8 — Super Audio Cart'));
  assert.match(await page.$eval('#svwRows tr[data-i="2"] textarea.pt', el => el.value), /NES › "Triangle"/);
  assert.match(await page.$eval('#svwCur', el => el.textContent), /NES 2A03 stage theme 150 BPM/);
  // the patch hint is editable and kept in the draft
  await page.click('#svwRows tr[data-i="4"] textarea.pt', { clickCount: 3 });
  await page.type('#svwRows tr[data-i="4"] textarea.pt', 'Drums › Kits › "2A03 Standard"');
  await page.screenshot({ path: 'test/out-wizard-starter-edit.png' });

  // ---- confirm with starter settings, run: tempo, meter and markers reach the plan and the mock project
  await act('create');
  const conf = await page.$eval('.svw-confirm', el => el.textContent);
  assert.match(conf, /Starter settings from “NES 2A03 stage theme”/);
  assert.match(conf, /Set tempo & meter: 150 BPM, 4\/4/);
  assert.match(conf, /Add section markers: Intro \(bar 1\), Stage A \(bar 5\), Stage B \(bar 13\), Bridge \(bar 21\), Turnaround \(bar 25\)/);
  assert.equal(await page.$eval('#svwOptTempo', el => el.checked), true);
  assert.equal(await page.$eval('#svwOptMarkers', el => el.checked), true);
  await page.screenshot({ path: 'test/out-wizard-confirm-starter.png' });
  await act('create');
  await page.waitForFunction(() => !document.querySelector('.svw-sum').hidden, { timeout: 10000 });
  const plan2 = srv.wizard.plans[1].trim().split('\n');
  assert.deepEqual(plan2.slice(0, 8), ['option\tpos=-1', 'option\ttempo=150', 'option\tmeter=4/4', 'marker\tname=Intro\tbar=1',
    'marker\tname=Stage A\tbar=5', 'marker\tname=Stage B\tbar=13', 'marker\tname=Bridge\tbar=21', 'marker\tname=Turnaround\tbar=25']);
  assert.equal(srv.state.play.tempo, 150);
  assert.deepEqual(srv.state.data.markers.map(m => `${m.name}@${m.beat}`),
    ['Intro@0', 'Stage A@16', 'A@32', 'Stage B@48', 'B@64', 'Bridge@80', 'Turnaround@96']);
  const sum3 = await page.$eval('.svw-sum', el => el.textContent);
  assert.match(sum3, /5 of 5 tracks created/);
  assert.match(sum3, /✓ Tempo 150 BPM/);
  assert.match(sum3, /✓ Time signature 4\/4/);
  assert.match(sum3, /✓ Marker "Intro" at bar 1: kept the existing marker "Intro"/);
  assert.match(sum3, /✓ Marker "Stage A" at bar 5/);
  assert.match(sum3, /Triangle \(bass\) in NES APU — ✓ Kontakt 8 — Super Audio Cart→ load: Super Audio Cart snapshot › Authentic › NES › "Triangle"/);
  assert.match(sum3, /→ load: Drums › Kits › "2A03 Standard"/);
  assert.match(sum3, /Saved as the starter sheet/);
  await page.screenshot({ path: 'test/out-wizard-starter-summary.png' });
  await act('cancel');

  // ---- the Brief button shows the starter sheet while composing
  await clickIn(page, '#svwBriefBtn');
  await page.waitForSelector('.svw-sheet');
  const sheetText = await page.$eval('.svw-sheet', el => el.textContent);
  assert.match(sheetText, /NES 2A03 stage theme/);
  assert.match(sheetText, /Retro & Chiptune/);
  assert.match(sheetText, /150 BPM · 4\/4 · E minor/);
  assert.match(sheetText, /Write under the real 2A03 limits/);
  assert.match(sheetText, /Pulse 1 \(lead\)Kontakt 8 — Super Audio CartSuper Audio Cart snapshot/);
  assert.deepEqual(await page.evaluate(() => SV.wizard.sheet().tracks.map(t => t.name)).then(x => x.length), 5);
  await page.screenshot({ path: 'test/out-wizard-brief.png' });
  await page.click('.svw-sheet [data-act="x"]');
  assert.equal(await page.$('.svw-sheet'), null);

  // ---- options off: no tempo line when unchecked; markers are skipped while Bitwig plays
  srv.wizard.playing = true;
  await clickIn(page, '#svwOpen');
  await loadTemplate('lofi-study');
  await act('create');
  await page.click('#svwOptTempo'); // off
  await act('create');
  await page.waitForFunction(() => !document.querySelector('.svw-sum').hidden, { timeout: 10000 });
  const plan3 = srv.wizard.plans[2];
  assert.ok(!/option\ttempo|option\tmeter/.test(plan3), 'tempo unchecked');
  assert.match(plan3, /marker\tname=Loop A\tbar=5/);
  assert.match(await page.$eval('.svw-sum', el => el.textContent), /✗ Marker "Intro" at bar 1: skipped, stop playback in Bitwig first/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.wizard.optTempo'))), false);
  await act('cancel');
  srv.wizard.playing = false;
  await page.evaluate(() => localStorage.setItem('scoreview.wizard.optTempo', 'true'));

  // ---- failures: no Group action, a plug-in that does not load, a missing preset
  srv.wizard.groupAction = false;
  await clickIn(page, '#svwOpen');
  await loadTemplate('satb-piano');
  await page.evaluate(() => {
    const rs = SV.wizard.rows();
    rs[0].lib = { kind: 'vst3', id: 'FAIL0000', label: 'Broken Choir' };
    rs[1].art = { path: 'C:\\MISSING\\Map.bwpreset', label: 'Missing map' };
  });
  await act('create');
  await act('create');
  await page.waitForFunction(() => !document.querySelector('.svw-sum').hidden, { timeout: 10000 });
  const sum2 = await page.$eval('.svw-sum', el => el.textContent);
  assert.match(sum2, /5 of 5 tracks created, \d problems/);
  assert.match(sum2, /Soprano not in Choir: Bitwig's "Group" action was not found/);
  assert.match(sum2, /✗ Broken Choir: not confirmed by Bitwig/);
  assert.match(sum2, /✗ Missing map: file not found/);
  assert.match(sum2, /Problems/);
  await page.screenshot({ path: 'test/out-wizard-failures.png' });
  await act('cancel');
  srv.wizard.groupAction = true;

  // ---- cancel while running
  srv.wizard.stepMs = 150;
  await clickIn(page, '#svwOpen');
  await loadTemplate('film');
  await act('create');
  await act('create');
  await page.waitForFunction(() => /Step \d+ of \d+/.test(document.querySelector('#svwStep').textContent), { timeout: 5000 });
  assert.equal(await page.$eval('[data-act="cancel"]', el => el.textContent), 'Stop');
  await act('cancel'); // Stop
  await page.waitForFunction(() => !document.querySelector('.svw-sum').hidden, { timeout: 10000 });
  assert.equal(srv.wizard.state, 'cancelled');
  assert.match(await page.$eval('.svw-sum', el => el.textContent), /Cancelled: \d+ of 21 tracks created/);
  await act('cancel');
  srv.wizard.stepMs = 15;

  // ---- Swap library from the staff picker (clip mode: the live "Violin 1" staff). Creating tracks switched
  // Score View to a fresh score of the new ensemble, so go back to Clip mode first.
  await page.click('#modeSeg [data-mode=clip]');
  await page.waitForFunction(() => SV.state.mode === 'clip' && document.querySelector('#paper g.label'));
  await new Promise(r => setTimeout(r, 300));
  const box = await (await page.$('#paper g.label')).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('.svi-pop .svi-swap');
  await page.click('.svi-pop .svi-swap');
  await page.waitForSelector('.svw-pal input[name=svwMode]');
  assert.match(await page.$eval('.svw-pal h4', el => el.textContent), /Swap library — Violin 1/);
  await page.type('.svw-pal input[type=text]', 'kontakt 8 native'); // the bare plug-in, not a harvested "Kontakt 8 — …" preset
  await page.screenshot({ path: 'test/out-wizard-swap.png' });
  await page.keyboard.press('Enter');
  for (let i = 0; i < 50 && !srv.wizard.swaps.length; i++) await sleep(50);
  assert.deepEqual(srv.wizard.swaps[0], { track: 'Violin 1', index: 2, mode: 'disable',
    lib: { kind: 'vst3', id: '5653544E694B386B6F6E74616B742038', label: 'Kontakt 8' } });
  await page.waitForFunction(() => /Violin 1: Kontakt 8 loaded \(old instrument disabled\)/.test(document.querySelector('#flash').textContent), { timeout: 5000 });

  assert.deepEqual(errors, []);
});
console.log('wizard-e2e: ok');
