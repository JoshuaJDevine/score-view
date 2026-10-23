// Rhythm engine tests: tuplets, voices, readings (measureOverrides), pickups.
// Renders every case with Verovio and writes one sheet per run to test/out.rhythm.png (look at it).
//   node test/rhythm-test.mjs [--no-png]
import assert from 'assert';
import fs from 'fs';
import { renderMEI, screenshotSvg, ScoreBuilder as SB } from './lib.mjs';

let id = 0;
const N = (start, dur, pitch) => ({ id: 't' + (id++), start, dur, pitch });
const seq = (starts, durs, pitches) => starts.map((s, i) => N(s, durs[i % durs.length], pitches[i % pitches.length]));
const range = (from, to, step) => { const r = []; for (let x = from; x < to - 1e-9; x += step) r.push(x); return r; };
const one = (name, notes, extra = {}) => ({ title: name, timeSig: { num: 4, den: 4 }, keyFifths: 0,
  parts: [{ name: extra.partName || 'Flute', notes, ...(extra.part || {}) }], ...(extra.score || {}) });
const count = (mei, re) => (mei.match(re) || []).length;
const scale = [72, 74, 76, 77, 79, 81, 83, 84];

const cases = [];
const add = (name, score, opts, check) => cases.push({ name, score, opts: { grid: 2, ...opts }, check });

add('straight 8ths', one('8ths', seq(range(0, 8, 0.5), [0.5], scale)), {}, r => {
  assert.equal(r.tuplets, 0);
  assert.equal(count(r.mei, /dur="8"/g), 16);
});
add('humanized straight 16ths stay straight', one('16ths', seq(range(0, 4, 0.25).map((s, i) => s + [0, 0.03, -0.025, 0.02][i % 4]), [0.22], scale)), {}, r => {
  assert.equal(r.tuplets, 0);
  assert.equal(count(r.mei, /dur="16"/g), 16);
});
add('8th triplets', one('8th triplets', seq(range(0, 4, 1 / 3), [1 / 3], scale)), {}, r => {
  assert.equal(r.tuplets, 4);
  assert.equal(count(r.mei, /<tuplet num="3" numbase="2"><beam>/g), 4);
});
add('16th triplets (sextuplets)', one('16th triplets', seq(range(0, 2, 1 / 6), [1 / 6], scale).concat(N(2, 1, 72), N(3, 1, 74))), {}, r => {
  assert.equal(count(r.mei, /dur="16"/g), 12);
  assert.equal(r.tuplets, 4);
  assert.equal(count(r.mei, /<beam><tuplet/g), 2);
});
const jitter = [0, 0.02, -0.015, 0.01, -0.02, 0.015];
add('humanized triplets (8th + 16th) still read as tuplets', one('humanized triplets', [
  ...seq(range(0, 2, 1 / 3).map((s, i) => s + jitter[i % 6]), [0.3], scale),
  ...seq(range(2, 3, 1 / 6).map((s, i) => s + jitter[i % 6] / 2), [0.15], scale), N(3, 1, 72),
]), {}, r => {
  assert.equal(count(r.mei, /<tuplet/g), 4);
  assert.equal(count(r.mei, /dur="16"/g), 6);
});
add('quarter triplets', one('quarter triplets', seq([0, 2 / 3, 4 / 3, 2, 3], [2 / 3, 2 / 3, 2 / 3, 1, 1], scale)), {}, r => {
  assert.equal(r.tuplets, 1);
  assert.match(r.mei, /<tuplet num="3" numbase="2">(<note[^>]*dur="4"[^>]*\/>){3}<\/tuplet>/);
});
add('mixed bar + rest in triplet', one('mixed', [
  ...seq([0, 0.25, 0.5, 0.75], [0.25], [72, 74, 76, 77]),
  ...seq([1, 4 / 3, 5 / 3], [1 / 3], [79, 77, 76]),
  ...seq([2, 2.5, 2.75], [0.5, 0.25, 0.25], [74, 72, 71]),
  ...seq([3 + 1 / 3, 3 + 2 / 3], [1 / 3], [72, 76]),
]), {}, r => {
  assert.equal(r.tuplets, 2);
  assert.match(r.mei, /<tuplet num="3" numbase="2"><rest dur="8"\/><beam>/);
});
add('tie across barline into triplet', one('tie into triplet', [
  N(0, 1, 72), N(1, 1, 74), N(2, 1, 76), N(3, 1 + 1 / 3, 77), N(4 + 1 / 3, 1 / 3, 76), N(4 + 2 / 3, 1 / 3, 74),
  N(5, 1 / 3, 72), N(5 + 1 / 3, 2 / 3 + 1, 71), N(7, 1, 72),
]), {}, r => {
  assert.match(r.mei, /<tuplet num="3" numbase="2">(<beam>)?<note[^>]*tie="t"/);
  assert.match(r.mei, /tie="i"[^>]*\/><\/tuplet>/);
});
add('swung 8ths read as triplets', one('swing', seq(range(0, 4, 1).flatMap(b => [b, b + 2 / 3]), [2 / 3, 1 / 3], scale)), {}, r => {
  assert.equal(r.tuplets, 4);
});
add('sustained bass under moving line', one('two voices', [
  N(0, 4, 55), ...seq(range(0, 4, 0.5), [0.5], [79, 77, 76, 74, 72, 74, 76, 77]),
  N(4, 2, 55), N(6, 2, 53), ...seq(range(4, 8, 1 / 3), [1 / 3], [79, 77, 76]),
], { partName: 'Violin' }), {}, r => {
  assert.match(r.mei, /<layer n="2">/);
  assert.match(r.mei, /<layer n="2"><note[^>]*dur="1"/);
});
add('legato overlaps stay one voice', one('legato', seq(range(0, 8, 0.5), [0.62], scale.concat(scale.slice().reverse()))), {}, r => {
  assert.doesNotMatch(r.mei, /<layer n="2">/);
});
add('melodic line keeps its voice', one('crossing lines', [
  ...seq(range(0, 4, 1), [1], [60, 62, 64, 65]), ...seq(range(0, 4, 0.5), [0.5], [76, 74, 72, 71, 69, 67, 69, 71]),
]), {}, r => {
  const l2 = r.mei.split('<layer n="2">')[1].split('</layer>')[0];
  assert.equal(count(l2, /<note/g), 4); // the quarter-note line, nothing swapped in
});
add('late first note (rests)', one('late start', [N(2.5, 0.5, 72), N(3, 1, 74), N(4, 4, 76)]), {}, r => {
  assert.match(r.mei, /<rest dur="2"\/><rest dur="8"\/>/);
});
add('pickup bar (pickupBeats 1)', one('pickup', [N(0, 0.5, 67), N(0.5, 0.5, 69), ...seq(range(1, 9, 1), [1], scale)],
  { score: { pickupBeats: 1 } }), {}, r => {
  assert.match(r.mei, /<measure n="1" xml:id="m1" metcon="false">/);
  assert.equal(r.pickupBeats, 1);
  assert.deepEqual(r.measureStarts.slice(0, 3), [0, 1, 5]);
});
add('reading: tuplets off in bar 2', one('override', seq(range(0, 8, 1 / 3), [1 / 3], scale)),
  { measureOverrides: { 2: { tuplets: 'off' } } }, r => {
  assert.equal(r.tuplets, 4);
});
add('reading: single voice bar 1', one('single voice', [
  N(0, 4, 55), ...seq(range(0, 4, 0.5), [0.5], [79, 77, 76, 74, 72, 74, 76, 77]),
], { partName: 'Violin' }), { measureOverrides: { 1: { voices: 'single' } } }, r => {
  assert.doesNotMatch(r.mei, /<layer n="2">/);
});
add('3/4 and rests', { title: '3/4', timeSig: { num: 3, den: 4 }, keyFifths: 0, parts: [{ name: 'Oboe',
  notes: [N(1, 1 / 3, 72), N(1 + 1 / 3, 1 / 3, 74), N(1 + 2 / 3, 1 / 3, 76), N(3, 0.5, 77), N(4.5, 1.5, 79)] }] }, {}, r => {
  assert.equal(r.tuplets, 1);
});
add('6/8 stays straight', { title: '6/8', timeSig: { num: 6, den: 8 }, keyFifths: 0, parts: [{ name: 'Clarinet',
  notes: seq(range(0, 6, 0.5), [0.5], scale) }] }, {}, r => {
  assert.equal(r.tuplets, 0);
});

// Score intent (opts.interpret, default on): a sampler performance reads as the plainest rhythm it can mean.
const durs = mei => (mei.match(/<(note|rest)\b[^>]*>/g) || []).map(x => (x.startsWith('<rest') ? 'r' : x.match(/pname="(\w)"/)[1]) +
  x.match(/dur="(\w+)"/)[1] + (/dots="1"/.test(x) ? '.' : '') + (/tie="[im]"/.test(x) ? '~' : '')).join(' ');
// Violin 1 bar 9 of a study score after Bitwig's 16th quantize: starts on 16ths (D a 16th early), lengths as played.
const violinBar = () => one('violin bar', [N(0, 6.893871307373047, 63), N(6.75, 1.3092041015625, 62), N(8, 4.0639190673828125, 60),
  N(12, 3.9182205200195312, 57)], { partName: 'Violin 1' });
add('intent: early note and loose lengths read as meant', violinBar(), {}, r => {
  assert.equal(durs(r.mei), 'e1~ e2. d4 c1 a1');
});
add('intent off: as played', violinBar(), { interpret: false }, r => {
  assert.equal(durs(r.mei), 'e1~ e2~ e8. d16~ d4 c1 a1');
});
add('intent: an explicit reading (straight 16ths) is read as played', violinBar(),
  { measureOverrides: { 2: { grid: 2, tuplets: 'off' } } }, r => {
  assert.match(durs(r.mei), /d16/);
});
add('intent: a played 16th run stays 16ths', one('16th run', seq(range(0, 2, 0.25).map((s, i) => s + [0.04, -0.05, 0.03, -0.04][i % 4]),
  [0.24], scale).concat(N(2, 2, 72))), {}, r => {
  assert.equal(count(r.mei, /dur="16"/g), 8);
});
add('intent: dotted 8th + 16th stays dotted', one('dotted', [N(0.02, 0.7, 72), N(0.79, 0.2, 74), N(1.03, 0.95, 76), N(2, 2, 77)]), {}, r => {
  assert.match(durs(r.mei), /^c8\. d16 e4 f2/);
});

let failed = 0;
const sheets = [];
for (const c of cases) {
  const r = SB.buildMEI(c.score, c.opts);
  let rendered;
  try {
    rendered = await renderMEI(r.mei, { pageWidth: 1800, scale: 45 });
    assert.ok(!/error/i.test(rendered.log), 'verovio log: ' + rendered.log);
    c.check(r);
    console.log('ok  ', c.name);
  } catch (err) {
    failed++;
    console.log('FAIL', c.name, '\n     ', err.message.split('\n')[0]);
    fs.writeFileSync(`test/out.rhythm-fail-${cases.indexOf(c)}.mei`, r.mei);
  }
  if (rendered) sheets.push(`<div style="font:14px sans-serif;margin:8px 12px 0">${c.name}</div>${rendered.svg}`);
}
if (!process.argv.includes('--no-png')) {
  for (let i = 0; i * 6 < sheets.length; i++) {
    await screenshotSvg(sheets.slice(i * 6, i * 6 + 6).join(''), `test/out.rhythm-${i + 1}.png`, { width: 900 });
    console.log(`wrote test/out.rhythm-${i + 1}.png`);
  }
}
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('all', cases.length, 'rhythm cases passed');
