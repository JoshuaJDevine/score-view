// Unit tests for web/features/instruments.js (instrument lookup, labels, transposition, clefs, ranges).
//   node test/instruments-test.mjs
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const I = require('../web/features/instruments.js');

// The user's real track names (Mega Man 2 fixture) -> [instrument id, label].
const CASES = [
  ['Violin Solo', 'Strings', 'violin', 'Solo Violin'],
  ['Violin 1', 'Strings', 'violin', 'Violins I'],
  ['Violin 2', 'Strings', 'violin', 'Violins II'],
  ['Viola', 'Strings', 'viola', 'Violas'],
  ['Cello', 'Strings', 'cello', 'Cellos'],
  ['Bass', 'Strings', 'doublebass', 'Double Basses'],
  ['Horns a4', 'Brass', 'horn', 'Horns in F 1–4'],
  ['Tumpet', 'Brass', 'trumpet', 'Trumpet in B♭'],
  ['Tumpets a3', 'Brass', 'trumpet', 'Trumpets in B♭ 1–3'],
  ['Tn Trombones a3', 'Brass', 'trombone', 'Trombones 1–3'],
  ['Tn Trombone Solo', 'Brass', 'trombone', 'Trombone'],
  ['Bs Trombones a2', 'Brass', 'basstrombone', 'Bass Trombones 1–2'],
  ['Tuba', 'Brass', 'tuba', 'Tuba'],
  ['Flute', 'Winds', 'flute', 'Flute'],
  ['Flutes  a3', 'Winds', 'flute', 'Flutes 1–3'],
  ['Oboes a3', 'Winds', 'oboe', 'Oboes 1–3'],
  ['Clarinet', 'Winds', 'clarinet', 'Clarinet in B♭'],
  ['Clarinets a3', 'Winds', 'clarinet', 'Clarinets in B♭ 1–3'],
  ['Basoons a3', 'Winds', 'bassoon', 'Bassoons 1–3'],
  ['Pecussion  I', 'Percussion', 'percussion', 'Percussion I'],
  ['Pecussion  II', 'Percussion', 'percussion', 'Percussion II'],
  ['Timpani', 'Percussion', 'timpani', 'Timpani'],
  ['Harp', 'Percussion', 'harp', 'Harp'],
  ['Super Audio Cart', 'Synth', 'synth', 'Super Audio Cart'],
  // context and other spellings
  ['Bass', 'Synth', 'synth', 'Bass'],
  ['Bass', 'Choir', 'bass-voice', 'Bass'],
  ['Horns', null, 'horn', 'Horns in F'],
  ['Bass', null, 'doublebass', 'Double Basses'],
  ['Bass ✎', 'Strings', 'doublebass', 'Double Basses'],
  ['Bass Clarinet', null, 'bassclarinet', 'Bass Clarinet'],
  ['Clarinet in A', null, 'clarinet-a', 'Clarinet in A'],
  ['E♭ Clarinet', null, 'clarinet-eb', 'Clarinet in E♭'],
  ['Trumpet in C', null, 'trumpet-c', 'Trumpet in C'],
  ['Contrabassoon', null, 'contrabassoon', 'Contrabassoon'],
  ['Contrabass', null, 'doublebass', 'Double Basses'],
  ['Bassoon', null, 'bassoon', 'Bassoon'],
  ['Piccolo', null, 'piccolo', 'Piccolo'],
  ['Piccolo Trumpet', null, 'piccolotrumpet', 'Piccolo Trumpet in B♭'],
  ['Alto Flute', null, 'altoflute', 'Alto Flute'],
  ['Cor Anglais', null, 'coranglais', 'Cor Anglais'],
  ['English Horn', null, 'coranglais', 'Cor Anglais'],
  ['Glock', null, 'glockenspiel', 'Glockenspiel'],
  ['Tubular Bells', null, 'tubularbells', 'Tubular Bells'],
  ['Celli', null, 'cello', 'Cellos'],
  ['Violins 1', null, 'violin', 'Violins I'],
  ['Vln2', null, 'violin', 'Violins II'],
  ['2nd Violins', null, 'violin', 'Violins II'],
  ['Cimbasso', null, 'cimbasso', 'Cimbasso'],
  ['4 Horns', null, 'horn', 'Horns in F 1–4'],
  ['Horn 3', null, 'horn', 'Horn in F 3'],
  ['Tenor', 'Choir', 'tenor', 'Tenor'],
  ['Sopranos', null, 'soprano', 'Sopranos'],
  ['Marimba', null, 'marimba', 'Marimba'],
  ['Xylophone', null, 'xylophone', 'Xylophone'],
  ['Celesta', null, 'celesta', 'Celesta'],
  ['Grand Piano', null, 'piano', 'Piano'],
  ['Untuned Percussion', null, 'percussion', 'Percussion'],
  ['Bass Drum', null, 'percussion', 'Percussion'],
  ['Synth Pad', null, 'synth', 'Synth Pad'],
  ['Audio 7', null, 'other', 'Audio 7'],
];
let fails = 0;
for (const [name, group, id, label] of CASES) {
  const r = I.lookup(name, group);
  const ok = r.id === id && r.label === label;
  if (!ok) { fails++; console.log(`FAIL ${JSON.stringify(name)} [${group}] -> ${r.id} "${r.label}" (want ${id} "${label}")`); }
}
assert.equal(fails, 0, fails + ' lookup failures');
console.log('lookup OK:', CASES.length, 'names');

// Transposition: concert pitch keeps only octave transpositions; transposed score uses the full interval.
const T = (name, transposed, group) => I.forPart({ name, group: group || null, notes: [] }, { transposed, overrides: {} }).transpose;
const TRANSP = [
  ['Clarinet', 0, 2], ['Clarinet in A', 0, 3], ['E♭ Clarinet', 0, -3], ['Bass Clarinet', 0, 14],
  ['Horns a4', 0, 7], ['Tumpet', 0, 2], ['Trumpet in C', 0, 0], ['Piccolo Trumpet', 0, -10],
  ['Cor Anglais', 0, 7], ['Alto Flute', 0, 5], ['Piccolo', -12, -12], ['Glockenspiel', -24, -24],
  ['Xylophone', -12, -12], ['Celesta', -12, -12], ['Crotales', -24, -24], ['Bass', 12, 12],
  ['Contrabassoon', 12, 12], ['Flute', 0, 0], ['Violin 1', 0, 0], ['Tuba', 0, 0], ['Alto Sax', 0, 9],
];
for (const [name, concert, transposed] of TRANSP) {
  assert.equal(T(name, false, name === 'Bass' ? 'Strings' : null), concert, name + ' concert transpose');
  assert.equal(T(name, true, name === 'Bass' ? 'Strings' : null), transposed, name + ' transposed transpose');
}
console.log('transposition OK:', TRANSP.length, 'instruments');

// Clefs (empty parts -> primary clef).
const C = (name, transposed, notes) => {
  const r = I.forPart({ name, notes: notes || [] }, { transposed, overrides: {} });
  return r.grand ? 'grand' : JSON.stringify(r.clef);
};
assert.equal(C('Viola', false), '["C",3]');
assert.equal(C('Cello', false), '["F",4]');
assert.equal(C('Bassoon', false), '["F",4]');
assert.equal(C('Violin 1', false), '["G",2]');
assert.equal(C('Bass Clarinet', false), '["F",4]');
assert.equal(C('Bass Clarinet', true), '["G",2]');
assert.equal(C('Guitar', false), JSON.stringify({ shape: 'G', line: 2, dis: 8, disPlace: 'below' }));
assert.equal(C('Tenor', false), JSON.stringify({ shape: 'G', line: 2, dis: 8, disPlace: 'below' }));
assert.equal(C('Pecussion I', false), '["perc",3]');
assert.equal(C('Harp', false), 'grand');
assert.equal(C('Piano', false), 'grand');
assert.equal(C('Marimba', false), 'grand');
assert.equal(C('Celesta', false), 'grand');
const high = [72, 74, 76, 77, 79, 76, 74].map((p, i) => ({ id: 'h' + i, start: i, dur: 1, pitch: p }));
assert.equal(C('Cello', false, high.map(n => ({ ...n, pitch: n.pitch - 12 }))), '["C",4]', 'high cello -> tenor clef');
assert.equal(C('Viola', false, high.map(n => ({ ...n, pitch: n.pitch + 7 }))), '["G",2]', 'high viola -> treble');
assert.equal(C('Tn Trombones a3', false, high.map(n => ({ ...n, pitch: n.pitch - 7 }))), '["C",4]', 'high trombone -> tenor clef');
console.log('clefs OK');

// transformScore: labels, clef, transpose, ranges (only out-of-range notes get a colour; others untouched).
const notes = [
  { id: 'a', start: 0, dur: 1, pitch: 50 },             // below violin range -> red
  { id: 'b', start: 1, dur: 1, pitch: 98 },             // above comfortable -> orange
  { id: 'c', start: 2, dur: 1, pitch: 67, color: '#123456' }, // someone else's colour stays
  { id: 'd', start: 3, dur: 1, pitch: 20 },             // keyswitch: ignored
];
const score = { parts: [{ name: 'Violin 1', group: 'Strings', notes }, { name: 'Clarinet ✎', group: 'Winds', notes: [] }] };
const out = I.transform(score, { transposed: true, ranges: true, names: true, overrides: {} });
const [vln, cl] = out.parts;
assert.equal(vln.label, 'Violins I');
assert.equal(cl.label, 'Clarinet in B♭ ✎');
assert.equal(cl.transpose, 2);
assert.equal(vln.notes[0].color, '#d6336c');
assert.equal(vln.notes[1].color, '#f08c00');
assert.equal(vln.notes[2].color, '#123456');
assert.equal(vln.notes[3].color, undefined);
assert.equal(notes[0].color, undefined, 'input notes not mutated');
const out2 = I.transform({ parts: [{ name: 'Violin 1', group: 'Strings', notes }] }, { transposed: false, ranges: false, names: false, overrides: {} });
assert.equal(out2.parts[0].label, undefined, 'track names mode leaves label unset');
assert.equal(out2.parts[0].notes[0].color, undefined);
// Overrides
const ov = I.forPart({ name: 'Super Audio Cart', group: 'Synth', notes: [] }, { overrides: { 'Super Audio Cart': 'celesta' }, transposed: false });
assert.equal(ov.id, 'celesta'); assert.equal(ov.auto, 'synth'); assert.equal(ov.override, 'celesta');
console.log('transform OK');

// Score order: woodwinds < brass < percussion < harp < strings, solo violin before sections.
const order = n => I.forPart({ name: n, group: n === 'Bass' ? 'Strings' : null, notes: [] }, { overrides: {} }).scoreOrder;
const seq = ['Flute', 'Oboes a3', 'Clarinet', 'Basoons a3', 'Horns a4', 'Tumpet', 'Tn Trombones a3', 'Bs Trombones a2', 'Tuba',
  'Timpani', 'Pecussion  I', 'Harp', 'Violin Solo', 'Violin 1', 'Violin 2', 'Viola', 'Cello', 'Bass'];
for (let i = 1; i < seq.length; i++) assert(order(seq[i - 1]) < order(seq[i]), seq[i - 1] + ' before ' + seq[i]);
console.log('score order OK');
console.log('instruments tests passed');
