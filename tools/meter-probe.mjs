// Measures how loud a track plays: plays the arrangement from a beat for a while and samples the track's peak output
// level (GET /api/meter, 0..127) every few ms. Changes only the transport (play position, play / stop), never notes.
//   node tools/meter-probe.mjs --track "Violin 1" --from 4 --ms 1500 [--step 25] [--port 8765] [--json]
// Prints one line per sample (ms since play, peak, a bar) and the onset (first sample >= 10) and maximum.
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 8765)), base = `http://127.0.0.1:${port}`;
const track = arg('track', ''), from = Number(arg('from', 0)), ms = Number(arg('ms', 1500)), step = Number(arg('step', 25));
const asJson = process.argv.includes('--json');
const sleep = t => new Promise(r => setTimeout(r, t));
const edit = ops => fetch(base + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body: ops.join('\n') });
const meter = async () => (await (await fetch(base + '/api/meter', { cache: 'no-store' })).json()).tracks;

export async function probe({ track, from, ms, step = 25 }) {
  await edit(['stop']);
  await sleep(400);
  await meter(); // reset the peaks
  await edit([`playFrom ${from}`]);
  const t0 = Date.now(), out = [];
  while (Date.now() - t0 < ms) {
    await sleep(step);
    const tr = (await meter()).find(t => t.name.startsWith(track));
    out.push({ ms: Date.now() - t0, peak: tr ? tr.peak : -1 });
  }
  await edit(['stop']);
  await sleep(300);
  const onset = out.find(s => s.peak >= 10);
  return { samples: out, onsetMs: onset ? onset.ms : null, max: Math.max(...out.map(s => s.peak)) };
}

if (process.argv[1] && process.argv[1].endsWith('meter-probe.mjs')) {
  const r = await probe({ track, from, ms, step });
  if (asJson) console.log(JSON.stringify(r));
  else {
    r.samples.forEach(s => console.log(String(s.ms).padStart(5), String(s.peak).padStart(4), '#'.repeat(Math.round(s.peak / 2))));
    console.log(`onset ${r.onsetMs} ms · max ${r.max}`);
  }
}
