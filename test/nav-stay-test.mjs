// gotoStay on the mock (the Sibelius-style paste that leaves Bitwig on the pasted clip), no browser:
// the session ends on the target, edits land there, /api/notes and /api/nav report it, the play start goes back
// (or stays on the clip with the preference), a failed gotoStay returns home and drops its edits.
// The real ClipNavigator is checked against a fake Bitwig in test/protocol-test.mjs (test/java/NavigatorCheck).
//   node test/nav-stay-test.mjs
import assert from 'assert';
import { startMockServer } from './mock-server.mjs';

const clip = (lane, track, start, playStop, notes = []) =>
  ({ lane, track, start, playStart: 0, playStop, loop: false, loopStart: 0, loopLength: playStop, notes });
const arrangement = () => ({
  tracks: [{ name: 'Piano' }, { name: 'Strings', group: true }, { name: 'Violins 1' }, { name: 'Cellos' }],
  home: 0,
  clips: [clip(0, 'Piano', 0, 16, [{ ch: 0, x: 0, y: 60, d: 1, vel: 100 }]), clip(2, 'Violins 1', 0, 8), clip(2, 'Violins 1', 8, 8), clip(3, 'Cellos', 4, 8)],
});

async function run(name, fn, opts = {}) {
  const srv = await startMockServer({ port: 0, markers: [], arrangement: arrangement(), ...opts });
  const post = body => fetch(srv.url + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body }).then(r => r.text());
  const get = p => fetch(srv.url + p).then(r => r.json());
  const notesOf = (track, start) => srv.arrangement.clips.find(c => c.track === track && c.start === start).notes.map(n => [n.x, n.y]);
  try { await fn({ srv, post, get, notesOf }); console.log('  ok ' + name); }
  finally { await srv.close(); }
}

await run('gotoStay ends the session on the target', async ({ srv, post, get, notesOf }) => {
  const v0 = (await get('/api/notes')).v;
  await post('gotoStay 2 8 Violins%201\nadd 0 24 72 100 1');
  const nav = await get('/api/nav');
  assert.equal(nav.session, false);
  assert.equal(nav.state, 'done');
  assert.equal(nav.batches, 1);
  assert.deepEqual(nav.stayed, { track: 'Violins 1', start: 8 });
  assert.equal(nav.lastTarget.stay, true);
  assert.match(nav.message, /^Stayed at Violins 1 @ 8/);
  assert.deepEqual(nav.results, ['ok: stay Violins 1 @ 8']);
  assert.deepEqual(notesOf('Violins 1', 8), [[24, 72]]);
  const notes = await get('/api/notes?v=' + v0); // the page is woken and sees the pasted clip
  assert(notes.v > v0);
  assert.equal(notes.track, 'Violins 1');
  assert.deepEqual(notes.notes.map(n => [n.x, n.y]), [[24, 72]]);
  assert.equal(notes.tracks.find(t => t.sel).name, 'Violins 1');
  assert.equal((await get('/api/transport')).playStart, 0, 'play start back where it was (the home clip)');
  await post('add 0 48 74 100 1'); // later edits go to the clip it stayed on, no auto-home
  assert.deepEqual(notesOf('Violins 1', 8), [[24, 72], [48, 74]]);
  assert.deepEqual(notesOf('Piano', 0), [[0, 60]]);
});

await run('play start preference: move it to the pasted clip', async ({ srv, post, get }) => {
  srv.nav.stayPlayStartAtTarget = true;
  await post('gotoStay 3 4 Cellos');
  assert.equal((await get('/api/transport')).playStart, 4);
  assert.equal((await get('/api/notes')).track, 'Cellos');
});

await run('a failed gotoStay goes home and drops its edits', async ({ post, get, notesOf }) => {
  await post('gotoStay 3 32 Cellos\nadd 0 0 48 100 1\nadd 0 24 50 100 1');
  const nav = await get('/api/nav');
  assert.equal(nav.session, false);
  assert.equal(nav.state, 'error');
  assert.equal(nav.batches, 1);
  assert.equal(nav.dropped, 2);
  assert.equal(nav.stayed, null);
  assert.match(nav.message, /Finished with errors: error: stay Cellos @ 32: No clip on Cellos/);
  assert.equal((await get('/api/notes')).track, 'Piano');
  assert.deepEqual(notesOf('Piano', 0), [[0, 60]], 'nothing written into the home clip');
  await post('add 0 24 62 100 1'); // the next batch applies again
  assert.deepEqual(notesOf('Piano', 0), [[0, 60], [24, 62]]);
});

await run('goto then gotoStay in one batch', async ({ post, get, notesOf }) => {
  await post('goto 3 4 Cellos\nadd 0 0 48 100 1\ngotoStay 2 0 Violins%201\nadd 0 0 72 100 1');
  const nav = await get('/api/nav');
  assert.equal(nav.session, false);
  assert.equal(nav.batches, 1);
  assert.deepEqual(nav.results, ['ok: goto Cellos @ 4', 'ok: stay Violins 1 @ 0']);
  assert.deepEqual(notesOf('Cellos', 4), [[0, 48]]);
  assert.deepEqual(notesOf('Violins 1', 0), [[0, 72]]);
  assert.equal((await get('/api/notes')).track, 'Violins 1');
});

await run('refused while playing: dropped and counted', async ({ srv, post, get, notesOf }) => {
  await post('play');
  await post('gotoStay 2 8 Violins%201\nadd 0 0 72 100 1');
  const nav = await get('/api/nav');
  assert.equal(nav.batches, 1);
  assert.equal(nav.message, 'Stop playback first.');
  assert.deepEqual(notesOf('Violins 1', 8), []);
  assert.deepEqual(notesOf('Piano', 0), [[0, 60]]);
  assert.equal(srv.nav.session, false);
});

await run('goto / gotoHome unchanged', async ({ post, get, notesOf }) => {
  await post('goto 2 8 Violins%201\nadd 0 0 72 100 1\ngotoHome 0');
  const nav = await get('/api/nav');
  assert.equal(nav.stayed, null);
  assert.equal(nav.lastTarget.home, true);
  assert.equal((await get('/api/notes')).track, 'Piano');
  assert.deepEqual(notesOf('Violins 1', 8), [[0, 72]]);
});

console.log('nav-stay-test: ok');
