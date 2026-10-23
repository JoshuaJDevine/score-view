// Listen probe against the LIVE extension (manual, read-only: it only sends GET requests, nothing in Bitwig changes).
// Shows what Channel.addNoteObserver delivers (GET /api/listen, NoteListen.java) while you play the arrangement in
// Bitwig, to settle what "Listen while playing" (features/arrangement-listen.js) has to expect:
//   * per track: note-ons / note-offs, keys below C1 (keyswitches), key range, velocities;
//   * stamping: each note-on's beat against the play position fitted from /api/listen's pos over time (jitter, lag);
//   * the selected track (GET /api/notes): which heard keys are in its selected clip and which are not, and its devices.
//     Extra keys (e.g. keyswitches an articulation map's Note FX sends) mean the observer reports AFTER the Note FX;
//     only the clip's own keys mean BEFORE.
// How: select a clip on a track with an articulation-map Note FX (and one without), start playback in Bitwig, then run
//   node test/listen-probe.mjs [seconds=20] [--raw]        (SV_BASE=http://localhost:8765 by default)
const BASE = process.env.SV_BASE || 'http://localhost:8765';
const seconds = Number(process.argv.find(a => /^\d+$/.test(a)) || 20);
const raw = process.argv.includes('--raw');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => { const r = await fetch(BASE + p, { cache: 'no-store' }); if (!r.ok) throw new Error(p + ': HTTP ' + r.status); return r.json(); };
const KS_MAX = 24;

let first;
try { first = await get('/api/listen'); } catch (e) {
  console.error('No /api/listen at ' + BASE + ' (' + e.message + '): is Score View running, with an extension that has it?');
  process.exit(2);
}
const notes = await get('/api/notes?v=-1');
console.log(`Listening ${seconds} s on ${BASE} (project "${notes.project}", selected track "${notes.track}")…`);
if (!first.playing) console.log('(the transport is stopped: start playback in Bitwig)');

let seq = first.seq;
const samples = []; // {t, pos} while playing: the play position over time
const byTrack = new Map();
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  const at = Date.now();
  const r = await get('/api/listen?since=' + seq);
  seq = r.seq;
  if (r.playing) samples.push({ t: at, pos: r.pos });
  for (const tr of r.tracks) {
    const s = byTrack.get(tr.index) || { name: tr.name, events: [] };
    s.events.push(...tr.events);
    byTrack.set(tr.index, s);
    if (raw) tr.events.forEach(e => console.log(`${tr.name.padEnd(20)} ${e[1] ? 'on ' : 'off'} key ${String(e[2]).padStart(3)} vel ${String(e[3]).padStart(3)} beat ${e[4].toFixed(3)} t ${e[5]} ${e[6] ? 'playing' : 'stopped'}`));
  }
  await sleep(200);
}

// The play position as a straight line over time (least squares over the samples of the longest run without jumps).
function fit(points) {
  if (points.length < 3) return null;
  const n = points.length, mt = points.reduce((a, p) => a + p.t, 0) / n, mp = points.reduce((a, p) => a + p.pos, 0) / n;
  let sxy = 0, sxx = 0;
  points.forEach(p => { sxy += (p.t - mt) * (p.pos - mp); sxx += (p.t - mt) ** 2; });
  const slope = sxx ? sxy / sxx : 0;
  return t => mp + slope * (t - mt);
}
let runs = [[]];
samples.forEach((s, i) => { if (i && s.pos < samples[i - 1].pos - 0.5) runs.push([]); runs[runs.length - 1].push(s); });
const line = fit(runs.sort((a, b) => b.length - a.length)[0] || []);

console.log('\ntrack'.padEnd(22), 'ons', 'offs', 'ks<C1', 'keys'.padEnd(9), 'vel'.padEnd(8), 'stamp-fit (beats: median, worst)');
for (const [, s] of [...byTrack].sort((a, b) => a[0] - b[0])) {
  const ons = s.events.filter(e => e[1] === 1), offs = s.events.length - ons.length;
  const ks = ons.filter(e => e[2] < KS_MAX).length;
  const keys = ons.map(e => e[2]), vels = ons.map(e => e[3]);
  let stamp = '-';
  if (line) {
    const d = ons.filter(e => e[6] === 1).map(e => e[4] - line(e[5])).filter(x => Math.abs(x) < 4).sort((a, b) => a - b);
    if (d.length) stamp = `${d[d.length >> 1].toFixed(3)}, ${Math.max(Math.abs(d[0]), Math.abs(d[d.length - 1])).toFixed(3)}`;
  }
  console.log(String(s.name).padEnd(21), String(ons.length).padStart(3), String(offs).padStart(4), String(ks).padStart(5),
    (keys.length ? Math.min(...keys) + '-' + Math.max(...keys) : '-').padEnd(9), (vels.length ? Math.min(...vels) + '-' + Math.max(...vels) : '-').padEnd(8), stamp);
}
if (!byTrack.size) console.log('(nothing heard: was Bitwig playing?)');

// The selected track: heard keys against its selected clip's keys, and its devices (a Note FX before the instrument?)
const sel = [...byTrack.values()].find(s => s.name === notes.track);
if (sel && notes.exists) {
  const clipKeys = new Set(notes.notes.map(n => n.y));
  const heardKeys = new Set(sel.events.filter(e => e[1] === 1).map(e => e[2]));
  const extra = [...heardKeys].filter(k => !clipKeys.has(k)).sort((a, b) => a - b);
  const never = [...clipKeys].filter(k => !heardKeys.has(k)).sort((a, b) => a - b);
  console.log(`\nSelected track "${notes.track}": devices ${notes.devices.list.map(d => d.name + (d.on ? '' : ' (off)')).join(' > ') || '(none)'}`);
  console.log(`  heard keys not in the selected clip: ${extra.join(' ') || 'none'}   (keyswitches here = the observer reports after the Note FX)`);
  console.log(`  clip keys never heard: ${never.join(' ') || 'none'}   (only meaningful when the whole clip played)`);
}
console.log(`\n${samples.length} position samples while playing${line ? '' : ' (too few to fit the play position)'}; seq ${first.seq} -> ${seq}.`);
