// Mock of the Bitwig extension's HTTP API, for testing the web UI without Bitwig.
// Serves web/ (with vendor files from node_modules) and a fake clip that /api/edit really edits.
//
//   node test/mock-server.mjs [--port 8800] [--fixture test/fixtures/live-violin1.json]
//
// Programmatic use (e.g. from a puppeteer test):
//   import { startMockServer } from './mock-server.mjs';
//   const srv = await startMockServer({ port: 8800 });  // srv.url, srv.state, srv.edits, srv.refusedOps, srv.close()
// Render dynamics: curve ops, /api/curve and /api/marks come from test/mock-curve.mjs (option curve: {devices, missing, speed, marks}).
// Timing (LiveSync.java): /api/notes carries settled / changedMs / selPlayStart and one more version is published once
// nothing changed for settle.quietMs (settle.switchQuietMs after a clip switch); settle: false = an extension without
// those fields. srv.switchClip(target, {noteMs, trackMs, playStartMs}) delivers a clip switch the way Bitwig does: the
// old notes go and the new ones arrive one by one, the track name and the play start marker follow later.
// Stored arrangement reads (GET/POST /api/arrangement, ArrangementMirror.java): srv.mirror (project -> JSON text); option
// mirror: false answers 404 like an extension without the endpoint; option project names the open project ('Mock').
// Listen while playing (GET /api/listen, NoteListen.java): the mock plays its arrangement while the transport runs
// (srv.listen: transform per track = a Note FX, lag, auto, requests; srv.pushListen(index, events)).
// Edit ops follow MOCK_OPS (= src/claude/scoreview/EditOps.java, checked by test/protocol-test.mjs).
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createMockWizard } from './mock-wizard.mjs';
import { createMockCurve } from './mock-curve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const VENDOR = {
  'vendor/verovio-toolkit-wasm.js': path.join(ROOT, 'node_modules/verovio/dist/verovio-toolkit-wasm.js'),
  'vendor/fflate.js': path.join(ROOT, 'node_modules/fflate/umd/index.js'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

// Default arranger cue markers (beats). Pass markers: [] for none.
// Same request rules as the extension (src/claude/scoreview/HttpGuard.java), so a page fetch that forgets the
// X-ScoreView header fails here too: Host must be 127.0.0.1/localhost/[::1] on our port; anything but GET/HEAD needs
// "X-ScoreView: 1" and, when an Origin is sent, our own origin; state-changing endpoints (postOnly) are POST only.
export function guardRequest({ method = 'GET', host, origin, marker, fetchSite, fetchMode }, port, postOnly) {
  const h = String(host || '').trim().toLowerCase();
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h)) return { status: 403, message: 'Forbidden: bad Host header' };
  const m = String(method).toUpperCase();
  if (m === 'OPTIONS') return { status: 403, message: 'Forbidden: no CORS' };
  if (postOnly && m !== 'POST') return { status: 405, message: 'Method not allowed: use POST' };
  if (origin != null && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(String(origin).trim().toLowerCase()))
    return { status: 403, message: 'Forbidden: foreign Origin' };
  if (String(fetchSite || '').trim().toLowerCase() === 'cross-site' && String(fetchMode || '').trim().toLowerCase() !== 'navigate')
    return { status: 403, message: 'Forbidden: cross-site request' };
  if (m === 'GET' || m === 'HEAD') return null;
  if (String(marker || '').trim() !== '1') return { status: 403, message: 'Forbidden: missing X-ScoreView header' };
  return null;
}
// Java's HttpServer routes a context by path prefix (/api/edit, /api/edit/x and /api/editX all reach the edit handler),
// so the mock treats every such path as POST only too.
const POST_ONLY = ['/api/edit'];
const isPostOnly = p => POST_ONLY.some(prefix => p.startsWith(prefix));

// The POST /api/edit ops the mock understands: { name: [minArgs, maxArgs (Infinity = rest of the line), handler, dev] }.
// Must match the extension's op table src/claude/scoreview/EditOps.java (test/protocol-test.mjs compares both through
// test/fixtures/ops.txt). Ops with too few arguments are refused (srv.refusedOps), except those whose handler checks
// its own arguments (navigator, http) — like EditOps.problem(). Developer-mode ops are refused unless the
// developerMode option is set (the mock only records them anyway).
export const MOCK_OPS = {
  move: [5, 5, 'extension'], del: [3, 3, 'extension'], add: [5, 5, 'extension'], dur: [4, 4, 'extension'],
  vel: [4, 4, 'extension'], select: [4, 4, 'extension'], audition: [1, 1, 'extension'], undo: [0, 0, 'extension'],
  redo: [0, 0, 'extension'], source: [1, 1, 'extension'],
  play: [0, 0, 'extension'], stop: [0, 0, 'extension'], toggle: [0, 0, 'extension'], playFrom: [1, 1, 'extension'],
  position: [1, 1, 'extension'], loop: [2, 2, 'extension'], loopOff: [0, 0, 'extension'], solo: [2, 2, 'extension'],
  mute: [2, 2, 'extension'], deviceOn: [2, 2, 'extension'], metronome: [1, 1, 'extension'],
  crawl: [0, Infinity, 'crawler'], crawlCancel: [0, 0, 'crawler'],
  goto: [3, Infinity, 'navigator'], gotoStay: [3, Infinity, 'navigator'], gotoHome: [0, 1, 'navigator'], navCancel: [0, 0, 'http'],
  wizardCancel: [0, 0, 'wizard'],
  curveClear: [0, 0, 'curve'], curveSet: [5, 5, 'curve'], curvePreview: [2, 2, 'curve'], curveRender: [2, 2, 'curve'], curveStop: [0, 0, 'curve'],
  act: [1, Infinity, 'extension', true], clipNext: [0, 0, 'extension', true], clipPrev: [0, 0, 'extension', true],
  clipStepProbe: [0, 1, 'extension', true],
  selectTrack: [1, 1, 'extension', true], moveTrackAfter: [2, 2, 'extension', true], moveTrackBefore: [2, 2, 'extension', true],
};
// Why an op line must not be applied (unknown, too few arguments), or null. Mirrors EditOps.problem().
export function opProblem(words) {
  const o = Object.hasOwn(MOCK_OPS, words[0]) ? MOCK_OPS[words[0]] : null;
  if (!o) return 'unknown op ' + words[0];
  const [min, , handler] = o;
  if (handler !== 'navigator' && handler !== 'http' && words.length - 1 < min) return `${words[0]} needs ${min} argument${min === 1 ? '' : 's'}`;
  return null;
}

const DEFAULT_MARKERS = [{ name: 'Intro', beat: 0 }, { name: 'A', beat: 32 }, { name: 'B', beat: 64 }];

export async function startMockServer({ port = 8800, fixture = path.join(ROOT, 'test/fixtures/live-violin1.json'), quiet = true,
                                        markers = DEFAULT_MARKERS, clipOffset = 0, arrangement = null, wizard: wizardOpts = {},
                                        developerMode = false, curve: curveOpts = {}, devices = [], project = 'Mock',
                                        mirror: mirrorOn = true, settle = { quietMs: 100, switchQuietMs: 200 } } = {}) {
  const base = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const tracksFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/live-bass.json'), 'utf8')).tracks;
  const state = {
    v: 1,
    data: { source: 'arranger', exists: true, length: 16, num: 4, den: 4, ...base,
            tracks: (base.tracks || tracksFixture).map((t, index) => ({ index, solo: false, mute: false, ...t, sel: t.name === base.track })),
            markers: base.markers || markers.map(m => ({ ...m })),
            // the selected track's devices (option devices: [names]; srv.setData({devices}) to change them)
            devices: { track: base.track || 'Violin 1', list: devices.map((name, index) => ({ index, name, on: true })) } },
    play: { playing: false, step: -1, pos: 0, tempo: 120, loop: { on: false, start: 0, length: 16 }, metronome: false },
    // Transport simulation: started by the play/stop/toggle/playFrom/position ops, the playhead advances at
    // tempo from anchor.pos (anchor.t = wall-clock ms). setPlay() switches it off so tests can pin exact values.
    sim: false, anchor: { pos: 0, t: 0 },
    clipOffset,  // arranger beat where the mock clip starts (drives the clip "step" while playing)
    project,     // the open project (/api/transport, /api/arrangement); srv.setProject() also puts it into /api/notes
  };
  // Stored arrangement reads per project (ArrangementMirror.java): a finished full crawl is stored by the "extension",
  // the page posts its mirror after harvesting clips or re-reading tracks.
  const mirror = new Map();
  const mirrorPosts = [];
  const edits = [];      // every op line received, in order
  const waiters = [];
  // MIDI bridge (/api/midi): ring of note events, as the extension forwards them from the selected track.
  const midi = { seq: 0, events: [], waiters: [] };
  function pushMidi(events) {
    [].concat(events).forEach(e => {
      midi.events.push({ seq: ++midi.seq, t: e.t != null ? e.t : Date.now(), type: e.type, key: e.key,
                         vel: e.type === 'off' ? 0 : (e.vel == null ? 100 : e.vel),
                         playing: e.playing != null ? !!e.playing : !!playSnapshot().playing });
    });
    if (midi.events.length > 256) midi.events.splice(0, midi.events.length - 256);
    midi.waiters.splice(0).forEach(fn => fn());
  }
  // A change wakes the long poll at once (unsettled); the settled version follows after the quiet window. switchLike:
  // the change belongs to a clip switch (the longer window, like LiveSync.SWITCH_QUIET_MS).
  const sync = { settled: true, changedAt: Date.now(), switchLike: false, timer: null, settledVersions: 0 };
  const wake = () => { state.v++; waiters.splice(0).forEach(fn => fn()); };
  const bump = (switchLike = false) => {
    sync.changedAt = Date.now();
    if (settle) {
      sync.settled = false;
      if (switchLike) sync.switchLike = true;
      clearTimeout(sync.timer);
      sync.timer = setTimeout(() => { sync.settled = true; sync.switchLike = false; sync.settledVersions++; wake(); },
        sync.switchLike ? settle.switchQuietMs : settle.quietMs);
    }
    wake();
  };
  // Whether a change (srv.setData / setNotes) looks like a clip switch to LiveSync: another track or play range, or
  // notes both removed and added beyond a single move (LiveSync.SWITCH_NOTES).
  const looksLikeSwitch = d => {
    const cur = state.data;
    if (['track', 'exists', 'length', 'playStart', 'loop', 'loopStart', 'loopLength'].some(k => k in d && d[k] !== cur[k])) return true;
    if (!d.notes) return false;
    const k = n => n.ch + '_' + n.x + '_' + n.y, before = new Set(cur.notes.map(k)), after = new Set(d.notes.map(k));
    const added = [...after].filter(x => !before.has(x)).length, removed = [...before].filter(x => !after.has(x)).length;
    return added > 0 && removed > 0 && added + removed > 3;
  };
  // The play start marker (Bitwig moves it to a selected arranger clip); srv.switchClip holds the old value a moment.
  const playStartNow = () => sync.heldPlayStart != null ? sync.heldPlayStart
    : arr ? (nav.playStart ?? arr.clips[nav.cur].start) : state.clipOffset;
  const timing = () => settle ? { settled: sync.settled, changedMs: Date.now() - sync.changedAt,
                                  selPlayStart: state.data.source === 'arranger' ? playStartNow() : null } : {};
  // Listen while playing (/api/listen, NoteListen.java): notes played per track, stamped with the arranger beat. With an
  // arrangement the mock plays its clips: each /api/listen while the transport runs adds the onsets the playhead passed
  // since the previous call. srv.arrangement is Bitwig's truth (change its notes to simulate edits the page has not
  // seen). srv.listen.transform[track] = ev => ev | [ev, ...] | null simulates a Note FX; srv.listen.lag = beats added
  // to every stamp; srv.listen.auto = false stops the playing; srv.pushListen(index, [{on, key, vel, beat}]) adds events.
  const listen = { seq: 0, events: new Map(), transform: {}, lag: 0, auto: true, last: null, requests: 0 };
  function pushListen(index, evs) {
    const ring = listen.events.get(index) || [];
    [].concat(evs).forEach(e => ring.push([++listen.seq, e.on === false ? 0 : 1, e.key, e.vel == null ? 100 : e.vel,
      e.beat, e.t != null ? e.t : Date.now(), e.playing === false ? 0 : 1]));
    if (ring.length > 512) ring.splice(0, ring.length - 512);
    listen.events.set(index, ring);
  }
  function playArrangement(snap) {
    const was = listen.last;
    listen.last = snap.playing ? snap.pos : null;
    if (!arr || !listen.auto || was == null || !snap.playing) return;
    const l = state.play.loop;
    const spans = snap.pos >= was ? [[was, snap.pos]] : l.on && l.length > 0 ? [[was, l.start + l.length], [l.start, snap.pos]] : [];
    arr.clips.forEach(c => {
      const t = state.data.tracks.find(x => x.name === c.track);
      if (!t) return;
      c.notes.forEach(n => {
        const at = n.x / 24;
        if (at < (c.playStart || 0) - 1e-9 || at >= c.playStop - 1e-9) return;
        const beat = c.start + at - (c.playStart || 0);
        if (!spans.some(([a, b]) => beat >= a - 1e-9 && beat < b - 1e-9)) return;
        let evs = [{ key: n.y, vel: n.vel == null ? 100 : n.vel, beat: beat + listen.lag }];
        const fx = listen.transform[c.track];
        if (fx) evs = [].concat(fx(evs[0]) || []);
        pushListen(t.index, evs);
      });
    });
  }
  // New Score wizard job (/api/wizard): see test/mock-wizard.mjs. Options: { stepMs, groupAction }.
  const wizard = createMockWizard({ data: state.data, play: state.play, bump, ...wizardOpts });
  // Render dynamics (CurvePlayer.java) and the dynamics marks (/api/marks): see test/mock-curve.mjs. srv.curve = its state.
  const curve = createMockCurve(curveOpts, { playing: () => !!playSnapshot().playing, transport: (on, pos) => transport(on, pos), tracks: () => state.data.tracks });
  const key = n => n.ch + '_' + n.x + '_' + n.y;
  const find = (ch, x, y) => state.data.notes.findIndex(n => n.ch === ch && n.x === x && n.y === y);

  const now = () => Date.now();
  function simPos() {
    const p = state.play;
    if (!state.sim || !p.playing) return p.pos;
    let pos = state.anchor.pos + (now() - state.anchor.t) / 1000 * p.tempo / 60;
    const l = p.loop;
    if (l.on && l.length > 0 && state.anchor.pos < l.start + l.length && pos >= l.start + l.length) {
      pos = l.start + ((pos - l.start) % l.length);
    }
    return pos;
  }
  function playSnapshot() {
    const p = state.play;
    if (!state.sim) return p;
    const pos = simPos();
    const rel = pos - state.clipOffset, len = state.data.length;
    const step = p.playing && rel >= 0 && rel < len ? Math.floor(rel * (state.data.stepsPerBeat || 24)) : -1;
    return { ...p, pos, step };
  }
  function transport(playing, pos) {
    const cur = simPos();
    state.sim = true;
    state.play.playing = playing;
    state.play.pos = pos == null ? cur : pos;
    state.anchor = { pos: state.play.pos, t: now() };
  }
  const trackAt = i => state.data.tracks.find(t => t.index === i);

  // ---- arrangement (optional): several clips on lanes, one of them selected (= state.data). The crawl op
  // returns them all (/api/crawl); goto/gotoStay/gotoHome select another clip like ClipNavigator.java (/api/nav), so
  // add ops after a goto land in that clip. arrangement = { tracks:[{name, group}], home: index,
  //   clips:[{lane, track, start, playStart, playStop, loop, loopStart, loopLength, notes:[{ch, x, y, d, vel}]}] }
  const arr = arrangement;
  // gotoStay (ClipNavigator.java): the session ends on the target. stayPlayStartAtTarget mirrors the preference
  // "Play start after pasting into another clip" (false = leave it where it was, the default).
  const nav = { state: 'idle', message: '', session: false, batches: 0, dropped: 0, results: [], lastTarget: null, home: null,
                stayed: null, stayPlayStartAtTarget: false,
                skipping: false, aborting: false, cancel: false, cur: arr ? arr.home || 0 : -1, homeIndex: -1, playStart: null };
  let crawlState = { state: 'idle', message: '' };
  let crawlFail = null; // failCrawl(): the next read stops with this { message, fix } (ArrangementCrawler.fail)
  function selectClip(i) {
    const c = arr.clips[i];
    nav.cur = i;
    nav.playStart = null; // Bitwig moves the play start marker to the selected clip
    c.notes.forEach(n => { if (n.sel == null) n.sel = false; });
    Object.assign(state.data, { track: c.track, notes: c.notes, length: c.playStop, playStart: c.playStart, loop: !!c.loop,
                                loopStart: c.loopStart || 0, loopLength: c.loopLength || c.playStop, exists: true });
    state.data.tracks.forEach(t => { t.sel = t.name === c.track; });
  }
  if (arr) {
    state.data.tracks = arr.tracks.map((t, index) => ({ index, solo: false, mute: false, sel: false, ...t }));
    selectClip(nav.cur);
  }
  const navStatus = () => ({ state: nav.state, message: nav.message, session: nav.session, batches: nav.batches, dropped: nav.dropped,
    lastTarget: nav.lastTarget, home: nav.home, stayed: nav.stayed, results: nav.results });
  // Mirrors ClipNavigator.accept(): false = drop the op (after a failed goto, or after a cancel).
  function navAccept(cmd) {
    if (nav.cancel && nav.session && !nav.aborting) { nav.aborting = true; nav.results.push('cancelled'); nav.message = 'Cancelled'; }
    nav.cancel = false;
    if (nav.aborting) {
      if (cmd === 'gotoStay') { nav.dropped++; if (!nav.session) nav.batches++; return false; } // ends a refused batch too
      if (cmd !== 'gotoHome') { nav.dropped++; return false; }
      nav.aborting = false;
      if (!nav.session) nav.batches++;
      return nav.session;
    }
    if (nav.skipping) {
      if (cmd !== 'goto' && cmd !== 'gotoStay' && cmd !== 'gotoHome') { nav.dropped++; return false; }
      nav.skipping = false;
    }
    return true;
  }
  // Mirrors ClipNavigator.queueEmpty(): at the end of a POST outside a session nothing is pending any more.
  function navQueueEmpty() { if (!nav.session) { nav.aborting = false; nav.skipping = false; } }
  function navGoto(a, stay = false) {
    if (!arr) return;
    const lane = Number(a[0]), start = Number(a[1]), track = decodeURIComponent(a.slice(2).join(' '));
    const kind = stay ? 'stay' : 'goto';
    if (!nav.session) {
      nav.results = [];
      nav.stayed = null;
      const why = a.length < 3 || !Number.isFinite(lane) || !Number.isFinite(start) ? `${stay ? 'gotoStay' : 'goto'} needs: lane startBeats trackName`
        : playSnapshot().playing ? 'Stop playback first.' : state.data.source !== 'arranger' ? 'Switch Score View to the Arranger source first.' : null;
      if (why) {
        nav.state = 'error'; nav.message = why; nav.results.push('error: ' + why); nav.aborting = true; nav.dropped = 0;
        if (stay) nav.batches++;
        return;
      }
      Object.assign(nav, { session: true, dropped: 0, homeIndex: nav.cur, home: { track: arr.clips[nav.cur].track, start: arr.clips[nav.cur].start } });
    }
    nav.lastTarget = { lane, start, track, home: false, stay };
    const i = arr.clips.findIndex(c => c.track === track && Math.abs(c.start - start) < 1e-4);
    if (i < 0) {
      const why = `No clip on ${track} starting at beat ${start} (was it moved or deleted? read the arrangement again)`;
      nav.state = 'error'; nav.message = why; nav.results.push(`error: ${kind} ${track} @ ${start}: ${why}`); nav.skipping = true;
      if (stay) { navHome(); nav.skipping = true; } // a failed gotoStay goes home; its edits are dropped
      return;
    }
    selectClip(i);
    nav.state = 'done'; nav.message = `${stay ? 'Stayed at' : 'At'} ${track} @ ${start}`; nav.results.push(`ok: ${kind} ${track} @ ${start}`);
    if (stay) {
      nav.stayed = { track, start };
      endSession(true);
    }
  }
  function endSession(stayedThere) {
    // play start: back where it was before the session (the home clip's start), unless the preference keeps it on the clip
    if (!stayedThere || !nav.stayPlayStartAtTarget) nav.playStart = arr.clips[nav.homeIndex].start;
    nav.session = false; nav.batches++;
    const bad = nav.results.filter(r => !r.startsWith('ok'));
    if (bad.length) { nav.state = 'error'; nav.message = 'Finished with errors: ' + bad.join('; '); }
  }
  function navHome() {
    nav.aborting = false; nav.skipping = false;
    if (!nav.session) { nav.batches++; return; }
    selectClip(nav.homeIndex);
    const c = arr.clips[nav.homeIndex];
    nav.lastTarget = { lane: c.lane, start: c.start, track: c.track, home: true, stay: false };
    nav.results.push(`ok: home ${c.track} @ ${c.start}`);
    nav.state = 'done'; nav.message = `Back at ${c.track} @ ${c.start}`;
    endSession(false);
  }
  // only = track names (op 'crawl tracks ...'): a targeted read of those tracks, like ArrangementCrawler.java.
  function crawlResult(only = null) {
    const clips = arr.clips.filter(c => !only || only.includes(c.track));
    const found = only ? only.filter(n => clips.some(c => c.track === n)) : null;
    return { state: 'done', message: only ? `Read ${clips.length} clips on ${found.length} of ${only.length} tracks` : `Read ${clips.length} clips on ${arr.tracks.length} lanes`,
      lane: arr.tracks.length, lanes: arr.tracks.length, clips: clips.length, stepsPerBeat: 24,
      ...(only ? { subset: only, found, complete: true } : {}),
      tracks: arr.tracks.map(t => ({ name: t.name, group: !!t.group })),
      result: clips.map(c => ({ lane: c.lane, track: c.track, start: c.start, playStart: c.playStart, playStop: c.playStop, loop: !!c.loop,
        loopStart: c.loopStart || 0, loopLength: c.loopLength || c.playStop, notes: c.notes.map(n => [n.ch, n.x, n.y, n.d, n.vel]) })) };
  }
  function crawl(words) {
    if (!arr) return;
    // 'crawl [exact] [safe|fast] [tracks <names>]': the flags before 'tracks' only change the extension's timing
    const flags = [];
    let a = words;
    while (a.length && a[0] !== 'tracks') { flags.push(a[0]); a = a.slice(1); }
    if (crawlFail) { crawlState = { state: 'error', ...crawlFail }; crawlFail = null; return; }
    const timing = { timing: flags.includes('fast') ? 'fast' : 'safe', skipLanes: flags.includes('fast'), skipped: 0, laneOrder: 'unknown', rewalked: false };
    if (a[0] === 'tracks') { if (a.length > 1) crawlState = { ...crawlResult(a.slice(1).map(decodeURIComponent)), ...timing }; return; }
    crawlState = { ...crawlResult(), ...timing };
    if (!mirrorOn) return;
    const t = Date.now();
    mirror.set(state.project, JSON.stringify({ v: 1, project: state.project, readAt: t, savedAt: t, by: 'extension',
      tracksAtRead: state.data.tracks.map(x => ({ name: x.name })), crawl: crawlState }));
  }

  function apply(op) {
    const [cmd, ...a] = op.trim().split(/\s+/);
    const n = a.map(Number);
    const notes = state.data.notes;
    switch (cmd) {
      case 'move': { const i = find(n[0], n[1], n[2]); if (i >= 0) { notes[i].x += n[3]; notes[i].y += n[4]; } break; }
      case 'del': { const i = find(n[0], n[1], n[2]); if (i >= 0) notes.splice(i, 1); break; }
      case 'dur': { const i = find(n[0], n[1], n[2]); if (i >= 0) notes[i].d = n[3]; break; }
      case 'vel': { const i = find(n[0], n[1], n[2]); if (i >= 0) notes[i].vel = Math.round(n[3] * 127); break; }
      case 'add': { const i = find(n[0], n[1], n[2]); const note = { ch: n[0], x: n[1], y: n[2], vel: n[3], d: n[4], sel: false };
                    if (i >= 0) notes[i] = note; else notes.push(note); break; }
      case 'source': state.data.source = a[0]; break;
      case 'goto': navGoto(a); break;
      case 'gotoStay': navGoto(a, true); break;
      case 'gotoHome': navHome(); break;
      case 'crawl': crawl(a); break;
      case 'play': if (!state.play.playing) transport(true); break;
      case 'stop': transport(false); break;
      case 'toggle': transport(!state.play.playing); break;
      case 'playFrom': transport(true, n[0]); break;
      case 'position': transport(state.play.playing, n[0]); break;
      case 'loop': { const pos = simPos(); state.play.loop = { on: true, start: n[0], length: n[1] }; state.anchor = { pos, t: now() }; break; }
      case 'loopOff': state.play.loop = { ...state.play.loop, on: false }; break;
      case 'metronome': state.play.metronome = a[0] === '1'; break;
      case 'curveClear': case 'curveSet': case 'curvePreview': case 'curveRender': case 'curveStop': curve.apply(cmd, a); break;
      case 'solo': case 'mute': { const t = trackAt(n[0]); if (t) t[cmd] = a[1] === '1'; break; }
      case 'deviceOn': { const dv = (state.data.devices.list || []).find(x => x.index === n[0]); if (dv) dv.on = a[1] === '1'; break; }
      default: break; // select, audition, undo, redo, ... are only recorded
    }
    notes.sort((p, q) => p.x - q.x || p.y - q.y);
  }

  const rejected = []; // requests the guard refused: { method, path, status, message }
  const refusedOps = []; // op lines the extension would refuse (EditOps.problem / Developer mode): { op, why }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const verdict = guardRequest({ method: req.method, host: req.headers.host, origin: req.headers.origin, marker: req.headers['x-scoreview'],
                                   fetchSite: req.headers['sec-fetch-site'], fetchMode: req.headers['sec-fetch-mode'] },
      server.address().port, isPostOnly(url.pathname));
    if (verdict) {
      rejected.push({ method: req.method, path: url.pathname, ...verdict });
      req.resume();
      const head = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
      if (verdict.status === 405) head.Allow = 'POST';
      res.writeHead(verdict.status, head);
      return res.end(verdict.message);
    }
    const json = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/api/notes') {
      const since = Number(url.searchParams.get('v'));
      const reply = () => json({ v: state.v, stepsPerBeat: 24, ...state.data, ...timing(), v: state.v });
      if (since !== state.v) return reply();
      const t = setTimeout(() => { const i = waiters.indexOf(reply2); if (i >= 0) waiters.splice(i, 1); reply(); }, 5000);
      const reply2 = () => { clearTimeout(t); reply(); };
      waiters.push(reply2);
      return;
    }
    if (url.pathname === '/api/midi') {
      let since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : -1;
      if (!Number.isFinite(since) || since > midi.seq) since = -1;
      const reply = () => json({ seq: midi.seq, track: state.data.track, monitoring: true, playing: !!playSnapshot().playing,
                                 events: since < 0 ? [] : midi.events.filter(e => e.seq > since) });
      if (since < 0 || midi.seq > since) return reply();
      const t = setTimeout(() => { const i = midi.waiters.indexOf(reply2); if (i >= 0) midi.waiters.splice(i, 1); reply(); }, 5000);
      const reply2 = () => { clearTimeout(t); reply(); };
      midi.waiters.push(reply2);
      return;
    }
    if (url.pathname === '/api/listen') {
      let since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : -1;
      const snap = playSnapshot();
      playArrangement(snap);
      listen.requests++;
      if (!Number.isFinite(since) || since > listen.seq) since = -1;
      const tracks = since < 0 ? [] : [...listen.events.entries()].sort((a, b) => a[0] - b[0])
        .map(([index, ring]) => ({ index, name: (trackAt(index) || {}).name || null, events: ring.filter(e => e[0] > since) }))
        .filter(t => t.events.length);
      return json({ seq: listen.seq, playing: !!snap.playing, pos: snap.pos, tracks });
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/api/play') return json(playSnapshot());
    if (url.pathname === '/api/nav') return json(navStatus());
    if (url.pathname === '/api/crawl') return json(crawlState);
    if (url.pathname === '/api/arrangement') {
      if (!mirrorOn) { res.writeHead(404); return res.end('not found'); }
      if (req.method !== 'POST') return json({ project: state.project, cache: null, doc: mirror.has(state.project) ? JSON.parse(mirror.get(state.project)) : null });
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const want = url.searchParams.get('project');
        const text = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); };
        if (want !== state.project) return text(409, 'the open project is ' + state.project);
        if (!/^\s*\{[\s\S]*\}\s*$/.test(body)) return text(400, 'the document must be a JSON object');
        mirror.set(state.project, body.trim());
        mirrorPosts.push({ project: want, t: Date.now(), length: body.length });
        text(200, 'ok');
      });
      return;
    }
    if (url.pathname === '/api/meter') return json({ t: Date.now(), tracks: (state.data.tracks || []).map((t, i) => ({ index: t.index ?? i, name: t.name, peak: 0 })) });
    if (url.pathname === '/api/transport') {
      // Bitwig moves the play start marker to the selected clip
      return json({ project: state.project, playing: !!playSnapshot().playing, playStart: playStartNow(), pos: playSnapshot().pos });
    }
    if (url.pathname === '/api/actions') return json([]);
    if (url.pathname === '/api/wizard') return wizard.handle(req, res, url, json);
    if (url.pathname === '/api/curve') return json(curve.status());
    if (url.pathname === '/api/marks') return curve.handleMarks(req, res);
    if (url.pathname === '/api/edit') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const lines = body.split('\n').filter(l => l.trim());
        lines.forEach(l => {
          edits.push(l.trim());
          if (l.trim() === 'navCancel') { nav.cancel = true; return; }
          const words = l.trim().split(/\s+/);
          if (!navAccept(words[0])) return;
          // like ScoreViewExtension.applyEdit: unknown / short ops and (without Developer mode) debug ops are refused
          const why = opProblem(words) || (MOCK_OPS[words[0]][3] && !developerMode ? 'needs Developer mode' : null);
          if (why) { refusedOps.push({ op: l.trim(), why }); return; }
          apply(l);
        });
        navQueueEmpty();
        // like the extension: the page is not woken mid-session; another clip selected = the longer settle window
        if (!nav.session) bump(lines.some(l => /^(goto|gotoStay|gotoHome|source)\b/.test(l.trim())));
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = VENDOR[rel] || path.join(WEB, rel);
    if (!file.startsWith(WEB) && !Object.values(VENDOR).includes(file)) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  port = server.address().port; // port 0 = any free port
  if (!quiet) console.log('mock Score View server on http://localhost:' + port);
  return {
    url: 'http://localhost:' + port, port, rejected, refusedOps, state, edits, midi, nav, arrangement: arr, wizard: wizard.w, // wizard: { plans, swaps, state, ... }
    mirror, mirrorPosts, // stored arrangement reads: project -> JSON text; the page's POSTs
    listen, pushListen,  // listen while playing (/api/listen): { transform, lag, auto, requests }, pushListen(index, events)
    // The user clicks arranger clip i (arrangement option): it becomes the selected clip, the play start moves to it.
    selectClip(i) { selectClip(i); bump(); },
    // The next read fails like ArrangementCrawler.fail: fix 'clickClip' (Bitwig's focus is not on the timeline) or 'stop'.
    failCrawl(message, fix = '') { crawlFail = { message, fix }; },
    setProject(name) { state.project = name; state.data.project = name; bump(); },
    curve: curve.c, // Render dynamics: { state, runs, written, curves, devices, missing, speed, marks (JSON text), marksPosts }
    // MIDI bridge: pushMidi([{ type: 'on'|'off', key, vel?, t? (ms), playing? (defaults to the transport) }])
    pushMidi,
    setNotes(notes) { const sw = looksLikeSwitch({ notes }); state.data.notes = notes; bump(sw); },
    setPlay(p) { state.sim = false; Object.assign(state.play, p); },
    setMarkers(m) { state.data.markers = m; bump(); },
    setData(d) { const sw = looksLikeSwitch(d); Object.assign(state.data, d); bump(sw); },
    sync, // { settled, changedAt, switchLike, settledVersions }
    /**
     * Selects another clip the way Bitwig reports it: each old note removed and each new note added in its own version
     * (noteMs apart), the track name (and track selection) trackMs after the last note, the play start marker
     * playStartMs after that. target = an arrangement clip index, or { track, notes, length?, playStart?, selPlayStart? }.
     * Resolves with { lastChangeAt } once everything has arrived.
     */
    async switchClip(target, { noteMs = 5, trackMs = 60, playStartMs = 60 } = {}) {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const c = typeof target === 'number' ? arr.clips[target] : target;
      const oldPlayStart = playStartNow();
      sync.heldPlayStart = oldPlayStart;
      const notes = state.data.notes = state.data.notes.slice(); // (an arrangement clip keeps its own array)
      while (notes.length) { notes.pop(); bump(true); await sleep(noteMs); }
      for (const n of c.notes) { notes.push({ sel: false, vel: 100, ...n }); notes.sort((p, q) => p.x - q.x || p.y - q.y); bump(true); await sleep(noteMs); }
      const len = c.playStop ?? c.length ?? state.data.length;
      Object.assign(state.data, { length: len, playStart: c.playStart || 0, loop: !!c.loop, loopStart: c.loopStart || 0, loopLength: c.loopLength || len, exists: true });
      bump(true);
      await sleep(trackMs);
      if (typeof target === 'number') { nav.cur = target; nav.playStart = null; c.notes = notes; }
      state.data.track = c.track;
      state.data.tracks.forEach(t => { t.sel = t.name === c.track; });
      bump(true);
      await sleep(playStartMs);
      sync.heldPlayStart = null;
      if (typeof target !== 'number' && c.selPlayStart != null) state.clipOffset = c.selPlayStart;
      bump(true);
      return { lastChangeAt: sync.changedAt };
    },
    close: () => new Promise(r => { clearTimeout(sync.timer); wizard.close(); curve.close(); waiters.splice(0).forEach(fn => fn()); midi.waiters.splice(0).forEach(fn => fn()); server.close(r); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  startMockServer({ port: Number(arg('--port') || 8800), fixture: arg('--fixture') || undefined, quiet: false });
}
