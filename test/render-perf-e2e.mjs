// Render cost guards on the full Mega Man 2 score (the saved crawl, all 23 parts in Score view, solo / mute zones on
// every staff as with Bitwig's track list):
// * Glyph inlining (web/core/svg-inline.js via core/render.js): rendered with Verovio's glyph <use>s and with inline
//   <path>s it must look the same. Screenshots of three places in the score are compared pixel by pixel in the page
//   (canvas); test/out.svg-inline-<place>-{use,inline}.png are written for looking at them side by side.
// * Layout thrash: one render forces only a handful of layouts (the afterRender hooks measure first, then write;
//   playback.js used to append a zone between staff measurements: hundreds of layouts).
// Timings are not asserted (machines differ); node tools/perf-bench.mjs reports them.
//   PORT=8871 node test/render-perf-e2e.mjs
import fs from 'fs';
import assert from 'assert/strict';
import { withPage, ROOT } from './lib.mjs';

const PORT = Number(process.env.PORT || 8871);
const crawl = JSON.parse(fs.readFileSync(ROOT + '/test/fixtures/crawl-megaman2.json', 'utf8'));
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); } };

await withPage({ port: PORT, width: 1400, height: 900 }, async ({ page, errors, srv }) => {
  srv.setData({ tracks: crawl.tracks.map((t, index) => ({ index, name: t.name, group: !!t.group, solo: false, mute: false, sel: t.name === srv.state.data.track })) });
  await page.waitForFunction(n => SV.state.liveData && SV.state.liveData.tracks.length === n, {}, crawl.tracks.length);
  await page.evaluate(c => {
    SV.state.crawl = c;
    SV.setBase(SV.arrangement.crawlToScore(c, { title: 'Mega Man 2' }), Date.now());
    SV.core.setScoreShow('all');
    SV.core.setMode('score');
  }, crawl);

  // Renders with inlining on or off, then screenshots the score at each scroll place (fractions of its height).
  const PLACES = { top: 0, middle: 0.45, end: 0.9 };
  async function shots(inline) {
    const info = await page.evaluate(async on => {
      SV.core.store.set('inlineGlyphs', on);
      SV.core.render();
      await SV.rendered(); // a big score's chunks are engraved in the workers
      const p = document.getElementById('paper');
      return { uses: p.getElementsByTagName('use').length, symbols: p.getElementsByTagName('symbol').length,
        notes: p.querySelectorAll('g.note').length, times: SV.state.render.times };
    }, inline);
    const out = {};
    for (const [name, f] of Object.entries(PLACES)) {
      await page.evaluate(f => { const m = document.getElementById('main'); m.scrollTop = Math.round((m.scrollHeight - m.clientHeight) * f); }, f);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const file = `${ROOT}/test/out.svg-inline-${name}-${inline ? 'inline' : 'use'}.png`;
      const main = await page.$('#main');
      out[name] = { file, b64: await main.screenshot({ path: file, encoding: 'base64' }) };
      fs.writeFileSync(file, Buffer.from(out[name].b64, 'base64'));
    }
    // (solo / mute zones go into a system when it is first shown: counted after scrolling through)
    info.zones = await page.evaluate(() => document.querySelectorAll('#paper .svpb-sm').length);
    return { info, out };
  }

  const before = await shots(false);
  const after = await shots(true);
  console.log('      glyph <use>s ' + before.info.uses + ' -> ' + after.info.uses + '; render times with inlining ' + JSON.stringify(after.info.times));

  check('the off switch keeps the <use>s; inlining removes every <use> and <symbol>', () => {
    assert.ok(before.info.uses > 10000, 'a full score has thousands of glyphs (' + before.info.uses + ')');
    assert.equal(after.info.uses, 0);
    assert.equal(after.info.symbols, 0);
  });
  check('same notes and solo / mute zones either way', () => {
    assert.equal(after.info.notes, before.info.notes);
    assert.equal(after.info.zones, before.info.zones);
    assert.ok(after.info.zones > 10, 'a zone per staff on each system shown (' + after.info.zones + ')');
  });

  for (const name of Object.keys(PLACES)) {
    const diff = await page.evaluate(async (a, b) => {
      const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const px = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
      const da = px(ia), db = px(ib);
      if (da.length !== db.length) return { size: true };
      let bad = 0, ink = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        if (d > 64) bad++;
        if (da[i] < 128) ink++;
      }
      return { bad, ink, total: da.length / 4 };
    }, before.out[name].b64, after.out[name].b64);
    check(`pixel comparison at the ${name} of the score (${diff.bad} of ${diff.total} pixels differ; ${diff.ink} dark)`, () => {
      assert.ok(!diff.size, 'same screenshot size');
      assert.ok(diff.ink > 5000, 'the screenshot shows notation');
      assert.ok(diff.bad <= diff.ink * 0.002, 'at most 0.2 % of the inked pixels differ (anti-aliasing)');
    });
  }

  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const layouts = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'LayoutCount').value;
  const l0 = await layouts();
  const zones = await page.evaluate(() => { SV.core.render(); return document.querySelectorAll('#paper .svpb-sm').length; });
  const forced = (await layouts()) - l0;
  check(`one full-score render forces few layouts (${forced}; ${zones} solo / mute zones)`, () => {
    assert.ok(zones > 100, 'a zone per staff on every system');
    assert.ok(forced <= 20, 'at most 20 layouts');
  });
  check('no page errors', () => assert.deepEqual(errors, []));
});

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('render-perf-e2e: all passed');
