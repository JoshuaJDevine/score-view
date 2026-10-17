// Passage selection and copy/paste between staves (features/passage.js) against the mock arrangement + clip navigator:
// click / Shift / Ctrl+click selection and its boxes, Ctrl+C on one staff and Ctrl+V on another (overwrite: a note
// ringing in is shortened, keyswitches stay), Bitwig left on the pasted clip with the pasted notes selected so ↑↑ moves
// them, two staves onto consecutive staves (content offset), merge preference, R, Alt+click, click another staff's note
// to make its clip live, alias warning, refusals (no read, playing) and coexistence with the note clipboard.
//   PORT=8951 node test/passage-e2e.mjs
import assert from 'assert';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { startMockServer } from './mock-server.mjs';
import { CHROME, ROOT } from './lib.mjs';
import { openMenu } from './selectors.mjs';

const PORT = Number(process.env.PORT || 8951);
const shot = name => path.join(process.env.SHOTS_DIR || path.join(ROOT, 'test'), (process.env.SHOTS_DIR ? 'paste-' : 'out.paste-') + name + '.png');
const clip = (lane, track, start, playStop, notes = [], extra = {}) =>
  ({ lane, track, start, playStart: 0, playStop, loop: false, loopStart: 0, loopLength: playStop, notes, ...extra });
const n = (x, y, d, vel = 100) => ({ ch: 0, x, y, d, vel });
const arrangement = {
  tracks: [{ name: 'Piano' }, { name: 'Strings', group: true }, { name: 'Violins 1' }, { name: 'Violins 2' }, { name: 'Violas' },
           { name: 'Cellos' }, { name: 'Basses' }],
  home: 0,
  clips: [
    clip(0, 'Piano', 0, 16, [n(0, 60, 1), n(96, 62, 1)]),
    clip(2, 'Violins 1', 0, 16, [n(0, 72, 1, 90), n(24, 74, 1, 90), n(48, 76, 2, 90), n(96, 77, 4, 90), n(96, 20, 4)]),
    clip(3, 'Violins 2', 0, 16, [n(0, 55, 1), n(48, 57, 4), n(96, 59, 1), n(96, 21, 4), n(192, 60, 1)]),
    clip(4, 'Violas', 0, 16, [], { playStart: 4, playStop: 20, loopLength: 20 }), // content offset: x = (beat + 4) * 24
    clip(5, 'Cellos', 0, 16, [n(0, 48, 4)]),
    clip(6, 'Basses', 0, 16, [n(0, 36, 4)]),
    clip(6, 'Basses', 16, 16, [n(0, 36, 4)]), // same notes: looks like an alias of the first
  ],
};

const srv = await startMockServer({ port: PORT, arrangement, markers: [] });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run', '--disable-gpu'] });
const errors = [];
const clipOf = (t, start = 0) => srv.arrangement.clips.find(c => c.track === t && c.start === start);
const notesOf = (t, start = 0) => clipOf(t, start).notes.map(q => [q.x, q.y, q.d]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const step = s => console.log('  ok ' + s);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100 });
  page.on('pageerror', err => errors.push(String(err)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => { localStorage.clear(); localStorage.setItem('scoreview.mode', '"score"'); localStorage.setItem('scoreview.range', '"all"');
    localStorage.setItem('scoreview.passage.prefs', JSON.stringify({ emptyStaves: true })); }); // Violas has only an empty clip
  await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.passage && SV.state.liveData && document.querySelector('#paper svg'), { timeout: 30000 });

  // A point on an empty spot of bar `bar` of `track`'s staff (no notehead near, hitTest lands there).
  const spot = (track, bar) => page.evaluate((track, bar) => {
    const st = SV.state.render.staves.find(s => s.part.replace(/\s*✎$/, '') === track);
    const el = st && document.getElementById('m' + bar + 's' + st.n);
    if (!el) return null;
    const lines = [...el.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect()).filter(b => b.width > 20).sort((a, b) => a.top - b.top);
    const top = lines[0].top, gap = (lines[4].top - top) / 4;
    for (let fx = 0.92; fx > 0.1; fx -= 0.04) {
      for (const k of [1.5, 2.5, 0.5, 3.5]) {
        const x = lines[0].left + (lines[0].right - lines[0].left) * fx, y = top + gap * k;
        const target = document.elementFromPoint(x, y);
        if (!target || !target.closest('#paper')) continue; // not under a panel
        const ev = { target, clientX: x, clientY: y };
        const hit = SV.hitTest(ev);
        if (!SV.noteAt(ev) && hit && hit.measure === bar && hit.staff === st.n) return { x, y };
      }
    }
    return null;
  }, track, bar);
  const click = async (track, bar, mods = []) => {
    const p = await spot(track, bar);
    assert.ok(p, `an empty spot in bar ${bar} of ${track}`);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.click(p.x, p.y);
    for (const m of mods.slice().reverse()) await page.keyboard.up(m);
  };
  const ctrl = async key => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); };
  const selection = () => page.evaluate(() => SV.passage.selection());
  let reportCount = 0;
  const waitReport = async () => {
    await page.waitForFunction(k => SV.passage.lastReport() && SV.passage.lastReport().__k !== k, { timeout: 20000 }, reportCount);
    const r = await page.evaluate(k => { const r = SV.passage.lastReport(); r.__k = k; return { ...r }; }, ++reportCount);
    await new Promise(r => setTimeout(r, 50));
    return r;
  };

  // ---- 0. Without a read: the selection works, a paste says what is missing.
  await click('Piano', 1);
  assert.deepEqual((await selection()).staves, ['Piano']);
  await ctrl('KeyC');
  await ctrl('KeyV');
  let rep = await waitReport();
  assert.match(rep.error, /Read arrangement/, rep.message);
  // No read: Alt+click cannot copy, so it stays playback.js's play-from-bar even with a passage selected.
  const edits0 = srv.edits.length;
  await click('Piano', 2, ['Alt']);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(srv.edits.slice(edits0).some(l => /^playFrom /.test(l)), 'Alt+click played from the bar: ' + JSON.stringify(srv.edits.slice(edits0)));
  assert.equal(await page.evaluate(k => SV.passage.lastReport().__k, reportCount), reportCount, 'no paste was tried');
  srv.setPlay({ playing: false });
  await page.waitForFunction(() => !SV.state.playing);
  await page.keyboard.press('Escape');
  assert.equal(await selection(), null, 'Esc clears the passage');
  step('no read: clear message');

  // ---- 1. Read; selection by clicks.
  await page.click('#svarRead');
  await page.waitForFunction(() => SV.state.crawl && SV.state.base && SV.state.base.source === 'crawl' && SV.state.align && document.querySelector('#paper svg'), { timeout: 15000 });
  await page.waitForFunction(() => SV.state.render.staves.length >= 6);
  await click('Violins 1', 1);
  await click('Violas', 2, ['Shift']);
  let s = await selection();
  assert.deepEqual(s.staves, ['Violins 1', 'Violins 2', 'Violas']);
  assert.deepEqual([s.from, s.to], [1, 2]);
  await click('Basses', 1, ['Control']);
  assert.deepEqual((await selection()).staves, ['Violins 1', 'Violins 2', 'Violas', 'Basses'], 'Ctrl+click adds a staff');
  await click('Violins 2', 1, ['Control']);
  assert.deepEqual((await selection()).staves, ['Violins 1', 'Violas', 'Basses'], 'Ctrl+click removes it again');
  const boxes = await page.$$eval('#pas-layer .pas-box', els => els.length);
  assert.ok(boxes >= 3, 'light blue boxes drawn: ' + boxes);
  await page.screenshot({ path: shot('selection') });
  await page.keyboard.press('Escape');
  assert.equal(await page.$$eval('#pas-layer .pas-box', els => els.length), 0);
  step('click / Shift / Ctrl selection and boxes');

  // ---- 2. Copy Violins 1 bar 2, paste on Violins 2 bar 2 (overwrite); Bitwig stays there with the notes selected.
  await click('Violins 1', 2);
  await ctrl('KeyC');
  const cb = await page.evaluate(() => SV.passage.clipboard);
  assert.deepEqual(cb.staves[0].notes.map(q => [q.start, q.pitch, q.dur]), [[0, 77, 4]], 'keyswitch left out of the copy');
  await click('Violins 2', 2);
  await ctrl('KeyV');
  rep = await waitReport();
  assert.ok(!rep.error, rep.message);
  assert.match(rep.message, /Pasted into Violins 2, bar 2/);
  assert.deepEqual(notesOf('Violins 2'), [[0, 55, 1], [48, 57, 2], [96, 21, 4], [96, 77, 4], [192, 60, 1]],
    'bar 2 replaced, the note ringing in shortened, the keyswitch kept');
  assert.equal(srv.state.data.track, 'Violins 2', 'Bitwig left on the pasted clip');
  assert.deepEqual(srv.nav.stayed, { track: 'Violins 2', start: 0 });
  assert.ok(srv.edits.some(l => l === 'gotoStay 3 0 Violins%202'));
  await page.waitForFunction(() => SV.state.liveData.track === 'Violins 2' && SV.state.selection.has('L0_96_77'), { timeout: 10000 });
  s = await selection();
  assert.deepEqual([s.staves, s.from, s.to], [['Violins 2'], 2, 2], 'the passage moves to the destination');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => SV.state.selection.has('L0_96_78'), { timeout: 5000 });
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => SV.state.liveData.notes.some(q => q.x === 96 && q.y === 79), { timeout: 5000 });
  assert.ok(notesOf('Violins 2').some(q => q[0] === 96 && q[1] === 79), '↑↑ moved the pasted note in Bitwig');
  const score = await page.evaluate(() => SV.state.base.parts.find(p => p.name === 'Violins 2').notes.map(q => [q.start, q.pitch]));
  assert.ok(score.some(q => q[0] === 4 && q[1] === 77), 'the score shows the paste without a new read');
  await page.screenshot({ path: shot('after') });
  step('copy / paste onto another staff, stays on it, ↑↑ works');

  // ---- 3. Two staves onto consecutive staves (Violas has a content offset).
  await click('Violins 1', 1);
  await click('Violins 2', 1, ['Shift']);
  await ctrl('KeyC');
  await click('Violas', 3);
  await ctrl('KeyV');
  rep = await waitReport();
  assert.ok(!rep.error, rep.message);
  assert.match(rep.message, /^Pasted into Violas, Cellos, bar 3/);
  assert.deepEqual(notesOf('Violas'), [[288, 72, 1], [312, 74, 1], [336, 76, 2]]);
  assert.deepEqual(notesOf('Cellos'), [[0, 48, 4], [192, 55, 1], [240, 57, 2]]);
  assert.equal(srv.state.data.track, 'Violas', 'left on the first target');
  await page.waitForFunction(() => SV.state.liveData.track === 'Violas' && SV.state.selection.has('L0_288_72'), { timeout: 10000 });
  step('two staves onto two consecutive staves');

  // ---- 4. Merge preference (panel), then back to overwrite.
  await openMenu(page, 'passage');
  await page.select('#pasMode', 'merge');
  await page.screenshot({ path: shot('panel') });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.passage.prefs')).mode), 'merge');
  await page.click('#pasClose');
  await click('Violins 1', 1);
  await ctrl('KeyC');
  assert.deepEqual((await page.evaluate(() => SV.passage.clipboard)).staves.map(q => q.track), ['Violins 1']);
  await click('Cellos', 1);
  await ctrl('KeyV');
  rep = await waitReport();
  assert.ok(!rep.error, rep.message);
  assert.deepEqual(notesOf('Cellos').filter(q => q[0] < 96), [[0, 48, 4], [0, 72, 1], [24, 74, 1], [48, 76, 2]], 'merge keeps what was there');
  await page.click('#pasBtn');
  await page.select('#pasMode', 'overwrite');
  await page.click('#pasClose');
  step('merge preference');

  // ---- 5. R repeats the passage after itself.
  await click('Piano', 1);
  await page.keyboard.press('KeyR');
  rep = await waitReport();
  assert.ok(!rep.error, rep.message);
  assert.deepEqual(notesOf('Piano'), [[0, 60, 1], [96, 60, 1]]);
  s = await selection();
  assert.deepEqual([s.staves, s.from, s.to], [['Piano'], 2, 2], 'R moves on, so R again continues');
  step('R repeats');

  // ---- 6. Alt+click copies there (instead of playing from the bar).
  await click('Violins 1', 1);
  const before = srv.edits.length;
  await click('Violins 2', 4, ['Alt']);
  rep = await waitReport();
  assert.ok(!rep.error, rep.message);
  assert.deepEqual(notesOf('Violins 2').filter(q => q[0] >= 288), [[288, 72, 1], [312, 74, 1], [336, 76, 2]]);
  assert.ok(!srv.edits.slice(before).some(l => /^play/.test(l)), 'Alt+click did not start playback');
  step('Alt+click copies');

  // ---- 7. Alias warning.
  await click('Violins 1', 1);
  await ctrl('KeyC');
  await click('Basses', 1);
  await ctrl('KeyV');
  rep = await waitReport();
  assert.ok(!rep.error, rep.message);
  assert.ok(rep.info.some(t => /Basses bar 5 has the same notes .* clip alias/.test(t)), JSON.stringify(rep));
  step('alias warning');

  // ---- 8. Click a note on another staff: its clip becomes live, the note selected.
  await page.keyboard.press('Escape');
  const target = await page.evaluate(() => {
    const st = SV.state.render.staves.find(s => s.part.replace(/\s*✎$/, '') === 'Cellos');
    const t = SV.state.render.timeline.find(e => !SV.isLive(e.srcId) && Math.abs(e.start) < 1e-6 && document.getElementById(e.svgId)
      && document.getElementById(e.svgId).closest('g.staff').id === 'm1s' + st.n);
    const b = document.getElementById(t.svgId).querySelector('.notehead').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(() => SV.state.liveData.track === 'Cellos' && SV.state.selection.size === 1, { timeout: 10000 });
  assert.equal(srv.state.data.track, 'Cellos');
  assert.deepEqual(srv.nav.stayed, { track: 'Cellos', start: 0 });
  assert.ok([...await page.evaluate(() => [...SV.state.selection])][0].startsWith('L0_0_'), 'the clicked note is selected');
  step('click another staff\'s note: its clip becomes live');

  // ---- 9. Refused while playing.
  srv.setPlay({ playing: true });
  await page.waitForFunction(() => SV.state.playing);
  await click('Violins 1', 1);
  await ctrl('KeyC');
  await ctrl('KeyV');
  rep = await waitReport();
  assert.match(rep.error, /Stop playback first/);
  srv.setPlay({ playing: false });
  await page.waitForFunction(() => !SV.state.playing);
  step('refused while playing');

  // ---- 10. The note clipboard still works: with notes selected and no passage, Ctrl+C / V are features/mouse.js's.
  await page.keyboard.press('Escape');
  const passageClip = JSON.stringify(await page.evaluate(() => SV.passage.clipboard));
  await page.evaluate(() => { SV.state.selection = new Set(SV.state.liveData.notes.map(SV.liveId)); SV.paintSelection(); });
  await ctrl('KeyC');
  assert.equal(await page.evaluate(() => SV.mouse.clipboard.notes.length), await page.evaluate(() => SV.state.liveData.notes.length));
  assert.equal(JSON.stringify(await page.evaluate(() => SV.passage.clipboard)), passageClip, 'passage clipboard untouched');
  assert.equal(await page.evaluate(() => SV.passage.takesKey('v')), false);
  // Ctrl+A with a passage selected selects the notes and drops the passage: the next Ctrl+C copies notes.
  await click('Violins 1', 2);
  assert.ok(await selection());
  await ctrl('KeyA');
  assert.equal(await selection(), null, 'Ctrl+A replaces the passage');
  assert.ok(await page.evaluate(() => SV.state.selection.size > 0));
  await ctrl('KeyC');
  assert.equal(JSON.stringify(await page.evaluate(() => SV.passage.clipboard)), passageClip, 'Ctrl+C after Ctrl+A copied notes, not a passage');
  step('note clipboard unchanged');

  const order = await page.evaluate(() => SV.hookOrder());
  assert.ok(order.paperClick.includes('features/passage.js'));
  assert.deepEqual(await page.evaluate(() => SV.shortcuts.conflicts()), []);
  assert.deepEqual(srv.rejected, []);
  assert.deepEqual(errors, []);
  console.log('passage-e2e OK');
} finally {
  if (errors.length) console.log('PAGE ERRORS:\n  ' + errors.join('\n  '));
  await browser.close();
  await srv.close();
}
