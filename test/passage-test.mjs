// Pure core of features/passage.js: passage selection by clicks, copy, where a paste lands, the per-clip edits
// (overwrite / merge, keyswitches, notes ringing in), the navigator batch (gotoStay last), result mapping, aliases.
//   node test/passage-test.mjs
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const P = require('../web/features/passage.js');
const A = require('../web/features/arrangement.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ok ' + name); };

const order = ['Flute', 'Violins 1', 'Violins 2', 'Violas', 'Cellos'];

ok('click selects one bar on one staff; Shift extends to a rectangle; Ctrl adds/removes a staff', () => {
  let s = P.selectAt(null, { track: 'Violins 1', bar: 3 }, order);
  assert.deepEqual(s, { staves: ['Violins 1'], from: 3, to: 3, anchor: { track: 'Violins 1', bar: 3 } });
  s = P.selectAt(s, { track: 'Violas', bar: 5 }, order, 'extend');
  assert.deepEqual(s.staves, ['Violins 1', 'Violins 2', 'Violas']);
  assert.deepEqual([s.from, s.to], [3, 5]);
  s = P.selectAt(s, { track: 'Flute', bar: 2 }, order, 'extend'); // upwards and earlier, from the same anchor
  assert.deepEqual(s.staves, ['Flute', 'Violins 1']);
  assert.deepEqual([s.from, s.to], [2, 3]);
  s = P.selectAt(s, { track: 'Cellos', bar: 9 }, order, 'add');
  assert.deepEqual(s.staves, ['Flute', 'Violins 1', 'Cellos'], 'Ctrl+click adds a staff in score order');
  assert.deepEqual([s.from, s.to], [2, 3], 'bars stay');
  s = P.selectAt(s, { track: 'Violins 1', bar: 2 }, order, 'add');
  assert.deepEqual(s.staves, ['Flute', 'Cellos']);
  assert.equal(P.selectAt({ staves: ['Flute'], from: 1, to: 1 }, { track: 'Flute', bar: 1 }, order, 'add'), null, 'last staff removed');
  assert.deepEqual(P.selectAt(null, { track: 'Violas', bar: 4 }, order, 'extend').staves, ['Violas'], 'Shift without a passage = click');
});

const notes = {
  'Violins 1': [
    { start: 0, dur: 1, pitch: 72, vel: 0.5 }, { start: 3, dur: 3, pitch: 74, vel: 0.5 }, // rings past bar 1
    { start: 4, dur: 1, pitch: 76, vel: 0.5 }, { start: 0, dur: 8, pitch: 20, vel: 1 }, // keyswitch
    { start: 8, dur: 1, pitch: 79, vel: 0.5 },
  ],
  Violas: [{ start: 1, dur: 1, pitch: 60 }],
};
const of = t => notes[t] || [];

ok('copy keeps notes starting inside, relative, cut at the end; keyswitches only on request', () => {
  const c = P.copyPassage(of, { staves: ['Violins 1', 'Violas'], from: 1, to: 1 }, { start: 0, end: 4 });
  assert.equal(c.beats, 4);
  assert.equal(c.bars, 1);
  assert.equal(c.keyswitches, false);
  assert.deepEqual(c.staves[0].notes.map(q => [q.start, q.dur, q.pitch]), [[0, 1, 72], [3, 1, 74]]);
  assert.deepEqual(c.staves[1].notes.map(q => [q.start, q.dur, q.pitch, q.vel]), [[1, 1, 60, 0.8]], 'missing velocity = 0.8');
  const k = P.copyPassage(of, { staves: ['Violins 1'], from: 2, to: 2 }, { start: 4, end: 8 }, { keyswitches: true });
  assert.deepEqual(k.staves[0].notes.map(q => [q.start, q.pitch]), [[0, 76]], 'the keyswitch started in bar 1');
  const k1 = P.copyPassage(of, { staves: ['Violins 1'], from: 1, to: 2 }, { start: 0, end: 8 }, { keyswitches: true });
  assert.deepEqual(k1.staves[0].notes.map(q => q.pitch), [20, 72, 74, 76]);
});

ok('paste targets: consecutive staves from the clicked one, or an explicit list', () => {
  const c = P.copyPassage(of, { staves: ['Violins 1', 'Violas'], from: 1, to: 1 }, { start: 0, end: 4 });
  const t = P.pasteTargets(c, { track: 'Violins 2', order, at: 16 });
  assert.deepEqual(t.targets.map(x => [x.track, x.start, x.end]), [['Violins 2', 16, 20], ['Violas', 16, 20]]);
  assert.deepEqual(t.targets[0].notes.map(q => q.start), [16, 19]);
  assert.match(P.pasteTargets(c, { track: 'Cellos', order, at: 0 }).error, /2 staves but only 1 staff from Cellos down/);
  assert.match(P.pasteTargets(c, { track: 'Harp', order, at: 0 }).error, /not a staff/);
  assert.deepEqual(P.pasteTargets(c, { tracks: ['Flute', 'Cellos'], at: 4 }).targets.map(x => x.track), ['Flute', 'Cellos']);
});

const clip = (lane, track, start, playStop, rows = [], extra = {}) =>
  ({ lane, track, start, playStart: 0, playStop, loop: false, loopStart: 0, loopLength: playStop, notes: rows, ...extra });

ok('clip edits: overwrite deletes notes starting in the region, shortens notes ringing in, keeps keyswitches', () => {
  const c = clip(2, 'Violins 2', 0, 16, [[0, 0, 60, 2, 90], [0, 72, 62, 3, 90], [0, 96, 64, 1, 90], [0, 96, 21, 4, 100], [0, 192, 65, 1, 90]]);
  const adds = [{ ch: 0, x: 96, y: 67, vel: 64, d: 1 }];
  const e = P.clipEdits(c, c.notes, 16, { start: 4, end: 8 }, adds, { mode: 'overwrite' });
  assert.deepEqual(e.lines, ['dur 0 72 62 1', 'del 0 96 64', 'add 0 96 67 64 1']);
  assert.deepEqual(e.rows, [[0, 0, 60, 2, 90], [0, 72, 62, 1, 90], [0, 96, 21, 4, 100], [0, 192, 65, 1, 90], [0, 96, 67, 1, 64]]);
  const ks = P.clipEdits(c, c.notes, 16, { start: 4, end: 8 }, [], { mode: 'overwrite', keyswitches: true });
  assert.ok(ks.lines.includes('del 0 96 21'), 'a copy with keyswitches clears them too');
  const m = P.clipEdits(c, c.notes, 16, { start: 4, end: 8 }, adds, { mode: 'merge' });
  assert.deepEqual(m.lines, ['add 0 96 67 64 1'], 'merge only adds');
  assert.equal(m.rows.length, 6);
});

ok('clip edits honour the content offset (playStart) and the visible window', () => {
  const c = clip(4, 'Violas', 8, 16, [[0, 0, 50, 1, 90], [0, 96, 60, 1, 90], [0, 120, 62, 1, 90]], { playStart: 4, playStop: 20 });
  // arranger beat of x: 8 + x/24 - 4 -> x 0 is before the visible start (hidden), x 96 = beat 8, x 120 = beat 9
  const e = P.clipEdits(c, c.notes, 24, { start: 8, end: 9 }, [], { mode: 'overwrite' });
  assert.deepEqual(e.lines, ['del 0 96 60']);
});

const crawl = {
  stepsPerBeat: 24,
  result: [
    clip(1, 'Violins 1', 0, 32, [[0, 0, 72, 1, 100]]),
    clip(2, 'Violins 2', 0, 16, [[0, 0, 55, 1, 100], [0, 96, 57, 6, 100]]),
    clip(2, 'Violins 2', 16, 16, [[0, 0, 59, 1, 100]]),
    clip(3, 'Violas', 0, 8, [], { loop: true, loopLength: 8 }),
    clip(5, 'Cellos', 32, 8),
  ],
};
const clipEnd = (c, next) => A.clipEnd(c, next);

ok('plan: a paste over two clips of one track, the stay job is the first target\'s first clip', () => {
  const targets = [{ track: 'Violins 2', start: 12, end: 20, notes: [{ start: 12, dur: 1, pitch: 70, vel: 0.5 }, { start: 17, dur: 2, pitch: 72, vel: 0.5 }] }];
  const p = P.planPaste(crawl, targets, { clipEnd, measureBeats: 4 });
  assert.deepEqual(p.errors, []);
  assert.equal(p.jobs.length, 2);
  assert.equal(p.stay, p.jobs[0]);
  assert.deepEqual(p.jobs[0].lines, ['add 0 288 70 64 1']);
  assert.deepEqual(p.jobs[1].lines, ['del 0 0 59', 'add 0 24 72 64 2']);
  assert.deepEqual(P.batchLines(p.jobs, p.stay), ['goto 2 16 Violins%202', 'del 0 0 59', 'add 0 24 72 64 2', 'gotoStay 2 0 Violins%202', 'add 0 288 70 64 1']);
});

ok('plan: notes ringing in are shortened, rows of the live clip come from rowsOf', () => {
  const targets = [{ track: 'Violins 2', start: 8, end: 12, notes: [] }];
  const p = P.planPaste(crawl, targets, { clipEnd, measureBeats: 4 });
  assert.deepEqual(p.jobs[0].lines, ['dur 0 96 57 4'], 'an empty bar pasted in overwrite mode clears and trims');
  const live = P.planPaste(crawl, targets, { clipEnd, rowsOf: () => [[0, 192, 40, 1, 100]] });
  assert.deepEqual(live.jobs[0].lines, ['del 0 192 40']);
  assert.deepEqual(P.planPaste(crawl, targets, { clipEnd, mode: 'merge' }).jobs, [], 'merge with nothing to add: nothing to do');
});

ok('plan: missing clip, looping clip -> errors; nothing to do -> no job', () => {
  const p = P.planPaste(crawl, [
    { track: 'Cellos', start: 0, end: 4, notes: [{ start: 0, dur: 1, pitch: 48 }] },
    { track: 'Violas', start: 0, end: 4, notes: [{ start: 0, dur: 1, pitch: 60 }] },
    { track: 'Cellos', start: 8, end: 12, notes: [] },
  ], { clipEnd, measureBeats: 4 });
  assert.equal(p.errors.length, 1, JSON.stringify(p.errors));
  assert.match(p.errors[0].error, /No clip on Cellos at bar 1/);
  assert.deepEqual(p.jobs.map(j => j.track), ['Violas'], 'a clip that plays its loop once is fine; Cellos bars 3: nothing there');
  const loop = P.planPaste({ ...crawl, result: [clip(3, 'Violas', 0, 8, [], { loop: true, loopLength: 8 }), clip(3, 'Violas', 32, 8)].map((c, i) => i ? c : { ...c, length: 32 }) },
    [{ track: 'Violas', start: 0, end: 4, notes: [] }], { clipEnd, measureBeats: 4 });
  assert.match(loop.errors[0].error, /loops — a paste would repeat in every pass/);
});

ok('landed jobs follow the goto/stay results in batch order', () => {
  assert.deepEqual(P.landedJobs(['ok: goto A @ 0', 'error: goto B @ 4: No clip', 'ok: stay C @ 0'], 3), [true, false, true]);
  assert.deepEqual(P.landedJobs(['ok: goto A @ 0', 'error: stay C @ 0: gone', 'ok: home P @ 0'], 2), [true, false]);
  assert.deepEqual(P.landedJobs(['error: Stop playback first.'], 2), [false, false]);
});

ok('alias warning: another clip with the same notes and play range', () => {
  const a = clip(1, 'Horn', 0, 8, [[0, 0, 60, 1, 100]]), b = clip(1, 'Horn', 16, 8, [[0, 0, 60, 1, 100]]), c = clip(1, 'Horn', 32, 8, [[0, 0, 62, 1, 100]]);
  const w = P.aliasWarnings({ result: [a, b, c] }, [{ clip: a, track: 'Horn' }], 4);
  assert.equal(w.length, 1);
  assert.match(w[0], /^Horn bar 5 has the same notes as the Horn clip at bar 1 — if it is a clip alias it changed too/);
  assert.deepEqual(P.aliasWarnings({ result: [a, c] }, [{ clip: a, track: 'Horn' }], 4), []);
});

console.log(`passage-test OK (${n} cases)`);
