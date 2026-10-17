// End-to-end test of controller-native entry (web/features/controller.js, GitHub #15) with simulated MIDI:
// MIDI Learn of a relative encoder for Duration (and spinning it), a pad note for Rest, a CC button for Undo,
// an encoder for Pitch (diatonic, chromatic with Shift), encoder-mode detection, the Launchkey MK4 default map,
// the generic A0–B1 action keys (Web MIDI and the Bitwig bridge, gated by the instrument's range), pitch-bend
// caret zones, persistence and import/export. Screenshots: test/out.controller-panel.png, test/out.controller-hud.png.
import assert from 'assert';
import puppeteer from 'puppeteer-core';
import { CHROME } from './lib.mjs';
import { startMockServer } from './mock-server.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 8950);
const BOX = 'Test Encoder Box', LK = 'Launchkey MK4 49 MIDI', S88 = 'KONTROL S88 MK3';

const srv = await startMockServer({ port: PORT });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
try {
  srv.setPlay({ playing: false });
  srv.setData({ length: 16, notes: [], track: 'Violin 1' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scoreview.mode', '"clip"'); } catch (e) { /* ignore */ }
    const mk = name => { const i = { name, state: 'connected', onmidimessage: null, open: () => Promise.resolve(i) }; return i; };
    window.__ins = { s88: mk('KONTROL S88 MK3'), lk: mk('Launchkey MK4 49 MIDI') };
    navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['a', window.__ins.s88], ['b', window.__ins.lk]]), outputs: new Map(), onstatechange: null });
  });
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#paper svg') && window.SV && SV.controller, { timeout: 30000 });
  await page.select('#keySel', '0');
  await sleep(300);
  await page.keyboard.press('n');
  await page.waitForSelector('#sve-layer .sve-caret');

  const notes = () => srv.state.data.notes.map(n => `${n.x}:${n.y}:${+n.d.toFixed(4)}`).sort().join(' ');
  const has = (x, y, d) => srv.state.data.notes.some(n => n.x === x && n.y === y && (d == null || Math.abs(n.d - d) < 1e-4));
  const st = () => page.evaluate(() => ({ digit: SV.entry.state.digit, caret: SV.entry.state.caret, dot: SV.entry.state.dot,
    chord: SV.entry.state.chordMode, last: SV.entry.state.last && SV.entry.state.last.pitches }));
  // A raw message from a named input. Spacing in ms keeps the encoder's acceleration out of it unless asked.
  const raw = async (data, port = BOX, gap = 0) => { await page.evaluate((d, p) => SV.controller._raw(d, p), data, port); if (gap) await sleep(gap); };
  const key = async (n, port = BOX, ch = 0) => { await raw([0x90 | ch, n, 100], port); await raw([0x80 | ch, n, 0], port); };
  // Through the fake Web MIDI input itself (the real path: onmidimessage with the input's name).
  const webIn = (which, data) => page.evaluate((w, d) => window.__ins[w].onmidimessage({ data: new Uint8Array(d), timeStamp: performance.now() }), which, data);
  const settle = () => sleep(450);
  const learnRow = id => page.click(`#svc-panel tr[data-a="${id}"] button[data-k="learn"]`);
  const bindings = port => page.evaluate(p => SV.controller.bindingsFor(p), port);

  // ---- Panel opens; Learn an encoder (64-centred relative) for Duration.
  await page.click('#svc-open');
  await page.waitForSelector('#svc-panel tr[data-a="encDur"]');
  await learnRow('encDur');
  assert(await page.$eval('#svc-panel tr[data-a="encDur"]', el => el.classList.contains('hot')), 'row shows learning');
  assert(await page.$eval('#svc-hud', el => el.classList.contains('learn') && el.textContent.includes('Learn: Duration')), 'learn HUD');
  await raw([0xb0, 21, 65], BOX, 30); await raw([0xb0, 21, 65], BOX, 30); await raw([0xb0, 21, 66], BOX, 30);
  await sleep(700);
  let b = (await bindings(BOX)).find(x => x.action === 'encDur' && x.learnt);
  assert(b && b.ctl.type === 'cc' && b.ctl.num === 21 && b.ctl.ch === 0 && b.ctl.mode === 'rel64', 'learnt relative-64 encoder: ' + JSON.stringify(b));
  assert(await page.evaluate(() => !SV.controller.state.learn), 'learn finished');

  // Spin it: 2 detents per duration step. Quarter (5) -> +4 detents -> whole (7); -6 detents -> 8th (4).
  for (let i = 0; i < 4; i++) await raw([0xb0, 21, 65], BOX, 60);
  assert.equal((await st()).digit, 7, 'encoder clockwise -> whole');
  await sleep(450);
  for (let i = 0; i < 6; i++) await raw([0xb0, 21, 63], BOX, 60);
  assert.equal((await st()).digit, 4, 'encoder anticlockwise -> 8th');
  assert(await page.$eval('#svc-hud', el => el.classList.contains('show') && el.textContent.includes('Duration') && el.textContent.includes('CC 21')), 'duration HUD');
  await page.screenshot({ path: 'test/out.controller-hud.png', clip: { x: 450, y: 620, width: 600, height: 200 } });

  // ---- Learn a pad note (channel 10) for Rest; keys on channel 1 still enter notes.
  await learnRow('rest');
  await key(36, BOX, 9);
  await sleep(100);
  b = (await bindings(BOX)).find(x => x.action === 'rest' && x.learnt);
  assert(b && b.ctl.type === 'note' && b.ctl.num === 36 && b.ctl.ch === 9, 'learnt pad: ' + JSON.stringify(b));
  await key(60);
  await settle();
  assert(has(0, 60, 0.5), 'key 60 entered as an 8th: ' + notes());
  await key(36, BOX, 9);                         // pad: rest
  await key(36);                                 // the same note number on channel 1 is a key (C2)
  await settle();
  assert(has(24, 36, 0.5) && !has(12, 36), 'pad rested, key C2 entered after the rest: ' + notes());
  assert.equal((await st()).caret, 36);

  // ---- Learn a CC button (ch 16, 127/0) for Undo: it takes back the last entry, then the rest.
  await learnRow('undo');
  await raw([0xbf, 77, 127]); await raw([0xbf, 77, 0]);
  await sleep(700);
  b = (await bindings(BOX)).find(x => x.action === 'undo' && x.learnt);
  assert(b && b.ctl.type === 'cc' && b.ctl.num === 77 && b.ctl.ch === 15 && b.ctl.mode === 'btn', 'learnt undo button: ' + JSON.stringify(b));
  await raw([0xbf, 77, 127]); await raw([0xbf, 77, 0]);
  await settle();
  assert(!has(24, 36) && has(0, 60), 'undo took back the C2: ' + notes());
  assert.equal((await st()).caret, 24);
  await raw([0xbf, 77, 127]); await raw([0xbf, 77, 0]);
  assert.equal((await st()).caret, 12, 'second undo took back the rest');

  // ---- Encoder for Pitch (two's complement): diatonic in the key, chromatic while Shift is held.
  await learnRow('encPitch');
  await raw([0xb0, 23, 1], BOX, 20); await raw([0xb0, 23, 1], BOX, 20);
  await sleep(700);
  b = (await bindings(BOX)).find(x => x.action === 'encPitch' && x.learnt);
  assert(b && b.ctl.mode === 'rel2c', 'learnt two\'s complement encoder: ' + JSON.stringify(b));
  await key(64);                                 // E4 at 12
  await settle();
  await raw([0xb0, 23, 1], BOX, 40); await raw([0xb0, 23, 1], BOX, 40);   // +1 diatonic step: E -> F
  await settle();
  assert(has(12, 65, 0.5) && !has(12, 64), 'diatonic up E->F: ' + notes());
  await raw([0xb0, 23, 1], BOX, 40); await raw([0xb0, 23, 1], BOX, 40);   // F -> G
  await settle();
  assert(has(12, 67), 'diatonic up F->G: ' + notes());
  await page.keyboard.down('Shift');
  await raw([0xb0, 23, 127], BOX, 40); await raw([0xb0, 23, 127], BOX, 40); // Shift: chromatic down G -> F#
  await page.keyboard.up('Shift');
  await settle();
  assert(has(12, 66) && !has(12, 67), 'chromatic with Shift G->F#: ' + notes());

  // ---- Encoder mode detection.
  const cls = await page.evaluate(() => [[65, 65, 66], [1, 1, 2], [127, 126], [40, 41, 42, 43], [63, 63], [9]].map(v => SV.controller.classify(20, v)));
  assert.deepEqual(cls, ['rel64', 'rel2c', 'rel2c', 'abs', 'rel64', 'rel2c'], 'classify: ' + cls);
  assert.equal(await page.evaluate(() => SV.controller.classify(96, [1])), 'incdec');

  // ---- Program change for Next bar; a MIDI clock tick during learning is ignored.
  await learnRow('barNext');
  await raw([0xf8]);
  await raw([0xc0, 4]);
  b = (await bindings(BOX)).find(x => x.action === 'barNext' && x.learnt);
  assert(b && b.ctl.type === 'pc' && b.ctl.num === 4, 'learnt program change: ' + JSON.stringify(b));
  assert.equal((await st()).caret, 24);
  await raw([0xc0, 4]);
  assert.equal((await st()).caret, 96, 'program change -> next bar');
  await page.evaluate(() => SV.entry.setCaret(24));

  await page.$eval('#svc-panel', el => { el.scrollTop = 0; });
  await page.screenshot({ path: 'test/out.controller-panel.png', clip: { x: 900, y: 50, width: 600, height: 850 } });

  // ---- Launchkey MK4 defaults (no learning) through the fake Web MIDI input.
  await page.evaluate(() => SV.controller.close());
  await webIn('lk', [0xbf, 102, 127]); await webIn('lk', [0xbf, 102, 0]);      // Track ▶ -> caret right by an 8th
  assert.equal((await st()).caret, 36, 'Launchkey Track ▶ moves the caret');
  await webIn('lk', [0x99, 50, 100]); await webIn('lk', [0x89, 50, 0]);        // pad 50 (ch 10): dot
  assert.equal((await st()).dot, true, 'Launchkey pad -> dot');
  await webIn('lk', [0x99, 50, 100]); await webIn('lk', [0x89, 50, 0]);
  await webIn('lk', [0xbf, 118, 127]); await webIn('lk', [0xbf, 118, 0]);      // Loop -> chord mode
  assert.equal((await st()).chord, true, 'Launchkey Loop -> chord mode');
  await webIn('lk', [0x90, 72, 90]); await webIn('lk', [0x80, 72, 0]);         // a key in chord mode joins the last chord
  await settle();
  assert(has(12, 66) && has(12, 72), 'chord mode adds to the last entry: ' + notes());
  await webIn('lk', [0xbf, 118, 127]); await webIn('lk', [0xbf, 118, 0]);
  // Launchkey encoder 1 (CC 21, auto-detected as 64-centred relative): duration.
  for (let i = 0; i < 4; i++) { await webIn('lk', [0xb0, 21, 65]); await sleep(60); }
  assert.equal((await st()).digit, 6, 'auto-detected relative encoder: 8th -> half');
  assert(await page.$eval('#svc-hud .c', el => el.textContent.includes('?')), 'HUD marks unverified default');

  // ---- Generic map on the S88: A0–B1 are action keys below the violin's range (G3).
  await webIn('s88', [0x90, 29, 100]); await webIn('s88', [0x80, 29, 0]);      // F1 -> quarter
  assert.equal((await st()).digit, 5, 'generic F1 -> quarter');
  await webIn('s88', [0xe0, 0x7f, 0x7f]); await webIn('s88', [0xe0, 0, 0x40]); // bend up -> caret right (quarter)
  assert.equal((await st()).caret, 60, 'pitch bend up moves the caret');
  // ... but on a bass (range from C1) F1 is a playable note.
  srv.setData({ track: 'Bass' });
  await sleep(600);
  await webIn('s88', [0x90, 29, 100]); await webIn('s88', [0x80, 29, 0]);
  await settle();
  assert(has(60, 29, 1), 'F1 enters a note on a bass: ' + notes());
  srv.setData({ track: 'Violin 1' });
  await sleep(600);

  // ---- Bitwig bridge (notes only): the generic keys work there too.
  await page.evaluate(() => SV.entry.setMidiSource('bitwig'));
  await page.waitForFunction(() => SV.entry.bridge.status === 'ok', { timeout: 5000 });
  let t = Date.now();
  srv.pushMidi([{ type: 'on', key: 28, vel: 100, t }, { type: 'off', key: 28, t: t + 50 }]);   // E1 -> 8th
  await page.waitForFunction(() => SV.entry.state.digit === 4, { timeout: 3000 });
  t = Date.now();
  srv.pushMidi([{ type: 'on', key: 23, vel: 100, t }, { type: 'off', key: 23, t: t + 50 }]);   // B0 -> rest
  await page.waitForFunction(() => SV.entry.state.caret === 96, { timeout: 3000 });
  await page.evaluate(() => SV.entry.setMidiSource('auto'));

  // ---- Persistence + export/import.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.controller.maps')));
  assert(saved[BOX] && saved[BOX].bindings.some(x => x.action === 'rest'), 'maps saved per port');
  const exported = JSON.stringify({ maps: { 'Other Box': saved[BOX] } });
  await page.evaluate(j => SV.controller.importJson(j), exported);
  assert((await bindings('Other Box')).some(x => x.action === 'undo' && x.ctl.num === 77), 'import adds a device map');

  // ---- Entry off: only free actions run; Record (CC 117) on the Launchkey enters entry mode again.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !SV.entry.state.on);
  await webIn('lk', [0xbf, 117, 127]); await webIn('lk', [0xbf, 117, 0]);
  assert(await page.evaluate(() => SV.entry.state.on), 'Launchkey Record toggles entry mode');

  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('controller-e2e OK');
} finally {
  await browser.close();
  await srv.close();
}
