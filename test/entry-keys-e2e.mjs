// End-to-end test of note entry's keys and preferences (web/features/entry.js) against the mock server: the keypad
// layouts (Sibelius default, Dorico, MuseScore) through the ⚙ preferences, Alt+digit intervals (in entry and, through
// features/motifs.js, on a selection), Ctrl+↑/↓ octave, Ctrl+←/→ by bar, legato overlap and short lengths (track name and
// keyswitch articulation), the out-of-range warning, and the shortcut registry / help. Screenshots: test/out-entry-keys-*.png.
import assert from 'assert';
import { withPage } from './lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 8846);
const SHOTS = process.env.SHOTS_DIR || 'test';

await withPage({ port: PORT }, async ({ page, srv, errors }) => {
  await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: 2 });
  await page.select('#keySel', '0');
  const reset = async (data = {}) => {
    await page.evaluate(() => { if (SV.entry.state.on) SV.entry.toggle(false); SV.state.selection.clear(); SV.paintSelection(); });
    srv.setData({ length: 16, notes: [], track: 'Flute', ...data });
    await sleep(500);
  };
  const notes = () => srv.state.data.notes.map(n => `${n.x}:${n.y}:${+n.d.toFixed(4)}`).sort().join(' ');
  const has = (x, y, d) => srv.state.data.notes.some(n => n.x === x && n.y === y && (d == null || Math.abs(n.d - d) < 1e-4));
  const press = async (...keys) => { for (const k of keys) { await page.keyboard.press(k); await sleep(110); } };
  const chord = async (mods, key) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(key); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await sleep(120); };
  const settle = () => sleep(450);
  const st = () => page.evaluate(() => ({ caret: SV.entry.state.caret, digit: SV.entry.state.digit, dot: SV.entry.state.dot, tie: SV.entry.state.tie }));
  const flash = () => page.$eval('#flash', el => el.classList.contains('hidden') ? '' : el.textContent);
  const entryOn = async () => { await page.focus('#main'); await press('n'); await page.waitForSelector('#sve-layer .sve-caret'); await page.evaluate(() => SV.entry.setCaret(0)); };

  // ---- 1. Sibelius is the default layout: 4 = quarter, 3 = 8th, 5 = half, 8 sharp / 9 flat / 7 natural, 0 rest
  await reset();
  assert.equal(await page.evaluate(() => SV.entry.prefs.layout), 'sibelius');
  await entryOn();
  assert.deepEqual(await page.$$eval('#sve-keypad [data-dur]', bs => bs.map(b => b.dataset.dur + '=' + b.querySelector('kbd').textContent)),
    ['7=6', '6=5', '5=4', '4=3', '3=2', '2=1'], 'keypad shows the Sibelius keys');
  await press('4', 'c');
  await press('3', 'd', '8');                 // 8th D, then sharp
  await settle();
  assert(has(0, 72, 1) && has(24, 75, 0.5), 'Sibelius 4/3 + sharp: ' + notes());
  await press('7');                           // natural
  await settle();
  assert(has(24, 74, 0.5), 'Sibelius 7 natural: ' + notes());
  await press('9');                           // flat
  await settle();
  assert(has(24, 73, 0.5), 'Sibelius 9 flat: ' + notes());
  await press('0');                           // 8th rest
  assert.equal((await st()).caret, 48);
  await press('5', 'e');                      // half
  await settle();
  assert(has(48, 76, 2), 'Sibelius 5 = half: ' + notes());
  await press('Numpad6');
  assert.equal((await st()).digit, 7, 'numpad 6 = whole');
  await page.keyboard.press('NumpadEnter');
  assert.equal((await st()).tie, true, 'numpad Enter = tie (Sibelius)');
  await press('t');

  // ---- 2. Ctrl+↑/↓ octave on the last note; Alt+3 third above, Alt+Shift+6 sixth below (C major)
  await press('4');
  await chord(['Control'], 'ArrowUp');
  await settle();
  assert(has(48, 88, 2) && !has(48, 76), 'Ctrl+↑ octave: ' + notes());
  await chord(['Control'], 'ArrowDown');
  await settle();
  assert(has(48, 76, 2), 'Ctrl+↓ back: ' + notes());
  await chord(['Alt'], 'Digit3');             // E -> G above
  await settle();
  assert(has(48, 79, 2), 'Alt+3 adds a third above: ' + notes());
  await chord(['Alt', 'Shift'], 'Digit6');    // below the bottom note E: G
  await settle();
  assert(has(48, 67, 2), 'Alt+Shift+6 adds a sixth below: ' + notes());
  await chord(['Alt'], 'Digit8');             // octave above the top G
  await settle();
  assert(has(48, 91, 2), 'Alt+8 octave above: ' + notes());

  // ---- 3. Ctrl+←/→: caret by bar (4/4, 96 steps)
  await page.evaluate(() => SV.entry.setCaret(130));
  await chord(['Control'], 'ArrowRight');
  assert.equal((await st()).caret, 192, 'Ctrl+→ next bar');
  await chord(['Control'], 'ArrowLeft');
  assert.equal((await st()).caret, 96, 'Ctrl+← previous bar');
  await chord(['Control'], 'ArrowLeft');
  assert.equal((await st()).caret, 0);

  // ---- 4. Preferences: Dorico through the ⚙ panel (6 = quarter, 5 = 8th, = sharp, 0 natural, ',' rest, 1 too short)
  await page.click('#sve-prefs-btn');
  await page.waitForSelector('#sve-prefs:not(.hidden)');
  await page.select('#sve-layout', 'dorico');
  await sleep(200);
  assert.equal(await page.evaluate(() => localStorage.getItem('scoreview.entry.layout')), '"dorico"', 'layout saved');
  assert.equal(await page.$eval('#sve-keypad [data-dur="5"] kbd', el => el.textContent), '6');
  assert(await page.$eval('#sve-rowint-l', el => el.classList.contains('hidden')), 'number-row option only for Sibelius');
  await page.screenshot({ path: `${SHOTS}/out-entry-keys-prefs.png` });
  await page.keyboard.press('Escape');       // closes the panel, stays in entry
  assert(await page.$eval('#sve-prefs', el => el.classList.contains('hidden')) && (await page.evaluate(() => SV.entry.state.on)));
  await reset();
  await entryOn();
  await press('6', 'g', '5', 'a', '=');
  await settle();
  assert(has(0, 67, 1) && has(24, 70, 0.5), 'Dorico 6/5 + = sharp: ' + notes());
  await press('0');
  await settle();
  assert(has(24, 69, 0.5), 'Dorico 0 natural: ' + notes());
  await press(',');
  assert.equal((await st()).caret, 48, 'Dorico , = rest');
  await press('1');
  assert(/128th/.test(await flash()), 'Dorico 1 (128th) is refused with a message: ' + await flash());
  await press('8');
  assert.equal((await st()).digit, 7, 'Dorico 8 = whole');

  // ---- 5. MuseScore, and Sibelius's number row = intervals (numpad keeps durations)
  await page.evaluate(() => SV.entry.setPref('layout', 'musescore'));
  await press('5', 'c');
  await settle();
  assert(has(48, 72, 1), 'MuseScore 5 = quarter: ' + notes());
  await page.evaluate(() => { SV.entry.setPref('layout', 'sibelius'); SV.entry.setPref('rowIntervals', true); });
  await press('Numpad4', 'e', '3');           // numpad 4 = quarter; row 3 = third above E
  await settle();
  assert(has(72, 76, 1) && has(72, 79, 1), 'Sibelius row 3 adds a third: ' + notes());
  await page.evaluate(() => SV.entry.setPref('rowIntervals', false));

  // ---- 6. Registry and help follow the layout; no clashes in any layout
  for (const lay of ['sibelius', 'dorico', 'musescore']) {
    for (const row of [false, true]) {
      const c = await page.evaluate((l, r) => { SV.entry.setPref('layout', l); SV.entry.setPref('rowIntervals', r); return SV.shortcuts.conflicts(); }, lay, row);
      assert.deepEqual(c, [], `no shortcut clashes (${lay}${row ? ', number row' : ''}): ` + JSON.stringify(c));
    }
  }
  await page.evaluate(() => { SV.entry.setPref('layout', 'dorico'); SV.entry.setPref('rowIntervals', false); });
  const reg = await page.evaluate(() => SV.shortcuts.list().filter(e => e.owner === 'entry').map(e => SV.shortcuts.keyText(e) + ' ' + e.desc));
  assert(reg.some(t => t.startsWith('3–8 duration') && /Dorico/.test(t)), 'registry: Dorico durations ' + reg.join(' | '));
  assert(reg.some(t => t.startsWith('Alt+2–9')) && reg.some(t => t.includes('Ctrl+↑')), 'registry: intervals, octave');
  assert(await page.$eval('#sve-help', el => /Dorico/.test(el.textContent) && /Alt/.test(el.textContent)), 'footer help follows the layout');
  const help = await page.$eval('#svKeys', el => el.textContent);
  assert(/3–8/.test(help) && /Alt\+2–9/.test(help), 'All keyboard shortcuts table updated');
  await page.evaluate(() => SV.entry.setPref('layout', 'sibelius'));

  // ---- 7. Outside entry: Alt+3 on a selection (motifs) adds a third above; Ctrl+↑ moves the selection an octave
  await reset({ notes: [{ ch: 0, x: 0, y: 60, d: 1, vel: 90 }, { ch: 0, x: 24, y: 62, d: 1, vel: 90 }] });
  await page.evaluate(() => { SV.state.selection = new Set(['L0_0_60', 'L0_24_62']); SV.paintSelection(); document.getElementById('main').focus(); });
  await chord(['Alt'], 'Digit3');
  await settle();
  assert(has(0, 64) && has(24, 65) && has(0, 60), 'Alt+3 outside entry: third above the selection: ' + notes());
  await page.evaluate(() => { SV.state.selection = new Set(['L0_0_60']); SV.paintSelection(); });
  await chord(['Control'], 'ArrowUp');
  await settle();
  assert(has(0, 72) && !has(0, 60), 'Ctrl+↑ outside entry: octave: ' + notes());

  // ---- 8. Legato overlap (track name) and its undo; short notes (gap / half)
  await reset({ track: 'Violins Legato' });
  await entryOn();
  await press('4', 'c', 'd');
  await settle();
  assert(has(0, 72, 1 + 1 / 16) && has(24, 74, 1), 'legato: the first note runs a 64th into the next: ' + notes());
  const caretNow = (await st()).caret;
  await page.evaluate(() => { SV.entry.state.notated.clear(); SV.entry.state.last = { x: 24, steps: 24, pitches: [74], ch: 0 }; SV.entry.actions.select(-1); });
  assert.equal((await st()).caret, 24, 'no record: the overlap is not counted in the written length');
  await page.evaluate(c => { SV.entry.actions.select(1); SV.entry.setCaret(c); }, caretNow);
  await press('Backspace');
  await settle();
  assert(has(0, 72, 1) && !has(24, 74), 'Backspace takes the overlap back too: ' + notes());
  await page.evaluate(() => SV.entry.setPref('legatoOverlap', 'off'));
  await press('d');
  await settle();
  assert(has(0, 72, 1), 'overlap off: ' + notes());
  await page.evaluate(() => SV.entry.setPref('legatoOverlap', 'small'));

  await reset({ track: 'Violins Spiccato' });
  await entryOn();
  await press('4', 'c', 'd');
  await settle();
  assert(has(0, 72, 1 - 1 / 16) && has(24, 74, 1 - 1 / 16), 'shorts: small gap: ' + notes());
  assert.equal((await st()).caret, 48, 'the caret follows the written length');
  await page.evaluate(() => SV.entry.setPref('shortLen', 'half'));
  await press('e');
  await settle();
  assert(has(48, 76, 0.5), 'shorts: half length: ' + notes());
  await press('ArrowLeft', 'ArrowLeft');      // caret back; then select the previous note: its written length is kept
  await page.evaluate(() => SV.entry.actions.select(-1));
  assert.equal((await st()).caret, 48, 'selecting a shortened note puts the caret after its written length');
  // With no record of the written lengths (a reload) the shortening is undone from the played length.
  await page.evaluate(() => SV.entry.setPref('shortLen', 'gap'));
  await page.evaluate(() => { SV.entry.state.notated.clear(); SV.entry.state.last = { x: 48, steps: 24, pitches: [76], ch: 0 }; SV.entry.actions.select(-1); });
  assert.equal((await st()).caret, 48, 'no record: a 15/16 spiccato note counts as a quarter');
  await page.evaluate(() => SV.entry.setPref('shortLen', 'gap'));

  // A note written at full length in Bitwig on a short track (on the step grid) is not taken for a gapped one.
  await reset({ track: 'Violins Spiccato', notes: [{ ch: 0, x: 0, y: 72, d: 1, vel: 90 }, { ch: 0, x: 24, y: 74, d: 1, vel: 90 }] });
  await entryOn();
  await page.evaluate(() => { SV.entry.state.last = { x: 24, steps: 24, pitches: [74], ch: 0 }; SV.entry.actions.select(-1); });
  assert.equal((await st()).caret, 24, 'a full-length quarter from Bitwig on a spiccato track stays a quarter');

  // Keyswitch articulation (BBC SO strings map): Short Spiccato (key 4) at 0, Legato (key 0) at 48.
  await reset({ track: 'Violins', notes: [{ ch: 0, x: 0, y: 4, d: 0.25, vel: 100 }, { ch: 0, x: 48, y: 0, d: 0.25, vel: 100 }] });
  await entryOn();
  await press('4', 'c', 'd', 'e', 'f');
  await settle();
  assert(has(0, 72, 15 / 16) && has(24, 74, 15 / 16) && has(48, 76, 1 + 1 / 16) && has(72, 77, 1),
    'keyswitches: short before 48, legato after (a short note is not run into the legato one): ' + notes());

  // ---- 9. Out-of-range warning (Violin: G3 up); off when the preference is off
  await reset({ track: 'Violin' });
  await entryOn();
  await page.evaluate(() => { SV.entry._midi('on', 50, 90); SV.entry._midi('off', 50); });
  await sleep(250);
  const warn = await flash();
  assert(/below the violin's range/.test(warn) && /G3/.test(warn), 'range warning: ' + warn);
  await page.screenshot({ path: `${SHOTS}/out-entry-keys-range.png`, clip: { x: 0, y: 0, width: 1100, height: 330 } });
  await page.evaluate(() => SV.entry.setPref('rangeWarn', 'off'));
  await sleep(2700);
  await page.evaluate(() => { SV.entry._midi('on', 48, 90); SV.entry._midi('off', 48); });
  await sleep(250);
  assert(!/range/.test(await flash()), 'no warning when off');
  await page.evaluate(() => SV.entry.setPref('rangeWarn', 'comfort'));
  await page.evaluate(() => { SV.entry._midi('on', 96, 90); SV.entry._midi('off', 96); });
  await sleep(250);
  assert(/above the violin's comfortable range/.test(await flash()), 'comfort warning: ' + await flash());

  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('entry-keys-e2e OK');
});
