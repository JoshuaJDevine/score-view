// Unit test of note entry's pure core (web/features/entry.js): keypad layouts (Sibelius / Dorico / MuseScore), the
// Alt+digit interval, articulation kinds, played lengths and the range check.
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const N = require('../web/features/entry.js');
const { keyAction, keyFor, intervalPitch, articKind, playedBeats, rangeIssue, LAYOUTS, DURS, OVERLAPS } = N;

const row = (d, extra) => ({ key: String(d), code: 'Digit' + d, ...extra });
const pad = (d, extra) => ({ key: String(d), code: 'Numpad' + d, ...extra });
const name = a => a.type === 'dur' ? DURS[a.idx].name : a.type === 'acc' ? ['natural', 'sharp', 'flat'][a.delta === 0 ? 0 : a.delta > 0 ? 1 : 2] :
  a.type === 'off' ? 'off:' + a.name : a.type;
const digits = lay => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => name(keyAction(lay, row(d))));

// ---- the three layouts, exactly (docs/features/entry.md)
assert.equal(N.DEFAULT_LAYOUT, 'sibelius');
assert.deepEqual(digits('sibelius'), ['rest', '32nd', '16th', '8th', 'quarter', 'half', 'whole', 'natural', 'sharp', 'flat']);
assert.deepEqual(digits('dorico'), ['natural', 'off:128th', 'off:64th', '32nd', '16th', '8th', 'quarter', 'half', 'whole', 'off:double whole']);
assert.deepEqual(digits('musescore'), ['rest', 'off:64th', '32nd', '16th', '8th', 'quarter', 'half', 'whole', 'off:double whole', 'off:longa']);
// numpad = number row; unknown layout falls back to Sibelius
for (const lay of Object.keys(LAYOUTS)) for (let d = 0; d <= 9; d++) assert.deepEqual(keyAction(lay, pad(d)), keyAction(lay, row(d)), lay + ' numpad ' + d);
assert.deepEqual(keyAction('nonsense', row(4)), { type: 'dur', idx: 5 });
// other keys
assert.deepEqual(keyAction('dorico', { key: ',', code: 'Comma' }), { type: 'rest' });
assert.equal(keyAction('sibelius', { key: ',', code: 'Comma' }), null);
assert.deepEqual(keyAction('dorico', { key: '=', code: 'Equal' }), { type: 'acc', delta: 1 });
assert.deepEqual(keyAction('musescore', { key: '=', code: 'Equal' }), { type: 'acc', delta: 0 });
assert.deepEqual(keyAction('sibelius', { key: '-', code: 'Minus' }), { type: 'acc', delta: -1 });
assert.deepEqual(keyAction('dorico', { key: '-', code: 'NumpadSubtract' }), { type: 'acc', delta: -1 });
assert.deepEqual(keyAction('sibelius', { key: 'Enter', code: 'NumpadEnter' }), { type: 'tie' });
assert.equal(keyAction('dorico', { key: 'Enter', code: 'NumpadEnter' }), null);
assert.equal(keyAction('sibelius', { key: 'Enter', code: 'Enter' }), null);
for (const lay of Object.keys(LAYOUTS)) {
  assert.deepEqual(keyAction(lay, { key: '.', code: 'Period' }), { type: 'dot' });
  assert.deepEqual(keyAction(lay, { key: '.', code: 'NumpadDecimal' }), { type: 'dot' });
  assert.equal(keyAction(lay, { key: 'c', code: 'KeyC' }), null, 'letters are not layout keys');
}
// Shift+number row is a symbol, not a duration; Shift+numpad still is
assert.equal(keyAction('sibelius', row(4, { key: '$', shift: true })), null);
// modifiers
assert.deepEqual(keyAction('musescore', row(3, { ctrl: true })), { type: 'triplet' });
assert.deepEqual(keyAction('sibelius', { key: 'ArrowUp', code: 'ArrowUp', ctrl: true }), { type: 'octave', dir: 1 });
assert.deepEqual(keyAction('dorico', { key: 'ArrowDown', code: 'ArrowDown', ctrl: true }), { type: 'octave', dir: -1 });
assert.deepEqual(keyAction('sibelius', { key: 'ArrowRight', code: 'ArrowRight', ctrl: true }), { type: 'bar', dir: 1 });
assert.deepEqual(keyAction('sibelius', { key: 'ArrowLeft', code: 'ArrowLeft', ctrl: true }), { type: 'bar', dir: -1 });
assert.equal(keyAction('sibelius', { key: 'ArrowLeft', code: 'ArrowLeft', ctrl: true, shift: true }), null);
assert.equal(keyAction('sibelius', { key: 'z', code: 'KeyZ', ctrl: true }), null);
assert.deepEqual(keyAction('sibelius', row(3, { alt: true })), { type: 'interval', n: 3, dir: 1 });
assert.deepEqual(keyAction('dorico', row(6, { key: '^', alt: true, shift: true })), { type: 'interval', n: 6, dir: -1 });
assert.equal(keyAction('sibelius', row(0, { alt: true })), null);
// Sibelius number row = intervals (preference); the numpad keeps the durations; other layouts ignore it
assert.deepEqual(keyAction('sibelius', row(3), { rowIntervals: true }), { type: 'interval', n: 3, dir: 1 });
assert.deepEqual(keyAction('sibelius', row(5, { key: '%', shift: true }), { rowIntervals: true }), { type: 'interval', n: 5, dir: -1 });
assert.deepEqual(keyAction('sibelius', pad(4), { rowIntervals: true }), { type: 'dur', idx: 5 });
assert.deepEqual(keyAction('dorico', row(6), { rowIntervals: true }), { type: 'dur', idx: 5 });

// keyFor: the key shown on the keypad buttons
assert.equal(keyFor('sibelius', 5), '4');
assert.equal(keyFor('dorico', 5), '6');
assert.equal(keyFor('musescore', 5), '5');
assert.equal(keyFor('dorico', 'rest'), ',');
assert.equal(keyFor('sibelius', 'rest'), '0');
assert.equal(keyFor('dorico', 'natural'), '0');

// ---- intervals (written pitch, white-key natural in, key signature applied)
assert.deepEqual(intervalPitch(60, 3, 1, 0), { pitch: 64, natural: 64 });  // C -> E
assert.deepEqual(intervalPitch(60, 3, -1, 0), { pitch: 57, natural: 57 }); // C -> A below
assert.equal(intervalPitch(60, 8, 1, 0).pitch, 72);                        // octave
assert.equal(intervalPitch(60, 2, 1, 0).pitch, 62);
assert.equal(intervalPitch(71, 3, 1, 1).pitch, 74);                        // B -> D (G major)
assert.equal(intervalPitch(62, 3, 1, 2).pitch, 66);                        // D -> F# (D major)
assert.equal(intervalPitch(62, 6, -1, -2).pitch, 53);                      // D -> F below (B-flat major)
assert.equal(intervalPitch(65, 4, 1, -1).pitch, 70);                       // F -> B-flat (F major)
assert.equal(intervalPitch(64, 5, 1, 0).pitch, 71);                        // E -> B
assert.equal(intervalPitch(66, 3, 1, 0).pitch, 69, 'a black key counts from the letter below (F# -> A)');

// ---- articulation kinds and played lengths
assert.equal(articKind('Legato'), 'legato');
assert.equal(articKind('Violins 1 Legato'), 'legato');
for (const s of ['Short Spiccato', 'Short Staccato', 'Short Pizzicato', 'Short Marcato', 'Vc Spiccato', 'Short Hits', 'Pizz'])
  assert.equal(articKind(s), 'short', s);
for (const s of ['Non legato', 'Violins non-legato', 'Long', 'Long Marcato Attack', 'Long CS', 'Tremolo', 'Violins', '', null]) assert.equal(articKind(s), null, String(s));
assert.equal(playedBeats(1, 'short', 'gap'), 1 - 1 / 16);
assert.equal(playedBeats(0.125, 'short', 'gap'), 0.125 - 0.125 / 4);
assert.equal(playedBeats(1, 'short', 'half'), 0.5);
assert.equal(playedBeats(1, 'short', 'off'), 1);
assert.equal(playedBeats(1, 'legato', 'half'), 1);
assert.equal(playedBeats(2, null, 'gap'), 2);
for (const b of [0.125, 0.25, 0.375, 0.5, 0.75, 1, 1.5, 2, 3, 4]) for (const m of ['gap', 'half', 'off'])
  assert(Math.abs(N.writtenBeats(playedBeats(b, 'short', m), 'short', m) - b) < 1e-9, `writtenBeats undoes playedBeats (${b}, ${m})`);
assert.equal(N.writtenBeats(0.9, 'legato', 'gap'), 0.9);
assert.equal(N.writtenBeats(0.9, null, 'half'), 0.9);
assert.deepEqual(Object.keys(OVERLAPS), ['off', 'small', 'medium', 'large']);
assert.equal(OVERLAPS.small, 1 / 16);
assert.equal(OVERLAPS.off, 0);

// ---- range check
const vln = [55, 100], comfort = [55, 93];
assert.equal(rangeIssue([60, 72], vln, comfort, 'range'), null);
assert.deepEqual(rangeIssue([50], vln, comfort, 'range'), { pitch: 50, side: 'below', level: 'range', lo: 55, hi: 100 });
assert.deepEqual(rangeIssue([60, 101], vln, comfort, 'range'), { pitch: 101, side: 'above', level: 'range', lo: 55, hi: 100 });
assert.equal(rangeIssue([96], vln, comfort, 'range'), null, 'outside the comfortable range only in comfort mode');
assert.deepEqual(rangeIssue([96], vln, comfort, 'comfort'), { pitch: 96, side: 'above', level: 'comfort', lo: 55, hi: 93 });
assert.equal(rangeIssue([30], vln, comfort, 'off'), null);
assert.equal(rangeIssue([30], null, null, 'range'), null);

console.log('entry-test OK');
