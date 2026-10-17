// End-to-end test of rhythm readings: live triplets render as tuplets; Q / Shift+Q cycle the bar's reading.
//   PORT=8832 node test/rhythm-e2e.mjs
import assert from 'assert';
import { withPage } from './lib.mjs';

const notes = [];
const scale = [72, 74, 76, 77, 79, 81, 83, 84];
for (let i = 0; i < 12; i++) notes.push({ ch: 0, x: i * 8, y: scale[i % 8], d: 1 / 3, vel: 100, sel: false }); // bar 1: 8th triplets
for (let i = 0; i < 8; i++) notes.push({ ch: 0, x: 96 + i * 12, y: scale[i], d: 0.5, vel: 100, sel: false }); // bar 2: 8ths

await withPage({ port: Number(process.env.PORT || 8832) }, async ({ page, srv, errors }) => {
  await page.evaluate(() => localStorage.removeItem('scoreview.rhythm.Violin 1'));
  srv.setData({ length: 8, loopLength: 8 });
  srv.setNotes(notes);
  const tuplets = () => page.$$eval('#paper g.tuplet', els => els.length);
  await page.waitForFunction(() => document.querySelectorAll('#paper g.tuplet').length === 4, { timeout: 10000 });

  // Select the first note (bar 1), press Q: straight 16ths -> no tuplets.
  const box = await (await page.$('#paper g.note')).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const flash = () => page.$eval('#flash', el => el.textContent);
  await page.keyboard.press('q');
  await page.waitForFunction(() => document.querySelectorAll('#paper g.tuplet').length === 0, { timeout: 5000 });
  assert.equal(await flash(), 'Bar 1: straight 16ths');
  assert.ok(await page.$('#m1s1.sv-reading'), 'bar 1 is marked');
  await page.keyboard.press('q');
  await page.waitForFunction(() => document.querySelectorAll('#paper g.tuplet').length === 4, { timeout: 5000 });
  assert.equal(await flash(), 'Bar 1: triplet reading');
  const stored = await page.evaluate(() => localStorage.getItem('scoreview.rhythm.Violin 1'));
  assert.equal(stored, '{"1":2}');
  await page.keyboard.down('Shift'); await page.keyboard.press('Q'); await page.keyboard.up('Shift');
  await page.waitForFunction(() => document.querySelectorAll('#paper g.tuplet').length === 0, { timeout: 5000 });
  await page.keyboard.down('Shift'); await page.keyboard.press('Q'); await page.keyboard.up('Shift');
  await page.waitForFunction(() => document.querySelectorAll('#paper g.tuplet').length === 4, { timeout: 5000 });
  assert.equal(await flash(), 'Bar 1: automatic reading (reset)');
  assert.equal(await page.evaluate(() => localStorage.getItem('scoreview.rhythm.Violin 1')), null);
  assert.equal(await tuplets(), 4);
  assert.deepEqual(srv.edits.filter(e => !/^(select|audition) /.test(e)), [], 'readings never edit the clip');
  await page.screenshot({ path: 'test/out.rhythm-e2e.png' });
  assert.deepEqual(errors, []);
  console.log('rhythm e2e OK');
});
