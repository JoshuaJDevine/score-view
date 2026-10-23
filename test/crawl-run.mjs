// Runs the extension's arrangement crawler on the LIVE Bitwig project and compares the result with the
// DAWproject fixture. Only runs on a project whose name contains "crawl" unless --any is given.
//   node test/crawl-run.mjs [--any] [--exact] [--safe | --fast] [--analyze]
// --safe / --fast read with the safe waits / the fast walk (adaptive waits + stepping past audio and effect lanes),
// whatever the preferences say, and save to test/out-crawl-safe.json / test/out-crawl-fast.json (else test/out-crawl.json).
// Compare two reads of one project: node test/crawl-compare.mjs test/out-crawl-safe.json test/out-crawl-fast.json
import fs from 'fs';
import { loadFixtureScore } from './lib.mjs';

const BASE = 'http://localhost:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mode = process.argv.includes('--fast') ? 'fast' : process.argv.includes('--safe') ? 'safe' : '';
const OUT = mode ? `test/out-crawl-${mode}.json` : 'test/out-crawl.json';
let st;
if (process.argv.includes('--analyze')) {
  st = JSON.parse(fs.readFileSync(OUT, 'utf8')); // re-analyse the last crawl without touching Bitwig
} else {
  const t = await (await fetch(BASE + '/api/transport')).json();
  if (!process.argv.includes('--any') && !/crawl/i.test(t.project)) { console.error('Refusing: project is ' + t.project); process.exit(2); }
  const t0 = Date.now();
  await fetch(BASE + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body: ['crawl', process.argv.includes('--exact') ? 'exact' : '', mode].filter(Boolean).join(' ') });
  for (;;) {
    await sleep(300);
    st = await (await fetch(BASE + '/api/crawl')).json();
    process.stdout.write(`
${st.state}: ${st.message}            `);
    if (st.state !== 'running') break;
  }
  console.log(`
${st.state} in ${((Date.now() - t0) / 1000).toFixed(1)} s` + (st.timing ? ` (timing ${st.timing}, ${st.skipped} lanes stepped past, lane order ${st.laneOrder}${st.rewalked ? ', walked again' : ''})` : ''));
  if (st.state !== 'done') process.exit(1);
  fs.writeFileSync(OUT, JSON.stringify(st, null, 1));
}

// Per track: clips found, and how many export notes the crawl reproduces (pitch + start within 1/16 beat).
const spb = st.stepsPerBeat;
const byTrack = new Map();
for (const c of st.result) {
  if (!byTrack.has(c.track)) byTrack.set(c.track, []);
  byTrack.get(c.track).push(c);
}
const base = await loadFixtureScore();
// Same conversion as the page, so extra (non-playing) notes show up too.
const { crawlToScore } = (await import('module')).createRequire(import.meta.url)('../web/features/arrangement.js');
const conv = crawlToScore(st);
console.log('track'.padEnd(20), 'clips', 'positions (bar)'.padEnd(36), 'export notes matched');
for (const [track, clips] of byTrack) {
  clips.sort((a, b) => a.start - b.start);
  const crawled = [];
  clips.forEach((c, i) => {
    const next = clips[i + 1];
    // Visible length is not in the API: cap at the next clip, and at the content end for non-looping clips.
    let end = next ? next.start : Infinity;
    if (!c.loop) end = Math.min(end, c.start + (c.playStop - c.playStart));
    for (const [, x, y] of c.notes) {
      const s = c.start + x / spb - c.playStart;
      if (s >= c.start - 1e-6 && s < end - 1e-6) crawled.push({ s, y });
    }
  });
  const part = base.parts.find(p => p.name === track);
  let matched = '-';
  if (part) {
    const byPitch = new Map();
    crawled.forEach(n => { if (!byPitch.has(n.y)) byPitch.set(n.y, []); byPitch.get(n.y).push(n.s); });
    const hit = part.notes.filter(n => (byPitch.get(n.pitch) || []).some(s => Math.abs(s - n.start) < 0.06)).length;
    matched = `${hit}/${part.notes.length} (${Math.round(100 * hit / part.notes.length)}%)`;
  }
  const cp = conv.parts.find(p => p.name === track);
  const extra = part && cp ? cp.notes.length - part.notes.length : '';
  console.log(track.padEnd(20), String(clips.length).padEnd(5), clips.map(c => c.start / 4 + 1).join(', ').slice(0, 36).padEnd(36), matched, part ? 'extra ' + extra : '');
}
