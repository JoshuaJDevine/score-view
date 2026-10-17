// Unit tests for web/features/sections.js (orchestral score order, brackets) and web/align.js (clip placement).
//   node test/sections-test.mjs
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ROOT, ScoreBuilder, loadFixtureScore } from './lib.mjs';

const require = createRequire(import.meta.url);
const Sections = require('../web/features/sections.js');
const ClipAlign = require('../web/align.js');

// ---- name matching (the user's real track names, typos included)
const id = n => Sections.matchName(n).id;
const expect = {
  'Piccolo': 'piccolo', 'Flute': 'flute', 'Flutes  a3': 'flute', 'Oboes a3': 'oboe', 'Cor Anglais': 'corAnglais',
  'English Horn': 'corAnglais', 'Clarinet': 'clarinet', 'Clarinets a3': 'clarinet', 'Bass Clarinet': 'bassClarinet',
  'Basoons a3': 'bassoon', 'Bassoon': 'bassoon', 'Contrabassoon': 'contrabassoon',
  'Horns a4': 'horn', 'Tumpet': 'trumpet', 'Tumpets a3': 'trumpet', 'Tn Trombones a3': 'trombone',
  'Tn Trombone Solo': 'trombone', 'Bs Trombones a2': 'bassTrombone', 'Bass Trombone': 'bassTrombone', 'Tuba': 'tuba',
  'Timpani': 'timpani', 'Pecussion  I': 'percussion', 'Pecussion  II': 'percussion', 'Harp': 'harp', 'Celesta': 'keyboards',
  'Super Audio Cart': 'other', 'Violin Solo': 'soloViolin', 'Violin 1': 'violin1', 'Violins I': 'violin1',
  'Violin 2': 'violin2', 'Violins II': 'violin2', 'Viola': 'viola', 'Violas': 'viola', 'Cello': 'cello',
  'Celli': 'cello', 'Bass': 'bass', 'Basses': 'bass', 'Double Bass': 'bass', 'Contrabass': 'bass',
};
for (const [name, want] of Object.entries(expect)) {
  assert.equal(id(name), want, name);
}

// ---- score order of the Mega Man 2 fixture
const score = await loadFixtureScore();
const ordered = Sections.scoreOrder(score.parts).map(p => p.name);
assert.deepEqual(ordered, [
  'Flute', 'Flutes  a3', 'Oboes a3', 'Clarinet', 'Clarinets a3', 'Basoons a3',
  'Horns a4', 'Tumpet', 'Tumpets a3', 'Tn Trombones a3', 'Bs Trombones a2', 'Tuba',
  'Timpani', 'Pecussion  I', 'Pecussion  II', 'Harp', 'Super Audio Cart',
  'Violin Solo', 'Violin 1', 'Violin 2', 'Viola', 'Cello', 'Bass',
]);
console.log('score order OK:', ordered.join(', '));

// ---- brackets in MEI: one per family, labelled; grand staff brace survives inside
const parts = Sections.scoreOrder(score.parts).map(p => ({ ...p, group: Sections.scoreInfo(p.name).bracket }));
parts.push({ name: 'Piano', grand: true, group: 'Keyboards', notes: [{ id: 'p1', start: 0, dur: 1, pitch: 72 }, { id: 'p2', start: 0, dur: 1, pitch: 48 }] });
const mei = ScoreBuilder.buildMEI({ title: 't', timeSig: score.timeSig, keyFifths: 0, lengthBeats: 8, groupLabels: true,
  parts: parts.map(p => ({ ...p, notes: p.notes.filter(n => n.start < 8) })) }, { grid: 2 }).mei;
const brackets = [...mei.matchAll(/<staffGrp symbol="bracket" bar.thru="true"><label><rend[^>]*>([^<]+)<\/rend><\/label>/g)].map(m => m[1]);
assert.deepEqual(brackets, ['Woodwinds', 'Brass', 'Percussion', 'Strings']); // single-staff groups get no bracket
assert.match(mei, /<staffGrp symbol="brace" bar.thru="true"><label>Piano<\/label>/);
assert.ok(mei.includes('<staffGrp bar.thru="false">') && !mei.includes('<staffGrp symbol="bracket" bar.thru="false">'), 'no outer bracket when grouped');
// Without groups the old single bracket stays.
const plain = ScoreBuilder.buildMEI({ title: 't', timeSig: score.timeSig, keyFifths: 0, lengthBeats: 4,
  parts: [{ name: 'A', notes: [] }, { name: 'B', notes: [] }] }, { grid: 2 }).mei;
assert.match(plain, /<staffGrp symbol="bracket" bar.thru="false">\s*<staffDef/);
console.log('brackets OK:', brackets.join(', '));

// ---- clip placement
function place(fixture, playPos) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures', fixture), 'utf8'));
  const notes = d.notes.map(n => ({ start: n.x / d.stepsPerBeat, pitch: n.y })).filter(n => n.start < d.length);
  const part = score.parts.find(p => p.name === d.track);
  return ClipAlign.findPlacements(notes, part.notes, { length: d.length, playPos });
}
const bar = o => o / 4 + 1;
const bass = place('live-bass.json');
assert.equal(bar(bass.best.offset), 1, 'Bass placed at bar 1');
assert.deepEqual(bass.cands.map(c => bar(c.offset)).sort((a, b) => a - b), [1, 25, 57, 89], 'Bass: the four equally good places');
assert.equal(bar(place('live-bass.json', 70 * 4).best.offset), 57, 'Bass: nearest to a playhead in bar 70 wins');
const vln = place('live-violin1.json');
assert.equal(bar(vln.best.offset), 25, 'Violin 1 placed at bar 25');
assert.equal(vln.cands.length, 1, 'Violin 1 is unambiguous');
assert.equal(bar(place('live-violin1.json', 0).best.offset), 25, 'a clearly better match beats playhead proximity');
// ---- SV.instruments.lookup(name).scoreOrder is preferred when it ranks every part
globalThis.SV = { instruments: { lookup: n => ({ family: 'x', scoreOrder: n === 'Tuba' ? 0 : 10 }) } };
assert.equal(Sections.scoreOrder(score.parts)[0].name, 'Tuba');
globalThis.SV = { instruments: { lookup: n => (n === 'Tuba' ? { scoreOrder: 0 } : undefined) } };
assert.equal(Sections.scoreOrder(score.parts)[0].name, 'Flute', 'partial external ranks are ignored');
delete globalThis.SV;

console.log('placement OK: Bass @', bass.cands.map(c => bar(c.offset)).join('/'), '· Violin 1 @', bar(vln.best.offset));
