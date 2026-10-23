// Unit test of the arrangement mirror (web/features/arrangement-mirror.js) and the incremental base rebuild /
// out-of-date info in web/features/arrangement.js: harvesting the selected clip (upsert, suspects), where it sits
// (placeSelected), merging a targeted re-read, stored documents, updateScore = crawlToScore on the Mega Man 2 read.
//   node test/arrangement-mirror-test.mjs
import assert from 'assert';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../web/features/arrangement-mirror.js');
const A = require('../web/features/arrangement.js');

const row = (x, y, d = 1) => [0, x, y, d, 100];
const clip = (track, start, notes, extra = {}) => ({ lane: track === 'Strings' ? 0 : 1, track, start, playStart: 0, playStop: 16, loop: false,
  loopStart: 0, loopLength: 16, notes, ...extra });
const crawl = () => ({
  stepsPerBeat: 24,
  tracks: [{ name: 'Strings', group: false }, { name: 'Pigments', group: false }],
  result: [clip('Strings', 0, [row(0, 60, 4)]), clip('Strings', 32, [row(0, 62, 4)]), clip('Pigments', 16, [row(96, 72)])],
});
const live = (track, notes, extra = {}) => ({ exists: true, track, playStart: 0, length: 16, loop: false, loopStart: 0, loopLength: 16,
  notes: notes.map(([x, y, d = 1]) => ({ ch: 0, x, y, d, vel: 100 })), ...extra });

// clipFromLive / sameContent
const c0 = M.clipFromLive(live('Strings', [[0, 60, 4]]), 0);
assert.deepEqual(c0.notes, [[0, 0, 60, 4, 100]]);
assert.ok(M.sameContent(c0, crawl().result[0]));
assert.ok(!M.sameContent(c0, crawl().result[1]));
assert.ok(!M.sameContent({ ...c0, playStop: 32 }, crawl().result[0]), 'play range counts');
assert.equal(M.similarity([row(0, 60), row(24, 62)], [row(0, 60)]), 0.5);

// upsertClip: unchanged -> none (same object back)
let cr = crawl();
let up = M.upsertClip(cr, c0, 5);
assert.equal(up.action, 'none');
assert.equal(up.crawl, cr);
// edited in Bitwig at the same start -> update in place, lane kept, other clips untouched
up = M.upsertClip(cr, M.clipFromLive(live('Strings', [[0, 60, 4], [48, 64]]), 0), 5);
assert.equal(up.action, 'update');
assert.equal(up.crawl.result.length, 3);
assert.equal(up.crawl.result[0].notes.length, 2);
assert.equal(up.crawl.result[0].seenAt, 5);
assert.equal(up.crawl.result[0].lane, 0);
assert.deepEqual(up.suspects, []);
assert.equal(cr.result[0].notes.length, 1, 'the old crawl is not modified');
// a measured looping clip keeps its length
cr.result[1].length = 24;
up = M.upsertClip(cr, M.clipFromLive(live('Strings', [[0, 63, 4]]), 32), 5);
assert.equal(up.crawl.result[1].length, 24);
// the same clip at a new start: added there, the old one suspect (moved or copied: the mirror cannot tell)
cr = crawl();
up = M.upsertClip(cr, M.clipFromLive(live('Pigments', [[96, 72]]), 48), 7);
assert.equal(up.action, 'add');
assert.equal(up.clip.lane, 1, 'lane of the track');
assert.deepEqual(up.suspects.map(c => c.start), [16]);
assert.equal(up.crawl.result.find(c => c.start === 16).suspect, true);
// confirmed when seen again where the mirror has it
up = M.upsertClip(up.crawl, M.clipFromLive(live('Pigments', [[96, 72]]), 16), 9);
assert.equal(up.action, 'confirm');
assert.equal(up.crawl.result.find(c => c.start === 16).suspect, undefined);
// a new clip covering another one's start: that one is suspect (Bitwig never overlaps clips on a lane)
up = M.upsertClip(crawl(), M.clipFromLive(live('Strings', [[0, 50]], { length: 48 }), 8), 1);
assert.deepEqual(up.suspects.map(c => c.start), [32]);
// an empty new clip is a clip too (somewhere to paste into); empty clips do not make others suspect
up = M.upsertClip(crawl(), M.clipFromLive(live('Harp', []), 64), 1);
assert.equal(up.action, 'add');
assert.equal(up.clip.lane, 0);

// mergeSubset: found tracks replaced; a wanted track not found after a complete walk has no clips; incomplete keeps it
cr = crawl();
const sub = { subset: ['Strings', 'Pigments'], found: ['Strings'], complete: true, tracks: [{ name: 'Strings' }, { name: 'Pigments' }, { name: 'Harp' }],
  result: [clip('Strings', 8, [row(0, 65)])] };
let mg = M.mergeSubset(cr, sub, 3);
assert.deepEqual(mg.crawl.result.map(c => c.track + '@' + c.start), ['Strings@8']);
assert.deepEqual(mg.tracks.sort(), ['Pigments', 'Strings']);
assert.equal(mg.crawl.tracks.length, 3, 'the read\'s track list is the current one');
assert.equal(mg.crawl.result[0].seenAt, 3);
mg = M.mergeSubset(cr, { ...sub, complete: false }, 3);
assert.deepEqual(mg.crawl.result.map(c => c.track + '@' + c.start).sort(), ['Pigments@16', 'Strings@8']);
// syncTracks: gone tracks' clips go, the list follows Bitwig
const synced = M.syncTracks(cr, [{ name: 'Pigments', group: false }, { name: 'Group', group: true }]);
assert.deepEqual(synced.result.map(c => c.track), ['Pigments']);
assert.deepEqual(synced.tracks, [{ name: 'Pigments', group: false }, { name: 'Group', group: true }]);

// placeSelected
const mirrorAt = cr2 => (track, beat) => cr2.result.find(c => c.track === track && Math.abs(c.start - beat) < 1e-6) || null;
const obs = (d, ps, extra = {}) => ({ track: d.track, sig: M.noteSig(d.notes), key: [d.track, d.length, d.playStart, d.loopStart, d.loopLength].join('|'),
  notes: d.notes, ps, nav: { session: false, batches: 0, stayed: null }, clipAt: mirrorAt(crawl()), ...extra });
const dA = live('Strings', [[0, 60, 4], [24, 62], [48, 64], [72, 65]]);
let p = M.placeSelected(null, obs(dA, 32));
assert.deepEqual([p.start, p.via], [32, 'marker'], 'the marker is the selected clip\'s start');
// edited where it is: same start
const dA2 = live('Strings', [[0, 60, 4], [24, 62], [48, 64], [72, 67]]);
let q = M.placeSelected(p.memo, obs(dA2, 32));
assert.equal(q.start, 32);
// the marker moved by hand (ruler), clip unchanged, no mirrored copy there: skip, unsure
q = M.placeSelected(p.memo, obs(dA, 40));
assert.ok(q.skip && q.unsure, JSON.stringify(q));
// ... then edited: still unsure (the old clip edited after a ruler click, or an edited copy just duplicated to 40:
// the mirror cannot tell, and must not put the copy's notes over the clip at 32)
let r2 = M.placeSelected(q.memo, obs(dA2, 40));
assert.ok(r2.skip && r2.unsure, JSON.stringify(r2));
r2 = M.placeSelected(r2.memo, obs(live('Strings', [[0, 60, 4], [24, 62], [48, 66], [72, 67]]), 40));
assert.ok(r2.skip && r2.unsure, 'stays unsure while that clip is edited');
// ... until the mirror has exactly these notes at the marker (the clip at 32 selected again)
r2 = M.placeSelected(q.memo, obs(dA, 32, { clipAt: mirrorAt({ result: [clip('Strings', 32, dA.notes.map(n => row(n.x, n.y, n.d)))] }) }));
assert.equal(r2.start, 32);
// the marker moved (ruler) onto another mirrored clip of the track, then the old clip was edited: unsure, never
// written over the clip at the marker
const mA = { result: [clip('Strings', 32, dA.notes.map(n => row(n.x, n.y, n.d))), clip('Strings', 64, [row(0, 40), row(24, 41)])] };
r2 = M.placeSelected(p.memo, obs(dA2, 64, { clipAt: mirrorAt(mA) }));
assert.ok(r2.skip && r2.unsure, JSON.stringify(r2));
// the edit was not harvested and the marker moved: the edited clip seen anywhere new is not placed at its old start
r2 = M.placeSelected(p.memo, obs(dA2, 48));
assert.ok(r2.skip && r2.unsure, 'an edit after the marker moved (or an edited copy): unsure');
// a different clip of the same size on the track, selected (marker at its start), the mirror has it there: the marker
const dB = live('Strings', [[0, 60, 4]]);
q = M.placeSelected(p.memo, obs(dB, 0));
assert.equal(q.start, 0);
// a clip the mirror does not have (mostly other notes), marker at its start: the marker (it is added)
q = M.placeSelected(p.memo, obs(live('Strings', [[0, 50], [24, 52]]), 8));
assert.equal(q.start, 8);
// ... and the mirror holds another clip there that looks more like it than the clip seen before: that one, changed
q = M.placeSelected(p.memo, obs(live('Strings', [[0, 50], [24, 52]]), 8, { clipAt: mirrorAt({ result: [clip('Strings', 8, [row(0, 50)])] }) }));
assert.equal(q.start, 8);
// another clip of the same track, its play start marker not there yet (the marker still at the old clip): not over
// the old clip; the old memo is kept, so the marker arriving places it
const dC = live('Strings', [[0, 70], [24, 71], [48, 72]]);
q = M.placeSelected(p.memo, obs(dC, 32));
assert.ok(q.skip && q.unsure, JSON.stringify(q));
assert.equal(q.memo.start, 32, 'the clip seen before stays the reference');
q = M.placeSelected(q.memo, obs(dC, 96));
assert.equal(q.start, 96, 'the marker arrived: placed there');
// ... but the same clip quantized in Bitwig (every note moved a little, live 2026-10-18: Violin 2's read kept the
// unquantized notes, a 16th early in the score) is this clip, edited: placed where it is
const dQ = live('Strings', [[0, 60, 4], [22, 62], [50, 64], [69, 65]]);
q = M.placeSelected(M.placeSelected(null, obs(dQ, 32)).memo, obs(dA, 32));
assert.deepEqual([q.skip, q.start], [undefined, 32], JSON.stringify(q));
assert.equal(M.nudged(dQ.notes, dA.notes, 12), true);
assert.equal(M.nudged(dQ.notes, dA.notes, 2), false, 'moved further than the tolerance');
assert.equal(M.nudged(dA.notes, dC.notes, 12), false, 'other pitches: another clip');
// ... and the quantized clip with the marker still lagging at another clip's start is not "nudged" (moved): unsure stays
q = M.placeSelected(M.placeSelected(null, obs(dQ, 32)).memo, obs(dA, 64, { clipAt: mirrorAt(mA) }));
assert.ok(q.skip && q.unsure, JSON.stringify(q));
// ... but a big edit Score View made is an edit: placed where it is
q = M.placeSelected(p.memo, obs(dC, 32, { edited: true }));
assert.equal(q.start, 32);
// ... and so is a one-note change of a small clip
const dS = live('Strings', [[0, 60]]);
q = M.placeSelected(M.placeSelected(null, obs(dS, 32)).memo, obs(live('Strings', [[0, 62]]), 32));
assert.equal(q.start, 32);
// an identical copy that the mirror has at the new marker: fine
q = M.placeSelected(M.placeSelected(null, obs(live('Strings', [[0, 60, 4]]), 0)).memo, obs(live('Strings', [[0, 60, 4]]), 32,
  { clipAt: mirrorAt({ result: [clip('Strings', 32, [row(0, 60, 4)])] }) }));
assert.equal(q.start, 32);
// another track at the same bar (the marker did not move): the marker
q = M.placeSelected(p.memo, obs(live('Pigments', [[96, 72]]), 32));
assert.equal(q.start, 32);
// Score View is navigating: skip; a gotoStay that left the marker behind: where the navigator stayed
q = M.placeSelected(p.memo, obs(dB, 0, { nav: { session: true, batches: 0 } }));
assert.ok(q.skip && !q.unsure);
q = M.placeSelected(p.memo, obs(live('Pigments', [[96, 72]]), 0, { nav: { session: false, batches: 1, stayed: { track: 'Pigments', start: 48 } } }));
assert.deepEqual([q.start, q.via], [48, 'nav']);
const q2 = M.placeSelected(q.memo, obs(live('Pigments', [[96, 72], [120, 74]]), 0, { nav: { session: false, batches: 1, stayed: { track: 'Pigments', start: 48 } } }));
assert.equal(q2.start, 48, 'edits of the stayed clip stay there');
// first look after a reload, on a clip pasted into (marker elsewhere): not sure
q = M.placeSelected(null, obs(live('Pigments', [[96, 72]]), 0, { nav: { session: false, batches: 4, stayed: { track: 'Pigments', start: 48 } } }));
assert.ok(q.skip);

// stored documents
const doc = M.makeDoc({ project: 'Song', crawl: crawl(), readAt: 10, savedAt: 20, tracksAtRead: [{ name: 'Strings', index: 0 }] });
assert.deepEqual(doc.tracksAtRead, [{ name: 'Strings' }]);
assert.ok(M.validDoc(doc, 'Song'));
assert.ok(!M.validDoc(doc, 'Other'));
assert.ok(!M.validDoc({ ...doc, v: 2 }, 'Song'));
assert.equal(M.pickDoc([null, { ...doc, savedAt: 30 }, doc], 'Song').savedAt, 30, 'newest');
assert.equal(M.pickDoc([{ ...doc, project: 'Other' }], 'Song'), null);
// another unsaved project with the same name ("Untitled") is not taken for this one
const two = { ...doc, tracksAtRead: [{ name: 'Strings' }, { name: 'Pigments' }] };
assert.ok(M.tracksAgree(two, [{ name: 'Strings' }, { name: 'Pigments' }, { name: 'Harp' }]));
assert.ok(!M.tracksAgree(two, [{ name: 'Bass' }, { name: 'Drums' }, { name: 'Strings' }]));
assert.ok(M.tracksAgree(two, null) && M.tracksAgree({ ...doc, tracksAtRead: [] }, [{ name: 'Bass' }]));

// updateScore: rebuilding one track gives what a full crawlToScore gives
const mm = JSON.parse(fs.readFileSync(new URL('./fixtures/crawl-megaman2.json', import.meta.url), 'utf8'));
const full = A.crawlToScore(mm, { title: 'MM2' });
const target = mm.result.find(c => c.track === 'Viola');
const edited = { ...mm, result: mm.result.map(c => c === target ? { ...c, notes: c.notes.concat([[0, 0, 70, 1, 100]]) } : c) };
const inc = A.updateScore(full, edited, ['Viola']);
assert.equal(inc.full, false);
const ref = A.crawlToScore(edited, { title: 'MM2' });
assert.deepEqual(inc.score.parts, ref.parts);
assert.equal(inc.score.lengthBeats, ref.lengthBeats);
assert.notEqual(inc.score, full);
assert.equal(inc.score.parts.find(p => p.name === 'Violin 1'), full.parts.find(p => p.name === 'Violin 1'), 'other parts are reused');
// a track gone from the read: full rebuild
const without = { ...mm, result: mm.result.filter(c => c.track !== 'Harp') };
assert.equal(A.updateScore(full, without, ['Harp']).full, true);
assert.deepEqual(A.updateScore(full, without, ['Harp']).score.parts.map(p => p.name), A.crawlToScore(without).parts.map(p => p.name));

// staleInfo: suspects and unplaced clips are listed with the tracks to re-read; gone tracks are not re-read
const sus = { ...crawl(), result: crawl().result.map(c => c.start === 16 ? { ...c, suspect: true } : c) };
const tracks = [{ name: 'Strings' }, { name: 'Pigments' }];
let info = A.staleInfo({ crawl: sus, tracksAtRead: tracks, tracksNow: tracks, seen: new Map(), current: null, barOf: b => b / 4 + 1 });
assert.deepEqual(info.reasons, ['Pigments: the clip at bar 5 may have moved']);
assert.deepEqual(info.refresh, ['Pigments']);
info = A.staleInfo({ crawl: crawl(), tracksAtRead: tracks, tracksNow: [tracks[0], { name: 'Harp' }], seen: new Map(), unsure: new Set(['Strings']) });
assert.deepEqual(info.added, ['Harp']);
assert.deepEqual(info.gone, ['Pigments']);
assert.deepEqual(info.refresh, ['Harp', 'Strings']);
assert.match(info.reasons[1], /Strings: a clip the read does not have/);
assert.deepEqual(A.staleReasons({ crawl: crawl(), tracksAtRead: tracks, tracksNow: tracks, seen: new Map() }), []);

// The marker is not always on the selected clip (live 2026-10-23): it is taken only where the read agrees.
{
  const notesOf = d => d.notes.map(n => row(n.x, n.y, n.d));
  const sel = live('Violin 1', [[120, 65], [180, 58], [264, 68], [324, 65], [383, 61], [408, 67]]);
  const read = { result: [clip('Violin 1', 0, []), clip('Violin 1', 32, [row(192, 63, 6.9)]), clip('Violin 1', 171.6, notesOf(sel))] };
  const withRead = cr2 => ({ clipAt: mirrorAt(cr2), clipsOf: t => cr2.result.filter(c => c.track === t) });
  // the bar 43 clip selected, the marker left at beat 0 on the track's empty bar 1 clip: never written over it,
  // placed by its notes instead (one clip of the track has exactly these)
  let r = M.placeSelected(null, obs(sel, 0, withRead(read)));
  assert.deepEqual([r.start, r.via], [171.6, 'content'], JSON.stringify(r));
  // ... and an edit of it right after (marker still at 0, same clip) stays there
  const sel2 = live('Violin 1', [[120, 65], [180, 58], [264, 68], [324, 65], [384, 61], [408, 67]]);
  r = M.placeSelected(r.memo, obs(sel2, 0, withRead(read)));
  assert.deepEqual([r.start, r.via], [171.6, 'content'], 'an edit stays where the clip was found');
  // the marker on no clip of the track and no clip with these notes (a copy edited, a new clip): unsure, not written
  r = M.placeSelected(null, obs(live('Violin 1', [[0, 50], [24, 52]]), 48, withRead(read)));
  assert.ok(r.skip && r.unsure, JSON.stringify(r));
  // two clips with exactly these notes and the marker on neither: unsure (which one cannot be told)
  const twice = { result: [...read.result, clip('Violin 1', 300, notesOf(sel))] };
  r = M.placeSelected(null, obs(sel, 0, withRead(twice)));
  assert.ok(r.skip && r.unsure, JSON.stringify(r));
  // the marker on the clip itself, quantized in Bitwig (nudged): there
  const q16 = live('Violin 1', [[192, 63, 6.9]]);
  r = M.placeSelected(null, obs(live('Violin 1', [[194, 63, 6.9]]), 32, withRead(read)));
  assert.deepEqual([r.start, r.via], [32, 'marker'], JSON.stringify(r));
  r = M.placeSelected(null, obs(q16, 32, withRead(read)));
  assert.equal(r.start, 32);
  // a track the read has no clip of (a new track or a new score): the marker
  r = M.placeSelected(null, obs(live('Harp', [[0, 50]]), 16, withRead(read)));
  assert.deepEqual([r.start, r.via], [16, 'marker']);
}

console.log('arrangement-mirror-test OK');
