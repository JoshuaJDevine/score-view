// Feature module: harmony — the user's Functional Color Theory, live in the score.
// See docs/functional-color-theory.md (the user's system) and docs/harmony.md (this implementation).
//
// Pure engine (also usable from Node: require('web/features/harmony.js')):
//   analyzeFull(score, opts) -> { regions, events, keys, notes: Map(id -> info), home, ... }
//   decorate(score, analysis, settings) -> score with note colours and the Roman-numeral ribbon
// Browser UI (when window.SV exists): Colors menu, H / Shift+H, overlays, aim assist, window.SV.harmony.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ the user's colour system

  const FUNCS = {
    tonic:       { colour: 'red',    state: 'Rest',             say: "We're home",                         more: 'This is where we belong · Everything is okay' },
    subdominant: { colour: 'yellow', state: 'Motion',           say: "We're going somewhere",              more: 'Something is happening · The story continues' },
    dominant:    { colour: 'blue',   state: 'Tension',          say: "We can't stay here",                 more: 'This needs to go somewhere · Something must happen' },
    supertonic:  { colour: 'green',  state: 'Motion + Tension', say: "We're moving but we need guidance",  more: 'Searching for the next step · Wandering' },
    mediant:     { colour: 'purple', state: 'Rest + Tension',   say: "We're comfortable but something isn't quite right", more: 'Mixed feelings' },
    submediant:  { colour: 'orange', state: 'Rest + Motion',    say: "We're leaving home but it feels good", more: 'Comfortable journey · Longing (deceptive)' },
  };
  // Noteheads/text need strong hues on the cream paper (#fbfaf6); bands use the same hues, translucent.
  const PALETTE = {
    red: '#d4213d', yellow: '#d39e00', blue: '#1d5bd6', green: '#22963a', purple: '#8a3cc8', orange: '#f07206',
    cyan: '#00acc8', magenta: '#e0168c', grey: '#a2a2a2',
  };
  // Band tints (translucent over the cream paper), tuned so red/magenta and yellow/orange stay apart.
  const BAND = { red: ['#e8402a', 0.15], yellow: ['#ffc800', 0.27], blue: ['#2f6fe0', 0.14], green: ['#2fa84f', 0.15],
                 purple: ['#8d4fd6', 0.14], orange: ['#ff8a00', 0.19], cyan: ['#00b8d4', 0.19], magenta: ['#e0168c', 0.12] };

  const DEFAULTS = {
    enabled: false, mode: 'both', ribbon: true, marks: true, snap: false,
    sharpColour: 'cyan', flatColour: 'magenta', // "bright Cyan/Magenta" — see docs/harmony.md (swappable)
  };

  // ------------------------------------------------------------------ pitch helpers

  const mod12 = x => ((x % 12) + 12) % 12;
  const norm = x => mod12(x + 6) - 6; // -6..5
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
  const scaleOf = mode => mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
  const maskOf = pcs => pcs.reduce((m, p) => m | (1 << mod12(p)), 0);
  // Diatonic collection used for "borrowed" tests: minor includes raised 6 and 7 (melodic/harmonic minor).
  const keyMask = k => maskOf((k.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 9, 10, 11] : MAJOR_SCALE).map(i => i + k.tonic));
  const pcToFifths = pc => mod12(pc * 7 + 6) - 6;                   // major tonic -> key signature (-6..5)
  const keyFifths = k => pcToFifths(k.mode === 'minor' ? k.tonic + 3 : k.tonic);
  const MAJ_NAMES = ['G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯'];
  const MIN_NAMES = ['e♭', 'b♭', 'f', 'c', 'g', 'd', 'a', 'e', 'b', 'f♯', 'c♯', 'g♯', 'd♯'];
  const keyLabel = k => (k.mode === 'minor' ? MIN_NAMES : MAJ_NAMES)[keyFifths(k) + 6];
  const keyLong = k => { const n = keyLabel(k); return n[0].toUpperCase() + n.slice(1) + (k.mode === 'minor' ? ' minor' : ' major'); };
  const LETTERS = 'CDEFGAB', LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
  const sameKey = (a, b) => a && b && a.tonic === b.tonic && a.mode === b.mode;

  // ------------------------------------------------------------------ chord vocabulary
  // roles: r root, 3 third, 5 fifth, 7 seventh, x added/suspended tone. steps = generic scale steps above the root.
  const TEMPLATES = [
    { q: 'maj',    iv: [0, 4, 7],     st: [0, 2, 4],    ro: 'r35',  prior: 0 },
    { q: 'min',    iv: [0, 3, 7],     st: [0, 2, 4],    ro: 'r35',  prior: 0 },
    { q: 'dim',    iv: [0, 3, 6],     st: [0, 2, 4],    ro: 'r35',  prior: -0.03 },
    { q: 'aug',    iv: [0, 4, 8],     st: [0, 2, 4],    ro: 'r35',  prior: -0.07 },
    { q: 'pow',    iv: [0, 7],        st: [0, 4],       ro: 'r5',   prior: -0.03 },
    { q: 'sus4',   iv: [0, 5, 7],     st: [0, 3, 4],    ro: 'rx5',  prior: -0.06 },
    { q: 'sus2',   iv: [0, 2, 7],     st: [0, 1, 4],    ro: 'rx5',  prior: -0.08 },
    { q: 'dom7',   iv: [0, 4, 7, 10], st: [0, 2, 4, 6], ro: 'r357', prior: -0.03 },
    { q: 'maj7',   iv: [0, 4, 7, 11], st: [0, 2, 4, 6], ro: 'r357', prior: -0.045 },
    { q: 'min7',   iv: [0, 3, 7, 10], st: [0, 2, 4, 6], ro: 'r357', prior: -0.035 },
    { q: 'hdim7',  iv: [0, 3, 6, 10], st: [0, 2, 4, 6], ro: 'r357', prior: -0.04 },
    { q: 'dim7',   iv: [0, 3, 6, 9],  st: [0, 2, 4, 6], ro: 'r357', prior: -0.04 },
    { q: 'mmaj7',  iv: [0, 3, 7, 11], st: [0, 2, 4, 6], ro: 'r357', prior: -0.1 },
    { q: '7sus4',  iv: [0, 5, 7, 10], st: [0, 3, 4, 6], ro: 'rx57', prior: -0.08 },
    { q: 'add6',   iv: [0, 4, 7, 9],  st: [0, 2, 4, 5], ro: 'r35x', prior: -0.065 },
    { q: 'madd6',  iv: [0, 3, 7, 9],  st: [0, 2, 4, 5], ro: 'r35x', prior: -0.075 },
    { q: 'add9',   iv: [0, 4, 7, 2],  st: [0, 2, 4, 1], ro: 'r35x', prior: -0.07 },
    { q: 'madd9',  iv: [0, 3, 7, 2],  st: [0, 2, 4, 1], ro: 'r35x', prior: -0.08 },
    { q: '7b5',    iv: [0, 4, 6, 10], st: [0, 2, 4, 6], ro: 'r357', prior: -0.09 }, // French sixth sonority
  ];
  const TQ = Object.fromEntries(TEMPLATES.map(t => [t.q, t]));
  const MISS = { r: 0.2, 3: 0.14, 5: 0.04, 7: 0.12, x: 0.13 };
  const THIRD = { maj: 'M', aug: 'M', dom7: 'M', maj7: 'M', add6: 'M', add9: 'M', '7b5': 'M',
                  min: 'm', min7: 'm', mmaj7: 'm', madd6: 'm', madd9: 'm', dim: 'd', hdim7: 'd', dim7: 'd',
                  pow: '?', sus4: 's', sus2: 's', '7sus4': 's' };
  const isSeventh = q => /7/.test(q);
  const DIM_FAMILY = q => q === 'dim' || q === 'hdim7' || q === 'dim7';
  const DOM_TYPE = q => q === 'maj' || q === 'dom7' || q === '7b5';

  const CANDS = []; // every (root, template) pair, precomputed
  for (let r = 0; r < 12; r++) TEMPLATES.forEach(t => {
    CANDS.push({ root: r, t, pcs: t.iv.map(i => mod12(r + i)), mask: maskOf(t.iv.map(i => r + i)) });
  });

  // ------------------------------------------------------------------ key profiles (Temperley-style)
  const PROF = {
    major: [5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4],
    minor: [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4],
  };
  const KEYS = [];
  for (let t = 0; t < 12; t++) ['major', 'minor'].forEach(mode => KEYS.push({ tonic: t, mode }));
  KEYS.forEach(k => { k.mask = keyMask(k); k.fifths = keyFifths(k); });
  const keyIndex = k => k.tonic * 2 + (k.mode === 'minor' ? 1 : 0);

  function corr(hist, prof, tonic) {
    let mx = 0, my = 0;
    for (let i = 0; i < 12; i++) { mx += hist[i]; my += prof[i]; }
    mx /= 12; my /= 12;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) {
      const x = hist[(i + tonic) % 12] - mx, y = prof[i] - my;
      num += x * y; dx += x * x; dy += y * y;
    }
    return dx ? num / Math.sqrt(dx * dy) : 0;
  }

  // ------------------------------------------------------------------ analysis

  const PERC = /c+ussion|drum|kit\b|snare|cymb|hi-?hat|gong|tam-?tam|clap|shaker|tambourine/i;
  const EPS = 1e-6;

  function collectNotes(score) {
    const notes = [];
    score.parts.forEach((p, pi) => {
      if (PERC.test(p.name || '')) return;
      p.notes.forEach(n => { if (n.pitch >= 24 && n.dur > 0) notes.push({ id: n.id, part: pi, start: n.start, dur: n.dur, pitch: n.pitch }); });
    });
    return notes;
  }

  function contentHash(score, opts) {
    let h = 0, c = 0;
    score.parts.forEach(p => {
      h = (h * 31 + (p.name || '').length) | 0;
      p.notes.forEach(n => { c++; h = (h * 31 + Math.round(n.start * 96) * 7 + n.pitch * 131 + Math.round(n.dur * 96)) | 0; });
    });
    return [h, c, score.keyFifths, score.timeSig.num, score.timeSig.den, score.measureOffset || 0, score.lengthBeats || 0, JSON.stringify(opts || {})].join(':');
  }

  const cacheById = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  let lastCache = null;

  /** Full analysis of a score ({timeSig, keyFifths|null, parts, lengthBeats, measureOffset}). Cached. */
  function analyzeFull(score, opts) {
    if (!score || !score.parts) return null;
    const plain = !opts || !Object.keys(opts).length;
    if (plain && cacheById && cacheById.has(score)) return cacheById.get(score);
    const hash = contentHash(score, opts);
    if (lastCache && lastCache.hash === hash) { if (plain && cacheById) cacheById.set(score, lastCache.an); return lastCache.an; }
    const an = runAnalysis(score, opts || {});
    lastCache = { hash, an };
    if (plain && cacheById) cacheById.set(score, an);
    return an;
  }

  function runAnalysis(score, opts) {
    const t0 = now();
    const ts = score.timeSig || { num: 4, den: 4 };
    const mb = ts.num * 4 / ts.den;
    const compound = ts.den === 8 && ts.num % 3 === 0 && ts.num > 3;
    const slot = compound ? 1.5 : ts.den >= 8 ? 0.5 : 1;
    const perBar = Math.max(1, Math.round(mb / slot));
    const notes = collectNotes(score);
    const offsetBeats = (score.measureOffset || 0) * mb;
    let endBeat = score.lengthBeats || 0;
    notes.forEach(n => { if (n.start + n.dur > endBeat) endBeat = n.start + n.dur; });
    const nBars = Math.max(1, Math.ceil(endBeat / mb - 1e-6));
    const S = nBars * perBar;

    // Per-slot pitch-class weights: duration x attack x metric position; plus the bass line.
    const vec = new Float64Array(S * 12);
    const lowest = new Int16Array(S).fill(999);
    const lowCover = new Float64Array(S);
    notes.forEach(n => {
      const s0 = Math.max(0, Math.floor(n.start / slot + EPS)), e = n.start + n.dur;
      const pos = n.start - Math.floor(n.start / mb + EPS) * mb; // position in bar
      const metric = Math.abs(pos) < 0.05 ? 1.3 : Math.abs(pos - mb / 2) < 0.05 ? 1.15 : Math.abs(pos / slot - Math.round(pos / slot)) < 0.05 ? 1 : 0.8;
      const pc = mod12(n.pitch);
      for (let s = s0; s < S && s * slot < e - EPS; s++) {
        const ov = Math.min(e, (s + 1) * slot) - Math.max(n.start, s * slot);
        if (ov <= 0) continue;
        vec[s * 12 + pc] += ov / slot * (s === s0 ? metric : 0.6);
        if (ov >= slot * 0.25 - EPS && (n.pitch < lowest[s])) { lowest[s] = n.pitch; lowCover[s] = ov; }
      }
    });
    const bassPc = new Int8Array(S).fill(-1);
    for (let s = 0; s < S; s++) if (lowest[s] < 999) { bassPc[s] = mod12(lowest[s]); vec[s * 12 + bassPc[s]] += 0.35; }

    // Prefix sums for O(1) segment vectors.
    const P = new Float64Array((S + 1) * 12), PB = new Float64Array((S + 1) * 12), PT = new Float64Array(S + 1), PN = new Float64Array(S + 1);
    for (let s = 0; s < S; s++) {
      let tot = 0;
      for (let i = 0; i < 12; i++) { const v = vec[s * 12 + i]; P[(s + 1) * 12 + i] = P[s * 12 + i] + v; tot += v; PB[(s + 1) * 12 + i] = PB[s * 12 + i]; }
      if (bassPc[s] >= 0) PB[(s + 1) * 12 + bassPc[s]] += 1;
      PT[s + 1] = PT[s] + tot;
      PN[s + 1] = PN[s] + (tot > 0.05 ? 1 : 0);
    }

    // ---- keys: windowed key finding per bar + Viterbi smoothing, biased to the home key.
    const home = homeKey(score, notes, vec, S);
    // Tonic evidence: the bass on strong beats (bar start, half bar) — separates relative/modal keys.
    // Mode evidence: the third above that strong-beat bass (C-E-G says major even next to a ♭VI).
    const strongBass = new Float64Array(nBars * 12), thirds = new Float64Array(nBars * 24);
    for (let s = 0; s < S; s++) {
      const pos = s % perBar, b = bassPc[s];
      if (b < 0 || !(pos === 0 || pos * 2 === perBar)) continue;
      const bar = Math.floor(s / perBar), w = pos ? 0.5 : 1;
      strongBass[bar * 12 + b] += w;
      thirds[bar * 24 + b * 2] += w * vec[s * 12 + mod12(b + 4)];
      thirds[bar * 24 + b * 2 + 1] += w * vec[s * 12 + mod12(b + 3)];
    }
    const barKeys = trackKeys(P, nBars, perBar, home, opts, strongBass, thirds);

    // ---- harmonic rhythm: best segmentation into chords (dynamic programming over slots).
    const v = new Float64Array(12), b = new Float64Array(12);
    const segCache = new Map();
    const evalSeg = (s, e) => {
      const k = s * 4096 + e;
      if (segCache.has(k)) return segCache.get(k);
      let tot = PT[e] - PT[s], btot = 0;
      for (let i = 0; i < 12; i++) { v[i] = P[e * 12 + i] - P[s * 12 + i]; b[i] = PB[e * 12 + i] - PB[s * 12 + i]; btot += b[i]; }
      const res = tot < 0.05 ? null : bestChord(v, tot, b, btot, barKeys[Math.floor(s / perBar)]);
      segCache.set(k, res);
      return res;
    };
    const LAMBDA = 0.42, maxL = Math.min(2 * perBar, 16);
    const best = new Float64Array(S + 1).fill(-Infinity), from = new Int32Array(S + 1);
    best[0] = 0;
    for (let e = 1; e <= S; e++) {
      for (let L = 1; L <= maxL && e - L >= 0; L++) {
        const s = e - L, bs = Math.floor(s / perBar), be = Math.floor((e - 1) / perBar);
        let align = 0;
        if (bs !== be) { if (s % perBar || L % perBar) continue; }
        else if (s % perBar && (s % perBar) * 2 !== perBar) align = 0.06;
        const r = evalSeg(s, e);
        const nonEmpty = PN[e] - PN[s];
        const g = r ? (nonEmpty + 0.2 * (L - nonEmpty)) * r.score - LAMBDA - align : -0.05 * L;
        if (best[s] + g > best[e]) { best[e] = best[s] + g; from[e] = s; }
      }
    }
    const segs = [];
    for (let e = S; e > 0; e = from[e]) segs.push({ s: from[e], e });
    segs.reverse();

    // ---- merge identical neighbours (and V-V7, Vsus4-V, power chord + triad on the same root).
    const merged = [];
    segs.forEach(sg => {
      const c = evalSeg(sg.s, sg.e);
      const key = barKeys[Math.floor(sg.s / perBar)];
      const prev = merged[merged.length - 1];
      if (prev && compatible(prev, c) && sameKey(prev.key, key)) {
        prev.e = sg.e;
        if (c) prev.c = mergeChord(prev.c, c);
        return;
      }
      merged.push({ s: sg.s, e: sg.e, c, key });
    });

    // ---- regions with spelling, Roman numerals, function and colour.
    const regions = merged.map(m => {
      const start = m.s * slot, end = Math.min(m.e * slot, Math.max(endBeat, m.s * slot + slot));
      let bass = -1;
      for (let s = m.s; s < m.e && bass < 0; s++) bass = bassPc[s];
      const reg = { start, end, s: m.s, e: m.e, key: m.key, bassPc: bass, root: null, quality: null, confidence: 0 };
      if (m.c) {
        let tot = PT[m.e] - PT[m.s], cov = 0;
        for (let i = 0; i < 12; i++) v[i] = P[m.e * 12 + i] - P[m.s * 12 + i];
        TQ[m.c.q].iv.forEach(i => { cov += v[mod12(m.c.root + i)]; });
        reg.root = m.c.root; reg.quality = m.c.q; reg.confidence = tot ? cov / tot : 0;
        reg.vec = Array.from(v); reg.tot = tot;
        reg.distinct = v.reduce((n, x) => n + (x > tot * 0.06 ? 1 : 0), 0);
      }
      return reg;
    });
    const sounding = regions.filter(r => r.root != null);
    sounding.forEach((r, i) => classify(r, sounding[i - 1], sounding[i + 1]));
    regions.forEach(r => finishRegion(r, offsetBeats));
    const events = findEvents(sounding, home, endBeat, offsetBeats);

    // ---- every note: chord tone / non-chord tone, borrowed tones, colour.
    const noteInfo = classifyNotes(notes, regions, slot);

    const keys = [];
    barKeys.forEach((k, i) => {
      if (!keys.length || !sameKey(keys[keys.length - 1].key, k)) keys.push({ start: i * mb + offsetBeats, key: k, name: keyLong(k), fifths: k.fifths });
    });
    return { regions, events, keys, notes: noteInfo, home, homeName: keyLong(home), measureBeats: mb, slot, offsetBeats,
             lengthBeats: endBeat, ms: now() - t0 };
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function compatible(a, c) {
    if (!a.c || !c) return !a.c && !c;
    if (a.c.root !== c.root) return false;
    const ta = THIRD[a.c.q], tc = THIRD[c.q];
    return ta === tc || ta === '?' || tc === '?' || ta === 's' || tc === 's';
  }
  // Keeps the more specific quality (a 7th, a real third) when merging.
  function mergeChord(a, c) {
    const rank = q => (THIRD[q] === '?' ? 0 : THIRD[q] === 's' ? 1 : 2) + (isSeventh(q) ? 1 : 0);
    return rank(c.q) > rank(a.q) ? c : a;
  }

  function homeKey(score, notes, vec, S) {
    const hist = new Array(12).fill(0);
    notes.forEach(n => { hist[mod12(n.pitch)] += Math.max(n.dur, 0.05); });
    let fifths = score.keyFifths;
    if (fifths == null) {
      const SB = root.ScoreBuilder;
      if (SB && SB.detectFifths) fifths = SB.detectFifths([].concat(...score.parts.map(p => p.notes)));
    }
    if (fifths == null) {
      let bestK = KEYS[0], br = -2;
      KEYS.forEach(k => { const r = corr(hist, PROF[k.mode], k.tonic); if (r > br) { br = r; bestK = k; } });
      return { tonic: bestK.tonic, mode: bestK.mode, mask: bestK.mask, fifths: bestK.fifths };
    }
    const maj = KEYS[keyIndex({ tonic: mod12(fifths * 7), mode: 'major' })];
    const min = KEYS[keyIndex({ tonic: mod12(fifths * 7 + 9), mode: 'minor' })];
    // Relative major or minor: profile fit plus the final bass note (pieces usually end on the tonic).
    let rM = corr(hist, PROF.major, maj.tonic), rm = corr(hist, PROF.minor, min.tonic);
    for (let s = S - 1; s >= 0; s--) {
      let tot = 0, bi = 0, bv = 0;
      for (let i = 0; i < 12; i++) { tot += vec[s * 12 + i]; if (vec[s * 12 + i] > bv) { bv = vec[s * 12 + i]; bi = i; } }
      if (tot > 0.05) { if (bi === maj.tonic) rM += 0.05; if (bi === min.tonic) rm += 0.05; break; }
    }
    return rm > rM ? min : maj;
  }

  function trackKeys(P, nBars, perBar, home, opts, strongBass, thirds) {
    const R = opts.keyWindow || 5;
    const W = Array.from({ length: 2 * R + 1 }, (_, i) => 1 - Math.abs(i - R) / (R + 1));
    const TONIC = opts.tonicEvidence != null ? opts.tonicEvidence : 2.5;
    const bh = new Float64Array(12), th = new Float64Array(24);
    const THIRDW = opts.thirdEvidence != null ? opts.thirdEvidence : 1;
    const MODAL = opts.modalPenalty != null ? opts.modalPenalty : 0.12;
    const E = opts.keyEmission || 4, HOME = opts.homeBonus != null ? opts.homeBonus : 0.35;
    const em = [];
    const h = new Array(12);
    for (let m = 0; m < nBars; m++) {
      h.fill(0); bh.fill(0); th.fill(0);
      let tot = 0, btot = 0;
      for (let d = -R; d <= R; d++) {
        const mm = m + d;
        if (mm < 0 || mm >= nBars) continue;
        const s = mm * perBar, e = (mm + 1) * perBar;
        for (let i = 0; i < 12; i++) {
          const x = (P[e * 12 + i] - P[s * 12 + i]) * W[d + R]; h[i] += x; tot += x;
          const y = strongBass[mm * 12 + i] * W[d + R]; bh[i] += y; btot += y;
          th[i * 2] += thirds[mm * 24 + i * 2] * W[d + R]; th[i * 2 + 1] += thirds[mm * 24 + i * 2 + 1] * W[d + R];
        }
      }
      // Fit of each pitch collection (key signature); a key also explains its modal neighbours
      // (Lydian/Mixolydian, Dorian/Phrygian) at a small cost, so the tonic is decided by tonic evidence.
      const coll = new Float64Array(12);
      if (tot > 0.1) for (let f = -6; f < 6; f++) {
        const t = mod12(f * 7);
        coll[f + 6] = Math.max(corr(h, PROF.major, t), corr(h, PROF.minor, t + 9));
      }
      const fit = f => coll[mod12(f + 6)];
      const modeEvidence = k => {
        const M = th[k.tonic * 2], m = th[k.tonic * 2 + 1];
        return M + m > 0.05 ? THIRDW * (k.mode === 'major' ? M - m : m - M) / (M + m) : 0;
      };
      em.push(KEYS.map(k => (tot > 0.1 ? E * Math.max(fit(k.fifths), Math.max(fit(k.fifths + 1), fit(k.fifths - 1)) - MODAL) +
                                         E * 0.5 * corr(h, PROF[k.mode], k.tonic) : 0) +
        (btot ? TONIC * bh[k.tonic] / btot : 0) + (sameKey(k, home) ? HOME : 0) + modeEvidence(k)));
    }
    const trans = (a, b) => {
      if (a === b) return 0;
      const ka = KEYS[a], kb = KEYS[b];
      if (ka.fifths === kb.fifths) return opts.relCost || 3.5;                 // relative major/minor
      if (ka.tonic === kb.tonic) return opts.parCost || 3.5;                   // parallel
      const df = Math.abs(norm(ka.fifths - kb.fifths));
      return 2.1 + 0.25 * df;
    };
    const N = KEYS.length;
    let score = em[0].slice();
    const back = [];
    for (let m = 1; m < nBars; m++) {
      const next = new Array(N), bk = new Int16Array(N);
      for (let k = 0; k < N; k++) {
        let bv = -Infinity, bi = 0;
        for (let j = 0; j < N; j++) { const x = score[j] - trans(j, k); if (x > bv) { bv = x; bi = j; } }
        next[k] = bv + em[m][k]; bk[k] = bi;
      }
      back.push(bk); score = next;
    }
    let k = 0;
    for (let i = 1; i < N; i++) if (score[i] > score[k]) k = i;
    const path = new Array(nBars);
    path[nBars - 1] = k;
    for (let m = nBars - 1; m > 0; m--) { k = back[m - 1][k]; path[m - 1] = k; }
    return path.map(i => KEYS[i]);
  }

  function bestChord(v, tot, b, btot, key) {
    let best = null;
    const thr = tot * 0.06;
    for (let ci = 0; ci < CANDS.length; ci++) {
      const c = CANDS[ci];
      if (v[c.root] < thr && b[c.root] === 0) continue;
      let cov = 0, miss = 0;
      const pcs = c.pcs, ro = c.t.ro;
      for (let i = 0; i < pcs.length; i++) {
        const x = v[pcs[i]];
        cov += x;
        if (x < thr) miss += MISS[ro[i]];
      }
      let sc = (2 * cov - tot) / tot - miss + c.t.prior;
      if (btot) sc += 0.15 * b[c.root] / btot + 0.04 * pcs.reduce((s, p) => s + b[p], 0) / btot;
      if (key) {
        if ((c.mask & ~key.mask) === 0) sc += 0.06;
        else if ((c.t.q === 'maj' || c.t.q === 'dom7') && (key.mask >> mod12(c.root + 5)) & 1) sc += 0.02;
      }
      if (!best || sc > best.score) best = { root: c.root, q: c.t.q, score: sc };
    }
    return best;
  }

  // ---- spelling relative to the local key

  function spellRoot(semis, q, mode, next) {
    const sc = scaleOf(mode);
    let cands = [];
    for (let d = 0; d < 7; d++) { const a = norm(semis - sc[d]); if (Math.abs(a) <= 1) cands.push({ deg: d, alt: a }); }
    cands.sort((x, y) => Math.abs(x.alt) - Math.abs(y.alt));
    if (cands.length > 1 && Math.abs(cands[0].alt) === Math.abs(cands[1].alt)) {
      // Tie (a chromatic root): sharp-side when it leads somewhere by step/fifth like an applied chord.
      const target = DIM_FAMILY(q) ? mod12(semis + 1) : mod12(semis + 5);
      const inScale = sc.includes(target) || (mode === 'minor' && (target === 9 || target === 11));
      const wantSharp = DIM_FAMILY(q) || (DOM_TYPE(q) && inScale && ![1, 3, 8, 10].includes(semis)) ||
        (mode === 'minor' && (semis === 9 || semis === 11));              // melodic-minor degrees
      cands = cands.filter(c => wantSharp ? c.alt > 0 : c.alt < 0).concat(cands);
    }
    return cands[0];
  }

  function spellTones(r) {
    const k = r.key, t = TQ[r.quality];
    const semis = mod12(r.root - k.tonic);
    const rs = r.rootSpell;
    const sc = scaleOf(k.mode);
    return t.iv.map((iv, i) => {
      let step = t.st[i];
      if (r.aug6 && iv === 10) step = 5;                      // augmented sixth above ♭6 = ♯4
      if (r.aug6 === 'Fr' && iv === 6) step = 1;
      const deg = (rs.deg + step) % 7;
      let alt = norm(semis + iv - sc[deg]);
      if (k.mode === 'minor' && (deg === 5 || deg === 6) && alt === 1) alt = 0; // melodic/harmonic minor
      return { pc: mod12(r.root + iv), deg, alt, role: t.ro[i] };
    });
  }

  const NUM = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  function numeral(deg, alt, third, mode) {
    let n = NUM[deg];
    if (third === 'm' || third === 'd') n = n.toLowerCase();
    let pre = alt < 0 ? '♭'.repeat(-alt) : alt > 0 ? '♯'.repeat(alt) : '';
    if (mode === 'minor' && deg === 6 && alt === 1 && third === 'd') pre = ''; // vii° in minor
    return pre + n;
  }
  // Diatonic triad quality on a scale degree (for applied-chord targets and power/sus chords).
  function diatonicThird(deg, mode) {
    const sc = scaleOf(mode);
    const third = norm(sc[(deg + 2) % 7] - sc[deg]), fifth = mod12(sc[(deg + 4) % 7] - sc[deg]);
    return fifth === 6 ? 'd' : third === 4 ? 'M' : 'm';
  }

  const FUNC_MAJOR = { 0: 'tonic', 2: 'supertonic', 4: 'mediant', 5: 'subdominant', 7: 'dominant', 9: 'submediant', 11: 'dominant',
                       3: 'mediant', 8: 'submediant', 10: 'flat', 1: 'flat', 6: 'sharp' };
  const FUNC_MINOR = { 0: 'tonic', 2: 'supertonic', 3: 'mediant', 5: 'subdominant', 7: 'dominant', 8: 'submediant', 10: 'dominant',
                       11: 'dominant', 1: 'flat', 4: 'sharp', 6: 'sharp', 9: 'subdominant' }; // ♯vi° ⊂ Dorian IV⁷

  function classify(r, prev, next) {
    const k = r.key;
    // Symmetric chords: choose the root that explains the context.
    if (r.quality === 'dim7') {
      const opts = [0, 3, 6, 9].map(i => mod12(r.root + i));
      const pick = (next && opts.find(o => mod12(o + 1) === next.root)) ?? opts.find(o => mod12(o + 1) === k.tonic) ??
        opts.find(o => mod12(o + 1) === mod12(k.tonic + 7)) ?? (opts.includes(r.bassPc) ? r.bassPc : r.root);
      r.root = pick;
    }
    if (r.quality === 'aug') {
      const opts = [0, 4, 8].map(i => mod12(r.root + i));
      r.root = opts.find(o => o === k.tonic || o === mod12(k.tonic + 7) || o === mod12(k.tonic + 3)) ?? (opts.includes(r.bassPc) ? r.bassPc : r.root);
    }
    const semis = mod12(r.root - k.tonic);
    const q = r.quality, third0 = THIRD[q];
    const nextSemis = next ? mod12(next.root - k.tonic) : null;
    r.rootSpell = spellRoot(semis, q, k.mode, next);

    // Augmented sixths: dominant-seventh sonority (or French) on ♭6 that resolves to V or a cadential 6/4.
    const goesToV = next && (nextSemis === 7 || (nextSemis === 0 && mod12(next.bassPc - k.tonic) === 7));
    if (semis === 8 && (q === 'dom7' || q === '7b5') && goesToV) {
      const fifthMissing = r.vec[mod12(r.root + 7)] < r.tot * 0.06;
      r.aug6 = q === '7b5' ? 'Fr' : fifthMissing ? 'It' : 'Ger';
      r.rootSpell = { deg: 5, alt: k.mode === 'minor' ? 0 : -1 };
    }
    r.tones = spellTones(r);
    const sharp = r.tones.some(t => t.alt > 0), flat = r.tones.some(t => t.alt < 0);
    r.sharp4 = r.tones.some(t => t.deg === 3 && t.alt > 0);
    r.borrowed = sharp ? 'sharp' : flat ? 'flat' : null;
    const third = third0 === '?' || third0 === 's' ? diatonicThird(r.rootSpell.deg, k.mode) : third0;
    const rn = numeral(r.rootSpell.deg, r.rootSpell.alt, third, k.mode);
    const bassIv = r.bassPc >= 0 ? mod12(r.bassPc - r.root) : 0;
    const t = TQ[q];
    const bassRole = t.ro[t.iv.findIndex(i => mod12(i) === bassIv)] || 'r';
    r.inversion = { r: 0, 3: 1, 5: 2, 7: 3, x: 0 }[bassRole];
    const fig = figure(q, r.inversion);

    // Default: function of the scale degree.
    r.func = (k.mode === 'minor' ? FUNC_MINOR : FUNC_MAJOR)[semis];
    r.applied = null;
    let label = rn + qualSuffix(q) + fig;

    const tonicChord = semis === 0 && (third === 'M' || third === 'm') && !isSeventh(q);
    if (r.aug6) {
      r.func = 'sharp';
      label = r.aug6 + '+6';
    } else if (semis === 1 && (q === 'dom7' || q === '7b5')) {
      r.func = 'dominant'; r.tritoneSub = true;                         // ♭II7: same Blue as V7
      label = '♭II' + '⁷';
    } else if (semis === 1 && (q === 'maj' || q === 'pow')) {
      r.func = 'flat'; r.neapolitan = true;
      label = r.inversion === 1 ? 'N⁶' : '♭II';
    } else if (tonicChord && r.inversion === 2 && next && nextSemis === 7) {
      r.func = 'dominant'; r.cad64 = true;                              // cadential 6/4 belongs to the dominant
    } else {
      const applied = appliedTarget(r, semis, q, k, next);
      if (applied) {
        r.applied = applied.label;
        r.func = 'sharp';
        if (q === 'maj') label = 'V' + fig + '/' + applied.label;
        else if (q === 'dom7') label = 'V' + (fig || '⁷') + '/' + applied.label;
        else if (q === 'dim') label = 'vii°' + fig + '/' + applied.label;
        else if (q === 'dim7') label = 'vii°' + (fig || '⁷') + '/' + applied.label;
        else if (q === 'hdim7') label = 'viiø' + (fig || '⁷') + '/' + applied.label;
      }
    }
    if (r.func === 'flat' || r.func === 'sharp') { r.borrowed = r.borrowed || r.func; }
    r.label = label;
    r.numeral = rn;
  }

  // Secondary dominant / leading-tone chord: chromatic, pointing at a consonant diatonic chord other than I.
  function appliedTarget(r, semis, q, k, next) {
    let tSemis;
    if (q === 'maj' || q === 'dom7') tSemis = mod12(semis + 5);
    else if (DIM_FAMILY(q)) tSemis = mod12(semis + 1);
    else return null;
    if (tSemis === 0) return null;                                       // that's V / vii° itself
    if (r.tones.every(t => t.alt === 0)) return null;                    // e.g. VII⁷ in minor stays VII⁷
    if (q === 'maj' && semis === 0 && !(next && mod12(next.root - k.tonic) === 5)) return null; // Picardy / major I
    const sc = scaleOf(k.mode);
    const deg = sc.indexOf(tSemis);
    if (deg < 0) return null;
    const tq = diatonicThird(deg, k.mode);
    if (tq === 'd') return null;
    return { label: numeral(deg, 0, tq, k.mode), fn: DIM_FAMILY(q) ? 'vii' : 'V' };
  }

  function qualSuffix(q) {
    return { dim: '°', aug: '+', hdim7: 'ø⁷', dim7: '°⁷', dom7: '⁷', maj7: 'ᴹ⁷', min7: '⁷', mmaj7: 'ᴹ⁷',
             sus4: 'sus4', sus2: 'sus2', '7sus4': '⁷sus4', add6: 'add6', madd6: 'add6', add9: 'add9', madd9: 'add9',
             pow: '', '7b5': '⁷♭5' }[q] || '';
  }
  // Figured-bass inversion symbols (7th chords replace the 7).
  function figure(q, inv) {
    if (!inv) return '';
    const tert = ['maj', 'min', 'dim', 'aug'].includes(q), sev = ['dom7', 'maj7', 'min7', 'hdim7', 'dim7', 'mmaj7', '7b5'].includes(q);
    if (tert) return inv === 1 ? '⁶' : inv === 2 ? '⁶₄' : '';
    if (sev) return ['', '⁶₅', '⁴₃', '⁴₂'][inv];
    return '';
  }

  function funcColour(func, s) {
    s = s || DEFAULTS;
    if (func === 'sharp') return PALETTE[s.sharpColour];
    if (func === 'flat') return PALETTE[s.flatColour];
    return FUNCS[func] ? PALETTE[FUNCS[func].colour] : null;
  }
  const funcColourName = (func, s) => func === 'sharp' ? (s || DEFAULTS).sharpColour : func === 'flat' ? (s || DEFAULTS).flatColour : FUNCS[func] && FUNCS[func].colour;

  function finishRegion(r, off) {
    r.start += off; r.end += off;
    if (r.root == null) { r.func = null; r.colour = null; r.label = ''; r.chordPcs = []; return; }
    r.chordPcs = r.tones.map(t => t.pc);
    r.keyFifths = r.key.fifths;
    r.keyName = keyLong(r.key);
    const tl = LETTERS.indexOf(keyLabel(r.key)[0].toUpperCase());
    const letter = (tl + r.rootSpell.deg) % 7;
    r.rootName = LETTERS[letter] + (ACC[norm(r.root - LETTER_PC[letter])] || '');
    r.implied = (r.distinct || 0) < 2 || r.confidence < 0.45;
  }

  // ---- expectation & subversion

  function findEvents(regs, home, endBeat, off) {
    const ev = [];
    for (let i = 0; i < regs.length; i++) {
      const a = regs[i], b = regs[i + 1];
      if (b && !sameKey(a.key, b.key)) {
        ev.push({ type: 'modulation', beat: b.start, from: keyLong(a.key), to: keyLong(b.key), home: sameKey(b.key, home),
                  text: sameKey(b.key, home) ? 'home: ' + keyLong(b.key) : '→ ' + keyLong(b.key) });
      }
      if (!b) continue;
      const k = a.key, semis = mod12(a.root - k.tonic), bSemis = mod12(b.root - k.tonic);
      const tense = a.func === 'dominant' || a.applied || a.aug6 || a.tritoneSub;
      if (tense) {
        let target;
        if (a.aug6) target = mod12(k.tonic + 7);
        else if (a.tritoneSub) target = mod12(a.root - 1);
        else if (DIM_FAMILY(a.quality)) target = mod12(a.root + 1);
        else if (a.cad64) target = mod12(k.tonic + 7);
        else if (semis === 10 && k.mode === 'minor') target = mod12(k.tonic); // VII-i (Aeolian cadence)
        else target = mod12(a.root + 5);
        const stable = b.quality && /^(maj|min|maj7|min7|add6|madd6|add9|madd9|pow|dom7|sus4)$/.test(b.quality);
        const primaryV = !a.applied && !a.aug6 && (semis === 7 || semis === 11 || a.tritoneSub);
        if (b.root === target || (a.cad64 && bSemis === 7)) {
          const cadence = bSemis === 0 && b.func === 'tonic';
          if (!a.cad64) ev.push({ type: 'resolve', beat: b.start, from: a.start, cadence, applied: !!(a.applied || a.aug6), text: cadence ? 'home' : 'resolves' });
        } else if (primaryV && b.key && sameKey(a.key, b.key) && bSemis === (k.mode === 'minor' ? 8 : 9) && stable) {
          ev.push({ type: 'deceptive', beat: b.start, from: a.start, text: 'deceptive', say: 'Longing' });
        } else if (primaryV && b.func !== 'dominant') {
          ev.push({ type: 'unresolved', beat: a.start, to: b.start, text: '?' });
        }
      }
      const c = regs[i + 2];
      if (c && a.func === 'supertonic' && b.func === 'dominant' && !b.applied && c.func === 'tonic' && sameKey(a.key, c.key)) {
        ev.push({ type: 'ii-V-I', beat: a.start, end: c.end, text: 'ii–V–I' });
      }
    }
    const last = regs[regs.length - 1];
    if (last && last.end >= endBeat + off - 1e-3) {
      const say = { dominant: 'eternal question', subdominant: 'eternal journey', tonic: "we're home" }[last.func];
      if (say) ev.push({ type: 'ending', beat: last.start, func: last.func, text: say });
      else ev.push({ type: 'ending', beat: last.start, func: last.func, text: 'open ending' });
    }
    return ev;
  }

  // ---- notes: chord tones, non-chord tones, borrowed tones

  function regionAt(regions, beat) {
    let lo = 0, hi = regions.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (regions[m].start <= beat + 1e-9) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? null : regions[ans];
  }

  function classifyNotes(notes, regions, slot) {
    const out = new Map();
    const off = regions.length ? regions[0].start - regions[0].s * slot : 0;
    const byPart = new Map();
    notes.forEach(n => { if (!byPart.has(n.part)) byPart.set(n.part, []); byPart.get(n.part).push(n); });
    byPart.forEach(list => {
      list.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      // Distinct onsets for melodic neighbours.
      const onsets = [];
      list.forEach(n => { if (!onsets.length || n.start - onsets[onsets.length - 1].t > 0.02) onsets.push({ t: n.start, notes: [n] }); else onsets[onsets.length - 1].notes.push(n); });
      const closest = (grp, p) => grp ? grp.notes.reduce((b, x) => Math.abs(x.pitch - p) < Math.abs(b.pitch - p) ? x : b) : null;
      onsets.forEach((o, oi) => o.notes.forEach(n => {
        const beat = n.start + off + 0.07;
        const r = regionAt(regions, beat);
        if (!r || r.root == null) return;
        const pc = mod12(n.pitch);
        const tone = r.tones.find(t => t.pc === pc);
        if (tone) { out.set(n.id, { ct: true, alt: tone.alt, region: r }); return; }
        const pg = onsets[oi - 1] && n.start - (onsets[oi - 1].t + 0) <= 2.01 ? onsets[oi - 1] : null;
        const ng = onsets[oi + 1] && onsets[oi + 1].t - (n.start + n.dur) <= 1.01 ? onsets[oi + 1] : null;
        const p = closest(pg, n.pitch), q = closest(ng, n.pitch);
        const inI = p ? n.pitch - p.pitch : null, outI = q ? q.pitch - n.pitch : null;
        const step = x => x != null && x !== 0 && Math.abs(x) <= 2;
        const posInRegion = n.start + off - r.start;
        const nr = q ? regionAt(regions, q.start + off + 0.07) : null;
        let type = 'nct';
        if (step(inI) && step(outI)) type = Math.sign(inI) === Math.sign(outI) ? 'passing' : 'neighbour';
        else if (p && inI === 0 && p.start + off < r.start - 1e-6 && step(outI) && outI < 0) type = 'suspension';
        else if (q && outI === 0 && nr && nr !== r && nr.chordPcs.includes(pc)) type = 'anticipation';
        else if (inI != null && Math.abs(inI) > 2 && step(outI) && posInRegion < 0.05) type = 'appoggiatura';
        else if (step(inI) && outI != null && Math.abs(outI) > 2) type = 'escape';
        else if (step(outI) && posInRegion < 0.05) type = 'appoggiatura';
        // Chromatic non-chord tones with harmonic weight count as borrowed (spelled by direction of motion).
        const rel = mod12(pc - r.key.tonic);
        let alt = 0;
        if (!((r.key.mask >> pc) & 1)) {
          const weighty = n.dur >= slot * 0.99 || (posInRegion < 0.05 && n.dur >= slot * 0.5);
          if (weighty) alt = outI != null ? (outI > 0 ? 1 : -1) : inI != null ? (inI > 0 ? 1 : -1) : (rel === 6 ? 1 : -1);
        }
        out.set(n.id, { ct: false, nct: type, alt, region: r });
      }));
    });
    return out;
  }

  // ------------------------------------------------------------------ decorating the score

  /** Returns a copy of score with note colours (never overwriting a colour already set) and the ribbon. */
  function decorate(score, an, s) {
    s = Object.assign({}, DEFAULTS, s);
    if (!an) return score;
    const colourNotes = s.mode === 'notes' || s.mode === 'both';
    const parts = colourNotes ? score.parts.map(p => ({ ...p, notes: p.notes.map(n => {
      if (n.color) return n;
      const info = an.notes.get(n.id);
      const c = info && noteColour(info, s);
      return c ? { ...n, color: c } : n;
    }) })) : score.parts;
    let directions = score.directions || [];
    if (s.ribbon) directions = directions.concat(ribbonDirections(an, score));
    return { ...score, parts, directions };
  }

  function noteColour(info, s) {
    if (!info.ct) return info.alt > 0 ? PALETTE[s.sharpColour] : info.alt < 0 ? PALETTE[s.flatColour] : PALETTE.grey;
    if (info.alt > 0) return PALETTE[s.sharpColour];
    if (info.alt < 0) return PALETTE[s.flatColour];
    return funcColour(info.region.func, s);
  }

  // Staff numbering as in score.js (a grand-staff part takes two staves), with the bars each staff has notes in,
  // so a ribbon label goes on the topmost staff that sounds in its bar (condensed empty staves are hidden).
  function isGrandStaff(name, pitches) { // mirrors score.js
    if (pitches.length < 2) return false;
    const lo = Math.min(...pitches), hi = Math.max(...pitches);
    if (/piano|harp|celest|organ|keys|marimba|synth|pad/i.test(name)) return lo < 57 && hi > 64;
    return hi - lo >= 36 && lo < 52 && hi > 69;
  }
  function staffPresence(score, mb) {
    const staves = [];
    score.parts.forEach(p => {
      const grand = p.grand != null ? p.grand : isGrandStaff(p.name || '', p.notes.map(n => n.pitch));
      const sets = grand ? [new Set(), new Set()] : [new Set()];
      p.notes.forEach(n => {
        const set = grand && n.pitch < 60 ? sets[1] : sets[0];
        for (let m = Math.floor(n.start / mb + 1e-6); m * mb < n.start + n.dur - 1e-6; m++) set.add(m);
      });
      sets.forEach(set => staves.push(set));
    });
    return staves;
  }

  // Ribbon text per region (key label at the start and at every modulation).
  function ribbonDirections(an, score) {
    const off = an.offsetBeats, dirs = [], mb = an.measureBeats;
    const staves = staffPresence(score, mb);
    let prevKey = null;
    an.regions.forEach(r => {
      if (r.root == null) return;
      let text = r.label;
      if (!prevKey || !sameKey(prevKey, r.key)) text = keyLabel(r.key) + ': ' + text;
      prevKey = r.key;
      if (r.implied) text = '(' + text + ')';
      r.ribbonText = text;
      const m = Math.floor((r.start - off) / mb + 1e-6);
      const staff = staves.findIndex(set => set.has(m)) + 1 || 1;
      dirs.push({ beat: r.start - off, text, kind: 'dir', staff, harmony: true });
    });
    return dirs;
  }

  // ------------------------------------------------------------------ aim assist (pure)

  function scalePcs(r) {
    const k = r.key;
    const pcs = scaleOf(k.mode).map(i => mod12(i + k.tonic));
    r.chordPcs.forEach(p => { if (!pcs.includes(p)) pcs.push(p); });
    if (k.mode === 'minor' && !pcs.includes(mod12(k.tonic + 11)) && r.func === 'dominant') pcs.push(mod12(k.tonic + 11));
    return pcs;
  }
  function snapIn(an, pitch, beat, mode) {
    const r = an && regionAt(an.regions, beat);
    if (!r || r.root == null) return pitch;
    const pcs = mode === 'scale' ? scalePcs(r) : r.chordPcs;
    for (let d = 0; d <= 12; d++) {
      if (pcs.includes(mod12(pitch + d))) return pitch + d;
      if (pcs.includes(mod12(pitch - d))) return pitch - d;
    }
    return pitch;
  }
  function stepChordTone(an, pitch, beat, dir) {
    const r = an && regionAt(an.regions, beat);
    if (!r || r.root == null) return pitch + dir;
    for (let p = pitch + dir; p >= 0 && p <= 127; p += dir) if (r.chordPcs.includes(mod12(p))) return p;
    return pitch;
  }

  const api = { analyzeFull, decorate, snapIn, stepChordTone, regionAt, PALETTE, FUNCS, DEFAULTS, funcColour, keyLong, noteColour };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.SV && root.document) setupUI(root.SV, api);

  // ------------------------------------------------------------------ browser UI

  function setupUI(SV, H) {
    const KEY = 'scoreview.harmony.settings';
    let settings = Object.assign({}, DEFAULTS);
    try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* defaults */ }
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ } };
    let current = null; // analysis of the score being rendered
    let overlayMs = 0;

    const MODES = ['notes', 'bands', 'both'];
    const MODE_NAMES = { notes: 'Noteheads', bands: 'Bands', both: 'Noteheads + bands' };

    SV.addStyle(`
      #paper { position: relative; }
      #paper > svg, #paper > .svc { position: relative; z-index: 1; }
      #paper .hv-layer { position: absolute; left: 0; top: 0; pointer-events: none; overflow: visible; }
      #paper .hv-bands { z-index: 0; }
      #paper .hv-marks { z-index: 2; }
      #paper.hv-on .sel, #paper.hv-on .sel * { fill: #111 !important; stroke: #111; }
      #paper.hv-on g.note.sel { filter: drop-shadow(0 0 1.5px #ff7a1a) drop-shadow(0 0 1.5px #ff7a1a); }
      #paper.hv-on .play, #paper.hv-on .play * { fill: #111 !important; }
      #paper.hv-on g.note.play { filter: drop-shadow(0 0 2px #1c7ed6); }
      .hv-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 25; background: var(--bar); border: 1px solid var(--line);
                  border-radius: 6px; padding: 8px 10px; min-width: 250px; box-shadow: 0 6px 20px #000a; }
      .hv-panel label { display: block; padding: 2px 0; color: var(--text); white-space: nowrap; }
      .hv-panel .hv-sub { margin: 2px 0 4px 20px; }
      .hv-panel hr { border: 0; border-top: 1px solid var(--line); margin: 6px 0; }
      .hv-panel kbd, .hv-legend kbd { background: var(--bar2); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; font: 11px ui-monospace, monospace; }
      .hv-legend { position: fixed; right: 18px; bottom: 44px; z-index: 26; background: #fbfaf6; color: #222; border-radius: 8px;
                   box-shadow: 0 6px 24px #000a; padding: 12px 14px 10px; width: 330px; font: 12.5px/1.35 system-ui, "Segoe UI", sans-serif; }
      .hv-legend h4 { margin: 0 0 6px; font: 600 13px system-ui; display: flex; justify-content: space-between; }
      .hv-legend h4 a { cursor: pointer; color: #888; font-weight: 400; }
      .hv-legend .row { display: grid; grid-template-columns: 16px 1fr; gap: 0 8px; align-items: start; padding: 3px 0; }
      .hv-legend .sw { width: 14px; height: 14px; border-radius: 3px; margin-top: 2px; }
      .hv-legend b { font-weight: 600; }
      .hv-legend i { color: #555; }
      .hv-legend .foot { color: #666; font-size: 11.5px; border-top: 1px solid #e3e0d6; margin-top: 6px; padding-top: 6px; }
      #hvBtn.on { border-color: var(--accent); color: #fff; }
      #hvBtn .dots { letter-spacing: -2px; margin-right: 6px; }
    `);

    // ---- toolbar
    const wrap = document.createElement('div');
    wrap.className = 'group dropdown';
    wrap.innerHTML = `
      <button class="btn" id="hvBtn" title="Functional Color Theory (H on/off, Shift+H cycles views)"><span class="dots"><span style="color:${PALETTE.red}">●</span><span style="color:${PALETTE.yellow}">●</span><span style="color:${PALETTE.blue}">●</span></span>Colors ▾</button>
      <div class="hv-panel hidden" id="hvPanel">
        <label><input type="checkbox" data-hv="enabled"> Harmony colours <kbd>H</kbd></label>
        <div class="hv-sub">
          ${MODES.map(m => `<label><input type="radio" name="hvMode" value="${m}"> ${MODE_NAMES[m]}</label>`).join('')}
          <label style="color:var(--dim);font-size:11px"><kbd>Shift</kbd>+<kbd>H</kbd> cycles</label>
        </div>
        <label><input type="checkbox" data-hv="ribbon"> Roman numerals above the score</label>
        <label><input type="checkbox" data-hv="marks"> Expectation marks (resolutions, deceptions, endings, modulations)</label>
        <hr>
        <label title="Mouse/letter note entry lands on the nearest chord tone"><input type="checkbox" data-hv="snap"> Snap to harmony</label>
        <label title="Sharp-side borrowed tones (♯4, secondary dominants) use magenta, flat-side use cyan"><input type="checkbox" data-hv="swap"> Swap cyan / magenta</label>
        <hr>
        <label><a id="hvLegendBtn" style="color:var(--accent);cursor:pointer">Legend — what the colours mean</a></label>
      </div>`;
    SV.addToolbar(wrap, { cluster: 'score', order: 50 });
    const $ = id => document.getElementById(id);
    const legend = document.createElement('div');
    legend.className = 'hv-legend hidden';
    document.body.appendChild(legend);

    function syncPanel() {
      wrap.querySelectorAll('[data-hv]').forEach(cb => {
        const k = cb.dataset.hv;
        cb.checked = k === 'swap' ? settings.sharpColour === 'magenta' : !!settings[k];
      });
      wrap.querySelectorAll('input[name=hvMode]').forEach(r => { r.checked = r.value === settings.mode; });
      $('hvBtn').classList.toggle('on', settings.enabled);
      renderLegend();
    }
    $('hvBtn').addEventListener('click', e => { $('hvPanel').classList.toggle('hidden'); e.stopPropagation(); });
    document.addEventListener('click', e => { if (!wrap.contains(e.target)) $('hvPanel').classList.add('hidden'); });
    wrap.addEventListener('change', e => {
      const k = e.target.dataset.hv;
      if (k === 'swap') { settings.sharpColour = e.target.checked ? 'magenta' : 'cyan'; settings.flatColour = e.target.checked ? 'cyan' : 'magenta'; }
      else if (k) settings[k] = e.target.checked;
      else if (e.target.name === 'hvMode') { settings.mode = e.target.value; settings.enabled = true; }
      save(); syncPanel();
      if (k !== 'snap') SV.render();
    });
    $('hvLegendBtn').addEventListener('click', () => { legend.classList.toggle('hidden'); $('hvPanel').classList.add('hidden'); });
    legend.addEventListener('click', e => { if (e.target.dataset.close) legend.classList.add('hidden'); });

    function renderLegend() {
      const row = (c, title, text) => `<div class="row"><div class="sw" style="background:${c}"></div><div>${title}<br><i>${text}</i></div></div>`;
      let html = '<h4><span>Functional Color Theory</span><a data-close="1">✕</a></h4>';
      Object.entries(FUNCS).forEach(([f, d]) => {
        const ex = { tonic: 'I, i, any temporary tonic', subdominant: 'IV, iv', dominant: 'V, V⁷, vii°, ♭II⁷', supertonic: 'ii, ii⁷, iiø⁷',
                     mediant: 'iii, ♭III', submediant: 'vi, ♭VI' }[f];
        html += row(PALETTE[d.colour], `<b>${d.state}</b> · ${ex}`, '“' + d.say + '”');
      });
      html += row(PALETTE[settings.sharpColour], '<b>Borrowed, sharp side</b> · V/x, vii°/x, It/Fr/Ger+6, ♯4', '“Expectation created” — ♯4 is the smoking gun');
      html += row(PALETTE[settings.flatColour], '<b>Borrowed, flat side</b> · modal interchange (♭3 ♭6 ♭7), ♭II, ♭VII', '“Something from another world”');
      html += row(PALETTE.grey, '<b>Non-chord tones</b> · passing, neighbour, suspension…', '“Decoration — no harmonic function”');
      html += `<div class="foot">Marks: <b style="color:${PALETTE.orange}">deceptive</b> (V→vi, Blue→Orange) · arcs show V→I fulfilled ·
        <b>?</b> unresolved tension · endings: Blue = <i>eternal question</i>, Yellow = <i>eternal journey</i> · → key = modulation.<br>
        Home key: <b>${current ? current.homeName : '—'}</b>. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd><kbd>↓</kbd> moves selected notes to the next chord tone.</div>`;
      legend.innerHTML = html;
    }
    syncPanel();
    SV.addHelp('<kbd>H</kbd> harmony colours · <kbd>Shift</kbd>+<kbd>H</kbd> colour view · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd><kbd>↓</kbd> next chord tone');

    // ---- analysis + decoration before engraving
    SV.hooks.transformScore.push(score => {
      current = null;
      if (!settings.enabled && !settings.snap) return score;
      current = H.analyzeFull(score);
      if (!settings.enabled) return score;
      const out = H.decorate(score, current, settings);
      if (cacheById && current) cacheById.set(out, current);
      return out;
    });

    // ---- overlays after engraving
    SV.hooks.afterRender.push(render => {
      const paper = $('paper');
      paper.querySelectorAll('.hv-layer').forEach(el => el.remove());
      paper.classList.toggle('hv-on', !!settings.enabled);
      if (!settings.enabled || !current || !render) return;
      const t0 = now();
      try { drawOverlay(paper, render, current); } catch (err) { console.error('harmony overlay', err); }
      overlayMs = now() - t0;
      if (!legend.classList.contains('hidden')) renderLegend();
    });

    function drawOverlay(paper, render, an) {
      const pr = paper.getBoundingClientRect();
      const mb = render.measureBeats;
      const rel = r => ({ l: r.left - pr.left, r: r.right - pr.left, t: r.top - pr.top, b: r.bottom - pr.top, w: r.width, h: r.height });
      // Measures, systems and the vertical extent of each system's staves.
      const systems = new Map();
      const measures = new Map();
      paper.querySelectorAll('g.measure').forEach(mEl => {
        const n = parseInt((mEl.id || '').replace(/^m/, ''), 10);
        if (isNaN(n)) return;
        const sys = mEl.closest('g.system') || mEl.parentNode;
        if (!systems.has(sys)) {
          const staves = mEl.querySelectorAll(':scope > g.staff');
          if (!staves.length) return;
          const lineBox = st => { const ls = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect()).filter(b => b.width > 10); return ls.length ? { t: Math.min(...ls.map(b => b.top)), b: Math.max(...ls.map(b => b.bottom)) } : null; };
          const a = lineBox(staves[0]), z = lineBox(staves[staves.length - 1]);
          if (!a || !z) return;
          const gap = Math.max(4, (a.b - a.t) / 4);
          systems.set(sys, { top: a.t - pr.top, bottom: z.b - pr.top, gap, measures: [] });
        }
        const box = rel(mEl.getBoundingClientRect());
        let left = box.l;
        mEl.querySelectorAll(':scope > g.staff > g.clef, :scope > g.staff > g.keySig, :scope > g.staff > g.meterSig').forEach(el => {
          const b = el.getBoundingClientRect(); if (b.width) left = Math.max(left, b.right - pr.left);
        });
        const barRight = (() => { const bl = mEl.querySelector(':scope > g.barLine'); return bl ? rel(bl.getBoundingClientRect()).l : box.r; })();
        const m = { n, el: mEl, sys: systems.get(sys), left, right: Math.max(left + 4, barRight), start: (n - 1) * mb, anchors: [] };
        systems.get(sys).measures.push(m);
        measures.set(n, m);
      });
      // Horizontal anchors: leftmost note at each onset.
      const seen = new Set();
      render.timeline.forEach(t => {
        const n = Math.floor(t.start / mb + 1e-6) + 1, m = measures.get(n);
        if (!m) return;
        const key = n + ':' + t.start.toFixed(3);
        if (seen.has(key)) return;
        seen.add(key);
        const el = document.getElementById(t.svgId);
        if (!el) return;
        const head = el.querySelector('.notehead') || el;
        const b = head.getBoundingClientRect();
        if (!b.width) return;
        let x = b.left - pr.left;
        const acc = el.querySelector('.accid');
        if (acc) { const ab = acc.getBoundingClientRect(); if (ab.width) x = Math.min(x, ab.left - pr.left); }
        m.anchors.push({ beat: t.start, x });
      });
      measures.forEach(m => {
        const pts = new Map();
        m.anchors.forEach(a => { const k = a.beat.toFixed(3); if (!pts.has(k) || pts.get(k).x > a.x) pts.set(k, a); });
        const arr = [...pts.values()].sort((a, b) => a.beat - b.beat);
        const pad = m.sys.gap * 0.6;
        const out = [{ beat: m.start, x: m.left + pad * 0.4 }];
        arr.forEach(a => {
          const x = Math.max(a.x - pad, out[out.length - 1].x + 1);
          if (a.beat < m.start + 1e-6) out[0].x = Math.max(m.left + 1, a.x - pad); else out.push({ beat: a.beat, x });
        });
        out.push({ beat: m.start + mb, x: m.right });
        m.xAt = beat => {
          if (beat <= out[0].beat) return out[0].x;
          for (let i = 1; i < out.length; i++) if (beat <= out[i].beat + 1e-6) {
            const a = out[i - 1], b = out[i];
            return a.x + (b.x - a.x) * (beat - a.beat) / Math.max(1e-6, b.beat - a.beat);
          }
          return m.right;
        };
      });

      const W = paper.scrollWidth, Hh = paper.scrollHeight;
      const NS = 'http://www.w3.org/2000/svg';
      const mk = (cls) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 'hv-layer ' + cls); s.setAttribute('width', W); s.setAttribute('height', Hh); paper.appendChild(s); return s; };
      const el = (parent, tag, attrs, text) => { const e = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); if (text != null) e.textContent = text; parent.appendChild(e); return e; };
      const bands = mk('hv-bands'), marks = mk('hv-marks');

      // All labels of a system share one baseline just above the highest note of its top staff.
      systems.forEach(sys => {
        let top = sys.top - sys.gap * 0.5;
        sys.measures.forEach(mm => {
          const first = mm.el.querySelector(':scope > g.staff');
          if (first) first.querySelectorAll(':scope > g.layer').forEach(l => { const lb = l.getBoundingClientRect(); if (lb.height) top = Math.min(top, lb.top - pr.top - sys.gap * 0.3); });
        });
        sys.baseline = top;
      });
      // Ribbon labels (Verovio <dir>s) -> colour them, remember their boxes.
      const labelBox = new Map();
      if (settings.ribbon) {
        const byMeasure = new Map();
        an.regions.forEach(r => {
          if (!r.ribbonText) return;
          const n = Math.floor(r.start / mb + 1e-6) + 1;
          if (!byMeasure.has(n)) byMeasure.set(n, []);
          byMeasure.get(n).push(r);
        });
        const placed = []; // [{ r, d, m }]
        byMeasure.forEach((regs, n) => {
          const m = measures.get(n);
          if (!m) return;
          const dirs = [...m.el.querySelectorAll(':scope > g.dir')];
          let i = 0;
          dirs.forEach(d => {
            const txt = d.textContent.replace(/\s+/g, ' ').trim();
            const r = regs.slice(i).find(x => x.ribbonText.replace(/\s+/g, ' ').trim() === txt);
            if (!r) return;
            i = regs.indexOf(r) + 1;
            const c = H.funcColour(r.func, settings);
            d.querySelectorAll('text, tspan').forEach(t => { t.setAttribute('fill', c); t.style.fontWeight = '600'; t.style.fontStyle = 'normal'; });
            d.setAttribute('fill', c);
            liftToTop(d, m);
            placed.push({ r, d, m });
          });
        });
        clearMarks(placed);
        placed.forEach(({ r, d }) => labelBox.set(r, rel(d.getBoundingClientRect())));
      }

      // A label engraved on an inner staff (the staves above rest in its bar) moves up above the system's top staff.
      function liftToTop(d, m) {
        const b = rel(d.getBoundingClientRect());
        if (!b.h) return;
        shiftY(d, m.sys.baseline - b.b, b);
      }
      // A label must not sit on a tempo mark, rehearsal mark or other text of its system (bar 1's "♩ = 164"):
      // it moves up just past whatever it touches, keeping its beat; where that would leave the engraving (top of the
      // page) it moves right of it instead.
      function clearMarks(placed) {
        const own = new Set(placed.map(p => p.d)), obstacles = new Map(); // system -> [boxes]
        const obstaclesOf = sys => {
          if (!obstacles.has(sys)) {
            const list = [];
            sys.measures.forEach(mm => mm.el.querySelectorAll(':scope > g.tempo, :scope > g.reh, :scope > g.dir').forEach(o => {
              if (own.has(o)) return;
              const b = rel(o.getBoundingClientRect());
              if (!b.w || !b.h) return;
              // features/playback.js boxes rehearsal marks (and may nudge them right) after this runs: allow for it.
              const f = o.classList.contains('reh') ? b.h * 0.3 : 0;
              list.push({ l: b.l - f, r: b.r + f + (f && 8), t: b.t - f, b: b.b + f });
            }));
            obstacles.set(sys, list);
          }
          return obstacles.get(sys);
        };
        placed.forEach(({ d, m }) => {
          const list = obstaclesOf(m.sys), pad = 2;
          let svg = d.ownerSVGElement;
          while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement;
          const ceiling = svg ? rel(svg.getBoundingClientRect()).t + pad : -Infinity;
          for (let tries = 0; tries <= list.length; tries++) {
            const b = rel(d.getBoundingClientRect());
            const hit = b.h && list.find(o => o.l < b.r + pad && o.r > b.l - pad && o.t < b.b + pad && o.b > b.t - pad);
            if (!hit) break;
            const up = hit.t - pad - b.b;
            if (b.t + up >= ceiling) shiftY(d, up, b); else shiftX(d, hit.r + pad - b.l, b);
          }
        });
      }
      function shiftY(d, dyPx, b) {
        if (Math.abs(dyPx) < 0.5) return;
        let k = 1;
        try { const bb = d.getBBox(); if (bb.height) k = bb.height / b.h; } catch (e) { /* not rendered */ }
        d.setAttribute('transform', `translate(0 ${(dyPx * k).toFixed(1)})` + (d.getAttribute('transform') ? ' ' + d.getAttribute('transform') : ''));
      }
      function shiftX(d, dxPx, b) {
        if (Math.abs(dxPx) < 0.5) return;
        let k = 1;
        try { const bb = d.getBBox(); if (bb.width) k = bb.width / b.w; } catch (e) { /* not rendered */ }
        d.setAttribute('transform', `translate(${(dxPx * k).toFixed(1)} 0)` + (d.getAttribute('transform') ? ' ' + d.getAttribute('transform') : ''));
      }

      // Bands: one rectangle per region per measure.
      const showBands = settings.mode === 'bands' || settings.mode === 'both';
      const pieces = new Map(); // region -> [rects]
      an.regions.forEach(r => {
        if (r.root == null) return;
        const cname = funcColourName(r.func, settings);
        const firstM = Math.floor(r.start / mb + 1e-6) + 1, lastM = Math.floor((r.end - 1e-6) / mb) + 1;
        for (let n = firstM; n <= lastM; n++) {
          const m = measures.get(n);
          if (!m || !m.xAt) continue;
          const a = Math.max(r.start, m.start), b = Math.min(r.end, m.start + mb);
          if (b <= a + 1e-6) continue;
          const cont = a > r.start + 1e-6, atStart = a <= m.start + 1e-6;
          const prevM = measures.get(n - 1);
          const x1 = cont && atStart ? (prevM && prevM.sys === m.sys ? prevM.right : m.left) : m.xAt(a) + 1, x2 = b >= m.start + mb - 1e-6 ? (b < r.end - 1e-6 ? m.right : m.right - 1) : m.xAt(b) - 1;
          const top = m.sys.top - m.sys.gap * 2.2, bottom = m.sys.bottom + m.sys.gap * 1.6;
          const rect = { x: x1, y: top, w: Math.max(2, x2 - x1), h: bottom - top, contL: a > r.start + 1e-6, contR: b < r.end - 1e-6 };
          (pieces.get(r) || pieces.set(r, []).get(r)).push(rect);
          if (showBands) {
            el(bands, 'rect', { x: rect.x, y: rect.y, width: rect.w, height: rect.h, rx: 3, fill: BAND[cname][0], 'fill-opacity': BAND[cname][1] * (r.implied ? 0.6 : 1) });
            if (!rect.contL) el(bands, 'rect', { x: rect.x, y: rect.y, width: 2.5, height: rect.h, fill: PALETTE[cname], 'fill-opacity': 0.55 });
          }
        }
      });
      if (!settings.marks) return;

      // Expectation & subversion marks.
      const regAt = beat => an.regions.find(r => Math.abs(r.start - beat) < 1e-6);
      const font = Math.max(10, Math.round((systems.values().next().value || { gap: 8 }).gap * 1.5));
      const tag = (x, y, text, colour, opts = {}) => el(marks, 'text', { x, y, fill: colour, 'font-size': opts.size || font, 'font-style': opts.italic === false ? 'normal' : 'italic',
        'font-weight': opts.bold ? 700 : 500, 'font-family': 'Georgia, "Times New Roman", serif', 'text-anchor': opts.anchor || 'start', 'paint-order': 'stroke', stroke: '#fbfaf6', 'stroke-width': 3 }, text);
      const anchorOf = r => {
        const lb = labelBox.get(r);
        if (lb) return { x: (lb.l + lb.r) / 2, y: lb.t, box: lb };
        const p = (pieces.get(r) || [])[0];
        return p ? { x: p.x + 8, y: p.y + font, box: null } : null;
      };
      an.events.forEach(ev => {
        if (ev.type === 'deceptive' || ev.type === 'resolve') {
          const a = regAt(ev.from), b = regAt(ev.beat);
          const pa = a && anchorOf(a), pb = b && anchorOf(b);
          if (ev.type === 'deceptive' && b) {
            (pieces.get(b) || []).forEach(p => el(marks, 'rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 4, fill: 'none', stroke: PALETTE.orange, 'stroke-width': 2.2, 'stroke-dasharray': '7 4' }));
            if (pb) tag(pb.box ? pb.box.r + 4 : pb.x, pb.box ? pb.box.b - 2 : pb.y, 'deceptive — longing', PALETTE.orange, { bold: true });
          }
          const arc = ev.type === 'deceptive' || ev.cadence || ev.applied;
          if (arc && pa && pb && Math.abs(pa.y - pb.y) < font * 3 && pb.x > pa.x) {
            const y = Math.min(pa.y, pb.y) - 2, h = Math.min(18, (pb.x - pa.x) * 0.25 + 6);
            const d = `M${pa.x},${y} C${pa.x},${y - h} ${pb.x},${y - h} ${pb.x},${y - 1}`;
            const col = ev.type === 'deceptive' ? PALETTE.orange : ev.cadence ? PALETTE.red : '#8a8a8a';
            el(marks, 'path', { d, fill: 'none', stroke: col, 'stroke-width': ev.type === 'deceptive' ? 1.8 : 1.3, 'stroke-dasharray': ev.type === 'deceptive' ? '4 3' : 'none', 'stroke-linecap': 'round', opacity: 0.85 });
            el(marks, 'path', { d: `M${pb.x - 3.5},${y - 6} L${pb.x},${y - 1} L${pb.x + 3.5},${y - 6}`, fill: 'none', stroke: col, 'stroke-width': 1.3, opacity: 0.85 });
          }
        } else if (ev.type === 'unresolved') {
          const a = regAt(ev.beat), pa = a && anchorOf(a);
          if (pa) tag(pa.box ? pa.box.r + 2 : pa.x, pa.box ? pa.box.t + font * 0.8 : pa.y, '?', PALETTE.blue, { bold: true, italic: false });
        } else if (ev.type === 'ending') {
          const a = regAt(ev.beat), pa = a && anchorOf(a);
          const col = H.funcColour(ev.func, settings) || '#555';
          if (pa) tag(pa.box ? pa.box.r + 6 : pa.x, pa.box ? pa.box.b - 2 : pa.y, ev.text, col, { bold: true });
        } else if (ev.type === 'modulation') {
          const b = regAt(ev.beat), p = b && (pieces.get(b) || [])[0];
          if (!p) return;
          el(marks, 'line', { x1: p.x - 1, x2: p.x - 1, y1: p.y - font * 0.2, y2: p.y + p.h, stroke: '#444', 'stroke-width': 1.4, 'stroke-dasharray': '2 3', opacity: 0.7 });
          tag(p.x + 3, p.y + p.h + font * 0.95, ev.text, '#333', { size: font * 0.9 });
        }
      });
    }

    // ---- keyboard: H toggles, Shift+H cycles, Alt+Shift+arrows step through chord tones.
    SV.hooks.keydown.push(e => {
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'h') {
        if (e.shiftKey) {
          settings.mode = settings.enabled ? MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length] : settings.mode;
          settings.enabled = true;
          SV.flash('Harmony: ' + MODE_NAMES[settings.mode]);
        } else {
          settings.enabled = !settings.enabled;
          SV.flash('Harmony colours ' + (settings.enabled ? 'on (' + MODE_NAMES[settings.mode] + ')' : 'off'));
        }
        save(); syncPanel(); SV.render();
        return true;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        aimSelection(e.key === 'ArrowUp' ? 1 : -1);
        return true;
      }
      return false;
    });

    if (SV.shortcuts) {
      SV.shortcuts.register({ keys: 'H', owner: 'harmony', desc: 'harmony colours on / off' });
      SV.shortcuts.register({ keys: 'Shift+H', owner: 'harmony', desc: 'next colour view' });
      SV.shortcuts.register({ keys: ['Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown'], owner: 'harmony', desc: 'selected note to the next chord tone up / down' });
    }

    function analysisNow() {
      if (current) return current;
      const r = SV.state.render;
      return r && r.score ? (current = H.analyzeFull(r.score)) : null;
    }
    const beatOf = id => {
      const r = SV.state.render, t = r && r.bySrc && r.bySrc.get(id);
      if (t && t.length) return t[0].start;
      const d = SV.state.liveData, { x } = SV.parseId(id);
      return x / ((d && d.stepsPerBeat) || 24);
    };

    function aimSelection(dir) {
      const an = analysisNow();
      const sel = [...SV.state.selection].filter(SV.isLive).map(id => ({ id, ...SV.parseId(id) }));
      if (!sel.length) return;
      if (!an) { SV.flash('No harmony analysis yet'); return; }
      const moves = sel.map(n => ({ ...n, dy: H.stepChordTone(an, n.y, beatOf(n.id), dir) - n.y }))
        .filter(n => n.dy && n.y + n.dy >= 0 && n.y + n.dy <= 127);
      if (!moves.length) return;
      moves.sort((a, b) => Math.sign(a.dy) * (b.y - a.y));
      const lines = moves.map(n => `move ${n.ch} ${n.x} ${n.y} 0 ${n.dy}`);
      const next = new Set(SV.state.selection);
      moves.forEach(n => { next.delete(n.id); next.add('L' + n.ch + '_' + n.x + '_' + (n.y + n.dy)); });
      SV.state.selection = next;
      const aud = document.getElementById('audition');
      if (aud && aud.checked) moves.slice(0, 4).forEach(n => lines.push('audition ' + (n.y + n.dy)));
      SV.send(lines);
      if (SV.paintSelection) SV.paintSelection();
    }

    // ---- public API (other modules: note entry calls snap() when "Snap to harmony" is on)
    SV.harmony = {
      // Analyse any score object (same shape as transformScore's); beats in the result are absolute
      // (measureOffset applied) like SV.hitTest().beat and render.timeline.
      analyze: score => { const a = H.analyzeFull(score); return a ? a.regions.filter(r => r.root != null).map(r => publicRegion(r, settings)) : []; },
      analysis: () => analysisNow(),
      regions: () => { const a = analysisNow(); return a ? a.regions.filter(r => r.root != null).map(r => publicRegion(r, settings)) : []; },
      events: () => { const a = analysisNow(); return a ? a.events.slice() : []; },
      chordAt: beat => { const a = analysisNow(), r = a && H.regionAt(a.regions, beat); return r && r.root != null ? publicRegion(r, settings) : null; },
      snap: (pitch, beat, mode) => { const a = analysisNow(); return a ? H.snapIn(a, pitch, beat, mode === 'scale' ? 'scale' : 'chord') : pitch; },
      nextChordTone: (pitch, beat, dir) => { const a = analysisNow(); return a ? H.stepChordTone(a, pitch, beat, dir) : pitch + dir; },
      enabled: () => !!settings.enabled,
      snapEnabled: () => !!settings.snap,
      settings: () => ({ ...settings }),
      set: patch => { Object.assign(settings, patch); save(); syncPanel(); SV.render(); },
      colours: { ...PALETTE },
      colourOf: func => H.funcColour(func, settings),
      stats: () => ({ analysisMs: current ? current.ms : null, overlayMs }),
    };
  }

  function publicRegion(r, s) {
    return { start: r.start, end: r.end, root: r.root, rootName: r.rootName, quality: r.quality, roman: r.label, func: r.func,
             color: funcColour(r.func, s), keyFifths: r.keyFifths, key: r.keyName, chordPcs: r.chordPcs.slice(), borrowed: r.borrowed,
             applied: r.applied, bass: r.bassPc, inversion: r.inversion, sharp4: !!r.sharp4, implied: !!r.implied };
  }
  api.publicRegion = publicRegion;
})(typeof window !== 'undefined' ? window : this);
