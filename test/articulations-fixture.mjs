// Helpers for the articulation tests: a "full" Mega Man 2 export (the fixture's project.xml plus the BBC SO plugin
// states' articulation XML from test/fixtures/megaman2-plugins.json) and the feature modules under a fake window.SV.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ROOT, loadFixtureScore } from './lib.mjs';

const require = createRequire(import.meta.url);
const fflate = require('fflate');

/** Writes test/out.megaman2-full.dawproject (zip with plugins/*.vstpreset) once and returns its path. */
export function fullExportPath() {
  const out = path.join(ROOT, 'test/out.megaman2-full.dawproject');
  const src = fflate.unzipSync(fs.readFileSync(path.join(ROOT, 'test/fixtures/megaman2.dawproject')));
  const states = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/megaman2-plugins.json'), 'utf8'));
  const files = { 'project.xml': src['project.xml'], 'metadata.xml': src['metadata.xml'] || fflate.strToU8('<MetaData/>') };
  // A .vstpreset is a binary VST3 container; BBC SO keeps its XML inside it.
  Object.entries(states).forEach(([p, xml]) => {
    files[p] = fflate.strToU8('VST3\x01\x00\x00\x00' + '0'.repeat(32) + xml + '\x00\x00JUCEPrivateData');
  });
  fs.writeFileSync(out, fflate.zipSync(files, { level: 1 }));
  return out;
}

export async function loadFullScore() {
  return loadFixtureScore(fullExportPath());
}

/** Loads instruments.js + articulations.js with a fake SV; returns SV (hooks, articulations, instruments). */
export function loadModules({ base = null, settings = {}, overrides = {}, liveData = null } = {}) {
  const store = new Map([['scoreview.articulations.settings', JSON.stringify(settings)],
                         ['scoreview.articulations.overrides', JSON.stringify(overrides)]]);
  const window = {
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) },
    SV: { hooks: { transformScore: [], afterRender: [], keydown: [], noteClick: [] },
          state: { base, liveData, selection: new Set(), source: 'arranger', align: null },
          liveId: n => 'L' + n.ch + '_' + n.x + '_' + n.y, isLive: id => /^L\d+_\d+_\d+$/.test(id),
          parseId: id => { const [ch, x, y] = id.slice(1).split('_').map(Number); return { ch, x, y }; } },
  };
  for (const f of ['instruments', 'articulations']) {
    new Function('window', 'module', fs.readFileSync(path.join(ROOT, `web/features/${f}.js`), 'utf8'))(window, undefined);
  }
  return window.SV;
}

/** The score the page core would build in score mode for `names`, bars [bar, bar + bars) (0-based), keyswitches kept. */
export function scoreFor(base, names, bar, bars, { hideKs = true } = {}) {
  const mb = base.timeSig.num * 4 / base.timeSig.den, START = bar * mb, END = (bar + bars) * mb;
  return {
    title: base.title, timeSig: base.timeSig, keyFifths: null, lengthBeats: bars * mb, measureOffset: bar,
    parts: names.map(n => base.parts.find(p => p.name === n)).map(p => ({
      name: p.name, group: p.group,
      notes: p.notes.filter(n => (!hideKs || n.pitch >= 24) && n.start >= START - 1e-6 && n.start < END - 1e-6)
        .map(n => ({ ...n, start: n.start - START, dur: Math.min(n.dur, END - n.start) })),
      keyswitches: p.notes.filter(n => n.pitch < 24 && n.start < END - 1e-6).map(n => ({ ...n, start: n.start - START })),
    })),
  };
}

export function transform(SV, score, ctx = { mode: 'score' }) {
  SV.hooks.transformScore.forEach(fn => { score = fn(score, ctx) || score; });
  return score;
}
