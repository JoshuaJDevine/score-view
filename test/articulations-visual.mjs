// Visual test for web/features/articulations.js: engraves Mega Man 2 excerpts (full export with BBC SO plugin
// states) through instruments.js + articulations.js and screenshots them.
//   node test/articulations-visual.mjs [only]  -> test/out-artic-<name>.png
import path from 'path';
import { ROOT, ScoreBuilder, renderMEI, screenshotSvg } from './lib.mjs';
import { loadFullScore, loadModules, scoreFor, transform } from './articulations-fixture.mjs';

const base = await loadFullScore();
const STRINGS = ['Violin 1', 'Violin 2', 'Viola', 'Cello', 'Bass'];
const BRASS = ['Horns a4', 'Tumpet', 'Tumpets a3', 'Tn Trombones a3', 'Tuba'];
// [name, tracks, first bar (0-based), bars]
export const RUNS = [
  ['strings-pizz', STRINGS, 12, 8],      // Violin 1: spicc., legato phrase, pizz. at bar 16, then arco
  ['strings-mix', ['Violin 1', 'Cello', 'Basoons a3'], 79, 9], // legato / spicc. / stacc. / pizz. changes every bar
  ['brass', BRASS, 4, 6],                // trumpet staccatissimo + marcato, trombones cuivré
  ['dynamics', STRINGS.concat(['Tumpet']), 46, 6], // automation: ff -> p at bar 49 (beat 192)
];
const only = process.argv[2];
for (const [name, tracks, bar, bars] of RUNS) {
  if (only && only !== name) continue;
  const SV = loadModules({ base });
  const score = transform(SV, scoreFor(base, tracks, bar, bars));
  score.parts.forEach(p => console.log(name.padEnd(13), p.name.padEnd(16), 'marks', (p.marks || []).map(m => `${m.beat}:${m.text}`).join(' | '),
    '· slurs', (p.slurs || []).length, '· hairpins', (p.hairpins || []).map(h => `${h.form}${h.start}-${h.end}`).join(' ')));
  const built = ScoreBuilder.buildMEI(score, { grid: 2, simplify: true });
  const { svg, log } = await renderMEI(built.mei, { pageWidth: 2400, scale: 40, condense: 'auto', condenseFirstPage: true, mnumInterval: 1 });
  if (log.trim()) console.log('verovio:', log.trim().slice(0, 400));
  const out = path.join(ROOT, `test/out-artic-${name}.png`);
  await screenshotSvg(svg, out, { width: 1250, height: 700 });
  console.log('wrote', out);
}

// Catalogue: every BBC SO string and brass articulation, one bar each (two notes; the keyswitch on the downbeat).
if (!only || only === 'catalog') {
  const SV = loadModules({ base: null });
  const parts = [['Violin', 'strings', 72], ['Trumpet', 'brass', 67]].map(([name, preset, pitch]) => {
    const map = SV.articulations.PRESETS[preset].map, notes = [], keyswitches = [];
    Object.keys(map).forEach((k, i) => {
      keyswitches.push({ id: `k${name}${i}`, start: i * 4 - 0.1, dur: 0.25, pitch: +k });
      notes.push({ id: `a${name}${i}`, start: i * 4, dur: 2, pitch }, { id: `b${name}${i}`, start: i * 4 + 2, dur: 1, pitch: pitch + 2 },
                 { id: `c${name}${i}`, start: i * 4 + 3, dur: 1, pitch: pitch + 4 });
    });
    return { name, notes, keyswitches };
  });
  const score = transform(SV, { title: 'catalog', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 80, parts }, { mode: 'clip' });
  const built = ScoreBuilder.buildMEI(score, { grid: 2 });
  const { svg, log } = await renderMEI(built.mei, { pageWidth: 2400, scale: 40, mnumInterval: 1 });
  if (log.trim()) console.log('verovio:', log.trim().slice(0, 400));
  const out = path.join(ROOT, 'test/out-artic-catalog.png');
  await screenshotSvg(svg, out, { width: 1250, height: 700 });
  console.log('wrote', out, '\n  violin:', Object.values(SV.articulations.PRESETS.strings.map).join(' | '));
}
