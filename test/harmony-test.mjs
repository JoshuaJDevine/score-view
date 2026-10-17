// Unit tests for web/features/harmony.js (Functional Color Theory analysis) on synthetic progressions,
// plus a timing run on the Mega Man 2 fixture.   node test/harmony-test.mjs
import assert from 'assert';
import { createRequire } from 'module';
import { loadFixtureScore } from './lib.mjs';

const require = createRequire(import.meta.url);
const H = require('../web/features/harmony.js');
const C = H.PALETTE;

let uid = 0;
// chords: [[pitches], beats?]; one part per voice so melodic context (non-chord tones) is realistic.
function score(chords, { keyFifths = 0, beats = 4, extra = [] } = {}) {
  const voices = [[], [], [], []];
  let t = 0;
  chords.forEach(c => {
    const [ps, len = beats] = Array.isArray(c[0]) ? c : [c];
    ps.slice().sort((a, b) => a - b).forEach((p, i) => voices[Math.min(i, 3)].push({ id: 'n' + (uid++), start: t, dur: len, pitch: p }));
    t += len;
  });
  const parts = voices.map((notes, i) => ({ name: ['Bass', 'Tenor', 'Alto', 'Soprano'][i], notes }));
  extra.forEach(e => parts.push(e));
  return { timeSig: { num: 4, den: 4 }, keyFifths, lengthBeats: t, parts };
}
const tr = (ps, d) => ps.map(p => p + d);
const I = [48, 64, 67, 72], IV = [53, 65, 69, 72], V = [43, 62, 67, 71], V7 = [43, 62, 65, 71], vi = [45, 64, 69, 72];
const ii7 = [50, 65, 69, 72];
const run = (sc) => H.analyzeFull(sc).regions.filter(r => r.root != null);
const romans = rs => rs.map(r => r.label);
const funcs = rs => rs.map(r => r.func);
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

test('I–IV–V–I in C major', () => {
  const rs = run(score([I, IV, V, I]));
  assert.deepEqual(romans(rs), ['I', 'IV', 'V', 'I']);
  assert.deepEqual(funcs(rs), ['tonic', 'subdominant', 'dominant', 'tonic']);
  assert.deepEqual(rs.map(r => H.funcColour(r.func)), [C.red, C.yellow, C.blue, C.red]);
  assert.equal(rs[0].keyName, 'C major');
});

test('I–IV–V–I in E♭ major', () => {
  const rs = run(score([I, IV, V, I].map(c => tr(c, 3)), { keyFifths: -3 }));
  assert.deepEqual(romans(rs), ['I', 'IV', 'V', 'I']);
  assert.deepEqual(funcs(rs), ['tonic', 'subdominant', 'dominant', 'tonic']);
  assert.equal(rs[0].keyName, 'E♭ major');
  assert.equal(rs[2].rootName, 'B♭');
});

test('ii7–V7–I = Green→Blue→Red, with a ii–V–I event and fulfilled resolution', () => {
  const an = H.analyzeFull(score([ii7, V7, I]));
  const rs = an.regions.filter(r => r.root != null);
  assert.deepEqual(romans(rs), ['ii⁷', 'V⁷', 'I']);
  assert.deepEqual(rs.map(r => H.funcColour(r.func)), [C.green, C.blue, C.red]);
  assert(an.events.some(e => e.type === 'ii-V-I'), 'ii-V-I event');
  assert(an.events.some(e => e.type === 'resolve' && e.cadence), 'V7→I cadence');
  assert(an.events.some(e => e.type === 'ending' && e.text === "we're home"));
});

test('deceptive V–vi = Blue→Orange', () => {
  const an = H.analyzeFull(score([I, IV, V7, vi]));
  const rs = an.regions.filter(r => r.root != null);
  assert.deepEqual(romans(rs), ['I', 'IV', 'V⁷', 'vi']);
  assert.equal(H.funcColour(rs[3].func), C.orange);
  assert(an.events.some(e => e.type === 'deceptive' && e.beat === rs[3].start), 'deceptive event');
});

test('V7/V with ♯4 is bright cyan; the ♯4 note is cyan', () => {
  const D7 = [50, 66, 69, 72];
  const sc5 = score([I, D7, V, I]);
  const an = H.analyzeFull(sc5);
  const rs = an.regions.filter(r => r.root != null);
  assert.deepEqual(romans(rs), ['I', 'V⁷/V', 'V', 'I']);
  assert.equal(rs[1].func, 'sharp');
  assert.equal(H.funcColour(rs[1].func), C.cyan);
  assert(rs[1].sharp4, '♯4 flagged');
  const fs = H.decorate(sc5, an, { enabled: true }).parts.flatMap(p => p.notes).find(n => n.pitch === 66);
  assert.equal(fs.color, C.cyan);
  assert(an.events.some(e => e.type === 'resolve' && e.beat === 8), 'V/V resolves to V');
});

test('♭VI borrowed: Orange chord, ♭3/♭6 tones magenta', () => {
  const bVI = [44, 63, 68, 72];
  const sc = score([I, bVI, V7, I]);
  const an = H.analyzeFull(sc);
  const rs = an.regions.filter(r => r.root != null);
  assert.deepEqual(romans(rs), ['I', '♭VI', 'V⁷', 'I']);
  assert.equal(H.funcColour(rs[1].func), C.orange);
  assert.equal(rs[1].borrowed, 'flat');
  const notes = H.decorate(sc, an, { enabled: true }).parts.flatMap(p => p.notes);
  assert.equal(notes.find(n => n.pitch === 63).color, C.magenta, 'E♭ magenta');
  assert.equal(notes.find(n => n.pitch === 44).color, C.magenta, 'A♭ magenta');
  assert.equal(notes.find(n => n.pitch === 72 && n.start === 4).color, C.orange, 'C (diatonic tone of ♭VI) orange');
});

test('Neapolitan sixth in C minor', () => {
  const i = [48, 63, 67, 72], N6 = [53, 61, 68, 77], Vm = [43, 62, 67, 71];
  const rs = run(score([i, N6, Vm, i], { keyFifths: -3 }));
  assert.equal(rs[0].keyName, 'C minor');
  assert.deepEqual(romans(rs), ['i', 'N⁶', 'V', 'i']);
  assert.equal(rs[1].func, 'flat');
  assert.equal(H.funcColour(rs[1].func), C.magenta);
});

test('German augmented sixth → V in C major', () => {
  const Ger = [44, 60, 63, 66];
  const I64 = [43, 60, 64, 72];
  const rs = run(score([I, Ger, I64, V7, I]));
  assert.deepEqual(romans(rs), ['I', 'Ger+6', 'I⁶₄', 'V⁷', 'I']);
  assert.equal(H.funcColour(rs[1].func), C.cyan);
  assert(rs[1].sharp4);
  assert.equal(rs[2].func, 'dominant', 'cadential 6/4 is Blue');
});

test('modulation to the dominant: G becomes the temporary tonic (Red)', () => {
  const G = tr(I, 7 - 12), C_in_G = IV.map(p => p - 12 + 7), D7 = [50, 66, 69, 72], Gend = [43, 59, 67, 74];
  const sc = score([I, IV, V7, I, vi, ii7, V7, I, [D7, 4], G, C_in_G, D7, G, [45, 64, 69, 72], D7, Gend]);
  const an = H.analyzeFull(sc);
  const rs = an.regions.filter(r => r.root != null);
  const last = rs[rs.length - 1];
  assert.equal(last.keyName, 'G major', 'ends in G: ' + rs.map(r => r.keyName + ' ' + r.label).join(', '));
  assert.equal(last.label, 'I');
  assert.equal(H.funcColour(last.func), C.red);
  assert.equal(rs[0].keyName, 'C major');
  assert(an.events.some(e => e.type === 'modulation' && e.to === 'G major'), 'modulation event');
});

test('passing and neighbour tones are neutral grey', () => {
  const sc = score([I, V, I]);
  const sop = sc.parts[3];
  sop.notes = [
    { id: 'p1', start: 0, dur: 1, pitch: 76 }, { id: 'p2', start: 1, dur: 1, pitch: 77 }, { id: 'p3', start: 2, dur: 1, pitch: 79 },
    { id: 'p4', start: 3, dur: 0.5, pitch: 81 }, { id: 'p5', start: 3.5, dur: 0.5, pitch: 79 },
    { id: 'p6', start: 4, dur: 4, pitch: 74 }, { id: 'p7', start: 8, dur: 4, pitch: 72 }];
  const an = H.analyzeFull(sc);
  assert.deepEqual(romans(an.regions.filter(r => r.root != null)), ['I', 'V', 'I']);
  assert.equal(an.notes.get('p2').nct, 'passing');
  assert.equal(an.notes.get('p4').nct, 'neighbour');
  const col = id => H.decorate(sc, an, { enabled: true }).parts[3].notes.find(n => n.id === id).color;
  assert.equal(col('p2'), C.grey);
  assert.equal(col('p4'), C.grey);
  assert.equal(col('p1'), C.red);
  assert.equal(col('p6'), C.blue);
});

test('existing note colours are never overwritten; ribbon directions are added', () => {
  const sc = score([I, V, I]);
  sc.parts[0].notes[0].color = '#ff0000';
  const out = H.decorate(sc, H.analyzeFull(sc), { enabled: true, mode: 'both', ribbon: true });
  assert.equal(out.parts[0].notes[0].color, '#ff0000');
  assert.equal(sc.parts[1].notes[0].color, undefined, 'input not mutated');
  assert.deepEqual(out.directions.map(d => d.text), ['C: I', 'V', 'I']);
});

test('tritone substitution ♭II7 is Blue', () => {
  const sub = [49, 65, 68, 71];
  const rs = run(score([ii7, sub, I]));
  assert.equal(rs[1].label, '♭II⁷');
  assert.equal(H.funcColour(rs[1].func), C.blue);
});

test('Blue ending = eternal question, Yellow ending = eternal journey', () => {
  assert(H.analyzeFull(score([I, IV, V])).events.some(e => e.type === 'ending' && e.text === 'eternal question'));
  assert(H.analyzeFull(score([I, V, IV])).events.some(e => e.type === 'ending' && e.text === 'eternal journey'));
});

test('snap and chord-tone stepping', () => {
  const an = H.analyzeFull(score([I, V7, I]));
  assert.equal(H.snapIn(an, 62, 1, 'chord'), 64);   // equidistant: prefers up
  assert.equal(H.snapIn(an, 63, 1, 'chord'), 64);
  assert.equal(H.snapIn(an, 61, 1, 'scale'), 62);
  assert.equal(H.snapIn(an, 69, 5, 'chord'), 71);   // A over G7: G or B, prefers up
  assert.equal(H.stepChordTone(an, 60, 0.5, 1), 64);
  assert.equal(H.stepChordTone(an, 67, 4.5, 1), 71);
  assert.equal(H.stepChordTone(an, 67, 4.5, -1), 65);
});

// ---- the whole Mega Man 2 fixture: timing and sanity
const mm = await loadFixtureScore();
global.ScoreBuilder = require('../web/score.js');
const mmScore = { timeSig: mm.timeSig, keyFifths: ScoreBuilder.detectFifths(mm.parts.flatMap(p => p.notes)), lengthBeats: mm.lengthBeats, parts: mm.parts };
global.ScoreBuilder = require('../web/score.js');
const t0 = performance.now();
const an = H.analyzeFull(mmScore);
const ms = performance.now() - t0;
const t1 = performance.now();
H.analyzeFull({ ...mmScore, parts: mmScore.parts.map(p => ({ ...p, notes: p.notes.slice() })) });
const cached = performance.now() - t1;
const counts = {};
an.regions.forEach(r => { counts[r.func] = (counts[r.func] || 0) + 1; });
console.log(`Mega Man 2: ${an.regions.length} regions, home ${an.homeName}, keys ${an.keys.map(k => k.name + '@' + k.start).join(', ')}`);
console.log('  functions', counts, 'events', an.events.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {}));
console.log(`  analysis ${ms.toFixed(1)} ms (cold), ${cached.toFixed(1)} ms (cached by content)`);
test('Mega Man 2 analysis under 100 ms', () => assert(ms < 100, ms + ' ms'));
console.log(`${passed} passed`);
