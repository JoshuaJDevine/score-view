// Paper theme (web/features/theme.js): dark paper with harmony colours on, selection and playhead legible,
// Bitwig dark, persistence across reloads, print view stays white.
// Screenshots: test/out.theme-dark.png, test/out.theme-bitwig.png, test/out.theme-light.png   PORT=8863 node test/theme-e2e.mjs
import assert from 'assert';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';
import { SEL, clickTool } from './selectors.mjs';

const port = Number(process.env.PORT || 8863);
const out = f => path.join(ROOT, 'test', 'out.' + f);
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

// Relative luminance of a computed CSS colour.
const lum = c => {
  const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

await withPage({ port, width: 1500, height: 900 }, async ({ page, srv, errors }) => {
  await page.evaluate(() => { localStorage.removeItem('scoreview.theme.paper'); localStorage.setItem('scoreview.harmony.settings', JSON.stringify({ enabled: true, mode: 'both' })); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.state.render && document.querySelector('#paper .hv-layer'), { timeout: 30000 });
  assert.equal(await page.$eval(SEL.paperSel, s => s.value), 'light');
  await page.screenshot({ path: out('theme-light.png') });

  // Select a note, show a playhead, switch to dark paper.
  const id = await page.$eval(SEL.notes, el => el.id);
  const box = await (await page.$('#' + id)).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  srv.setPlay({ playing: true, step: 24 * 5, pos: 5 });
  await page.select(SEL.paperSel, 'dark');
  await settle(600);
  const st = await page.evaluate(() => {
    const cs = el => getComputedStyle(el);
    const paper = cs(document.getElementById('paper')).backgroundColor;
    const plain = [...document.querySelectorAll('#paper g.note')].find(n => !n.getAttribute('fill') && !n.classList.contains('sel') && !n.classList.contains('play'));
    const coloured = [...document.querySelectorAll('#paper g.note[fill]')].filter(n => !n.classList.contains('sel') && !n.classList.contains('play'));
    const sel = document.querySelector('#paper g.note.sel');
    const play = document.querySelector('#paper .play');
    const staffLine = document.querySelector('#paper g.staff > path');
    return {
      cls: document.documentElement.className, paper,
      ink: cs(plain ? (plain.querySelector('use') || plain) : document.querySelector('#paper g.clef use') || document.querySelector('#paper g.clef')).fill,
      line: staffLine ? cs(staffLine).stroke : null,
      colouredFills: [...new Set(coloured.map(n => cs(n).fill))],
      colouredAttrs: [...new Set(coloured.map(n => n.getAttribute('fill')))],
      sel: sel ? cs(sel.querySelector('use') || sel).fill : null,
      play: play ? cs(play.querySelector('use') || play).fill : null,
    };
  });
  console.log('dark paper:', st);
  assert.match(st.cls, /svp-dark/);
  assert.ok(lum(st.paper) < 0.05, 'paper is dark');
  assert.ok(contrast(st.ink, st.paper) > 10, 'ink on paper contrast ' + contrast(st.ink, st.paper).toFixed(1));
  assert.ok(contrast(st.line, st.paper) > 7, 'staff lines legible');
  assert.ok(st.colouredFills.length >= 2, 'harmony colours present');
  st.colouredFills.forEach(c => assert.ok(contrast(c, st.paper) >= 4.5, `harmony colour ${c} contrast ${contrast(c, st.paper).toFixed(1)} on dark paper`));
  assert.ok(st.sel && contrast(st.sel, st.paper) > 7, 'selected note legible: ' + st.sel);
  if (st.play) assert.ok(contrast(st.play, st.paper) > 7, 'playhead note legible: ' + st.play);
  await page.screenshot({ path: out('theme-dark.png') });

  await page.select(SEL.paperSel, 'bitwig');
  await settle();
  const bw = await page.evaluate(() => ({ cls: document.documentElement.className, paper: getComputedStyle(document.getElementById('paper')).backgroundColor }));
  assert.match(bw.cls, /svp-bitwig/);
  assert.ok(bw.paper !== st.paper && lum(bw.paper) < 0.05, 'Bitwig grey paper: ' + bw.paper);
  await page.screenshot({ path: out('theme-bitwig.png') });

  // Persisted; the print view keeps white paper.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.SV && SV.state.render, { timeout: 30000 });
  assert.equal(await page.$eval(SEL.paperSel, s => s.value), 'bitwig');
  assert.match(await page.evaluate(() => document.documentElement.className), /svp-dark svp-bitwig|svp-bitwig/);
  await clickTool(page, 'print');
  await page.waitForSelector(SEL.print.page + ' svg');
  const pr = await page.evaluate(() => {
    const pg = document.querySelector('.svp-page');
    const n = pg.querySelector('g.note use') || pg.querySelector('g.note');
    return { bg: getComputedStyle(pg).backgroundColor, note: getComputedStyle(n).fill };
  });
  console.log('print view in dark theme:', pr);
  assert.equal(pr.bg, 'rgb(255, 255, 255)');
  assert.equal(pr.note, 'rgb(0, 0, 0)');
  srv.setPlay({ playing: false, step: -1, pos: 0 });
  assert.equal(errors.length, 0, errors.join('\n'));
});
console.log('theme e2e ok');
