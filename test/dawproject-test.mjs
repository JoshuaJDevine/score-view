// Parses a .dawproject with web/dawproject.js (under jsdom) and renders the full score to test/full.svg.
import fs from 'fs';
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';

const require = createRequire(import.meta.url);
const file = process.argv[2];
const dom = new JSDOM('');
const ctx = { DOMParser: dom.window.DOMParser, fflate: require('fflate'), TextDecoder };
new Function('DOMParser', 'TextDecoder', fs.readFileSync(new URL('../web/dawproject.js', import.meta.url), 'utf8'))
  .call(ctx, ctx.DOMParser, TextDecoder);
const SB = require('../web/score.js');

const score = ctx.DawProject.parseDawProjectFile(fs.readFileSync(file), 'Test');
console.log('timeSig', score.timeSig, 'bpm', score.bpm, 'length', score.lengthBeats);
score.parts.forEach(p => {
  const ps = p.notes.map(n => n.pitch);
  console.log(`  ${p.group || '-'} / ${p.name}: ${p.notes.length} notes, pitch ${Math.min(...ps)}-${Math.max(...ps)}`);
});
score.parts = score.parts.map(p => ({ ...p, notes: p.notes.filter(n => n.pitch >= 24) })).filter(p => p.notes.length);
score.keyFifths = null;
const r = SB.buildMEI(score, { grid: 2, simplify: true });
console.log('key', r.keyFifths, 'measures', r.measures);
const tk = new VerovioToolkit(await createVerovioModule());
tk.setOptions({ pageWidth: 2600, pageHeight: 60000, scale: 40, adjustPageHeight: true, breaks: 'auto',
  header: 'none', footer: 'none', condense: 'auto', condenseFirstPage: true, justifyVertically: false });
if (!tk.loadData(r.mei)) { console.error('LOAD FAILED', tk.getLog()); process.exit(1); }
console.log('pages', tk.getPageCount(), 'log:', tk.getLog().slice(0, 500));
fs.writeFileSync(new URL('./full.svg', import.meta.url), tk.renderToSVG(1));
