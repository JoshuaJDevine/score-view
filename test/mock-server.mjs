// Mock of the Bitwig extension's HTTP API, for testing the web UI without Bitwig.
// Serves web/ (with vendor files from node_modules) and a fake clip that /api/edit really edits.
//
//   node test/mock-server.mjs [--port 8800] [--fixture test/fixtures/live-violin1.json]
//
// Programmatic use (e.g. from a puppeteer test):
//   import { startMockServer } from './mock-server.mjs';
//   const srv = await startMockServer({ port: 8800 });  // srv.url, srv.state, srv.edits, srv.refusedOps, srv.close()
// Render dynamics: curve ops, /api/curve and /api/marks come from test/mock-curve.mjs (option curve: {devices, missing, speed, marks}).
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
  mute: [2, 2, 'extension'], metronome: [1, 1, 'extension'],
  crawl: [0, 1, 'crawler'], crawlCancel: [0, 0, 'crawler'],
  goto: [3, Infinity, 'navigator'], gotoStay: [3, Infinity, 'navigator'], gotoHome: [0, 1, 'navigator'], navCancel: [0, 0, 'http'],
  wizardCancel: [0, 0, 'wizard'],
  curveClear: [0, 0, 'curve'], curveSet: [5, 5, 'curve'], curvePreview: [2, 2, 'curve'], curveRender: [2, 2, 'curve'], curveStop: [0, 0, 'curve'],
  act: [1, Infinity, 'extension', true], clipNext: [0, 0, 'extension', true], clipPrev: [0, 0, 'extension', true],
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
                                        developerMode = false, curve: curveOpts = {} } = {}) {
  const base = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const tracksFixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/live-bass.json'), 'utf8')).tracks;
  const state = {
    v: 1,
    data: { source: 'arranger', exists: true, length: 16, num: 4, den: 4, ...base,
            tracks: (base.tracks || tracksFixture).map((t, index) => ({ index, solo: false, mute: false, ...t, sel: t.name === base.track })),
            markers: base.markers || markers.map(m => ({ ...m })) },
    play: { playing: false, step: -1, pos: 0, tempo: 120, loop: { on: false, start: 0, length: 16 }, metronome: false },
    // Transport simulation: started by the play/stop/toggle/playFrom/position ops, the playhead advances at
    // tempo from anchor.pos (anchor.t = wall-clock ms). setPlay() switches it off so tests can pin exact values.
    sim: false, anchor: { pos: 0, t: 0 },
    clipOffset,  // arranger beat where the mock clip starts (drives the clip "step" while playing)
  };
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
  const bump = () => { state.v++; waiters.splice(0).forEach(fn => fn()); };
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
  function crawlResult() {
    return { state: 'done', message: `Read ${arr.clips.length} clips on ${arr.tracks.length} lanes`, lane: arr.tracks.length, lanes: arr.tracks.length,
      clips: arr.clips.length, stepsPerBeat: 24, tracks: arr.tracks.map(t => ({ name: t.name, group: !!t.group })),
      result: arr.clips.map(c => ({ lane: c.lane, track: c.track, start: c.start, playStart: c.playStart, playStop: c.playStop, loop: !!c.loop,
        loopStart: c.loopStart || 0, loopLength: c.loopLength || c.playStop, notes: c.notes.map(n => [n.ch, n.x, n.y, n.d, n.vel]) })) };
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
      case 'crawl': if (arr) crawlState = crawlResult(); break;
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
      const reply = () => json({ v: state.v, stepsPerBeat: 24, ...state.data, v: state.v });
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
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/api/play') return json(playSnapshot());
    if (url.pathname === '/api/nav') return json(navStatus());
    if (url.pathname === '/api/crawl') return json(crawlState);
    if (url.pathname === '/api/transport') {
      const c = arr ? arr.clips[nav.cur] : null; // Bitwig moves the play start marker to the selected clip
      return json({ project: 'Mock', playing: !!playSnapshot().playing, playStart: c ? (nav.playStart ?? c.start) : state.clipOffset, pos: playSnapshot().pos });
    }
    if (url.pathname === '/api/actions') return json([]);
    if (url.pathname === '/api/wizard') return wizard.handle(req, res, url, json);
    if (url.pathname === '/api/curve') return json(curve.status());
    if (url.pathname === '/api/marks') return curve.handleMarks(req, res);
    if (url.pathname === '/api/edit') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        body.split('\n').filter(l => l.trim()).forEach(l => {
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
        if (!nav.session) bump(); // like the extension: the page is not woken mid-session
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
    curve: curve.c, // Render dynamics: { state, runs, written, curves, devices, missing, speed, marks (JSON text), marksPosts }
    // MIDI bridge: pushMidi([{ type: 'on'|'off', key, vel?, t? (ms), playing? (defaults to the transport) }])
    pushMidi,
    setNotes(notes) { state.data.notes = notes; bump(); },
    setPlay(p) { state.sim = false; Object.assign(state.play, p); },
    setMarkers(m) { state.data.markers = m; bump(); },
    setData(d) { Object.assign(state.data, d); bump(); },
    close: () => new Promise(r => { wizard.close(); curve.close(); waiters.splice(0).forEach(fn => fn()); midi.waiters.splice(0).forEach(fn => fn()); server.close(r); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  startMockServer({ port: Number(arg('--port') || 8800), fixture: arg('--fixture') || undefined, quiet: false });
}
