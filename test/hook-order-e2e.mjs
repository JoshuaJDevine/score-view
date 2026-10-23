// Pins the order in which the shipped feature modules' SV hooks run (registration order = the <script> order in
// web/index.html, then the order inside each module; see web/core/base.js). keydown, noteClick, paperClick and
// paperMouseDown stop at the first handler that returns true, so a reordering changes which module wins a key or a
// click. If you reorder on purpose, update the table below in the same commit.
//   PORT=8871 node test/hook-order-e2e.mjs
import assert from 'assert';
import { withPage } from './lib.mjs';

const port = Number(process.env.PORT || 8871);
const f = name => 'features/' + name + '.js';
const EXPECTED = {
  transformScore: ['notation', 'instruments', 'articulations', 'sections', 'rhythm', 'dynamics', 'harmony', 'entry', 'playback'].map(f),
  buildOptions: ['sections', 'passage', 'musicxml', 'print', 'notation'].map(f),
  afterRender: ['instruments', 'articulations', 'sections', 'sections', 'rhythm', 'dynamics', 'harmony', 'entry', 'mouse', 'passage',
    'playback', 'musicxml', 'layout'].map(f),
  // controller and orchestrate unshift their panel-closing Esc handlers, so an open panel closes before entry mode or
  // the selection sees the Esc; orchestrate's other keys stay in script order. dynamics comes before harmony: with live
  // notes selected H / Shift+H are hairpins (Sibelius), otherwise harmony colours.
  keydown: ['controller', 'orchestrate', 'articulations', 'articulations', 'rhythm', 'dynamics', 'harmony', 'motifs', 'orchestrate', 'entry',
    'mouse', 'mouse', 'passage', 'playback', 'print'].map(f),
  noteClick: ['articulations', 'rhythm', 'entry', 'passage', 'playback'].map(f),
  paperClick: ['rhythm', 'entry', 'passage'].map(f),
  paperMouseDown: ['dynamics', 'mouse'].map(f),
  liveData: ['articulations', 'sections', 'dynamics', 'dynamics', 'dynamics', 'motifs', 'entry', 'passage', 'playback', 'arrangement'].map(f),
  liveSettled: ['dynamics'].map(f),
  play: ['dynamics', 'entry', 'playback', 'notation'].map(f),
  visibleTracks: ['sections'].map(f),
};

await withPage({ port }, async ({ page, errors }) => {
  const got = await page.evaluate(() => SV.hookOrder());
  assert.deepEqual(Object.keys(got).sort(), Object.keys(EXPECTED).sort(), 'hook names');
  for (const name of Object.keys(EXPECTED)) {
    assert.deepEqual(got[name], EXPECTED[name], `SV.hooks.${name} order changed:\n  got      ${got[name].join(', ')}\n  expected ${EXPECTED[name].join(', ')}`);
  }
  console.log('ok   hook order of the shipped modules');

  // The hook lists stay plain arrays (modules use indexOf/splice/unshift); the recording push is not enumerable.
  const plain = await page.evaluate(() => {
    const a = SV.hooks.liveData, fn = () => {};
    const n = a.length;
    a.push(fn);
    const ok = Array.isArray(a) && Object.keys(a).length === n + 1 && a.indexOf(fn) === n;
    a.splice(a.indexOf(fn), 1);
    return ok && SV.hookOrder().liveData.length === n;
  });
  assert.ok(plain, 'hooks are plain arrays');
  assert.deepEqual(errors, []);
  console.log('ok   hooks are plain arrays');
});
console.log('hook-order-e2e OK');
