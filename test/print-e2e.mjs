// Print / PDF (web/features/print.js) on the Mega Man 2 export (score mode, all tracks, whole song):
// full score pages on A4 portrait, a Violin 1 part, Letter landscape; page numbers "n / N"; the @media print layout
// is checked with page.pdf() (PDF page count = print view pages). Screenshots: test/out.print-*.png
//   PORT=8862 node test/print-e2e.mjs
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';
import { clickIn } from './selectors.mjs';

const port = Number(process.env.PORT || 8862);
const out = f => path.join(ROOT, 'test', 'out.' + f);
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));
const pdfPages = buf => (Buffer.from(buf).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

await withPage({ port, fixture: path.join(ROOT, 'test/fixtures/live-bass.json'), mode: 'score', width: 1400, height: 1000 }, async ({ page, errors }) => {
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('scoreview.print.')) localStorage.removeItem(k); });
  await (await page.$('#fileInput')).uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => SV.state.base && SV.state.render, { timeout: 30000 });
  await page.evaluate(() => { SV.state.trackMode = 'all'; SV.render(); });
  await page.waitForFunction(() => SV.state.render.score.parts.length >= 20);

  await clickIn(page, '#svpPrintBtn');
  await page.waitForSelector('#svPrint .svp-page');
  const set = (id, v) => page.evaluate((id, v) => {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = v; else el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { pages: document.querySelectorAll('#svPrintPages .svp-page').length, info: document.getElementById('svpInfo').textContent, last: SV.print.last && SV.print.last.pages, ms: SV.print.last && JSON.stringify(SV.print.last.ms, (k, v) => typeof v === 'number' ? Math.round(v) : v) };
  }, id, v);
  await set('svpComposer', 'Takashi Tateishi');
  const full = await set('svpWhole', '1');
  console.log('full score:', full);
  assert.ok(full.pages >= 8 && full.pages === full.last, 'whole song full score paginates over several pages');
  const p1 = await page.evaluate(() => {
    const pg = document.querySelector('.svp-page'), r = pg.getBoundingClientRect();
    const txt = s => [...pg.querySelectorAll(s + ' text')].map(t => t.textContent.replace(/\s+/g, ' ').trim()).join(' | ');
    return { w: r.width, h: r.height, head: txt('g.pgHead'), foot: txt('g.pgFoot'), parts: SV.print.last.opts.part, staves: pg.querySelectorAll('g.staff').length };
  });
  console.log('page 1:', p1);
  assert.ok(Math.abs(p1.w / p1.h - 210 / 297) < 0.01, 'A4 portrait aspect');
  assert.match(p1.head, /megaman2/);
  assert.match(p1.head, /Takashi Tateishi/);
  assert.match(p1.foot, new RegExp('1 / ' + full.pages));
  await page.screenshot({ path: out('print-score.png') });
  const lastFoot = await page.$eval('.svp-page:last-child', pg => [...pg.querySelectorAll('g.pgFoot text')].map(t => t.textContent).join(' '));
  assert.match(lastFoot, new RegExp(full.pages + ' / ' + full.pages), 'last page numbered');

  // The printed document: only the pages, one per sheet.
  await page.emulateMediaType('print');
  const visible = await page.evaluate(() => ({ header: getComputedStyle(document.querySelector('header')).display, bar: getComputedStyle(document.querySelector('.svp-bar')).display }));
  assert.deepEqual(visible, { header: 'none', bar: 'none' }, 'app chrome hidden when printing');
  await page.screenshot({ path: out('print-media.png') });
  await page.emulateMediaType(null); // back to the default (page.pdf() then uses print media)

  // One part: Violin 1, bigger staff, written pitch default for parts.
  const part = await set('svpPart', 'Violin 1');
  console.log('Violin 1 part:', part);
  assert.ok(part.pages >= 1 && part.pages < full.pages);
  const ph = await page.evaluate(() => [...document.querySelectorAll('.svp-page:first-child g.pgHead text')].map(t => t.textContent.trim()).join(' | '));
  assert.match(ph, /Violins I/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.svp-page:first-child g.staff').length > 0 &&
    new Set([...document.querySelectorAll('.svp-page g.staff')].map(s => s.closest('g.measure').querySelectorAll(':scope > g.staff').length)).size), 1, 'one staff per system');
  await page.screenshot({ path: out('print-part.png') });
  const ppdf = await page.pdf({ preferCSSPageSize: true, timeout: 180000 });
  fs.writeFileSync(out('print-part.pdf'), ppdf);
  console.log('part PDF pages:', pdfPages(ppdf));
  assert.equal(pdfPages(ppdf), part.pages, 'part PDF page count');

  // Letter landscape.
  await set('svpPaper', 'letter');
  const land = await set('svpOrient', 'landscape');
  const r = await page.$eval('.svp-page', pg => { const b = pg.getBoundingClientRect(); return b.width / b.height; });
  console.log('Letter landscape:', land, 'aspect', r.toFixed(3));
  assert.ok(Math.abs(r - 279.4 / 215.9) < 0.01, 'Letter landscape aspect');
  await page.screenshot({ path: out('print-landscape.png') });

  // Close returns to the score.
  await page.click('#svpClose');
  assert.equal(await page.$('#svPrint'), null);
  assert.equal(errors.length, 0, errors.join('\n'));
});
console.log('print e2e ok');
