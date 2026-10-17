// Experiment: does "Move cursor to next lane" + "Select first item" walk tracks while staying in the clip area?
// Only runs on a project whose name contains "crawl".
// Needs Preferences > Score View > Developer mode on (the "act" op is a developer-only op).
const BASE = 'http://localhost:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async () => (await fetch(BASE + '/api/transport', { cache: 'no-store' })).json();
const act = async id => { await fetch(BASE + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body: 'act ' + id }); await sleep(250); return get(); };
const show = (label, s) => console.log(label.padEnd(34), s.clip.exists ? `${s.clip.track} @${s.playStart} len ${s.clip.length}` : `(no clip) playStart ${s.playStart}`);

const s0 = await get();
if (!/crawl/i.test(s0.project)) { console.error('Refusing: project is ' + s0.project); process.exit(2); }
show('start', s0);
const lanes = process.argv[2] ? Number(process.argv[2]) : 6;
for (let i = 0; i < lanes; i++) {
  show(`move cursor to next lane #${i + 1}`, await act('Move cursor to next lane'));
  show('  select first item', await act('Select first item'));
  show('  select next item', await act('Select next item'));
}
