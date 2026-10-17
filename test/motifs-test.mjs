// Unit tests for the pure motif logic in web/features/motifs.js (no browser).
import assert from 'assert';
import { createRequire } from 'module';
const M = createRequire(import.meta.url)('../web/features/motifs.js');
const spb = 24, C = { spb, fifths: 0 };
const n = (x, y, d = 0.5, vel = 100) => ({ ch: 0, x, y, d, vel });
const simple = ns => ns.map(q => [q.x, q.y, q.d]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const applied = (clip, r) => simple(M.plan(clip, r).notes);

// Replays edit lines on a clip; fails if a move/add would land on a note that is still there.
function simulate(clip, lines) {
  const m = new Map(clip.map(q => [q.ch + '_' + q.x + '_' + q.y, { ...q }]));
  for (const l of lines) {
    const [c, ...a] = l.split(' '); const v = a.map(Number); const k = v[0] + '_' + v[1] + '_' + v[2];
    if (c === 'del') { assert(m.has(k), 'del of missing ' + l); m.delete(k); }
    if (c === 'move') {
      const q = m.get(k); assert(q, 'move of missing ' + l);
      const nk = v[0] + '_' + (v[1] + v[3]) + '_' + (v[2] + v[4]);
      assert(!m.has(nk), 'move onto existing note ' + l);
      m.delete(k); m.set(nk, { ...q, x: v[1] + v[3], y: v[2] + v[4] });
    }
    if (c === 'add') { assert(!m.has(k), 'add over existing note ' + l); m.set(k, { ch: v[0], x: v[1], y: v[2], vel: v[3], d: v[4] }); }
  }
  return simple([...m.values()]);
}

// Diatonic spelling: chromatic notes keep their sharp through diatonic moves.
assert.equal(M.diaShift(72, 1, 0), 74);
assert.equal(M.diaShift(76, 1, 0), 77);   // E -> F in C
assert.equal(M.diaShift(61, 1, 0), 63);   // C# -> D#
assert.equal(M.diaShift(66, 1, 1), 67);   // F# -> G in G major
assert.equal(M.diaShift(72, -2, 0), 69);  // third below C = A
assert.equal(M.diaShift(72, -5, 0), 64);  // sixth below C = E
assert.equal(M.diaShift(62, -5, -2), 53); // sixth below D in Bb = F

const fig = [n(0, 72), n(12, 74), n(24, 76), n(36, 79)]; // C D E G eighths, C major

// Sequence: copy 2 beats later, a step up.
let r = M.ops.sequence(fig, { ...C, dir: 1 });
assert.deepEqual(simple(r.adds), [[48, 74, .5], [60, 76, .5], [72, 77, .5], [84, 81, .5]]);
// Figure length rounds up to the beat: a 1.25-beat figure sequences 2 beats later.
assert.deepEqual(simple(M.ops.sequence([n(0, 60, 1), n(24, 62, .25)], { ...C, dir: -1 }).adds), [[48, 59, 1], [72, 60, .25]]);

// Inversion around the first note.
assert.deepEqual(applied(fig, M.ops.invert(fig, C)), [[0, 72, .5], [12, 71, .5], [24, 69, .5], [36, 65, .5]]);
assert.deepEqual(applied(fig, M.ops.invert(fig, { ...C, chromatic: true })), [[0, 72, .5], [12, 70, .5], [24, 68, .5], [36, 65, .5]]);

// Retrograde reverses rhythm: C(1) D(.5) E(.5) -> E(.5) D(.5) C(1).
const rh = [n(0, 72, 1), n(24, 74), n(36, 76)];
assert.deepEqual(applied(rh, M.ops.retrograde(rh, C)), [[0, 76, .5], [12, 74, .5], [24, 72, 1]]);

// Retrograde with a cycle (C D C): one note goes del+add, the rest move; never lands on an unmoved note.
const cyc = [n(0, 72), n(12, 74, .25), n(24, 72)];
let p = M.plan(cyc, M.ops.retrograde(cyc, C));
assert.deepEqual(simple(p.notes), [[0, 72, .5], [18, 74, .25], [24, 72, .5]]);
assert.deepEqual(simulate(cyc, p.lines), simple(p.notes));
// Chromatic inversion that swaps two notes of a chord: ordered safely.
const sw = [n(0, 72), n(12, 74), n(12, 70)];
p = M.plan(sw, M.ops.invert(sw, { ...C, chromatic: true }));
assert.deepEqual(simulate(sw, p.lines), simple(p.notes));
assert.deepEqual(simple(p.notes), [[0, 72, .5], [12, 70, .5], [12, 74, .5]]);
// A chain of moves (each lands where the next one starts) is ordered without falling back to del+add.
const chain = [n(0, 60, 1), n(24, 60, 1), n(48, 60, 1)];
p = M.plan(chain, { moves: chain.map(q => ({ from: q, to: { ...q, x: q.x + 24 } })) });
assert(p.lines.every(l => l.startsWith('move')), p.lines.join('|'));
assert.deepEqual(simulate(chain, p.lines), [[24, 60, 1], [48, 60, 1], [72, 60, 1]]);

// Augment / diminish relative to the figure start (here starting at beat 1).
const off = fig.map(q => ({ ...q, x: q.x + 24 }));
p = M.plan(off, M.ops.scaleTime(off, { ...C, factor: 2 }));
assert.deepEqual(simple(p.notes), [[24, 72, 1], [48, 74, 1], [72, 76, 1], [96, 79, 1]]);
assert.deepEqual(simulate(off, p.lines), simple(p.notes));
p = M.plan(off, M.ops.scaleTime(off, { ...C, factor: 0.5 }));
assert.deepEqual(simple(p.notes), [[24, 72, .25], [30, 74, .25], [36, 76, .25], [42, 79, .25]]);
assert.deepEqual(simulate(off, p.lines), simple(p.notes));

// Doubling and harmonising (additive): collisions with existing notes are skipped, not overwritten.
const clip = [...fig, n(12, 62, 2, 50)];
p = M.plan(clip, M.ops.transpose(fig, { semis: -12 }));
assert.equal(p.skipped, 1);
assert(!p.lines.some(l => l.startsWith('add 0 12 62')));
assert.deepEqual(p.ids, ['L0_0_60', 'L0_12_62', 'L0_24_64', 'L0_36_67']);
assert.deepEqual(simple(M.ops.diatonic(fig, { ...C, steps: -2 }).adds).map(q => q[1]), [69, 71, 72, 76]);
assert.deepEqual(simple(M.ops.diatonic(fig, { ...C, steps: -5 }).adds).map(q => q[1]), [64, 65, 67, 71]);

// Range: in-place ops refuse to leave the MIDI range; additive ops drop the excess.
const hi = [n(0, 120), n(12, 5)];
assert(M.plan(hi, M.ops.invert(hi, { ...C, chromatic: true })).error);
p = M.plan([n(0, 120)], M.ops.transpose([n(0, 120)], { semis: 12 }));
assert.equal(p.lines.length, 0); assert.equal(p.skipped, 1);

// Harmony snap hook is applied to generated pitches (beat is passed in clip beats).
const seen = [];
r = M.ops.sequence(fig, { ...C, dir: 1, snap: (y, b) => { seen.push(b); return y === 77 ? 76 : y; } });
assert.deepEqual(r.adds.map(q => q.y), [74, 76, 76, 81]);
assert.deepEqual(seen, [2, 2.5, 3, 3.5]);

// Motif library round trip: transposed diatonically to a new start pitch / key.
const mot = M.makeMotif('Fate', fig, spb, 0);
assert.deepEqual(mot.notes.map(q => q.steps), [0, 1, 2, 4]);
assert.deepEqual(mot.notes.map(q => q.semis), [0, 2, 4, 7]);
r = M.placeMotif(mot, { x: 96, pitch: 76, ch: 0, spb, fifths: 0 }); // from E in C: E F G B
assert.deepEqual(simple(r.adds), [[96, 76, .5], [108, 77, .5], [120, 79, .5], [132, 83, .5]]);
r = M.placeMotif(mot, { x: 0, pitch: 67, ch: 0, spb, fifths: 1 }); // from G in G major: G A B D
assert.deepEqual(r.adds.map(q => q.y), [67, 69, 71, 74]);
console.log('motifs unit tests OK');
