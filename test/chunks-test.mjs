// Unit test of chunked engraving: ScoreBuilder's built.chunks (web/score.js: a run of bars as its own MEI document) and
// web/core/chunks.js (system breaks, hidden staves, cache keys), on synthetic scores and the Mega Man 2 crawl; each
// chunk engraved with Verovio must be exactly one system. The page side is test/chunked-e2e.mjs.
//   node test/chunks-test.mjs
import fs from 'fs';
import assert from 'assert/strict';
import { createRequire } from 'module';
import { renderMEI, ScoreBuilder as SB, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const SC = require('../web/core/chunks.js');
const { crawlToScore } = require('../web/features/arrangement.js');
const { JSDOM } = await import('jsdom');
const parser = new (new JSDOM('').window.DOMParser)();

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
}
const xml = mei => {
  const doc = parser.parseFromString(mei, 'application/xml');
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, 'well-formed XML');
  return doc;
};
const ids = (doc, tag) => [...doc.getElementsByTagName(tag)].map(e => e.getAttribute('xml:id')).filter(Boolean);
const N = (id, start, dur, pitch) => ({ id, start, dur, pitch });
const PAGE = { pageWidth: 2727, marginLeft: 60, marginRight: 40 };
const VRV = { scale: 55, pageWidth: 2727, pageHeight: 60000, adjustPageHeight: true, pageMarginLeft: 60, pageMarginRight: 40,
  header: 'none', footer: 'none', condense: 'none', breaks: 'encoded', minLastJustification: 0, mnumInterval: 1 };
const systems = svg => (svg.match(/class="system"/g) || []).length;

// Two parts over 8 bars: a violin note tied over the bar line 4 | 5, a slur and a crescendo over it, a cello in tenor
// clef from bar 5 (a clef change), a key change at bar 5, a tempo change, a rest-only part (hidden in a chunk).
function synthetic() {
  const vn = [N('v1', 0, 4, 76), N('v2', 4, 4, 77), N('v3', 8, 4, 79), N('v4', 12, 6, 81), N('v5', 18, 2, 79)];
  for (let b = 5; b < 8; b++) vn.push(N('v' + (b * 2), b * 4, 2, 76), N('v' + (b * 2 + 1), b * 4 + 2, 2, 74));
  const vc = [N('c1', 0, 4, 36), N('c2', 4, 4, 38)];
  for (let b = 4; b < 8; b++) vc.push(N('c' + (b + 10), b * 4, 4, 64 + b)); // high: tenor clef
  return {
    title: 'T', timeSig: { num: 4, den: 4 }, keyFifths: 0, lengthBeats: 32, tempo: 100,
    keyChanges: [{ beat: 16, fifths: 2 }], tempoChanges: [{ beat: 20, bpm: 80 }],
    parts: [
      { name: 'Violin', notes: vn, slurs: [{ start: 'v3', end: 'v5' }], hairpins: [{ start: 10, end: 19, form: 'cres', id: 'hp1' }] },
      { name: 'Cello', clef: ['F', 4], altClefs: [['C', 4]], notes: vc },
      { name: 'Tacet', notes: [N('t1', 0, 1, 60)] },
    ],
  };
}

await check('the full document is the run of all bars; chunks partition the bars, notes and measures', async () => {
  const b = SB.buildMEI(synthetic(), { grid: 2 });
  assert.equal(b.chunks.mei(0, b.measures - 1), b.mei, 'mei = chunks.mei(0, last)');
  const full = xml(b.mei);
  const parts = [[0, 2], [3, 4], [5, b.measures - 1]].map(([a, z], i) => xml(b.chunks.mei(a, z, { abbr: i > 0, system: true })));
  assert.deepEqual(parts.flatMap(d => ids(d, 'measure')), ids(full, 'measure'), 'every measure once, in order');
  assert.deepEqual(parts.flatMap(d => ids(d, 'note')).sort(), ids(full, 'note').sort(), 'every note once');
  parts.forEach((d, i) => assert.equal(d.getElementsByTagName('sb').length, 1, 'chunk ' + i + ' starts with a system break'));
});

await check('state carried into a chunk: clef, key, labels (short names), time signature hidden', async () => {
  const b = SB.buildMEI(synthetic(), { grid: 2 });
  const doc = xml(b.chunks.mei(5, 7, { abbr: true }));
  const sd = doc.getElementsByTagName('scoreDef')[0];
  assert.equal(sd.getAttribute('keysig'), '2s', 'the key from bar 5');
  assert.equal(sd.getAttribute('meter.visible'), 'false', 'no time signature at a later system start');
  const cello = [...doc.getElementsByTagName('staffDef')].find(s => s.getAttribute('n') === '2');
  assert.equal(cello.getAttribute('clef.shape'), 'C', 'the cello is in tenor clef there');
  const label = cello.getElementsByTagName('label')[0].textContent, short = cello.getElementsByTagName('labelAbbr')[0].textContent;
  assert.equal(label, short, 'a later system shows the short name');
  const first = xml(b.chunks.mei(0, 2, { abbr: true }));
  assert.equal(first.getElementsByTagName('scoreDef')[0].getAttribute('meter.visible'), null, 'the first chunk shows the time signature');
});

await check('spanners cut at a chunk edge: ties, slurs, hairpins continue; ids stay unique', async () => {
  const b = SB.buildMEI(synthetic(), { grid: 2 });
  // v4 (beats 12-18) is tied from bar 4 into bar 5; the slur v3..v5 and the hairpin (beats 10-19) cross 4 | 5 too.
  const left = b.chunks.mei(0, 3), right = b.chunks.mei(4, 7);
  assert.match(left, /<tie staff="1" startid="#nv4" tstamp2="0m\+5"\/>/, 'the tie runs to the end of bar 4');
  assert.match(right, /<tie staff="1" tstamp="0" endid="#nv4-c1"\/>/, 'and comes in at the start of bar 5');
  assert.match(left, /<slur staff="1" startid="#nv3" tstamp2="\dm\+5"\/>/, 'slur to the chunk end');
  assert.match(right, /<slur staff="1" tstamp="0" endid="#nv5"\/>/, 'slur from the chunk start');
  assert.match(left, /<hairpin xml:id="hp1" [^>]*tstamp2="1m\+5"/, 'hairpin with its id to the chunk end');
  assert.match(right, /<hairpin form="cres" staff="1" tstamp="0" tstamp2="0m\+/, 'its continuation, without the id');
  assert.ok(!/xml:id="hp1"/.test(right), 'the id is not repeated');
  const whole = b.chunks.mei(0, 7);
  assert.ok(!/<tie /.test(whole), 'no tie elements inside one document (@tie does it)');
});

await check('hidden staves: left out of scoreDef, bars and control events; marks above the score move to the top staff', async () => {
  const sc = synthetic();
  sc.directions = [{ beat: 20, text: 'B', kind: 'reh', staff: 1 }];
  const b = SB.buildMEI(sc, { grid: 2 });
  assert.equal(SC.hidden(b.chunks, 4, 7, true), null, 'all: nothing hidden');
  const hide = SC.hidden(b.chunks, 4, 7, false);
  assert.deepEqual([...hide], [3], 'the tacet part (staff 3) has no notes in bars 5-8');
  const doc = xml(b.chunks.mei(4, 7, { hide: new Set([1, 3]) }));
  assert.deepEqual([...doc.getElementsByTagName('staffDef')].map(s => s.getAttribute('n')), ['2']);
  assert.ok([...doc.getElementsByTagName('staff')].every(s => s.getAttribute('n') === '2'), 'only staff 2 in the bars');
  assert.equal(doc.getElementsByTagName('slur').length + doc.getElementsByTagName('hairpin').length, 0, 'staff 1 events dropped');
  const reh = doc.getElementsByTagName('reh')[0], tempo = doc.getElementsByTagName('tempo')[0];
  assert.equal(reh.getAttribute('staff'), '2', 'rehearsal mark on the top staff shown');
  assert.equal(tempo.getAttribute('staff'), '2', 'tempo mark too');
  const none = SC.hidden({ parts: [[1], [2]], filled: () => false }, 0, 3, false);
  assert.deepEqual([...none], [2], 'a chunk with nothing to play keeps its first part');
});

await check('each chunk engraves as exactly one system, justified to the width', async () => {
  const b = SB.buildMEI(synthetic(), { grid: 2 });
  for (const [a, z] of [[0, 3], [4, 7]]) {
    const { svg, log } = await renderMEI(b.chunks.mei(a, z, { abbr: a > 0, system: true }), VRV);
    assert.equal(systems(svg), 1, `bars ${a + 1}-${z + 1}: one system (${log})`);
    assert.ok(!/Error/.test(log), log);
    assert.equal((svg.match(/class="tie"/g) || []).length >= 1, true, 'the cut tie is drawn');
  }
});

const crawl = JSON.parse(fs.readFileSync(ROOT + '/test/fixtures/crawl-megaman2.json', 'utf8'));
// As played (interpret: false): the sticky-breaks case below is tuned to these bar widths. Known limit: with the
// score-intent reading's narrower bars, a one-bar shift never meets the old breaks again (every later chunk re-plans).
const mm2 = SB.buildMEI(crawlToScore(crawl), { grid: 2, simplify: true, interpret: false });

await check('Mega Man 2: the plan covers every bar once, systems of sensible size, fast', async () => {
  const t = performance.now();
  const plan = SC.plan(mm2.chunks, PAGE, null, 'x');
  const meis = plan.map((c, i) => mm2.chunks.mei(c.a, c.b, { abbr: i > 0, system: true, hide: SC.hidden(mm2.chunks, c.a, c.b, false) }));
  meis.forEach(m => SC.hash(m));
  const ms = performance.now() - t;
  assert.equal(plan[0].a, 0);
  plan.forEach((c, i) => { assert.ok(c.b >= c.a); if (i) assert.equal(c.a, plan[i - 1].b + 1); });
  assert.equal(plan[plan.length - 1].b, mm2.measures - 1);
  assert.ok(plan.length >= 30 && plan.length <= 60, plan.length + ' systems (a full render has ~44 at this width)');
  assert.ok(ms < 500, 'plan + chunk MEI + hashes in ' + Math.round(ms) + ' ms');
  console.log(`      ${plan.length} chunks of ${plan.map(c => c.b - c.a + 1).join(',')} bars; plan + MEI + hash ${Math.round(ms)} ms`);
});

await check('Mega Man 2: every chunk is one system; ids unique across chunks', async () => {
  const plan = SC.plan(mm2.chunks, PAGE, null, 'x');
  const seen = new Set();
  let t = 0;
  for (let i = 0; i < plan.length; i += 5) { // every 5th chunk (engraving all takes a while)
    const c = plan[i];
    const mei = mm2.chunks.mei(c.a, c.b, { abbr: i > 0, system: true, hide: SC.hidden(mm2.chunks, c.a, c.b, false) });
    const t0 = performance.now();
    const { svg } = await renderMEI(mei, { ...VRV, minLastJustification: i === plan.length - 1 ? 0.8 : 0 });
    t += performance.now() - t0;
    assert.equal(systems(svg), 1, `chunk ${i} (bars ${c.a + 1}-${c.b + 1}) is one system`);
    for (const m of svg.matchAll(/ id="((?:m\d+(?:s\d+)?)|n[^"]+)"/g)) {
      assert.ok(!seen.has(m[1]), 'id ' + m[1] + ' only once');
      seen.add(m[1]);
    }
  }
  console.log(`      ${Math.ceil(plan.length / 5)} chunks engraved in ${Math.round(t)} ms`);
});

await check('sticky breaks: changing one bar re-plans at most the chunks around it', async () => {
  const p0 = SC.plan(mm2.chunks, PAGE, null, 'ctx');
  const bars = mm2.chunks.bars.slice();
  const k = p0[10].a + 1;
  bars[k] = { ...bars[k], onsets: bars[k].onsets + 6, gaps: bars[k].gaps + 2 }; // a much busier bar
  const p1 = SC.plan({ ...mm2.chunks, bars }, PAGE, { ctx: 'ctx', ranges: p0 }, 'ctx');
  const same = new Set(p0.map(c => c.a + ':' + c.b));
  const changed = p1.filter(c => !same.has(c.a + ':' + c.b));
  assert.ok(changed.length <= 3, 'changed chunks: ' + JSON.stringify(changed));
  const other = SC.plan({ ...mm2.chunks, bars }, PAGE, { ctx: 'other', ranges: p0 }, 'ctx2');
  assert.deepEqual(other, SC.plan({ ...mm2.chunks, bars }, PAGE, null, 'x'), 'another layout ignores the old breaks');
});

await check('hash: stable, different for different strings', () => {
  assert.equal(SC.hash('<mei/>'), SC.hash('<mei/>'));
  assert.notEqual(SC.hash('<mei a="1"/>'), SC.hash('<mei a="2"/>'));
  assert.notEqual(SC.hash(mm2.mei), SC.hash(mm2.mei.replace('pname="c"', 'pname="d"')));
});

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('chunks-test: all passed');
