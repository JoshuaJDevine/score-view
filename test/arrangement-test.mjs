// Crawl result -> base score: compared against the DAWproject export using the saved live crawl (test/fixtures/crawl-megaman2.json).
import assert from 'assert';
import fs from 'fs';
import { createRequire } from 'module';
import { loadFixtureScore } from './lib.mjs';

const { crawlToScore } = createRequire(import.meta.url)('../web/features/arrangement.js');

// Synthetic: loop pass, offset content, content end.
const synth = crawlToScore({ stepsPerBeat: 24, tracks: [{ name: 'Strings', group: true }, { name: 'Vln', group: false }], result: [
  { track: 'Vln', start: 0, playStart: 0, playStop: 4, loop: true, loopStart: 0, loopLength: 4, notes: [[0, 0, 60, 1, 100], [0, 48, 62, 1, 100]] },
  { track: 'Vln', start: 10, playStart: 2, playStop: 8, loop: false, loopStart: 0, loopLength: 8, notes: [[0, 0, 70, 1, 100], [0, 48, 72, 1, 100], [0, 120, 74, 1, 100]] },
] });
const v = synth.parts[0];
assert.equal(v.group, 'Strings');
// A looping clip whose visible length is unknown plays one loop pass (Bitwig does not expose the length);
// the second clip starts 2 beats into its content and stops at its content end.
assert.deepEqual(v.notes.map(n => [n.start, n.pitch]), [[0, 60], [2, 62], [10, 72], [13, 74]]);
// The song runs to the last clip's end (beat 16), not to its last note (ends at 14).
assert.equal(synth.lengthBeats, 16);

// A project made with New (crawl.fresh, SVArrangementMirror.freshCrawl): every instrument track is a staff with or
// without clips (not groups, effect, master or audio tracks); the form length and template meter / markers hold until
// clips reach further.
const M = createRequire(import.meta.url)('../web/features/arrangement-mirror.js');
const fresh = M.freshCrawl([{ name: 'Strings', group: true }, { name: 'Vln', type: 'Instrument' }, { name: 'Vc', type: 'Instrument' },
  { name: 'Vox', type: 'Audio' }, { name: 'FX 1', type: 'Effect' }, { name: 'Master', type: 'Master' }],
  { timeSig: { num: 3, den: 4 }, lengthBeats: 24, markers: [{ beat: 0, name: 'Intro' }] });
let fs1 = crawlToScore(fresh);
assert.deepEqual(fs1.parts.map(p => [p.name, p.group, p.notes.length]), [['Vln', 'Strings', 0], ['Vc', 'Strings', 0]]);
assert.equal(fs1.fresh, true);
assert.equal(fs1.lengthBeats, 24);
assert.deepEqual(fs1.timeSig, { num: 3, den: 4 });
assert.deepEqual(fs1.markers, [{ beat: 0, name: 'Intro' }], 'template markers when Bitwig has none');
fs1 = crawlToScore({ ...fresh, result: [{ track: 'Vc', start: 30, playStart: 0, playStop: 6, notes: [[0, 0, 48, 1, 100]] }] });
assert.deepEqual(fs1.parts.map(p => [p.name, p.notes.length]), [['Vln', 0], ['Vc', 1]], 'empty staves stay once clips arrive');
assert.equal(fs1.lengthBeats, 36);
assert.equal(crawlToScore({ ...fresh, fresh: undefined }).parts.length, 0, 'a normal read keeps only tracks with notes');

// Real crawl vs the export.
const crawl = JSON.parse(fs.readFileSync(new URL('./fixtures/crawl-megaman2.json', import.meta.url)));
const score = crawlToScore(crawl);
const base = await loadFixtureScore();
for (const part of base.parts) {
  const c = score.parts.find(p => p.name === part.name);
  assert(c, 'crawled part ' + part.name);
  const byPitch = new Map();
  c.notes.forEach(n => { if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []); byPitch.get(n.pitch).push(n.start); });
  const hit = part.notes.filter(n => (byPitch.get(n.pitch) || []).some(s => Math.abs(s - n.start) < 0.06)).length;
  assert(hit / part.notes.length >= 0.98, `${part.name}: ${hit}/${part.notes.length}`);
  assert.equal(c.group, part.group, part.name + ' group');
}
console.log('arrangement tests passed:', score.parts.length, 'parts');
