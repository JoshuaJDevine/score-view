// Visual test for web/features/instruments.js: engraves the Mega Man 2 fixture through the module's
// transformScore hook (loaded with a fake window.SV) in concert and transposed mode with ranges on.
//   node test/instruments-visual.mjs   -> test/out-instruments-{concert,transposed,ranges}.png
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { ROOT, ScoreBuilder, loadFixtureScore, renderMEI, screenshotSvg } from './lib.mjs';

function loadModule(settings) {
  const store = new Map(Object.entries(settings).map(([k, v]) => ['scoreview.instruments.' + k, JSON.stringify(v)]));
  const window = {
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) },
    SV: { hooks: { transformScore: [], afterRender: [] }, state: {} },
  };
  new Function('window', 'module', fs.readFileSync(path.join(ROOT, 'web/features/instruments.js'), 'utf8'))(window, undefined);
  assert(window.SV.instruments, 'SV.instruments exposed');
  assert.equal(window.SV.hooks.transformScore.length, 1, 'transformScore hook registered');
  return window.SV;
}

const base = await loadFixtureScore();
const BARS = 12;
const mb = base.timeSig.num * 4 / base.timeSig.den;
// [output name, transposed?, first bar] -- bar 64 has flutes above their range (red) and bass trombones high (orange)
const RUNS = [["concert", false, 8], ["transposed", true, 8], ["ranges", false, 64]];
function scoreFor(bar) {
  const START = bar * mb;
  return {
    title: base.title, timeSig: base.timeSig, keyFifths: null, lengthBeats: BARS * mb, measureOffset: bar,
    parts: base.parts.map(p => ({
      name: p.name, group: p.group,
      notes: p.notes.filter(n => n.pitch >= 24 && n.start >= START && n.start < START + BARS * mb)
        .map(n => ({ ...n, start: n.start - START })),
    })),
  };
}

for (const [mode, transposed, bar] of RUNS) {
  const SV = loadModule({ transposed, ranges: true, names: true });
  let score = scoreFor(bar);
  SV.hooks.transformScore.forEach(fn => { score = fn(score, {}) || score; });
  score.parts.forEach(p => console.log(mode.padEnd(10), p.name.padEnd(18), '->', (p.label || '').padEnd(22),
    JSON.stringify(p.clef || (p.grand ? 'grand' : 'auto')).padEnd(14), 'tr', p.transpose || 0,
    'out-of-range', p.notes.filter(n => n.color).length));
  const built = ScoreBuilder.buildMEI(score, { grid: 2 });
  const { svg } = await renderMEI(built.mei, { pageWidth: 2600, scale: 35, condense: 'auto', condenseFirstPage: true });
  const out = path.join(ROOT, `test/out-instruments-${mode}.png`);
  await screenshotSvg(svg, out, { width: 1300, height: 900 });
  console.log('wrote', out);
}
