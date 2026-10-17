// Converts note lists (in beats) into MEI for Verovio: quantizing, tuplets, voices, ties, beams, spelling.
(function (root) {
  'use strict';
  const TPQ = 8;  // units of the public `grid` option per quarter (1 = 32nd, 2 = 16th, 4 = 8th)
  const TQ = 48;  // internal ticks per quarter: 32nds (6), 16th triplets (8) and 8th triplets (16) are whole
  const G = TQ / TPQ;
  const DUR = { 288: ['1', 1], 192: ['1', 0], 144: ['2', 1], 96: ['2', 0], 72: ['4', 1], 48: ['4', 0],
                36: ['8', 1], 24: ['8', 0], 18: ['16', 1], 12: ['16', 0], 9: ['32', 1], 6: ['32', 0], 3: ['64', 0] };
  const VALUES = [288, 192, 144, 96, 72, 48, 36, 24, 18, 12, 9, 6, 3];
  const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
  const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
  const FLAT_ORDER = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
  const C_MAJOR_CHROMATIC = { 1: 'c', 3: 'e', 6: 'f', 8: 'a', 10: 'b' };
  const ACCID = { '-2': 'ff', '-1': 'f', '0': 'n', '1': 's', '2': 'x' };

  function keyAlters(fifths) {
    const alt = { c: 0, d: 0, e: 0, f: 0, g: 0, a: 0, b: 0 };
    if (fifths > 0) SHARP_ORDER.slice(0, fifths).forEach(l => alt[l] = 1);
    if (fifths < 0) FLAT_ORDER.slice(0, -fifths).forEach(l => alt[l] = -1);
    return alt;
  }

  function makeSpeller(fifths) {
    const kalt = keyAlters(fifths);
    const table = {};
    for (let pc = 0; pc < 12; pc++) {
      let best = null;
      for (const l of LETTERS) {
        const a = ((pc - LETTER_PC[l] + 18) % 12) - 6;
        if (Math.abs(a) > 2) continue;
        let score;
        if (a === kalt[l]) score = 0;
        else if (fifths === 0 && C_MAJOR_CHROMATIC[pc]) score = C_MAJOR_CHROMATIC[pc] === l ? 1 : 9;
        else score = 2 + Math.abs(a) * 2 + ((fifths >= 0) === (a > 0) ? 0 : 1);
        if (!best || score < best.score) best = { l, a, score };
      }
      table[pc] = best;
    }
    return p => {
      const s = table[((p % 12) + 12) % 12];
      return { pname: s.l, alter: s.a, oct: Math.floor((p - s.a) / 12) - 1 };
    };
  }

  const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const pcToFifths = pc => ((pc * 7) % 12 + 18) % 12 - 6; // major tonic pitch class -> fifths (-6..5)

  // Krumhansl-Schmuckler key finding; returns key-signature fifths.
  function detectFifths(notes) {
    const hist = new Array(12).fill(0);
    notes.forEach(n => hist[((n.pitch % 12) + 12) % 12] += Math.max(n.dur, 0.05));
    if (hist.every(v => v === 0)) return 0;
    const corr = (prof, tonic) => {
      let mx = 0, my = 0;
      for (let i = 0; i < 12; i++) { mx += hist[i]; my += prof[i]; }
      mx /= 12; my /= 12;
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < 12; i++) {
        const x = hist[(i + tonic) % 12] - mx, y = prof[i] - my;
        num += x * y; dx += x * x; dy += y * y;
      }
      return num / Math.sqrt(dx * dy || 1);
    };
    let best = { r: -2, fifths: 0 };
    for (let t = 0; t < 12; t++) {
      const rM = corr(MAJOR_PROFILE, t), rm = corr(MINOR_PROFILE, t);
      if (rM > best.r) best = { r: rM, fifths: pcToFifths(t) };
      if (rm > best.r) best = { r: rm, fifths: pcToFifths((t + 3) % 12) };
    }
    return best.fifths;
  }

  function chooseClef(name, pitches) {
    if (/viola|vla\b/i.test(name)) return ['C', 3];
    if (/cello|vc\b|bass|tuba|timp|trombone|tbn|bsn|contra|baritone/i.test(name)) return ['F', 4];
    if (!pitches.length) return ['G', 2];
    const sorted = pitches.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] < 57 ? ['F', 4] : ['G', 2];
  }

  // Alternative clefs when the part's clef was chosen here (no instrument module): tenor clef first for the
  // instruments that read it, otherwise treble <-> bass.
  function autoAltClefs(name, clef) {
    if (clef.shape === 'G') return [['F', 4]];
    if (clef.shape === 'C') return [['G', 2]];
    if (clef.shape !== 'F') return [];
    return /cello|vc\b|bsn|bassoon|trombone|tbn|euphon/i.test(name) ? [['C', 4], ['G', 2]] : [['G', 2]];
  }

  function isGrandStaff(name, pitches) {
    if (pitches.length < 2) return false;
    const lo = Math.min(...pitches), hi = Math.max(...pitches);
    if (/piano|harp|celest|organ|keys|marimba|synth|pad/i.test(name)) return lo < 57 && hi > 64;
    return hi - lo >= 36 && lo < 52 && hi > 69;
  }

  // Splits a duple span [pos, pos+len) inside one measure (ticks from the bar line) into notatable durations.
  // Rests follow stricter engraving rules: no dotted rests in simple meters, long rests start on their own multiple.
  function decompose(pos, len, beat, rest, compound) {
    const out = [];
    while (len > 0) {
      let pick = 0;
      for (const v of VALUES) {
        if (v > len) continue;
        const dotted = DUR[v][1] > 0;
        if (rest && dotted && !(compound && v % beat === 0)) continue;
        if (v >= beat) {
          if (pos % beat !== 0) continue;
          if (rest && pos % v !== 0) continue;
        } else {
          const base = dotted ? v * 2 / 3 : v;
          if (pos % Math.min(base, beat) !== 0) continue;
          if (Math.floor(pos / beat) !== Math.floor((pos + v - 1) / beat)) continue;
        }
        pick = v; break;
      }
      if (!pick) pick = VALUES.find(v => v <= len && pos % v === 0) || VALUES.find(v => v <= len);
      if (!pick) break; // remainder below the smallest value (cannot happen with grid-aligned input)
      out.push(pick); pos += pick; len -= pick;
    }
    return out;
  }

  // Splits k units at unit p of an n-unit tuplet into tuplet note values (in units).
  function decomposeTuplet(p, k, n, rest) {
    const out = [];
    while (k > 0) {
      let pick = 1;
      for (const v of [4, 3, 2]) {
        if (v > k || v >= n) continue;
        if (v === 4 && p % 2) continue;
        if (v === 3 && (rest || p % 3)) continue;
        pick = v; break;
      }
      out.push(pick); p += pick; k -= pick;
    }
    return out;
  }

  // Everything about one meter that the engraver needs (ticks): bar length, beat, beam window, tuplet window.
  function meterInfo(num, den) {
    const M = num * TQ * 4 / den;
    const compound = den === 8 && num % 3 === 0 && num > 3;
    // Tuplet analysis window: a quarter (8th triplets, 16th triplets; quarter triplets merge two windows), or an
    // 8th in x/8 simple meters (16th triplets). Compound meters are read straight.
    const U = compound ? 0 : den <= 4 ? TQ : den === 8 ? TQ / 2 : 0;
    return { num, den, M, compound, beat: compound ? TQ * 3 / 2 : den === 2 ? TQ * 2 : TQ,
             beamWin: compound ? TQ * 3 / 2 : TQ, U, W: U || M, unit: TQ * 4 / den };
  }

  // Bar layout: meters [{tick, num, den}] sorted, the first at tick 0; optional pickup (anacrusis) measure of P
  // ticks in the first meter. A meter change inside a bar ends that bar early (an incomplete bar, like the DAW).
  function makeLayout(meters, P) {
    const first = meterInfo(meters[0].num, meters[0].den);
    const segs = [{ t0: P || 0, k0: P ? 1 : 0, info: first }];
    meters.slice(1).forEach(c => {
      const cur = segs[segs.length - 1], T = c.tick;
      if (T < cur.t0 || (c.num === cur.info.num && c.den === cur.info.den)) return;
      const info = meterInfo(c.num, c.den);
      if (T === cur.t0) { cur.info = info; return; }
      segs.push({ t0: T, k0: cur.k0 + Math.ceil((T - cur.t0) / cur.info.M), info });
    });
    const segIdx = (key, x) => {
      let lo = 0, hi = segs.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid][key] <= x) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const start = m => {
      if (m < 0) return m * first.M;
      if (P && m === 0) return 0;
      const s = segs[segIdx('k0', m)];
      return s.t0 + (m - s.k0) * s.info.M;
    };
    return {
      start,
      len: m => {
        if (m < 0) return first.M;
        if (P && m === 0) return P;
        const i = segIdx('k0', m), next = segs[i + 1];
        return next ? Math.min(segs[i].info.M, next.t0 - start(m)) : segs[i].info.M;
      },
      of: t => {
        if (t < 0) return Math.floor(t / first.M);
        if (P && t < P) return 0;
        const s = segs[segIdx('t0', t)];
        return s.k0 + Math.floor((t - s.t0) / s.info.M);
      },
      info: m => m <= 0 ? (P || m < 0 ? first : segs[0].info) : segs[segIdx('k0', m)].info,
      first,
    };
  }

  // ---- Clefs and ottavas: staff positions as diatonic numbers (C4 = 28, D4 = 29 ...).
  const CLEF_REF = { G: 32, F: 24, C: 28 }; // the pitch each clef names (G4, F3, C4)
  const clefKey = c => c.shape + c.line + (c.dis ? (c.disPlace === 'below' ? '-' : '+') + c.dis : '');
  // Diatonic number of the bottom staff line.
  function clefBottom(c) {
    const dis = c.dis ? (c.disPlace === 'below' ? -7 : 7) * Math.round((c.dis - 1) / 7) : 0;
    return CLEF_REF[c.shape] + dis - 2 * (c.line - 1);
  }
  function ledgers(d, bottom) {
    const pos = d - bottom;
    return pos >= 10 ? (pos - 8) >> 1 : pos <= -2 ? (-pos) >> 1 : 0;
  }
  // Reading cost of a note with L ledger lines: clefs change for a sustained stretch at 3+ lines; ottava lines
  // only from 4+ lines (violinists read 3 ledger lines all day).
  const clefCost = L => L <= 2 ? 0.1 * L : 0.2 + 1.3 * Math.pow(L - 2, 1.5);
  const ottavaCost = L => L <= 3 ? 0.05 * L : 0.15 + 2 * Math.pow(L - 3, 1.3);
  // Cost of putting a note under an ottava line that reads well without it (by its ledger lines).
  const LOCO_UNDER_OTTAVA = L => L <= 2 ? 0.8 : L === 3 ? 0.3 : 0.1;
  const CLEF_SWITCH = { phrase: 4, bar: 5 }, OTTAVA_SWITCH = { phrase: 3, bar: 4 };

  // Cheapest state per unit: cost(u, k) + switch penalty at unit boundaries (Viterbi). Returns state per unit.
  function cheapestPath(units, K, cost, switchCost) {
    if (!units.length) return [];
    let prev = Array.from({ length: K }, (_, k) => cost(0, k));
    const back = [];
    for (let u = 1; u < units.length; u++) {
      const cur = new Array(K), from = new Array(K);
      for (let k = 0; k < K; k++) {
        let best = Infinity, bj = 0;
        for (let j = 0; j < K; j++) {
          const c = prev[j] + (j === k ? 0 : switchCost(u));
          if (c < best - 1e-9) { best = c; bj = j; }
        }
        cur[k] = best + cost(u, k); from[k] = bj;
      }
      back.push(from); prev = cur;
    }
    let k = 0;
    for (let j = 1; j < K; j++) if (prev[j] < prev[k] - 1e-9) k = j;
    const path = [k];
    for (let u = units.length - 1; u > 0; u--) { k = back[u - 1][k]; path.push(k); }
    return path.reverse();
  }

  // Penalty (ticks of timing error) for writing a tuplet group (doubled for the finer 16th-triplet grid, which
  // fits random timing too easily), and how much better than straight a tuplet reading must fit before it is
  // used: straight music must never turn into triplets by accident.
  const TUP_PENALTY = 1.5, TUP_RATIO = 0.7;

  // Chooses how one analysis window (a beat) is subdivided. pts: [{t (ticks from window start), w}].
  // Returns sub-ranges [{a, b, q, tup}] (relative ticks; q = quantum; tup = written as a 3:2 tuplet).
  function decideWindow(pts, W, qd, mode) {
    const D = [{ a: 0, b: W, q: qd, tup: false }];
    if (mode === 'off' || !pts.length) return D;
    const cost = (a, b, q) => {
      let c = 0;
      for (const p of pts) {
        if (p.t < a || p.t >= b) continue;
        const x = p.t - a;
        c += Math.abs(x - Math.min(b - a, Math.round(x / q) * q)) * p.w;
      }
      return c;
    };
    const cD = cost(0, W, qd);
    if (mode !== 'triplet' && cD <= 0) return D;
    const cands = [{ plan: [{ a: 0, b: W, q: W / 3, tup: true }], c: cost(0, W, W / 3) + TUP_PENALTY }];
    if (W === TQ && qd <= W / 4) {
      // 16th-note triplets per half beat (a full sextuplet is two of them), mixable with straight 16ths.
      const h = W / 2;
      const half = [0, h].map(a => ({ d: cost(a, a + h, qd), t: cost(a, a + h, h / 3) + 2 * TUP_PENALTY }));
      [[1, 0], [0, 1], [1, 1]].forEach(([x, y]) => cands.push({
        plan: [{ a: 0, b: h, q: x ? h / 3 : qd, tup: !!x }, { a: h, b: W, q: y ? h / 3 : qd, tup: !!y }],
        c: (x ? half[0].t : half[0].d) + (y ? half[1].t : half[1].d),
      }));
    }
    let best = cands[0];
    cands.forEach(c => { if (c.c < best.c - 1e-9) best = c; });
    if (mode === 'triplet') return best.plan;
    if (best.c >= cD * TUP_RATIO) return D;
    // Evidence: onsets the tuplet reading explains clearly better. A lone one must sit (almost) exactly on the
    // tuplet grid; a humanized straight line drifting near a third of a beat stays straight.
    let n = 0, worst = 0;
    pts.forEach(p => {
      if (p.w < 1) return;
      const r = best.plan.find(r => p.t < r.b) || best.plan[best.plan.length - 1];
      if (!r.tup) return;
      const e = x => Math.abs(p.t - r.a - Math.min(r.b - r.a, Math.round((p.t - r.a) / x) * x));
      const et = e(r.q), ed = e(qd);
      if (et + 1 < ed) { n++; worst = Math.max(worst, et); }
    });
    return n >= 2 || (n === 1 && worst <= 1) ? best.plan : D;
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeId = s => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
  const abbr = name => { const w = String(name).trim(); return w.length <= 12 ? w : w.slice(0, 11) + '.'; };
  const lowerBound = (arr, x) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };

  /**
   * score: { title, timeSig:{num,den}, keyFifths (null = detect), lengthBeats?, measureOffset?, pickupBeats?,
   *          parts:[{ name, label?, grand?, clef? (['C',3] or {shape,line,dis,disPlace}),
   *                   transpose? (written = sounding + transpose semitones),
   *                   measureOverrides? (like opts.measureOverrides, for this part only; wins over opts),
   *                   altClefs? (clefs it may change to mid-staff), ottava? ({up, down} octaves, or false),
   *                   notes:[{id, start, dur, pitch, color?,
   *                           artic? (MEI artic list: 'stacc' 'stacciss' 'spicc' 'ten' 'acc' 'marc' 'snap' 'harm'...),
   *                           trem? (unmeasured tremolo slashes, 1-3), trill? (upper note interval in semitones)}],
   *                   slurs?:[{start, end}] (note ids), marks?:[{beat, text, kind: 'dir'|'dynam', italic?}],
   *                   hairpins?:[{start, end, form: 'cres'|'dim'}] (beats); marks and hairpins may carry an id
   *                   (MEI xml:id, so the SVG element can be found) }],
   *          directions?:[{ beat, text, kind: 'reh'|'tempo'|'dir', staff? }],
   *          timeSigChanges?:[{beat, num, den}], keyChanges?:[{beat, fifths}], tempo? (quarter bpm),
   *          tempoChanges?:[{beat, bpm, endBeat? (gradual)}], offsetBeats? (absolute beat of the first measure) }
   *          (start/dur/beat in quarter-note beats from the first rendered measure;
   *           pickupBeats > 0 makes the first measure an incomplete bar of that many beats)
   * opts:  { grid: grid units (TPQ = 8: 1 = 32nd, 2 = 16th, 4 = 8th), simplify, tuplets: 'auto'|'off',
   *          measureOverrides: { [measureNumber]: { grid, tuplets: 'auto'|'off'|'triplet', voices: 'auto'|'single', simplify } },
   *          clefChanges (default true), ottava (default true) }
   * returns { mei, keyFifths, timeline:[{svgId, srcId, start, end}], measureBeats (first meter), measures, measureOffset,
   *           staves:[{n, part, clef, fifths, transpose, clefs:[{beat, clef}], ottavas:[{start, end, shift}]}],
   *           pickupBeats, measureStarts / measureLengths (beats, per rendered measure), meters:[{measure, beat, num, den}],
   *           keyChanges:[{measure, beat, fifths}], offsetBeats, tuplets (count) }   (returned beats are absolute)
   */
  function buildMEI(score, opts) {
    opts = opts || {};
    const num = score.timeSig.num, den = score.timeSig.den;
    // Meter changes (beats in the score's time base) -> ticks; the first meter is score.timeSig.
    const meters = [{ tick: 0, num, den }];
    (score.timeSigChanges || []).forEach(c => {
      const tick = Math.round(c.beat * TQ);
      if (!(c.num > 0 && c.den > 0) || tick < 0) return;
      if (tick === 0) { meters[0] = { tick: 0, num: c.num, den: c.den }; return; }
      meters.push({ tick, num: c.num, den: c.den });
    });
    meters.sort((a, b) => a.tick - b.tick);
    const M = meterInfo(meters[0].num, meters[0].den).M; // first meter's bar length (measureBeats)
    const allNotes = [].concat(...score.parts.map(p => p.notes));
    const keyChanges = (score.keyChanges || []).filter(k => k && isFinite(k.beat) && isFinite(k.fifths))
      .map(k => ({ tick: Math.max(0, Math.round(k.beat * TQ)), fifths: Math.max(-7, Math.min(7, Math.round(k.fifths))) }))
      .sort((a, b) => a.tick - b.tick);
    const fifths = keyChanges.length && keyChanges[0].tick === 0 ? keyChanges[0].fifths
      : score.keyFifths == null ? detectFifths(allNotes) : score.keyFifths;
    // Key of a transposed staff: the enharmonic choice with fewer accidentals; at 6 vs 6 keep the concert key's side.
    const transposedFifths = (concert, semis) => {
      const base = (((concert + 7 * semis) % 12) + 12) % 12; // 0..11; the enharmonic twin is base - 12
      let best = null;
      for (let f = base - 12; f <= base; f += 12) {
        if (f < -7 || f > 7) continue;
        if (!best || Math.abs(f) < Math.abs(best) || (Math.abs(f) === Math.abs(best) && Math.sign(f) === Math.sign(concert || 1))) best = f;
      }
      return best;
    };
    const spellers = {};
    const spellerFor = f => spellers[f] || (spellers[f] = { spell: makeSpeller(f), kalt: keyAlters(f) });
    const mOff = score.measureOffset || 0; // first rendered measure, for numbering and timeline
    const pickupBeats = score.pickupBeats != null ? score.pickupBeats : opts.pickupBeats || 0;
    const P = pickupBeats > 0 && pickupBeats * TQ < M ? Math.round(pickupBeats * TQ) : 0;
    const lay = makeLayout(meters, P);
    // Absolute beat (ticks) of the first rendered measure: timeline and measureStarts are in absolute beats.
    const absOff = score.offsetBeats != null ? Math.round(score.offsetBeats * TQ) : mOff * M;
    const baseGrid = opts.grid || 2, baseTup = opts.tuplets || 'auto';
    const globalOv = opts.measureOverrides || {};

    // Effective rhythm settings for measure m (0-based) of part pi.
    const setCache = [];
    function settingsFor(pi, m) {
      const cache = setCache[pi] || (setCache[pi] = new Map());
      let s = cache.get(m);
      if (s) return s;
      const n = m + 1 + mOff, partOv = score.parts[pi].measureOverrides || {};
      const o = Object.assign({}, globalOv[n], partOv[n]), mi = lay.info(m);
      s = { q: Math.min(mi.W, Math.max(1, o.grid || baseGrid) * G), tup: mi.U ? o.tuplets || baseTup : 'off',
            single: o.voices === 'single', simplify: o.simplify != null ? !!o.simplify : !!opts.simplify };
      cache.set(m, s);
      return s;
    }

    let maxTick = Math.max(M, Math.round((score.lengthBeats || 0) * TQ));
    const timeline = [];
    let tupletCount = 0;

    // Quantizes one part: decide each beat's subdivision (straight or tuplet), then snap note edges to it.
    function quantizePart(part, pi) {
      const wins = new Map();
      const winAt = t => {
        const m = lay.of(t), ms = lay.start(m), W = lay.info(m).W, j = Math.floor((t - ms) / W), key = m * 1024 + j;
        let w = wins.get(key);
        if (!w) {
          const a = ms + j * W;
          w = { m, a, b: Math.min(a + W, ms + lay.len(m)), W, pts: [], plan: null };
          wins.set(key, w);
        }
        return w;
      };
      const raw = part.notes.map(n => ({ n, rs: n.start * TQ, re: (n.start + n.dur) * TQ }));
      raw.forEach(r => {
        winAt(r.rs).pts.push(r.rs, 1);
        const we = winAt(r.re);
        we.pts.push(r.re, r.re - r.rs <= we.W ? 0.5 : 0.25);
      });
      const planOf = w => {
        if (w.plan) return w.plan;
        const s = settingsFor(pi, w.m);
        let rel;
        if (w.b - w.a < w.W || s.tup === 'off') rel = [{ a: 0, b: w.b - w.a, q: Math.min(s.q, w.b - w.a), tup: false }];
        else {
          const pts = [];
          for (let i = 0; i < w.pts.length; i += 2) pts.push({ t: w.pts[i] - w.a, w: w.pts[i + 1] });
          rel = decideWindow(pts, w.W, s.q, s.tup);
        }
        return (w.plan = rel.map(r => ({ a: w.a + r.a, b: w.a + r.b, q: r.q, tup: r.tup })));
      };
      const subAt = t => {
        const plan = planOf(winAt(t));
        return plan.find(r => t < r.b) || plan[plan.length - 1];
      };
      const Q = t => {
        const r = subAt(t);
        return Math.min(r.a + Math.round((t - r.a) / r.q) * r.q, r.b);
      };
      const tr = part.transpose || 0;
      const qn = [];
      raw.forEach(({ n, rs, re }) => {
        const s = Q(rs);
        if (s < 0) return;
        let e = Q(re);
        if (e <= s) { const r = subAt(s); e = Math.min(s + r.q, r.b); }
        qn.push({ id: n.id, pitch: n.pitch + tr, s, e, color: n.color, artic: n.artic, trem: n.trem, trill: n.trill, ks: n.pitch < 24 });
      });

      // Tuplet regions; a pair a note sustains across is merged: two triplet beats -> one quarter-note
      // triplet, two 16th-triplet halves of a beat -> one sextuplet.
      const pointSet = new Set();
      qn.forEach(n => { pointSet.add(n.s); pointSet.add(n.e); });
      const crossed = x => !pointSet.has(x) && qn.some(n => n.s < x && n.e > x);
      const subs = [];
      [...wins.values()].sort((a, b) => a.a - b.a).forEach(w => planOf(w).forEach(r => { if (r.tup) subs.push({ ...r, m: w.m }); }));
      const regions = [];
      for (let i = 0; i < subs.length; i++) {
        const r = subs[i], nx = subs[i + 1];
        const W = lay.info(r.m).W;
        const reg = { a: r.a, b: r.b, unit: r.q, num: 3, numbase: 2, m: r.m, W };
        const isHalf = r.b - r.a < W;
        const sameBeat = Math.floor((r.a - lay.start(r.m)) / W) === Math.floor((r.b - lay.start(r.m)) / W);
        if (nx && nx.a === r.b && nx.m === r.m && nx.q === r.q && (!isHalf || sameBeat) && crossed(r.b)) {
          reg.b = nx.b;
          if (isHalf) { reg.num = 6; reg.numbase = 4; }
          i++;
        }
        regions.push(reg);
      }
      return { qn, regions };
    }

    // Staves: each part becomes 1 or 2 staves of quantized notes.
    const staves = [];
    const partStaffs = [];
    score.parts.forEach((part, pi) => {
      const pitches = part.notes.map(n => n.pitch);
      const { qn, regions } = quantizePart(part, pi);
      qn.forEach(n => { if (n.e > maxTick) maxTick = n.e; });
      const grand = part.grand != null ? part.grand : isGrandStaff(part.name, pitches);
      const lists = grand ? [qn.filter(n => n.pitch >= 60), qn.filter(n => n.pitch < 60)] : [qn];
      const clefs = grand ? [['G', 2], ['F', 4]] : [part.clef || chooseClef(part.name, pitches.map(p => p + (part.transpose || 0)))];
      const keyOf = f => part.noKeySig ? 0 : part.transpose ? transposedFifths(f, part.transpose) : f;
      const idxs = lists.map((notes, i) => {
        const clef = normClef(clefs[i]);
        // Alternative clefs for mid-staff changes: part.altClefs; an automatic clef (no part.clef) may also
        // switch between treble and bass, and so may grand staves.
        const alts = grand ? [clef.shape === 'G' ? ['F', 4] : ['G', 2]] : part.clef ? part.altClefs || [] : autoAltClefs(part.name, clef);
        staves.push({ n: staves.length + 1, notes, clef, alts: alts.map(normClef), part, fifths: keyOf(fifths), keyOf, pi, regions });
        return staves.length;
      });
      partStaffs.push({ part, idxs });
    });
    const nMeasures = Math.max(1, lay.of(maxTick - 1) + 1);
    const total = lay.start(nMeasures);

    // Voices: trim legato overlaps, group chords, assign chords to layers by pitch proximity.
    staves.forEach(st => {
      const S = t => settingsFor(st.pi, lay.of(t));
      const notes = st.notes.slice().sort((a, b) => a.s - b.s || b.pitch - a.pitch);
      const onsets = [...new Set(notes.map(n => n.s))].sort((a, b) => a - b);
      const nextOnset = s => { const i = lowerBound(onsets, s + 1); return i < onsets.length ? onsets[i] : Infinity; };
      // Bars read as a single voice: every note stops at the next onset.
      notes.forEach(n => { const o = nextOnset(n.s); if (o < n.e && S(o).single) n.e = o; });
      // Does another note that ends where b starts continue into b more smoothly than a does?
      const closerLine = (a, b, j, g) => {
        for (let k = j - 1; k >= 0 && notes[k].s > b.s - 4 * TQ; k--) {
          const c = notes[k];
          if (c !== a && c.s < b.s && Math.abs(c.e - b.s) <= g && Math.abs(c.pitch - b.pitch) < Math.abs(a.pitch - b.pitch)) return true;
        }
        return false;
      };
      for (let i = 0; i < notes.length; i++) {
        const a = notes[i], g = S(a.s).q;
        for (let j = i + 1; j < notes.length && notes[j].s < a.e; j++) {
          const b = notes[j];
          if (b.s <= a.s) continue;
          const ov = a.e - b.s;
          // Tiny overlaps always; up to half the note only when b continues a's line (a held bass stays held).
          if (ov <= g || (ov * 2 <= (a.e - a.s) + g && Math.abs(a.pitch - b.pitch) <= 12 && !closerLine(a, b, j, g))) { a.e = b.s; break; }
        }
      }
      notes.forEach(n => {
        // Simplify: lengthen short notes into small following gaps (staccato 16ths -> 8ths) for readability.
        if (!S(n.s).simplify) return;
        const len = n.e - n.s;
        if (len > TQ / 2) return;
        const nm = lay.of(n.s), ms = lay.start(nm), beat = lay.info(nm).beat;
        const beatEnd = ms + (Math.floor((n.s - ms) / beat) + 1) * beat;
        const limit = Math.min(nextOnset(n.e - 1), beatEnd);
        if (limit > n.e && limit - n.e <= len) n.e = limit;
      });
      // Chords: same onset and ends within a grid step (any ends in single-voice bars).
      const byStart = new Map();
      notes.forEach(n => { if (!byStart.has(n.s)) byStart.set(n.s, []); byStart.get(n.s).push(n); });
      const chords = [];
      byStart.forEach((group, s) => {
        const set = S(s), tol = set.single ? Infinity : set.q;
        group.sort((a, b) => a.e - b.e);
        let cur = null;
        group.forEach(n => {
          if (cur && n.e - cur.minE <= tol) { cur.notes.push(n); cur.maxE = n.e; return; }
          cur = { s, minE: n.e, maxE: n.e, notes: [n] };
          chords.push(cur);
        });
      });
      chords.forEach(c => { const nx = nextOnset(c.s); c.e = c.maxE <= nx ? c.maxE : Math.max(c.minE, nx); });
      chords.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
      const meanPitch = c => c.notes.reduce((s, n) => s + n.pitch, 0) / c.notes.length;
      const layers = [];
      chords.forEach(c => {
        const pc = meanPitch(c);
        let L = null, best = Infinity;
        layers.forEach(l => {
          if (l.end > c.s) return;
          const d = Math.abs(l.pitch - pc) + (c.s - l.end) / TQ;
          if (d < best) { best = d; L = l; }
        });
        if (!L) {
          // A small overlap with the previous note of a nearby line shortens it instead of opening a voice.
          const g = S(c.s).q;
          layers.forEach(l => {
            const last = l.items[l.items.length - 1], ov = l.end - c.s, d = Math.abs(l.pitch - pc);
            if (last.s >= c.s) return;
            if ((ov <= g || (ov * 4 <= last.e - last.s && d <= 12)) && d < best) { best = d; L = l; }
          });
          if (L) L.items[L.items.length - 1].e = c.s;
        }
        if (!L) {
          if (layers.length < 3) { L = { end: 0, items: [], pitch: pc }; layers.push(L); }
          else {
            L = layers.reduce((m, l) => l.end < m.end ? l : m);
            const last = L.items[L.items.length - 1];
            if (last.s >= c.s) { last.notes.push(...c.notes); return; }
            last.e = c.s;
          }
        }
        L.items.push(c); L.end = c.e; L.pitch = pc;
      });
      layers.forEach(l => l.items.forEach(c => c.notes.sort((a, b) => a.pitch - b.pitch)));
      // Highest layer first so voice 1 is the top line.
      const avg = l => l.items.reduce((s, c) => s + c.notes[c.notes.length - 1].pitch, 0) / l.items.length;
      layers.sort((a, b) => avg(b) - avg(a));
      st.layers = layers.length ? layers : [{ end: 0, items: [] }];
    });

    // Registers: mid-staff clef changes and ottava lines, decided per phrase with hysteresis.
    const clefChangesOn = opts.clefChanges !== false, ottavaOn = opts.ottava !== false;
    staves.forEach(st => {
      st.clefPlan = [{ tick: 0, clef: st.clef }];
      st.ottavas = [];
      const real = c => CLEF_REF[c.shape] != null;
      if (!real(st.clef)) return;
      const clefs = [st.clef];
      if (clefChangesOn) st.alts.forEach(c => { if (real(c) && !clefs.some(x => clefKey(x) === clefKey(c))) clefs.push(c); });
      const ott = ottavaOn ? ottavaRange(st) : { up: 0, down: 0 };
      if (clefs.length < 2 && !ott.up && !ott.down) return;
      const units = phraseUnits(st);
      if (!units.length) return;
      const { spell } = spellerFor(st.fifths);
      const dia = new Map();
      const diaOf = p => { let d = dia.get(p); if (d == null) { const s = spell(p); d = (s.oct + 1) * 7 + LETTERS.indexOf(s.pname) - 7; dia.set(p, d); } return d; };
      units.forEach(u => { u.d = u.pitches.map(diaOf); });
      // Clefs: the part's clef is preferred; later alternatives (e.g. treble after tenor for a cello) cost more.
      let path = units.map(() => 0);
      if (clefs.length > 1) {
        const bottoms = clefs.map(clefBottom);
        path = cheapestPath(units, clefs.length, (u, k) => {
          const U = units[u];
          // Notes that read fine in the part's own clef pay for being written in another one.
          let c = k && !u ? 1 : 0; // a part opens in its own clef unless the music says otherwise
          for (const d of U.d) {
            c += clefCost(ledgers(d, bottoms[k]));
            if (k) c += k * (ledgers(d, bottoms[0]) <= 2 ? 1 : 0.15);
          }
          return c;
        }, u => CLEF_SWITCH[units[u].kind]);
        // A change inside a stretch of rests goes to its last bar line (before the music it is for).
        // (Empty units cost nothing in any clef, so the change may sit anywhere in the rests at equal cost.)
        for (let u = 1; u < units.length; u++) {
          if (path[u] === path[u - 1]) continue;
          const from = path[u - 1], to = path[u];
          let r = u, v = u;
          while (r - 1 >= 1 && !units[r - 1].d.length) r--;
          while (v < units.length && !units[v].d.length) v++;
          if (v === units.length) { for (let x = r; x < v; x++) path[x] = from; break; } // nothing left to read
          const at = v - 1 >= r && units[v - 1].bar ? v - 1 : v;
          for (let x = r; x <= v; x++) path[x] = x < at ? from : to;
          u = Math.max(u, at);
        }
        let cur = 0;
        units.forEach((U, u) => {
          if (path[u] !== cur) { st.clefPlan.push({ tick: U.a, clef: clefs[path[u]] }); cur = path[u]; }
        });
        if (path[0] !== 0) st.clefPlan[0].clef = clefs[path[0]];
        if (st.clefPlan.length > 1 && st.clefPlan[1].tick === 0) st.clefPlan.shift();
        st.clef = st.clefPlan[0].clef;
      }
      // Ottavas on top of the chosen clefs: states 0, +1, +2 (8va, 15ma) or -1, -2 (8vb, 15mb) octaves.
      if (!ott.up && !ott.down) return;
      const shifts = [0];
      for (let k = 1; k <= ott.up; k++) shifts.push(k);
      for (let k = 1; k <= ott.down; k++) shifts.push(-k);
      const ob = units.map((U, u) => clefBottom(clefs[path[u]]));
      const opath = cheapestPath(units, shifts.length, (u, k) => {
        const U = units[u], sh = shifts[k];
        if (!sh) { let c = 0; for (const d of U.d) c += ottavaCost(ledgers(d, ob[u])); return c; }
        if (!U.d.length) return (U.b - U.a) / TQ;  // a line held through rests
        let c = Math.abs(sh);
        for (const d of U.d) c += ottavaCost(ledgers(d - 7 * sh, ob[u])) + LOCO_UNDER_OTTAVA(ledgers(d, ob[u]));
        if (U.d.every(d => ledgers(d, ob[u]) <= 2)) c += 3; // a phrase that doesn't need the line at all
        return c;
      }, u => OTTAVA_SWITCH[units[u].kind]);
      for (let u = 0; u < units.length;) {
        const sh = shifts[opath[u]];
        let v = u + 1;
        while (v < units.length && shifts[opath[v]] === sh) v++;
        if (sh) {
          const chords = [].concat(...units.slice(u, v).map(U => U.chords));
          if (chords.length) {
            chords.forEach(c => { c.ott = sh; });
            st.ottavas.push({ shift: sh, chords });
          }
        }
        u = v;
      }
    });

    // Phrase units of a staff: split at bar lines no note sounds across and at onsets after a rest of a beat or
    // more. Clef changes and ottava lines start and stop only at unit boundaries.
    function phraseUnits(st) {
      const chords = [];
      st.layers.forEach(L => L.items.forEach(c => chords.push(c)));
      if (!chords.length) return [];
      chords.sort((a, b) => a.s - b.s);
      const starts = chords.map(c => c.s), prefEnd = [];
      let mx = -Infinity;
      chords.forEach((c, i) => { mx = Math.max(mx, c.e); prefEnd[i] = mx; });
      const endBefore = T => { const i = lowerBound(starts, T); return i ? prefEnd[i - 1] : -Infinity; };
      const bounds = new Map([[0, 'phrase']]);
      chords.forEach((c, i) => { if (c.s > 0 && (i ? prefEnd[i - 1] : -Infinity) <= c.s - TQ) bounds.set(c.s, 'phrase'); });
      const bars = new Set();
      for (let m = 1; m < nMeasures; m++) {
        const T = lay.start(m), e = endBefore(T);
        if (e > T) continue;
        bars.add(T);
        if (!bounds.has(T)) {
          const i = lowerBound(starts, T), next = i < chords.length ? chords[i].s : Infinity;
          bounds.set(T, e <= T - TQ || next >= T + TQ ? 'phrase' : 'bar');
        }
      }
      const ticks = [...bounds.keys()].sort((a, b) => a - b);
      const units = ticks.map((a, i) => ({ a, b: i + 1 < ticks.length ? ticks[i + 1] : total, kind: bounds.get(a), bar: bars.has(a), chords: [], pitches: [] }));
      let u = 0;
      chords.forEach(c => {
        while (u + 1 < units.length && units[u + 1].a <= c.s) u++;
        units[u].chords.push(c);
        c.notes.forEach(n => { if (!n.ks) units[u].pitches.push(n.pitch); });
      });
      return units;
    }

    // Allowed ottava lines of a staff: part.ottava {up, down} (octaves) or false; default by clef.
    function ottavaRange(st) {
      const o = st.part.ottava;
      if (o === false) return { up: 0, down: 0 };
      if (o && typeof o === 'object') return { up: Math.min(2, o.up | 0), down: Math.min(2, o.down | 0) };
      return st.clef.shape === 'G' ? { up: 2, down: 0 } : st.clef.shape === 'F' ? { up: 0, down: 1 } : { up: 0, down: 0 };
    }

    // Layers -> per-measure pieces with ties. A tuplet region applies to a layer only where the layer has an
    // event boundary inside it (a note held under a triplet figure stays a plain value).
    const noteAt = new Map(); // src id -> { staff, n, first: {m, id, pos}, last: {m, id, pos} } (slurs, trills)
    staves.forEach(st => {
      st.measures = Array.from({ length: nMeasures }, () => []);
      st.layers.forEach((L, li) => {
        const gap = li === 0 ? 'rest' : 'space';
        const segs = [];
        let t = 0;
        L.items.forEach(c => {
          if (c.s > t) segs.push({ kind: gap, s: t, e: c.s });
          segs.push({ kind: 'chord', s: c.s, e: c.e, chord: c });
          t = c.e;
        });
        if (t < total) segs.push({ kind: gap, s: t, e: total });
        const bounds = segs.map(s => s.s);
        const active = new Map();
        st.regions.forEach(r => {
          const i = lowerBound(bounds, r.a + 1);
          if (i < bounds.length && bounds[i] < r.b) {
            if (!active.has(r.m)) active.set(r.m, []);
            active.get(r.m).push(r);
          }
        });
        const perMeasure = Array.from({ length: nMeasures }, () => []);
        segs.forEach(seg => {
          const pieces = [];
          const rest = seg.kind !== 'chord';
          for (let m = Math.max(0, lay.of(seg.s)); m < nMeasures && lay.start(m) < seg.e; m++) {
            const ms = lay.start(m), ml = lay.len(m), mi = lay.info(m);
            const a = Math.max(seg.s, ms), b = Math.min(seg.e, ms + ml);
            if (rest && a === ms && b === ms + ml && ml === mi.M) { pieces.push({ m, pos: 0, len: ml, wv: ml, whole: true }); continue; }
            const duple = (x, y) => {
              let pos = x - ms;
              decompose(pos, y - x, mi.beat, rest, mi.compound).forEach(v => { pieces.push({ m, pos, len: v, wv: v }); pos += v; });
            };
            let x = a;
            (active.get(m) || []).forEach(r => {
              if (r.b <= x || r.a >= b) return;
              if (r.a > x) { duple(x, r.a); x = r.a; }
              const y = Math.min(b, r.b), p = (x - r.a) / r.unit, k = (y - x) / r.unit;
              if (p % 1 || k % 1) { duple(x, y); x = y; return; }
              let pos = x - ms;
              decomposeTuplet(p, k, (r.b - r.a) / r.unit, rest).forEach(u => {
                pieces.push({ m, pos, len: u * r.unit, wv: u * r.unit * 3 / 2, tup: r });
                pos += u * r.unit;
              });
              x = y;
            });
            if (x < b) duple(x, b);
          }
          pieces.forEach((p, k) => {
            p.kind = seg.kind; p.chord = seg.chord; p.k = k;
            p.tie = pieces.length === 1 ? null : k === 0 ? 'i' : k === pieces.length - 1 ? 't' : 'm';
            perMeasure[p.m].push(p);
          });
          if (seg.kind === 'chord' && pieces.length) {
            const a = pieces[0], z = pieces[pieces.length - 1];
            seg.chord.notes.forEach(n => noteAt.set(n.id, {
              staff: st.n, n, first: { m: a.m, id: 'n' + safeId(n.id), pos: a.pos },
              last: { m: z.m, id: 'n' + safeId(n.id) + (z.k ? '-c' + z.k : ''), pos: z.pos + z.len } }));
          }
        });
        perMeasure.forEach((ps, m) => st.measures[m].push(ps));
      });
    });

    // Concert key per measure: key changes snap to the nearest bar line.
    const keyAt = new Array(nMeasures).fill(fifths);
    keyChanges.forEach(k => {
      let m = Math.max(0, lay.of(k.tick));
      if (m < nMeasures && k.tick - lay.start(m) > lay.len(m) / 2) m++;
      for (let x = m; x < nMeasures; x++) keyAt[x] = k.fifths;
    });

    // Emit MEI.
    const keySig = fifths === 0 ? '0' : Math.abs(fifths) + (fifths > 0 ? 's' : 'f');
    const dirsByMeasure = new Map();
    (score.directions || []).forEach(d => {
      const tick = Math.round(d.beat * TQ);
      const m = lay.of(tick);
      if (m < 0 || m >= nMeasures) return;
      if (!dirsByMeasure.has(m)) dirsByMeasure.set(m, []);
      dirsByMeasure.get(m).push({ ...d, tstamp: (tick - lay.start(m)) / lay.info(m).unit + 1 });
    });
    const ctlByMeasure = controlEvents();
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">');
    out.push('<meiHead><fileDesc><titleStmt><title>' + esc(score.title || 'Score') + '</title></titleStmt><pubStmt/></fileDesc></meiHead>');
    out.push('<music><body><mdiv><score>');
    out.push(`<scoreDef keysig="${keySig}" meter.count="${lay.first.num}" meter.unit="${lay.first.den}">`);
    // Parts with a `group` are bracketed per run of consecutive parts sharing it (barlines joined inside a
    // bracket, labelled when score.groupLabels); without groups the whole score gets one bracket.
    const grouped = partStaffs.some(ps => ps.part.group);
    out.push(grouped ? '<staffGrp bar.thru="false">' : '<staffGrp symbol="bracket" bar.thru="false">');
    const sigOf = f => f === 0 ? '0' : Math.abs(f) + (f > 0 ? 's' : 'f');
    const clefAttrs = (c, pre) => `${pre}shape="${c.shape}" ${pre}line="${c.line}"` +
      (c.dis ? ` ${pre}dis="${c.dis}" ${pre}dis.place="${c.disPlace || 'above'}"` : '');
    const staffDef = (st, label) =>
      `<staffDef n="${st.n}" lines="5" ${clefAttrs(st.clef, 'clef.')}` +
      (st.fifths !== fifths ? ` keysig="${sigOf(st.fifths)}"` : '') + '>' +
      (label ? `<label>${esc(label)}</label><labelAbbr>${esc(st.part.abbr || abbr(label))}</labelAbbr>` : '') + '</staffDef>';
    const partDef = ({ part, idxs }) => {
      const label = part.label || part.name;
      if (idxs.length > 1) {
        out.push(`<staffGrp symbol="brace" bar.thru="true"><label>${esc(label)}</label><labelAbbr>${esc(part.abbr || abbr(label))}</labelAbbr>`);
        idxs.forEach(i => out.push(staffDef(staves[i - 1], '')));
        out.push('</staffGrp>');
      } else out.push(staffDef(staves[idxs[0] - 1], label));
    };
    for (let i = 0; i < partStaffs.length;) {
      const g = partStaffs[i].part.group;
      let j = i + 1;
      while (g && j < partStaffs.length && partStaffs[j].part.group === g) j++;
      const run = partStaffs.slice(i, j);
      if (g && run.length > 1) {
        out.push('<staffGrp symbol="bracket" bar.thru="true">' +
          (score.groupLabels ? `<label><rend fontstyle="italic" fontweight="bold">${esc(g)}</rend></label><labelAbbr><rend fontstyle="italic" fontweight="bold">${esc(abbr(g))}</rend></labelAbbr>` : ''));
        run.forEach(partDef);
        out.push('</staffGrp>');
      } else run.forEach(partDef);
      i = j;
    }
    out.push('</staffGrp></scoreDef><section>');

    const durAttrs = v => `dur="${DUR[v][0]}"` + (DUR[v][1] ? ` dots="${DUR[v][1]}"` : '');
    // Clef changes: at a bar line the new clef ends the previous bar (before the bar line); inside a bar it
    // goes into layer 1 right where the phrase starts (layer clefs apply to the whole staff in Verovio).
    staves.forEach(st => {
      st.endClef = new Map(); st.midClef = new Map();
      st.clefPlan.slice(1).forEach(c => {
        const m = lay.of(c.tick), xml = `<clef ${clefAttrs(c.clef, '')}/>`;
        if (c.tick === lay.start(m) && m > 0) st.endClef.set(m - 1, xml);
        else st.midClef.set(m, { pos: c.tick - lay.start(m), xml });
      });
    });
    const meterChanges = [], keyChangesOut = [];
    for (let m = 0; m < nMeasures; m++) {
      const ms = lay.start(m), mi = lay.info(m);
      if (m > 0) {
        // Meter and key changes: a <scoreDef> before the measure (transposed / unkeyed staves get a staffDef).
        const pm = lay.info(m - 1), meterCh = mi.num !== pm.num || mi.den !== pm.den, keyCh = keyAt[m] !== keyAt[m - 1];
        if (meterCh) meterChanges.push({ measure: m + 1 + mOff, beat: (absOff + ms) / TQ, num: mi.num, den: mi.den });
        if (keyCh) keyChangesOut.push({ measure: m + 1 + mOff, beat: (absOff + ms) / TQ, fifths: keyAt[m] });
        if (meterCh || keyCh) {
          const own = keyCh ? staves.filter(st => st.keyOf(keyAt[m]) !== keyAt[m]) : [];
          out.push('<scoreDef' + (meterCh ? ` meter.count="${mi.num}" meter.unit="${mi.den}"` : '') +
            (keyCh ? ` keysig="${sigOf(keyAt[m])}"` : '') + (own.length ? '><staffGrp>' +
            own.map(st => `<staffDef n="${st.n}" keysig="${sigOf(st.keyOf(keyAt[m]))}"/>`).join('') + '</staffGrp></scoreDef>' : '/>'));
        }
      }
      out.push(`<measure n="${m + 1 + mOff}" xml:id="m${m + 1 + mOff}"` + (lay.len(m) !== mi.M ? ' metcon="false"' : '') +
        `${m === nMeasures - 1 ? ' right="end"' : ''}>`);
      staves.forEach(st => {
        // Accidentals are resolved in time order across all layers of the staff.
        const state = {};
        const { spell, kalt } = spellerFor(st.keyOf(keyAt[m]));
        const all = [];
        st.measures[m].forEach(ps => ps.forEach(p => { if (p.kind === 'chord') all.push(p); }));
        all.sort((a, b) => a.pos - b.pos);
        all.forEach(p => {
          const ott = p.chord.ott || 0;
          p.spelled = p.chord.notes.map(n => {
            const sp0 = spell(n.pitch), sp = ott ? { ...sp0, oct: sp0.oct - ott } : sp0;
            const key = sp.pname + sp.oct;
            const cur = key in state ? state[key] : kalt[sp.pname];
            let accid = null;
            if (p.tie !== 't' && p.tie !== 'm' && sp.alter !== cur) { accid = ACCID[sp.alter]; state[key] = sp.alter; }
            return { n, sp, accid, ges: ott ? sp0.oct : null };
          });
        });
        out.push(`<staff n="${st.n}" xml:id="m${m + 1 + mOff}s${st.n}">`);
        const midClef = st.midClef.get(m);
        st.measures[m].forEach((ps, li) => {
          if (li > 0 && ps.every(p => p.kind === 'space')) return;
          const items = [];
          let beam = [], tupItems = null, tupR = null;
          const emit = x => (tupItems || items).push(x);
          const flush = () => {
            if (beam.length > 1) emit('<beam>' + beam.map(b => b.xml).join('') + '</beam>');
            else beam.forEach(b => emit(b.xml));
            beam = [];
          };
          let lastTup = null;
          const closeTuplet = () => {
            if (!tupItems) return;
            const open = `<tuplet num="${tupR.num}" numbase="${tupR.numbase}">`;
            const beamed = tupItems.length === 1 && tupItems[0].startsWith('<beam>');
            const W = tupR.W;
            const t = { r: tupR, beamed, inner: beamed ? tupItems[0].slice(6, -7) : '', open, half: tupR.b - tupR.a < W && tupR.num === 3 };
            const prev = lastTup;
            if (t.half && beamed && prev && prev.idx === items.length - 1 && prev.half && prev.beamed && prev.r.b === tupR.a &&
                Math.floor((prev.r.a - ms) / W) === Math.floor((tupR.a - ms) / W)) {
              // Two 16th-triplet halves of one beat share a beam: "3 3" under one beam group.
              const hide = o => o.replace('>', ' bracket.visible="false">');
              items[prev.idx] = '<beam>' + hide(prev.open) + prev.inner + '</tuplet>' + hide(open) + t.inner + '</tuplet></beam>';
              lastTup = null;
            } else {
              items.push(open + tupItems.join('') + '</tuplet>');
              lastTup = { ...t, idx: items.length - 1 };
            }
            tupItems = null; tupR = null; tupletCount++;
          };
          let clefDone = li > 0 || !midClef;
          ps.forEach(p => {
            if (!clefDone && p.pos + p.len > midClef.pos) { flush(); emit(midClef.xml); clefDone = true; }
            if ((p.tup || null) !== tupR) {
              flush(); closeTuplet();
              if (p.tup) { tupItems = []; tupR = p.tup; }
            }
            let xml;
            if (p.kind === 'rest') xml = p.whole ? '<mRest/>' : `<rest ${durAttrs(p.wv)}/>`;
            else if (p.kind === 'space') xml = p.whole ? '<mSpace/>' : `<space ${durAttrs(p.wv)}/>`;
            else {
              const noteXml = (s, withDur) => {
                const id = 'n' + safeId(s.n.id) + (p.k ? '-c' + p.k : '');
                const startBeat = (absOff + ms + p.pos) / TQ;
                timeline.push({ svgId: id, srcId: s.n.id, start: startBeat, end: startBeat + p.len / TQ });
                let a = `<note xml:id="${id}" pname="${s.sp.pname}" oct="${s.sp.oct}"`;
                if (s.ges != null) a += ` oct.ges="${s.ges}"`;
                if (withDur) a += ' ' + durAttrs(p.wv);
                if (s.accid) a += ` accid="${s.accid}"`;
                else if (s.sp.alter) a += ` accid.ges="${ACCID[s.sp.alter]}"`;
                if (p.tie) a += ` tie="${p.tie}"`;
                if (s.n.color) a += ` color="${esc(s.n.color)}"`;
                if (withDur) a += extra;
                return a + '/>';
              };
              // Articulations sit on the attack only; tremolo slashes on every tied piece.
              const ns = p.chord.notes;
              const artic = p.tie === 't' || p.tie === 'm' ? '' : [...new Set(ns.map(n => n.artic).filter(Boolean).join(' ').split(/\s+/).filter(Boolean))].join(' ');
              // Unmeasured tremolo: slashes plus the value's own beams/flags make `trem` strokes in total.
              const flags = Math.max(0, Math.log2(parseInt(DUR[p.wv][0], 10)) - 2);
              const trem = Math.max(0, Math.max(0, ...ns.map(n => n.trem || 0)) - flags);
              const extra = (artic ? ` artic="${esc(artic)}"` : '') + (trem ? ` stem.mod="${Math.min(trem, 6)}slash"` : '');
              xml = p.spelled.length === 1 ? noteXml(p.spelled[0], true)
                : `<chord ${durAttrs(p.wv)}${extra}>` + p.spelled.map(s => noteXml(s, false)).join('') + '</chord>';
              if (trem) xml = '<bTrem>' + xml + '</bTrem>';
            }
            const beamable = p.kind === 'chord' && p.wv < TQ;
            const win = p.tup ? -1 : Math.floor(p.pos / mi.beamWin);
            if (beamable && beam.length && beam[0].win === win) beam.push({ xml, win });
            else { flush(); if (beamable) beam.push({ xml, win }); else emit(xml); }
          });
          flush(); closeTuplet();
          if (li === 0 && st.endClef.has(m)) items.push(st.endClef.get(m));
          out.push(`<layer n="${li + 1}">` + items.join('') + '</layer>');
        });
        out.push('</staff>');
      });
      (dirsByMeasure.get(m) || []).forEach(d => {
        const tag = d.kind === 'reh' ? 'reh' : d.kind === 'tempo' ? 'tempo' : 'dir';
        out.push(`<${tag} staff="${d.staff || 1}" tstamp="${d.tstamp}" place="above">${esc(d.text)}</${tag}>`);
      });
      (ctlByMeasure.get(m) || []).forEach(x => out.push(x));
      out.push('</measure>');
    }
    out.push('</section></score></mdiv></body></music></mei>');

    // Per-part control events (articulation module): slurs, trills, dynamics, technique text, hairpins.
    function controlEvents() {
      const ctl = new Map();
      const add = (m, x) => { if (m < 0 || m >= nMeasures) return; if (!ctl.has(m)) ctl.set(m, []); ctl.get(m).push(x); };
      const ts = (tick, m) => +((tick - lay.start(m)) / lay.info(m).unit + 1).toFixed(4);
      // optional MEI id on marks and hairpins (features/dynamics.js finds its own in the SVG by id)
      const xmlId = id => (id && /^[A-Za-z_][\w.-]*$/.test(id) ? ` xml:id="${id}"` : '');
      const tstamp2 = (tick, m0) => { const me = Math.min(lay.of(tick - 1), nMeasures - 1); return `${me - m0}m+${ts(tick, me)}`; };
      partStaffs.forEach(({ part, idxs }) => {
        const staff = idxs[0];
        (part.slurs || []).forEach(sl => {
          const a = noteAt.get(sl.start), b = noteAt.get(sl.end);
          if (!a || !b || a === b || a.staff !== b.staff) return;
          add(a.first.m, `<slur staff="${a.staff}" startid="#${a.first.id}" endid="#${b.last.id}"/>`);
        });
        (part.marks || []).forEach(mk => {
          const tick = Math.round(mk.beat * TQ);
          if (tick < 0 || !mk.text) return;
          const m = lay.of(tick);
          if (mk.kind === 'dynam') add(m, `<dynam${xmlId(mk.id)} staff="${staff}" tstamp="${ts(tick, m)}" place="below">${esc(mk.text)}</dynam>`);
          else {
            const t = mk.italic === false ? esc(mk.text) : `<rend fontstyle="italic">${esc(mk.text)}</rend>`;
            add(m, `<dir staff="${staff}" tstamp="${ts(tick, m)}" place="above">${t}</dir>`);
          }
        });
        (part.hairpins || []).forEach(h => {
          const s = Math.round(h.start * TQ), e = Math.round(h.end * TQ);
          if (s < 0 || e <= s) return;
          const ms = lay.of(s), me = Math.min(lay.of(e - 1), nMeasures - 1);
          add(ms, `<hairpin${xmlId(h.id)} form="${h.form === 'dim' ? 'dim' : 'cres'}" staff="${staff}" tstamp="${ts(s, ms)}" ` +
                  `tstamp2="${me - ms}m+${ts(Math.min(e, lay.start(me) + lay.len(me)), me)}" place="below"/>`);
        });
      });
      noteAt.forEach(a => {
        if (!a.n.trill) return;
        const st = staves[a.staff - 1], { spell, kalt } = spellerFor(st.keyOf(keyAt[a.first.m]));
        const sp = spell(a.n.pitch), li = LETTERS.indexOf(sp.pname), up = LETTERS[(li + 1) % 7];
        const natural = (sp.oct + (li === 6 ? 1 : 0) + 1) * 12 + LETTER_PC[up];
        const alter = a.n.pitch + a.n.trill - natural;
        const accid = Math.abs(alter) <= 2 && alter !== kalt[up] ? ` accidupper="${ACCID[alter]}"` : '';
        // Long notes get a wavy extender to (nearly) the end of the note.
        let ext = '';
        if (a.n.e - a.n.s >= TQ * 2) {
          const e = a.n.e - TQ / 4, me = Math.min(lay.of(e - 1), nMeasures - 1);
          ext = ` extender="true" tstamp2="${me - a.first.m}m+${ts(e, me)}"`;
        }
        add(a.first.m, `<trill staff="${a.staff}" startid="#${a.first.id}"` + ext + accid + '/>');
      });
      // Ottava lines: from the first note to the end of the last note of the span.
      staves.forEach(st => st.ottavas.forEach(o => {
        let first = null, last = null;
        o.chords.forEach(c => {
          if (!first || c.s < first.s) first = c;
          if (!last || c.e > last.e) last = c;
        });
        const a = noteAt.get(first.notes[0].id), b = noteAt.get(last.notes[0].id);
        if (!a || !b) return;
        const dis = Math.abs(o.shift) === 2 ? 15 : 8;
        o.start = first.s; o.end = last.e;
        add(a.first.m, `<octave staff="${st.n}" startid="#${a.first.id}" endid="#${b.last.id}" dis="${dis}" ` +
                       `dis.place="${o.shift > 0 ? 'above' : 'below'}"/>`);
      }));
      tempoMarks().forEach(t => {
        const m = lay.of(t.tick);
        if (m < 0 || m >= nMeasures) return;
        if (t.text) {
          add(m, `<dir staff="1" tstamp="${ts(t.tick, m)}"` + (t.end > t.tick ? ` tstamp2="${tstamp2(t.end, m)}" extender="true" lform="dashed"` : '') +
                 ` place="above"><rend fontstyle="italic">${esc(t.text)}</rend></dir>`);
          return;
        }
        const mi = lay.info(m), U = mi.compound ? ['♩.', 4, 1, 1.5] : mi.den === 2 ? ['𝅗𝅥', 2, 0, 2] : ['♩', 4, 0, 1];
        const v = Math.round(t.bpm / U[3]);
        add(m, `<tempo staff="1" tstamp="${ts(t.tick, m)}" place="above" mm="${v}" mm.unit="${U[1]}"` + (U[2] ? ' mm.dots="1"' : '') +
               ` midi.bpm="${Math.round(t.bpm * 100) / 100}">${U[0]} = ${v}</tempo>`);
      });
      return ctl;
    }

    // Tempo marks from score.tempo (quarter-note bpm at the start) and score.tempoChanges [{beat, bpm, endBeat?}]
    // (endBeat: a gradual change reaching bpm there -> "accel."/"rit." with a dashed line, then the new mark).
    // Positions snap to the beat, and to the bar line when within a beat of it.
    function tempoMarks() {
      const marks = [];
      const snap = beat => {
        let t = Math.round(beat) * TQ;
        const m = lay.of(t), a = lay.start(m), b = a + lay.len(m);
        if (t - a <= TQ) t = a; else if (b - t <= TQ && m + 1 < nMeasures) t = b;
        return Math.max(0, t);
      };
      const userTempoAt0 = (score.directions || []).some(d => d.kind === 'tempo' && Math.round(d.beat * TQ) <= 0);
      let cur = score.tempo > 0 ? score.tempo : null;
      if (cur && !userTempoAt0) marks.push({ tick: 0, bpm: cur });
      (score.tempoChanges || []).filter(c => c && c.bpm > 0 && isFinite(c.beat))
        .sort((a, b) => a.beat - b.beat).forEach(c => {
          if (cur != null && Math.round(c.bpm) === Math.round(cur)) { cur = c.bpm; return; }
          const t0 = snap(c.beat);
          if (c.endBeat != null && c.endBeat - c.beat >= 1 && cur != null) {
            const t1 = snap(c.endBeat);
            if (t1 > t0) marks.push({ tick: t0, end: t1, text: c.bpm > cur ? 'accel.' : 'rit.' });
            marks.push({ tick: Math.max(t1, t0), bpm: c.bpm });
          } else marks.push({ tick: t0, bpm: c.bpm });
          cur = c.bpm;
        });
      return marks.filter(t => t.tick < total);
    }

    const beatsOf = t => (absOff + t) / TQ;
    return { mei: out.join('\n'), keyFifths: fifths, timeline, measureBeats: M / TQ, measures: nMeasures, measureOffset: mOff,
             staves: staves.map(st => ({ n: st.n, part: st.part.name, clef: st.clef, fifths: st.fifths, transpose: st.part.transpose || 0,
                                        clefs: st.clefPlan.map(c => ({ beat: beatsOf(c.tick), clef: c.clef })),
                                        ottavas: st.ottavas.filter(o => o.end != null).map(o => ({ start: beatsOf(o.start), end: beatsOf(o.end), shift: o.shift })) })),
             pickupBeats: P / TQ, measureStarts: Array.from({ length: nMeasures }, (_, m) => (absOff + lay.start(m)) / TQ),
             measureLengths: Array.from({ length: nMeasures }, (_, m) => lay.len(m) / TQ),
             meters: [{ measure: 1 + mOff, beat: absOff / TQ, num: lay.first.num, den: lay.first.den }].concat(meterChanges),
             keyChanges: keyChangesOut, offsetBeats: absOff / TQ, tuplets: tupletCount };
  }

  // ---- Helpers for render consumers (render = buildMEI's result, beats absolute like the timeline).
  /** Measure number containing beat. */
  function measureAt(render, beat) {
    const ms = render.measureStarts || [];
    if (!ms.length || beat < ms[0]) return Math.floor((beat - (render.offsetBeats || 0)) / render.measureBeats) + 1 + (render.measureOffset || 0);
    let i = lowerBound(ms, beat + 1e-9) - 1;
    if (i === ms.length - 1) {
      const len = (render.measureLengths && render.measureLengths[i]) || render.measureBeats;
      i += Math.floor((beat - ms[i]) / len);
    }
    return i + 1 + (render.measureOffset || 0);
  }
  /** { start, beats } of measure number n (beats absolute). */
  function measureSpan(render, n) {
    const i = n - 1 - (render.measureOffset || 0), ms = render.measureStarts || [];
    if (i >= 0 && i < ms.length) return { start: ms[i], beats: render.measureLengths ? render.measureLengths[i] : render.measureBeats };
    return { start: (n - 1) * render.measureBeats, beats: render.measureBeats };
  }
  /** Clef of a render staff at beat (staves[].clefs; falls back to staff.clef). */
  function clefAt(staff, beat) {
    let c = staff.clef;
    (staff.clefs || []).forEach(x => { if (x.beat <= beat + 1e-9) c = x.clef; });
    return c;
  }
  /** Octaves the staff is shifted by an ottava line at beat (+1 = 8va: sounding = written + 12). */
  function ottavaAt(staff, beat) {
    const o = (staff.ottavas || []).find(x => x.start <= beat + 1e-9 && beat < x.end - 1e-9);
    return o ? o.shift : 0;
  }

  function normClef(c) {
    return Array.isArray(c) ? { shape: c[0], line: c[1] } : c;
  }

  // Pitch one scale step up (dir=1) or down (dir=-1) from p in the major key with this signature.
  function diatonicStep(p, fifths, dir) {
    const tonic = ((fifths * 7) % 12 + 12) % 12;
    const scale = [0, 2, 4, 5, 7, 9, 11].map(i => (i + tonic) % 12);
    let x = p + dir;
    while (!scale.includes(((x % 12) + 12) % 12)) x += dir;
    return x;
  }

  const api = { buildMEI, detectFifths, diatonicStep, makeSpeller, measureAt, measureSpan, clefAt, ottavaAt, TPQ, TICKS_PER_QUARTER: TQ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScoreBuilder = api;
})(this);
