// Import (web/features/import.js): the MIDI file parser on files written here, the MusicXML parser on a round trip
// through the MusicXML exporter (web/features/musicxml.js), .mxl unzipping and planImport's edit ops.
//   node test/import-test.mjs
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';
import { ScoreBuilder, loadFixtureScore } from './lib.mjs';
import { u32, ascii, meta, track, midiFile } from './midi-file.mjs';

const require = createRequire(import.meta.url);
const IM = require('../web/features/import.js');
const MX = require('../web/features/musicxml.js');
const fflate = require('fflate');
const { DOMParser } = new JSDOM('').window;
let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('MIDI parser');
{
  const P = 480;
  const conductor = track([[0, ...meta(0x51, [0x07, 0xa1, 0x20])], [0, ...meta(0x58, [3, 2, 24, 8])], [P * 6, ...meta(0x58, [6, 3, 24, 8])]]);
  const violin = track([
    [0, ...meta(0x03, ascii('Violin I'))],
    [0, 0x90, 60, 100], [P, 62, 90],            // running status: second note-on without status byte
    [P, 0x80, 60, 0], [P * 2, 0x90, 62, 0],     // note-on velocity 0 = note off
    [P * 2, 0x90, 64, 80], [P * 2 + P / 2, 0x90, 64, 70], // same key twice (overlap) -> FIFO pairing
    [P * 3, 0x80, 64, 0], [P * 4, 0x80, 64, 0],
    [P * 4, 0xf0, 3, 1, 2, 0xf7],               // sysex is skipped
    [P * 5, 0x90, 67, 64],                      // never released: ends at track end
    [P * 7, 0xff, 0x01, 1, 0x41],
  ]);
  const twoCh = track([[0, ...meta(0x03, ascii('Keys'))], [0, 0xc1, 40], [0, 0x90, 48, 100], [P, 0x80, 48, 0], [0, 0x91, 72, 50], [P / 4, 0x81, 72, 0]]);
  const f = IM.parseMidi(midiFile(1, P, [conductor, violin, twoCh]));
  check(f.format === 1 && f.ppq === 480, 'format 1, 480 PPQ');
  check(eq(f.timeSig, { num: 3, den: 4 }) && f.tempo === 120, 'time signature 3/4 and tempo 120 from the conductor track: ' + JSON.stringify(f.timeSig) + ' ' + f.tempo);
  check(eq(f.parts.map(p => p.name), ['Violin I', 'Keys (ch 1)', 'Keys (ch 2)']), 'parts per track/channel: ' + f.parts.map(p => p.name).join(', '));
  const v = f.parts[0].notes.map(n => [n.start, n.dur, n.pitch, n.vel]);
  check(eq(v, [[0, 1, 60, 100], [1, 1, 62, 90], [2, 1, 64, 80], [2.5, 1.5, 64, 70], [5, 2, 67, 64]]), 'violin notes in beats (running status, vel-0 off, overlap, open note): ' + JSON.stringify(v));
  check(eq(f.parts[2].notes.map(n => [n.start, n.dur, n.pitch]), [[0, 0.25, 72]]), 'second channel split off');
  // 3/4 for two bars (6 beats), then 6/8 (3 beats per bar); file ends at beat 7
  check(eq(f.measureStarts, [0, 3, 6]), 'bar starts follow the time signature change: ' + JSON.stringify(f.measureStarts));

  const f0 = IM.parseMidi(midiFile(0, 96, [track([[0, 0x90, 60, 100], [0, 0x99, 36, 120], [96, 0x80, 60, 0], [96, 0x89, 36, 0]])]));
  check(f0.parts.length === 2 && f0.parts[1].name.startsWith('Drums') && f0.parts[0].notes[0].dur === 1, 'format 0 split by channel (96 PPQ), channel 10 named Drums');
  let threw = false;
  try { IM.parseMidi(new Uint8Array([...ascii('MThd'), ...u32(6), 0, 0, 0, 1, 0xe7, 0x28])); } catch (e) { threw = /SMPTE/.test(e.message); }
  check(threw, 'SMPTE division rejected with a clear message');
  const viaFile = IM.parseFile('song.mid', midiFile(1, P, [conductor, violin]));
  check(viaFile.title === 'song' && viaFile.parts.length === 1, 'parseFile detects MIDI, drops empty tracks, titles from the file name');
}

// ------------------------------------------------------------------ MusicXML round trip

const key = n => `${+n.start.toFixed(4)}|${n.pitch}|${+n.dur.toFixed(4)}`;
function exportXml(score, buildOptions) {
  const built = ScoreBuilder.buildMEI(score, buildOptions);
  const render = { ...built, score };
  const prep = MX.prepareExport(render, { ScoreBuilder, buildOptions, singleStaff: true, writtenPitch: true });
  return { xml: MX.fromMEI(prep.mei, { DOMParser, score: prep.score, staves: prep.staves, title: score.title, date: '2026-01-01' }).xml, built };
}

console.log('\nMusicXML round trip (synthetic: chords, voices, ties over barlines, transposing parts)');
{
  const score = {
    title: 'Round trip', timeSig: { num: 4, den: 4 }, keyFifths: -1, lengthBeats: 12,
    parts: [
      { name: 'Clarinet in Bb', notes: [ // concert pitch; the export writes it a tone higher with <transpose>
        { id: 'c1', start: 0, dur: 1, pitch: 65 }, { id: 'c2', start: 1, dur: 0.5, pitch: 67 }, { id: 'c3', start: 1.5, dur: 0.5, pitch: 69 },
        { id: 'c4', start: 2, dur: 4, pitch: 70 }, // tied over the barline
        { id: 'c5', start: 7, dur: 0.25, pitch: 72 }, { id: 'c6', start: 7.25, dur: 0.75, pitch: 74 }] },
      { name: 'Horn in F', notes: [{ id: 'h1', start: 0, dur: 2, pitch: 53 }, { id: 'h2', start: 4, dur: 8, pitch: 60 }] },
      { name: 'Piano', notes: [ // chords and two voices
        { id: 'p1', start: 0, dur: 2, pitch: 60 }, { id: 'p2', start: 0, dur: 2, pitch: 64 }, { id: 'p3', start: 0, dur: 2, pitch: 67 },
        { id: 'p4', start: 0, dur: 1, pitch: 72 }, { id: 'p5', start: 1, dur: 1, pitch: 74 }, { id: 'p6', start: 2, dur: 2, pitch: 76 },
        { id: 'p7', start: 4, dur: 1, pitch: 36 }, { id: 'p8', start: 5, dur: 3, pitch: 43 }, { id: 'p9', start: 9, dur: 1.5, pitch: 48 }] },
    ],
  };
  const { xml } = exportXml(score, { grid: 1, simplify: false });
  check(/<transpose>/.test(xml), 'export carries <transpose> for the clarinet/horn');
  const res = IM.parseMusicXML(xml, { DOMParser });
  check(res.title === 'Round trip' && eq(res.timeSig, { num: 4, den: 4 }) && res.measureStarts.length === 3, `title, 4/4, 3 bars (${res.measureStarts})`);
  check(eq(res.parts.map(p => p.name), ['Clarinet in Bb', 'Horn in F', 'Piano']), 'part names');
  check(res.parts[0].transpose === -2 && res.parts[1].transpose === -7, `part transposition read (clarinet ${res.parts[0].transpose}, horn ${res.parts[1].transpose})`);
  score.parts.forEach((sp, i) => {
    const want = sp.notes.map(key).sort(), got = res.parts[i].notes.map(key).sort();
    check(eq(want, got), `${sp.name}: ${want.length} notes back in concert pitch` + (eq(want, got) ? '' : `\n         want ${want.join(' ')}\n         got  ${got.join(' ')}`));
  });
  const cl = res.parts[0].notes[0];
  check(cl.written === cl.pitch + 2, 'clarinet written pitch kept alongside (written = concert + 2)');

  // Compressed .mxl
  const mxl = fflate.zipSync({ 'META-INF/container.xml': fflate.strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/rt.musicxml"/></rootfiles></container>'),
                               'score/rt.musicxml': fflate.strToU8(xml) });
  const fromMxl = IM.parseFile('rt.mxl', mxl, { DOMParser, fflate });
  check(fromMxl.parts.length === 3 && fromMxl.parts[2].notes.length === 9, '.mxl unzipped via META-INF/container.xml');
}

console.log('\nMusicXML round trip (Mega Man 2 fixture)');
{
  const s = await loadFixtureScore();
  const parts = s.parts.filter(p => /Violin 1|Cello|Bass|Tuba|Horns/.test(p.name)).map(p => ({ ...p, notes: p.notes.filter(n => n.pitch >= 24) }));
  const score = { title: s.title, timeSig: s.timeSig, lengthBeats: s.lengthBeats, parts };
  const { xml, built } = exportXml(score, { grid: 1, simplify: false });
  const res = IM.parseMusicXML(xml, { DOMParser });
  check(res.measureStarts.length === built.measures, `${res.measureStarts.length} bars (engraving has ${built.measures})`);
  parts.forEach((sp, i) => {
    // The fixture is played on a 32nd/triplet grid; compare onset + pitch exactly and durations within a 32nd.
    const got = res.parts[i].notes;
    const want = sp.notes;
    const byOn = new Map();
    got.forEach(n => { const k = n.start.toFixed(3) + '|' + n.pitch; byOn.set(k, n); });
    let found = 0, durOk = 0;
    want.forEach(n => {
      const g = byOn.get((Math.round(n.start * 8) / 8).toFixed(3) + '|' + n.pitch);
      if (g) { found++; if (Math.abs(g.dur - n.dur) <= 0.126 || g.dur < n.dur) durOk++; }
    });
    check(found >= want.length * 0.97 && durOk >= found * 0.95 && got.length <= want.length,
      `${sp.name}: ${found}/${want.length} notes found (onset+pitch), ${durOk} with matching length, ${got.length} parsed`);
  });
}

// ------------------------------------------------------------------ planImport

console.log('\nplanImport');
{
  const part = { notes: [{ start: 0, dur: 1, pitch: 60, written: 62, vel: 90 }, { start: 4, dur: 2, pitch: 64, written: 66, vel: 200 },
                         { start: 4, dur: 1, pitch: 64, written: 66, vel: 50 }, { start: 8, dur: 1, pitch: 150 }] };
  const existing = [{ ch: 0, x: 0, y: 50, d: 1 }, { ch: 0, x: 96, y: 51, d: 1 }, { ch: 1, x: 200, y: 52, d: 1 }];
  const p = IM.planImport(part, { stepsPerBeat: 24, targetBeat: 4, fromBeat: 0, toBeat: 8, mode: 'replace', existing, clipLength: 8 });
  check(eq(p.ops, ['del 0 96 51', 'del 1 200 52', 'add 0 96 60 90 1', 'add 0 192 64 127 2']),
        'replace: deletes notes in [target, target+span), adds at clip steps, keeps the longer duplicate, clamps velocity: ' + JSON.stringify(p.ops));
  check(p.startStep === 96 && p.endStep === 288 && p.beyondClip === 1, `range steps ${p.startStep}-${p.endStep}, ${p.beyondClip} note after the clip end`);
  const m = IM.planImport(part, { stepsPerBeat: 24, targetBeat: 0, fromBeat: 4, mode: 'merge', existing, written: true, transpose: -12 });
  check(eq(m.ops, ['add 0 0 54 127 2']) && m.skipped === 1, 'merge, source range from beat 4, written pitch -12, out-of-range pitch skipped: ' + JSON.stringify(m.ops));
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
