// End-to-end smoke test of the core page against the mock server:
// renders the fixture clip, clicks a note, raises it a semitone, checks the edit reached the "clip".
import assert from 'assert';
import { withPage } from './lib.mjs';
import { SEL, MENUS, TOOLS } from './selectors.mjs';

await withPage({ port: Number(process.env.PORT || 8801) }, async ({ page, srv, errors }) => {
  const noteCount = await page.$$eval(SEL.notes, els => els.length);
  assert(noteCount > 50, 'notes rendered: ' + noteCount);

  // Click the first rendered live note and press ArrowUp.
  const id = await page.$eval(SEL.notes, el => el.id);
  const box = await (await page.$('#' + id)).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelector('#paper .sel'), { timeout: 5000 });
  await new Promise(r => setTimeout(r, 500));
  const moves = srv.edits.filter(e => e.startsWith('move'));
  assert.equal(moves.length, 1, 'one move op sent: ' + JSON.stringify(srv.edits));
  assert.match(moves[0], /^move 0 \d+ \d+ 0 1$/);
  assert.deepEqual(errors, []);

  // Toolbar ids are unique (Import… and Instruments ▾ once shared "sviBtn") and each button sits in its cluster.
  const ids = await page.evaluate((importSel, instrSel) => {
    const seen = {}; document.querySelectorAll('[id]').forEach(el => { seen[el.id] = (seen[el.id] || 0) + 1; });
    const cluster = sel => { const el = document.querySelector(sel); const c = el && el.closest('.svl-cluster'); return c ? c.dataset.k : null; };
    return { dups: Object.keys(seen).filter(k => seen[k] > 1), importIn: cluster(importSel), instrIn: cluster(instrSel) };
  }, TOOLS.import, MENUS.instruments.button);
  assert.deepEqual(ids.dups, [], 'duplicate element ids: ' + ids.dups.join(', '));
  assert.equal(ids.importIn, 'file', 'Import… is in the File cluster');
  assert.equal(ids.instrIn, 'score', 'Instruments ▾ is in the Score cluster');
  await page.screenshot({ path: 'test/out-smoke.png' });
  console.log('e2e smoke OK:', noteCount, 'notes; edits', srv.edits);
});
