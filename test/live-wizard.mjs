// Live New Score wizard steps (docs/wizard.md) against the running extension — NEW EMPTY PROJECT ONLY.
// Refuses unless the open project's name starts with "New" (Bitwig's default for File → New).
//   node test/live-wizard.mjs <step>     steps: bare | devices | bbcso | group | multi
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const W = require('../web/features/wizard-templates.js');
const inv = require('../web/features/wizard-plugins.js');
const BASE = 'http://localhost:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const t = await (await fetch(BASE + '/api/transport')).json();
if (!/^New\b/.test(t.project)) { console.error('Refusing: project is "' + t.project + '" (use File → New)'); process.exit(2); }

const lib = name => { const p = W.findPlugin(inv, name); if (!p) throw new Error(name + ' not installed'); return { kind: p.format, id: p.id, label: p.name }; };
const clap = name => { const p = (inv.plugins || []).find(x => x.name === name && x.format === 'clap'); return { kind: 'clap', id: p.id, label: p.name }; };
const step = process.argv[2] || 'bare';
const rows = {
  bare: [{ name: 'Wizard Bare', group: '', color: '#3fb7b0', lib: null, art: null }],
  devices: [
    { name: 'Wizard Pigments', group: '', color: '#3fb7b0', lib: lib('Pigments'), art: null },
    { name: 'Wizard Dexed', group: '', color: '#4c8fd6', lib: clap('Dexed'), art: null },
  ],
  bbcso: W.resolveTemplate('string-quartet', inv).slice(0, 1).map(r => ({ ...r, name: 'Wizard Violin' })),
  group: W.resolveTemplate('chamber-strings', inv).map(r => ({ ...r, lib: null, art: null })),
  multi: [
    { name: 'Flute', group: 'Winds', color: '#5aa469', lib: clap('Dexed'), art: null },
    { name: 'Clarinet', group: 'Winds', color: '#5aa469', lib: clap('Dexed'), art: null },
    { name: 'Horn', group: 'Brass', color: '#d0573f', lib: clap('Dexed'), art: null },
    { name: 'Trumpet', group: 'Brass', color: '#d0573f', lib: clap('Dexed'), art: null },
    { name: 'Tuba', group: 'Brass', color: '#d0573f', lib: clap('Dexed'), art: null },
  ],
}[step];
if (!rows) { console.error('unknown step ' + step); process.exit(2); }

const plan = W.buildPlan(rows, { position: -1 });
console.log('plan:\n' + plan);
const t0 = Date.now();
const res = await fetch(BASE + '/api/wizard', { method: 'POST', headers: { 'X-ScoreView': '1' }, body: plan });
console.log('POST', res.status, (await res.text()).slice(0, 200));
let st;
for (let i = 0; i < 600; i++) {
  await sleep(500);
  st = await (await fetch(BASE + '/api/wizard')).json();
  if (!['queued', 'running'].includes(st.state)) break;
}
console.log(`state ${st.state} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify(st, null, 1).slice(0, 2500));
const d = await (await fetch(BASE + '/api/notes?v=-1')).json();
console.log('tracks now:', d.tracks.map(x => (x.group ? '[' + x.name + ']' : x.name)).join(', '));
