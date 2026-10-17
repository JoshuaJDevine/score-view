// GUI slice 1, pure logic: palette matching / ranking / shortcut keys / task groups (features/palette.js), the status
// bar readout (features/statusbar.js) and the toast history (features/toasts.js).
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const P = require('../web/features/palette.js');
const S = require('../web/features/statusbar.js');
const T = require('../web/features/toasts.js');
const SB = require('../web/score.js');

// ---- fuzzy matching
assert.ok(P.fuzzyScore('hide', 'Hide keyswitches') > 0);
assert.ok(P.fuzzyScore('hk', 'View Hide keyswitches') != null, 'initials match');
assert.ok(P.fuzzyScore('hidke', 'View Hide keyswitches') != null, 'word prefixes match');
assert.equal(P.fuzzyScore('hide', 'Tracks: 1 shown Winds Clean'), null, 'letters scattered inside words do not match');
assert.equal(P.fuzzyScore('xyz', 'Hide keyswitches'), null);
assert.ok(P.fuzzyScore('key auto', 'Key: Auto') > 0, 'every word must match, any order');
assert.equal(P.fuzzyScore('key zzz', 'Key: Auto'), null);
assert.ok(P.fuzzyScore('print', 'Print / PDF') > P.fuzzyScore('print', 'Score: Print view helper'), 'a match at the start wins');
assert.ok(P.fuzzyScore('orch', 'Orchestrate') > P.fuzzyScore('orch', 'Write Score order chord'), 'a substring beats initials');
assert.equal(P.fuzzyScore('', 'anything'), 0);

// ---- ranking: recent first without a query; matches by score with a recency bonus
const cmds = [
  { id: 'a', text: 'Simplify rhythms' }, { id: 'b', text: 'Hide empty staves' }, { id: 'c', text: 'Hide keyswitches' },
  { id: 'd', text: 'Export MusicXML' },
];
assert.deepEqual(P.rank(cmds, '', ['d', 'b']).map(c => c.id), ['d', 'b', 'a', 'c']);
assert.deepEqual(P.rank(cmds, 'hide', []).map(c => c.id), ['b', 'c']);
assert.deepEqual(P.rank(cmds, 'hide', ['c']).map(c => c.id), ['c', 'b'], 'recently run wins a tie');
assert.deepEqual(P.rank(cmds, 'nothing here', []), []);

// ---- shortcut keys → KeyboardEvent init
assert.deepEqual(P.keyInit('Alt+Shift+S'), { bubbles: true, cancelable: true, ctrlKey: false, altKey: true, shiftKey: true, key: 'S', code: 'KeyS' });
assert.equal(P.keyInit('Q').key, 'q');
assert.equal(P.keyInit('Ctrl+3').code, 'Digit3');
assert.deepEqual([P.keyInit('Space').key, P.keyInit('Space').code], [' ', 'Space']);
assert.equal(P.keyInit('ArrowUp').key, 'ArrowUp');
assert.equal(P.keyInit('Escape').code, 'Escape');

// ---- tasks for the sheet
assert.equal(P.taskOf({ owner: 'motifs' }), 'Develop and orchestrate');
assert.equal(P.taskOf({ owner: 'somethingNew' }), 'Other');
const groups = P.groupByTask([{ owner: 'playback' }, { owner: 'core' }, { owner: 'x' }, { owner: 'mouse' }]);
assert.deepEqual(groups.map(g => [g.task, g.entries.length]), [['Select and edit notes', 2], ['Playback', 1], ['Other', 1]]);
assert.equal(P.cleanLabel('  Orchestrate ▾ '), 'Orchestrate');
assert.equal(P.cleanLabel('Print / PDF…'), 'Print / PDF');

// ---- status bar readout
const spellE = SB.makeSpeller(4), spellF = SB.makeSpeller(-1);
assert.equal(S.pitchName(61, spellE), 'C♯4');
assert.equal(S.pitchName(70, spellF), 'B♭4');
assert.equal(S.pitchName(60), 'C4');
assert.equal(S.durName(1.5), 'dotted quarter');
assert.equal(S.durName(1 / 3), '8th triplet');
assert.equal(S.durName(0.25), '16th');
assert.equal(S.durName(2.25), '2.25 beats');
assert.equal(S.durName(1), 'quarter');
const render = { measureBeats: 4, measureOffset: 0, measureStarts: [0, 4, 7], measureLengths: [4, 3, 4], offsetBeats: 0 };
assert.equal(S.barBeat(5.5, render, SB), 'bar 2 beat 2.5');
assert.equal(S.barBeat(7, render, SB), 'bar 3 beat 1', 'a 3/4 bar in between');
assert.equal(S.barBeat(2, null, null), 'beat 3');
const keyed = { keyFifths: 4, keyChanges: [{ measure: 3, beat: 8, fifths: -3 }] };
assert.deepEqual([S.keyAt(keyed, 0), S.keyAt(keyed, 7.9), S.keyAt(keyed, 8), S.keyAt(null, 3)], [4, 4, -3, 0],
  'spelling follows the key in force at the note (after a key change)');
assert.equal(S.summary([], 'Violin 1').text, 'Violin 1 · nothing selected');
assert.equal(S.summary([], null).text, 'Nothing selected');
const one = S.summary([{ pitch: 66, start: 4.5, dur: 1.5, artic: 'Legato' }], 'Violin 1', { render, SB, spell: spellE });
assert.equal(one.text, '1 note · Violin 1 · bar 2 beat 1.5 · F♯4 · dotted quarter · Legato');
const many = S.summary([{ pitch: 72, start: 8, dur: 1, artic: 'Legato' }, { pitch: 60, start: 4, dur: 0.5, artic: 'Staccato' },
  { pitch: 64, start: 4, dur: 1, artic: null }], 'Flute', { render, SB, spell: SB.makeSpeller(0) });
assert.equal(many.text, '3 notes · Flute · bar 2 beat 1 – bar 3 beat 2 · C4–C5 · mixed lengths · mixed articulations');
assert.equal(S.summary([{ pitch: 60, start: 0, dur: 1 }, { pitch: 60, start: 1, dur: 1 }], null).parts.slice(-2).join(' / '), 'C4 / quarter');

// ---- toast history
const h = T.createHistory(3);
['one', 'two', 'three', 'four'].forEach((m, i) => h.add(m, '', 1000 + i));
assert.deepEqual(h.list().map(e => e.msg), ['four', 'three', 'two'], 'newest first, capped');
assert.equal(h.size(), 3);
h.clear();
assert.equal(h.size(), 0);
assert.equal(T.guessKind('Could not read the arrangement'), 'err');
assert.equal(T.guessKind('Goto failed: clip not found'), 'err');
assert.equal(T.guessKind('No articulation map for Bass'), 'warn');
assert.equal(T.guessKind('Pasted 4 notes'), 'info');
assert.equal(h.add('x', 'ok').kind, 'ok', 'an explicit kind wins');

console.log('gui-test OK');
