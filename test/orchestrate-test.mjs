// Orchestrate core: voicing (explode / double / reduce), clip lookup and step math, navigator batches.
import assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const O = require('../web/features/orchestrate.js');
const { clipEnd } = require('../web/features/arrangement.js');
const instruments = require('../web/features/instruments.js');

const info = name => { const r = instruments.forPart({ name, notes: [] }); return { name, range: r.inst.range, bass: r.inst.id === 'doublebass', rank: r.scoreOrder }; };
const strings = O.orderTargets(['Cellos', 'Violas', 'Violins 2', 'Violins 1', 'Basses'].map(info));
assert.deepEqual(strings.map(t => t.name), ['Violins 1', 'Violins 2', 'Violas', 'Cellos', 'Basses'], 'top-down by range, score order on ties');
assert.equal(strings[4].bass, true);

const chord = (start, pitches, dur = 4) => pitches.map(p => ({ start, dur, pitch: p, vel: 0.8 }));
const pitchesOf = (r, name) => r.byTarget.get(name).map(n => n.pitch);

// 4-note chord to 4 strings: one note each, top down.
const four = strings.slice(0, 4);
let r = O.explode(chord(0, [48, 64, 67, 72]), four);
assert.deepEqual(four.map(t => pitchesOf(r, t.name)), [[72], [67], [64], [48]]);
assert.equal(r.dropped, 0);

// With basses: the bass an octave lower in the basses, upper four unchanged.
r = O.explode(chord(0, [48, 64, 67, 72]), strings);
assert.deepEqual(pitchesOf(r, 'Basses'), [36]);
assert.deepEqual(pitchesOf(r, 'Cellos'), [48]);
// bassOctave off: the basses are one of the voices (5 targets, 4 notes -> doubling).
r = O.explode(chord(0, [48, 64, 67, 72]), strings, { bassOctave: false });
assert.deepEqual(strings.map(t => pitchesOf(r, t.name)), [[72], [72], [67], [64], [48]]);

// More notes than instruments: top notes + bass kept, inner dropped.
r = O.explode(chord(0, [43, 55, 64, 67, 72, 76]), four);
assert.deepEqual(four.map(t => pitchesOf(r, t.name)), [[76], [72], [67], [43]]);
assert.equal(r.dropped, 2);

// Fewer notes: doubling, and ranges (viola can't play F#3 -> moved up an octave; violins at least G3).
r = O.explode(chord(0, [42, 74]), four);
assert.deepEqual(four.map(t => pitchesOf(r, t.name)), [[74], [74], [54], [42]]);
assert.equal(r.refit, 1);
r = O.explode(chord(0, [42, 74]), four, { keepRanges: false });
assert.deepEqual(pitchesOf(r, 'Violas'), [42]);

// Passage: each onset voiced on its own.
r = O.explode([...chord(0, [60, 64, 67, 72], 1), ...chord(1, [59, 62, 67, 74], 1)], four);
assert.deepEqual(pitchesOf(r, 'Violins 1'), [72, 74]);
assert.deepEqual(r.byTarget.get('Cellos').map(n => n.start), [0, 1]);

// Double: octave / diatonic third in G major / range fit.
const line = [{ start: 0, dur: 1, pitch: 67, vel: 0.7 }, { start: 1, dur: 1, pitch: 71, vel: 0.7 }, { start: 2, dur: 2, pitch: 74, vel: 0.7 }];
assert.deepEqual(O.double(line, { interval: 'octDown', range: info('Cellos').range }).notes.map(n => n.pitch), [55, 59, 62]);
assert.deepEqual(O.double(line, { interval: 'thirdUp', fifths: 1 }).notes.map(n => n.pitch), [71, 74, 78]); // B D F#
assert.deepEqual(O.double(line, { interval: 'sixthDown', fifths: 0 }).notes.map(n => n.pitch), [59, 62, 65]);  // B D F
const db = O.double(line, { interval: 'unison', range: info('Basses').range });
assert.deepEqual(db.notes.map(n => n.pitch), [55, 59, 62], 'basses: unison moved down into range');
assert.equal(db.refit, 3);

// Reduce: merge + dedupe.
const red = O.reduce([[{ start: 0, dur: 1, pitch: 60 }, { start: 1, dur: 1, pitch: 62 }], [{ start: 0, dur: 2, pitch: 60 }, { start: 0, dur: 2, pitch: 48 }]]);
assert.deepEqual(red.notes.map(n => [n.start, n.pitch, n.dur]), [[0, 60, 2], [0, 48, 2], [1, 62, 1]]);

// Clips: lookup, step math with a content offset, missing clip, looping clip.
const crawl = { stepsPerBeat: 24, tracks: [], result: [
  { lane: 3, track: 'Vln', start: 16, playStart: 4, playStop: 20, loop: false, loopStart: 0, loopLength: 20, notes: [] },
  { lane: 3, track: 'Vln', start: 40, playStart: 0, playStop: 8, loop: false, loopStart: 0, loopLength: 8, notes: [] },
  { lane: 5, track: 'Vc', start: 0, playStart: 0, playStop: 4, loop: true, loopStart: 0, loopLength: 4, length: 16, notes: [] },
  { lane: 6, track: 'Cb', start: 0, playStart: 0, playStop: 8, loop: true, loopStart: 0, loopLength: 8, notes: [] },
] };
let p = O.planTarget(crawl, 'Vln', [{ start: 17.5, dur: 1, pitch: 72, vel: 1 }, { start: 41, dur: 20, pitch: 74, vel: 0.5 }], { clipEnd, measureBeats: 4 });
assert(!p.error, p.error);
assert.equal(p.writes.length, 2);
assert.deepEqual(p.writes[0].adds, [{ ch: 0, x: Math.round((17.5 - 16 + 4) * 24), y: 72, vel: 127, d: 1 }]);
assert.equal(p.writes[1].adds[0].d, 7, 'shortened to the clip end');
const lines = O.batchLines(p, 7);
assert.deepEqual(lines, ['goto 3 16 Vln', 'add 0 132 72 127 1', 'goto 3 40 Vln', 'add 0 24 74 64 7', 'gotoHome 7']);
p = O.planTarget(crawl, 'Vln', [{ start: 36, dur: 1, pitch: 72 }], { clipEnd, measureBeats: 4 });
assert.match(p.error, /No clip on Vln at bar 10/);
p = O.planTarget(crawl, 'Viola', [{ start: 0, dur: 1, pitch: 60 }], { clipEnd });
assert.match(p.error, /No clip on Viola at bar 1 — create one in Bitwig/);
p = O.planTarget(crawl, 'Vc', [{ start: 1, dur: 1, pitch: 48 }], { clipEnd });
assert.match(p.error, /loops/, 'a clip that repeats its loop is refused');
p = O.planTarget(crawl, 'Cb', [{ start: 1, dur: 1, pitch: 36 }], { clipEnd });
assert(!p.error, 'a looping clip shown for one pass is fine');
assert.equal(O.batchLines({ writes: [{ lane: 1, clip: { start: 0, track: 'Flutes  a3' }, adds: [] }] }, -1)[0], 'goto 1 0 Flutes%20%20a3');

O.applyToCrawl(O.planTarget(crawl, 'Cb', [{ start: 1, dur: 1, pitch: 36, vel: 0.5 }], { clipEnd }));
assert.deepEqual(crawl.result[3].notes, [[0, 0 + 24, 36, 1, 64]]);
assert.equal(O.laneOf(crawl, 'Vc'), 5);
console.log('orchestrate tests passed');

// Diatonic doubling spells like an engraver: B♮ (raised 7th of C minor, key of E♭) + a third = D, not D♯.
{
  const O2 = (await import('module')).createRequire(import.meta.url)('../web/features/orchestrate.js');
  const thirds = O2.double([72, 71, 72, 74].map((p, i) => ({ start: i, dur: 1, pitch: p, vel: 0.8 })), { interval: 'thirdUp', fifths: -3, keepRanges: false });
  if (thirds.notes.map(n => n.pitch).join(',') !== '75,74,75,77') throw new Error('C B♮ C D a third up in E♭ should be E♭ D E♭ F, got ' + thirds.notes.map(n => n.pitch));
  console.log('diatonic spelling test passed');
}
