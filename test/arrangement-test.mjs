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
