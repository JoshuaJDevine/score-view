// Crawler feasibility probe (docs/research.md section C) against the LIVE extension.
// Safety: refuses to run unless the open Bitwig project's name contains "crawl" (use a Save-As copy).
// Needs Preferences > Score View > Developer mode on ("act" / "clipNext" are developer-only ops).
//
//   node test/crawl-probe.mjs            # T0, T2, T3, T6 and a mini crawl of up to 40 clips
import fs from 'fs';

const BASE = 'http://localhost:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async () => (await fetch(BASE + '/api/transport', { cache: 'no-store' })).json();
const op = async line => { await fetch(BASE + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body: line }); };
const log = [];
const say = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); log.push(s); };
const key = t => [t.clip.track, t.clip.length, t.clip.notes, t.clip.fp, t.loopStart, t.loopLength, t.playStart].join('|');

// Waits until the state has been stable for `quiet` ms (or `max` ms passed); returns state + settle time.
async function settle(before, { quiet = 80, max = 1500 } = {}) {
  const t0 = Date.now();
  let last = await get(), lastKey = key(last), stableSince = Date.now(), changedAt = null;
  while (Date.now() - t0 < max) {
    await sleep(20);
    const s = await get(), k = key(s);
    if (k !== lastKey) { lastKey = k; last = s; stableSince = Date.now(); if (changedAt == null && k !== before) changedAt = Date.now() - t0; }
    else if (Date.now() - stableSince >= quiet && (k !== before || Date.now() - t0 > 400)) break;
  }
  return { s: last, changedMs: changedAt, totalMs: Date.now() - t0 };
}
async function act(id) {
  const before = key(await get());
  await op('act ' + id);
  return settle(before);
}
const brief = s => `${s.clip.exists ? s.clip.track : '(no clip)'} len=${s.clip.length} notes=${s.clip.notes} loop=${s.loopOn ? 'on' : 'off'} ${s.loopStart}+${s.loopLength} playStart=${s.playStart} undo=${s.canUndo} [${s.lastAction}]`;

const t0 = await get();
if (!/crawl/i.test(t0.project || '')) {
  console.error(`Refusing to run: open project is "${t0.project}". Save a copy whose name contains "crawl" and open it.`);
  process.exit(2);
}
if (t0.playing) { console.error('Stop the transport first.'); process.exit(2); }
const saved = { loopOn: t0.loopOn, loopStart: t0.loopStart, loopLength: t0.loopLength, playStart: t0.playStart };
say('T0 baseline:', brief(t0));

try {
  // T2: selection actions.
  let r = await act('Select first item');
  say(`T2 Select first item (${r.changedMs ?? '-'} ms):`, brief(r.s));
  for (let i = 1; i <= 3; i++) {
    r = await act('Select next item');
    say(`T2 Select next item #${i} (${r.changedMs ?? '-'} ms):`, brief(r.s));
  }
  r = await act('Select item in next lane');
  say(`T2 Select item in next lane (${r.changedMs ?? '-'} ms):`, brief(r.s));
  {
    const before = key(await get());
    await op('clipNext');
    r = await settle(before);
    say(`T2 cursorClip.selectNext() (${r.changedMs ?? '-'} ms):`, brief(r.s));
  }

  // T3: does "Loop Selection" reveal the selected clip's position and length?
  r = await act('Select first item');
  const undoBefore = r.s.canUndo;
  r = await act('Loop Selection');
  say(`T3 Loop Selection (${r.changedMs ?? '-'} ms):`, brief(r.s), `clipLen=${r.s.clip.length}`,
      r.s.loopLength === r.s.clip.length ? 'LENGTH MATCHES' : 'length differs', `undo ${undoBefore}->${r.s.canUndo}`);

  // Mini crawl: first item, then next item / next lane, recording track + position + fingerprint.
  say('--- mini crawl ---');
  const seen = new Map();
  r = await act('Select first item');
  for (let step = 0; step < 40 && r.s.clip.exists; step++) {
    const l = await act('Loop Selection');
    const s = l.s;
    const id = `${s.clip.track}@${s.loopStart}`;
    say(`#${step} ${s.clip.track} @ beat ${s.loopStart} (bar ${s.loopStart / 4 + 1}) len ${s.loopLength} notes ${s.clip.notes} fp ${s.clip.fp.slice(0, 40)} [settle ${l.totalMs} ms]`);
    if (seen.has(id)) { say('repeat -> stop'); break; }
    seen.set(id, s.clip.fp);
    let n = await act('Select next item');
    if (key(n.s) === key(s) || `${n.s.clip.track}@${n.s.loopStart}` === id) {
      n = await act('Select item in next lane');
      if (!n.s.clip.exists || n.s.clip.track === s.clip.track) { say('no next lane -> stop'); break; }
    }
    r = n;
  }
  say(`crawled ${seen.size} clips`);
} finally {
  // Restore loop and play start exactly.
  await op(`loop ${saved.loopStart} ${saved.loopLength}`);
  if (!saved.loopOn) await op('loopOff');
  await sleep(300);
  const end = await get();
  say('restored:', brief(end), end.loopStart === saved.loopStart && end.loopLength === saved.loopLength && end.loopOn === saved.loopOn ? 'LOOP OK' : 'LOOP DIFFERS');
  fs.writeFileSync('test/out-crawl-probe.log', log.join('\n'));
}
