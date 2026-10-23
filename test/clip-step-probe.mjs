// Probe against the LIVE extension (manual): does CursorClip.selectNext() walk arranger clips when it starts from a
// VALID selected clip? (The first probe, test/crawl-probe.mjs T2, ran it with no clip selected.) The extension's
// Developer-mode op 'clipStepProbe [n]' (ClipStepProbe.java) calls selectNext() n times, then selectPrevious() n times,
// records what the cursor clip shows after each call, and puts the play start marker back. The shipped crawl never
// uses it. It moves Bitwig's clip selection, so it refuses unless the project's name contains "crawl" (a Save-As copy).
// Needs Preferences > Score View > Developer mode on.
//   1. Open a Save-As copy named "… crawl …", click a clip in the Arranger (not a note), stop playback.
//   2. node test/clip-step-probe.mjs [n=3]
const BASE = process.env.SV_BASE || 'http://localhost:8765';
const n = Number(process.argv[2] || 3);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async () => (await fetch(BASE + '/api/transport', { cache: 'no-store' })).json();

const t0 = await get();
if (!/crawl/i.test(t0.project || '')) { console.error(`Refusing: the open project is "${t0.project}". Save a copy whose name contains "crawl" and open it.`); process.exit(2); }
if (t0.playing) { console.error('Stop the transport first.'); process.exit(2); }
if (!t0.clip || !t0.clip.exists) { console.error('Click a clip in the Arranger first: the probe must start from a valid clip.'); process.exit(2); }
if (!t0.probe) { console.error('This extension has no clipStepProbe (GET /api/transport has no "probe"): build and install the branch first.'); process.exit(2); }
console.log(`Start: ${t0.clip.track} @ ${t0.playStart} (${t0.clip.notes} notes, length ${t0.clip.length})`);
await fetch(BASE + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body: 'clipStepProbe ' + n });
let t;
for (let i = 0; i < 200; i++) {
  await sleep(150);
  t = await get();
  if (/refused/.test(t.lastAction)) { console.error(t.lastAction + ' (Developer mode on? a read running?)'); process.exit(1); }
  if (t.probe.state === 'done' || t.probe.state === 'error') break;
}
const p = t.probe;
console.log(`${p.state}: ${p.message}`);
const show = s => `${s.exists ? s.track : '(no clip)'} @ ${s.playStart} len ${s.length} notes ${s.notes} hasNext ${s.hasNext} hasPrevious ${s.hasPrevious}`;
if (p.origin) console.log('origin      ', show(p.origin));
(p.steps || []).forEach((s, i) => console.log(`${String(i + 1).padStart(2)} ${s.dir.padEnd(4)} ${s.changedMs < 0 ? 'no change ' : (s.changedMs + ' ms').padEnd(10)}`, show(s)));
const moved = (p.steps || []).filter(s => s.dir === 'next' && s.changedMs >= 0).length;
console.log(moved ? `selectNext() changed the clip ${moved} of ${n} times: compare the tracks / play starts above with the Arranger.`
  : 'selectNext() did not change the cursor clip from a valid selection.');
