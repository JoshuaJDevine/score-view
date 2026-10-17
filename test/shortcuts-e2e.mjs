// The page's shortcut registry (core/shortcuts.js) and toolbar registration (SV.addToolbar opts, features/layout.js):
// no two owners claim the same key in the same context, every module registered its keys, the help lists them, and
// every toolbar group sits in the cluster it asked for, in order.
import assert from 'assert';
import fs from 'fs';
import { withPage } from './lib.mjs';
import { SEL } from './selectors.mjs';

const PORT = Number(process.env.PORT || 8871);
const SHOTS = process.env.SV_SHOTS;

await withPage({ port: PORT }, async ({ page, errors }) => {
  await page.waitForFunction(() => document.querySelector('#svKeys table'), { timeout: 10000 });
  const r = await page.evaluate(() => ({ conflicts: SV.shortcuts.conflicts(), list: SV.shortcuts.list() }));
  assert.deepEqual(r.conflicts, [], 'shortcut clashes: ' + JSON.stringify(r.conflicts));
  const owners = new Set(r.list.map(e => e.owner));
  for (const o of ['core', 'motifs', 'orchestrate', 'entry', 'articulations', 'rhythm', 'harmony', 'mouse', 'playback',
    'controller', 'inspire', 'print'])
    assert.ok(owners.has(o), 'shortcuts registered by ' + o);
  const has = (key, owner, when) => r.list.some(e => e.keys.includes(key) && e.owner === owner && (!when || e.when === when));
  assert.ok(has('Alt+S', 'motifs') && has('Alt+Shift+S', 'motifs'));
  assert.ok(has('Shift+S', 'articulations', 'normal') && has('Shift+A', 'entry', 'entry'));
  assert.ok(has('Escape', 'core', 'normal') && has('Escape', 'entry', 'entry') && has('Escape', 'mouse', 'drag'));
  assert.ok(has('Alt+X', 'orchestrate') && has('Q', 'rhythm') && has('Space', 'playback') && has('Ctrl+P', 'print'));

  // Help: open "Shortcuts ▾"; the table names the contexts and the keys
  await page.click('#helpToggle');
  const help = await page.$eval('#svKeys', el => el.textContent);
  for (const t of ['Everywhere', 'Note entry (N)', 'Score (not in note entry)', 'Sequence up a step', 'play / stop'])
    assert.ok(help.includes(t), 'help shows ' + t);
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: SHOTS + '/pre-shortcuts-help.png' }); }
  await page.click('#helpToggle');

  // Toolbar: every group asked for its cluster explicitly and sits there, ordered by `order`
  const bar = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.svl-cluster > :not(.svl-label)')]; // File / View sit in their menus (compact header)
    return {
      missing: groups.filter(g => !g.dataset.svCluster).map(g => g.id || g.className),
      wrong: groups.filter(g => g.dataset.svCluster && g.closest('.svl-cluster').dataset.k !== g.dataset.svCluster).map(g => g.id),
      orders: [...document.querySelectorAll('.svl-cluster')].map(c =>
        [...c.children].filter(x => !x.classList.contains('svl-label')).map(x => +(x.dataset.svOrder || 1e9))),
      keys: [...document.querySelectorAll('#featureBar > .svl-cluster')].map(c => c.dataset.k),
      menus: { file: !!document.querySelector('#svFilePanel .svl-cluster[data-k="file"]'), view: !!document.querySelector('#svViewPanel .svl-cluster[data-k="view"]') },
    };
  });
  assert.deepEqual(bar.missing, [], 'toolbar groups without a cluster');
  assert.deepEqual(bar.wrong, [], 'toolbar groups in the wrong cluster');
  bar.orders.forEach(o => assert.deepEqual(o, o.slice().sort((a, b) => a - b), 'cluster in order: ' + o));
  assert.deepEqual(bar.keys, ['score', 'write', 'play', 'more'], 'feature bar clusters in order (compact header)');
  assert.deepEqual(bar.menus, { file: true, view: true }, 'File cluster in File ▾, View cluster in View ▾');

  // A late registration with opts lands in its cluster and position; one without opts is guessed (fallback)
  const late = await page.evaluate(async () => {
    const a = SV.addToolbar('<button class="btn" id="tLateA">A</button>', { cluster: 'write', order: 65 });
    const b = SV.addToolbar('<button class="btn" id="tLateB">B</button>', { cluster: 'view' });
    const c = SV.addToolbar('<button class="btn" id="tLateC">C</button>'); // no opts, unknown ids: More
    await new Promise(r => setTimeout(r, 50));
    const prev = a.previousElementSibling, next = a.nextElementSibling;
    const out = { a: a.closest('.svl-cluster').dataset.k, b: b.closest('.svl-cluster').dataset.k, c: c.closest('.svl-cluster').dataset.k,
      prevHasMtf: !!(prev && prev.querySelector('#mtfBtn')), nextHasOrc: !!(next && next.querySelector('#orcBtn')),
      viewHidden: b.closest('.svl-cluster').hidden };
    [a, b, c].forEach(el => el.remove());
    return out;
  });
  assert.deepEqual([late.a, late.b, late.c], ['write', 'view', 'more']);
  assert.ok(late.prevHasMtf && late.nextHasOrc, 'order 65 goes between Motif (60) and Orchestrate (70)');
  assert.equal(late.viewHidden, false, 'the View cluster shows once it has an item');
  const fallback = await page.evaluate(async () => {
    // The old id guess still sorts calls without opts: a group holding a New Score… button goes to File.
    const real = document.getElementById('svwOpen');
    real.id = 'svwOpenReal';
    const i = SV.addToolbar('<button class="btn" id="svwOpen">X</button>');
    await new Promise(r => setTimeout(r, 50));
    const out = i.closest('.svl-cluster').dataset.k;
    i.remove(); real.id = 'svwOpen';
    return out;
  });
  assert.equal(fallback, 'file', 'a call without opts falls back to the id guess');
  assert.deepEqual(errors, []);
  console.log('shortcuts-e2e OK:', r.list.length, 'shortcut entries from', owners.size, 'owners');
});
