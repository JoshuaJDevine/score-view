// Compares two arrangement reads (GET /api/crawl results saved by test/crawl-run.mjs), e.g. a fast read against a
// safe one of the same project: clips per track, each clip's place and notes. No Bitwig needed.
//   node test/crawl-compare.mjs test/out-crawl-safe.json test/out-crawl-fast.json
//   import { compareCrawls } from './crawl-compare.mjs';  -> { same, lines:[text], counts:{a, b} }
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const clipKey = c => `${c.track} @ beat ${c.start}`;
const noteKey = n => n.join(':');
const describe = c => `${clipKey(c)} (${(c.notes || []).length} notes${c.loop ? ', loops' : ''})`;

/** Differences between read a and read b (same clips at the same places with the same notes and play ranges = same). */
export function compareCrawls(a, b) {
  const lines = [];
  const index = st => {
    const m = new Map();
    (st.result || []).forEach(c => { const k = clipKey(c); m.set(k, (m.get(k) || []).concat([c])); });
    return m;
  };
  const A = index(a), B = index(b);
  for (const [k, cs] of A) {
    const other = B.get(k);
    if (!other) { cs.forEach(c => lines.push('only in the first: ' + describe(c))); continue; }
    if (other.length !== cs.length) lines.push(`${k}: ${cs.length} clip(s) in the first, ${other.length} in the second`);
    const [x, y] = [cs[0], other[0]];
    for (const f of ['playStart', 'playStop', 'loop', 'loopStart', 'loopLength', 'length']) {
      if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) lines.push(`${k}: ${f} ${JSON.stringify(x[f])} vs ${JSON.stringify(y[f])}`);
    }
    const nx = new Set((x.notes || []).map(noteKey)), ny = new Set((y.notes || []).map(noteKey));
    const missing = [...nx].filter(n => !ny.has(n)), extra = [...ny].filter(n => !nx.has(n));
    if (missing.length || extra.length) lines.push(`${k}: notes differ (${missing.length} only in the first, ${extra.length} only in the second)`);
  }
  for (const [k, cs] of B) if (!A.has(k)) cs.forEach(c => lines.push('only in the second: ' + describe(c)));
  const tracksA = JSON.stringify((a.tracks || []).map(t => t.name)), tracksB = JSON.stringify((b.tracks || []).map(t => t.name));
  if (tracksA !== tracksB) lines.push('the track lists differ');
  return { same: lines.length === 0, lines, counts: { a: (a.result || []).length, b: (b.result || []).length } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fa, fb] = process.argv.slice(2);
  if (!fa || !fb) { console.error('usage: node test/crawl-compare.mjs <first.json> <second.json>'); process.exit(2); }
  const a = JSON.parse(fs.readFileSync(fa, 'utf8')), b = JSON.parse(fs.readFileSync(fb, 'utf8'));
  const r = compareCrawls(a, b);
  const t = st => (st.ms != null ? ` in ${(st.ms / 1000).toFixed(1)} s (${st.timing || 'safe'}${st.skipped ? ', ' + st.skipped + ' lanes stepped past' : ''}${st.laneOrder ? ', lane order ' + st.laneOrder : ''})` : '');
  console.log(`first:  ${r.counts.a} clips${t(a)}`);
  console.log(`second: ${r.counts.b} clips${t(b)}`);
  r.lines.forEach(l => console.log('  ' + l));
  console.log(r.same ? 'SAME: every clip, place and note agrees' : `DIFFERENT: ${r.lines.length} difference(s)`);
  process.exit(r.same ? 0 : 1);
}
