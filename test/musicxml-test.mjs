// MusicXML export (web/features/musicxml.js): MEI from score.js -> MusicXML 4.0, checked by
//  - well-formedness and the MusicXML 4.0 XSD (xmllint-wasm, test/fixtures/musicxml-4.0),
//  - a round trip: Verovio imports the MusicXML; per staff, every note's onset / pitch / duration must
//    match the source MEI (Verovio's own timing of both files),
//  - PNG renderings of source and round trip (test/out-mx-*.png) to look at.
//
//   node test/musicxml-test.mjs [--no-png]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';
import { ROOT, ScoreBuilder, loadFixtureScore, screenshotSvg } from './lib.mjs';

const require = createRequire(import.meta.url);
const MX = require('../web/features/musicxml.js');
const { DOMParser } = new JSDOM('').window;
const PNG = !process.argv.includes('--no-png');
let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };

// ------------------------------------------------------------------ Verovio helpers

let tk;
async function toolkit() {
  if (tk) return tk;
  const { default: createVerovioModule } = await import('verovio/wasm');
  const { VerovioToolkit } = await import('verovio/esm');
  tk = new VerovioToolkit(await createVerovioModule());
  return tk;
}

// Loads data (MEI or MusicXML) and returns { staves: Map(n -> sorted ["onset|pitch|dur"]), svg, mei }.
async function analyse(data, { svg = false } = {}) {
  const t = await toolkit();
  t.setOptions({ pageWidth: 2100, pageHeight: 60000, scale: 35, adjustPageHeight: true, header: 'none', footer: 'none',
                 breaks: 'auto', condense: 'none' });
  if (!t.loadData(data)) throw new Error('Verovio could not load: ' + t.getLog());
  const mei = t.getMEI({ removeIds: false });
  t.renderToTimemap();
  const doc = new DOMParser().parseFromString(mei, 'application/xml');
  const staves = new Map();
  for (const staff of doc.getElementsByTagNameNS('*', 'staff')) {
    const n = staff.getAttribute('n');
    if (!staves.has(n)) staves.set(n, []);
    for (const note of staff.getElementsByTagNameNS('*', 'note')) {
      if (note.getAttribute('grace')) continue;
      const id = note.getAttribute('xml:id');
      const tm = t.getTimesForElement(id), midi = t.getMIDIValuesForElement(id);
      const on = Math.round(tm.scoreTimeOnset * 1000) / 1000, dur = Math.round(tm.scoreTimeDuration * 1000) / 1000;
      staves.get(n).push(`${on}|${midi.pitch}|${dur}`);
    }
  }
  staves.forEach(v => v.sort());
  let svgOut = '';
  if (svg) for (let p = 1; p <= t.getPageCount(); p++) svgOut += t.renderToSVG(p);
  return { staves, svg: svgOut, mei, log: t.getLog() };
}

// Same notes per staff; transposed staves (written pitch in our MEI) may come back as sounding pitch.
function compareStaves(src, rt, label, shift = new Map()) {
  let same = src.staves.size === rt.staves.size;
  const problems = [];
  src.staves.forEach((notes, n) => {
    const got = rt.staves.get(n) || [];
    const d = shift.get(n) || 0;
    const want = notes.map(s => { const [o, p, du] = s.split('|'); return `${o}|${+p + d}|${du}`; }).sort();
    const ok = want.length === got.length && want.every((v, i) => v === got[i]);
    const okNoShift = !ok && notes.length === got.length && notes.every((v, i) => v === got[i]);
    if (!ok && !okNoShift) {
      same = false;
      const miss = want.filter(v => !got.includes(v)).slice(0, 4), extra = got.filter(v => !want.includes(v)).slice(0, 4);
      problems.push(`staff ${n}: ${want.length} vs ${got.length} notes; missing ${miss.join(' ')} extra ${extra.join(' ')}`);
    }
  });
  const total = [...src.staves.values()].reduce((a, v) => a + v.length, 0);
  check(same, `${label}: round trip keeps ${total} notes (onset, pitch, duration) on ${src.staves.size} staves` +
        (problems.length ? '\n         ' + problems.slice(0, 6).join('\n         ') : ''));
}

// ------------------------------------------------------------------ XSD validation

let xsd;
async function validate(xml, label) {
  const { validateXML, memoryPages } = require('xmllint-wasm');
  if (!xsd) {
    const dir = path.join(ROOT, 'test/fixtures/musicxml-4.0');
    xsd = {
      main: fs.readFileSync(path.join(dir, 'musicxml.xsd'), 'utf8')
        .replace('http://www.musicxml.org/xsd/xml.xsd', 'xml.xsd').replace('http://www.musicxml.org/xsd/xlink.xsd', 'xlink.xsd'),
      preload: ['xml.xsd', 'xlink.xsd'].map(f => ({ fileName: f, contents: fs.readFileSync(path.join(dir, f), 'utf8') })),
    };
  }
  const res = await validateXML({
    xml: [{ fileName: 'score.musicxml', contents: xml.replace(/<!DOCTYPE[^>]*>/, '') }],
    schema: [xsd.main], preload: xsd.preload, initialMemoryPages: 256, maxMemoryPages: memoryPages.GiB,
  });
  check(res.valid, `${label}: valid against the MusicXML 4.0 XSD` + (res.valid ? '' : '\n         ' + res.errors.slice(0, 5).map(e => e.rawMessage || e.message).join('\n         ')));
}

function wellFormed(xml, label) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  check(!doc.getElementsByTagName('parsererror').length && doc.documentElement.localName === 'score-partwise', `${label}: well-formed score-partwise`);
  return doc;
}

async function runCase(label, mei, mxOpts, { shift, png = PNG } = {}) {
  console.log('\n' + label);
  const res = MX.fromMEI(mei, { DOMParser, date: '2026-01-01', ...mxOpts });
  const file = path.join(ROOT, 'test', 'out-mx-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.musicxml');
  fs.writeFileSync(file, res.xml);
  console.log(`  ${res.parts.length} parts, ${res.measures} measures, ${res.notes} notes, divisions ${res.divisions} -> ${path.relative(ROOT, file)}`);
  const doc = wellFormed(res.xml, label);
  await validate(res.xml, label);
  const src = await analyse(mei, { svg: png });
  const rt = await analyse(res.xml, { svg: png });
  compareStaves(src, rt, label, shift);
  if (png) {
    const base = path.join(ROOT, 'test', 'out-mx-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    await screenshotSvg(src.svg, base + '-mei.png');
    await screenshotSvg(rt.svg, base + '-roundtrip.png');
    console.log(`  screenshots: ${path.relative(ROOT, base)}-mei.png / -roundtrip.png`);
  }
  return { res, doc, xml: res.xml };
}

const q = (doc, sel) => [...doc.querySelectorAll(sel)];

// ------------------------------------------------------------------ 1. synthetic score from score.js

const N = (start, dur, pitch, extra) => ({ id: `s${start}_${pitch}_${Math.random().toString(36).slice(2, 6)}`, start, dur, pitch, ...extra });
const synthetic = {
  title: 'Synthetic test', timeSig: { num: 4, den: 4 }, keyFifths: -1, lengthBeats: 12,
  parts: [
    { name: 'Clarinet in Bb', transpose: 2, notes: [ // sounding F major line; written in G
      N(0, 1, 65), N(1, 0.5, 67), N(1.5, 0.5, 69), N(2, 2.5, 70), N(4.5, 0.25, 72), N(4.75, 0.25, 74), N(5, 1, 72),
      N(6, 0.75, 69), N(6.75, 0.25, 67), N(7, 3, 65) ] },
    { name: 'Tenor', clef: { shape: 'G', line: 2, dis: 8, disPlace: 'below' }, notes: [
      N(0, 2, 57), N(2, 1, 60), N(3, 1, 58), N(4, 4, 57), N(8, 0.125, 60), N(8.125, 0.125, 62), N(8.25, 0.25, 64), N(8.5, 1.5, 65) ] },
    { name: 'Piano', grand: true, notes: [
      // RH two voices: held half notes under moving eighths; chords
      N(0, 2, 64), N(0, 0.5, 72), N(0.5, 0.5, 74), N(1, 0.5, 76), N(1.5, 0.5, 77), N(2, 2, 65, { color: '#e8590c' }), N(2, 2, 69), N(2, 2, 72),
      N(4, 4, 69), N(4, 4, 72), N(4, 4, 76), N(8, 1, 61), N(9, 1, 63), N(10, 2, 66),
      // LH
      N(0, 4, 41), N(0, 4, 48), N(4, 2, 46), N(6, 2, 45), N(8, 3, 38), N(11, 1, 43) ] },
  ],
  directions: [{ beat: 0, text: 'A', kind: 'reh', staff: 1 }, { beat: 0, text: 'Allegro ♩ = 132', kind: 'tempo', staff: 1 },
               { beat: 5, text: 'espressivo', kind: 'dir', staff: 2 }],
};
{
  const built = ScoreBuilder.buildMEI(synthetic, { grid: 1 });
  const { doc, xml } = await runCase('Synthetic', built.mei, { score: synthetic, staves: built.staves });
  const parts = q(doc, 'score-part');
  check(parts.map(p => p.querySelector('part-name').textContent).join(',') === 'Clarinet in Bb,Tenor,Piano', 'part names from labels');
  check(parts[0].querySelector('instrument-sound')?.textContent === 'wind.reed.clarinet.bflat', 'clarinet instrument-sound');
  const tr = doc.querySelector('part#P1 transpose');
  check(tr && tr.querySelector('diatonic').textContent === '-1' && tr.querySelector('chromatic').textContent === '-2', 'Bb clarinet <transpose> diatonic -1 chromatic -2');
  check(doc.querySelector('part#P1 key fifths').textContent === '1', 'clarinet written key G (1 sharp) for concert F');
  check(doc.querySelector('part#P2 clef clef-octave-change')?.textContent === '-1', 'tenor treble-8vb clef-octave-change -1');
  check(doc.querySelector('part#P3 staves')?.textContent === '2', 'piano is one part with 2 staves');
  check(q(doc, 'part#P3 note voice').some(v => v.textContent === '2'), 'piano RH second voice');
  check(q(doc, 'part#P3 note voice').some(v => v.textContent === '5'), 'piano LH voice 5 (staff 2)');
  check(q(doc, 'part#P3 backup').length > 0, 'backup between voices');
  check(doc.querySelector('rehearsal')?.textContent === 'A', 'rehearsal mark');
  check(doc.querySelector('metronome per-minute')?.textContent === '132' && doc.querySelector('direction sound')?.getAttribute('tempo') === '132', 'tempo -> metronome + sound tempo');
  check(q(doc, 'words').some(w => w.textContent === 'Allegro'), 'tempo words');
  check(q(doc, 'part#P2 words').some(w => w.textContent === 'espressivo'), 'dir -> words on the Tenor');
  check(q(doc, 'tie[type="start"]').length > 0 && q(doc, 'tied[type="stop"]').length > 0, 'ties and tied');
  check(q(doc, 'chord').length >= 5, 'chords');
  check(q(doc, 'note[color="#E8590C"]').length === 1, 'note color');
  check(q(doc, 'beam[number="2"]').length > 0, 'secondary beams');
  check(q(doc, 'barline bar-style').some(b => b.textContent === 'light-heavy'), 'final barline');
  check(/<rest measure="yes"\/>/.test(xml), 'whole-measure rests');
}

// ------------------------------------------------------------------ 2. concert pitch view -> written pitch export

{
  console.log('\nprepareExport (concert view)');
  const concert = { ...synthetic, parts: synthetic.parts.map(p => ({ ...p, transpose: undefined })) };
  const built = ScoreBuilder.buildMEI(concert, { grid: 1 });
  const render = { ...built, score: concert };
  const prep = MX.prepareExport(render, { ScoreBuilder, buildOptions: { grid: 1 }, singleStaff: true });
  check(prep.changed.some(c => /Clarinet in Bb: written pitch \(\+2\)/.test(c)), 'clarinet re-engraved in written pitch (fallback table): ' + prep.changed.join('; '));
  check(!prep.changed.some(c => /Piano/.test(c)), 'piano keeps its grand staff');
  const withLookup = MX.prepareExport(render, { ScoreBuilder, buildOptions: { grid: 1 },
    instruments: { lookup: n => /clar/i.test(n) ? { name: 'Clarinet in B♭', transpose: 2 } : null, isTransposed: () => false } });
  check(withLookup.changed.length === 1, 'SV.instruments.lookup() decides the transposition when present');
  const res = MX.fromMEI(prep.mei, { DOMParser, score: prep.score, staves: prep.staves });
  const d = new DOMParser().parseFromString(res.xml, 'application/xml');
  const first = d.querySelector('part#P1 note pitch');
  check(first.querySelector('step').textContent === 'G' && first.querySelector('octave').textContent === '4', 'first clarinet note written G4 (sounding F4)');
  check(d.querySelector('part#P1 transpose chromatic')?.textContent === '-2', 'and carries <transpose>');
  const t = MX.transposeElement;
  check(JSON.stringify(t(7)) === '{"diatonic":-4,"chromatic":-7,"octave":0}', 'horn in F: diatonic -4 chromatic -7');
  check(JSON.stringify(t(14)) === '{"diatonic":-1,"chromatic":-2,"octave":-1}', 'tenor sax: diatonic -1 chromatic -2 octave -1');
  check(JSON.stringify(t(12)) === '{"diatonic":0,"chromatic":0,"octave":-1}', 'double bass: octave-change -1');
  check(JSON.stringify(t(-12)) === '{"diatonic":0,"chromatic":0,"octave":1}', 'piccolo: octave-change +1');
  check(JSON.stringify(t(9)) === '{"diatonic":-5,"chromatic":-9,"octave":0}', 'alto sax: diatonic -5 chromatic -9');
  check(JSON.stringify(t(3)) === '{"diatonic":-2,"chromatic":-3,"octave":0}', 'clarinet in A: diatonic -2 chromatic -3');
  const tp = MX.parseTempo('Allegro (q. = 96)');
  check(tp.words === 'Allegro' && tp.unit === 'quarter' && tp.dot && tp.bpm === 96 && tp.qpm === 144, 'tempo parse "Allegro (q. = 96)"');
}

// ------------------------------------------------------------------ 3. hand-written MEI: features other modules add

const handMEI = `<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
<meiHead><fileDesc><titleStmt><title>Hand MEI</title></titleStmt><pubStmt/></fileDesc></meiHead>
<music><body><mdiv><score>
<scoreDef keysig="2f" meter.count="4" meter.unit="4">
<staffGrp symbol="bracket" bar.thru="false">
  <staffGrp symbol="bracket" bar.thru="true"><label>Woodwinds</label>
    <staffDef n="1" lines="5" clef.shape="G" clef.line="2"><label>Flute</label><labelAbbr>Fl.</labelAbbr></staffDef>
    <staffDef n="2" lines="5" clef.shape="G" clef.line="2" keysig="0"><label>Clarinet in Bb</label><labelAbbr>Cl.</labelAbbr></staffDef>
  </staffGrp>
  <staffGrp symbol="bracket" bar.thru="true"><label>Strings</label>
    <staffDef n="3" lines="5" clef.shape="C" clef.line="3"><label>Viola</label><labelAbbr>Vla.</labelAbbr></staffDef>
    <staffDef n="4" lines="5" clef.shape="F" clef.line="4"><label>Cello</label><labelAbbr>Vc.</labelAbbr></staffDef>
  </staffGrp>
</staffGrp></scoreDef>
<section>
<measure n="5" xml:id="m5">
 <staff n="1"><layer n="1">
  <beam><tuplet num="3" numbase="2"><note xml:id="a1" pname="b" oct="5" dur="8" accid.ges="f" color="rgb(28,126,214)"/><note xml:id="a2" pname="c" oct="6" dur="8"/><note xml:id="a3" pname="d" oct="6" dur="8"/></tuplet></beam>
  <tuplet num="3" numbase="2"><beam><note xml:id="a4" pname="e" oct="6" dur="16" accid="n"/><note xml:id="a5" pname="f" oct="6" dur="16"/><note xml:id="a6" pname="g" oct="6" dur="16"/><note xml:id="a6b" pname="a" oct="6" dur="16"/></beam><rest dur="8"/></tuplet>
  <tuplet num="3" numbase="2"><note xml:id="a7" pname="a" oct="5" dur="4" tie="i"/><note xml:id="a8" pname="f" oct="5" dur="4"/><note xml:id="a9" pname="d" oct="5" dur="4"/></tuplet>
 </layer></staff>
 <staff n="2"><layer n="1"><note xml:id="b1" pname="c" oct="5" dur="2" dots="1"/><chord dur="4"><note xml:id="b2" pname="e" oct="5"/><note xml:id="b3" pname="g" oct="5" accid="s"/></chord></layer>
  <layer n="2"><space dur="2"/><note xml:id="b4" pname="a" oct="4" dur="2"/></layer></staff>
 <staff n="3"><layer n="1"><mRest/></layer></staff>
 <staff n="4"><layer n="1"><note xml:id="c1" pname="b" oct="2" dur="1" accid.ges="f"/></layer></staff>
 <reh staff="1" tstamp="1" place="above">B</reh>
 <tempo staff="1" tstamp="1" place="above" mm="72" mm.unit="4">Adagio</tempo>
 <dir staff="3" tstamp="3" place="above">pizz.</dir>
 <dynam staff="4" tstamp="1">mf</dynam>
 <slur staff="2" startid="#b1" endid="#b2"/>
</measure>
<scoreDef meter.count="3" meter.unit="4"/>
<measure n="6" xml:id="m6" right="end">
 <staff n="1"><layer n="1"><note xml:id="a10" pname="a" oct="5" dur="4" tie="t"/><rest dur="2"/></layer></staff>
 <staff n="2"><layer n="1"><mRest/></layer></staff>
 <staff n="3"><layer n="1"><clef shape="G" line="2"/><note xml:id="d1" pname="a" oct="4" dur="2" dots="1"/></layer></staff>
 <staff n="4"><layer n="1"><mRest/></layer></staff>
</measure>
</section></score></mdiv></body></music></mei>`;
{
  const handScore = { parts: [{ name: 'Flute' }, { name: 'Clarinet in Bb', transpose: 2 }, { name: 'Viola' }, { name: 'Cello' }] };
  const handStaves = [{ n: 1, part: 'Flute' }, { n: 2, part: 'Clarinet in Bb' }, { n: 3, part: 'Viola' }, { n: 4, part: 'Cello' }];
  const { doc } = await runCase('Hand MEI', handMEI, { score: handScore, staves: handStaves }, { shift: new Map([['2', -2]]) });
  const pl = [...doc.querySelector('part-list').children].map(e => e.localName + (e.getAttribute('type') ? ':' + e.getAttribute('type') : ''));
  check(pl.join(' ') === 'part-group:start score-part score-part part-group:stop part-group:start score-part score-part part-group:stop', 'section brackets -> part-groups: ' + pl.join(' '));
  check(q(doc, 'group-name').map(g => g.textContent).join() === 'Woodwinds,Strings', 'group names');
  check(doc.querySelector('part#P2 key fifths').textContent === '0' && doc.querySelector('part#P1 key fifths').textContent === '-2', 'per-staff keysig');
  check(q(doc, 'part#P1 time-modification').length === 11, 'tuplet notes and rest get time-modification');
  check(q(doc, 'part#P1 tuplet[type="start"]').length === 3 && q(doc, 'part#P1 tuplet[type="stop"]').length === 3, '3 tuplet brackets');
  check(doc.querySelector('part#P1 measure').getAttribute('number') === '5', 'measure numbers from @n');
  check(q(doc, 'part#P1 measure')[1].querySelector('time beats')?.textContent === '3', 'meter change 3/4');
  check(q(doc, 'part#P3 measure')[1].querySelector('clef sign')?.textContent === 'G', 'clef change inside layer');
  check(doc.querySelector('part#P4 dynamics mf') != null, 'dynam -> dynamics');
  check(q(doc, 'part#P2 slur').length === 2, 'slur start/stop');
  check(doc.querySelector('part#P2 forward') != null, 'space -> forward');
  check(doc.querySelector('part#P1 note[color="#1C7ED6"]') != null, 'rgb() color');
  check(doc.querySelector('part#P1 metronome per-minute')?.textContent === '72' && q(doc, 'part#P1 words').some(w => w.textContent === 'Adagio'), 'tempo from @mm');
}

// ------------------------------------------------------------------ 3b. registers, meters, keys, tempo (issue #12)
{
  let k = 0;
  const run = (start, ps, d = 1) => ps.map((p, i) => ({ id: 'r' + (k++), start: start + i * d, dur: d - 0.02, pitch: p }));
  const regScore = {
    title: 'Registers', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 23, tempo: 164,
    tempoChanges: [{ beat: 4, endBeat: 11, bpm: 180 }], keyChanges: [{ beat: 14, fifths: -2 }],
    timeSigChanges: [{ beat: 8, num: 3, den: 4 }, { beat: 14, num: 4, den: 4 }, { beat: 18, num: 6, den: 8 }],
    parts: [
      { name: 'Violin', clef: ['G', 2], ottava: { up: 1 }, notes: [...run(0, [67, 69, 71, 72]), ...run(4.5, [88, 91, 93, 96, 98, 100, 98, 96, 93, 91, 88], 0.5),
                                                                    ...run(11, [72, 71, 69]), ...run(14, [70, 69, 67, 65]), ...run(18, [62, 63, 65], 1.5)] },
      { name: 'Cello', clef: ['F', 4], altClefs: [['C', 4]], ottava: false, notes: [...run(0, [48, 50, 52, 53]), ...run(5, [67, 69, 71, 72, 71, 69, 67, 69, 71], 0.5),
                                                                                  ...run(11, [69, 67, 65]), ...run(14, [43, 45, 46, 48]), ...run(18, [43, 46, 50], 1.5)] },
    ],
  };
  const built = ScoreBuilder.buildMEI(regScore, { grid: 2 });
  const { doc } = await runCase('Registers', built.mei, { score: regScore, staves: built.staves });
  check(q(doc, 'octave-shift[type="down"][size="8"]').length === 1 && q(doc, 'octave-shift[type="stop"]').length === 1, '8va -> <octave-shift type="down"> ... stop');
  check(q(doc, 'part:nth-of-type(2) clef sign').map(e => e.textContent).join(' ') === 'F C F', 'cello clefs F -> C -> F');
  check(q(doc, 'time beats').map(e => e.textContent).join(' ') === '4 3 4 6 4 3 4 6', 'time signatures 4/4 3/4 4/4 6/8 (both parts)');
  check(q(doc, 'key fifths').map(e => e.textContent).join(' ') === '0 -2 0 -2', 'key change to B flat major');
  check(q(doc, 'metronome per-minute').map(e => e.textContent).join(' ') === '164 180' && q(doc, 'sound[tempo="164"]').length === 1, 'metronome marks 164 and 180 with <sound tempo>');
  check(q(doc, 'words').some(e => e.textContent === 'accel.') && q(doc, 'dashes[type="start"]').length === 1 && q(doc, 'dashes[type="stop"]').length === 1, 'accel. with dashes');
}

// ------------------------------------------------------------------ 4. Mega Man 2 fixture

{
  const s = await loadFixtureScore();
  // As in the app with "Hide keyswitches" on (default): notes below C1 are articulation keyswitches.
  const score = { ...s, parts: s.parts.map(p => ({ ...p, notes: p.notes.filter(n => n.pitch >= 24) })), keyFifths: null, directions: [{ beat: 0, text: 'Intro', kind: 'reh' }, { beat: 0, text: '♩ = 150', kind: 'tempo' }] };
  const built = ScoreBuilder.buildMEI(score, { grid: 2, simplify: true });
  // Only the first 16 bars get rendered to PNG (the whole song is ~40 pages).
  const t0 = Date.now();
  const res = MX.fromMEI(built.mei, { DOMParser, score, staves: built.staves, date: '2026-01-01' });
  console.log(`\nMega Man 2: ${res.parts.length} parts, ${res.measures} measures, ${res.notes} notes, ${res.xml.length >> 10} KB in ${Date.now() - t0} ms`);
  fs.writeFileSync(path.join(ROOT, 'test/out-mx-megaman2.musicxml'), res.xml);
  if (res.warnings.length) console.log('  warnings: ' + res.warnings.join('; '));
  wellFormed(res.xml, 'Mega Man 2');
  await validate(res.xml, 'Mega Man 2');
  const src = await analyse(built.mei), rt = await analyse(res.xml);
  compareStaves(src, rt, 'Mega Man 2');
  check(res.parts.length === 23, '23 parts (grand staves merged into one part each)');
  if (PNG) {
    const short = { ...score, lengthBeats: 32, parts: score.parts.map(p => ({ ...p, notes: p.notes.filter(n => n.start < 32).map(n => ({ ...n, dur: Math.min(n.dur, 32 - n.start) })) })) };
    const b2 = ScoreBuilder.buildMEI(short, { grid: 2, simplify: true });
    const r2 = MX.fromMEI(b2.mei, { DOMParser, score: short, staves: b2.staves });
    const a = await analyse(b2.mei, { svg: true }), b = await analyse(r2.xml, { svg: true });
    await screenshotSvg(a.svg, path.join(ROOT, 'test/out-mx-megaman2-mei.png'));
    await screenshotSvg(b.svg, path.join(ROOT, 'test/out-mx-megaman2-roundtrip.png'));
    console.log('  screenshots: test/out-mx-megaman2-mei.png / -roundtrip.png (first 8 bars)');
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall MusicXML checks passed');
process.exit(failures ? 1 : 0);
