// Mock of the extension's Render dynamics (src/claude/scoreview/CurvePlayer.java) for test/mock-server.mjs: the
// curve ops (curveClear / curveSet / curvePreview / curveRender / curveStop), GET /api/curve, and GET/POST /api/marks
// (the dynamics document the extension keeps in the project's DocumentState).
//
// Nothing is performed: a run moves the mock transport from fromBeat - 1 to toBeat at `speed` beats per second and
// records what CurvePlayer would set (srv.curve.written: [{run, track, target, beat, v}]); srv.curve.runs lists each
// run ({mode, from, to, curves}). Options (startMockServer({ curve: {...} })): devices {track: [device names]} (as
// /api/curve reports them), missing [track] (their controls are "not found"), speed (beats/s, default 8), marks
// (initial JSON text).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKS_MAX = 65535; // = ScoreViewExtension.MARKS_MAX
const PROFILES =JSON.parse(fs.readFileSync(path.join(ROOT, 'web/features/library-profiles.json'), 'utf8')).profiles;

export function createMockCurve({ devices = {}, missing = [], speed = 8, marks = '' } = {}, { playing, transport, tracks }) {
  const c = { state: 'idle', mode: '', message: '', from: 0, to: 0, pos: 0, progress: 0, restored: true, curves: new Map(),
    devices, missing, speed, runs: [], written: [], marks, marksPosts: 0, timer: null, run: 0, setError: null };
  const fmt = v => Math.round(v * 1000) / 1000;
  const error = why => { c.state = 'error'; c.message = why; };
  const running = () => c.state === 'preparing' || c.state === 'running';
  function valueAt(curve, beat) {
    const p = curve.points;
    if (beat <= p[0].beat) return p[0].v;
    for (let i = 1; i < p.length; i++) if (beat <= p[i].beat) return p[i - 1].v + (p[i].v - p[i - 1].v) * (beat - p[i - 1].beat) / ((p[i].beat - p[i - 1].beat) || 1);
    return p[p.length - 1].v;
  }
  function finish(state, message) {
    clearInterval(c.timer); c.timer = null;
    if (c.startedTransport) { transport(false); c.startedTransport = false; }
    c.state = state; c.message = message; c.restored = true;
  }
  function start(mode, a) {
    c.run++; // = CurvePlayer.runs: every request, refused ones too
    if (running()) { c.message = 'Already running: stop it first'; return; }
    const from = Math.max(0, Number(a[0])), to = Number(a[1]);
    Object.assign(c, { mode, from, to, pos: from, progress: 0 });
    if (!(to > from)) return error(`The range is empty (${a[0]} to ${a[1]})`);
    if (playing()) return error(`Stop playback first: ${mode} starts the transport itself.`);
    if (c.setError) return error(c.setError);
    if (!c.curves.size) return error('No curves: add dynamics first.');
    const names = new Set(tracks().map(t => t.name));
    const list = [...c.curves.values()];
    const bad = list.find(cv => !names.has(cv.track));
    if (bad) return error(`No track named '${bad.track}' in Bitwig`);
    c.state = 'preparing'; c.message = 'Finding the library controls…'; c.restored = false;
    const run = { mode, from, to, curves: list.map(cv => ({ ...cv, points: cv.points.slice() })) };
    c.runs.push(run);
    setTimeout(() => {
      if (c.state !== 'preparing') return;
      const lost = list.filter(cv => c.missing.includes(cv.track));
      if (lost.length) {
        const p = PROFILES.find(q => q.id === lost[0].profile), t = p.targets.find(x => x.id === lost[0].target);
        return finish('error', `Not found: ${p.name} ${t.label} on '${lost[0].track}' (devices: ${(c.devices[lost[0].track] || []).join(', ')}). Choose another library profile for that staff, or check the plug-in.`);
      }
      c.state = 'running'; c.message = mode === 'render' ? 'Rendering…' : 'Previewing…';
      transport(true, Math.max(0, from - 1));
      c.startedTransport = true;
      let pos = Math.max(0, from - 1);
      c.timer = setInterval(() => {
        pos += c.speed * 0.05;
        c.pos = Math.min(pos, to);
        c.progress = Math.max(0, Math.min(1, (c.pos - from) / (to - from)));
        if (pos >= from) list.forEach(cv => c.written.push({ run: c.runs.length, mode, track: cv.track, target: cv.target, beat: fmt(c.pos), v: fmt(valueAt(cv, c.pos)) }));
        c.message = `${mode === 'render' ? 'Rendering' : 'Previewing'} beats ${fmt(from)}–${fmt(to)} · beat ${fmt(c.pos)}`;
        if (pos >= to) finish('done', `${mode === 'render' ? 'Rendered' : 'Previewed'} beats ${fmt(from)}–${fmt(to)} · ${c.written.filter(w => w.run === c.runs.length).length} values`
          + (mode === 'render' ? ' recorded as arranger automation (Ctrl+Z in Bitwig undoes it).' : '.'));
      }, 50);
    }, 100);
  }
  function apply(cmd, a) {
    switch (cmd) {
      case 'curveClear': if (!running()) { c.curves.clear(); c.setError = null; } return;
      case 'curveSet': {
        if (running()) return error('Busy: stop the running ' + c.mode + ' first');
        const bad = why => { c.setError = `curveSet ${a[0]}: ${why}`; error(c.setError); };
        const p = PROFILES.find(q => q.id === a[2]);
        if (!p) return bad(`unknown library profile ${a[2]}`);
        if (!p.targets.some(t => t.id === a[3])) return bad(`${p.name} has no control ${a[3]}`);
        const points = String(a[4]).split(',').map(s => { const [b, v] = s.split(':').map(Number); return { beat: b, v: Math.max(0, Math.min(1, v)) }; });
        if (points.some((q, i) => !Number.isFinite(q.beat) || !Number.isFinite(q.v) || (i && q.beat < points[i - 1].beat))) return bad('points must be beat:value with increasing beats');
        c.curves.set(a[0], { id: a[0], track: decodeURIComponent(a[1]), profile: a[2], target: a[3], points });
        return;
      }
      case 'curvePreview': return start('preview', a);
      case 'curveRender': return start('render', a);
      case 'curveStop': if (running()) finish('stopped', 'Stopped.'); return;
      default: return;
    }
  }
  function status() {
    return { state: c.state, mode: c.mode, message: c.message, from: c.from, to: c.to, pos: c.pos,
      progress: c.state === 'done' ? 1 : c.progress, written: c.written.length, restored: c.restored, run: c.run,
      curves: [...c.curves.values()].map(cv => ({ id: cv.id, track: cv.track, profile: cv.profile, target: cv.target, points: cv.points.length })),
      devices: c.devices };
  }
  // GET returns the stored JSON ({} when empty); POST replaces it (a JSON object, like ScoreViewExtension.handleMarks).
  function handleMarks(req, res) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        body = body.trim();
        if (body.length > MARKS_MAX) { res.writeHead(413); return res.end(`too many marks (${body.length} > ${MARKS_MAX} characters)`); }
        if (!body.startsWith('{') || !body.endsWith('}')) { res.writeHead(400); return res.end('marks must be a JSON object'); }
        c.marks = body; c.marksPosts++;
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(c.marks && c.marks.trim() ? c.marks : '{}');
  }
  return { c, apply, status, handleMarks, close: () => clearInterval(c.timer) };
}
