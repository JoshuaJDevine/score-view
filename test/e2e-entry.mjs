// End-to-end test of the note-entry module (web/features/entry.js) against the mock server:
// letters, keypad durations, accidentals, repeat, tie, triplets, rest, MIDI chords, Backspace, overwrite,
// rhythm-first slots, a rhythm cell, a tapped rhythm and mouse entry. Screenshots go to test/out-entry-*.png.
import assert from 'assert';
import { withPage } from './lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 8842);

await withPage({ port: PORT }, async ({ page, srv, errors }) => {
  await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: 2 });
  srv.setData({ length: 16, notes: [] });
  await page.select('#keySel', '0');
  await sleep(400);
  const notes = () => srv.state.data.notes.map(n => `${n.x}:${n.y}:${+n.d.toFixed(4)}`).sort();
  const has = (x, y, d) => srv.state.data.notes.some(n => n.x === x && n.y === y && (d == null || Math.abs(n.d - d) < 1e-4));
  const press = async (...keys) => { for (const k of keys) { await page.keyboard.press(k); await sleep(120); } };
  const settle = () => sleep(450);
  const shot = path => page.screenshot({ path, clip: { x: 0, y: 66, width: 1100, height: 220 } });

  // These steps use the MuseScore keypad layout (5 = quarter); test/entry-keys-e2e.mjs covers Sibelius and Dorico.
  await page.evaluate(() => SV.entry.setPref('layout', 'musescore'));

  // Entry mode on: caret drawn on the staff.
  await press('n');
  await page.waitForSelector('#sve-layer .sve-caret');
  assert(await page.$eval('#sve-pill', el => el.textContent.includes('ENTRY')), 'pill shows entry');

  // 1. Letters with quarter notes (C major, starting near the middle line B4).
  await press('5', 'c', 'd', 'e', 'f');
  await settle();
  assert(has(0, 72, 1) && has(24, 74, 1) && has(48, 76, 1) && has(72, 77, 1), 'letters: ' + notes());

  // 2. 8ths, sharp + natural on the last note, repeat, tie.
  await press('4', 'g', '+');
  await settle();
  assert(has(96, 80, 0.5), 'sharpened to G#: ' + notes());
  await press('=');
  await settle();
  assert(has(96, 79, 0.5) && !has(96, 80), 'natural back to G: ' + notes());
  await press('r');                      // repeat G at 108
  await press('t', 'g');                 // tie: extends the note at 108 by an 8th
  await settle();
  assert(has(108, 79, 1) && !has(120, 79), 'tie extends: ' + notes());

  // 3. Selection follows the entered note: Alt+ArrowUp (core, Score View keys: semitone) raises it.
  await page.keyboard.down('Alt'); await press('ArrowUp'); await page.keyboard.up('Alt');
  await settle();
  assert(has(108, 80, 1), 'Alt+arrow up on entered note: ' + notes());
  await page.keyboard.down('Alt'); await press('ArrowDown'); await page.keyboard.up('Alt');
  await settle();

  // 4. Triplets (Ctrl+3): 8th triplets are 8 steps.
  await page.keyboard.down('Control'); await page.keyboard.press('3'); await page.keyboard.up('Control');
  await press('c', 'd', 'e');
  await page.keyboard.down('Control'); await page.keyboard.press('3'); await page.keyboard.up('Control');
  await settle();
  assert(has(132, 84, 1 / 3) && has(140, 86, 1 / 3) && has(148, 88, 1 / 3), 'triplets: ' + notes());

  // 5. Rest advances the caret (8th = 12 steps): 156 -> 168.
  await press('0');
  assert.equal(await page.evaluate(() => SV.entry.state.caret), 168);

  // 6. MIDI: a C major chord (pressed within 60 ms) then a single D; Backspace takes the D back.
  await page.evaluate(() => {
    const t = performance.now();
    SV.entry._midi('on', 60, 96, t); SV.entry._midi('on', 64, 90, t + 15); SV.entry._midi('on', 67, 80, t + 30);
    SV.entry._midi('off', 64); SV.entry._midi('off', 60); SV.entry._midi('off', 67);
  });
  await sleep(150);
  await page.evaluate(() => { SV.entry._midi('on', 62, 70); SV.entry._midi('off', 62); });
  await settle();
  assert(has(168, 60, 0.5) && has(168, 64, 0.5) && has(168, 67, 0.5) && has(180, 62, 0.5), 'midi: ' + notes());
  assert.equal(srv.state.data.notes.find(n => n.x === 168 && n.y === 60).vel, 96, 'midi velocity kept');
  await press('Backspace');
  await settle();
  assert(!has(180, 62) && await page.evaluate(() => SV.entry.state.caret) === 180, 'backspace undoes MIDI note');
  await shot('test/out-entry-1-melody.png');

  // 7. Overwrite: a quarter B at the start replaces the C there (B is closest to the C-major chord's root C4).
  await page.evaluate(() => SV.entry.setCaret(0));
  await press('5', 'b');
  await settle();
  assert(has(0, 59, 1) && !has(0, 72) && has(24, 74), 'overwrite: ' + notes());

  // 8. Shift+letter adds to the chord above.
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyD'); await page.keyboard.up('Shift');
  await settle();
  assert(has(0, 62, 1), 'shift+D adds D above B: ' + notes());

  // 9. Rhythm-first: lay 8-8-quarter slots in bar 3, see placeholders, then fill them from MIDI.
  await page.click('#sve-rf');
  await page.evaluate(() => SV.entry.setCaret(192));
  await press('4', '4', '5');
  await sleep(500);
  const ph = await page.$$eval('#paper g.note[id^="nP"]', els => els.length);
  assert.equal(ph, 3, 'three placeholder notes');
  await shot('test/out-entry-2-slots.png');
  for (const p of [65, 67, 69]) await page.evaluate(p => { SV.entry._midi('on', p); SV.entry._midi('off', p); }, p);
  await settle();
  assert(has(192, 65, 0.5) && has(204, 67, 0.5) && has(216, 69, 1), 'slots filled: ' + notes());
  await press('Backspace');
  await settle();
  assert(!has(216, 69), 'backspace un-fills the last slot');
  await press('c');
  await settle();
  assert(has(216, 72, 1), 'letter fills slot (C nearest G4 is C5): ' + notes());

  // 10. Rhythm cell F1 (dotted 8th + 16th) at the caret (240), filled with letters.
  await press('F1');
  await sleep(400);
  await press('e', 'd');
  await settle();
  assert(has(240, 76, 0.75) && has(258, 74, 0.25), 'rhythm cell: ' + notes());

  // 11. Tapped rhythm on the sustain pedal at 120 BPM: taps at 0, 0.5 s, 0.75 s, 1 s -> quarter, 8th, 8th, + current value.
  await page.evaluate(() => SV.entry.setCaret(288));
  await page.evaluate(() => {
    [0, 500, 750, 1000].forEach(t => { SV.entry._midi('cc', 64, 127, 1000 + t); SV.entry._midi('cc', 64, 0, 1100 + t); });
    SV.entry.finishCapture();
  });
  await sleep(400);
  const slots = await page.evaluate(() => SV.entry.state.slots.filter(s => !s.filled).map(s => [s.x, s.steps]));
  assert.deepEqual(slots, [[288, 24], [312, 12], [324, 12], [336, 24]], 'tapped slots ' + JSON.stringify(slots));
  await shot('test/out-entry-3-tapped.png');
  for (const p of [60, 62, 64, 65]) await page.evaluate(p => { SV.entry._midi('on', p); SV.entry._midi('off', p); }, p);
  await settle();
  assert(has(288, 60, 1) && has(312, 62, 0.5) && has(324, 64, 0.5) && has(336, 65, 1), 'tapped slots filled: ' + notes());
  await page.click('#sve-rf');

  // 12. Mouse entry: hover the middle line (B4) of bar 4 shows a ghost; clicking enters it with the current value.
  await page.evaluate(() => SV.entry.setCaret(360));
  const target = await page.evaluate(() => {
    const st = document.getElementById('m4s1');
    const lines = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    const mid = lines[2];
    return { x: mid.left + mid.width * 0.62, y: mid.top + mid.height / 2 };
  });
  await page.mouse.move(target.x, target.y);
  await sleep(200);
  assert(await page.$('#sve-layer .sve-ghost'), 'ghost note shown');
  const ghostName = await page.$eval('#sve-layer .sve-gname', el => el.textContent);
  assert.equal(ghostName, 'B4');
  await shot('test/out-entry-4-ghost.png');
  await page.mouse.click(target.x, target.y);
  await settle();
  const mouseNote = srv.state.data.notes.find(n => n.y === 71 && n.x >= 288 && n.x < 384);
  assert(mouseNote && mouseNote.d === 1 && mouseNote.x % 6 === 0, 'mouse entry: ' + notes());
  await page.mouse.move(10, 10);
  await sleep(200);
  await shot('test/out-entry-5-final.png');

  // 13. Key signature: in G major, F means F#.
  await page.select('#keySel', '1');
  await sleep(400);
  await page.evaluate(() => SV.entry.setCaret(372));
  await press('f');
  await settle();
  assert(srv.state.data.notes.some(n => n.x === 372 && n.y % 12 === 6), 'F# in G major: ' + notes());

  await press('Escape');
  assert(!(await page.$('#sve-layer .sve-caret')), 'Esc leaves entry mode');
  assert.deepEqual(errors, []);
  console.log('e2e entry OK —', srv.state.data.notes.length, 'notes,', srv.edits.length, 'edit ops');
});
