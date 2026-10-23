// Unit test of listening while playing (web/features/arrangement-listen.js) and its out-of-date reason in
// web/features/arrangement.js: onset matching per bar with jitter and bar-line tolerance, keyswitches left out, the
// per-track baseline (a Note FX that changes the notes makes a track ignored), flags only for consistent
// disagreement (the same bar on two passes, or two bars in one pass), silent / muted tracks, loops, resets.
//   node test/arrangement-listen-test.mjs
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const L = require('../web/features/arrangement-listen.js');
const A = require('../web/features/arrangement.js');

// ---- onsets and bar scores
assert.deepEqual(L.expectedOnsets([{ start: 1, pitch: 60 }, { start: 0, pitch: 12 }, { start: 0, pitch: 64 }]),
  [{ beat: 0, key: 64 }, { beat: 1, key: 60 }], 'keyswitches below C1 are left out, sorted');
assert.deepEqual(L.heardOnsets([[1, 1, 60, 90, 2, 0, 1], [2, 0, 60, 0, 2.5, 0, 1], [3, 1, 20, 90, 2, 0, 1], [4, 1, 62, 90, 3, 0, 0], [5, 1, 64, 0, 3, 0, 1]]),
  [{ beat: 2, key: 60 }], 'note-ons while playing only, no keyswitches, no velocity 0');

const bars = n => Array.from({ length: n }, (_, k) => ({ bar: k + 1, start: k * 4, end: k * 4 + 4 }));
const on = (beat, key) => ({ beat, key });
const exp = [on(0, 60), on(1, 62), on(2, 64), on(3, 65), on(4, 67), on(6, 69)];
let s = L.barScores(exp, exp, bars(2));
assert.deepEqual(s.map(x => [x.bar, x.score]), [[1, 1], [2, 1]], 'identical');
s = L.barScores(exp, exp.map(o => on(o.beat + 0.1, o.key)), bars(2));
assert.deepEqual(s.map(x => x.score), [1, 1], 'jitter 0.1 beat matches');
s = L.barScores(exp, exp.map(o => on(o.beat - 0.12, o.key)), bars(2));
assert.deepEqual(s.map(x => x.score), [1, 1], 'early by 0.12: the bar-2 note stamped in bar 1 still matches (counts in bar 2)');
s = L.barScores(exp, exp.map(o => on(o.beat + 0.3, o.key)), bars(2));
assert.deepEqual(s.map(x => x.score), [0, 0], '0.3 beat late is a different note');
s = L.barScores(exp, exp.map(o => (o.beat === 2 ? on(2, 63) : o)), bars(2));
assert.equal(s[0].exp, 4); assert.equal(s[0].heard, 4); assert.equal(s[0].matched, 3); assert.equal(s[0].score, 0.75);
assert.equal(s[1].score, 1);
s = L.barScores([on(0, 60)], [on(0, 60), on(0, 60)], bars(1));
assert.equal(s[0].score, 2 / 3, 'a doubled note is one match and one extra');
assert.deepEqual(L.barScores([], [], bars(2)), [], 'silent bars are not scored');
assert.deepEqual(L.barScores([], [on(5, 60)], bars(2)).map(x => [x.bar, x.score]), [[2, 0]], 'a note where the read has none');

// ---- the listener over simulated playback
// A song of 8 bars per track: a note on every beat. heard(name, beat, key) -> [{key, beat}] lets a test change playback.
const BARS = 8, BB = 4;
const song = { Piano: [], Strings: [], Synth: [] };
for (let b = 0; b < BARS * BB; b++) {
  song.Piano.push(on(b, 60 + (b % 5)));
  song.Strings.push(on(b + 0.5, 48 + (b % 3)));
  if (b % 2 === 0) song.Synth.push(on(b, 72));
}
const expected = () => new Map(Object.entries(song).map(([n, list]) => [n, list.slice()]));
let seq = 0;
// Plays from..to in 0.5-beat responses (like 250 ms polls at 120 bpm); returns the tracks flagged on the way.
function play(listener, { from = 0, to = BARS * BB + 1, heard = (n, o) => [o], skip = new Set(), jitter = () => 0, ctx = {} } = {}) {
  const flagged = [];
  const index = { Piano: 0, Strings: 1, Synth: 2 };
  for (let pos = from + 0.5; pos <= to + 1e-9; pos += 0.5) {
    const tracks = Object.entries(song).map(([name, list]) => ({
      index: index[name], name,
      events: list.filter(o => o.beat >= pos - 0.5 && o.beat < pos).flatMap(o => heard(name, o) || [])
        .map(h => [++seq, h.on === false ? 0 : 1, h.key, 100, h.beat + jitter(), 0, 1]),
    })).filter(t => t.events.length);
    flagged.push(...listener.feed({ playing: true, pos, tracks }, { expected: expected(), barBeats: BB, skip, ...ctx }));
  }
  listener.feed({ playing: false, pos: to }, null);
  return flagged;
}

let li = L.createListener();
assert.deepEqual(play(li), [], 'pass 1, unchanged: nothing flagged');
let info = li.info();
assert.equal(info.tracks.Piano.baseline, 1);
assert.equal(info.tracks.Synth.baseline, 1);
assert.equal(info.pass, 1);

// bar 3 of Strings changed in Bitwig (one note now a different pitch): once is not enough, twice is
const changed = (n, o) => (n === 'Strings' && o.beat >= 8 && o.beat < 9 ? [on(o.beat, o.key + 1)] : [o]);
assert.deepEqual(play(li, { heard: changed }), [], 'one bar differs once: not yet');
assert.deepEqual(li.info().tracks.Strings.bad, [3]);
assert.deepEqual(play(li, { heard: changed }), ['Strings'], 'the same bar on the next pass: Strings changed');
assert.deepEqual([...li.flagged()], [['Strings', 3]]);
let st = A.staleInfo({ crawl: { result: [] }, heard: li.flagged() });
assert.deepEqual(st.reasons, ['Strings changed at bar 3 (heard while playing)']);
assert.deepEqual(st.refresh, ['Strings'], 'offered for a targeted re-read');
st = A.staleInfo({ crawl: { result: [] }, heard: li.flagged(), edited: new Set(['Strings']) });
assert.deepEqual(st.reasons, [], 'a track edited from Score View is overlaid live');
li.resetTracks(['Strings']);
assert.deepEqual([...li.flagged()], [], 're-read: the flag goes');
assert.equal(li.info().tracks.Strings.baseline, 1, '... the baseline stays');

// two bars differ in one pass: flagged at the first of them right away
li = L.createListener();
play(li);
const twoBars = (n, o) => (n === 'Piano' && o.beat >= 20 ? [on(o.beat, o.key + 2)] : [o]);
assert.deepEqual(play(li, { heard: twoBars }), ['Piano']);
assert.equal(li.flagged().get('Piano'), 6);

// a changed clip before the first pass: the baseline (median) is still learned from the agreeing bars
li = L.createListener();
assert.deepEqual(play(li, { heard: (n, o) => (n === 'Synth' && o.beat >= 24 ? [] : [o]) }), ['Synth'], 'bars 7-8 silent on the first pass');
assert.equal(li.flagged().get('Synth'), 7);

// timing jitter of up to ±0.12 beat everywhere: no flags
li = L.createListener();
let r = 1;
const jitter = () => { r = (r * 16807) % 2147483647; return ((r / 2147483647) - 0.5) * 0.24; };
assert.deepEqual(play(li, { jitter }).concat(play(li, { jitter }), play(li, { jitter })), [], 'jitter is tolerated');

// an articulation map's keyswitch before every note (below C1): ignored, baseline 1
li = L.createListener();
const ks = (n, o) => (n === 'Strings' ? [on(o.beat, 12 + (o.key % 3)), o] : [o]);
play(li, { heard: ks });
assert.equal(li.info().tracks.Strings.baseline, 1, 'keyswitches do not count');
// a Note FX that transposes everything (the observer reports after it): the track is ignored, never flagged
li = L.createListener();
const fx = (n, o) => (n === 'Synth' ? [on(o.beat, o.key + 12)] : [o]);
play(li, { heard: fx });
assert.equal(li.info().tracks.Synth.ignored, true);
assert.deepEqual(play(li, { heard: (n, o) => (n === 'Synth' ? (o.beat >= 8 ? [] : [on(o.beat, o.key + 12)]) : [o]) }), [], 'ignored for good');
// a harmoniser adding a third to every note: baseline 2/3 (low but usable), deviations from it still count
li = L.createListener();
const third = (n, o) => (n === 'Piano' ? [o, on(o.beat, o.key + 4)] : [o]);
play(li, { heard: third });
assert.ok(Math.abs(li.info().tracks.Piano.baseline - 2 / 3) < 1e-3 && !li.info().tracks.Piano.ignored);
assert.deepEqual(play(li, { heard: third }), []);

// a muted (or silent) track: nothing heard says nothing about its clips
li = L.createListener();
play(li);
assert.deepEqual(play(li, { heard: (n, o) => (n === 'Piano' ? [] : [o]) }).concat(play(li, { heard: (n, o) => (n === 'Piano' ? [] : [o]) })), []);
assert.deepEqual(li.info().tracks.Piano.bad, []);
// skipped tracks (live clip, edited, muted per Bitwig) are not judged at all
li = L.createListener();
play(li, { skip: new Set(['Piano']) });
assert.equal(li.info().tracks.Piano, undefined);

// passes: starting mid-song judges only bars heard from their start; a jump back starts a new pass
li = L.createListener();
play(li, { from: 9, to: 30 });
assert.equal(li.info().pass, 1);
assert.equal(li.info().tracks.Piano.baseline, 1, 'bars 3 (from beat 9) to 7 judged: the partly heard bar 3 matches too');
const loop = L.createListener();
for (let k = 0; k < 3; k++) {
  for (let pos = 0.5; pos <= 16.5; pos += 0.5) {
    const tracks = [{ index: 0, name: 'Piano', events: song.Piano.filter(o => o.beat >= pos - 0.5 && o.beat < pos).map(o => [++seq, 1, o.key, 100, o.beat, 0, 1]) }];
    loop.feed({ playing: true, pos: pos > 16 ? pos - 16 : pos, tracks }, { expected: expected(), barBeats: BB, skip: new Set() });
  }
}
assert.ok(loop.info().pass >= 3, 'each loop pass is a pass');
assert.equal(loop.info().tracks.Piano.flagged, null);
// a new read forgets everything
li.reset();
assert.deepEqual(li.info().tracks, {});

console.log('arrangement-listen-test: all passed');
