// Feature module: articulations and dynamics (issue #9). See docs/AGENTS.md for the SV hook API.
//
// Articulations: BBC Symphony Orchestra (and similar libraries) switch articulations with keyswitch notes below
// C1 in the clip. Each part gets a key -> articulation table (from the full DAWproject export's plugin states,
// a built-in BBC SO Core table per instrument, or the user's override). Every note gets the articulation of the
// latest keyswitch at (or just after) its start -- BBC SO keyswitches latch, held or short -- and is engraved
// accordingly: dots/wedges/accents/tenuto, tremolo slashes, trills, slurs over legato phrases, and technique text
// (pizz./arco, con sord./senza sord., sul pont./ord. ...) printed only where the technique changes.
// Dynamics: marks (pp..ff, with hysteresis) and hairpins from the export's "Dynamics"/"Expression" automation
// (CC1/CC11 as fallback) and note velocities (shorts, or when there is no automation).
// Write-back (live clip): palette on note click and Shift+S/U/I/T/A/N/R insert the keyswitch before the
// selected notes, remove the ones the selection makes redundant, and restore the previous articulation after it.
//
// Node: const A = require('web/features/articulations.js') exposes the pure functions (resolve, annotate,
// deriveDynamics, planWriteBack, ...).
(function (root) {
  'use strict';

  const KS_MAX = 24; // keyswitches sit below C1 (the same threshold as "Hide keyswitches")

  // ------------------------------------------------------------------ built-in tables (BBC SO Core keyswitch order)

  const list = names => { const m = {}; names.forEach((n, k) => { if (n) m[k] = n; }); return m; };
  const STRINGS = ['Legato', 'Long', 'Long CS', 'Long Flautando', 'Short Spiccato', 'Short Staccato', 'Short Pizzicato',
    'Short Col Legno', 'Tremolo', 'Trill (Major 2nd)', 'Trill (Minor 2nd)', 'Long Sul Tasto', 'Long Harmonics',
    'Short Harmonics', 'Short Pizzicato Bartok', 'Long Marcato Attack', 'Tremolo Sul Pont', 'Tremolo CS', 'Long Sul Pont',
    'Short Spiccato CS'];
  const BRASS_BASE = ['Legato', 'Long', 'Short Staccatissimo', 'Short Marcato', 'Long Cuivre', 'Long Sfz', 'Long Flutter', 'Multitongue'];
  const MUTED = ['Long (Muted)', 'Short Staccatissimo (Muted)', 'Short Marcato (Muted)'];
  const WINDS = ['Legato', 'Long', 'Trill (Major 2nd)', 'Trill (Minor 2nd)', 'Short Staccatissimo', 'Short Tenuto', 'Short Marcato', 'Long Flutter', 'Multitongue'];
  const PRESETS = {
    strings: { name: 'Strings (BBC SO Core)', map: list(STRINGS) },
    brass: { name: 'Horns / Trumpets (BBC SO Core)', map: list(BRASS_BASE.concat(['Trill (Major 2nd)', 'Trill (Minor 2nd)'], MUTED)) },
    trombones: { name: 'Trombones (BBC SO Core)', map: list(BRASS_BASE.concat(MUTED)) },
    tuba: { name: 'Tuba (BBC SO Core)', map: list(BRASS_BASE) },
    winds: { name: 'Flutes / Clarinets (BBC SO Core)', map: list(WINDS) },
    piccolo: { name: 'Piccolo (BBC SO Core)', map: list(WINDS.concat(['Rips', 'Falls'])) },
    oboe: { name: 'Oboes (BBC SO Core)', map: list(WINDS.slice(0, 7).concat([null, 'Multitongue'])) },
    bassoon: { name: 'Bassoons (BBC SO Core)', map: list(WINDS.slice(0, 8)) },
    harp: { name: 'Harp (BBC SO Core)', map: list(['Short Sustained', 'Short Damped', 'Short Damped Medium', 'Long Bisbigliando Trem', 'Short Gliss']) },
    timpani: { name: 'Timpani (BBC SO Core)', map: list(['Short Hits', 'Long Rolls', 'Short Hits Soft', 'Long Rolls Soft', 'Short Hits Hotrods',
      'Long Rolls Hotrods', 'Short Hits Damped', 'Short Hits Super Damped', 'Hotrods Hits Damped', 'Short Hits Damped Soft']) },
  };
  const BY_INSTRUMENT = {
    violin: 'strings', viola: 'strings', cello: 'strings', doublebass: 'strings',
    horn: 'brass', trumpet: 'brass', 'trumpet-c': 'brass', piccolotrumpet: 'brass',
    trombone: 'trombones', basstrombone: 'trombones', tuba: 'tuba', cimbasso: 'tuba',
    flute: 'winds', altoflute: 'winds', bassflute: 'winds', clarinet: 'winds', 'clarinet-a': 'winds', 'clarinet-eb': 'winds',
    bassclarinet: 'winds', piccolo: 'piccolo', oboe: 'oboe', coranglais: 'oboe', bassoon: 'bassoon', contrabassoon: 'bassoon',
    harp: 'harp', timpani: 'timpani',
  };
  const NAME_RULES = [
    [/viol|vln|vla|cell|vc\b|bass(es)?\b(?!.*(trom|clar|tuba|flute|drum))|contrabass|string/i, 'strings'],
    [/b(a)?s(s)?\.?\s*trom|tn\.?\s*trom|trombon|tbn/i, 'trombones'],
    [/horn|hn\b|trumpet|tumpet|tpt/i, 'brass'],
    [/tuba|cimbasso/i, 'tuba'], [/picc/i, 'piccolo'], [/flute|clarinet|cl\b|fl\b/i, 'winds'],
    [/oboe|anglais/i, 'oboe'], [/bassoon|basoon|fagot/i, 'bassoon'], [/harp/i, 'harp'], [/timp/i, 'timpani'],
  ];
  const cleanName = n => String(n || '').replace(/\s*✎\s*$/, '').trim();

  function presetFor(instrumentId, name) {
    if (instrumentId && BY_INSTRUMENT[instrumentId]) return BY_INSTRUMENT[instrumentId];
    const r = NAME_RULES.find(([re]) => re.test(name || ''));
    return r ? r[1] : null;
  }

  // ------------------------------------------------------------------ what an articulation name means on paper

  // -> { artic, trem, trill, slur, play, mute, label, dyn, short, family }
  //    play: bowing/technique state ('pizz.', 'col legno', 'sul pont.', 'sul tasto', 'flaut.', 'cuivré', 'snap'), null = ord.
  //    mute: con sord.; label: text shown when a run of this articulation starts (spicc., flz., ...).
  function classify(name, family) {
    const s = String(name || '').toLowerCase();
    const d = { artic: null, trem: 0, trill: 0, slur: false, play: null, mute: false, label: null, dyn: null, short: /short|stacc|spicc|pizz|marcato|hits/.test(s) };
    const artic = [];
    const labels = [];
    if (family === 'percussion') { d.label = name; return d; }
    if (/legato/.test(s)) d.slur = true;
    if (/bart/.test(s)) { artic.push('snap'); d.play = 'snap'; } else if (/pizz/.test(s)) d.play = 'pizz.';
    if (/col legno/.test(s)) d.play = 'col legno';
    if (/sul pont/.test(s)) d.play = 'sul pont.';
    if (/sul tasto/.test(s)) d.play = 'sul tasto';
    if (/flautando/.test(s)) d.play = 'flaut.';
    if (/cuivr/.test(s)) d.play = 'cuivré';
    if (/\bcs\b|muted|con sord/.test(s)) d.mute = true;
    if (/spicc/.test(s)) { artic.push('stacc'); labels.push('spicc.'); }
    else if (/staccatissimo/.test(s)) artic.push('stacciss');
    else if (/staccato/.test(s)) artic.push('stacc');
    if (/tenuto/.test(s)) artic.push('ten');
    if (/marcato attack/.test(s)) artic.push('acc');
    else if (/marcato/.test(s)) artic.push('marc');
    if (/harmonic/.test(s)) { artic.push('harm'); if (/short/.test(s)) artic.push('stacc'); }
    if (/sfz/.test(s)) d.dyn = 'sfz';
    if (/trem|roll|bisbig/.test(s)) d.trem = 3;
    if (/flutter/.test(s)) { d.trem = 3; labels.push('flz.'); }
    if (/multi.?tongue/.test(s)) { d.trem = 3; labels.push('multi-tongue'); }
    if (/bisbig/.test(s)) labels.push('bisb.');
    if (/trill/.test(s)) d.trill = /minor|m2\b/.test(s) ? 1 : 2;
    if (/hotrod/.test(s)) labels.push('hot rods');
    else if (/soft/.test(s) && /hit|roll/.test(s)) labels.push('soft sticks');
    if (/super damped/.test(s)) labels.push('very damp.');
    else if (/damped/.test(s)) labels.push(family === 'harp' ? 'étouffé' : 'damp.');
    if (/gliss/.test(s)) labels.push('gliss.');
    if (/\brips?\b/.test(s)) labels.push('rip');
    if (/\bfalls?\b/.test(s)) labels.push('fall');
    d.artic = artic.length ? artic.join(' ') : null;
    d.label = labels.length ? labels.join(', ') : null;
    return d;
  }

  // ------------------------------------------------------------------ keyswitch -> articulation per note

  const TOL = 1 / 16; // a keyswitch up to a 64th after a note's start still applies to it (recorded slightly late)

  /**
   * notes: musical notes [{id, start, dur}], keyswitches: [{start, dur, pitch}] (any order), map {key: name}.
   * opts.heldRevert: a keyswitch held longer than a beat ends at its release (back to the latched one before);
   *   default false = BBC SO behaviour (every keyswitch latches until the next).
   * Returns Map(note id -> articulation name | null (no keyswitch yet)).
   */
  function resolve(notes, keyswitches, map, opts) {
    opts = opts || {};
    const ks = (keyswitches || []).filter(k => map[k.pitch] != null).slice().sort((a, b) => a.start - b.start);
    const out = new Map();
    notes.forEach(n => {
      let cur = null, i = -1;
      for (let j = 0; j < ks.length && ks[j].start <= n.start + TOL; j++) i = j;
      if (i >= 0) {
        cur = map[ks[i].pitch];
        if (opts.heldRevert) {
          // Walk back while the latest switch was a held one that has already been released.
          let j = i;
          while (j >= 0 && ks[j].dur > 1 && ks[j].start + ks[j].dur <= n.start + 1e-6) j--;
          cur = j >= 0 ? map[ks[j].pitch] : null;
        }
      }
      out.set(n.id, cur);
    });
    return out;
  }

  /**
   * Annotates one part's notes. part: { notes, keyswitches? } (keyswitches may also be inside notes when they are
   * shown). opts: { family ('strings'|'brass'|'percussion'|...), heldRevert }.
   * Returns { notes (copies with artic/trem/trill), marks [{beat, text, kind}], slurs [{start, end}], arts Map, descs Map }.
   */
  function annotate(part, map, opts) {
    opts = opts || {};
    const family = opts.family || null;
    const isKs = n => n.pitch < KS_MAX;
    const seen = new Set();
    const ks = [];
    (part.keyswitches || []).concat(part.notes.filter(isKs)).forEach(k => { if (!seen.has(k.id)) { seen.add(k.id); ks.push(k); } });
    const mus = part.notes.filter(n => !isKs(n));
    const arts = resolve(mus, ks, map, opts);
    const descs = new Map();
    const cache = {};
    const descOf = a => a == null ? null : (cache[a] || (cache[a] = classify(a, family)));
    const notes = part.notes.map(n => {
      if (isKs(n)) return n;
      const d = descOf(arts.get(n.id));
      descs.set(n.id, d);
      if (!d || (!d.artic && !d.trem && !d.trill)) return n;
      const c = Object.assign({}, n);
      if (d.artic) c.artic = d.artic;
      if (d.trem) c.trem = d.trem;
      if (d.trill) c.trill = d.trill;
      return c;
    });

    // Onsets (chords) in time order.
    const groups = [];
    mus.slice().sort((a, b) => a.start - b.start || b.pitch - a.pitch).forEach(n => {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.start - n.start) < 1e-3) { g.notes.push(n); g.end = Math.max(g.end, n.start + n.dur); }
      else groups.push({ start: n.start, end: n.start + n.dur, notes: [n] });
    });

    // Technique text only where it changes.
    const marks = [], slurs = [];
    // A keyswitch on its note's attack does not fire (the note keeps the previous articulation): flag it.
    const late = lateKeyswitches(mus, ks, map);
    [...new Set(late.map(l => l.note.start))].forEach(b => marks.push({ beat: b, text: '⚠ ks', kind: 'dir', late: true }));
    const brass = family === 'brass';
    const st = { play: null, mute: false, label: null };
    groups.forEach(g => {
      const d = descOf(arts.get(g.notes[0].id));
      if (!d) return;
      const texts = [];
      if (d.play !== st.play) {
        const wasPizz = st.play === 'pizz.' || st.play === 'snap';
        if (d.play === 'snap') { if (st.play && !wasPizz) texts.push('ord.'); }
        else if (d.play) texts.push((wasPizz && /sul|flaut/.test(d.play) ? 'arco ' : '') + d.play);
        else texts.push(wasPizz ? 'arco' : 'ord.');
        st.play = d.play;
      }
      if (d.mute !== st.mute) { texts.push(d.mute ? 'con sord.' : brass ? 'open' : 'senza sord.'); st.mute = d.mute; }
      if (d.label !== st.label) { if (d.label) texts.push(d.label); st.label = d.label; }
      if (texts.length) marks.push({ beat: g.start, text: texts.join(' '), kind: 'dir' });
      if (d.dyn) marks.push({ beat: g.start, text: d.dyn, kind: 'dynam', sfz: true });
    });

    // Slurs over consecutive legato notes (opts.slurs, default true; the page's setting slurLegato is off by default:
    // phrasing slurs are the composer's); a rest (gap over a 16th) or another articulation breaks them.
    let run = [];
    const flush = () => {
      if (run.length > 1 && opts.slurs !== false) {
        const top = g => g.notes.reduce((a, b) => (b.pitch > a.pitch ? b : a));
        slurs.push({ start: top(run[0]).id, end: top(run[run.length - 1]).id });
      }
      run = [];
    };
    groups.forEach(g => {
      const d = descOf(arts.get(g.notes[0].id));
      const prev = run[run.length - 1];
      if (!d || !d.slur) { flush(); return; }
      if (prev && g.start - prev.end > 0.25) flush();
      run.push(g);
    });
    flush();
    return { notes, marks, slurs, arts, descs, late };
  }

  // ------------------------------------------------------------------ dynamics

  const BANDS = [0.12, 0.25, 0.38, 0.5, 0.62, 0.8];
  const DYN_NAMES = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff'];
  const HYST = 0.03;
  const bandOf = v => BANDS.filter(t => v >= t).length;
  const withHyst = (cur, v, h) => {
    if (cur == null) return bandOf(v);
    const lo = cur > 0 ? BANDS[cur - 1] : -Infinity, hi = cur < BANDS.length ? BANDS[cur] : Infinity;
    h = h == null ? HYST : h;
    return v >= lo - h && v < hi + h ? cur : bandOf(v);
  };

  // Piecewise-linear automation curve -> value at t. Several points at one time are a jump: the last one wins.
  function curveFn(points) {
    if (!points || !points.length) return null;
    const pts = points.map((p, i) => ({ t: p.t, v: p.v, i })).sort((a, b) => a.t - b.t || a.i - b.i);
    const scale = pts.some(p => p.v > 1.0001) ? 1 / 127 : 1;
    return t => {
      let lo = 0, hi = pts.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t <= t + 1e-9) lo = m + 1; else hi = m; }
      const i = lo - 1;
      if (i < 0) return pts[0].v * scale;
      if (i === pts.length - 1) return pts[i].v * scale;
      const a = pts[i], b = pts[i + 1];
      return (a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t)) * scale;
    };
  }

  /** Level curve (0..1) from DAWproject automation: Dynamics (else CC1, else Expression/CC11) x Expression. */
  function levelCurve(auto) {
    if (!auto) return null;
    const cc = auto.cc || {};
    const dyn = curveFn(auto.dynamics) || curveFn(cc[1]);
    const expr = curveFn(auto.expression) || curveFn(cc[11]);
    if (dyn && expr) return t => dyn(t) * (0.7 + 0.3 * expr(t));
    return dyn || expr || null;
  }

  /**
   * notes: musical notes [{id, start, dur, vel? (0..1)}] in render beats; opts: { level: t -> 0..1 (render beats) | null,
   * velocity: use velocities when there is no curve (default true), measureBeats,
   * skipBeats: Set of beats that already have a dynamic (sfz from the articulation) }.
   * Returns { marks: [{beat, text, kind: 'dynam'}], hairpins: [{start, end, form}] }.
   */
  function deriveDynamics(notes, opts) {
    opts = opts || {};
    const level = opts.level || null, useVel = opts.velocity !== false;
    const mb = opts.measureBeats || 4;
    const groups = [];
    notes.slice().sort((a, b) => a.start - b.start).forEach(n => {
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.start - n.start) < 1e-3) { g.notes.push(n); g.end = Math.max(g.end, n.start + n.dur); }
      else groups.push({ start: n.start, end: n.start + n.dur, notes: [n] });
    });
    if (!groups.length) return { marks: [], hairpins: [] };
    const velOf = g => { const v = g.notes.map(n => n.vel).filter(v => v != null); return v.length ? Math.max(...v) : null; };
    // Velocity is phrase-level information: the mean over a 4-beat window (accent patterns cancel out).
    const rawVel = groups.map(velOf);
    const smoothVel = groups.map(g => {
      let s = 0, k = 0;
      groups.forEach((h, j) => { if (h.start >= g.start - 2 && h.start < g.start + 2 && rawVel[j] != null) { s += rawVel[j]; k++; } });
      return k ? s / k : null;
    });
    groups.forEach((g, i) => {
      if (level) { g.v = level(g.start); g.src = 'curve'; }
      else if (useVel && smoothVel[i] != null) { g.v = smoothVel[i]; g.src = 'vel'; }
      else g.v = null;
    });
    const valued = groups.filter(g => g.v != null);
    if (!valued.length) return { marks: [], hairpins: [] };

    // Hairpins: sustained ramps of the curve (sampled every 1/4 beat), or of smoothed velocities.
    const hairpins = [];
    const addHairpin = (t0, v0, t1, v1) => {
      if (Math.abs(v1 - v0) < 0.08 || t1 - t0 < 1 || bandOf(v0) === bandOf(v1)) return;
      const sounding = groups.find(g => g.start <= t0 + 1e-6 && g.end > t0 + 1e-6);
      const first = sounding || groups.find(g => g.start >= t0 - 1e-6 && g.start < t1);
      if (!first) return;
      const inside = groups.filter(g => g.start < t1 - 1e-6 && g.end > t0);
      const start = sounding ? t0 : first.start;
      const end = Math.min(t1, Math.max(...inside.map(g => g.end)));
      if (end - start < 0.5) return;
      hairpins.push({ start, end, form: v1 > v0 ? 'cres' : 'dim' });
    };
    if (level) {
      const t0 = groups[0].start, t1 = groups[groups.length - 1].end, step = 0.25;
      let run = null;
      for (let t = t0; t < t1; t += step) {
        const a = level(t), b = level(t + step), dv = b - a;
        const sign = Math.abs(dv) < 1e-4 || Math.abs(dv) > 0.15 ? 0 : Math.sign(dv); // flat or a jump ends a ramp
        if (run && sign === run.sign) { run.t1 = t + step; run.v1 = b; continue; }
        if (run) addHairpin(run.t0, run.v0, run.t1, run.v1);
        run = sign ? { sign, t0: t, v0: a, t1: t + step, v1: b } : null;
      }
      if (run) addHairpin(run.t0, run.v0, run.t1, run.v1);
    }
    // Velocity crescendos: the played velocities themselves rise (or fall) step by step -- accent patterns break
    // the run, and a sudden jump (an echo) is a new dynamic, not a hairpin.
    const velGroups = groups.map((g, i) => ({ g, raw: rawVel[i] })).filter(x => x.g.src === 'vel' && x.raw != null)
      .map(x => ({ start: x.g.start, end: x.g.end, v: x.raw }));
    for (let i = 0; i < velGroups.length;) {
      let j = i;
      const dir = j + 1 < velGroups.length ? Math.sign(velGroups[j + 1].v - velGroups[j].v) : 0;
      while (dir && j + 1 < velGroups.length && velGroups[j + 1].start - velGroups[j].end <= 1 &&
             (velGroups[j + 1].v - velGroups[j].v) * dir >= -0.02 && Math.abs(velGroups[j + 1].v - velGroups[j].v) <= 0.12) j++;
      const a = velGroups[i], b = velGroups[j];
      if (j - i >= 3 && b.start - a.start >= 2 && Math.abs(b.v - a.v) >= 0.15 && bandOf(a.v) !== bandOf(b.v) &&
          !hairpins.some(h => h.start < b.start && h.end > a.start)) {
        hairpins.push({ start: a.start, end: b.start, form: dir > 0 ? 'cres' : 'dim' });
      }
      i = Math.max(i + 1, j);
    }
    hairpins.sort((a, b) => a.start - b.start);

    // Marks: band changes that last at least a beat, outside hairpins; restated after two bars of rest.
    const marks = [];
    const skip = opts.skipBeats || new Set();
    let cur = null, printed = null, lastEnd = -Infinity;
    valued.forEach((g, i) => {
      // Velocity is noisier than drawn automation: wider hysteresis, and the new level must last 2 beats.
      const vel = g.src === 'vel', h = vel ? 2 * HYST : HYST, hold = vel ? 2 : 1;
      const b = withHyst(cur, g.v, h);
      if (b !== cur) {
        const later = valued.slice(i + 1).filter(o => o.start < g.start + hold - 1e-6);
        if (cur == null || later.every(o => withHyst(b, o.v, h) === b)) cur = b;
      }
      const inHairpin = hairpins.some(h => g.start > h.start + 1e-6 && g.start < h.end - 1e-6);
      const restate = g.start - lastEnd >= 2 * mb;
      if (!inHairpin && !skip.has(+g.start.toFixed(4)) && (cur !== printed || restate)) {
        marks.push({ beat: g.start, text: DYN_NAMES[cur], kind: 'dynam' });
        printed = cur;
      }
      lastEnd = Math.max(lastEnd, g.end);
    });
    return { marks, hairpins };
  }

  // ------------------------------------------------------------------ write-back plan (live clip)

  /**
   * notes: the live clip's notes [{ch, x, y, d (beats), vel}] (keyswitches included), spb: steps per beat,
   * selected: Set of live ids "L<ch>_<x>_<y>", key: keyswitch key of the wanted articulation, map {key: name}.
   * Returns edit ops: deletes keyswitches inside the selection, adds a short trigger just before the first selected
   * note (unless that articulation is already active there).
   * mode 'from' (default): the articulation latches from there on, like BBC SO and like a part ("pizz." holds until
   *   "arco"); later articulation changes stay, a later switch to the same articulation is removed as redundant.
   * mode 'only': only the selected notes change; the previous articulation is restored for the note after them.
   */
  /**
   * Where a keyswitch for a note at step x goes: an eighth of a beat before it, after the previous note's start (+ the
   * tolerance, so it is not read as the previous note's) and not before the clip's first played step minX; squeezed,
   * one step before the note. Never on the note itself (a keyswitch at the same moment as its note does not fire: BBC
   * SO in Bitwig, tested 2026-10-17), except when there is no room at all (the clip's first note): then x, with late.
   * -> { x, late }
   */
  function keyswitchSlot(x, prevX, spb, minX = 0) {
    const tol = Math.max(1, Math.round(spb * TOL)), lead = Math.max(1, Math.round(spb / 8));
    const lo = Math.max(minX, prevX == null ? -Infinity : prevX + 1);
    let k = Math.max(x - lead, prevX == null ? -Infinity : prevX + tol + 1, minX);
    if (k >= x) k = x - 1;
    if (k < lo) return { x, late: true };
    return { x: k, late: false };
  }

  /**
   * Keyswitches that will not fire for the note they are meant for: at the same moment as it or just after (within
   * TOL), and changing the articulation. keyswitches/notes: [{id, start, pitch}] (beats). -> [{ks, note}]
   */
  function lateKeyswitches(notes, keyswitches, map) {
    const ks = (keyswitches || []).filter(k => map[k.pitch] != null).slice().sort((a, b) => a.start - b.start);
    const mus = notes.slice().sort((a, b) => a.start - b.start);
    const out = [];
    ks.forEach((k, i) => {
      const note = mus.find(n => n.start + TOL >= k.start);
      if (!note || k.start < note.start - 1e-6) return;
      const before = ks.slice(0, i).filter(o => o.start < note.start - 1e-6).pop();
      if (!before || map[before.pitch] !== map[k.pitch]) out.push({ ks: k, note });
    });
    return out;
  }

  /**
   * Moves keyswitches that sit on (or just after) their note to keyswitchSlot. notes: live clip notes [{ch, x, y}].
   * -> { ops: ['move …'], stuck: n (no room: the clip's first note) }
   */
  function planKeyswitchFix(notes, spb, map, minX = 0) {
    const tol = Math.max(1, Math.round(spb * TOL));
    const ks = notes.filter(n => n.y < KS_MAX && map[n.y] != null);
    const mus = notes.filter(n => n.y >= KS_MAX).sort((a, b) => a.x - b.x);
    const ops = [];
    let stuck = 0;
    ks.forEach(k => {
      const o = mus.find(n => n.x + tol >= k.x);
      if (!o || k.x < o.x) return;
      const prev = mus.filter(n => n.x < o.x).pop();
      const slot = keyswitchSlot(o.x, prev ? prev.x : null, spb, minX);
      if (slot.late) { stuck++; return; }
      if (!ks.some(q => q !== k && q.x === slot.x && q.y === k.y)) ops.push(`move ${k.ch} ${k.x} ${k.y} ${slot.x - k.x} 0`);
    });
    return { ops, stuck };
  }

  function planWriteBack(notes, spb, selected, key, map, mode = 'from', opts = {}) {
    const idOf = n => 'L' + n.ch + '_' + n.x + '_' + n.y;
    const tol = Math.max(1, Math.round(spb * TOL));
    const ks = notes.filter(n => n.y < KS_MAX && map[n.y] != null).sort((a, b) => a.x - b.x);
    const mus = notes.filter(n => n.y >= KS_MAX).sort((a, b) => a.x - b.x || a.y - b.y);
    const sel = mus.filter(n => selected.has(idOf(n)));
    if (!sel.length) return [];
    const x0 = sel[0].x, xLast = sel[sel.length - 1].x;
    const owner = k => mus.find(n => n.x + tol >= k.x) || null;      // the note a keyswitch is for
    const keyAt = (x, list) => { let r = null; list.forEach(k => { if (k.x <= x + tol) r = k.y; }); return r; };
    const inside = ks.filter(k => { const o = owner(k); return o && o.x >= x0 && o.x <= xLast; });
    const rest = ks.filter(k => !inside.includes(k));
    const ops = inside.map(k => `del ${k.ch} ${k.x} ${k.y}`);
    const ch = sel[0].ch;
    let late = false;
    const place = (x, prevX) => { const s = keyswitchSlot(x, prevX, spb, opts.minX || 0); if (s.late) late = true; return s.x; };
    const before = mus.filter(n => n.x < x0);
    if (keyAt(x0, rest) !== key) {
      // Reuse the position of the switch the first note already had (the user's own placement), else just before it.
      const own = inside.find(k => owner(k).x === x0);
      const x = own ? own.x : place(x0, before.length ? before[before.length - 1].x : null);
      const same = `del ${ch} ${x} ${key}`;
      if (ops.includes(same)) ops.splice(ops.indexOf(same), 1); // that exact switch is already there: keep it
      else ops.push(`add ${ch} ${x} ${key} 100 0.25`);
    }
    if (mode !== 'only') {
      // Latch: nothing to restore. The next switch after the selection is redundant if it is the same articulation.
      const later = rest.filter(k => { const o = owner(k); return o && o.x > xLast; });
      if (later.length && later[0].y === key) ops.push(`del ${later[0].ch} ${later[0].x} ${later[0].y}`);
      if (opts.report) opts.report.late = late;
      return ops;
    }
    const next = mus.find(n => n.x > xLast);
    if (next) {
      const own = rest.filter(k => owner(k) === next);
      const was = keyAt(next.x, ks);
      if (!own.length && was != null && was !== key) ops.push(`add ${next.ch} ${place(next.x, xLast)} ${was} 100 0.25`);
      else if (own.length && own.every(k => k.y === key)) own.forEach(k => ops.push(`del ${k.ch} ${k.x} ${k.y}`)); // now redundant
    }
    if (opts.report) opts.report.late = late;
    return ops;
  }

  // Picks the articulation for a shortcut intent; repeated presses cycle through the candidates.
  const INTENTS = {
    short: [/^short staccato$/i, /^short spicc?ato$/i, /^short staccatissimo$/i, /^short tenuto$/i, /stacc|spicc/i],
    legato: [/legato/i],
    pizz: [/pizzicato$/i, /pizz(?!.*bart)/i],
    trem: [/^tremolo$/i, /trem|roll/i],
    accent: [/^short marcato$/i, /marcato attack/i, /marcato/i],
    long: [/^long$/i, /sustained/i, /^short hits$/i],
    trill: [/trill.*maj/i, /trill/i],
  };
  function keyForIntent(map, intent, currentKeys) {
    const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
    const cands = [];
    (INTENTS[intent] || []).forEach(re => keys.forEach(k => { if (re.test(map[k]) && !/muted|\bcs\b/i.test(map[k]) && !cands.includes(k)) cands.push(k); }));
    if (!cands.length) return null;
    if (intent === 'short' && currentKeys && currentKeys.length && currentKeys.every(k => k === currentKeys[0])) {
      const i = cands.indexOf(currentKeys[0]);
      if (i >= 0) return cands[(i + 1) % cands.length];
    }
    return cands[0];
  }

  const api = { PRESETS, KS_MAX, classify, resolve, annotate, deriveDynamics, curveFn, levelCurve, planWriteBack,
                keyswitchSlot, lateKeyswitches, planKeyswitchFix,
                keyForIntent, presetFor, bandOf, DYN_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const SV = root.SV;
  if (!SV || !SV.hooks) return;

  // ------------------------------------------------------------------ settings and maps

  const KEY = 'scoreview.articulations.';
  const store = {
    get(k, d) { try { const v = root.localStorage && root.localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (root.localStorage) root.localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const settings = Object.assign({ show: true, dynamics: true, velocity: true, clickPalette: false, heldRevert: false, onlySelected: false,
    slurLegato: false }, store.get('settings', {}));
  const overrides = store.get('overrides', {}); // track -> { preset?: id | 'none', map?: {key: name} }
  const saveSettings = () => store.set('settings', settings);
  const saveOverrides = () => store.set('overrides', overrides);

  const basePart = name => { const b = SV.state.base; return b && b.parts ? b.parts.find(p => p.name === name) : null; };
  const instrumentOf = part => {
    if (part && part.instrument) return part.instrument;
    try { return SV.instruments ? SV.instruments.forPart(part || { name: '' }).id : null; } catch (e) { return null; }
  };
  const familyOf = (presetId, instId) => {
    const inst = SV.instruments && instId ? SV.instruments.get(instId) : null;
    if (inst && inst.unpitched) return 'percussion';
    if (presetId === 'brass' || presetId === 'trombones' || presetId === 'tuba') return 'brass';
    return presetId === 'strings' ? 'strings' : presetId === 'harp' ? 'harp' : presetId || (inst && inst.family) || null;
  };

  /** Articulation table for a track: { map, source, preset, family } (map null = none). */
  function mapFor(trackName, part) {
    const name = cleanName(trackName);
    const ov = overrides[name] || {};
    const bp = basePart(name);
    const instId = instrumentOf(part || bp || { name });
    const auto = presetFor(instId, name);
    let map = null, source = '', preset = auto;
    if (ov.map && Object.keys(ov.map).length) { map = ov.map; source = 'custom'; preset = ov.preset || auto; }
    else if (ov.preset === 'none') { map = null; source = 'off'; preset = null; }
    else if (ov.preset && PRESETS[ov.preset]) { map = PRESETS[ov.preset].map; source = PRESETS[ov.preset].name; preset = ov.preset; }
    else if (bp && bp.articulations) { map = bp.articulations; source = bp.articulationSource || 'export'; }
    else if (auto) { map = PRESETS[auto].map; source = PRESETS[auto].name + ' (built-in)'; }
    const isPerc = /percussion|untuned/i.test(source) || familyOf(preset, instId) === 'percussion';
    return { map, source, preset, family: isPerc ? 'percussion' : familyOf(preset, instId) };
  }

  function originBeat(score, ctx) {
    const mb = score.timeSig.num * 4 / score.timeSig.den;
    if (!ctx || ctx.mode === 'score') return (score.measureOffset || 0) * mb;
    const S = SV.state, d = S.liveData;
    if (!d || !d.exists || S.source !== 'arranger') return null;
    return S.align && S.align.track === d.track ? S.align.offset : null;
  }

  function transform(score, ctx) {
    if (!score || !score.parts || (!settings.show && !settings.dynamics)) return score;
    const mb = score.timeSig.num * 4 / score.timeSig.den;
    const origin = originBeat(score, ctx);
    const ld = SV.state.liveData;
    const liveVel = new Map(ld && ld.notes ? ld.notes.map(n => [SV.liveId(n), n.vel / 127]) : []);
    score.parts = score.parts.map(part => {
      const info = mapFor(part.name, part);
      const p = Object.assign({}, part);
      if (settings.show && info.map) {
        const r = annotate(part, info.map, { family: info.family, heldRevert: settings.heldRevert, slurs: settings.slurLegato });
        p.notes = r.notes;
        p.marks = (p.marks || []).concat(r.marks);
        p.slurs = (p.slurs || []).concat(r.slurs);
      }
      if (settings.dynamics) {
        const bp = basePart(cleanName(part.name));
        const curve = origin != null && bp ? levelCurve(bp.automation) : null;
        const mus = p.notes.filter(n => n.pitch >= KS_MAX).map(n => n.vel != null ? n : liveVel.has(n.id) ? Object.assign({}, n, { vel: liveVel.get(n.id) }) : n);
        const skipBeats = new Set((p.marks || []).filter(m => m.kind === 'dynam').map(m => +m.beat.toFixed(4)));
        const dyn = deriveDynamics(mus, { level: curve ? t => curve(t + origin) : null, velocity: settings.velocity, measureBeats: mb, skipBeats });
        p.marks = (p.marks || []).concat(dyn.marks);
        p.hairpins = (p.hairpins || []).concat(dyn.hairpins);
      }
      return p;
    });
    return score;
  }

  SV.hooks.transformScore.push((score, ctx) => transform(score, ctx));

  // ------------------------------------------------------------------ write-back

  function liveTrackName() { const d = SV.state.liveData; return d && d.exists ? d.track : null; }

  // The clip's first played step (notes before the visible start do not play, so a keyswitch cannot go there).
  const clipFirstStep = d => Math.max(0, Math.ceil(((d && d.playStart) || 0) * ((d && d.stepsPerBeat) || 24) - 1e-6));
  const LATE_MSG = 'The first note of the clip: Bitwig cannot send its keyswitch before it, so the library plays the previous '
    + 'articulation for this note (⚠ ks in the score). Start the clip with some empty space.';

  /** Moves the live clip's keyswitches that sit on their notes a little earlier (Articulations ▾). */
  function fixKeyswitches() {
    const d = SV.state.liveData;
    if (!d || !d.exists) { SV.flash('Select a clip first'); return; }
    const info = mapFor(d.track);
    if (!info.map) { SV.flash('No articulation map for ' + d.track); return; }
    const r = planKeyswitchFix(d.notes, d.stepsPerBeat || 24, info.map, clipFirstStep(d));
    if (r.ops.length) SV.send(r.ops);
    SV.flash((r.ops.length ? `Moved ${r.ops.length} keyswitch${r.ops.length > 1 ? 'es' : ''} just before their notes` : 'No keyswitch needed moving')
      + (r.stuck ? ` · ${r.stuck} on the clip's first note cannot fire: start the clip with some empty space` : ''), { kind: r.stuck ? 'warn' : 'ok', ms: 7000 });
  }

  function apply(key, label) {
    const d = SV.state.liveData;
    if (!d || !d.exists) return false;
    const info = mapFor(d.track);
    if (!info.map) { SV.flash('No articulation map for ' + d.track); return true; }
    const sel = new Set([...SV.state.selection].filter(id => SV.isLive(id) && SV.parseId(id).y >= KS_MAX));
    if (!sel.size) { SV.flash('Select notes of the live clip first'); return true; }
    const spb = d.stepsPerBeat || 24;
    const report = {};
    const ops = planWriteBack(d.notes, spb, sel, key, info.map, settings.onlySelected ? 'only' : 'from', { minX: clipFirstStep(d), report });
    if (!ops.length) { SV.flash((label || info.map[key]) + ' already'); return true; }
    SV.send(ops);
    if (report.late) SV.flash(LATE_MSG, { kind: 'warn', ms: 9000 });
    else SV.flash(settings.onlySelected ? info.map[key] + ' → ' + sel.size + ' note' + (sel.size > 1 ? 's' : '')
      : info.map[key] + ' from here on (until the next articulation change)');
    closePalette();
    return true;
  }

  function currentKeys() {
    const d = SV.state.liveData;
    if (!d || !d.exists) return [];
    const info = mapFor(d.track);
    if (!info.map) return [];
    const spb = d.stepsPerBeat || 24;
    const notes = d.notes.map(n => ({ id: SV.liveId(n), start: n.x / spb, dur: n.d, pitch: n.y }));
    const arts = resolve(notes.filter(n => n.pitch >= KS_MAX), notes.filter(n => n.pitch < KS_MAX), info.map, settings);
    const byName = {};
    Object.keys(info.map).forEach(k => { byName[info.map[k]] = Number(k); });
    return [...SV.state.selection].map(id => byName[arts.get(id)]).filter(k => k != null);
  }

  const SHORTCUTS = { KeyS: 'short', KeyU: 'legato', KeyI: 'pizz', KeyT: 'trem', KeyA: 'accent', KeyN: 'long', KeyR: 'trill' };
  const INTENT_NAMES = { short: 'staccato', legato: 'legato', pizz: 'pizzicato', trem: 'tremolo', accent: 'accent', long: 'long', trill: 'trill' };
  SV.hooks.keydown.push(e => {
    if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    const intent = SHORTCUTS[e.code];
    if (!intent || !SV.state.selection.size) return false;
    if (SV.entry && SV.entry.state && SV.entry.state.on) return false; // note entry owns Shift+letters
    const d = SV.state.liveData;
    if (!d || !d.exists) return false;
    const info = mapFor(d.track);
    if (!info.map) { SV.flash('No articulation map for ' + d.track); return true; }
    const key = keyForIntent(info.map, intent, currentKeys());
    if (key == null) { SV.flash('No ' + INTENT_NAMES[intent] + ' articulation for ' + d.track); return true; }
    return apply(key);
  });

  if (SV.shortcuts) Object.keys(SHORTCUTS).forEach(code => SV.shortcuts.register({
    keys: 'Shift+' + code.slice(3), owner: 'articulations', desc: INTENT_NAMES[SHORTCUTS[code]] + ' on the selected notes (again: next variant)', when: 'normal',
  }));

  SV.articulations = Object.assign({}, api, { settings, overrides, mapFor, transform, apply, saveOverrides, saveSettings,
    fixKeyswitches: () => fixKeyswitches() });

  // ------------------------------------------------------------------ UI

  let pal = null; // the palette element (UI only)
  if (typeof document === 'undefined' || !SV.addToolbar) return;

  SV.addStyle(`
    .sva-pop { position: fixed; z-index: 40; background: var(--bar, #232323); color: var(--text, #ddd); border: 1px solid var(--line, #3a3a3a);
               border-radius: 6px; box-shadow: 0 6px 20px #000a; padding: 8px 10px; font-size: 12px; max-height: 75vh; overflow: auto; }
    .sva-pop h4 { margin: 4px 0 6px; font-size: 12px; color: #fff; font-weight: 600; }
    .sva-pop label { display: block; padding: 2px 0; white-space: nowrap; }
    .sva-pop .hint { color: var(--dim, #888); font-size: 11px; margin-top: 6px; max-width: 300px; white-space: normal; }
    .sva-row { display: flex; gap: 10px; justify-content: space-between; padding: 2px 4px; border-radius: 3px; cursor: pointer; }
    .sva-row:hover { background: var(--bar2, #2d2d2d); }
    .sva-row .src { color: var(--dim, #888); }
    .sva-row .src.custom { color: var(--accent, #ff7a1a); }
    .sva-edit table { border-collapse: collapse; margin-top: 4px; }
    .sva-edit td { padding: 1px 3px; }
    .sva-edit input[type=text] { width: 190px; background: var(--bar2, #2d2d2d); color: inherit; border: 1px solid var(--line, #3a3a3a); border-radius: 3px; font: inherit; padding: 1px 4px; }
    .sva-edit input[type=number] { width: 46px; background: var(--bar2, #2d2d2d); color: inherit; border: 1px solid var(--line, #3a3a3a); border-radius: 3px; font: inherit; }
    .sva-edit select { margin-left: 4px; }
    .sva-pal { position: fixed; z-index: 35; display: flex; flex-wrap: wrap; gap: 3px; max-width: 360px; padding: 5px; background: var(--bar, #232323);
               border: 1px solid var(--line, #3a3a3a); border-radius: 6px; box-shadow: 0 4px 14px #0009; font-size: 11px; }
    .sva-pal button { background: var(--bar2, #2d2d2d); color: var(--text, #ddd); border: 1px solid var(--line, #3a3a3a); border-radius: 4px; padding: 2px 6px; cursor: pointer; font: inherit; }
    .sva-pal button:hover { border-color: var(--accent, #ff7a1a); }
    .sva-pal button.on { background: var(--accent, #ff7a1a); color: #111; }
  `);

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bar = SV.addToolbar('<button class="btn" id="svaBtn" title="Articulations (keyswitches) and dynamics">Articulations ▾</button>' +
    '<label title="Dynamics and hairpins from automation / velocity"><input type="checkbox" id="svaDyn"> Dynamics</label>', { cluster: 'score', order: 20 });
  const dynCb = bar.querySelector('#svaDyn');
  dynCb.checked = settings.dynamics;
  dynCb.addEventListener('change', () => { settings.dynamics = dynCb.checked; saveSettings(); SV.render(); });

  let pop = null;
  const closePop = () => { if (pop) { pop.remove(); pop = null; } };
  document.addEventListener('mousedown', e => {
    if (pop && !pop.contains(e.target) && e.target.id !== 'svaBtn') closePop();
    if (pal && !pal.contains(e.target)) closePalette();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closePop(); closePalette(); } }, true);

  function placeAt(el, x, y) {
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + 'px';
    el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }

  function shownTracks() {
    const r = SV.state.render;
    const names = r ? r.score.parts.map(p => cleanName(p.name)) : [];
    const lt = liveTrackName();
    if (lt && !names.includes(lt)) names.push(lt);
    return names;
  }

  function openMenu(x, y) {
    closePop();
    pop = document.createElement('div');
    pop.className = 'sva-pop';
    pop.id = 'svaMenu';
    const opt = (k, text, title) => `<label title="${esc(title || '')}"><input type="checkbox" data-set="${k}" ${settings[k] ? 'checked' : ''}> ${text}</label>`;
    const rows = shownTracks().map(n => {
      const info = mapFor(n);
      return `<div class="sva-row" data-track="${esc(n)}"><span>${esc(n)}</span><span class="src ${info.source === 'custom' ? 'custom' : ''}">${esc(info.source || 'none')}</span></div>`;
    }).join('') || '<div class="hint">No tracks shown</div>';
    pop.innerHTML = '<h4>Articulations</h4>' +
      '<button class="btn" id="svaPalBtn" title="Shift+K">Palette for the selected notes</button> ' +
      '<button class="btn" id="svaFixKs" title="A keyswitch on its note\'s attack does not fire (⚠ ks in the score): move those a little earlier">Fix keyswitch timing</button>' +
      opt('show', 'Show articulations from keyswitches', 'Dots, accents, tremolo, slurs and technique text from keyswitch notes') +
      opt('dynamics', 'Dynamics and hairpins', 'From the export\'s Dynamics/Expression automation (CC1/CC11), else velocity') +
      opt('velocity', 'Use velocity when there is no automation') +
      opt('clickPalette', 'Also open the palette on note click', 'Off (default): Shift+K opens it for the selected notes') +
      opt('onlySelected', 'Apply to the selected notes only', 'Off (default): the articulation holds from the selected note on, like a part') +
      opt('slurLegato', 'Slur legato passages', 'Off (default): legato keyswitches draw no slurs; add phrasing yourself') +
      opt('heldRevert', 'Held keyswitches end at release', 'Off: every keyswitch latches until the next one (BBC SO)') +
      '<h4>Tracks</h4><div class="sva-tracks">' + rows + '</div><div class="sva-edit"></div>' +
      '<div class="hint">Click a track to edit its keyswitch table. A full .dawproject export (with plugins/) provides the exact BBC SO tables.<br>' +
      'Shortcuts on selected live notes: Shift+S staccato (again: spiccato…), Shift+U legato, Shift+I pizz., Shift+T tremolo, ' +
      'Shift+A accent, Shift+N long/arco, Shift+R trill.</div>';
    document.body.appendChild(pop);
    pop.addEventListener('change', e => {
      const k = e.target.dataset && e.target.dataset.set;
      if (!k) return;
      settings[k] = e.target.checked;
      if (k === 'dynamics') dynCb.checked = settings.dynamics;
      saveSettings();
      SV.render();
    });
    pop.querySelector('#svaPalBtn').addEventListener('click', () => { closePop(); paletteForSelection(); });
    pop.querySelector('#svaFixKs').addEventListener('click', () => { closePop(); fixKeyswitches(); });
    pop.querySelector('.sva-tracks').addEventListener('click', e => {
      const row = e.target.closest('.sva-row');
      if (row) openEditor(row.dataset.track);
    });
    placeAt(pop, x, y);
  }

  function openEditor(track) {
    const box = pop && pop.querySelector('.sva-edit');
    if (!box) return;
    const info = mapFor(track);
    const ov = overrides[track] || {};
    const map = info.map || {};
    const keys = Object.keys(map).map(Number).sort((a, b) => a - b);
    const presetOpts = '<option value="">Automatic</option>' + Object.keys(PRESETS).map(id =>
      `<option value="${id}" ${ov.preset === id && !ov.map ? 'selected' : ''}>${esc(PRESETS[id].name)}</option>`).join('') +
      `<option value="none" ${ov.preset === 'none' ? 'selected' : ''}>None (no articulations)</option>`;
    box.innerHTML = `<h4>${esc(track)} <span style="color:var(--dim)">— ${esc(info.source || 'none')}</span></h4>` +
      `Table: <select data-preset>${presetOpts}</select>` +
      '<table>' + keys.map(k => `<tr><td><input type="number" min="0" max="23" value="${k}" data-k></td><td><input type="text" value="${esc(map[k])}" data-n></td></tr>`).join('') +
      '<tr><td><input type="number" min="0" max="23" placeholder="key" data-k></td><td><input type="text" placeholder="add articulation…" data-n></td></tr></table>' +
      '<button class="btn" data-save>Save table</button> <button class="btn" data-reset>Reset</button>';
    box.querySelector('[data-preset]').addEventListener('change', e => {
      const v = e.target.value;
      if (v) overrides[track] = { preset: v }; else delete overrides[track];
      saveOverrides(); SV.render(); openEditor(track);
    });
    box.querySelector('[data-save]').addEventListener('click', () => {
      const m = {};
      box.querySelectorAll('tr').forEach(tr => {
        const k = parseInt(tr.querySelector('[data-k]').value, 10), n = tr.querySelector('[data-n]').value.trim();
        if (k >= 0 && k < KS_MAX && n) m[k] = n;
      });
      overrides[track] = { preset: (overrides[track] || {}).preset, map: m };
      saveOverrides(); SV.render(); openEditor(track);
      SV.flash('Saved the keyswitch table for ' + track);
    });
    box.querySelector('[data-reset]').addEventListener('click', () => { delete overrides[track]; saveOverrides(); SV.render(); openEditor(track); });
    box.addEventListener('keydown', e => e.stopPropagation());
  }

  bar.querySelector('#svaBtn').addEventListener('click', e => {
    if (pop) { closePop(); return; }
    const r = e.target.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4);
  });

  // Palette next to a clicked live note: the track's articulations, the current one highlighted.
  function closePalette() { if (pal) { pal.remove(); pal = null; } }
  function openPalette(el) {
    closePalette();
    const d = SV.state.liveData;
    if (!d || !d.exists) return;
    const info = mapFor(d.track);
    if (!info.map) return;
    const cur = currentKeys();
    pal = document.createElement('div');
    pal.className = 'sva-pal';
    pal.id = 'svaPalette';
    Object.keys(info.map).map(Number).sort((a, b) => a - b).forEach(k => {
      const b = document.createElement('button');
      b.textContent = info.map[k].replace(/^Short (?=.)/, '');
      b.title = info.map[k] + ' (keyswitch ' + k + ')';
      b.dataset.key = k;
      if (cur.length && cur.every(c => c === k)) b.classList.add('on');
      b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); apply(k); });
      pal.appendChild(b);
    });
    document.body.appendChild(pal);
    const r = el.getBoundingClientRect();
    placeAt(pal, r.left - 10, r.top - pal.getBoundingClientRect().height - 18);
  }
  // Shift+K (or the Articulations menu): the palette at the first selected live note.
  function paletteForSelection() {
    const r = SV.state.render;
    const t = r && [...SV.state.selection].filter(id => SV.isLive(id)).map(id => (r.bySrc.get(id) || [])[0]).filter(Boolean)
      .sort((a, b) => a.start - b.start)[0];
    const el = t && document.getElementById(t.svgId);
    if (!el) { SV.flash('Articulations: select notes of the live clip first (then Shift+K)'); return; }
    const d = SV.state.liveData;
    if (!d || !d.exists || !mapFor(d.track).map) { SV.flash('No articulation map for ' + ((d && d.track) || 'this track')); return; }
    openPalette(el);
  }
  SV.hooks.keydown.push(e => {
    if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyK') return false;
    if (SV.entry && SV.entry.state && SV.entry.state.on) return false;
    if (pal) closePalette(); else paletteForSelection();
    return true;
  });
  if (SV.shortcuts) SV.shortcuts.register({ keys: 'Shift+K', owner: 'articulations', when: 'normal', desc: 'articulation palette for the selected notes' });
  SV.hooks.noteClick.push((t, e) => {
    if (!settings.clickPalette || !SV.isLive(t.srcId) || e.button !== 0) return false;
    if (SV.entry && SV.entry.state && SV.entry.state.on) return false;
    const el = document.getElementById(t.svgId);
    setTimeout(() => { if (el && el.isConnected) openPalette(el); }, 0);
    return false;
  });
  SV.hooks.afterRender.push(() => {
    if (!pal) return;
    // Re-anchor after a re-render (the edit that changed the keyswitches redraws the score).
    const sel = [...SV.state.selection][0];
    const t = sel && SV.state.render && (SV.state.render.bySrc.get(sel) || [])[0];
    const el = t && document.getElementById(t.svgId);
    if (el) openPalette(el); else closePalette();
  });

  // ---- articulation-map Note FX on the selected track (e.g. JSONBach's "BBCSO String Articulations"): it sends its own
  // keyswitch (its selector, Legato by default) before every note, so keyswitch notes in the clip last one note.
  const isMapDevice = name => /articulation/i.test(name || '');
  const dismissedMaps = new Set(); // "track|device" closed for this session
  function activeMaps(d) {
    const dv = d && d.devices;
    if (!dv || !d.exists || dv.track !== d.track) return [];
    return (dv.list || []).filter(x => x.on && isMapDevice(x.name));
  }
  SV.addStyle(`
    #svaMapWarn { display: flex; align-items: center; gap: 10px; padding: 6px 12px; font-size: 12px; background: #4a3a12; color: #ffe6a6;
                  border-bottom: 1px solid #7a5d1a; }
    #svaMapWarn.hidden { display: none; }
    #svaMapWarn b { color: #fff; }
    #svaMapWarn .btn { padding: 2px 10px; }
    #svaMapWarn .sva-x { margin-left: auto; background: none; border: 0; color: inherit; cursor: pointer; font-size: 14px; }
  `);
  const warn = document.createElement('div');
  warn.id = 'svaMapWarn';
  warn.className = 'hidden';
  const mainEl = document.getElementById('main');
  if (mainEl) mainEl.parentNode.insertBefore(warn, mainEl);
  let warnKey = null;
  function refreshMapWarning() {
    const d = SV.state.liveData;
    const maps = activeMaps(d).filter(m => !dismissedMaps.has(d.track + '|' + m.name));
    const key = maps.length ? d.track + '|' + maps.map(m => m.index + m.name).join(',') : null;
    if (key === warnKey) return;
    warnKey = key;
    if (!maps.length) { warn.classList.add('hidden'); warn.innerHTML = ''; return; }
    warn.classList.remove('hidden');
    const names = maps.map(m => '“' + esc(m.name) + '”').join(', ');
    warn.innerHTML = `<span>⚠ ${names} on <b>${esc(d.track)}</b> sends its own keyswitch before every note, so articulations `
      + 'written in the clip (Score View, or BBC SO\'s own buttons) last only one note.</span>'
      + '<button class="btn" id="svaMapOff" title="Switches the device off in Bitwig (switch it on again in the device chain)">Turn the map off</button>'
      + '<button class="sva-x" id="svaMapDismiss" title="Keep the map (this session)">✕</button>';
    warn.querySelector('#svaMapOff').addEventListener('click', () => {
      SV.send(maps.map(m => `deviceOn ${m.index} 0`));
      SV.flash(`${names.replace(/[“”]/g, '')} switched off on ${d.track}: keyswitches in the clip now latch`, { kind: 'ok' });
    });
    warn.querySelector('#svaMapDismiss').addEventListener('click', () => {
      maps.forEach(m => dismissedMaps.add(d.track + '|' + m.name));
      refreshMapWarning();
    });
  }
  SV.hooks.liveData.push(() => refreshMapWarning());
  SV.articulations.activeMaps = activeMaps;

  SV.addHelp('Articulations: <kbd>Shift</kbd>+<kbd>S</kbd> staccato (again: spiccato…) · <kbd>Shift</kbd>+<kbd>U</kbd> legato · ' +
    '<kbd>Shift</kbd>+<kbd>I</kbd> pizz. · <kbd>Shift</kbd>+<kbd>T</kbd> tremolo · <kbd>Shift</kbd>+<kbd>A</kbd> accent · ' +
    '<kbd>Shift</kbd>+<kbd>N</kbd> long/arco · <kbd>Shift</kbd>+<kbd>R</kbd> trill (writes keyswitch notes into the clip) · <kbd>Shift</kbd>+<kbd>K</kbd> palette');
})(typeof window !== 'undefined' ? window : this);
