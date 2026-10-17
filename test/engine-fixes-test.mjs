// Regression tests for engine details: transposed key spelling, noKeySig, part abbreviations, staff transposition.
import assert from 'assert';
import { ScoreBuilder as SB } from './lib.mjs';

const notes = [0, 2, 4].map((d, i) => ({ id: 'a' + i, start: i, dur: 1, pitch: 64 + d }));
const build = (parts, keyFifths = 4) => SB.buildMEI({ timeSig: { num: 4, den: 4 }, keyFifths, parts }, {});

// B-flat clarinet in E major (4 sharps) reads in F# major (6 sharps), not G-flat (6 flats).
let r = build([{ name: 'Clarinet', transpose: 2, notes }]);
assert.equal(r.staves[0].fifths, 6, 'E major + major 2nd = F# major');
assert.match(r.mei, /keysig="6s"/);
assert.equal(r.staves[0].transpose, 2, 'staves report transposition');

// Flat side stays flat: B-flat clarinet in A-flat major (4 flats) -> B-flat major (2 flats).
r = build([{ name: 'Clarinet', transpose: 2, notes }], -4);
assert.equal(r.staves[0].fifths, -2);

// Horn in F in D-flat major (5 flats) -> A-flat major (4 flats).
r = build([{ name: 'Horn', transpose: 7, notes }], -5);
assert.equal(r.staves[0].fifths, -4);

// Percussion: no key signature even in a sharp key.
r = build([{ name: 'Flute', notes }, { name: 'Percussion', noKeySig: true, notes }]);
assert.equal(r.staves[1].fifths, 0);
assert.match(r.mei, /<staffDef n="2"[^>]*keysig="0"/);

// Abbreviations: a module-provided abbr wins over truncation.
r = build([{ name: 'Trumpets in B♭ 1–3', abbr: 'Tpt. 1–3', notes }]);
assert.match(r.mei, /<labelAbbr>Tpt\. 1–3<\/labelAbbr>/);

console.log('engine fixes tests passed');
