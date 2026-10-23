// Browser test of the harmony module: H / Shift+H, noteheads + bands + ribbon on the Mega Man 2 export,
// aim assist (Alt+Shift+↑) on a live note, SV.harmony API.   PORT=8852 node test/harmony-e2e.mjs
import assert from 'assert';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';

const port = Number(process.env.PORT || 8852);
const out = f => path.join(ROOT, 'test', f);
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));
const waitRender = page => page.waitForFunction(() => window.SV && SV.state.render && document.querySelector('#paper svg'), { timeout: 30000 });

// 1) Clip mode: H toggles, live note aim assist.
await withPage({ port, width: 1500, height: 900 }, async ({ page, srv, errors }) => {
  await page.evaluate(() => localStorage.removeItem('scoreview.harmony.settings'));
  await page.focus('#main');
  await page.keyboard.press('h');
  await page.waitForFunction(() => document.querySelector('#paper .hv-layer'), { timeout: 10000 });
  const st = await page.evaluate(() => ({
    enabled: SV.harmony.enabled(),
    coloured: [...document.querySelectorAll('#paper g.note')].filter(n => n.getAttribute('fill') || n.getAttribute('color')).length,
    notes: document.querySelectorAll('#paper g.note').length,
    dirs: document.querySelectorAll('#paper g.dir').length,
    regions: SV.harmony.regions().length,
  }));
  console.log('clip mode:', st);
  assert(st.enabled && st.coloured > st.notes * 0.8 && st.dirs > 3 && st.regions > 3);

  // Shift+H cycles the view.
  const m0 = await page.evaluate(() => SV.harmony.settings().mode);
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyH'); await page.keyboard.up('Shift');
  await settle();
  const m1 = await page.evaluate(() => SV.harmony.settings().mode);
  assert.notEqual(m0, m1, 'Shift+H cycles mode');
  await page.evaluate(() => SV.harmony.set({ mode: 'both' }));
  await settle();

  // Aim assist: select a live note and press Alt+Shift+Up.
  const id = await page.$eval('#paper g.note', el => el.id);
  const box = await (await page.$('#' + id)).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const expect = await page.evaluate(() => {
    const sid = [...SV.state.selection][0], { y } = SV.parseId(sid);
    const beat = SV.state.render.bySrc.get(sid)[0].start;
    return { y, to: SV.harmony.nextChordTone(y, beat, 1), chord: SV.harmony.chordAt(beat) };
  });
  srv.edits.length = 0;
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await settle(600);
  const moves = srv.edits.filter(e => e.startsWith('move'));
  console.log('aim assist:', expect.y, '->', expect.to, 'in', expect.chord && expect.chord.roman, moves);
  assert.equal(moves.length, 1);
  assert.equal(Number(moves[0].split(' ')[5]), expect.to - expect.y);
  assert.equal(await page.evaluate(() => SV.harmony.snap(61, 0.1, 'chord') % 1), 0);
  await page.screenshot({ path: out('out-harmony-clip.png') });
  assert.deepEqual(errors, []);
});

// 2) Score mode, Mega Man 2 export: all tracks / whole song, and a pinned subset.
await withPage({ port, width: 1600, height: 1000, mode: 'score' }, async ({ page, errors }) => {
  await page.evaluate(() => {
    localStorage.setItem('scoreview.trackMode2', JSON.stringify('all'));
    localStorage.setItem('scoreview.range', JSON.stringify('all'));
    localStorage.setItem('scoreview.harmony.settings', JSON.stringify({ enabled: true, mode: 'both', ribbon: true, marks: true }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitRender(page);
  await (await page.$('#fileInput')).uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => SV.state.base && document.querySelectorAll('#paper g.measure').length > 100, { timeout: 60000 });
  await settle(800);
  const timing = await page.evaluate(() => {
    const t = [];
    for (const on of [false, true, true]) {
      SV.harmony.set({ enabled: on });
      const t0 = performance.now(); SV.render(); t.push(Math.round(performance.now() - t0));
    }
    const a = SV.harmony.analysis();
    return { renderOff: t[0], renderOn: t[1], renderOnCached: t[2], analysisMs: Math.round(a.ms), regions: a.regions.length,
             home: a.homeName, overlayMs: Math.round(SV.harmony.stats().overlayMs), bands: document.querySelectorAll('#paper .hv-bands rect').length };
  });
  console.log('Mega Man 2 all tracks:', timing);
  assert(timing.analysisMs < 100, 'analysis ' + timing.analysisMs + ' ms');
  assert(timing.bands > 50);
  await page.screenshot({ path: out('out-harmony-mm2-all.png') });

  // A readable subset: strings + bassoons, whole song.
  await page.evaluate(() => {
    localStorage.setItem('scoreview.pinned', JSON.stringify(['Violin 1', 'Violin 2', 'Viola', 'Cello', 'Bass', 'Basoons a3']));
    localStorage.setItem('scoreview.trackMode2', JSON.stringify('pinned'));
  });
  await page.evaluate(() => { SV.state.trackMode = 'pinned'; ['Violin 1', 'Violin 2', 'Viola', 'Cello', 'Bass', 'Basoons a3'].forEach(n => SV.state.pinned.add(n)); SV.render(); });
  await settle(800);
  await page.screenshot({ path: out('out-harmony-mm2-strings.png') });
  await page.evaluate(() => { document.getElementById('main').scrollTop = 1700; });
  await settle(300);
  await page.screenshot({ path: out('out-harmony-mm2-strings-2.png') });
  for (const mode of ['notes', 'bands']) {
    await page.evaluate(m => { document.getElementById('main').scrollTop = 0; SV.harmony.set({ mode: m }); }, mode);
    await settle(500);
    await page.screenshot({ path: out('out-harmony-mm2-' + mode + '.png'), clip: { x: 0, y: 60, width: 1600, height: 640 } });
  }
  await page.evaluate(() => { SV.harmony.set({ mode: 'both' }); document.querySelector('#hvLegendBtn').click(); });
  await settle(300);
  await page.screenshot({ path: out('out-harmony-legend.png') });
  assert.deepEqual(errors, []);
});
console.log('harmony e2e OK');
