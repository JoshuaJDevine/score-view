// Import into the live clip (web/features/import.js) against the mock server:
//  1) clip mode: a MusicXML file (exported here by web/features/musicxml.js, with a Bb clarinet) -> the clarinet part,
//     bars 1-2, at bar 3, replacing what is there; the mock clip must hold the concert pitches afterwards.
//  2) a MIDI file with 600 notes (chunked sending) merged at the clip start.
//  3) score mode (Mega Man 2 export, Bass clip placed at bar 25): a MIDI part at arranger bar 26 lands at clip beat 4.
// Screenshot: test/out.import-dialog.png      PORT=8861 node test/import-e2e.mjs
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { JSDOM } from 'jsdom';
import { withPage, ROOT, ScoreBuilder } from './lib.mjs';
import { midiFile, notesTrack } from './midi-file.mjs';

const require = createRequire(import.meta.url);
const MX = require('../web/features/musicxml.js');
const port = Number(process.env.PORT || 8861);
const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));
const tmp = f => path.join(ROOT, 'test', 'out.' + f);

// ---- input files
const clar = [{ id: 'a', start: 0, dur: 1, pitch: 65 }, { id: 'b', start: 1, dur: 1, pitch: 67 }, { id: 'c', start: 2, dur: 2, pitch: 69 },
              { id: 'd', start: 4, dur: 0.5, pitch: 70 }, { id: 'e', start: 4.5, dur: 0.5, pitch: 72 }, { id: 'f', start: 5, dur: 3, pitch: 74 },
              { id: 'g', start: 8, dur: 4, pitch: 77 }]; // bar 3: outside the chosen source bars
const score = { title: 'Import test', timeSig: { num: 4, den: 4 }, lengthBeats: 12,
                parts: [{ name: 'Flute', notes: [{ id: 'x', start: 0, dur: 4, pitch: 84 }] }, { name: 'Clarinet in Bb', notes: clar }] };
const built = ScoreBuilder.buildMEI(score, { grid: 1, simplify: false });
const prep = MX.prepareExport({ ...built, score }, { ScoreBuilder, buildOptions: { grid: 1 }, writtenPitch: true });
const xml = MX.fromMEI(prep.mei, { DOMParser: new JSDOM('').window.DOMParser, score: prep.score, staves: prep.staves, title: 'Import test' }).xml;
assert.match(xml, /<chromatic>-2<\/chromatic>/, 'clarinet exported in written pitch');
fs.writeFileSync(tmp('import.musicxml'), xml);

const many = Array.from({ length: 600 }, (_, i) => ({ start: i * 0.125, dur: 0.125, pitch: 40 + (i % 30), vel: 64 + (i % 50) }));
fs.writeFileSync(tmp('import-many.mid'), midiFile(1, 960, [notesTrack('Strings', 960, many)]));
const bassLine = [{ start: 0, dur: 1, pitch: 40 }, { start: 1, dur: 1, pitch: 43 }, { start: 2, dur: 2, pitch: 45 }];
fs.writeFileSync(tmp('import-bass.mid'), midiFile(1, 480, [notesTrack('Contrabass', 480, bassLine)]));

const openFile = async (page, file) => {
  await (await page.$('#sviFile')).uploadFile(file);
  await page.waitForSelector('#sviDialog', { timeout: 10000 });
};
const setForm = (page, values) => page.evaluate(v => {
  const dlg = document.getElementById('sviDialog');
  Object.entries(v).forEach(([k, val]) => {
    const radio = dlg.querySelector(`input[name="${k}"][value="${val}"]`);
    if (radio) radio.checked = true; else dlg.querySelector('#' + k).value = val;
  });
  dlg.dispatchEvent(new Event('change'));
  return document.getElementById('sviInfo').textContent;
}, values);
const waitDone = (page, n) => page.waitForFunction(t => !document.getElementById('sviDialog') && document.getElementById('flash').textContent.startsWith(t),
  { timeout: 20000 }, `Imported ${n} notes`);

// ---- 1 + 2: clip mode
await withPage({ port, width: 1500, height: 950 }, async ({ page, srv, errors }) => {
  const before = srv.state.data.notes.map(n => ({ ...n }));
  await openFile(page, tmp('import.musicxml'));
  const rows = await page.$$eval('.svi-parts tbody tr', trs => trs.map(t => [...t.cells].slice(1, 5).map(c => c.textContent.trim()).join(' | ')));
  console.log('parts:', rows);
  assert.equal(rows.length, 2);
  assert.match(rows[1], /Clarinet in Bb \| 7 \| F4–F5 \| sounds −2 st/);
  await page.click('.svi-parts tbody tr[data-i="1"]');
  const info = await setForm(page, { sviFrom: 1, sviTo: 2, sviTarget: 'bar', sviBar: 3, sviMode: 'replace' });
  console.log('info:', info);
  assert.match(info, /6 notes → bars 3–4/);
  await page.screenshot({ path: tmp('import-dialog.png') });
  srv.edits.length = 0;
  await page.click('#sviGo');
  await waitDone(page, 6);
  await settle();
  const notes = srv.state.data.notes;
  const inRange = notes.filter(n => n.x >= 192 && n.x < 384).map(n => [n.x, n.y, n.d]);
  console.log('bars 3-4 now:', JSON.stringify(inRange));
  assert.deepEqual(inRange, clar.slice(0, 6).map(n => [192 + n.start * 24, n.pitch, n.dur]), 'concert pitches at bar 3, old notes replaced');
  const outside = n => n.x < 192 || n.x >= 384;
  assert.deepEqual(notes.filter(outside), before.filter(outside).sort((p, q) => p.x - q.x || p.y - q.y), 'notes outside the range untouched');
  assert.ok(srv.edits.some(e => e.startsWith('del ')), 'replace deleted the old notes');

  // 2) 600 notes, merged at the clip start: several chunks, all arrive.
  const n0 = srv.state.data.notes.length;
  srv.edits.length = 0;
  let posts = 0;
  page.on('request', r => { if (r.url().endsWith('/api/edit')) posts++; });
  await openFile(page, tmp('import-many.mid'));
  await setForm(page, { sviTarget: 'clip', sviMode: 'merge' });
  await page.click('#sviGo');
  await waitDone(page, 600);
  await settle();
  const adds = srv.edits.filter(e => e.startsWith('add ')).length;
  console.log(`600-note MIDI: ${adds} adds in ${posts} requests, clip ${n0} -> ${srv.state.data.notes.length} notes`);
  assert.equal(adds, 600);
  assert.ok(posts >= 3, 'sent in chunks');
  assert.ok(!srv.edits.some(e => e.startsWith('del ')), 'merge deletes nothing');
  const n = srv.state.data.notes.find(q => q.x === 3 && q.y === 41);
  assert.ok(n && Math.abs(n.d - 0.125) < 1e-9 && n.vel === 65, 'MIDI note at step 3 (beat 0.125), 32nd long, velocity kept');
  assert.equal(errors.length, 0, errors.join('\n'));
});

// ---- 3: score mode
await withPage({ port: port + 50, fixture: path.join(ROOT, 'test/fixtures/live-bass.json'), mode: 'score', height: 1000 }, async ({ page, srv, errors }) => {
  await (await page.$('#fileInput')).uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => SV.state.base && SV.state.align, { timeout: 30000 });
  await page.evaluate(() => SV.cycleAlign(1));
  await settle();
  assert.equal(await page.evaluate(() => SV.state.align.offset), 96, 'Bass clip placed at bar 25');
  await openFile(page, tmp('import-bass.mid'));
  const info = await setForm(page, { sviTarget: 'bar', sviBar: 26, sviMode: 'merge' });
  console.log('score mode info:', info);
  assert.match(info, /3 notes → bars 26–26/);
  srv.edits.length = 0;
  await page.click('#sviGo');
  await waitDone(page, 3);
  console.log('ops:', srv.edits.join(' | '));
  assert.deepEqual(srv.edits, ['add 0 96 40 100 1', 'add 0 120 43 100 1', 'add 0 144 45 100 2'], 'arranger bar 26 = clip beat 4');
  assert.equal(errors.length, 0, errors.join('\n'));
});
console.log('import e2e ok');
