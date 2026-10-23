// Render dynamics, the pure parts (no browser): typing, the marks document, the level model and hairpin shapes, curve
// points (density, variation, dual-control lag), library profiles, ops, velocities ("both ways"), and that marks with
// ids engrave and keep their ids in Verovio's SVG.
//   node test/dynamics-test.mjs
import assert from 'assert';
import { createRequire } from 'module';
import { ScoreBuilder, renderMEI } from './lib.mjs';

const require = createRequire(import.meta.url);
const D = require('../web/features/dynamics.js');
const LP = require('../web/features/library-profiles.js');
let passed = 0;
const ok = name => { passed++; console.log('  ok ' + name); };
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---- typing
{
  assert.deepEqual(D.parseEntry('p<f').tokens, [{ dyn: 'p' }, { hairpin: 'cres' }, { dyn: 'f' }]);
  assert.deepEqual(D.parseEntry(' MF > ').tokens, [{ dyn: 'mf' }, { hairpin: 'dim' }]);
  assert.deepEqual(D.parseEntry('<>').tokens, [{ hairpin: 'messa' }]);
  assert.deepEqual(D.parseEntry('fp').tokens, [{ dyn: 'fp' }], 'fp is one mark, not f + p');
  assert.deepEqual(D.parseEntry('sffz').tokens, [{ dyn: 'sffz' }]);
  assert.deepEqual(D.parseEntry('cresc.').tokens, [{ hairpin: 'cres' }]);
  assert.match(D.parseEntry('pq').error, /Unknown dynamic "q"/);
  assert.ok(D.parseEntry('').error);
  ok('parseEntry: marks, hairpins, words, errors');

  const span = { start: 16, end: 24 };
  assert.deepEqual(D.planEntry(D.parseEntry('p<f').tokens, span),
    { marks: [{ beat: 16, text: 'p' }, { beat: 24, text: 'f' }], hairpins: [{ start: 16, end: 24, form: 'cres' }] });
  const two = D.planEntry(D.parseEntry('p<f>p').tokens, span);
  assert.deepEqual(two.hairpins.map(h => [h.start, h.end, h.form]), [[16, 20, 'cres'], [20, 24, 'dim']]);
  assert.deepEqual(two.marks.map(m => [m.beat, m.text]), [[16, 'p'], [20, 'f'], [24, 'p']]);
  assert.deepEqual(D.planEntry(D.parseEntry('mf').tokens, span).marks, [{ beat: 16, text: 'mf' }]);
  assert.equal(D.planEntry(D.parseEntry('<>').tokens, span).hairpins[0].shape, 'messa');
  ok('planEntry: Dorico-style placement over the selection');
}

// ---- the marks document
{
  const doc = D.emptyDoc();
  D.addEntry(doc, 'Violins', D.planEntry(D.parseEntry('p<f').tokens, { start: 0, end: 8 }), { clip: 0 });
  D.addEntry(doc, 'Violins', D.planEntry(D.parseEntry('mp').tokens, { start: 0, end: 4 }));
  const t = doc.tracks.Violins;
  assert.deepEqual(t.marks.map(m => [m.beat, m.text]), [[0, 'mp'], [8, 'f']], 'a mark replaces the one at the same beat');
  D.addEntry(doc, 'Violins', D.planEntry(D.parseEntry('>').tokens, { start: 4, end: 12 }));
  assert.deepEqual(t.hairpins.map(h => [h.start, h.end, h.form]), [[4, 12, 'dim']], 'a hairpin replaces the ones it overlaps');
  const round = D.normalizeDoc(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(round, doc, 'JSON round trip');
  assert.deepEqual(D.normalizeDoc({ tracks: { X: { marks: [{ beat: 1, text: 'zz' }], hairpins: [{ start: 2, end: 1 }] } } }), D.emptyDoc(), 'junk is dropped');
  assert.equal(D.findItem(doc, t.hairpins[0].id).kind, 'hairpin');
  assert.equal(D.removeRange(doc, 'Violins', 7, 9), 2, 'f at 8 and the hairpin over 4–12');
  assert.equal(D.removeIds(doc, [doc.tracks.Violins.marks[0].id]), 1);
  assert.deepEqual(doc.tracks, {}, 'an empty track is dropped');
  ok('marks document: add / replace / remove / normalize');
}

// ---- level model and shapes
{
  const m = D.levelModel({ marks: [{ beat: 0, text: 'p' }, { beat: 8, text: 'f' }], hairpins: [{ start: 0, end: 8, form: 'cres' }] });
  assert.ok(near(m.at(0), D.LEVELS.p) && near(m.at(8), D.LEVELS.f) && near(m.at(12), D.LEVELS.f));
  assert.ok(near(m.at(4), (D.LEVELS.p + D.LEVELS.f) / 2), 'S-curve passes the middle at the middle');
  assert.ok(m.at(1) - D.LEVELS.p < (D.LEVELS.f - D.LEVELS.p) / 8, 'S-curve starts slowly');
  for (let b = 0; b < 8; b += 0.25) assert.ok(m.at(b + 0.25) >= m.at(b) - 1e-9, 'crescendo never falls');
  const shapes = D.SHAPES.map(s => s.id);
  assert.deepEqual(shapes, ['s', 'linear', 'late', 'early', 'messa']);
  const q = u => Object.fromEntries(['linear', 'late', 'early'].map(s => [s, D.shapeU(s, u, 0.7)]));
  assert.ok(q(0.5).late < q(0.5).linear && q(0.5).linear < q(0.5).early, 'late swell lags, early swell leads');
  assert.equal(D.shapeU('s', 0.3, 0), 0.3, 'strength 0 = linear');
  // hairpin with no target: one dynamic up, then held
  const up = D.levelModel({ marks: [{ beat: 0, text: 'mp' }], hairpins: [{ start: 4, end: 8, form: 'cres' }] });
  assert.ok(up.at(9) > D.LEVELS.mp + 0.1 && near(up.at(9), up.at(20)));
  // messa di voce: rises to a peak in the middle, falls back
  const messa = D.levelModel({ marks: [{ beat: 0, text: 'p' }], hairpins: [{ start: 0, end: 8, form: 'cres', shape: 'messa' }] });
  assert.ok(messa.at(4) > D.LEVELS.p + 0.15 && near(messa.at(8), D.LEVELS.p) && near(messa.at(0), D.LEVELS.p));
  // per-hairpin shape beats the default
  const own = D.levelModel({ marks: [{ beat: 0, text: 'p' }, { beat: 8, text: 'f' }], hairpins: [{ start: 0, end: 8, form: 'cres', shape: 'late' }] }, { shape: 'early' });
  assert.ok(own.at(4) < (D.LEVELS.p + D.LEVELS.f) / 2);
  // fp and sfz
  const acc = D.levelModel({ marks: [{ beat: 0, text: 'mf' }, { beat: 4, text: 'sfz' }, { beat: 8, text: 'fp' }] });
  assert.ok(acc.at(4.1) > D.LEVELS.mf + 0.2 && near(acc.at(5), D.LEVELS.mf), 'sfz spikes and returns');
  assert.ok(near(acc.at(8.1), D.LEVELS.f) && near(acc.at(9), D.LEVELS.p), 'fp');
  // chained hairpins: the second starts where the first ended
  const chain = D.levelModel({ marks: [{ beat: 0, text: 'p' }], hairpins: [{ start: 0, end: 4, form: 'cres' }, { start: 4, end: 8, form: 'dim' }] });
  assert.ok(near(chain.at(4), D.LEVELS.p + 0.14) && near(chain.at(8), D.LEVELS.p));
  ok('level model: S-curve, linear, late/early swell, messa di voce, targets, fp, sfz, chains');
}

// ---- curve points: density, jumps, variation
{
  const entry = { marks: [{ beat: 0, text: 'p' }, { beat: 16, text: 'f' }, { beat: 24, text: 'pp' }],
    hairpins: [{ start: 0, end: 16, form: 'cres' }] };
  const m = D.levelModel(entry);
  const pts = D.levelPoints(m, 0, 32);
  const inHairpin = pts.filter(p => p.beat >= 0 && p.beat <= 16);
  assert.ok(inHairpin.length <= D.MAX_PER_HAIRPIN + 1, `≤ ${D.MAX_PER_HAIRPIN} points per hairpin (got ${inHairpin.length})`);
  assert.ok(pts.length <= 22, 'the whole curve stays editable: ' + pts.length);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].beat > pts[i - 1].beat, 'beats strictly increase');
  const at = b => D.interp(pts, b);
  for (let b = 0; b <= 16; b += 0.5) assert.ok(Math.abs(at(b) - m.at(b)) < 0.012, `thinned curve follows the shape at ${b}`);
  const jump = pts.findIndex(p => p.beat === 24);
  assert.ok(jump > 0 && near(pts[jump - 1].beat, 24 - 1 / 24) && near(pts[jump - 1].v, D.LEVELS.f) && near(pts[jump].v, D.LEVELS.pp), 'subito pp jumps over one grid step');
  assert.ok(near(pts[pts.length - 1].beat, 32) && near(pts[0].beat, 0));
  const part = D.levelPoints(m, 8, 12);
  assert.ok(near(part[0].v, m.at(8), 2e-4) && near(part[part.length - 1].v, m.at(12), 2e-3), 'a range inside a hairpin starts and ends on the curve');

  const v1 = D.levelPoints(m, 0, 32, { variation: { on: true, amount: 0.5, seed: 7 } });
  const v2 = D.levelPoints(m, 0, 32, { variation: { on: true, amount: 0.5, seed: 7 } });
  const v3 = D.levelPoints(m, 0, 32, { variation: { on: true, amount: 0.5, seed: 8 } });
  assert.deepEqual(v1, v2, 'variation is seeded (same seed, same curve)');
  assert.notDeepEqual(v1, v3);
  const dev = Math.max(...v1.map(p => Math.abs(p.v - m.at(p.beat))));
  // gentle: at amount 0.5 well under one dynamic step (0.13), so the music stays inside its dynamic
  assert.ok(dev > 0.01 && dev <= 0.06, 'variation is gentle but audible: ' + dev.toFixed(4));
  assert.ok([28, 29, 30, 31].every(b => v1.some(p => p.beat === b)), 'a held dynamic drifts every beat');
  assert.ok(v1.length <= pts.length + 24);
  ok(`curve points: ${pts.length} points for p<f>…pp over 8 bars, thinned, seeded variation (max ${dev.toFixed(3)})`);
}

// ---- library profiles
{
  const ids = LP.list().map(p => p.id);
  assert.deepEqual(ids, ['pocket-strings', 'bbcso', 'spitfire-cc', 'pigments', 'velocity']);
  const ps = LP.byId('pocket-strings');
  assert.deepEqual(ps.targets.map(t => [t.kind, t.plugin, t.param]), [['vst3', 'ABCDEF019182FAEB5443484344443032', 48], ['vst3', 'ABCDEF019182FAEB5443484344443032', 49]]);
  assert.deepEqual(LP.byId('bbcso').targets.map(t => t.param), [20, 10]);
  assert.deepEqual(LP.byId('spitfire-cc').targets.map(t => t.cc), [1, 11]);
  assert.equal(LP.byId('pigments').targets[0].kind, 'remote');
  assert.equal(LP.detect({ deviceNames: ['Articulation Map', 'Pocket Strings'] }).profile.id, 'pocket-strings');
  assert.equal(LP.detect({ pluginId: '56535453616e746262632073796d7068' }).profile.id, 'bbcso');
  assert.equal(LP.detect({ deviceNames: ['Kontakt 7'] }).profile.id, 'spitfire-cc');
  assert.equal(LP.detect({ pluginName: 'Pigments' }).how, 'export');
  assert.equal(LP.detect({ trackName: 'Pigments' }).how, 'track name');
  assert.equal(LP.detect({ trackName: 'Violins' }).profile.id, 'velocity');
  assert.equal(LP.detect({ trackName: 'Pigments', override: 'bbcso' }).profile.id, 'bbcso');
  assert.equal(LP.detect({ deviceNames: ['Pocket Stringsy'] }).profile.id, 'velocity', 'whole words only');
  assert.ok(near(LP.valueAt(ps.targets[0], 1), 1) && near(LP.valueAt(ps.targets[0], 0), 0.04));
  assert.ok(LP.valueAt(ps.targets[1], 0) >= 0.42, 'Expression moves less than Timbre');
  ok('library profiles: table, detection, value mapping');
}

// ---- curves, ops
{
  const doc = { v: 1, tracks: { 'Pocket Strings': { marks: [{ id: 'a', beat: 0, text: 'p' }, { id: 'b', beat: 8, text: 'f' }], hairpins: [{ id: 'h', start: 0, end: 8, form: 'cres' }] } } };
  const tracks = [{ track: 'Pocket Strings', profile: LP.byId('pocket-strings') }, { track: 'Flute', profile: LP.byId('velocity') }];
  const curves = D.buildCurves(doc, tracks, 0, 16, { shape: 's', strength: 0.7, variation: false });
  assert.deepEqual(curves.map(c => [c.track, c.profile, c.target]), [['Pocket Strings', 'pocket-strings', 'timbre'], ['Pocket Strings', 'pocket-strings', 'expression']]);
  const [timbre, expr] = curves;
  assert.ok(timbre.points[0].v < 0.4 && timbre.points[timbre.points.length - 1].v > 0.6);
  assert.ok(expr.points[0].v > timbre.points[0].v, 'expression sits higher (moves less)');
  const ramp = [{ beat: 0, v: 0 }, { beat: 4, v: 0.5 }, { beat: 8, v: 1 }];
  const [tT, tE] = LP.byId('pocket-strings').targets;
  const lead = D.targetPoints(ramp, tT, { lag: 0.5 }), trail = D.targetPoints(ramp, tE, { lag: 0.5 });
  assert.ok(near(lead[1].v, LP.valueAt(tT, 0.5)), 'the first slider is on time');
  assert.ok(near(trail[1].v, LP.valueAt(tE, 0.4375)), 'the second slider trails by the lag');
  const lagged = D.buildCurves(doc, tracks, 0, 16, { variation: true, amount: 1 });
  assert.notDeepEqual(lagged[1].points, D.buildCurves(doc, tracks, 0, 16, { variation: false })[1].points);
  const ops = D.curveOps(curves, 'render', 0, 16);
  assert.equal(ops[0], 'curveClear');
  assert.match(ops[1], /^curveSet c1 Pocket%20Strings pocket-strings timbre 0:0\.\d+(,[\d.]+:[\d.]+)+$/);
  assert.equal(ops[ops.length - 1], 'curveRender 0 16');
  assert.equal(D.curveOps(curves, 'preview', 4, 8).pop(), 'curvePreview 4 8');
  ops.forEach(o => assert.ok(!/\s{2}/.test(o) && o.split(' ').length <= 6, 'one op per line, no spaces inside arguments'));
  ok('buildCurves (dual control, lag) and curve ops');
}

// ---- velocities, both ways
{
  const notes = [0, 1, 2, 3, 4, 5, 6, 7].map(b => ({ id: 'n' + b, start: b, vel: b === 2 ? 110 : 90 }));
  const entry = { marks: [{ id: 'm1', beat: 0, text: 'p' }, { id: 'm2', beat: 4, text: 'ff' }], hairpins: [] };
  const v = new Map(D.planVelocities(entry, notes).map(x => [x.id, x.vel]));
  const first = [0, 1, 2, 3].map(b => v.get('n' + b)), second = [4, 5, 6, 7].map(b => v.get('n' + b));
  assert.ok(first.every(x => x === D.VELOCITY.p), 'without humanize every note under p is exactly p');
  assert.ok(second.every(x => x === D.VELOCITY.ff));
  // humanize: seeded, within ±H (+ the downbeat lift), deterministic (applying twice changes nothing)
  const many = Array.from({ length: 64 }, (_, i) => ({ id: 'h' + i, start: i / 2, pitch: 60 + (i % 5), vel: 64 }));
  const hum = { marks: [{ id: 'p', beat: 0, text: 'p' }], hairpins: [] };
  const h1 = D.planVelocities(hum, many, { humanize: 4, seed: 9 });
  const after = many.map(n => ({ ...n, vel: (h1.find(x => x.id === n.id) || n).vel }));
  assert.deepEqual(D.planVelocities(hum, after, { humanize: 4, seed: 9 }), [], 'humanized velocities are stable');
  const hv = after.map(n => n.vel);
  assert.ok(Math.min(...hv) >= D.VELOCITY.p - 4 && Math.max(...hv) <= D.VELOCITY.p + 4 + 3, 'within ±4 (+ downbeat lift)');
  assert.ok(new Set(hv).size >= 5, 'the notes differ');
  const down = after.filter(n => n.start % 4 === 0).map(n => n.vel), off = after.filter(n => n.start % 1 !== 0).map(n => n.vel);
  assert.ok(down.reduce((s, x) => s + x) / down.length > off.reduce((s, x) => s + x) / off.length, 'downbeats a little stronger');
  // ids: only these notes (new notes follow the dynamic)
  assert.deepEqual(D.planVelocities(entry, notes, { ids: new Set(['n5']) }).map(x => x.id), ['n5']);
  const only = D.planVelocities(entry, notes, { only: new Set(['m2']) });
  assert.deepEqual(only.map(x => x.id), ['n4', 'n5', 'n6', 'n7'], 'only the new mark’s notes');
  const fp = D.planVelocities({ marks: [{ id: 'x', beat: 0, text: 'fp' }], hairpins: [] }, notes.slice(0, 3).map(n => ({ ...n, vel: 90 })));
  assert.deepEqual(fp.map(x => x.vel), [96, 49, 49]);
  const sfz = D.planVelocities({ marks: [{ id: 'x', beat: 2, text: 'sfz' }], hairpins: [] }, notes);
  assert.deepEqual(sfz, [{ id: 'n2', vel: 118 }]);
  const hp = { marks: [{ id: 'a', beat: 0, text: 'p' }, { id: 'b', beat: 8, text: 'f' }], hairpins: [{ id: 'h', start: 0, end: 8, form: 'cres' }] };
  assert.deepEqual(D.planVelocities(hp, notes, { marks: false, hairpins: false }), [], 'hairpins off: velocities alone');
  const swell = new Map(D.planVelocities(hp, notes.map(n => ({ ...n, vel: 80 })), { marks: false }).map(x => [x.id, x.vel]));
  assert.ok(swell.get('n7') > swell.get('n4') && swell.get('n4') > swell.get('n1'), 'velocities follow the hairpin (default)');
  ok('velocities: dynamics set the notes they govern (fp, sfz, hairpins), humanized and stable');
}

// ---- re-anchoring: dynamics follow their clip once its position is known
{
  const t = { marks: [{ id: 'a', beat: 8.5, text: 'p', co: 8.5, ck: '16|0|4', or: 0, clip: 8.5 }, { id: 'b', beat: 20, text: 'f', co: 16, ck: 'other', or: 2 }],
    hairpins: [{ id: 'h', start: 9, end: 12, form: 'cres', co: 8.5, ck: '16|0|4', or: 0 }] };
  assert.equal(D.reanchor(t, '16|0|4', 0), 2);
  assert.deepEqual([t.marks.find(m => m.id === 'a').beat, t.hairpins[0].start, t.hairpins[0].end], [0, 0.5, 3.5]);
  assert.equal(t.marks.find(m => m.id === 'b').beat, 20, 'another clip\'s dynamics stay');
  assert.equal(D.reanchor(t, '16|0|4', 0), 0, 'nothing left to move');
  ok('reanchor: a guessed clip position is corrected, other clips untouched');
}

// ---- engraving: ids reach the SVG
{
  const score = { title: 'x', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 8,
    parts: [{ name: 'Vln', notes: [0, 1, 2, 3, 4].map(b => ({ id: 'n' + b, start: b, dur: 1, pitch: 72 })),
      marks: [{ beat: 0, text: 'p', kind: 'dynam', id: 'dm_a1' }, { beat: 4, text: 'f', kind: 'dynam' }], hairpins: [{ start: 0, end: 4, form: 'cres', id: 'dh_h1' }] }] };
  const r = ScoreBuilder.buildMEI(score, { grid: 2 });
  assert.match(r.mei, /<dynam xml:id="dm_a1" staff="1"/);
  assert.match(r.mei, /<hairpin xml:id="dh_h1" form="cres"/);
  assert.match(r.mei, /<dynam staff="1" tstamp="1" place="below">f<\/dynam>/, 'marks without an id are unchanged');
  const { svg } = await renderMEI(r.mei);
  assert.match(svg, /id="dm_a1"/);
  assert.match(svg, /id="dh_h1"/);
  ok('engraving keeps the mark and hairpin ids');
}

console.log(`dynamics-test: ${passed} passed`);
