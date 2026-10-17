// Unit tests for the pure Inspire core (web/features/inspire.js) and its mood library. node test/inspire-test.mjs
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const C = require('../web/features/inspire.js');
const L = require('../web/features/inspire-library.js');
const pc = p => ((p % 12) + 12) % 12;

// Numerals
let c = C.parseNumeral('♭II', 'minor');
assert.equal(c.root, 1); assert.deepEqual(c.tones, [0, 4, 7]);
c = C.parseNumeral('V', 'minor');
assert.equal(c.root, 7); assert.deepEqual(c.tones, [0, 4, 7], 'uppercase V in minor is a major triad');
c = C.parseNumeral('vii°', 'major');
assert.equal(c.root, 11); assert.deepEqual(c.tones, [0, 3, 6]);
c = C.parseNumeral('Vsus4', 'major');
assert.deepEqual(c.tones, [0, 5, 7]);
c = C.parseNumeral('imaj7', 'minor');
assert.deepEqual(c.tones, [0, 3, 7, 11]);
c = C.parseNumeral('Iadd9', 'major');
assert.deepEqual(c.tones, [0, 4, 7, 2]);
assert.throws(() => C.parseNumeral('X', 'major'));
// Every library numeral parses
for (const m of L.MOODS) for (const p of m.progressions) p.forEach(n => C.parseNumeral(n, m.mode));
assert.ok(L.MOODS.length >= 3);

// Plans: in range, fill the bars, chord tones only, root + third present, smooth voice leading
const BAR = 96, RANGE = [55, 93];
for (const mood of L.MOODS) {
  for (let seed = 1; seed <= mood.progressions.length; seed++) {
    const tonic = mood.mode === 'minor' ? 9 : 0, bars = 8, start = 2 * BAR;
    const p = C.plan({ mood, tonic, bars, barSteps: BAR, startStep: start, range: RANGE, seed });
    const end = start + bars * BAR;
    assert.equal(p.chords.length, Math.ceil(bars / mood.barsPerChord), `${mood.id}/${seed} chord count`);
    assert.deepEqual(p.progression, mood.progressions[(seed - 1) % mood.progressions.length]);
    for (const n of p.notes) {
      assert.ok(n.y >= RANGE[0] && n.y <= RANGE[1], `${mood.id}/${seed} pitch ${n.y} in range`);
      assert.ok(n.x >= start && n.x + n.d <= end, `${mood.id}/${seed} note inside the bars`);
      assert.ok(n.d > 0 && n.vel === mood.velocity);
    }
    p.chords.forEach((ch, i) => {
      const chord = C.parseNumeral(ch.numeral, mood.mode), root = pc(tonic + chord.root);
      const allowed = new Set(chord.tones.map(t => pc(root + t)));
      const sounding = p.notes.filter(n => n.x <= ch.x && n.x + n.d > ch.x);
      const upper = mood.pedal ? sounding.filter(n => n.x + n.d < end || n.x !== start || n.y !== Math.min(...sounding.map(s => s.y))) : sounding;
      assert.equal(sounding.length, mood.voices + (mood.pedal ? 1 : 0), `${mood.id}/${seed} chord ${i} voice count`);
      const pcs = upper.map(n => pc(n.y));
      pcs.forEach(x => assert.ok(allowed.has(x), `${mood.id}/${seed} chord ${i} (${ch.name}) has only chord tones`));
      assert.ok(pcs.includes(root), `${mood.id}/${seed} chord ${i} has its root`);
      assert.ok(pcs.includes(pc(root + chord.third)), `${mood.id}/${seed} chord ${i} has its third`);
    });
    if (mood.pedal) {
      const ped = p.notes.find(n => n.x === start && n.d === bars * BAR);
      assert.ok(ped && pc(ped.y) === tonic, `${mood.id} holds a tonic pedal`);
    }
  }
}

// Voice leading: from one chord to the next no upper voice leaps more than a fifth (hopeful, seed 1)
{
  const mood = L.byId('hopeful');
  const p = C.plan({ mood, tonic: 0, bars: 4, barSteps: BAR, startStep: 0, range: RANGE, seed: 1 });
  const at = x => p.notes.filter(n => n.x <= x && n.x + n.d > x).map(n => n.y).sort((a, b) => a - b);
  for (let b = 1; b < 4; b++) {
    const a = at((b - 1) * BAR), z = at(b * BAR);
    a.forEach((y, i) => assert.ok(Math.abs(y - z[i]) <= 7, `voice ${i} leaps ${y}→${z[i]} at bar ${b + 1}`));
  }
  // Common tones are held, not re-struck
  const g = p.notes.filter(n => n.y === 79);
  assert.ok(g.some(n => n.d > BAR), 'the common G is held across the bar line');
}

// Same seed = same result; Again (next seed) gives another progression
const a1 = C.plan({ mood: 'melancholy', tonic: 9, bars: 8, barSteps: BAR, startStep: 0, range: RANGE, seed: 1 });
const a2 = C.plan({ mood: 'melancholy', tonic: 9, bars: 8, barSteps: BAR, startStep: 0, range: RANGE, seed: 1 });
const b1 = C.plan({ mood: 'melancholy', tonic: 9, bars: 8, barSteps: BAR, startStep: 0, range: RANGE, seed: 2 });
assert.deepEqual(a1.notes, a2.notes);
assert.notDeepEqual(a1.progression, b1.progression);

// Chord names
assert.deepEqual(C.plan({ mood: 'suspense', tonic: 9, bars: 8, barSteps: BAR, startStep: 0, range: RANGE, seed: 2 }).chords.map(c => c.name),
  ['Am', 'Am(maj7)', 'Am7', 'Am6']);

// Partial last chord: 3 bars of a 2-bar harmonic rhythm
const part = C.plan({ mood: 'melancholy', tonic: 9, bars: 3, barSteps: BAR, startStep: 0, range: RANGE, seed: 1 });
assert.equal(part.chords.length, 2);
assert.ok(part.notes.every(n => n.x + n.d <= 3 * BAR));

// ---- Melody over the chords
for (const mood of L.MOODS) {
  for (let seed = 1; seed <= 4; seed++) {
    const tonic = mood.mode === 'minor' ? 9 : 0, bars = 8, start = 0, range = [60, 96];
    const pad = C.plan({ mood, tonic, bars, barSteps: BAR, startStep: start, range: RANGE, seed });
    const m = C.planMelody({ mood, chords: pad.chords, tonic, startStep: start, bars, barSteps: BAR, spb: 24, range, seed });
    const tag = mood.id + '/' + seed;
    const win = C.melodyWindow(range, mood.melody.register);
    assert.ok(m.notes.length >= bars, tag + ' writes a line, got ' + m.notes.length);
    const xs = new Set();
    for (const n of m.notes) {
      assert.ok(n.y >= win.lo && n.y <= win.hi, tag + ' pitch inside the register window');
      assert.ok(n.x >= start && n.x + n.d <= start + bars * BAR && n.d > 0, tag + ' inside the bars');
      assert.ok(n.vel >= 1 && n.vel <= 127);
      assert.ok(!xs.has(n.x), tag + ' monophonic'); xs.add(n.x);
    }
    const sorted = [...m.notes].sort((a, b) => a.x - b.x);
    sorted.forEach((n, i) => assert.ok(i === 0 || sorted[i - 1].x + sorted[i - 1].d <= n.x, tag + ' no overlaps'));
    // Downbeats: a chord tone, or a sigh (a step above, resolving down onto a chord tone half-way)
    const chordAt = x => pad.chords.find(c => c.x <= x && x < c.end);
    for (const n of sorted.filter(n => n.x % BAR === 0)) {
      const ch = chordAt(n.x), next = sorted.find(q => q.x === n.x + n.d);
      const ok = ch.pcs.includes(pc(n.y)) || (next && next.y < n.y && n.y - next.y <= 2 && ch.pcs.includes(pc(next.y)));
      assert.ok(ok, `${tag} downbeat ${n.x / BAR + 1} is a chord tone or a resolving sigh`);
    }
    // Phrase ends (last note of bars 4 and 8) land on chord tones
    for (const b of [4, 8]) {
      const last = sorted.filter(n => n.x < b * BAR).pop();
      assert.ok(chordAt(last.x).pcs.includes(pc(last.y)), `${tag} phrase ending at bar ${b} on a chord tone`);
    }
    // Leaps stay singable
    sorted.forEach((n, i) => i && assert.ok(Math.abs(n.y - sorted[i - 1].y) <= 12, tag + ' no leap beyond an octave'));
  }
}
{ // character: suspense has rests; melancholy sighs; same seed same melody
  const mk = (id, seed) => { const mood = L.byId(id), tonic = 9; const pad = C.plan({ mood, tonic, bars: 8, barSteps: BAR, startStep: 0, range: RANGE, seed });
    return C.planMelody({ mood, chords: pad.chords, tonic, startStep: 0, bars: 8, barSteps: BAR, spb: 24, range: [60, 96], seed }).notes; };
  const sus = mk('suspense', 1);
  assert.ok(sus.reduce((a, n) => a + n.d, 0) < 8 * BAR * 0.9, 'suspense leaves rests');
  assert.deepEqual(mk('melancholy', 3), mk('melancholy', 3));
  assert.notDeepEqual(mk('melancholy', 3), mk('melancholy', 4));
}
assert.deepEqual([...C.localScale([9, 11, 0, 2, 4, 5, 7], [4, 8, 11])].sort((a, b) => a - b), [0, 2, 4, 5, 8, 9, 11], 'V in A minor raises G to G♯');

// ---- Continue the phrase: answer progressions, lead-on voicing, melody that ends on the tonic
{
  const h = L.byId('hopeful'), q = ['IVadd9', 'Iadd9', 'V', 'vi', 'IVadd9', 'Iadd9', 'V', 'vi'];
  for (let seed = 1; seed <= h.answers.length; seed++) {
    const a = C.answerProgression(h, q, 8, seed, true);
    assert.equal(a.length, 8);
    assert.deepEqual(a.slice(0, 4), q.slice(0, 4), 'parallel: the opening comes back');
    assert.deepEqual(a.slice(-h.answers[seed - 1].length), h.answers[seed - 1], 'ends with the cadential tail');
    assert.match(a[7], /^I/, 'hopeful answers end on I');
  }
  assert.notDeepEqual(C.answerProgression(h, q, 8, 2, false).slice(0, 4), q.slice(0, 4), 'contrasting opening differs');
  assert.deepEqual(C.answerProgression(h, q, 2, 1, true), ['Iadd9', 'Iadd9'], 'short answer: the tail only');
  const m = L.byId('melancholy');
  assert.equal(C.answerProgression(m, null, 4, 1, true).slice(-1)[0], 'i');
  // Lead-on voicing: the first chord of the answer moves smoothly from the question's last chord
  const prev = [69, 72, 76, 79]; // Am(add G) voicing at the end of the question
  const pad = C.plan({ mood: h, tonic: 0, bars: 8, barSteps: BAR, startStep: 0, range: RANGE, seed: 1, progression: C.answerProgression(h, q, 8, 1, true), prev });
  const first = pad.notes.filter(n => n.x === 0).map(n => n.y).sort((a, b) => a - b);
  assert.ok(first.reduce((s, y, i) => s + Math.abs(y - prev[i]), 0) <= 8, 'answer starts close to the last voicing of the question: ' + first);
  assert.equal(pad.chords[7].numeral, 'Iadd9');
  // Melody: final note forced to the tonic, phrase continues from the given pitch
  for (let seed = 1; seed <= 4; seed++) {
    const mel = C.planMelody({ mood: h, chords: pad.chords, tonic: 0, startStep: 2 * BAR, bars: 6, barSteps: BAR, spb: 24, range: [60, 96], seed, prev: 76, barOffset: 2, finalPc: 0 });
    const s = [...mel.notes].sort((a, b) => a.x - b.x);
    assert.ok(s[0].x >= 2 * BAR, 'starts after the restated motif');
    assert.ok(Math.abs(s[0].y - 76) <= 7, 'connects to the previous note');
    assert.equal(pc(s[s.length - 1].y), 0, 'seed ' + seed + ': ends on the tonic');
  }
}

console.log('inspire-test OK');
