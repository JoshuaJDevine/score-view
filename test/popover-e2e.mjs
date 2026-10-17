// Popover closing and engraving placement fixes (wave 1d):
//  B2  Orchestrate and Controller panels close on Esc and on a press outside; with "Stay open while I select notes"
//      (default on) a press in the score keeps Orchestrate open; a click that did not start on a Learn button never
//      starts MIDI Learn.
//  B4  With harmony on, the roman numeral at bar 1 does not overlap the tempo mark or the rehearsal mark.
//  Tokens: web/style.css is linked, the old CSS names resolve through the --sv-* tokens, chrome/density preferences.
// Usage: PORT=8870 node test/popover-e2e.mjs   (uses PORT and PORT+1)
import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { withPage } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8870);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const visible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && !e.classList.contains('hidden'); }, sel);

await withPage({ port: PORT, width: 1440, height: 900, mode: 'clip' }, async ({ page }) => {
  // ---- tokens
  const tok = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { link: !!document.querySelector('link[rel=stylesheet][href="style.css"]'), inline: document.querySelectorAll('head > style').length,
             bar: cs.getPropertyValue('--bar').trim(), accent: cs.getPropertyValue('--accent').trim(),
             h: document.getElementById('orcBtn').getBoundingClientRect().height, chrome: document.documentElement.dataset.chrome };
  });
  assert(tok.link, 'style.css linked');
  assert.equal(tok.bar, getVar('--sv-surface-1'), 'old --bar resolves to the token');
  assert.equal(tok.accent, '#ff7a1a');
  assert.equal(tok.h, 28, 'control height 28px');
  assert.equal(tok.chrome, 'dark');
  await page.evaluate(() => SV.theme.setDensity('compact'));
  assert.equal(await page.evaluate(() => document.getElementById('orcBtn').getBoundingClientRect().height), 24, 'compact: 24px');
  await page.evaluate(() => { SV.theme.setDensity('normal'); SV.theme.setChrome('light'); });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(226, 223, 216)', 'light chrome desk');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.theme.chrome'))), 'light', 'chrome saved');
  await page.evaluate(() => SV.theme.setChrome('dark'));

  // ---- Orchestrate: Esc with focus in the score, outside press, press in the score (stay open), pref off
  await page.click('#orcBtn');
  assert(await visible(page, '#orcPanel'), 'orchestrate opens');
  await page.focus('#main');
  await page.keyboard.press('Escape');
  assert(!await visible(page, '#orcPanel'), 'Esc closes orchestrate (focus in the score)');
  await page.click('#orcBtn');
  await page.click('#orcPanel #orcFrom');
  await page.keyboard.press('Escape');
  assert(!await visible(page, '#orcPanel'), 'Esc closes orchestrate (focus in the panel)');
  await page.click('#orcBtn');
  // a note clear of the panel (where the panel sits depends on the header layout)
  const note = await page.evaluate(() => [...document.querySelectorAll('#paper g.note')].find(el => {
    const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit && hit.closest('g.note') === el;
  }).id);
  await page.click('#' + note);
  await sleep(150);
  assert(await visible(page, '#orcPanel'), 'a press in the score keeps orchestrate open (stay-open default)');
  { // mid-drag, Esc cancels the note drag (mouse.js) and leaves the panel open; the next Esc closes it
    const nb = await (await page.$('#' + note)).boundingBox();
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.mouse.down();
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2 - 20, { steps: 4 });
    await page.keyboard.press('Escape');
    assert(await visible(page, '#orcPanel'), 'Esc during a drag in the score leaves orchestrate open');
    await page.mouse.up();
    await page.keyboard.press('Escape');
    assert(!await visible(page, '#orcPanel'), 'the next Esc closes orchestrate');
    await page.click('#orcBtn');
  }
  await page.click('#helpToggle');
  assert(!await visible(page, '#orcPanel'), 'a press outside closes orchestrate');
  await page.click('#helpToggle');
  await page.click('#orcBtn');
  await page.click('#orcStay');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.orchestrate.prefs')).stayOpen), false, 'pref saved');
  await page.click('#' + note);
  assert(!await visible(page, '#orcPanel'), 'stay-open off: a press in the score closes orchestrate');
  await page.click('#orcBtn');
  await page.click('#orcStay'); // back on
  await page.click('#orcBtn');
  assert(!await visible(page, '#orcPanel'), 'the toolbar button toggles it closed');

  // ---- Controller: stray click, Esc, outside press
  await page.click('#svc-open');
  assert(await page.$('#svc-panel'), 'controller opens');
  const learn = await page.$('#svc-panel tr[data-a="rest"] button[data-k="learn"]');
  const b = await learn.boundingBox();
  await page.mouse.move(b.x - 300, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.up();
  await sleep(100);
  assert(await page.evaluate(() => !SV.controller.state.learn), 'a click that started elsewhere does not start Learn');
  await page.click('#svc-panel tr[data-a="rest"] button[data-k="learn"]');
  assert(await page.evaluate(() => SV.controller.state.learn && SV.controller.state.learn.action === 'rest'), 'a real click starts Learn');
  await page.keyboard.press('Escape');
  assert(await page.evaluate(() => !SV.controller.state.learn) && await page.$('#svc-panel'), 'first Esc cancels Learn, panel stays');
  await page.keyboard.press('Escape');
  assert(!await page.$('#svc-panel'), 'second Esc closes the controller panel');
  await page.click('#svc-open');
  await page.focus('#svc-panel select[data-k="port"]');
  await page.keyboard.press('Escape');
  assert(!await page.$('#svc-panel'), 'Esc closes it with focus on its device menu');
  await page.click('#svc-open');
  await page.mouse.click(40, 600); // the score, left of the panel
  assert(!await page.$('#svc-panel'), 'a press outside closes the controller panel');
  assert(await page.evaluate(() => !SV.controller.state.learn), 'and never starts Learn');
});

function getVar(name) { return ({ '--sv-surface-1': '#222222' })[name]; }

// ---- B4: roman numeral vs tempo mark at bar 1 (score mode, Mega Man 2, harmony on)
await withPage({ port: PORT + 1, width: 1440, height: 900, mode: 'score', fixture: path.join(ROOT, 'test/fixtures/live-bass.json') }, async ({ page }) => {
  await (await page.$('#fileInput')).uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => window.SV.state.base && document.querySelector('#svSectionSeg button[data-section="Strings"]'), { timeout: 30000 });
  await page.click('#svSectionSeg button[data-section="Strings"]');
  await sleep(1500);
  await page.click('#main');
  await page.keyboard.press('h');
  await page.waitForFunction(() => document.querySelector('#paper .hv-layer'), { timeout: 15000 });
  await sleep(500);
  const r = await page.evaluate(() => {
    const m1 = document.querySelector('#paper g.measure#m1') || document.querySelector('#paper g.measure');
    const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const marks = [...m1.querySelectorAll(':scope > g.tempo, :scope > g.reh')].map(box);
    const labels = [...m1.querySelectorAll(':scope > g.dir')].filter(d => d.getAttribute('fill')).map(box);
    const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    const svgTop = document.querySelector('#paper svg').getBoundingClientRect().top;
    return { marks: marks.length, labels: labels.length, overlaps: labels.filter(l => marks.some(m => hit(l, m))).length,
             clipped: labels.filter(l => l.t < svgTop).length };
  });
  assert(r.marks >= 1, 'bar 1 has a tempo/rehearsal mark: ' + JSON.stringify(r));
  assert(r.labels >= 1, 'bar 1 has a roman numeral: ' + JSON.stringify(r));
  assert.equal(r.overlaps, 0, 'roman numeral clear of the tempo and rehearsal marks: ' + JSON.stringify(r));
  assert.equal(r.clipped, 0, 'roman numeral inside the engraving (not cut off at the top): ' + JSON.stringify(r));
  await page.screenshot({ path: path.join(ROOT, 'test/out.popover-harmony-bar1.png'), clip: { x: 0, y: 200, width: 700, height: 300 } });
});
console.log('popover-e2e OK');
