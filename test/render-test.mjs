// Renders a synthetic multi-part score through score.js + Verovio to test/out.svg.
import { createRequire } from 'module';
import fs from 'fs';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';

const require = createRequire(import.meta.url);
const SB = require('../web/score.js');

let id = 0;
const N = (start, dur, pitch) => ({ id: '0_' + (id++) + '_' + pitch, start, dur, pitch });
const melody = [
  N(0, 1, 76), N(1, 0.5, 74), N(1.5, 0.5, 72), N(2, 1.5, 71), N(3.5, 0.5, 69),
  N(4, 0.25, 72), N(4.25, 0.25, 74), N(4.5, 0.25, 76), N(4.75, 0.25, 78), N(5, 3.5, 79),
  N(8.5, 0.55, 80), N(9, 1.05, 78), N(10, 2, 75),   // legato overlaps
];
const chords = [];
[[0, [48, 55, 64]], [4, [43, 50, 59]], [8, [45, 52, 60]]].forEach(([t, ps]) => ps.forEach(p => chords.push(N(t, 4, p))));
const piano = [N(0, 0.5, 40), N(0.5, 0.5, 52), N(1, 1, 64), N(1, 1, 67), N(2, 2, 72), N(2, 2, 36)];

const score = {
  title: 'Test', timeSig: { num: 4, den: 4 }, keyFifths: null,
  parts: [{ name: 'Flute', notes: melody }, { name: 'Viola', notes: chords.map(n => ({ ...n, pitch: n.pitch + 7 })) },
          { name: 'Cellos', notes: chords }, { name: 'Piano', notes: piano }],
};
const r = SB.buildMEI(score, { grid: 2 });
fs.writeFileSync(new URL('./out.mei', import.meta.url), r.mei);
console.log('key fifths', r.keyFifths, 'measures', r.measures, 'timeline', r.timeline.length);

const VerovioModule = await createVerovioModule();
const tk = new VerovioToolkit(VerovioModule);
tk.setOptions({ pageWidth: 2100, pageHeight: 3000, scale: 45, adjustPageHeight: true, footer: 'none', header: 'none' });
if (!tk.loadData(r.mei)) { console.error('LOAD FAILED', tk.getLog()); process.exit(1); }
console.log('log:', tk.getLog().slice(0, 2000));
fs.writeFileSync(new URL('./out.svg', import.meta.url), tk.renderToSVG(1));
console.log('pages', tk.getPageCount());
