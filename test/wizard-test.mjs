// New Score wizard: templates, resolution against the plug-in inventory, plan text (and the Java parser reading it),
// and the plug-in cache scanner.   node test/wizard-test.mjs
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { ROOT } from './lib.mjs';
import { parseCache } from '../tools/scan-plugins.mjs';

const require = createRequire(import.meta.url);
const T = require('../web/features/wizard-templates.js');
const INV = require('../web/features/wizard-plugins.js');
const HARVEST = require('../web/features/wizard-presets.js');
const I = require('../web/features/instruments.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

const BBC = { format: 'vst3', id: '56535453616E746262632073796D7068', name: 'BBC Symphony Orchestra', vendor: 'Spitfire Audio', category: 'Synth' };
const K8 = { format: 'vst3', id: '5653544E694B386B6F6E74616B742038', name: 'Kontakt 8', vendor: 'Native Instruments', category: 'Synth' };
const DEXED_CLAP = { format: 'clap', id: 'com.digital-suburban.dexed', name: 'Dexed', vendor: 'Digital Suburban', category: 'Synth' };
const FX = ['Strings', 'Basoon', 'Horns', 'Timpani'].map(x => ({ name: 'Articulation Map BBCSO ' + x, path: 'C:\\Lib\\Note FX Layer\\Articulation Map BBCSO ' + x + '.bwpreset', folder: 'Note FX Layer' }));
const inv = { plugins: [BBC, K8, DEXED_CLAP], noteFx: FX, presets: [{ name: 'My Celeste', path: 'C:\\Lib\\My Celeste.bwpreset', folder: 'Instrument Layer' }] };

const ESSENTIALS = T.TEMPLATES.filter(t => t.category === 'Essentials');
const STARTERS = T.TEMPLATES.filter(t => t.category !== 'Essentials');

test('every template row has a notation instrument known to instruments.js', () => {
  const ids = new Set(I.all().map(x => x.id));
  T.TEMPLATES.forEach(t => {
    assert.ok(t.rows.length > 0, t.id);
    assert.ok(T.CATEGORIES.includes(t.category), `${t.id}: category ${t.category}`);
    t.rows.forEach(r => assert.ok(ids.has(r.sv), `${t.id}: ${r.name} -> ${r.sv}`));
  });
  assert.deepEqual(ESSENTIALS.map(t => t.id), ['classical', 'chamber-strings', 'film', 'string-quartet', 'satb-piano']);
  assert.equal(T.templateById('big-band'), null);
  assert.equal(new Set(T.TEMPLATES.map(t => t.id)).size, T.TEMPLATES.length, 'unique ids');
});

test('24 starter templates: brief (tempo, meter, key, form, prompt), 3-10 rows, the requested ideas', () => {
  assert.equal(STARTERS.length, 24);
  ['sac-nes', 'sac-snes', 'sac-n64', 'lofi-study', 'cafe-piano'].forEach(id => assert.ok(T.templateById(id), id));
  STARTERS.forEach(t => {
    const b = t.brief;
    assert.ok(t.name && t.note, t.id);
    assert.ok(b, t.id + ': brief');
    assert.ok(b.tempo >= 40 && b.tempo <= 220, `${t.id}: tempo ${b.tempo}`);
    assert.ok(Array.isArray(b.meter) && b.meter[0] >= 2 && [2, 4, 8].includes(b.meter[1]), `${t.id}: meter`);
    assert.ok(b.key && b.key.length > 2, `${t.id}: key`);
    assert.ok(b.form.length >= 3 && b.form.every(([n, bars]) => n && bars > 0), `${t.id}: form`);
    const sentences = b.prompt.split(/[.!?](\s|$)/).filter(s => s && s.trim().length > 3).length;
    assert.ok(b.prompt.length >= 200 && sentences >= 2 && sentences <= 6, `${t.id}: prompt (${sentences} sentences, ${b.prompt.length} chars)`);
    assert.ok(t.rows.length >= 3 && t.rows.length <= 10, `${t.id}: ${t.rows.length} rows`);
    assert.deepEqual(new Set(t.rows.map(r => r.name)).size, t.rows.length, `${t.id}: duplicate track names`);
    assert.deepEqual(T.checkRows(t.rows.map(r => ({ name: r.name, group: r.group }))), [], `${t.id}: split groups`);
    t.rows.forEach(r => assert.equal(r.art, null, `${t.id}: articulation maps are for BBC SO rows only`));
  });
  const cats = new Set(STARTERS.map(t => t.category));
  assert.ok(cats.size >= 6, 'several categories');
  assert.deepEqual(T.byCategory().map(g => g.category), T.CATEGORIES.filter(c => T.TEMPLATES.some(t => t.category === c)));
});

test('every row has a patch hint (unless its plug-in is a single patch)', () => {
  T.TEMPLATES.forEach(t => T.resolveTemplate(t.id, INV.plugins.length ? INV : { plugins: [] }).forEach((r, i) => {
    const single = r.lib && T.SINGLE_PATCH.has(r.lib.label);
    assert.ok(single || r.patch.length > 8, `${t.id}: ${r.name} has no patch hint`);
  }));
  // a hint keyed by library follows the library that resolved
  const row = T.TEMPLATES.find(t => t.id === 'satb-piano').rows[0];
  assert.match(T.patchFor(row, { label: 'Eric Whitacre Choir' }), /Long Aah/);
  assert.equal(T.patchFor(row, { label: 'Kontakt 8' }), 'sopranos, "Aah"');
  assert.equal(T.patchFor({ patch: '' }, null), '');
});

test('real inventory: all 24 starters resolve to their first-choice plug-in, no warnings', () => {
  if (!INV.plugins.length) { console.log('    (skipped: empty inventory)'); return; }
  STARTERS.forEach(t => {
    T.resolveTemplate(t.id, INV, HARVEST).forEach((r, i) => {
      assert.ok(r.lib, `${t.id}: ${r.name} has no instrument`);
      assert.equal(r.host, t.rows[i].libs[0], `${t.id}: ${r.name} resolved ${r.host}`);
      assert.deepEqual(r.warnings, [], `${t.id}: ${r.name}`);
    });
  });
});

test('harvested patch presets: loaded instead of the bare plug-in when plug-in + patch match, else a clear warning', () => {
  const H = { presets: [
    { plugin: 'BBC Symphony Orchestra', patch: 'Violins 1', path: 'C:\\SVP\\BBC\\Violins 1.vstpreset' },
    { plugin: 'Kontakt 8', patch: 'Super Audio Cart', path: 'C:\\SVP\\K8\\Super Audio Cart.vstpreset' }] };
  const q = T.resolveTemplate('string-quartet', inv, H);
  assert.deepEqual(q[0].lib, { kind: 'file', id: 'C:\\SVP\\BBC\\Violins 1.vstpreset', label: 'BBC Symphony Orchestra — Violins 1',
    vendor: 'Spitfire Audio', plugin: 'BBC Symphony Orchestra' });
  assert.equal(q[0].presetLoaded, true);
  assert.equal(q[0].art.label, 'Articulation Map BBCSO Strings', 'the articulation map stays first');
  assert.match(T.buildPlan(q.slice(0, 1)), /dev=file:[^\t]*Articulation Map BBCSO Strings[^\t]*\tdev=file:C:\\SVP\\BBC\\Violins 1\.vstpreset\|BBC Symphony Orchestra — Violins 1\n/);
  // no harvested "Violins 2": bare BBC SO plus a warning naming the patch to load
  assert.equal(q[1].lib.kind, 'vst3');
  assert.equal(q[1].presetLoaded, false);
  assert.equal(q[1].presetPatch, 'Violins 2');
  assert.ok(q[1].warnings.some(w => /load "Violins 2" in BBC Symphony Orchestra manually/.test(w)));
  // case-insensitive; Super Audio Cart rows use the Kontakt state, the N64 (SAC2) rows do not
  assert.equal(T.findPreset(H, 'bbc symphony orchestra', 'VIOLINS 1').patch, 'Violins 1');
  assert.equal(T.resolveTemplate('sac-nes', inv, H)[0].lib.label, 'Kontakt 8 — Super Audio Cart');
  assert.equal(T.resolveTemplate('sac-n64', inv, H)[0].lib.label, 'Kontakt 8');
  // without BBC SO the fallback library gets no preset and no warning about one
  const k = T.resolveTemplate('string-quartet', { plugins: [K8] }, H)[0];
  assert.equal(k.lib.label, 'Kontakt 8');
  assert.equal(k.presetPatch, '');
  // the palette lists the harvested presets first
  assert.equal(T.palette(inv, H)[0].vendor, 'Patch presets (harvested)');
});

test('real harvest: every BBC SO row of the Essentials quartet/classical templates loads a patch preset', () => {
  if (!HARVEST.presets.length || !INV.plugins.length) { console.log('    (skipped: no harvest)'); return; }
  ['string-quartet', 'classical', 'chamber-strings'].forEach(id => T.resolveTemplate(id, INV, HARVEST).forEach(r =>
    assert.ok(r.presetLoaded, `${id}: ${r.name}`)));
  T.resolveTemplate('sac-snes', INV, HARVEST).forEach(r => assert.ok(r.presetLoaded, 'sac-snes: ' + r.name));
});

test('starter brief helpers: markers from the form, brief line, starter sheet text', () => {
  const nes = T.templateById('sac-nes');
  assert.deepEqual(T.formMarkers(nes.brief.form), [
    { name: 'Intro', bar: 1 }, { name: 'Stage A', bar: 5 }, { name: 'Stage B', bar: 13 }, { name: 'Bridge', bar: 21 }, { name: 'Turnaround', bar: 25 }]);
  assert.equal(T.briefLine(nes.brief), '150 BPM · 4/4 · E minor · 28 bars');
  assert.equal(T.briefLine(null), '');
  const rows = T.resolveTemplate('sac-nes', { plugins: [K8] });
  const sheet = T.starterSheet(nes, rows, { created: '2026-10-15' });
  assert.equal(sheet.tracks.length, 5);
  assert.deepEqual(sheet.tracks[2], { name: 'Triangle (bass)', group: 'NES APU', lib: 'Kontakt 8', patch: 'Super Audio Cart snapshot › Authentic › NES › "Triangle"' });
  const text = T.sheetText(sheet);
  assert.match(text, /^NES 2A03 stage theme \(Retro & Chiptune\)\n150 BPM/);
  assert.match(text, /Form: Intro 4 · Stage A 8/);
  assert.match(text, /- Triangle \(bass\) — Kontakt 8: Super Audio Cart snapshot › Authentic › NES › "Triangle"/);
  assert.equal(T.starterSheet(null, rows).brief, null);
});

test('track names of the Essentials templates are recognised by name (or the wizard sets an override)', () => {
  let mismatches = [];
  ESSENTIALS.forEach(t => t.rows.forEach(r => {
    const got = I.lookup(r.name, r.group).id;
    if (got !== r.sv) mismatches.push(`${r.name}: ${got} != ${r.sv}`);
  }));
  // The wizard stores an override for these; keep the list short so template names stay natural.
  assert.ok(mismatches.length <= 6, mismatches.join('; '));
  ['Violins 1', 'Celli', 'Basses', 'Horns a4', 'Tenor Trombones a3', 'Bassoons a3'].forEach(name => {
    const r = ESSENTIALS.flatMap(t => t.rows).find(x => x.name === name);
    assert.equal(I.lookup(r.name, r.group).id, r.sv, name);
  });
});

test('resolution: BBC SO + articulation map (typo-tolerant), fallbacks, nothing installed', () => {
  const rows = T.resolveTemplate('classical', inv);
  const bsn = rows.find(r => r.name === 'Bassoons a3');
  assert.equal(bsn.lib.kind, 'vst3');
  assert.equal(bsn.lib.id, BBC.id);
  assert.equal(bsn.art.label, 'Articulation Map BBCSO Basoon'); // the user's file is spelled "Basoon"
  const fl = rows.find(r => r.name === 'Flutes a3');
  assert.equal(fl.art, null); // no Flute map in this inventory
  assert.ok(fl.warnings.some(w => /Articulation map/.test(w)));
  // Without BBC SO: next candidate, and no articulation map (they are BBC SO keyswitches).
  const noBbc = { ...inv, plugins: [K8] };
  const v1 = T.resolveTemplate('chamber-strings', noBbc)[0];
  assert.equal(v1.lib.label, 'Kontakt 8');
  assert.equal(v1.art, null);
  assert.ok(v1.warnings.some(w => /not installed; using Kontakt 8/.test(w)));
  const none = T.resolveTemplate('satb-piano', { plugins: [], noteFx: [] })[0];
  assert.equal(none.lib, null);
  assert.ok(/no instrument/.test(none.warnings[0]));
  assert.equal(T.findPlugin(inv, 'dexed').format, 'clap');
  assert.equal(T.resolveTemplate('nope', inv).length, 0);
});

test('real inventory: every template resolves an instrument for every row', () => {
  if (!INV.plugins.length) { console.log('    (skipped: empty inventory)'); return; }
  T.TEMPLATES.forEach(t => T.resolveTemplate(t.id, INV).forEach(r => assert.ok(r.lib, `${t.id}: ${r.name}`)));
});

test('palette groups plug-ins by vendor, presets first', () => {
  const p = T.palette(inv);
  assert.equal(p[0].vendor, 'Presets (your library)');
  assert.equal(p[0].items[0].kind, 'file');
  assert.deepEqual(p.slice(1).map(g => g.vendor), ['Digital Suburban', 'Native Instruments', 'Spitfire Audio']);
});

const planRows = [
  { name: 'Violins 1', group: 'Strings', color: '#d9a441', lib: { kind: 'vst3', id: BBC.id, label: 'BBC SO' }, art: { path: FX[0].path, label: 'Map Strings' } },
  { name: 'Viola\tx', group: 'Strings', color: '#d9a441', lib: null, art: null },
  { name: 'Synth', group: '', color: '#3fb7b0', lib: { kind: 'clap', id: 'com.digital-suburban.dexed', label: 'Dexed' }, art: null },
];

test('plan text: groups, tracks, devices in order (articulation map first)', () => {
  const plan = T.buildPlan(planRows, { position: 0 });
  const lines = plan.trim().split('\n');
  assert.equal(lines[0], 'option\tpos=0');
  assert.equal(lines[1], 'group\tname=Strings\tcolor=#d9a441');
  assert.equal(lines.length, 5);
  const v1 = lines[2].split('\t');
  assert.deepEqual(v1.slice(0, 4), ['track', 'name=Violins 1', 'group=Strings', 'color=#d9a441']);
  assert.equal(v1[4], 'dev=file:' + FX[0].path + '|Map Strings');
  assert.equal(v1[5], 'dev=vst3:' + BBC.id + '|BBC SO');
  assert.equal(lines[3], 'track\tname=Viola x\tgroup=Strings\tcolor=#d9a441'); // tabs in names are flattened
  assert.equal(lines[4], 'track\tname=Synth\tcolor=#3fb7b0\tdev=clap:com.digital-suburban.dexed|Dexed');
  assert.equal(T.buildSwapPlan({ trackIndex: 3, trackName: 'Violins 1', lib: { kind: 'vst3', id: 'ABC', label: 'Kontakt 8' }, mode: 'replace' }),
    'swap\ttrack=3\tname=Violins 1\tdev=vst3:ABC|Kontakt 8\tmode=replace\n');
});

test('plan text: starter settings (tempo, meter, section markers) come before the groups', () => {
  const plan = T.buildPlan(planRows.slice(2), { position: -1, tempo: 92.5, meter: [6, 8], markers: [{ name: 'Intro', bar: 1 }, { name: 'A\tx', bar: 5 }] });
  assert.deepEqual(plan.trim().split('\n').slice(0, 5), ['option\tpos=-1', 'option\ttempo=92.5', 'option\tmeter=6/8',
    'marker\tname=Intro\tbar=1', 'marker\tname=A x\tbar=5']);
  // nothing extra without options
  assert.ok(!/tempo|meter|marker/.test(T.buildPlan(planRows)));
});

test('plan checks: split groups and duplicate names', () => {
  const w = T.checkRows([{ name: 'A', group: 'G' }, { name: 'B', group: '' }, { name: 'A', group: 'G' }]);
  assert.ok(w.some(x => /split/.test(x)));
  assert.ok(w.some(x => /Two tracks are called "A"/.test(x)));
  assert.deepEqual(T.checkRows([{ name: 'A', group: 'G' }, { name: 'B', group: 'G' }]), []);
});

test('Java side parses the plan the page sends (NewScoreWizard.fields, rgb, newSlot)', () => {
  let javac;
  try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); javac = true; } catch (e) { javac = false; }
  if (!javac) { console.log('    (skipped: no javac)'); return; }
  const out = path.join(ROOT, 'build', 'wiztest');
  fs.mkdirSync(out, { recursive: true });
  const cp = path.join(ROOT, 'lib', 'extension-api-25.jar');
  const srcs = fs.readdirSync(path.join(ROOT, 'src/claude/scoreview')).filter(f => f.endsWith('.java')).map(f => path.join(ROOT, 'src/claude/scoreview', f));
  execFileSync('javac', ['--release', '21', '-Xlint:-options', '-cp', cp, '-d', out, ...srcs, path.join(ROOT, 'test/java/WizardPlanCheck.java')]);
  const res = execFileSync('java', ['-cp', out + path.delimiter + cp, 'claude.scoreview.WizardPlanCheck'],
    { input: T.buildPlan(planRows, { position: -1, tempo: 150, meter: [7, 8], markers: [{ name: 'Stage A', bar: 5 }] }), encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(res[0], 'option pos=-1');
  assert.equal(res[1], 'option tempo=150');
  assert.equal(res[2], 'option meter=7/8');
  assert.equal(res[3], 'marker name=Stage A bar=5');
  assert.equal(res[4], 'group name=Strings color=#d9a441');
  assert.equal(res[5], `track name=Violins 1 group=Strings color=#d9a441 dev=file:${FX[0].path}|Map Strings || vst3:${BBC.id}|BBC SO`);
  assert.equal(res[8], 'rgb 1.0 0.5019608 0.0 true');
  assert.equal(res[9], 'newSlot 1 2 -1');
  assert.equal(res[10], 'meter 6/8 true true tempo 92.5 0.0');
});

test('plug-in cache scanner reads Bitwig\'s tagged fields', () => {
  const field = (tag, s) => { const b = Buffer.from(s, 'utf8'); const h = Buffer.alloc(9); h.writeUInt16BE(0, 0); h.writeUInt16BE(tag, 2); h[4] = 8; h.writeUInt32BE(b.length, 5); return Buffer.concat([h, b]); };
  const junk = Buffer.from([1, 2, 3, 0, 0x16, 0xe4, 1, 4]);
  const buf = Buffer.concat([field(0x3ec, 'C:\\VST3\\BBC.vst3'), junk, field(0x3e3, 'Synth'), field(0x3e4, 'BBC Symphony Orchestra'), junk,
    field(0x3e6, 'Spitfire Audio'), field(0x3e2, BBC.id), field(0x3e3, 'Audio FX'), field(0x3e4, 'Some EQ'), field(0x3e6, 'X'), field(0x3e2, 'ABCDEF01')]);
  const got = parseCache(buf, 'vst3');
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { format: 'vst3', id: BBC.id, name: 'BBC Symphony Orchestra', vendor: 'Spitfire Audio', category: 'Synth' });
  assert.equal(got[1].category, 'Audio FX');
  const clap = parseCache(Buffer.concat([field(0x3e3, 'Synth'), field(0x3e4, 'Dexed'), field(0x3e6, 'DS'), field(0x2ec4, 'com.digital-suburban.dexed')]), 'clap');
  assert.equal(clap[0].id, 'com.digital-suburban.dexed');
});

console.log(`wizard-test: ${n} passed`);
