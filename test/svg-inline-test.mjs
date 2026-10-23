// Unit test of web/core/svg-inline.js (Verovio glyph <use> -> inline <path>) on real Verovio output (a synthetic
// score and the Mega Man 2 fixture) and on hand-written edge cases. The pixel comparison in the page is
// test/render-perf-e2e.mjs.
import assert from 'assert/strict';
import { createRequire } from 'module';
import { loadFixtureScore, renderMEI, ScoreBuilder as SB } from './lib.mjs';

const require = createRequire(import.meta.url);
const { inlineGlyphs } = require('../web/core/svg-inline.js');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); }
}

const USE = /<use\b[^>]*?\s*(?:\/>|>\s*<\/use>)/g;
const GLYPH = /<path transform="translate\(([^,]+),([^)]+)\) scale\(([^,]+),([^)]+)\) scale\(1,-1\)" d="[^"]*" \/>/g;
const attr = (s, k) => { const m = s.match(new RegExp('\\s' + k + '="([^"]*)"')); return m ? m[1] : null; };

/** Checks a real Verovio page: every glyph inlined with the use's geometry, everything else byte-identical. */
function checkVerovioPage(svg) {
  const uses = svg.match(USE) || [];
  assert.ok(uses.length > 0, 'the page has glyph <use>s');
  const out = inlineGlyphs(svg);
  assert.equal((out.match(/<use\b/g) || []).length, 0, 'no <use> left');
  assert.equal((out.match(/<symbol\b/g) || []).length, 0, 'unused symbols dropped');
  assert.ok(!/<defs>/.test(out), 'empty <defs> dropped');
  const glyphs = [...out.matchAll(GLYPH)];
  assert.equal(glyphs.length, uses.length, 'one <path> per <use>');
  uses.forEach((u, i) => {
    const [, tx, ty, sx, sy] = glyphs[i];
    const w = parseFloat(attr(u, 'width')), h = parseFloat(attr(u, 'height'));
    assert.equal(+tx, +attr(u, 'x'), 'x of glyph ' + i);
    assert.equal(+ty, +attr(u, 'y'), 'y of glyph ' + i);
    assert.ok(Math.abs(sx - w / 1000) < 1e-6 && Math.abs(sy - h / 1000) < 1e-6, 'scale of glyph ' + i);
  });
  // the d of each path is its symbol's
  const sym = new Map([...svg.matchAll(/<symbol id="([^"]+)"[^>]*>\s*<path[^>]*\sd="([^"]*)"/g)].map(m => [m[1], m[2]]));
  uses.forEach((u, i) => assert.equal(attr(glyphs[i][0], 'd'), sym.get(attr(u, 'xlink:href').slice(1)), 'd of glyph ' + i));
  // the rest of the string is untouched
  const restIn = svg.replace(/[ \t]*<defs>[\s\S]*?<\/defs>[ \t]*\r?\n?/, '').replace(USE, '\u0000');
  const restOut = out.replace(GLYPH, '\u0000');
  assert.equal(restOut, restIn, 'everything but <defs> and the glyphs is byte-identical');
  return out;
}

await check('synthetic score (test/render-test.mjs material)', async () => {
  const N = (start, dur, pitch, i) => ({ id: '0_' + i + '_' + pitch, start, dur, pitch });
  const score = { title: 'T', timeSig: { num: 4, den: 4 }, keyFifths: null, parts: [
    { name: 'Flute', notes: [N(0, 1, 76, 0), N(1, 0.5, 74, 1), N(1.5, 0.5, 73, 2), N(2, 1.5, 71, 3), N(4, 0.25, 70, 4), N(7, 1, 79, 5)] },
    { name: 'Cellos', notes: [N(0, 4, 48, 6), N(0, 4, 55, 7), N(4, 2, 43, 8)] }] };
  const { svg } = await renderMEI(SB.buildMEI(score, { grid: 2 }).mei, { scale: 45 });
  checkVerovioPage(svg);
});

await check('Mega Man 2 fixture (23 parts): every glyph, byte-identical elsewhere, fast', async () => {
  const score = await loadFixtureScore();
  const { svg } = await renderMEI(SB.buildMEI(score, { grid: 2 }).mei, { scale: 55 });
  checkVerovioPage(svg);
  const t = performance.now();
  inlineGlyphs(svg);
  const ms = performance.now() - t;
  console.log('      ' + (svg.match(/<use\b/g) || []).length + ' glyphs in ' + Math.round(ms) + ' ms');
  assert.ok(ms < 1000, 'well under a second (' + Math.round(ms) + ' ms)');
});

const defs = (...syms) => '<defs>\n' + syms.join('\n') + '\n</defs>\n';
const SYM = (id, extra = '', body = '<path transform="scale(1,-1)" d="M0 0h10" />') =>
  `<symbol id="${id}" viewBox="0 0 1000 1000"${extra} overflow="inherit">${body}</symbol>`;

await check('<use> transform and other attributes carry over; </use> closing form', () => {
  const svg = '<svg>' + defs(SYM('G')) + '<g><use xlink:href="#G" x="10" y="20" width="500" height="500" class="a" transform="rotate(90)"></use></g></svg>';
  assert.equal(inlineGlyphs(svg),
    '<svg><g><path class="a" transform="rotate(90) translate(10,20) scale(0.5,0.5) scale(1,-1)" d="M0 0h10" /></g></svg>');
});

await check('non-square viewport: xMidYMid meet centres; preserveAspectRatio="none" stretches; viewBox origin', () => {
  const svg = '<svg>' + defs(SYM('G'), `<symbol id="S" viewBox="100 50 1000 500" preserveAspectRatio="none"><path d="M1 1" /></symbol>`) +
    '<use xlink:href="#G" x="0" y="0" width="200px" height="100px" />' +
    '<use href="#S" x="5" y="5" width="100" height="100" /></svg>';
  assert.equal(inlineGlyphs(svg),
    '<svg><path transform="translate(50,0) scale(0.1,0.1) scale(1,-1)" d="M0 0h10" />' +
    '<path transform="translate(-5,-5) scale(0.1,0.2)" d="M1 1" /></svg>');
});

await check('unresolvable <use>s stay, and so do the symbols they (or anything else) still reference', () => {
  const multi = SYM('M', '', '<path d="M0 0" /><path d="M1 1" />');
  const svg = '<svg>' + defs(SYM('G'), SYM('K'), SYM('P', ' preserveAspectRatio="xMinYMin slice"'), multi, SYM('U')) +
    '<use xlink:href="#G" x="1" y="1" width="10%" height="10%" />' + // % needs the viewport: left alone
    '<use xlink:href="#M" x="0" y="0" width="1" height="1" />' +    // not a single <path>
    '<use xlink:href="#P" x="0" y="0" width="1" height="1" />' +    // slice
    '<use xlink:href="#Q" x="0" y="0" width="1" height="1" />' +    // unknown symbol
    '<use xlink:href="#U" x="0" y="0" width="1000" height="1000" />' + // inlined
    '<rect fill="url(#K)" /></svg>';                                // K referenced elsewhere: kept
  const out = inlineGlyphs(svg);
  assert.equal((out.match(/<use\b/g) || []).length, 4, 'four <use>s kept');
  assert.ok(/<path transform="translate\(0,0\) scale\(1,1\) scale\(1,-1\)" d="M0 0h10" \/>/.test(out), 'U inlined');
  ['G', 'K', 'P', 'M'].forEach(id => assert.ok(out.includes('<symbol id="' + id + '"'), id + ' kept'));
  assert.ok(!out.includes('<symbol id="U"'), 'U dropped');
});

await check('strings without glyphs come back as they are', () => {
  assert.equal(inlineGlyphs('<svg><g/></svg>'), '<svg><g/></svg>');
  assert.equal(inlineGlyphs(''), '');
  assert.equal(inlineGlyphs(null), null);
});

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('svg-inline-test: all passed');
