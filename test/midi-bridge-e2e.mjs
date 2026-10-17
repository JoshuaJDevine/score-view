// End-to-end test of the MIDI bridge (Bitwig forwards the notes it receives; GET /api/midi) in entry.js:
// bridge notes and chords enter at the caret like Web MIDI ones (chords grouped by Bitwig's timestamps, not arrival),
// Auto falls back to the bridge when Web MIDI is missing or rejected, Auto prefers a working Web MIDI port,
// the source selector, and notes while the transport plays are ignored unless "Record while playing" is on.
import assert from 'assert';
import puppeteer from 'puppeteer-core';
import { CHROME } from './lib.mjs';
import { startMockServer } from './mock-server.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 8930);

// Web MIDI stubs, installed before the page's scripts run.
const STUBS = {
  missing: () => { delete Navigator.prototype.requestMIDIAccess; delete navigator.requestMIDIAccess; },
  rejected: () => { navigator.requestMIDIAccess = () => Promise.reject(new DOMException('denied', 'SecurityError')); },
  working: () => {
    const input = { name: 'KONTROL S88 MK3', state: 'connected', onmidimessage: null, open: () => Promise.resolve(input) };
    window.__fakeIn = input;
    navigator.requestMIDIAccess = () => Promise.resolve({ inputs: new Map([['in1', input]]), outputs: new Map(), onstatechange: null });
  },
};

const srv = await startMockServer({ port: PORT });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];

async function openPage(stub) {
  srv.setPlay({ playing: false });
  srv.setData({ length: 16, notes: [] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('scoreview.mode', '"clip"'); } catch (e) { /* ignore */ } });
  await page.evaluateOnNewDocument(STUBS[stub]);
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#paper svg'), { timeout: 30000 });
  await page.select('#keySel', '0');
  await sleep(300);
  await page.keyboard.press('n');
  await page.waitForSelector('#sve-layer .sve-caret');
  return page;
}
const pill = page => page.$eval('#sve-pill .midi', el => el.textContent);
const waitPill = (page, text) => page.waitForFunction(t => (document.querySelector('#sve-pill .midi') || {}).textContent === t, { timeout: 5000 }, text);
const has = (x, y, d) => srv.state.data.notes.some(n => n.x === x && n.y === y && (d == null || Math.abs(n.d - d) < 1e-4));
const notes = () => srv.state.data.notes.map(n => `${n.x}:${n.y}:${+n.d.toFixed(4)}`).sort().join(' ');
const caret = page => page.evaluate(() => SV.entry.state.caret);
const tap = (key, t, vel = 100, len = 80) => [{ type: 'on', key, vel, t }, { type: 'off', key, t: t + len }];
const settle = () => sleep(500);

try {
  // ---- 1. Web MIDI rejected: Auto falls back to the bridge.
  let page = await openPage('rejected');
  await waitPill(page, 'MIDI: via Bitwig ✓');
  assert.equal(await page.evaluate(() => SV.entry.midiPath()), 'bridge');
  assert.equal(await page.$eval('#sve-midisrc', el => el.value), 'auto');
  assert(await page.$eval('#sve-pill .midi', el => el.title.includes('Web MIDI: blocked')), 'pill title explains the fallback');

  // Single note at the caret (quarter = 24 steps), velocity kept.
  let t = Date.now();
  srv.pushMidi(tap(60, t, 77));
  await settle();
  assert(has(0, 60, 1), 'bridge single note: ' + notes());
  assert.equal(srv.state.data.notes.find(n => n.x === 0 && n.y === 60).vel, 77, 'bridge velocity kept');
  assert.equal(await caret(page), 24);

  // A chord: three keys within 60 ms (by Bitwig's timestamps), released together.
  t = Date.now();
  srv.pushMidi([{ type: 'on', key: 64, t }, { type: 'on', key: 67, t: t + 20 }, { type: 'on', key: 72, t: t + 40 },
                { type: 'off', key: 67, t: t + 300 }, { type: 'off', key: 64, t: t + 310 }, { type: 'off', key: 72, t: t + 320 }]);
  await settle();
  assert(has(24, 64, 1) && has(24, 67, 1) && has(24, 72, 1), 'bridge chord: ' + notes());
  assert.equal(await caret(page), 48);

  // Grouping follows the event timestamps, not arrival: two keys 150 ms apart that arrive in one batch are two
  // entries (legato: the first is still held), and a chord whose second key arrives late is still one chord.
  t = Date.now();
  srv.pushMidi([{ type: 'on', key: 62, t }, { type: 'on', key: 65, t: t + 150 }, { type: 'off', key: 62, t: t + 200 }, { type: 'off', key: 65, t: t + 260 }]);
  await settle();
  assert(has(48, 62, 1) && has(72, 65, 1) && !has(48, 65), 'legato pair split by timestamps: ' + notes());
  t = Date.now();
  srv.pushMidi({ type: 'on', key: 69, t });
  await sleep(250);                                   // second key arrives 250 ms later but was played 25 ms later
  srv.pushMidi([{ type: 'on', key: 74, t: t + 25 }, { type: 'off', key: 69, t: t + 400 }, { type: 'off', key: 74, t: t + 410 }]);
  await settle();
  assert(has(96, 69, 1) && has(96, 74, 1), 'late-arriving chord tone grouped: ' + notes());
  assert.equal(await caret(page), 120);

  // Backspace takes a bridge entry back like any other.
  await page.keyboard.press('Backspace');
  await settle();
  assert(!has(96, 69) && await caret(page) === 96, 'backspace undoes a bridge chord');

  // ---- 2. Transport playing: bridge notes are ignored (could be clip playback) ...
  srv.setPlay({ playing: true, pos: 0, step: -1 });
  await waitPill(page, 'MIDI: via Bitwig ⏸ (playing)');
  srv.pushMidi(tap(71, Date.now()));
  await settle();
  assert(!has(96, 71) && await caret(page) === 96, 'playing: bridge note ignored: ' + notes());
  // ... unless "Record while playing" is on.
  assert(await page.$eval('#sve-recplay', el => !el.checked), 'record while playing is off by default');
  await page.click('#sve-recplay');
  await waitPill(page, 'MIDI: via Bitwig ✓');
  srv.pushMidi(tap(71, Date.now()));
  await settle();
  assert(has(96, 71, 1), 'record while playing: ' + notes());
  await page.click('#sve-recplay');
  srv.setPlay({ playing: false });
  await page.screenshot({ path: 'test/out.midi-bridge.png', clip: { x: 0, y: 0, width: 1500, height: 300 } });
  await page.close();

  // ---- 3. No Web MIDI at all: Auto uses the bridge.
  page = await openPage('missing');
  await waitPill(page, 'MIDI: via Bitwig ✓');
  srv.pushMidi(tap(65, Date.now()));
  await settle();
  assert(has(0, 65, 1), 'no Web MIDI -> bridge: ' + notes());
  await page.close();

  // ---- 4. Web MIDI works: Auto uses it and ignores the bridge; "Bitwig" switches over (and ignores Web MIDI).
  page = await openPage('working');
  await waitPill(page, 'MIDI: KONTROL S88 MK3 ✓');
  assert.equal(await page.evaluate(() => SV.entry.midiPath()), 'web');
  await page.evaluate(() => {
    const t = performance.now(), send = (d, dt) => window.__fakeIn.onmidimessage({ data: new Uint8Array(d), timeStamp: t + dt });
    send([0x90, 60, 90], 0); send([0x90, 64, 90], 10); send([0x80, 60, 0], 200); send([0x80, 64, 0], 210);
  });
  srv.pushMidi(tap(72, Date.now()));
  await settle();
  assert(has(0, 60, 1) && has(0, 64, 1) && !has(24, 72) && !has(0, 72), 'auto + working Web MIDI: ' + notes());
  assert.equal(await page.evaluate(() => SV.entry.bridge.status), 'off', 'bridge not polled while Web MIDI is live');

  await page.select('#sve-midisrc', 'bitwig');
  await waitPill(page, 'MIDI: via Bitwig ✓');
  await page.evaluate(() => { window.__fakeIn.onmidimessage({ data: new Uint8Array([0x90, 50, 90]), timeStamp: performance.now() });
                              window.__fakeIn.onmidimessage({ data: new Uint8Array([0x80, 50, 0]), timeStamp: performance.now() + 50 }); });
  srv.pushMidi(tap(67, Date.now()));
  await settle();
  assert(has(24, 67, 1) && !has(24, 50), 'Bitwig source: bridge only: ' + notes());
  assert.equal(await page.evaluate(() => localStorage.getItem('scoreview.entry.midiSource')), '"bitwig"', 'source remembered');

  await page.select('#sve-midisrc', 'web');
  await waitPill(page, 'MIDI: KONTROL S88 MK3 ✓');
  assert.equal(await page.evaluate(() => SV.entry.bridge.status), 'off', 'Web MIDI source stops the bridge');

  // Leaving entry mode stops the bridge.
  await page.select('#sve-midisrc', 'bitwig');
  await waitPill(page, 'MIDI: via Bitwig ✓');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => SV.entry.bridge.status === 'off', { timeout: 3000 });
  await page.close();

  assert.deepEqual(errors, [], 'page errors');
  console.log('midi-bridge e2e: all passed');
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
  await browser.close();
  await srv.close();
}
