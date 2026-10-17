// Articulations and dynamics (web/features/articulations.js, score.js MEI, dawproject.js plugin states,
// musicxml.js export): keyswitch resolution, notation, technique text, dynamics, write-back plans.
//   node test/articulations-test.mjs
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';
import { ROOT, ScoreBuilder, renderMEI } from './lib.mjs';
import { loadFullScore, loadModules, scoreFor, transform } from './articulations-fixture.mjs';

const require = createRequire(import.meta.url);
const A = require('../web/features/articulations.js');
const MX = require('../web/features/musicxml.js');
const { DOMParser } = new JSDOM('').window;
let failures = 0, passes = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passes++; console.log('  ok   ' + name); },
    err => { failures++; console.log('  FAIL ' + name + '\n       ' + String(err && err.stack || err).split('\n').slice(0, 4).join('\n       ')); });
}

const STR = A.PRESETS.strings.map, TPT = A.PRESETS.brass.map;
let uid = 0;
const note = (start, dur, pitch, extra) => ({ id: 'n' + uid++, start, dur, pitch, ...extra });
const ks = (start, key, dur = 0.25) => ({ id: 'k' + uid++, start, dur, pitch: key });

console.log('keyswitch resolution');
await test('a short trigger latches until the next keyswitch', () => {
  const notes = [note(0.5, 0.5, 60), note(1, 0.5, 62), note(4, 1, 64), note(8, 1, 65)];
  const r = A.resolve(notes, [ks(0, 4), ks(3.75, 6)], STR);
  assert.deepEqual(notes.map(n => r.get(n.id)), ['Short Spiccato', 'Short Spiccato', 'Short Pizzicato', 'Short Pizzicato']);
});
await test('notes before the first keyswitch have no articulation', () => {
  const notes = [note(0, 1, 60), note(2, 1, 62)];
  const r = A.resolve(notes, [ks(1.5, 0)], STR);
  assert.deepEqual(notes.map(n => r.get(n.id)), [null, 'Legato']);
});
await test('held keyswitch covers its span and latches afterwards (BBC SO)', () => {
  const notes = [note(23.5, 0.3, 61), note(26, 1.3, 70), note(32.5, 0.25, 61), note(40, 0.25, 61)];
  const r = A.resolve(notes, [ks(0, 4), ks(22.5, 0, 8.65), ks(31.75, 4)], STR);
  assert.deepEqual(notes.map(n => r.get(n.id)), ['Legato', 'Legato', 'Short Spiccato', 'Short Spiccato']);
  const held = [note(62.5, 0.4, 57), note(70, 0.3, 62)];
  const r2 = A.resolve(held, [ks(31.75, 4), ks(62, 6, 6.5)], STR);
  assert.deepEqual(held.map(n => r2.get(n.id)), ['Short Pizzicato', 'Short Pizzicato'], 'latched after release');
});
await test('heldRevert: a held keyswitch ends at its release', () => {
  const notes = [note(63, 0.4, 57), note(70, 0.3, 62)];
  const r = A.resolve(notes, [ks(31.75, 4), ks(62, 6, 6.5)], STR, { heldRevert: true });
  assert.deepEqual(notes.map(n => r.get(n.id)), ['Short Pizzicato', 'Short Spiccato']);
});
await test('a keyswitch recorded a hair late still applies to its note; unknown keys are ignored', () => {
  const notes = [note(4, 1, 60), note(8, 1, 60)];
  const r = A.resolve(notes, [ks(0, 4), ks(4.03, 6), ks(7.9, 21)], STR);
  assert.deepEqual(notes.map(n => r.get(n.id)), ['Short Pizzicato', 'Short Pizzicato']);
});

console.log('notation');
await test('articulation names map to marks', () => {
  const c = n => A.classify(n, 'strings');
  assert.equal(c('Short Staccato').artic, 'stacc');
  assert.equal(c('Short Spiccato').artic, 'stacc'); assert.equal(c('Short Spiccato').label, 'spicc.');
  assert.equal(A.classify('Short Staccatissimo', 'brass').artic, 'stacciss');
  assert.equal(A.classify('Short Marcato', 'brass').artic, 'marc');
  assert.equal(A.classify('Short Tenuto', 'winds').artic, 'ten');
  assert.equal(c('Long Marcato Attack').artic, 'acc');
  assert.equal(c('Tremolo').trem, 3);
  assert.equal(c('Tremolo Sul Pont').play, 'sul pont.');
  assert.equal(c('Tremolo CS').mute, true);
  assert.equal(c('Trill (Minor 2nd)').trill, 1); assert.equal(c('Trill (Major 2nd)').trill, 2);
  assert.equal(c('Short Pizzicato Bartok').artic, 'snap');
  assert.equal(c('Long Harmonics').artic, 'harm');
  assert.equal(c('Legato').slur, true);
  assert.equal(A.classify('Long Flutter', 'brass').label, 'flz.');
  assert.equal(A.classify('Long Sfz', 'brass').dyn, 'sfz');
  assert.equal(A.classify('Long Rolls', 'timpani').trem, 3);
});
await test('technique text only where it changes (pizz. ... arco, con sord. ... senza sord.)', () => {
  const notes = [note(0, 0.5, 60), note(0.5, 0.5, 62), note(1, 0.5, 64), note(2, 1, 65), note(3, 1, 67), note(4, 2, 69), note(6, 2, 71), note(8, 1, 72)];
  const part = { notes, keyswitches: [ks(-4, 4), ks(1.9, 6), ks(3.9, 2), ks(5.9, 1), ks(7.9, 4)] };
  const r = A.annotate(part, STR, { family: 'strings' });
  assert.deepEqual(r.marks.map(m => m.beat + ' ' + m.text),
    ['0 spicc.', '2 pizz.', '4 arco con sord.', '6 senza sord.', '8 spicc.']);
  assert.equal(r.notes[0].artic, 'stacc');
  assert.equal(r.notes[3].artic, undefined, 'pizz. has no dot');
});
await test('brass mutes end with "open"; percussion shows the instrument', () => {
  const r = A.annotate({ notes: [note(0, 1, 70), note(1, 1, 70)], keyswitches: [ks(-1, 10), ks(0.9, 1)] }, TPT, { family: 'brass' });
  assert.deepEqual(r.marks.map(m => m.text), ['con sord.', 'open']);
  const p = A.annotate({ notes: [note(0, 1, 40), note(1, 1, 40)], keyswitches: [ks(-1, 6), ks(0.9, 3)] }, { 3: 'Cymbal', 6: 'Snare 1' }, { family: 'percussion' });
  assert.deepEqual(p.marks.map(m => m.text), ['Snare 1', 'Cymbal']);
});
await test('legato slurs span consecutive notes and break at rests', () => {
  const notes = [note(0, 1, 60), note(1, 1, 62), note(2, 1, 64), note(4, 1, 65), note(5, 1.2, 67), note(6, 1, 69), note(8, 1, 70)];
  const r = A.annotate({ notes, keyswitches: [ks(-1, 0), ks(7.9, 4)] }, STR);
  assert.deepEqual(r.slurs, [{ start: notes[0].id, end: notes[2].id }, { start: notes[3].id, end: notes[5].id }]);
});
await test('tremolo and trills annotate notes; keyswitches shown when not hidden stay unannotated', () => {
  const k = ks(0, 8);
  const r = A.annotate({ notes: [k, note(0, 4, 60), note(4, 4, 62)], keyswitches: [ks(3.9, 10)] }, STR);
  assert.equal(r.notes[0], k);
  assert.equal(r.notes[1].trem, 3);
  assert.equal(r.notes[2].trill, 1);
});

console.log('MEI / Verovio');
await test('score.js writes @artic, <bTrem>, <slur>, <trill>, <dir>, <dynam>, <hairpin>; Verovio renders them', async () => {
  const notes = [note(0, 0.5, 72, { artic: 'stacc' }), note(0.5, 0.5, 74, { artic: 'stacciss' }), note(1, 0.5, 76, { artic: 'marc' }),
    note(1.5, 0.5, 77, { artic: 'acc' }), note(2, 2, 79, { trem: 3 }), note(4, 1, 72), note(5, 1, 74), note(6, 2, 69, { trill: 1 }),
    note(8, 0.5, 72, { trem: 3 }), note(8.5, 0.5, 72, { artic: 'snap' })];
  const score = { title: 't', timeSig: { num: 4, den: 4 }, keyFifths: -1, lengthBeats: 12,
    parts: [{ name: 'Violin', notes, slurs: [{ start: notes[5].id, end: notes[7].id }],
      marks: [{ beat: 0, text: 'spicc.', kind: 'dir' }, { beat: 0, text: 'p', kind: 'dynam' }, { beat: 8, text: 'f', kind: 'dynam' }],
      hairpins: [{ start: 4, end: 8, form: 'cres' }] }] };
  const { mei } = ScoreBuilder.buildMEI(score, { grid: 2 });
  for (const re of [/artic="stacc"/, /artic="stacciss"/, /artic="marc"/, /artic="acc"/, /artic="snap"/, /<bTrem><note[^>]*dur="2"[^>]*stem.mod="3slash"/,
    /<bTrem><note[^>]*dur="8"[^>]*stem.mod="2slash"/, /<slur staff="1" startid="#n\w+" endid="#n\w+"\/>/, /<trill staff="1" startid="#n\w+" extender="true" tstamp2="0m\+4.75"\/>/,
    /<dir staff="1" tstamp="1" place="above"><rend fontstyle="italic">spicc.<\/rend><\/dir>/, /<dynam staff="1" tstamp="1" place="below">p<\/dynam>/,
    /<hairpin form="cres" staff="1" tstamp="1" tstamp2="0m\+5" place="below"\/>/]) assert.match(mei, re);
  // B-flat key: a minor-2nd trill on A (upper note B-flat) needs no accidental; on B-flat a major 2nd (C) neither.
  assert.doesNotMatch(mei, /accidupper/);
  const { svg, log } = await renderMEI(mei);
  assert.equal(log.trim(), '', 'no Verovio warnings');
  for (const cls of ['artic', 'bTrem', 'slur', 'trill', 'dynam', 'hairpin', 'dir']) assert.match(svg, new RegExp(`class="${cls}"`), cls + ' rendered');
});
await test('articulations sit on the attack only; a hairpin across bars uses a measure offset', () => {
  const n = note(3, 3, 72, { artic: 'acc', trem: 3 });
  const { mei } = ScoreBuilder.buildMEI({ title: 't', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 8,
    parts: [{ name: 'Vc', notes: [n], hairpins: [{ start: 1, end: 6, form: 'dim' }] }] }, { grid: 2 });
  assert.equal((mei.match(/artic="acc"/g) || []).length, 1);
  assert.equal((mei.match(/<bTrem>/g) || []).length, 2, 'tremolo on both tied pieces');
  assert.match(mei, /<hairpin form="dim" staff="1" tstamp="2" tstamp2="1m\+3"/);
});
await test('a trill whose upper note leaves the key gets @accidupper', () => {
  const { mei } = ScoreBuilder.buildMEI({ title: 't', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 4,
    parts: [{ name: 'Fl', notes: [note(0, 1, 76, { trill: 1 }), note(1, 1, 71, { trill: 2 })] }] }, { grid: 2 });
  assert.doesNotMatch(mei.split('accidupper').slice(1).join(), /x/);
  assert.match(mei, /accidupper="s"/, 'B trill M2 -> C sharp');
  assert.equal((mei.match(/accidupper/g) || []).length, 1, 'E trill m2 -> F natural, no accidental');
});

console.log('dynamics');
const flat = (t, v) => ({ t, v });
await test('automation steps become marks; bands have hysteresis', () => {
  const notes = [0, 1, 2, 3, 8, 9, 10, 11, 16, 17].map(t => note(t, 1, 60));
  const level = A.curveFn([flat(0, 0.9), flat(8, 0.9), flat(8, 0.3), flat(16, 0.3), flat(16, 0.52)]);
  const r = A.deriveDynamics(notes, { level, measureBeats: 4 });
  assert.deepEqual(r.marks.map(m => m.beat + m.text), ['0ff', '8p', '16mf']);
  assert.deepEqual(r.hairpins, []);
  const wobble = A.curveFn([flat(0, 0.49), flat(2, 0.52), flat(4, 0.48), flat(6, 0.51)]);
  const r2 = A.deriveDynamics([0, 1, 2, 3, 4, 5, 6].map(t => note(t, 1, 60)), { level: wobble });
  assert.equal(r2.marks.length, 1, 'no flicker around a band edge: ' + JSON.stringify(r2.marks));
});
await test('a ramp becomes a hairpin ending in the target dynamic', () => {
  const notes = [0, 2, 4, 6, 8, 10].map(t => note(t, 2, 60));
  const level = A.curveFn([flat(0, 0.3), flat(4, 0.3), flat(8, 0.85), flat(12, 0.85)]);
  const r = A.deriveDynamics(notes, { level });
  assert.deepEqual(r.hairpins, [{ start: 4, end: 8, form: 'cres' }]);
  assert.deepEqual(r.marks.map(m => m.beat + m.text), ['0p', '8ff']);
  const dim = A.deriveDynamics(notes, { level: A.curveFn([flat(0, 0.9), flat(2, 0.9), flat(10, 0.2)]) });
  assert.equal(dim.hairpins.length, 1); assert.equal(dim.hairpins[0].form, 'dim');
  assert.deepEqual(dim.marks.map(m => m.text), ['ff', 'pp']);
});
await test('velocity fallback: accent patterns do not flicker, a sustained rise is a crescendo', () => {
  const pat = [0.45, 0.75, 0.5, 0.7];
  const notes = Array.from({ length: 32 }, (_, i) => note(i * 0.5, 0.5, 60, { vel: pat[i % 4] }));
  const r = A.deriveDynamics(notes, {});
  assert.equal(r.marks.length, 1, JSON.stringify(r.marks));
  const rise = Array.from({ length: 16 }, (_, i) => note(i * 0.5, 0.5, 60, { vel: 0.2 + i * 0.045 }));
  const r2 = A.deriveDynamics(rise, {});
  assert.ok(r2.hairpins.some(h => h.form === 'cres'), JSON.stringify(r2));
  assert.equal(A.deriveDynamics(rise, { velocity: false }).marks.length, 0, 'velocity can be switched off');
});
await test('dynamics are restated after two bars of rest', () => {
  const r = A.deriveDynamics([note(0, 1, 60), note(1, 1, 60), note(12, 1, 60)], { level: () => 0.45, measureBeats: 4 });
  assert.deepEqual(r.marks.map(m => m.beat + m.text), ['0mp', '12mp']);
});

console.log('write-back plans');
const L = (x, y, d = 0.25, ch = 0) => ({ ch, x, y, d, vel: 100 });
const id = n => 'L' + n.ch + '_' + n.x + '_' + n.y;
await test('applying pizz. latches from the selected note on (default): one trigger, nothing restored', () => {
  const notes = [L(0, 4), L(12, 60), L(24, 62), L(36, 64), L(48, 65)];
  const ops = A.planWriteBack(notes, 24, new Set([id(notes[2]), id(notes[3])]), 6, STR);
  assert.deepEqual(ops, ['add 0 21 6 100 0.25']);
});
await test('"selected notes only": pizz. for the selection, spicc. restored after it', () => {
  const notes = [L(0, 4), L(12, 60), L(24, 62), L(36, 64), L(48, 65)];
  const ops = A.planWriteBack(notes, 24, new Set([id(notes[2]), id(notes[3])]), 6, STR, 'only');
  assert.deepEqual(ops, ['add 0 21 6 100 0.25', 'add 0 45 4 100 0.25']);
});
await test('latching keeps later articulation changes; a later switch to the same articulation is removed', () => {
  const notes = [L(0, 4), L(12, 60), L(24, 62), L(36, 6), L(36, 64), L(48, 0), L(48, 65)];
  // pizz. already starts at 64: applying pizz. from 62 makes that switch redundant; the legato at 65 stays.
  const ops = A.planWriteBack(notes, 24, new Set([id(notes[2])]), 6, STR);
  assert.deepEqual(ops, ['add 0 21 6 100 0.25', 'del 0 36 6']);
});
await test('keyswitches inside the selection are removed; an existing switch after it that becomes redundant too', () => {
  const notes = [L(0, 4), L(12, 60), L(23, 0, 2), L(24, 62), L(36, 6), L(36, 64), L(48, 4), L(48, 65)];
  // select 62 and 64: legato -> pizz inside the selection, spicc at the next note; apply spicc.
  const ops = A.planWriteBack(notes, 24, new Set([id(notes[3]), id(notes[5])]), 4, STR);
  assert.deepEqual(ops, ['del 0 23 0', 'del 0 36 6', 'del 0 48 4']);
});
await test('nothing to do when the articulation is already active; the first note of the clip gets a switch at 0', () => {
  const notes = [L(0, 4), L(12, 60), L(24, 62)];
  assert.deepEqual(A.planWriteBack(notes, 24, new Set([id(notes[2])]), 4, STR), []);
  const n2 = [L(0, 60), L(24, 62)];
  assert.deepEqual(A.planWriteBack(n2, 24, new Set([id(n2[0])]), 0, STR), ['add 0 0 0 100 0.25']);
});
await test('intent shortcuts pick (and cycle) articulations from the table', () => {
  assert.equal(STR[A.keyForIntent(STR, 'short')], 'Short Staccato');
  assert.equal(STR[A.keyForIntent(STR, 'short', [5])], 'Short Spiccato');
  assert.equal(TPT[A.keyForIntent(TPT, 'short')], 'Short Staccatissimo');
  assert.equal(TPT[A.keyForIntent(TPT, 'accent')], 'Short Marcato');
  assert.equal(STR[A.keyForIntent(STR, 'accent')], 'Long Marcato Attack');
  assert.equal(STR[A.keyForIntent(STR, 'pizz')], 'Short Pizzicato');
  assert.equal(A.keyForIntent(TPT, 'pizz'), null);
  assert.equal(STR[A.keyForIntent(STR, 'trem')], 'Tremolo');
  assert.equal(STR[A.keyForIntent(STR, 'long')], 'Long');
});

console.log('Mega Man 2 (full export with BBC SO plugin states)');
const base = await loadFullScore();
await test('dawproject.js reads every BBC SO articulation table and the dynamics automation', () => {
  const p = n => base.parts.find(x => x.name === n);
  assert.equal(base.parts.filter(x => x.articulations).length, 21);
  assert.equal(p('Violin 1').articulationSource, 'BBC Symphony Orchestra: Core - Violins 1');
  assert.deepEqual([0, 4, 6, 8].map(k => p('Violin 1').articulations[k]), ['Legato', 'Short Spiccato', 'Short Pizzicato', 'Tremolo']);
  // The built-in tables match the plugin states (spelling aside: "Legato (Extended)", "Spicc CS").
  const same = (track, preset) => {
    const m = {};
    Object.entries(p(track).articulations).forEach(([k, v]) => { m[k] = v.replace(' (Extended)', '').replace('Spicc CS', 'Spiccato CS'); });
    assert.deepEqual(m, A.PRESETS[preset].map, track);
  };
  [['Violin 1', 'strings'], ['Cello', 'strings'], ['Bass', 'strings'], ['Tumpet', 'brass'], ['Horns a4', 'brass'], ['Tn Trombones a3', 'trombones'],
   ['Bs Trombones a2', 'trombones'], ['Tuba', 'tuba'], ['Flute', 'winds'], ['Clarinets a3', 'winds'], ['Oboes a3', 'oboe'],
   ['Basoons a3', 'bassoon'], ['Harp', 'harp'], ['Timpani', 'timpani']].forEach(([t, id]) => same(t, id));
  assert.equal(p('Violin 1').automation.dynamics.length, 10);
  assert.deepEqual(p('Violin 1').automation.dynamics[1], { t: 192, v: 0.42 });
  assert.ok(p('Flute').automation.cc[1].length > 0);
  assert.equal(p('Violin 1').notes[0].vel > 0, true);
});
await test('without plugin states the built-in tables are chosen by instrument', () => {
  const SV = loadModules({ base: null });
  const want = { 'Violin 1': 'strings', 'Cello': 'strings', 'Bass': 'strings', 'Tumpet': 'brass', 'Horns a4': 'brass', 'Tn Trombones a3': 'trombones',
    'Bs Trombones a2': 'trombones', 'Tuba': 'tuba', 'Flutes  a3': 'winds', 'Oboes a3': 'oboe', 'Clarinet': 'winds', 'Basoons a3': 'bassoon', 'Harp': 'harp', 'Timpani': 'timpani' };
  Object.entries(want).forEach(([n, id]) => assert.deepEqual(SV.articulations.mapFor(n).map, A.PRESETS[id].map, n));
});
await test('overrides (localStorage) win over the export table', () => {
  const SV = loadModules({ base, overrides: { 'Violin 1': { map: { 0: 'Short Pizzicato' } }, 'Cello': { preset: 'none' } } });
  assert.deepEqual(SV.articulations.mapFor('Violin 1 ✎').map, { 0: 'Short Pizzicato' });
  assert.equal(SV.articulations.mapFor('Cello').map, null);
  assert.equal(SV.articulations.mapFor('Viola').source, 'BBC Symphony Orchestra: Core - Violas');
});
await test('strings, bars 80-88: legato slurs, spicc./pizz./arco only at changes, wedges/tenuto/marcato in bassoons', () => {
  const SV = loadModules({ base });
  const s = transform(SV, scoreFor(base, ['Violin 1', 'Cello', 'Basoons a3'], 79, 9));
  const [vln, vc, bsn] = s.parts;
  assert.deepEqual(vln.marks.filter(m => m.kind === 'dir').map(m => m.text), ['pizz.', 'arco']);
  assert.deepEqual(vc.marks.filter(m => m.kind === 'dir').map(m => m.text), ['spicc.', 'pizz.', 'arco', 'spicc.']);
  assert.ok(vln.slurs.length >= 3 && vc.slurs.length >= 3);
  const artics = bsn.notes.map(n => n.artic).filter(Boolean);
  ['stacciss', 'ten', 'marc'].forEach(a => assert.ok(artics.includes(a), a));
  assert.ok(vln.marks.some(m => m.kind === 'dynam' && m.text === 'f'), 'Violin 1 dynamics from automation');
  const { mei } = ScoreBuilder.buildMEI(s, { grid: 2, simplify: true });
  assert.ok((mei.match(/<slur /g) || []).length >= 9);
});
await test('trumpet bars 6-9: staccatissimo wedges and marcato; the keyswitches are not engraved', () => {
  const SV = loadModules({ base });
  const s = transform(SV, scoreFor(base, ['Tumpet'], 5, 4));
  const a = s.parts[0].notes.map(n => n.artic);
  assert.ok(a.filter(x => x === 'stacciss').length >= 6 && a.filter(x => x === "marc").length >= 3, a.join(','));
  assert.ok(s.parts[0].notes.every(n => n.pitch >= 24));
});
await test('dynamics, bars 47-52: Violin 1 automation ff -> p at bar 49, Violin 2 pp', () => {
  const SV = loadModules({ base });
  const s = transform(SV, scoreFor(base, ['Violin 1', 'Violin 2'], 46, 6));
  assert.deepEqual(s.parts[0].marks.filter(m => m.kind === 'dynam').map(m => m.text), ['ff', 'p']);
  assert.deepEqual(s.parts[1].marks.filter(m => m.kind === 'dynam').map(m => m.text), ['pp']);
  const off = loadModules({ base, settings: { dynamics: false, show: false } });
  const s2 = transform(off, scoreFor(base, ['Violin 1'], 46, 6));
  assert.equal((s2.parts[0].marks || []).length, 0, 'switched off');
});

console.log('MusicXML export');
await test('articulations, tremolo, trills, slurs, technique text, dynamics and hairpins export and validate', async () => {
  const notes = [note(0, 0.5, 72, { artic: 'stacc' }), note(0.5, 0.5, 74, { artic: 'stacciss' }), note(1, 0.5, 76, { artic: 'marc' }),
    note(1.5, 0.5, 77, { artic: 'ten' }), note(2, 2, 79, { trem: 3 }), note(4, 1, 72), note(5, 1, 74), note(6, 2, 76, { trill: 1 }),
    note(8, 1, 72, { artic: 'snap' }), note(9, 1, 72, { artic: 'harm' })];
  const score = { title: 't', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 12,
    parts: [{ name: 'Violin', notes, slurs: [{ start: notes[5].id, end: notes[7].id }],
      marks: [{ beat: 0, text: 'pizz.', kind: 'dir' }, { beat: 0, text: 'p', kind: 'dynam' }, { beat: 8, text: 'f', kind: 'dynam' }],
      hairpins: [{ start: 4, end: 8, form: 'cres' }] }] };
  const built = ScoreBuilder.buildMEI(score, { grid: 2 });
  const { xml } = MX.fromMEI(built.mei, { DOMParser, score, staves: built.staves, date: '2026-01-01' });
  fs.writeFileSync(path.join(ROOT, 'test/out-mx-articulations.musicxml'), xml);
  for (const s of ['<staccato/>', '<staccatissimo/>', '<strong-accent/>', '<tenuto/>', '<tremolo type="single">3</tremolo>', '<trill-mark/>',
    '<slur type="start"', '<slur type="stop"', '<snap-pizzicato/>', '<harmonic/>', '<words font-style="italic">pizz.</words>',
    '<dynamics><p/></dynamics>', '<dynamics><f/></dynamics>', '<wedge type="crescendo"/>', '<wedge type="stop"/>']) assert.ok(xml.includes(s), s);
  const { validateXML, memoryPages } = require('xmllint-wasm');
  const dir = path.join(ROOT, 'test/fixtures/musicxml-4.0');
  const res = await validateXML({
    xml: [{ fileName: 'score.musicxml', contents: xml.replace(/<!DOCTYPE[^>]*>/, '') }],
    schema: [fs.readFileSync(path.join(dir, 'musicxml.xsd'), 'utf8').replace('http://www.musicxml.org/xsd/xml.xsd', 'xml.xsd').replace('http://www.musicxml.org/xsd/xlink.xsd', 'xlink.xsd')],
    preload: ['xml.xsd', 'xlink.xsd'].map(f => ({ fileName: f, contents: fs.readFileSync(path.join(dir, f), 'utf8') })),
    initialMemoryPages: 256, maxMemoryPages: memoryPages.GiB,
  });
  assert.ok(res.valid, res.errors.slice(0, 3).map(e => e.rawMessage || e.message).join('\n'));
});

console.log(`---- ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
