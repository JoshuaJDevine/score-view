// Unit test of the "read is out of date" heuristic and the clip matching in web/features/arrangement.js.
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const A = require('../web/features/arrangement.js');

const row = (x, y, d = 1) => [0, x, y, d, 100];
const crawl = {
  stepsPerBeat: 24,
  tracks: [{ name: 'Pocket Strings' }, { name: 'Pigments' }],
  result: [
    { lane: 0, track: 'Pocket Strings', start: 0, playStart: 0, playStop: 16, notes: [row(0, 60, 4), row(0, 64, 4)] },
    { lane: 0, track: 'Pocket Strings', start: 32, playStart: 0, playStop: 16, notes: [row(0, 62, 4)] },
    { lane: 1, track: 'Pigments', start: 16, playStart: 4, playStop: 20, notes: [row(96, 72, 0.5)] },
  ],
};
const live = (track, notes, playStart = 0, length = 16) => ({ exists: true, track, playStart, length,
  notes: notes.map(([x, y, d]) => ({ ch: 0, x, y, d, vel: 100 })) });

// noteSig: order-independent, live and crawl rows agree
assert.equal(A.noteSig([row(0, 64, 4), row(0, 60, 4)]), A.noteSig(live('x', [[0, 60, 4], [0, 64, 4]]).notes));
assert.notEqual(A.noteSig([row(0, 60, 4)]), A.noteSig([row(0, 60, 2)]));

// matchClip: exact by notes + play range; then by play range; then the only clip on the track
let m = A.matchClip(crawl, live('Pocket Strings', [[0, 62, 4]]));
assert.ok(m.exact && m.clip.start === 32, 'second Strings clip by its notes');
m = A.matchClip(crawl, live('Pigments', [[96, 72, 0.5], [120, 74, 1]], 4, 20));
assert.ok(!m.exact && m.clip.start === 16, 'edited Pigments clip still found (only clip on the track)');
assert.equal(A.matchClip(crawl, live('Pocket Strings', [[0, 50, 1]])), null, 'two Strings clips with the same range: ambiguous');
assert.equal(A.matchClip(crawl, live('Harp', [[0, 50, 1]])), null);

// clipChanged
const snap = d => A.clipSnapshot(d);
assert.equal(A.clipChanged(crawl, snap(live('Pocket Strings', [[0, 60, 4], [0, 64, 4]]))), false);
assert.equal(A.clipChanged(crawl, snap(live('Pocket Strings', [[0, 60, 4]]))), true, 'a note deleted in Bitwig');
assert.equal(A.clipChanged(crawl, snap(live('Pocket Strings', [[0, 60, 4], [0, 64, 4]], 0, 32))), true, 'clip lengthened');
assert.equal(A.clipChanged(crawl, snap(live('Harp', []))), false, 'an empty new clip shows nothing new');
assert.equal(A.clipChanged(crawl, snap(live('Harp', [[0, 50, 1]]))), true, 'a new track with notes');

// staleReasons
const tracks = [{ name: 'Pocket Strings' }, { name: 'Pigments' }];
const seen = new Map();
const base = { crawl, tracksAtRead: tracks, tracksNow: tracks, seen, current: 'Pigments', edited: new Set() };
assert.deepEqual(A.staleReasons(base), []);
seen.set('Pocket Strings', snap(live('Pocket Strings', [[0, 60, 4], [0, 64, 4]])));
assert.deepEqual(A.staleReasons(base), [], 'an unchanged clip seen again');
seen.set('Pocket Strings', snap(live('Pocket Strings', [[0, 60, 4], [0, 65, 4]])));
assert.deepEqual(A.staleReasons(base), ['Pocket Strings changed'], 'changed in Bitwig, then another clip selected');
assert.deepEqual(A.staleReasons({ ...base, current: 'Pocket Strings' }), [], 'the selected clip is overlaid live');
assert.deepEqual(A.staleReasons({ ...base, edited: new Set(['Pocket Strings']) }), [], 'Score View edits are overlaid');
seen.clear();
assert.deepEqual(A.staleReasons({ ...base, tracksNow: [...tracks, { name: 'Harp' }] }), ['tracks changed (new: Harp)']);
assert.deepEqual(A.staleReasons({ ...base, tracksNow: [tracks[0]] }), ['tracks changed (gone: Pigments)']);
assert.deepEqual(A.staleReasons({ ...base, tracksNow: [tracks[1], tracks[0]] }), ['tracks were reordered']);
assert.deepEqual(A.staleReasons({ ...base, crawl: null }), [], 'no read, nothing to be out of date');

console.log('arrangement-stale-test OK');
