// Registers and score-level notation (issue #12): mid-staff clef changes, ottava lines, meter changes, key changes,
// tempo marks; DAWproject tempo automation; render helpers. Writes test/out-notation-*.png (look at them).
//   node test/notation-test.mjs [--no-png]
import path from 'path';
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';
import { ROOT, ScoreBuilder as SB, loadFixtureScore, renderMEI, screenshotSvg } from './lib.mjs';

const require = createRequire(import.meta.url);
const INS = require('../web/features/instruments.js');
const PNG = !process.argv.includes('--no-png');
let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };

let uid = 0;
// Notes from [pitch|null(rest), beats] pairs, starting at `start`.
function line(start, seq) {
  const out = [];
  let t = start;
  seq.forEach(([p, d]) => { if (p != null) out.push({ id: 'x' + (uid++), start: t, dur: d - 0.02, pitch: p }); t += d; });
  return out;
}
const q = (ps, d = 1) => ps.map(p => [p, d]);

async function show(label, score, opts = {}, { width = 1400, pageWidth = 2100, scale = 40 } = {}) {
  const t0 = performance.now();
  const r = SB.buildMEI(score, opts);
  const ms = performance.now() - t0;
  const v = await renderMEI(r.mei, { pageWidth, scale });
  check(!v.log.trim(), `${label}: Verovio log clean` + (v.log.trim() ? ' — ' + v.log.trim().slice(0, 300) : ''));
  if (PNG) {
    const file = path.join(ROOT, 'test', 'out-notation-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png');
    await screenshotSvg(v.svg, file, { width, height: 300 });
    console.log('  wrote ' + path.relative(ROOT, file));
  }
  return { r, ms, svg: v.svg };
}
const count = (s, re) => (s.match(re) || []).length;

// ------------------------------------------------------------------ 1. cello into tenor clef and back
console.log('\nCello: bass -> tenor -> bass');
const C = 48;
const celloNotes = [
  ...line(0, q([48, 50, 52, 53, 55, 53, 52, 50])),                              // bars 1-2 low
  ...line(8, [[null, 2], [65, 0.5], [67, 0.5], [69, 0.5], [67, 0.5]]),           // bar 3: rest, then up
  ...line(12, q([69, 71, 72, 71, 69, 67, 69, 71], 0.5)), ...line(16, q([72, 71, 69, 67])), // bars 4-5 high
  ...line(20, [[null, 2], [50, 1], [48, 1]]), ...line(24, q([43, 45, 47, 48])),   // bars 6-7 low again
  ...line(28, q([48, 50, 52, 57])), ...line(32, q([52, 50, 48, 45])),            // bars 8-9: one A3 - no change
];
const cello = { name: 'Cello', clef: ['F', 4], altClefs: [['C', 4], ['G', 2]], ottava: false, notes: celloNotes };
{
  const { r } = await show('cello', { title: 'Cello', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 36, parts: [cello] });
  const clefs = r.staves[0].clefs;
  check(clefs.length === 3 && clefs[1].clef.shape === 'C' && clefs[1].clef.line === 4 && clefs[2].clef.shape === 'F',
    'bass -> tenor -> bass: ' + clefs.map(c => `${c.clef.shape}${c.clef.line}@${c.beat}`).join(' '));
  check(clefs[1].beat === 8, 'tenor clef at the bar line inside the rest before the high phrase (end of bar 2)');
  check(clefs[2].beat === 20, 'back to bass at the bar line in the rest before the low phrase (bar 6)');
  check(count(r.mei, /<clef /g) === 2, 'two <clef> changes in the MEI');
  const off = SB.buildMEI({ title: 'Cello', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 36, parts: [cello] }, { clefChanges: false });
  check(!/<clef /.test(off.mei) && off.staves[0].clefs.length === 1, 'opts.clefChanges = false: one clef');
  check(SB.clefAt(r.staves[0], 13).shape === 'C' && SB.clefAt(r.staves[0], 2).shape === 'F', 'ScoreBuilder.clefAt');
}
// Hysteresis: one high note in a low passage stays in the bass clef; a run of short excursions doesn't flip.
{
  const notes = [...line(0, q([48, 50, 52, 67, 52, 50, 48, 50])), ...line(8, q([52, 53, 55, 69, 55, 53, 52, 50]))];
  const r = SB.buildMEI({ timeSig: { num: 4, den: 4 }, keyFifths: 0, parts: [{ ...cello, notes }] });
  check(r.staves[0].clefs.length === 1, 'hysteresis: isolated high notes keep the bass clef');
}

// ------------------------------------------------------------------ 2. violin high passage with 8va
console.log('\nViolin: 8va');
const violin = {
  name: 'Violin', clef: ['G', 2], ottava: { up: 1, down: 0 }, notes: [
    ...line(0, q([67, 69, 71, 72, 74, 76, 74, 72])),
    ...line(8, [[null, 1], [88, 0.5], [91, 0.5], [93, 0.5], [96, 0.5], [98, 0.5], [100, 0.5]]),
    ...line(12, q([103, 100, 98, 96, 98, 100, 98, 96], 0.5)), ...line(16, [[96, 2], [null, 2]]),
    ...line(20, q([79, 77, 76, 74])), ...line(24, q([72, 88, 72, 71])), // one E6: no 8va
  ],
};
{
  const { r } = await show('violin-8va', { title: 'Violin', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 28, parts: [violin] });
  const o = r.staves[0].ottavas;
  check(o.length === 1 && o[0].shift === 1 && o[0].start === 9 && o[0].end > 17 && o[0].end <= 18, '8va over the high phrase: ' + JSON.stringify(o));
  check(/<octave [^>]*dis="8" dis.place="above"/.test(r.mei), '<octave dis="8" dis.place="above"> in the MEI');
  check(/oct="6" oct.ges="7"/.test(r.mei), 'notes under the line written an octave lower, @oct.ges keeps the real octave');
  check(SB.ottavaAt(r.staves[0], 12) === 1 && SB.ottavaAt(r.staves[0], 21) === 0, 'ScoreBuilder.ottavaAt');
  const off = SB.buildMEI({ timeSig: { num: 4, den: 4 }, keyFifths: 0, parts: [violin] }, { ottava: false });
  check(!/<octave/.test(off.mei), 'opts.ottava = false: no ottava');
  const brass = SB.buildMEI({ timeSig: { num: 4, den: 4 }, keyFifths: 0, parts: [{ ...violin, name: 'Trumpet', ottava: false }] });
  check(!/<octave/.test(brass.mei), 'part.ottava = false: no ottava');
}
// Piano: 15ma at the top, 8vb at the bottom.
{
  const notes = [...line(0, q([60, 64, 67, 72])), ...line(4, [[null, 1], [100, 0.5], [103, 0.5], [105, 0.5], [108, 0.5], [105, 1]]),
                 ...line(8, q([33, 29, 28, 24, 26, 28, 24, 29], 0.5)), ...line(12, [[48, 4]])];
  const { r } = await show('piano-ottavas', { timeSig: { num: 4, den: 4 }, keyFifths: 0, parts: [{ name: 'Piano', grand: true, ottava: { up: 2, down: 1 }, notes }] });
  const shifts = r.staves.map(s => s.ottavas.map(o => o.shift));
  check(shifts[0].length === 1 && shifts[0][0] >= 1 && shifts[1].length === 1 && shifts[1][0] === -1, 'piano: line above (RH) and 8vb (LH): ' + JSON.stringify(shifts));
  check(r.staves[1].ottavas[0].end === 12, '8vb ends with the low passage (the C3 after it is loco)');
}

// ------------------------------------------------------------------ 3. meter changes 4/4 -> 3/4 -> 4/4 (+ 6/8)
console.log('\nMeter changes');
{
  const notes = [...line(0, q([60, 62, 64, 65, 67, 65, 64, 62])), ...line(8, q([60, 64, 67, 72, 67, 64])),
                 ...line(14, [[65, 0.5], [67, 0.5], [69, 1], [71, 2], [72, 4]]), ...line(22, q([72, 71, 69, 67, 65, 64], 0.5))];
  const score = { title: 'Meters', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 25,
                  timeSigChanges: [{ beat: 8, num: 3, den: 4 }, { beat: 14, num: 4, den: 4 }, { beat: 22, num: 6, den: 8 }],
                  parts: [{ name: 'Flute', clef: ['G', 2], notes }] };
  const { r } = await show('meters', score);
  check(JSON.stringify(r.measureStarts) === '[0,4,8,11,14,18,22]', 'measureStarts ' + JSON.stringify(r.measureStarts));
  check(JSON.stringify(r.measureLengths) === '[4,4,3,3,4,4,3]', 'measureLengths ' + JSON.stringify(r.measureLengths));
  check(r.meters.map(m => `${m.measure}:${m.num}/${m.den}`).join(' ') === '1:4/4 3:3/4 5:4/4 7:6/8', 'meters ' + r.meters.map(m => `${m.measure}:${m.num}/${m.den}`).join(' '));
  check(count(r.mei, /<scoreDef meter.count/g) === 3, 'three <scoreDef meter.count> changes');
  check(SB.measureAt(r, 12.5) === 4 && SB.measureAt(r, 14) === 5 && SB.measureAt(r, 0) === 1, 'ScoreBuilder.measureAt');
  check(SB.measureSpan(r, 3).start === 8 && SB.measureSpan(r, 3).beats === 3, 'ScoreBuilder.measureSpan');
  // A change in the middle of a bar ends that bar early.
  const mid = SB.buildMEI({ timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 12, timeSigChanges: [{ beat: 6, num: 3, den: 4 }],
                            parts: [{ name: 'Flute', clef: ['G', 2], notes: line(0, q([60, 62, 64, 65, 67, 69, 71, 72, 74, 72, 71, 69])) }] });
  check(JSON.stringify(mid.measureStarts) === '[0,4,6,9]' && /metcon="false"/.test(mid.mei), 'mid-bar change: incomplete bar 2 ' + JSON.stringify(mid.measureStarts));
}

// ------------------------------------------------------------------ 4. tempo marks
console.log('\nTempo');
{
  const notes = line(0, q([60, 62, 64, 65, 67, 69, 71, 72, 74, 72, 71, 69, 67, 65, 64, 62, 60, 62, 64, 65, 67, 65, 64, 62]));
  const score = { title: 'Tempo', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 24, tempo: 164,
                  tempoChanges: [{ beat: 8, endBeat: 16.997, bpm: 180 }, { beat: 20, bpm: 150 }], parts: [{ name: 'Flute', clef: ['G', 2], notes }] };
  const { r } = await show('tempo-ramp', score);
  check(/<tempo [^>]*mm="164"[^>]*>♩ = 164<\/tempo>/.test(r.mei), '♩ = 164 at the start');
  check(/<dir [^>]*tstamp2="1m\+5"[^>]*extender="true"[^>]*><rend fontstyle="italic">accel\.<\/rend>/.test(r.mei), 'accel. with a dashed line over the ramp (bars 3-4)');
  check(/<measure n="5"[^]*♩ = 180[^]*<measure n="6"/.test(r.mei), '♩ = 180 where the ramp arrives (bar 5, snapped from beat 17)');
  check(/rit\.|♩ = 150/.test(r.mei) && !/rit\./.test(r.mei), 'sudden change: ♩ = 150, no rit.');
  const six = SB.buildMEI({ timeSig: { num: 6, den: 8 }, keyFifths: 0, tempo: 120, parts: [{ name: 'Flute', clef: ['G', 2], notes: line(0, q([60, 62, 64], 1.5)) }] });
  check(/mm="80" mm.unit="4" mm.dots="1"[^>]*>♩\. = 80/.test(six.mei), '6/8: dotted-quarter mark (♩. = 80)');
}

// ------------------------------------------------------------------ 5. key changes
console.log('\nKey changes');
{
  const notes = [...line(0, q([60, 62, 64, 65, 67, 69, 71, 72])), ...line(8, q([62, 64, 66, 67, 69, 71, 73, 74]))];
  const score = { title: 'Keys', timeSig: { num: 4, den: 4 }, keyFifths: null, lengthBeats: 16, keyChanges: [{ beat: 0, fifths: 0 }, { beat: 7.5, fifths: 2 }],
                  parts: [{ name: 'Flute', clef: ['G', 2], notes }, { name: 'Clarinet in Bb', clef: ['G', 2], transpose: 2, notes: notes.map(n => ({ ...n, id: n.id + 'c' })) }] };
  const { r } = await show('keys', score);
  check(r.keyFifths === 0 && r.keyChanges.length === 1 && r.keyChanges[0].measure === 3 && r.keyChanges[0].fifths === 2, 'key change to D major at bar 3 ' + JSON.stringify(r.keyChanges));
  check(/<scoreDef keysig="2s"><staffGrp><staffDef n="2" keysig="4s"\/><\/staffGrp><\/scoreDef>/.test(r.mei), 'clarinet staff gets its written key (E major)');
  check(!/accid="s"/.test(r.mei.split('<measure n="3"')[1]), 'no sharps written in D major bars');
}

// ------------------------------------------------------------------ 6. instruments module: alt clefs and ottava config
console.log('\nInstruments');
{
  const vc = INS.transform({ parts: [{ name: 'Cello', notes: celloNotes }] }, { overrides: {}, names: true }).parts[0];
  check(vc.clef[0] === 'F' && vc.altClefs.some(c => c[0] === 'C' && c[1] === 4) && vc.ottava === false, 'cello: bass clef, tenor/treble alternatives, no ottava');
  const va = INS.transform({ parts: [{ name: 'Viola', notes: line(0, q([60, 62])) }] }, { overrides: {} }).parts[0];
  check(va.altClefs.some(c => c[0] === 'G'), 'viola: treble alternative');
  const hn = INS.transform({ parts: [{ name: 'Horn in F', notes: line(0, q([60, 62])) }] }, { overrides: {} }).parts[0];
  check(hn.altClefs.some(c => c[0] === 'F'), 'horn: bass alternative');
  const vn = INS.transform({ parts: [{ name: 'Violin 1', notes: line(0, q([60, 62])) }] }, { overrides: {} }).parts[0];
  check(vn.ottava && vn.ottava.up === 1 && !vn.altClefs.length, 'violin: 8va, no clef changes');
}

// ------------------------------------------------------------------ 7. DAWproject tempo / meter automation
console.log('\nDAWproject');
const { DOMParser } = new JSDOM('').window;
{
  const ctx = {};
  const fs = await import('fs');
  new Function('DOMParser', 'TextDecoder', fs.readFileSync(path.join(ROOT, 'web/dawproject.js'), 'utf8')).call(ctx, DOMParser, TextDecoder);
  const xml = `<?xml version="1.0"?><Project version="1.0"><Transport><Tempo value="100" id="t0"/><TimeSignature numerator="4" denominator="4" id="ts"/></Transport>
    <Structure><Track contentType="notes" id="tr1" name="Flute"><Channel id="c1"/></Track></Structure>
    <Arrangement id="a"><Lanes timeUnit="beats" id="l"><Lanes track="tr1" id="l1"><Clips id="cl"><Clip time="0" duration="40"><Notes id="n"><Note time="0" duration="1" key="72" vel="0.8"/></Notes></Clip></Clips></Lanes></Lanes>
    <TempoAutomation unit="bpm" timeUnit="beats" id="ta"><Target parameter="t0"/>
      <RealPoint time="0" value="100" interpolation="hold"/><RealPoint time="8" value="120" interpolation="linear"/>
      <RealPoint time="16" value="130" interpolation="linear"/><RealPoint time="20" value="140" interpolation="hold"/></TempoAutomation>
    <TimeSignatureAutomation timeUnit="beats" id="tsa"><Target parameter="ts"/>
      <TimeSignaturePoint time="0" numerator="4" denominator="4"/><TimeSignaturePoint time="8" numerator="3" denominator="4"/>
      <TimeSignaturePoint time="14" numerator="7" denominator="8"/></TimeSignatureAutomation></Arrangement></Project>`;
  const s = ctx.DawProject.parseProjectXml(xml, 'T');
  check(s.tempo === 100 && JSON.stringify(s.tempoChanges) === '[{"beat":8,"bpm":120},{"beat":8,"endBeat":20,"bpm":140}]',
    'tempo: jump at 8, then one ramp 8-20 to 140 ' + JSON.stringify(s.tempoChanges));
  check(JSON.stringify(s.timeSigChanges) === '[{"beat":8,"num":3,"den":4},{"beat":14,"num":7,"den":8}]' && s.timeSig.num === 4, 'time signature automation ' + JSON.stringify(s.timeSigChanges));
}

// notation.js: re-basing a Clip-bars score on the real bar line, tempo in force, harmony key changes.
{
  const NOT = require('../web/features/notation.js');
  const base = { timeSig: { num: 4, den: 4 }, timeSigChanges: [{ beat: 8, num: 3, den: 4 }], tempo: 100, tempoChanges: [{ beat: 10, endBeat: 20, bpm: 120 }] };
  const sc = NOT.applyBase({ timeSig: { num: 4, den: 4 }, measureOffset: 4, lengthBeats: 8, parts: [{ name: 'A', notes: [{ id: 'a', start: 0, dur: 1, pitch: 60 }] }] }, base);
  check(sc.measureOffset === 4 && sc.offsetBeats === 14 && sc.parts[0].notes[0].start === 2 && sc.timeSig.num === 3,
    'applyBase: bar 5 really starts at beat 14 (3/4 from beat 8), notes shifted by 2');
  check(sc.tempo === 108 && sc.tempoChanges.length === 1 && sc.tempoChanges[0].beat === 0 && sc.tempoChanges[0].endBeat === 6, 'applyBase: tempo in force inside the ramp');
  const keys = NOT.harmonyKeyChanges([{ start: 0, end: 16, keyFifths: 0 }, { start: 16, end: 20, keyFifths: 1 }, { start: 20, end: 32, keyFifths: 0 },
                                      { start: 32, end: 52, keyFifths: 2 }], { barBeats: 4 });
  check(JSON.stringify(keys) === '[{"beat":0,"fifths":0},{"beat":32,"fifths":2}]', 'harmony key changes: a one-bar excursion is ignored ' + JSON.stringify(keys));
}

// ------------------------------------------------------------------ 8. Mega Man 2: tempo ramp, strings, performance
console.log('\nMega Man 2');
{
  const base = await loadFixtureScore();
  check(base.tempo === 164 && base.tempoChanges.length === 1 && base.tempoChanges[0].beat === 352 &&
        Math.abs(base.tempoChanges[0].endBeat - 417) < 0.01 && base.tempoChanges[0].bpm === 180, 'fixture tempo: 164, ramp 352 -> 417 to 180 ' + JSON.stringify(base.tempoChanges));
  const full = { ...base, keyFifths: null, parts: INS.transform({ parts: base.parts.map(p => ({ ...p })) }, { overrides: {} }).parts };
  for (let i = 0; i < 3; i++) SB.buildMEI(full, { grid: 2 }); // warm up
  const t0 = performance.now();
  const N = 5;
  let r;
  for (let i = 0; i < N; i++) r = SB.buildMEI(full, { grid: 2 });
  const ms = (performance.now() - t0) / N;
  console.log(`  buildMEI full fixture: ${ms.toFixed(1)} ms (23 parts, ${r.measures} bars)`);
  check(ms < 300, 'buildMEI on the full fixture well under 300 ms');
  check(/♩ = 164/.test(r.mei) && /accel\./.test(r.mei) && /♩ = 180/.test(r.mei), 'fixture: ♩ = 164, accel., ♩ = 180');
  const changes = r.staves.filter(s => s.clefs.length > 1).map(s => `${s.part}: ${s.clefs.map(c => c.clef.shape + c.clef.line + '@' + c.beat).join(' ')}`);
  const otts = r.staves.filter(s => s.ottavas.length).map(s => `${s.part}: ${s.ottavas.length}`);
  console.log('  clef changes: ' + (changes.join(' | ') || 'none'));
  console.log('  ottavas: ' + (otts.join(' | ') || 'none'));
  const v = await renderMEI(r.mei, { pageWidth: 2100, scale: 35 });
  check(!v.log.trim(), 'fixture: Verovio log clean' + (v.log.trim() ? ' — ' + v.log.trim().slice(0, 300) : ''));
  // Strings, bars 81-108 (around the accel.).
  const strings = full.parts.filter(p => /violin|viola|cello|bass$/i.test(p.name));
  const from = 80 * 4, to = 108 * 4;
  const cut = {
    ...full, measureOffset: 80, offsetBeats: from, lengthBeats: to - from, tempo: 164, tempoChanges: base.tempoChanges.map(c => ({ ...c, beat: c.beat - from, endBeat: c.endBeat - from })),
    parts: strings.map(p => ({ ...p, notes: p.notes.filter(n => n.pitch >= 24 && n.start >= from && n.start < to).map(n => ({ ...n, start: n.start - from })) })),
  };
  await show('megaman2-strings', cut, { grid: 2 }, { width: 1500, pageWidth: 2600, scale: 35 });
}

console.log(failures ? `\n${failures} FAILED` : '\nall notation checks passed');
process.exit(failures ? 1 : 0);
