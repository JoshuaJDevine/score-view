// End-to-end test of web/features/articulations.js in the page against the mock server (live Violin 1 clip with
// BBC SO keyswitches): engraving, the palette and Shift shortcuts writing keyswitch notes back, Hide keyswitches,
// and score mode with the full export (plugin tables, dynamics).  PORT=8921 node test/articulations-e2e.mjs
import assert from 'assert';
import { withPage } from './lib.mjs';
import { clickIn } from './selectors.mjs';
import { fullExportPath } from './articulations-fixture.mjs';

const port = Number(process.env.PORT || 8921);
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));
const count = (page, sel) => page.$$eval(sel, els => els.length);
const dirTexts = page => page.$$eval('#paper g.dir', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));

await withPage({ port, width: 1600, height: 1000 }, async ({ page, srv, errors }) => {
  await page.waitForFunction(() => window.SV && window.SV.articulations && document.querySelector('#paper g.artic'), { timeout: 30000 });
  const artics = await count(page, '#paper g.artic');
  const slurs = await count(page, '#paper g.slur');
  const dirs = await dirTexts(page);
  console.log('engraved:', artics, 'articulations,', slurs, 'slurs, text', dirs);
  assert(artics >= 30, 'spiccato dots');
  assert.equal(slurs, 0, 'no automatic slurs by default');
  // Articulations ▾ > Slur legato passages
  await page.click('#svaBtn');
  await page.waitForSelector('#svaMenu input[data-set=slurLegato]');
  await page.click('#svaMenu input[data-set=slurLegato]');
  await page.click('#svaBtn');
  await page.waitForFunction(() => document.querySelectorAll('#paper g.slur').length >= 2, { timeout: 5000 });
  await page.click('#svaBtn');
  await page.click('#svaMenu input[data-set=slurLegato]');
  await page.click('#svaBtn');
  await page.waitForFunction(() => !document.querySelector('#paper g.slur'), { timeout: 5000 });
  assert(dirs.includes('spicc.') && dirs.includes('pizz.'), 'technique text');
  assert(await count(page, '#paper g.dynam') >= 1, 'velocity dynamics in clip mode');
  await page.screenshot({ path: 'test/out-artic-e2e-clip.png' });

  // Hide keyswitches off: the keyswitch notes are engraved too, the articulations stay.
  const notesHidden = await count(page, '#paper g.note');
  await clickIn(page, '#hideKs');
  await page.waitForFunction(n => document.querySelectorAll('#paper g.note').length > n, {}, notesHidden);
  assert(await count(page, '#paper g.artic') >= artics - 2, 'articulations kept with keyswitches shown');
  await clickIn(page, '#hideKs');
  await page.waitForFunction(n => document.querySelectorAll('#paper g.note').length === n, {}, notesHidden);

  // These steps exercise the "Apply to the selected notes only" option (the default latches from the note on,
  // covered by the unit tests): switch it on in the Articulations menu.
  await page.click('#svaBtn');
  await page.waitForSelector('#svaMenu input[data-set=onlySelected]');
  await page.click('#svaMenu input[data-set=onlySelected]');
  await page.click('#svaBtn');

  // Palette: click a spiccato note at beat 32.5, Shift+K, choose Pizzicato.
  const clickNote = async id => {
    const box = await (await page.$('#' + id)).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  await clickNote('nL0_780_64');
  await new Promise(r => setTimeout(r, 300));
  assert(!(await page.$('#svaPalette')), 'a click selects without opening the palette');
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyK'); await page.keyboard.up('Shift');
  await page.waitForSelector('#svaPalette button', { timeout: 5000 });
  const buttons = await page.$$eval('#svaPalette button', els => els.map(b => b.textContent + (b.classList.contains('on') ? '*' : '')));
  console.log('palette:', buttons.join(' | '));
  assert(buttons.includes('Spiccato*'), 'current articulation highlighted');
  await page.screenshot({ path: 'test/out-artic-e2e-palette.png' });
  const before = srv.edits.length;
  await page.$$eval('#svaPalette button', els => els.find(b => b.textContent === 'Pizzicato')
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
  await settle();
  const ops1 = srv.edits.slice(before);
  console.log('palette ops:', ops1);
  assert.deepEqual(ops1, ['del 0 762 4', 'add 0 762 6 100 0.25', 'add 0 789 4 100 0.25']);
  await page.waitForFunction(() => [...document.querySelectorAll('#paper g.dir')].some(e => /arco/.test(e.textContent)), { timeout: 5000 });
  assert.equal((await dirTexts(page)).filter(t => t === 'pizz.').length, 2, 'second pizz. passage');

  // Shift+U on the next chord: legato keyswitch in, spiccato restored after it.
  await clickNote('nL0_804_64');
  const before2 = srv.edits.length;
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyU'); await page.keyboard.up('Shift');
  await settle();
  const ops2 = srv.edits.slice(before2).filter(o => !/^(select|audition)/.test(o));
  console.log('Shift+U ops:', ops2);
  assert.deepEqual(ops2, ['add 0 801 0 100 0.25', 'add 0 813 4 100 0.25']);
  assert.ok(!srv.edits.slice(before2).includes('loopOff'), 'no clash with the loop shortcut');

  // Shift+S on a pizz. note: back to staccato (cycle starts at Short Staccato), redundant switches removed.
  await clickNote('nL0_780_64');
  const before3 = srv.edits.length;
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyS'); await page.keyboard.up('Shift');
  await settle();
  const ops3 = srv.edits.slice(before3).filter(o => !/^(select|audition)/.test(o));
  console.log('Shift+S ops:', ops3);
  assert.deepEqual(ops3, ['del 0 762 6', 'add 0 762 5 100 0.25']);

  // Menu: per-track table source and the editor.
  await page.click('#svaBtn');
  await page.waitForSelector('#svaMenu .sva-row');
  const rows = await page.$$eval('#svaMenu .sva-row', els => els.map(e => e.textContent));
  console.log('menu rows:', rows);
  assert(rows.some(r => /Violin 1.*Strings \(BBC SO Core\)/.test(r)));
  await page.click('#svaMenu .sva-row');
  await page.waitForSelector('#svaMenu .sva-edit input[data-n]');
  assert.equal(await count(page, '#svaMenu .sva-edit input[data-n]'), 21, '20 rows + an empty one');
  await page.screenshot({ path: 'test/out-artic-e2e-menu.png' });
  await page.keyboard.press('Escape');

  // Score mode with the full export: plugin tables and automation dynamics.
  await page.evaluate(() => { document.querySelector('#modeSeg button[data-mode="score"]').click(); });
  await (await page.$('#fileInput')).uploadFile(fullExportPath());
  await page.waitForFunction(() => window.SV.state.base && window.SV.state.base.parts.some(p => p.articulations), { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#paper g.dynam'), { timeout: 10000 });
  const src = await page.evaluate(() => window.SV.articulations.mapFor('Violin 1').source);
  assert.equal(src, 'BBC Symphony Orchestra: Core - Violins 1');
  const dyn = await page.$$eval('#paper g.dynam', els => els.map(e => e.textContent.trim()));
  console.log('score mode dynamics:', dyn, 'hairpins', await count(page, '#paper g.hairpin'));
  await page.screenshot({ path: 'test/out-artic-e2e-score.png' });

  // An articulation-map Note FX on the selected track: warning bar, one click switches it off (deviceOn).
  srv.setData({ devices: { track: 'Violin 1', list: [{ index: 0, name: 'BBCSO String Articulations', on: true }, { index: 1, name: 'BBC Symphony Orchestra', on: true }] } });
  await page.waitForSelector('#svaMapWarn:not(.hidden)', { timeout: 5000 });
  assert.match(await page.$eval('#svaMapWarn', el => el.textContent), /BBCSO String Articulations.*Violin 1.*one note/s);
  await page.screenshot({ path: 'test/out-artic-e2e-mapwarn.png' });
  await page.click('#svaMapOff');
  await page.waitForSelector('#svaMapWarn.hidden', { timeout: 5000 });
  assert.ok(srv.edits.includes('deviceOn 0 0'), 'the map is switched off: ' + srv.edits.slice(-3).join(' | '));
  console.log('ok   articulation map warning; Turn the map off sends deviceOn 0 0');
  assert.deepEqual(errors, []);
});
console.log('articulations e2e OK');
