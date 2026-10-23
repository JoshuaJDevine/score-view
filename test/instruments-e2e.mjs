// Browser test for web/features/instruments.js against the mock server (clip mode, "Violin 1" live clip):
// instrument label, clicking the staff name opens the picker, an override changes the clef and persists.
//   PORT=8822 node test/instruments-e2e.mjs   -> test/out-instruments-e2e.png
import assert from 'assert';
import { withPage } from './lib.mjs';
import { SEL, openMenu, clickTool } from './selectors.mjs';

await withPage({ port: Number(process.env.PORT || 8822) }, async ({ page, errors }) => {
  await page.evaluate(() => localStorage.removeItem('scoreview.instruments.overrides'));
  assert(await page.evaluate(() => !!(window.SV.instruments && SV.instruments.lookup('Violin 1', 'Strings').id === 'violin')));
  const labelText = () => page.$eval(SEL.staffLabel, el => el.textContent.trim());
  assert.equal(await labelText(), 'Violins I');
  assert.equal(await page.evaluate(() => SV.state.render.staves[0].clef.shape), 'G');

  // Click the staff name -> picker; choose Viola.
  const box = await (await page.$(SEL.staffLabel)).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector(SEL.instruments.pickerInput, { timeout: 3000 });
  await page.type(SEL.instruments.pickerInput, 'viola');
  await page.screenshot({ path: 'test/out-instruments-picker.png' });
  await page.click(SEL.instruments.pick('viola'));
  await page.waitForFunction(() => SV.state.render.staves[0].clef.shape === 'C', { timeout: 5000 });
  assert.equal(await labelText(), 'Violas I', 'override relabels; section number comes from the track name');
  const ov = await page.evaluate(() => JSON.parse(localStorage.getItem('scoreview.instruments.overrides')));
  assert.deepEqual(ov, { 'Violin 1': 'viola' });

  // Toggles: track names, transposed (no-op for strings), ranges.
  await clickTool(page, 'instrumentNames');
  await page.waitForFunction(sel => document.querySelector(sel).textContent.includes('Violin 1'), {}, SEL.staffLabel);
  await clickTool(page, 'instrumentNames');
  await clickTool(page, 'ranges');
  await page.evaluate(() => SV.instruments.setOverride('Violin 1', null));
  await page.waitForFunction(() => SV.state.render.staves[0].clef.shape === 'G');

  // Toolbar panel lists every track with its pin and instrument; ticking 📌 pins the track.
  await openMenu(page, 'instruments');
  await page.waitForSelector(SEL.instruments.row);
  const row = await page.$eval('.svi-row[data-part="Violin 1"]', el => el.textContent);
  assert.match(row, /Violin 1.*selected.*Violin/);
  await page.click('.svi-row[data-part="Viola"] input[data-pin]');
  assert.ok(await page.evaluate(() => SV.state.pinned.has('Viola')), 'ticking 📌 pins the track');
  await page.click('.svi-row[data-part="Viola"] input[data-pin]');
  assert.ok(!(await page.evaluate(() => SV.state.pinned.has('Viola'))), 'and unpins it');
  await page.screenshot({ path: 'test/out-instruments-e2e.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { localStorage.removeItem('scoreview.instruments.ranges'); });
  assert.deepEqual(errors, []);
  console.log('instruments e2e OK');
});
