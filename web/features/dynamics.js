// Feature module: dynamics — Sibelius-style dynamic marks and hairpins on the live clip's notes, stored in the Bitwig
// project (GET/POST /api/marks, the extension's DocumentState), engraved on the staff, and performed as real control
// curves on the track's library (Render dynamics: Preview / Render through the extension's CurvePlayer).
//
//   marks + hairpins (arranger beats, per track) ──levelModel──> level 0..1 ──library profile──> control curves
//                                                                                     └── curveSet / curveRender ops
//
// Pure part (node-testable): parseEntry, planEntry, doc helpers, levelModel, levelPoints, targetPoints, buildCurves,
// curveOps, planVelocities, thin. Node: const D = require('web/features/dynamics.js') (needs library-profiles.js).
// Page: SV.dynamics (see the end of this file and docs/features/dynamics.md).
(function (root) {
  'use strict';

  const LP = typeof module !== 'undefined' && module.exports ? require('./library-profiles.js') : (root.SV && root.SV.libraryProfiles);

  // ------------------------------------------------------------------ vocabulary

  const LEVELS = { ppp: 0.1, pp: 0.2, p: 0.32, mp: 0.45, mf: 0.57, f: 0.7, ff: 0.84, fff: 0.95 };
  const VELOCITY = { ppp: 20, pp: 33, p: 49, mp: 64, mf: 80, f: 96, ff: 112, fff: 124 };
  // accents: a short spike above the current level, then back (sfp: then p)
  const ACCENTS = { sfz: 0.25, sf: 0.22, fz: 0.25, sffz: 0.35, rfz: 0.18, sfp: 0.25 };
  const MARK_NAMES = Object.keys(LEVELS).concat(['fp'], Object.keys(ACCENTS));
  const PALETTE = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fp', 'sfz'];
  const SHAPES = [
    { id: 's', name: 'S-curve', blurb: 'eases in and out: the natural default' },
    { id: 'linear', name: 'Linear', blurb: 'an even ramp' },
    { id: 'late', name: 'Late swell', blurb: 'holds back, then blooms at the end' },
    { id: 'early', name: 'Early swell', blurb: 'opens at once, then settles' },
    { id: 'messa', name: 'Messa di voce', blurb: 'swells to the middle and falls back (<>)' },
  ];
  const STEP = 0.14;           // a hairpin without a target dynamic moves about one dynamic
  const JUMP = 1 / 24;         // a new dynamic: the curve jumps over one grid step
  const FP_LEN = 0.25;         // fp: forte for a sixteenth... then piano
  const SPIKE_LEN = 0.3;
  const MAX_PER_HAIRPIN = 16;  // automation points per hairpin, after thinning
  const EPS = 1 / 48;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const r4 = v => Math.round(v * 10000) / 10000;

  // ------------------------------------------------------------------ typing: "p<f", "mf", "<>", "sfz", "cresc."

  const WORDS = [['cresc.', 'cres'], ['cresc', 'cres'], ['decresc.', 'dim'], ['decresc', 'dim'], ['dim.', 'dim'], ['dim', 'dim'], ['<>', 'messa'], ['<', 'cres'], ['>', 'dim']];
  const NAMES_BY_LEN = MARK_NAMES.slice().sort((a, b) => b.length - a.length);
  /** Typed text -> { tokens: [{dyn} | {hairpin: 'cres'|'dim'|'messa'}] } or { error }. */
  function parseEntry(text) {
    const s = String(text || '').toLowerCase().replace(/\s+/g, '');
    if (!s) return { error: 'Type a dynamic (pp … ff, fp, sfz) and/or < > (for example p<f)' };
    const tokens = [];
    for (let i = 0; i < s.length;) {
      const w = WORDS.find(([k]) => s.startsWith(k, i));
      if (w) { tokens.push({ hairpin: w[1] }); i += w[0].length; continue; }
      const m = NAMES_BY_LEN.find(n => s.startsWith(n, i));
      if (!m) return { error: `Unknown dynamic "${s.slice(i)}" — use pp p mp mf f ff fff fp sfz, < > or <>` };
      tokens.push({ dyn: m });
      i += m.length;
    }
    return { tokens };
  }

  /**
   * Places typed tokens over a span of beats {start, end} (Dorico-style): dynamics before the first hairpin at the
   * start, each hairpin over an equal share of the span, a dynamic after a hairpin at its end. Without hairpins one
   * dynamic goes at the start; several are spread start → end. -> { marks:[{beat, text}], hairpins:[{start, end, form, shape?}] }
   */
  function planEntry(tokens, span) {
    const start = span.start, end = Math.max(span.end, span.start + EPS);
    const nh = tokens.filter(t => t.hairpin).length;
    const seg = nh ? (end - start) / nh : 0;
    const marks = [], hairpins = [];
    let k = 0;
    tokens.forEach(t => {
      if (t.hairpin) {
        const h = { start: r4(start + k * seg), end: r4(start + (k + 1) * seg), form: t.hairpin === 'dim' ? 'dim' : 'cres' };
        if (t.hairpin === 'messa') h.shape = 'messa';
        hairpins.push(h);
        k++;
      } else marks.push({ beat: r4(start + k * seg), text: t.dyn });
    });
    if (!nh && marks.length > 1) marks.forEach((m, i) => { m.beat = r4(start + (end - start) * i / (marks.length - 1)); });
    return { marks, hairpins };
  }

  // ------------------------------------------------------------------ the marks document (stored in the Bitwig project)
  // { v: 1, tracks: { [track]: { marks: [{id, beat, text, clip?}], hairpins: [{id, start, end, form, shape?, strength?, clip?}] } } }
  // Beats are arranger beats; clip = the arranger start of the clip the mark was entered in (for reference).

  let idSeq = 0;
  const newId = () => 'm' + Date.now().toString(36).slice(-5) + (idSeq++).toString(36) + Math.random().toString(36).slice(2, 5);
  const emptyDoc = () => ({ v: 1, tracks: {} });
  function normalizeDoc(d) {
    const out = emptyDoc();
    if (!d || typeof d !== 'object' || !d.tracks) return out;
    Object.keys(d.tracks).forEach(name => {
      const t = d.tracks[name] || {};
      const marks = (t.marks || []).filter(m => m && Number.isFinite(m.beat) && MARK_NAMES.includes(m.text));
      const hairpins = (t.hairpins || []).filter(h => h && Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
      if (marks.length || hairpins.length) out.tracks[name] = { marks, hairpins };
    });
    return out;
  }
  const entryOf = (doc, track) => (doc.tracks[track] || { marks: [], hairpins: [] });
  function ensure(doc, track) { if (!doc.tracks[track]) doc.tracks[track] = { marks: [], hairpins: [] }; return doc.tracks[track]; }
  const sortEntry = t => { t.marks.sort((a, b) => a.beat - b.beat); t.hairpins.sort((a, b) => a.start - b.start); };

  /** Adds a planned entry to a track: a mark replaces one at the same beat, a hairpin the ones it overlaps. Returns the new items. */
  function addEntry(doc, track, plan, extra = {}) {
    const t = ensure(doc, track);
    const added = { marks: [], hairpins: [] };
    plan.hairpins.forEach(h => {
      t.hairpins = t.hairpins.filter(o => Math.min(o.end, h.end) - Math.max(o.start, h.start) <= EPS);
      const n = Object.assign({ id: newId() }, h, extra);
      t.hairpins.push(n); added.hairpins.push(n);
    });
    plan.marks.forEach(m => {
      t.marks = t.marks.filter(o => Math.abs(o.beat - m.beat) > EPS);
      const n = Object.assign({ id: newId() }, m, extra);
      t.marks.push(n); added.marks.push(n);
    });
    sortEntry(t);
    return added;
  }
  /** Removes items by id (any track); returns how many went. */
  function removeIds(doc, ids) {
    const set = new Set(ids);
    let n = 0;
    Object.keys(doc.tracks).forEach(name => {
      const t = doc.tracks[name];
      const m0 = t.marks.length, h0 = t.hairpins.length;
      t.marks = t.marks.filter(m => !set.has(m.id));
      t.hairpins = t.hairpins.filter(h => !set.has(h.id));
      n += m0 - t.marks.length + h0 - t.hairpins.length;
      if (!t.marks.length && !t.hairpins.length) delete doc.tracks[name];
    });
    return n;
  }
  /** Removes a track's marks in [start, end] and hairpins overlapping it; returns how many went. */
  function removeRange(doc, track, start, end) {
    const t = doc.tracks[track];
    if (!t) return 0;
    const ids = t.marks.filter(m => m.beat >= start - EPS && m.beat <= end + EPS).map(m => m.id)
      .concat(t.hairpins.filter(h => h.start < end + EPS && h.end > start - EPS).map(h => h.id));
    return removeIds(doc, ids);
  }
  function findItem(doc, id) {
    for (const name of Object.keys(doc.tracks)) {
      const t = doc.tracks[name];
      const m = t.marks.find(x => x.id === id);
      if (m) return { track: name, kind: 'mark', item: m };
      const h = t.hairpins.find(x => x.id === id);
      if (h) return { track: name, kind: 'hairpin', item: h };
    }
    return null;
  }

  // ------------------------------------------------------------------ level model: marks + hairpins -> level(beat)

  const smoother = u => u * u * u * (u * (u * 6 - 15) + 10);
  /** Hairpin shape: progress u (0..1) -> 0..1; k = strength (0 = linear, 1 = strongest). */
  function shapeU(shape, u, k) {
    u = clamp01(u);
    switch (shape) {
      case 'linear': return u;
      case 'late': return Math.pow(u, 1 + 2.5 * k);
      case 'early': return 1 - Math.pow(1 - u, 1 + 2.5 * k);
      default: return u + (smoother(u) - u) * k; // 's'
    }
  }
  function rampValue(r, b) {
    const u = (b - r.s) / (r.e - r.s);
    if (r.shape === 'messa') {
      return u < 0.5 ? r.v0 + (r.peak - r.v0) * shapeU('s', u * 2, r.k) : r.peak + (r.v1 - r.peak) * shapeU('s', (u - 0.5) * 2, r.k);
    }
    return r.v0 + (r.v1 - r.v0) * shapeU(r.shape, u, r.k);
  }

  /**
   * entry = { marks, hairpins } of one track (arranger beats); opts = { shape (default for hairpins without their own),
   * strength (0..1), initial (level before the first mark) }. Returns { at(beat) -> 0..1, steps:[{beat, v}], ramps:[{s, e,
   * v0, v1, shape, k, peak, id}] }. A hairpin runs from the level at its start to the dynamic written at (about) its
   * end, else one dynamic up/down, and that level holds after it until the next mark.
   */
  function levelModel(entry, opts = {}) {
    const o = Object.assign({ shape: 's', strength: 0.7, initial: LEVELS.mf }, opts);
    const steps = [];
    let prev = o.initial;
    (entry.marks || []).slice().sort((a, b) => a.beat - b.beat).forEach(m => {
      const t = m.text;
      if (LEVELS[t] != null) { steps.push({ beat: m.beat, v: LEVELS[t], mark: m }); prev = LEVELS[t]; }
      else if (t === 'fp') { steps.push({ beat: m.beat, v: LEVELS.f, mark: m }, { beat: m.beat + FP_LEN, v: LEVELS.p }); prev = LEVELS.p; }
      else if (ACCENTS[t] != null) {
        const after = t === 'sfp' ? LEVELS.p : prev;
        steps.push({ beat: m.beat, v: clamp01(prev + ACCENTS[t]), mark: m, spike: true }, { beat: m.beat + SPIKE_LEN, v: after });
        prev = after;
      }
    });
    const ramps = [];
    const sortSteps = () => steps.sort((a, b) => a.beat - b.beat || (a.implicit ? -1 : 0) - (b.implicit ? -1 : 0));
    sortSteps();
    const stepAt = b => { let v = o.initial; for (const s of steps) { if (s.beat <= b + 1e-9) v = s.v; else break; } return v; };
    const at = b => { const r = ramps.find(x => b >= x.s - 1e-9 && b < x.e - 1e-9); return r ? rampValue(r, b) : stepAt(b); };
    (entry.hairpins || []).slice().sort((a, b) => a.start - b.start).forEach(h => {
      const v0 = at(h.start);
      const target = steps.filter(s => s.mark && !s.spike && s.beat >= h.end - 0.75 && s.beat <= h.end + 1)
        .sort((a, b) => Math.abs(a.beat - h.end) - Math.abs(b.beat - h.end))[0];
      const shape = h.shape || o.shape;
      const k = h.strength != null ? h.strength : o.strength;
      let v1 = target ? target.v : shape === 'messa' ? v0 : clamp01(v0 + (h.form === 'dim' ? -STEP : STEP));
      if (!target && shape !== 'messa' && v1 === v0) v1 = clamp01(v0 + (h.form === 'dim' ? -STEP / 2 : STEP / 2));
      const peak = shape === 'messa' ? clamp01(Math.max(v0, v1) + 0.1 + 0.15 * k) : null;
      ramps.push({ s: h.start, e: h.end, v0, v1, shape, k, peak, id: h.id });
      if (!target || target.beat > h.end + 1e-9) { steps.push({ beat: h.end, v: v1, implicit: true }); sortSteps(); }
    });
    return { at, steps, ramps, initial: o.initial };
  }

  // ------------------------------------------------------------------ curves: level points, thinning, variation

  /** Ramer–Douglas–Peucker on [{beat, v}], tightened until at most max points remain. */
  function thin(points, max = MAX_PER_HAIRPIN, eps0 = 0.004) {
    if (points.length <= 2) return points.slice();
    const rdp = (pts, eps) => {
      const keep = new Array(pts.length).fill(false);
      keep[0] = keep[pts.length - 1] = true;
      const stack = [[0, pts.length - 1]];
      while (stack.length) {
        const [a, z] = stack.pop();
        let best = -1, bi = -1;
        for (let i = a + 1; i < z; i++) {
          const t = (pts[i].beat - pts[a].beat) / (pts[z].beat - pts[a].beat || 1);
          const d = Math.abs(pts[i].v - (pts[a].v + (pts[z].v - pts[a].v) * t));
          if (d > best) { best = d; bi = i; }
        }
        if (best > eps) { keep[bi] = true; stack.push([a, bi], [bi, z]); }
      }
      return pts.filter((p, i) => keep[i]);
    };
    let eps = eps0, out = rdp(points, eps);
    while (out.length > max) { eps *= 1.5; out = rdp(points, eps); }
    return out;
  }

  function hash(seed, i) {
    let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i | 0, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967295 * 2 - 1;
  }
  /** Smooth value noise in -1..1 (cosine-interpolated lattice, period 1). */
  function smoothNoise(seed, x) {
    const i = Math.floor(x), f = x - i, a = hash(seed, i), b = hash(seed, i + 1);
    return a + (b - a) * (1 - Math.cos(Math.PI * f)) / 2;
  }
  const seedOf = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

  /**
   * Level points [{beat, v}] of a model over [from, to]: the value at `from`, a jump at each new dynamic, up to
   * MAX_PER_HAIRPIN thinned points per hairpin, the value at `to`; holds stay flat (easy to edit in Bitwig) unless
   * human variation adds a gentle drift (a point every 2 beats). opts.variation = { on, amount (0..1), seed }.
   */
  function levelPoints(model, from, to, opts = {}) {
    const pts = [];
    const add = (beat, v, tag) => pts.push({ beat: r4(beat), v, tag });
    add(from, model.at(from), 'from');
    model.steps.forEach(s => {
      if (s.beat <= from + 1e-9 || s.beat >= to - 1e-9) return;
      const before = model.at(s.beat - 1e-6), after = model.at(s.beat);
      if (Math.abs(before - after) < 1e-4) return;
      add(Math.max(from, s.beat - JUMP), model.at(Math.max(from, s.beat - JUMP)), 'pre');
      add(s.beat, after, 'step');
    });
    model.ramps.forEach(r => {
      const a = Math.max(r.s, from), z = Math.min(r.e, to);
      if (z - a < 1e-6) return;
      const raw = [];
      for (let i = 0; i <= 48; i++) { const b = a + (z - a) * i / 48; raw.push({ beat: b, v: i === 48 && z === r.e ? r.v1 : rampValue(r, Math.min(b, r.e - 1e-9)) }); }
      thin(raw).forEach(p => add(p.beat, p.v, 'ramp'));
    });
    const inRamp = b => model.ramps.find(r => b > r.s + 1e-6 && b < r.e - 1e-6);
    const variation = opts.variation || {};
    if (variation.on && variation.amount > 0) {
      // drift points in long holds: every 2 beats, away from jumps and hairpins
      const marks = pts.map(p => p.beat);
      for (let b = Math.ceil(from / 2) * 2 + 2; b < to - 1; b += 2) {
        if (inRamp(b) || marks.some(m => Math.abs(m - b) < 1)) continue;
        add(b, model.at(b), 'drift');
      }
    }
    add(to, model.at(Math.max(from, to - 1e-6)), 'to');
    pts.sort((p, q) => p.beat - q.beat);
    const out = [];
    pts.forEach(p => { // same beat: the later value wins (a jump keeps both sides one grid step apart)
      const last = out[out.length - 1];
      if (last && Math.abs(last.beat - p.beat) < 1e-6) out[out.length - 1] = p; else out.push(p);
    });
    if (variation.on && variation.amount > 0) {
      const amp = 0.05 * Math.min(1, variation.amount), seed = variation.seed || 1;
      out.forEach(p => {
        const r = inRamp(p.beat);
        const env = r ? 0.4 + 0.6 * Math.sin(Math.PI * (p.beat - r.s) / (r.e - r.s)) : 0.4;
        p.v = p.v + amp * env * smoothNoise(seed, p.beat / 1.7);
      });
    }
    return out.map(p => ({ beat: p.beat, v: r4(clamp01(p.v)) }));
  }

  /** Linear interpolation over points [{beat, v}] sorted by beat. */
  function interp(points, b) {
    if (!points.length) return 0;
    if (b <= points[0].beat) return points[0].v;
    for (let i = 1; i < points.length; i++) {
      if (b <= points[i].beat) { const p = points[i - 1], q = points[i]; return p.v + (q.v - p.v) * (b - p.beat) / ((q.beat - p.beat) || 1); }
    }
    return points[points.length - 1].v;
  }

  /**
   * One target's control points from level points: valueAt(target, level). The second control of a dual library
   * (role expression) trails by `lag` beats with its own small wobble (human variation).
   */
  function targetPoints(levelPts, target, { lag = 0, amount = 0, seed = 1 } = {}) {
    const second = target.role === 'expression';
    return levelPts.map(p => {
      let level = second && lag ? interp(levelPts, p.beat - lag) : p.v;
      if (second && amount > 0) level += 0.012 * amount * smoothNoise(seed + 7, p.beat / 1.3);
      return { beat: p.beat, v: r4(clamp01(LP.valueAt(target, clamp01(level)))) };
    });
  }

  /**
   * Curves for Render/Preview: tracks [{track, profile}] over [from, to] (arranger beats) -> [{track, profile, target,
   * points}]. prefs = { shape, strength, variation, amount }. Profiles without controls (velocity only) give none.
   */
  function buildCurves(doc, tracks, from, to, prefs = {}) {
    const out = [];
    tracks.forEach(({ track, profile }) => {
      if (!profile || !(profile.targets || []).length) return;
      const model = levelModel(entryOf(doc, track), { shape: prefs.shape, strength: prefs.strength });
      const seed = seedOf(track);
      const variation = { on: !!prefs.variation, amount: prefs.amount != null ? prefs.amount : 0.35, seed };
      const lvl = levelPoints(model, from, to, { variation });
      const lag = variation.on ? 0.12 * variation.amount : 0;
      profile.targets.forEach(t => out.push({ track, profile: profile.id, target: t.id, kind: t.kind,
        points: targetPoints(lvl, t, { lag, amount: variation.on ? variation.amount : 0, seed }) }));
    });
    return out;
  }

  const pointsText = pts => pts.map(p => `${r4(p.beat)}:${r4(p.v)}`).join(',');
  /** The ops that load curves into the extension and run them: mode 'preview' | 'render'. */
  function curveOps(curves, mode, from, to) {
    const ops = ['curveClear'];
    curves.forEach((c, i) => ops.push(`curveSet c${i + 1} ${encodeURIComponent(c.track)} ${c.profile} ${c.target} ${pointsText(c.points)}`));
    if (mode) ops.push(`${mode === 'render' ? 'curveRender' : 'curvePreview'} ${r4(from)} ${r4(to)}`);
    return ops;
  }

  // ------------------------------------------------------------------ velocities ("both ways")

  const VEL_TABLE = Object.keys(LEVELS).map(k => [LEVELS[k], VELOCITY[k]]);
  function levelToVelocity(level) {
    if (level <= VEL_TABLE[0][0]) return VEL_TABLE[0][1];
    for (let i = 1; i < VEL_TABLE.length; i++) {
      const [l1, v1] = VEL_TABLE[i], [l0, v0] = VEL_TABLE[i - 1];
      if (level <= l1) return v0 + (v1 - v0) * (level - l0) / (l1 - l0);
    }
    return VEL_TABLE[VEL_TABLE.length - 1][1];
  }
  const clampVel = v => Math.max(1, Math.min(127, Math.round(v)));
  const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

  /**
   * New velocities for notes [{id, start (arranger beats), vel (1..127)}] of one track: each dynamic mark scales the
   * notes it governs (from it to the next dynamic) so their average is the mark's velocity, keeping accents; fp = f on
   * its first chord, p after; sfz & co. raise only the note they sit on. opts = { marks (default true), hairpins
   * (default false: notes under a hairpin follow its curve), only: Set of mark/hairpin ids to apply (default all),
   * model (levelModel, for hairpins) }. -> [{id, vel}] (changed notes only).
   */
  function planVelocities(entry, notes, opts = {}) {
    const o = Object.assign({ marks: true, hairpins: false }, opts);
    const want = id => !o.only || o.only.has(id);
    const out = new Map();
    const cur = n => (out.has(n.id) ? out.get(n.id) : n.vel);
    const marks = (entry.marks || []).slice().sort((a, b) => a.beat - b.beat);
    const governing = marks.filter(m => !ACCENTS[m.text] || m.text === 'sfp');
    if (o.marks) {
      governing.forEach((m, i) => {
        if (!want(m.id)) return;
        const end = i + 1 < governing.length ? governing[i + 1].beat : Infinity;
        const group = notes.filter(n => n.start >= m.beat - EPS && n.start < end - EPS);
        if (!group.length) return;
        const scale = (list, target) => { const avg = mean(list.map(cur)); list.forEach(n => out.set(n.id, clampVel(cur(n) * target / avg))); };
        if (m.text === 'fp' || m.text === 'sfp') {
          const first = group.filter(n => n.start < m.beat + EPS), rest = group.filter(n => n.start >= m.beat + EPS);
          if (first.length) scale(first, m.text === 'fp' ? VELOCITY.f : VELOCITY.ff);
          if (rest.length) scale(rest, VELOCITY.p);
        } else scale(group, VELOCITY[m.text]);
      });
      marks.filter(m => ACCENTS[m.text] && m.text !== 'sfp' && want(m.id)).forEach(m => {
        notes.filter(n => Math.abs(n.start - m.beat) < EPS).forEach(n => out.set(n.id, Math.max(cur(n), m.text === 'sffz' ? 124 : 118)));
      });
    }
    if (o.hairpins) {
      const model = o.model || levelModel(entry);
      (entry.hairpins || []).filter(h => want(h.id)).forEach(h => {
        const group = notes.filter(n => n.start >= h.start - EPS && n.start < h.end - EPS);
        if (!group.length) return;
        const avg = mean(group.map(cur));
        group.forEach(n => out.set(n.id, clampVel(levelToVelocity(model.at(n.start)) * cur(n) / avg)));
      });
    }
    const byId = new Map(notes.map(n => [n.id, n.vel]));
    return [...out].filter(([id, v]) => v !== byId.get(id)).map(([id, vel]) => ({ id, vel }));
  }

  const pure = { LEVELS, VELOCITY, ACCENTS, MARK_NAMES, PALETTE, SHAPES, MAX_PER_HAIRPIN, parseEntry, planEntry, emptyDoc,
    normalizeDoc, entryOf, addEntry, removeIds, removeRange, findItem, shapeU, levelModel, thin, smoothNoise, levelPoints,
    interp, targetPoints, buildCurves, pointsText, curveOps, levelToVelocity, planVelocities, seedOf };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ================================================================== page
  const SV = root.SV;
  if (!SV || !SV.hooks) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cleanName = n => String(n || '').replace(/\s*✎\s*$/, '').trim();

  // ---- preferences (Josh's rule: every behaviour someone may want differently is a saved preference)
  const PREF_KEY = 'scoreview.dynamics.prefs';
  const DEFAULTS = { shape: 's', strength: 0.7, variation: true, amount: 0.35, velMarks: true, velHairpins: false,
    keys: 'sibelius', profiles: {} };
  const prefs = (() => { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(PREF_KEY)) || {}); } catch (e) { return Object.assign({}, DEFAULTS); } })();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  // ---- the marks document: loaded from the Bitwig project, saved back after each change
  let doc = emptyDoc(), loadedFor = undefined, saveTimer = 0;
  async function loadDoc() {
    try {
      const r = await fetch('/api/marks', { cache: 'no-store' });
      const text = r.ok ? await r.text() : '';
      doc = normalizeDoc(text ? JSON.parse(text) : null);
    } catch (e) { doc = emptyDoc(); }
    SV.requestRender();
    refreshPanel();
  }
  function saveDoc() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch('/api/marks', { method: 'POST', body: JSON.stringify(doc) })
        .then(async r => { if (!r.ok) throw new Error(await r.text()); })
        .catch(e => SV.flash('Could not save the dynamics in the Bitwig project: ' + e.message));
    }, 150);
  }
  SV.hooks.liveData.push(d => {
    const p = d && d.project != null ? d.project : null;
    if (p !== loadedFor) { loadedFor = p; loadDoc(); } // first update, and every project switch
  });

  // ---- where the live clip sits in the arrangement
  let transportStart = { key: null, beat: null };
  const clipKey = d => [d.track, d.length, d.playStart, d.loopStart, d.loopLength].join('|');
  /**
   * Arranger beat of the live clip's content beat 0 -> { origin, how } | null: the Score-mode placement, else the last
   * ⟳ Read arrangement, else the play start marker (Bitwig moves it to a clip you select).
   */
  function liveOrigin() {
    const S = SV.state, d = S.liveData;
    if (!d || !d.exists || S.source !== 'arranger') return null;
    const ps = d.playStart || 0;
    if (S.mode === 'score' && S.align && S.align.track === d.track) return { origin: S.align.offset - ps, how: 'placement' };
    const m = SV.arrangement && SV.arrangement.liveClip ? SV.arrangement.liveClip() : null;
    if (m) return { origin: m.clip.start - m.clip.playStart, how: 'read' };
    if (transportStart.key === clipKey(d) && transportStart.beat != null) return { origin: transportStart.beat - ps, how: 'play start' };
    return null;
  }
  SV.hooks.liveData.push(d => {
    if (!d || !d.exists) return;
    const k = clipKey(d);
    if (transportStart.key === k) return;
    transportStart = { key: k, beat: null };
    fetch('/api/transport', { cache: 'no-store' }).then(r => r.json())
      .then(t => { if (transportStart.key === k && !t.playing) { transportStart.beat = t.playStart; SV.requestRender(); } }).catch(() => {});
  });

  /** The selected live notes (no keyswitches) in arranger beats -> { track, start, end, notes, origin } | { error }. */
  function selectionSpan() {
    const S = SV.state, d = S.liveData;
    if (!d || !d.exists) return { error: 'Select notes of the live clip first' };
    if (S.source !== 'arranger') return { error: 'Dynamics live on the arranger timeline: switch Score View to Arranger' };
    const o = liveOrigin();
    if (!o) return { error: 'Where is this clip in the arrangement? Use Score mode or ⟳ Read arrangement first' };
    const spb = d.stepsPerBeat || 24;
    const ids = new Set([...S.selection].filter(id => SV.isLive(id)));
    const notes = d.notes.filter(n => n.y >= 24 && ids.has(SV.liveId(n)))
      .map(n => ({ id: SV.liveId(n), ch: n.ch, x: n.x, y: n.y, start: n.x / spb + o.origin, end: n.x / spb + n.d + o.origin, vel: n.vel }));
    if (!notes.length) return { error: 'Select notes of the live clip first' };
    return { track: d.track, start: Math.min(...notes.map(n => n.start)), end: spanEnd(notes, liveTrackNotes(o)), notes, origin: o };
  }

  /**
   * Where a hairpin over the selection ends (and the dynamic typed after it goes): on a rhythmic position, not where the
   * last note's sound happens to stop (short or detached notes would put an f between beats). The next note's start
   * when it comes within a beat of the selection's end, else that end rounded up to a sixteenth.
   */
  function spanEnd(sel, all) {
    const lastStart = Math.max(...sel.map(n => n.start)), rawEnd = Math.max(...sel.map(n => n.end));
    const next = Math.min(...all.filter(n => n.start > lastStart + EPS).map(n => n.start));
    if (Number.isFinite(next) && next <= rawEnd + 1 + 1e-9) return r4(next);
    return r4(Math.max(lastStart + EPS, Math.ceil(rawEnd * 4 - 1e-6) / 4));
  }

  /** The live clip's notes in arranger beats (for velocities). */
  function liveTrackNotes(o) {
    const d = SV.state.liveData, spb = d.stepsPerBeat || 24;
    return d.notes.filter(n => n.y >= 24).map(n => ({ id: SV.liveId(n), ch: n.ch, x: n.x, y: n.y, start: n.x / spb + o.origin, vel: n.vel }));
  }

  /** Enters typed dynamics over the selected notes ("p<f", "mf", "<", ">", "<>", "sfz"). Returns true when something was added. */
  function enter(text, opts = {}) {
    const parsed = parseEntry(text);
    if (parsed.error) { SV.flash(parsed.error); return false; }
    const span = selectionSpan();
    if (span.error) { SV.flash(span.error); return false; }
    const plan = planEntry(parsed.tokens, span);
    if (opts.shape) plan.hairpins.forEach(h => { if (!h.shape) h.shape = opts.shape; });
    const added = addEntry(doc, span.track, plan, { clip: r4(span.origin.origin + (SV.state.liveData.playStart || 0)) });
    saveDoc();
    applyVelocities(span.track, span.origin, new Set(added.marks.map(m => m.id).concat(added.hairpins.map(h => h.id))));
    SV.requestRender();
    refreshPanel();
    SV.flash(`${span.track}: ${String(text).trim()} · stored in the Bitwig project`);
    return true;
  }

  function applyVelocities(track, origin, only) {
    if (!prefs.velMarks && !prefs.velHairpins) return 0;
    const entry = entryOf(doc, track);
    const notes = liveTrackNotes(origin);
    const plan = planVelocities(entry, notes, { marks: prefs.velMarks, hairpins: prefs.velHairpins, only,
      model: levelModel(entry, { shape: prefs.shape, strength: prefs.strength }) });
    const byId = new Map(notes.map(n => [n.id, n]));
    const ops = plan.map(p => { const n = byId.get(p.id); return `vel ${n.ch} ${n.x} ${n.y} ${r4(p.vel / 127)}`; });
    if (ops.length) { SV.send(ops); SV.state.editedTracks && SV.state.editedTracks.add(track); }
    return ops.length;
  }

  // ---- engraving: the stored marks on their staves
  function scoreOrigin(score) {
    const S = SV.state, d = S.liveData;
    const mb = score.timeSig.num * 4 / score.timeSig.den;
    if (S.mode === 'score') return (score.measureOffset || 0) * mb;
    const o = liveOrigin();
    return o ? o.origin + ((d && d.playStart) || 0) : null;
  }
  SV.hooks.transformScore.push(score => {
    if (!score || !score.parts || !Object.keys(doc.tracks).length) return score;
    const so = scoreOrigin(score);
    if (so == null) return score;
    const len = score.lengthBeats || Infinity;
    score.parts = score.parts.map(part => {
      const name = cleanName(part.name);
      const t = doc.tracks[name];
      if (!t) return part;
      const p = Object.assign({}, part);
      // our marks replace the ones articulations.js guessed from velocity/automation (its sfz accents stay)
      p.marks = (p.marks || []).filter(m => m.kind !== 'dynam' || m.sfz);
      p.hairpins = [];
      t.marks.forEach(m => { const b = m.beat - so; if (b >= -1e-6 && b < len) p.marks.push({ beat: Math.max(0, b), text: m.text, kind: 'dynam', id: 'dm_' + m.id }); });
      t.hairpins.forEach(h => {
        const s = Math.max(0, h.start - so), e = Math.min(len, h.end - so);
        if (e - s < 1e-6) return;
        if ((h.shape || '') === 'messa') {
          const mid = (s + e) / 2;
          p.hairpins.push({ start: s, end: mid, form: 'cres', id: 'dh_' + h.id }, { start: mid, end: e, form: 'dim', id: 'dh2_' + h.id });
        } else p.hairpins.push({ start: s, end: e, form: h.form, id: 'dh_' + h.id });
      });
      return p;
    });
    return score;
  });

  // Click targets: hairpins are thin lines, so each of ours gets a transparent box to click.
  SV.hooks.afterRender.push(() => {
    document.querySelectorAll('#paper g.hairpin[id^="dh"], #paper g.dynam[id^="dm_"]').forEach(g => {
      g.classList.add('svd-item');
      if (g.querySelector('.svd-hit')) return;
      try {
        const b = g.getBBox();
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const pad = Math.max(60, b.height);
        r.setAttribute('class', 'svd-hit');
        r.setAttribute('x', b.x - 20); r.setAttribute('y', b.y - pad / 2);
        r.setAttribute('width', b.width + 40); r.setAttribute('height', b.height + pad);
        g.insertBefore(r, g.firstChild);
      } catch (e) { /* not laid out */ }
    });
  });
  const itemIdOf = el => { const g = el && el.closest && el.closest('#paper g.svd-item'); return g ? g.id.replace(/^(dh2_|dh_|dm_)/, '') : null; };
  SV.hooks.paperMouseDown.push(e => {
    const id = itemIdOf(e.target);
    if (!id || e.button !== 0) return false;
    e.preventDefault();
    openItemPop(id, e.clientX, e.clientY);
    return true;
  });

  // ------------------------------------------------------------------ keys
  const entryOn = () => !!(SV.entry && SV.entry.state && SV.entry.state.on);
  const hasLiveSelection = () => [...SV.state.selection].some(id => SV.isLive(id));
  SV.hooks.keydown.push(e => {
    if (e.metaKey || entryOn()) return false;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyE') {
      e.preventDefault();
      if (!hasLiveSelection()) { SV.flash('Dynamics: select notes of the live clip first (then Ctrl+E)'); return true; }
      openEntryPop();
      return true;
    }
    if (e.code !== 'KeyH' || e.ctrlKey) return false;
    const wanted = prefs.keys === 'alt' ? e.altKey : !e.altKey;
    if (!wanted || !hasLiveSelection()) return false; // without a selection H stays harmony colours
    e.preventDefault();
    enter(e.shiftKey ? '>' : '<', { shape: null });
    return true;
  });
  if (SV.shortcuts) {
    const alt = prefs.keys === 'alt';
    SV.shortcuts.register({ keys: alt ? 'Alt+H' : 'H', owner: 'dynamics', when: alt ? 'normal' : 'live notes selected', desc: 'crescendo hairpin over the selected notes' + (alt ? '' : ' (without a selection: harmony colours)') });
    SV.shortcuts.register({ keys: alt ? 'Alt+Shift+H' : 'Shift+H', owner: 'dynamics', when: alt ? 'normal' : 'live notes selected', desc: 'diminuendo hairpin over the selected notes' });
    SV.shortcuts.register({ keys: 'Ctrl+E', owner: 'dynamics', when: 'normal', desc: 'dynamics popover: type pp … ff, fp, sfz, p<f, <>' });
    SV.shortcuts.register({ keys: ['Enter', 'Escape'], owner: 'dynamics', when: 'Dynamics popover', desc: 'apply / close' });
  }

  // ------------------------------------------------------------------ UI
  SV.addStyle(`
    .svd { position: relative; }
    .svd-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: var(--sv-z-menu); width: 400px; max-width: calc(100vw - 32px);
      max-height: 78vh; overflow: auto; background: var(--sv-surface-2); border: 1px solid var(--sv-border); border-radius: var(--sv-radius-md);
      padding: var(--sv-space-4) var(--sv-space-5); box-shadow: var(--sv-shadow-pop); color: var(--sv-text); font-size: var(--sv-fs-body); }
    .svd-h { font-size: var(--sv-fs-label); font-weight: 700; color: var(--sv-text-dim); text-transform: uppercase; letter-spacing: .08em; margin: 10px 0 6px; }
    .svd-h:first-child { margin-top: 2px; }
    .svd-row { display: grid; grid-template-columns: 110px 1fr; align-items: center; gap: 6px; margin: 4px 0; }
    .svd-row input[type=range] { width: 100%; }
    .svd-check { display: block; margin: 3px 0; }
    .svd-hint { color: var(--sv-text-dim); font-size: var(--sv-fs-small); margin: 4px 0; line-height: 1.4; }
    .svd-pal { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
    .svd-pal button { min-width: 34px; height: 26px; background: var(--sv-surface-3); color: var(--sv-text); border: 1px solid var(--sv-border);
      border-radius: var(--sv-radius-sm); cursor: pointer; font: italic 700 14px "Times New Roman", serif; }
    .svd-pal button:hover { border-color: var(--sv-accent); }
    .svd-pal button.svd-hp { font: 600 13px var(--sv-font); }
    .svd-type { width: 100%; box-sizing: border-box; background: var(--sv-surface-3); color: var(--sv-text); border: 1px solid var(--sv-border);
      border-radius: var(--sv-radius-sm); padding: 4px 6px; font: italic 600 14px "Times New Roman", serif; }
    .svd-type:focus { outline: none; box-shadow: var(--sv-focus); }
    .svd-list { max-height: 140px; overflow: auto; border: 1px solid var(--sv-border); border-radius: var(--sv-radius-sm); padding: 2px 4px; }
    .svd-li { display: flex; gap: 8px; align-items: center; padding: 1px 2px; }
    .svd-li .svd-what { flex: 1; }
    .svd-li .svd-mk { font: italic 700 13px "Times New Roman", serif; }
    .svd-li button { background: none; border: 0; color: var(--sv-text-dim); cursor: pointer; padding: 0 4px; }
    .svd-li button:hover { color: var(--sv-err); }
    .svd-staves { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 3px 8px; align-items: center; }
    .svd-staves select { width: 100%; min-width: 0; }
    .svd-how { color: var(--sv-text-dim); font-size: var(--sv-fs-small); }
    .svd-bars input { width: 56px; }
    .svd-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
    .svd-actions .svd-render { background: var(--sv-accent); color: var(--sv-on-accent); border-color: var(--sv-accent); font-weight: 700; }
    .svd-actions .svd-render:disabled { opacity: .5; }
    .svd-foot { position: sticky; bottom: calc(-1 * var(--sv-space-4)); background: var(--sv-surface-2); padding: 2px 0 var(--sv-space-4);
      margin-bottom: calc(-1 * var(--sv-space-4)); border-top: 1px solid var(--sv-border); }
    .svd-progress { height: 6px; background: var(--sv-surface-3); border-radius: 3px; overflow: hidden; margin-top: 8px; }
    .svd-progress > div { height: 100%; width: 0; background: var(--sv-accent); transition: width var(--sv-motion); }
    .svd-progress[hidden] { display: none; }
    .svd-status { margin-top: 6px; font-size: var(--sv-fs-control); white-space: pre-line; }
    .svd-status.bad { color: var(--sv-err); }
    .svd-status.ok { color: var(--sv-ok); }
    .svd-exp { color: var(--sv-warn); font-size: var(--sv-fs-small); }
    .svd-pop { position: fixed; z-index: var(--sv-z-pop); width: 280px; background: var(--sv-surface-2); border: 1px solid var(--sv-border);
      border-radius: var(--sv-radius-md); box-shadow: var(--sv-shadow-pop); padding: var(--sv-space-4); color: var(--sv-text); font-size: var(--sv-fs-control); }
    .svd-pop .svd-actions { margin-top: 6px; }
    #paper g.svd-item { cursor: pointer; }
    #paper g.svd-item .svd-hit { fill: transparent; stroke: none; pointer-events: all; }
    #paper g.svd-item:hover { fill: var(--sv-sel); stroke: var(--sv-sel); }
  `);

  const group = SV.addToolbar('<div class="svd"><button class="btn" id="svdBtn" title="Dynamics: marks and hairpins on the selected notes (H, Shift+H, Ctrl+E), and Render dynamics (record library control curves as Bitwig automation)">Dynamics ▾</button>'
    + '<div class="svd-panel hidden" id="svdPanel"></div></div>', { cluster: 'write', order: 90 });
  const panel = group.querySelector('#svdPanel');
  const q = id => panel.querySelector('#' + id);
  const shapeName = id => (SHAPES.find(s => s.id === id) || SHAPES[0]).name;
  const mbNow = () => { const d = SV.state.liveData || {}; return (d.num || 4) * 4 / (d.den || 4); };
  /** 'bar 3' on a bar line, else 'bar 3 beat 2.5' (1-based, arranger bars). */
  const barBeat = b => { const mb = mbNow(); const bar = Math.floor(b / mb + 1e-9), off = b - bar * mb; return `bar ${bar + 1}` + (off > 1e-3 ? ` beat ${Math.round((off + 1) * 100) / 100}` : ''); };

  // ---- library detection: /api/curve reports the devices on each track
  let curveStatus = null;
  async function fetchCurve() {
    try { curveStatus = await (await fetch('/api/curve', { cache: 'no-store' })).json(); } catch (e) { /* keep the old one */ }
    return curveStatus;
  }
  function profileFor(track) {
    const base = SV.state.base && SV.state.base.parts ? SV.state.base.parts.find(p => cleanName(p.name) === track) : null;
    return LP.detect({ override: prefs.profiles[track], deviceNames: curveStatus && curveStatus.devices ? curveStatus.devices[track] : null,
      pluginName: base && base.plugin ? base.plugin.name : null, trackName: track });
  }

  /** Default bar range: the live clip's bars -> { from, to } (1-based arranger bars) | null. */
  function clipBars() {
    const d = SV.state.liveData, o = liveOrigin();
    if (!d || !d.exists || !o) return null;
    const ps = d.playStart || 0, mb = mbNow();
    const start = o.origin + ps, end = o.origin + (d.length || 0);
    return { from: Math.floor(start / mb + 1e-6) + 1, to: Math.max(Math.floor(start / mb + 1e-6) + 1, Math.ceil(end / mb - 1e-6)) };
  }
  /** Staves to perform: every shown track with marks (the live track first). */
  function performTracks() {
    const shown = SV.state.render && SV.state.render.staves ? [...new Set(SV.state.render.staves.map(s => cleanName(s.part)))] : [];
    const live = SV.state.liveData && SV.state.liveData.exists ? SV.state.liveData.track : null;
    const names = Object.keys(doc.tracks).filter(n => shown.includes(n) || n === live);
    return names.sort((a, b) => (a === live ? -1 : b === live ? 1 : shown.indexOf(a) - shown.indexOf(b)));
  }

  const unchecked = new Set(); // staves unticked in the panel this session
  let run = null;               // { mode, timer } while Preview/Render runs

  function marksListHtml() {
    const tracks = performTracks();
    if (!tracks.length) return '<div class="svd-hint">No dynamics yet. Select notes and press <b>H</b> / <b>Shift+H</b> for a hairpin, or type below.</div>';
    const rows = [];
    tracks.forEach(name => {
      const t = doc.tracks[name];
      const items = t.marks.map(m => ({ b: m.beat, html: `<span class="svd-mk">${esc(m.text)}</span>`, id: m.id }))
        .concat(t.hairpins.map(h => ({ b: h.start, id: h.id,
          html: `${h.shape === 'messa' ? '&lt;&gt; messa di voce' : h.form === 'dim' ? 'dim. &gt;' : 'cresc. &lt;'} to ${barBeat(h.end)}${h.shape && h.shape !== 'messa' ? ' · ' + esc(shapeName(h.shape)) : ''}` })))
        .sort((a, b) => a.b - b.b);
      items.forEach(it => rows.push(`<div class="svd-li"><span class="svd-what">${esc(name)} · ${barBeat(it.b)} · ${it.html}</span><button data-del="${it.id}" title="Remove (velocities already set stay; Ctrl+Z in Bitwig undoes them)">✕</button></div>`));
    });
    return `<div class="svd-list" id="svdList">${rows.join('')}</div>`;
  }

  function stavesHtml() {
    const tracks = performTracks();
    if (!tracks.length) return '<div class="svd-hint">Nothing to perform: add dynamics first.</div>';
    const opts = (track, cur) => LP.list().map(p => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)}${p.experimental ? ' (experimental)' : ''}</option>`).join('');
    return '<div class="svd-staves">' + tracks.map(name => {
      const det = profileFor(name);
      const how = det.how === 'override' ? 'your choice' : det.how === 'fallback' ? 'not recognised' : 'from the ' + det.how;
      return `<input type="checkbox" data-track="${esc(name)}" ${unchecked.has(name) ? '' : 'checked'}><span>${esc(name)}</span>`
        + `<select data-profile="${esc(name)}" title="Library profile (${esc(how)})"><option value="">Auto: ${esc(det.profile.name)}</option>${opts(name, prefs.profiles[name])}</select>`;
    }).join('') + '</div>';
  }

  function showPanel() {
    const cb = clipBars();
    const playing = SV.state.playing;
    panel.innerHTML = '<div class="svd-h">Marks</div>'
      + '<div class="svd-hint">Select notes, then click or type (Dorico-style: <i>p&lt;f</i>, <i>mf&gt;</i>, <i>&lt;&gt;</i>). Keys: '
      + (prefs.keys === 'alt' ? '<b>Alt+H</b> / <b>Alt+Shift+H</b>' : '<b>H</b> / <b>Shift+H</b>') + ' hairpin, <b>Ctrl+E</b> popover. Stored in the Bitwig project.</div>'
      + palHtml()
      + '<input class="svd-type" id="svdType" placeholder="p<f" spellcheck="false">'
      + marksListHtml()
      + '<div class="svd-h">Render dynamics</div>'
      + stavesHtml()
      + `<div class="svd-row svd-bars">Bars <span><input type="number" id="svdFrom" min="1" value="${cb ? cb.from : ''}"> to <input type="number" id="svdTo" min="1" value="${cb ? cb.to : ''}"></span></div>`
      + '<div class="svd-hint"><b>Render</b> plays the bars and records the library\'s controls (e.g. Timbre + Expression) as Bitwig arranger automation (write mode "touch"), then restores your write settings. Undo with Ctrl+Z in Bitwig, or edit the lanes. <b>Preview</b> plays and moves the controls without recording.</div>'
      + '<div class="svd-h">Shape</div>'
      + `<label class="svd-row">Hairpins <select id="svdShape">${SHAPES.map(s => `<option value="${s.id}" ${s.id === prefs.shape ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`
      + `<div class="svd-hint" id="svdShapeBlurb">${esc((SHAPES.find(s => s.id === prefs.shape) || SHAPES[0]).blurb)}. Click a hairpin in the score to give it its own shape.</div>`
      + `<label class="svd-row">Shape strength <input type="range" id="svdStrength" min="0" max="1" step="0.05" value="${prefs.strength}"></label>`
      + `<label class="svd-check"><input type="checkbox" id="svdVar" ${prefs.variation ? 'checked' : ''}> Human variation (a slow, seeded wobble; the second slider trails a little)</label>`
      + `<label class="svd-row">Variation <input type="range" id="svdAmount" min="0" max="1" step="0.05" value="${prefs.amount}" ${prefs.variation ? '' : 'disabled'}></label>`
      + '<div class="svd-h">Velocities</div>'
      + `<label class="svd-check"><input type="checkbox" id="svdVelMarks" ${prefs.velMarks ? 'checked' : ''}> A dynamic mark sets the velocities of the notes it governs</label>`
      + `<label class="svd-check"><input type="checkbox" id="svdVelHairpins" ${prefs.velHairpins ? 'checked' : ''}> Hairpins shape velocities too</label>`
      + `<label class="svd-row">Hairpin keys <select id="svdKeys"><option value="sibelius" ${prefs.keys !== 'alt' ? 'selected' : ''}>H / Shift+H with notes selected (Sibelius)</option><option value="alt" ${prefs.keys === 'alt' ? 'selected' : ''}>Alt+H / Alt+Shift+H (H stays harmony)</option></select></label>`
      + '<div class="svd-foot"><div class="svd-actions"><button class="btn" id="svdStop" disabled>Stop</button><button class="btn" id="svdPreview">Preview</button>'
      + '<button class="btn svd-render" id="svdRender">Render</button><button class="btn" id="svdClose">Close</button></div>'
      + '<div class="svd-progress" id="svdProg" hidden><div></div></div><div class="svd-status" id="svdStatus"></div></div>';
    wirePal(panel, () => q('svdType'));
    const why = !cb ? 'Where is the clip in the arrangement? Use Score mode or ⟳ Read arrangement first.' : playing ? 'Stop playback first.' : '';
    if (why) report(why, true);
    if (run) setRunning(true);
  }
  function refreshPanel() { if (!panel.classList.contains('hidden') && !run) showPanel(); }

  const palHtml = () => '<div class="svd-pal">' + PALETTE.map(t => `<button data-dyn="${t}" title="${t}">${t}</button>`).join('')
    + '<button class="svd-hp" data-dyn="<" title="crescendo hairpin">&lt;</button><button class="svd-hp" data-dyn=">" title="diminuendo hairpin">&gt;</button>'
    + '<button class="svd-hp" data-dyn="<>" title="messa di voce">&lt;&gt;</button></div>';
  function wirePal(box, input, after) {
    box.querySelectorAll('[data-dyn]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      if (enter(b.dataset.dyn) && after) after();
    }));
    const inp = input();
    if (inp) inp.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); if (enter(inp.value)) { inp.value = ''; if (after) after(); } }
      else if (e.key === 'Escape') { e.preventDefault(); if (after) after(); else close(); }
    });
  }

  function report(msg, kind) {
    const st = q('svdStatus');
    if (st) { st.textContent = msg; st.className = 'svd-status' + (kind === true || kind === 'bad' ? ' bad' : kind === 'ok' ? ' ok' : ''); }
    // the open panel shows it already (a flash there would also cover the panel's buttons)
    if ((kind === true || kind === 'bad') && (!st || panel.classList.contains('hidden'))) SV.flash(msg);
  }
  function setRunning(on, progress) {
    if (!q('svdStop')) return;
    q('svdStop').disabled = !on;
    q('svdPreview').disabled = on;
    q('svdRender').disabled = on;
    q('svdProg').hidden = !on && progress == null;
    if (progress != null) q('svdProg').firstChild.style.width = Math.round(progress * 100) + '%';
  }

  /** Preview or Render the checked staves over the bar range (mode 'preview' | 'render'). */
  async function perform(mode, opts = {}) {
    if (run) return report('Already running — Stop first', true);
    if (SV.state.playing) return report('Stop playback first: ' + (mode === 'render' ? 'Render' : 'Preview') + ' starts the transport itself.', true);
    if (!liveOrigin()) return report('Where is the clip in the arrangement? Use Score mode or ⟳ Read arrangement first.', true);
    await LP.ready;
    await fetchCurve();
    const mb = mbNow();
    const fromBar = opts.fromBar || +(q('svdFrom') && q('svdFrom').value), toBar = opts.toBar || +(q('svdTo') && q('svdTo').value);
    if (!(fromBar >= 1) || !(toBar >= fromBar)) return report('Bars: give a range like 1 to 4', true);
    const from = (fromBar - 1) * mb, to = toBar * mb;
    const tracks = (opts.tracks || performTracks().filter(n => !unchecked.has(n))).map(track => ({ track, profile: profileFor(track).profile }));
    const skipped = tracks.filter(t => !(t.profile.targets || []).length).map(t => t.track);
    const curves = buildCurves(doc, tracks, from, to, prefs);
    if (!curves.length) return report(tracks.length ? `No library controls for ${skipped.join(', ')} (velocity only): choose a profile next to the staff.` : 'Tick a staff with dynamics first.', true);
    const playable = new Set(curves.map(c => c.track));
    if (playable.size > 8) return report('At most 8 staves at a time', true);
    const before = curveStatus ? curveStatus.run : undefined; // the extension counts runs: wait for ours, not the last one's status
    SV.send(curveOps(curves, mode, from, to));
    run = { mode, before, sent: Date.now() };
    setRunning(true, 0);
    const exp = curves.some(c => c.kind === 'cc') ? ' · MIDI CC is sent live only (experimental: not recorded)' : '';
    report(`${mode === 'render' ? 'Rendering' : 'Previewing'} bars ${fromBar}–${toBar}: ${[...playable].join(', ')}${skipped.length ? ` (velocity only: ${skipped.join(', ')})` : ''}${exp}`);
    return poll();
  }
  function poll() {
    return new Promise(resolve => {
      const tick = async () => {
        const st = await fetchCurve();
        if (!run) return resolve(st);
        if (st && run.before != null && st.run === run.before) { // the extension has not taken our ops yet
          if (Date.now() - run.sent < 6000) { run.timer = setTimeout(tick, 200); return; }
          run = null;
          setRunning(false, null);
          report('No answer from the extension: is Score View on in Bitwig?', 'bad');
          return resolve(st);
        }
        const active = st && (st.state === 'preparing' || st.state === 'running');
        if (st && active) {
          setRunning(true, st.progress || 0);
          report(inBars(st.message || ''));
          run.timer = setTimeout(tick, 200);
          return;
        }
        const ok = st && st.state === 'done';
        run = null;
        setRunning(false, ok ? 1 : null);
        report(st ? inBars(st.message) : 'No answer from the extension', ok ? 'ok' : st && st.state === 'stopped' ? '' : 'bad');
        resolve(st);
      };
      run.timer = setTimeout(tick, 150);
    });
  }
  function stop() { SV.send(['curveStop']); }
  /** 'beats 0–16' / 'beat 7.5' in the extension's messages -> bars (1-based). */
  function inBars(msg) {
    const mb = mbNow(), bar = b => Math.floor(b / mb + 1e-6) + 1;
    return String(msg).replace(/beats (\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)/g, (m, a, z) => `bars ${bar(+a)}–${Math.max(bar(+a), Math.ceil(+z / mb - 1e-6))}`)
      .replace(/\bbeat (\d+(?:\.\d+)?)/g, (m, b) => barBeat(+b));
  }

  function open() {
    panel.classList.remove('hidden');
    showPanel();
    Promise.all([LP.ready, fetchCurve()]).then(() => refreshPanel());
  }
  function close() {
    panel.classList.add('hidden');
    const m = $('main'); if (m) m.focus();
  }
  group.querySelector('#svdBtn').addEventListener('click', e => { if (panel.classList.contains('hidden')) open(); else close(); e.stopPropagation(); });
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); e.preventDefault(); } e.stopPropagation(); });
  panel.addEventListener('click', e => {
    e.stopPropagation();
    const del = e.target.closest('[data-del]');
    if (del) { removeIds(doc, [del.dataset.del]); saveDoc(); SV.requestRender(); showPanel(); return; }
    const id = e.target.id;
    if (id === 'svdClose') close();
    else if (id === 'svdPreview') perform('preview');
    else if (id === 'svdRender') perform('render');
    else if (id === 'svdStop') stop();
  });
  panel.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.track) { if (t.checked) unchecked.delete(t.dataset.track); else unchecked.add(t.dataset.track); return; }
    if (t.dataset.profile != null && t.tagName === 'SELECT') {
      if (t.value) prefs.profiles[t.dataset.profile] = t.value; else delete prefs.profiles[t.dataset.profile];
      savePrefs(); return;
    }
    switch (t.id) {
      case 'svdShape': prefs.shape = t.value; q('svdShapeBlurb').textContent = (SHAPES.find(s => s.id === t.value) || SHAPES[0]).blurb + '. Click a hairpin in the score to give it its own shape.'; break;
      case 'svdStrength': prefs.strength = +t.value; break;
      case 'svdVar': prefs.variation = t.checked; q('svdAmount').disabled = !t.checked; break;
      case 'svdAmount': prefs.amount = +t.value; break;
      case 'svdVelMarks': prefs.velMarks = t.checked; break;
      case 'svdVelHairpins': prefs.velHairpins = t.checked; break;
      case 'svdKeys': prefs.keys = t.value; SV.flash('Hairpin keys change after a reload (F5)'); break;
      default: return;
    }
    savePrefs();
  });
  document.addEventListener('mousedown', e => { if (!group.contains(e.target) && !panel.classList.contains('hidden') && !run) close(); });

  // ---- popovers: Ctrl+E entry, and a click on a mark / hairpin in the score
  let pop = null;
  function closePop() { if (pop) { pop.remove(); pop = null; const m = $('main'); if (m) m.focus(); } }
  function placePop(el, x, y) {
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x)) + 'px';
    el.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y)) + 'px';
  }
  function openEntryPop() {
    closePop();
    const sel = [...document.querySelectorAll('#paper g.note.sel, #paper g.note.selected')];
    const rr = sel.length ? SV.geom.rect(sel[0]) : null;
    pop = document.createElement('div');
    pop.className = 'svd-pop';
    pop.id = 'svdPop';
    pop.innerHTML = '<div class="svd-h">Dynamics</div>' + palHtml() + '<input class="svd-type" id="svdPopType" placeholder="p<f · mf · <> · sfz" spellcheck="false">'
      + '<div class="svd-actions"><button class="btn" id="svdPopClear" title="Remove the dynamics over the selected notes">Clear</button><button class="btn" id="svdPopOk">OK</button></div>';
    placePop(pop, rr ? rr.left : 200, rr ? rr.bottom + 28 : 160);
    pop.addEventListener('mousedown', e => e.stopPropagation());
    wirePal(pop, () => pop.querySelector('#svdPopType'), closePop);
    pop.querySelector('#svdPopOk').addEventListener('click', () => { const v = pop.querySelector('#svdPopType').value; if (!v.trim() || enter(v)) closePop(); });
    pop.querySelector('#svdPopClear').addEventListener('click', () => { clearSelection(); closePop(); });
    pop.querySelector('#svdPopType').focus();
  }
  function clearSelection() {
    const span = selectionSpan();
    if (span.error) return SV.flash(span.error);
    // up to the selection's end, not the next note's dynamic that a hairpin end may touch
    const n = removeRange(doc, span.track, span.start, span.end - 2 * EPS);
    saveDoc(); SV.requestRender(); refreshPanel();
    SV.flash(n ? `Removed ${n} dynamic${n > 1 ? 's' : ''}` : 'No dynamics over the selection');
  }
  function openItemPop(id, x, y) {
    closePop();
    const f = findItem(doc, id);
    if (!f) return;
    pop = document.createElement('div');
    pop.className = 'svd-pop';
    pop.id = 'svdItemPop';
    if (f.kind === 'hairpin') {
      const h = f.item;
      pop.innerHTML = `<div class="svd-h">${h.shape === 'messa' ? 'Messa di voce' : h.form === 'dim' ? 'Diminuendo' : 'Crescendo'} · ${esc(f.track)}</div>`
        + `<label class="svd-row">Shape <select id="svdItemShape"><option value="">Default (${esc(shapeName(prefs.shape))})</option>${SHAPES.map(s => `<option value="${s.id}" ${s.id === h.shape ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`
        + `<label class="svd-row">Strength <input type="range" id="svdItemStrength" min="0" max="1" step="0.05" value="${h.strength != null ? h.strength : prefs.strength}"></label>`
        + `<label class="svd-check"><input type="checkbox" id="svdItemOwn" ${h.strength != null ? 'checked' : ''}> Own strength (else the default)</label>`
        + '<div class="svd-actions"><button class="btn" id="svdItemDel">Delete</button><button class="btn" id="svdItemOk">OK</button></div>';
    } else {
      pop.innerHTML = `<div class="svd-h">Dynamic · ${esc(f.track)}</div><input class="svd-type" id="svdItemText" value="${esc(f.item.text)}" spellcheck="false">`
        + '<div class="svd-actions"><button class="btn" id="svdItemDel">Delete</button><button class="btn" id="svdItemOk">OK</button></div>';
    }
    placePop(pop, x + 8, y + 12);
    pop.addEventListener('mousedown', e => e.stopPropagation());
    pop.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closePop(); if (e.key === 'Enter') pop.querySelector('#svdItemOk').click(); });
    pop.querySelector('#svdItemDel').addEventListener('click', () => { removeIds(doc, [id]); saveDoc(); SV.requestRender(); refreshPanel(); closePop(); });
    pop.querySelector('#svdItemOk').addEventListener('click', () => {
      if (f.kind === 'hairpin') {
        const sh = pop.querySelector('#svdItemShape').value;
        if (sh) f.item.shape = sh; else delete f.item.shape;
        if (pop.querySelector('#svdItemOwn').checked) f.item.strength = +pop.querySelector('#svdItemStrength').value; else delete f.item.strength;
      } else {
        const v = pop.querySelector('#svdItemText').value.trim().toLowerCase();
        if (!MARK_NAMES.includes(v)) { SV.flash('Unknown dynamic "' + v + '"'); return; }
        f.item.text = v;
      }
      saveDoc(); SV.requestRender(); refreshPanel(); closePop();
    });
    pop.querySelector('#svdItemStrength') && pop.querySelector('#svdItemStrength').addEventListener('input', () => { pop.querySelector('#svdItemOwn').checked = true; });
    const first = pop.querySelector('select, input'); if (first) first.focus();
  }
  // (the press that opened an item's popover bubbles here too: it must not close it again)
  document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && !itemIdOf(e.target)) closePop(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) closePop(); }, true);

  SV.addHelp('<b>Dynamics ▾</b> select notes · <kbd>H</kbd> / <kbd>Shift</kbd>+<kbd>H</kbd> hairpin · <kbd>Ctrl</kbd>+<kbd>E</kbd> type <i>p</i>, <i>mf</i>, <i>p&lt;f</i> · Render records the library\'s controls as Bitwig automation');

  SV.dynamics = Object.assign({}, pure, {
    prefs, savePrefs, doc: () => doc, setDoc(d) { doc = normalizeDoc(d); saveDoc(); SV.requestRender(); refreshPanel(); },
    reload: loadDoc, enter, liveOrigin, selectionSpan, profileFor, perform, stop, open, close, curveStatus: () => curveStatus,
    openEntryPop, closePop,
  });
})(typeof window !== 'undefined' ? window : globalThis);
