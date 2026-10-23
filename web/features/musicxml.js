// Feature module: musicxml (issue #7). Exports the engraved score as MusicXML 4.0 (score-partwise) for Dorico.
//
// The source is the MEI that score.js produced for the current render (SV.state.render.mei), so the export
// matches what is on screen: same spelling, voices, ties, beams, tuplets, clefs and keys.
//
// Pitch: MusicXML notes are always *written* pitch; <transpose> says how to get to concert pitch. Parts that
// score.js already wrote transposed (part.transpose = written - sounding semitones) are exported as they are,
// with <transpose chromatic = -part.transpose>. Parts shown in concert pitch whose instrument transposes
// (SV.instruments.lookup(name).transpose, or a small built-in table when that module is absent) are
// re-engraved with buildMEI(part.transpose = t) first, so Dorico receives correctly spelled written pitch.
//
// Node: const MX = require('web/features/musicxml.js'); MX.fromMEI(mei, { DOMParser, score, staves }).
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ small helpers

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };
  const lcm = (a, b) => a / gcd(a, b) * b;
  const fr = (n, d) => { if (d < 0) { n = -n; d = -d; } const g = gcd(n, d); return [n / g, d / g]; };
  const fmul = (a, b) => fr(a[0] * b[0], a[1] * b[1]);
  const fadd = (a, b) => fr(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
  const kids = el => Array.from(el.children || []);
  const kid = (el, name) => kids(el).find(k => k.localName === name);
  const attr = (el, name) => (el && el.hasAttribute(name) ? el.getAttribute(name) : null);
  const childText = (el, name) => { const k = kid(el, name); return k ? k.textContent.replace(/\s+/g, ' ').trim() : ''; };
  const cleanName = s => String(s || '').replace(/\s*✎\s*$/, '').replace(/\s+/g, ' ').trim();
  const normFifths = f => ((f % 12) + 18) % 12 - 6;

  // Durations are fractions of a quarter note: [num, den].
  function durFrac(dur, dots) {
    let f;
    if (dur === 'maxima') f = [32, 1];
    else if (dur === 'long') f = [16, 1];
    else if (dur === 'breve') f = [8, 1];
    else { const d = parseInt(dur, 10); if (!(d > 0)) return null; f = fr(4, d); }
    const k = dots || 0;
    return k ? fmul(f, [Math.pow(2, k + 1) - 1, Math.pow(2, k)]) : f;
  }
  const TYPE = { maxima: 'maxima', long: 'long', breve: 'breve', 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth',
                 16: '16th', 32: '32nd', 64: '64th', 128: '128th', 256: '256th' };
  const BEAMS = { 8: 1, 16: 2, 32: 3, 64: 4, 128: 5, 256: 6 };
  const ALTER = { s: 1, f: -1, ss: 2, x: 2, ff: -2, n: 0, xs: 3, sx: 3, ts: 3, tf: -3, nf: -1, ns: 1 };
  const ACCIDENTAL = { s: 'sharp', f: 'flat', ss: 'sharp-sharp', x: 'double-sharp', ff: 'flat-flat', n: 'natural',
                       xs: 'triple-sharp', ts: 'triple-sharp', tf: 'triple-flat', nf: 'natural-flat', ns: 'natural-sharp' };
  const ARTIC = { stacc: 'staccato', stacciss: 'staccatissimo', ten: 'tenuto', acc: 'accent', marc: 'strong-accent',
                  spicc: 'spiccato', 'ten-stacc': 'detached-legato' };
  const TECHNICAL = { snap: 'snap-pizzicato', harm: 'harmonic', upbow: 'up-bow', dnbow: 'down-bow' };
  const DYNAMICS = /^(pppppp|ppppp|pppp|ppp|pp|p|mp|mf|f|ff|fff|ffff|fffff|ffffff|sfz|sffz|sfp|sfpp|fp|rf|rfz|fz|sf|pf|sfzp|n)$/;

  function parseKeySig(s) {
    if (s == null || s === '') return null;
    if (s === '0') return 0;
    const m = /^(\d+)([sf])$/.exec(s.trim());
    return m ? (m[2] === 's' ? 1 : -1) * parseInt(m[1], 10) : null;
  }

  function color(c) {
    if (!c) return null;
    c = String(c).trim();
    let m = /^#([0-9a-f]{3})$/i.exec(c);
    if (m) return '#' + m[1].split('').map(x => x + x).join('').toUpperCase();
    m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
    if (m) return '#' + m[1].toUpperCase();
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
    if (m) return '#' + m.slice(1, 4).map(v => Math.min(255, +v).toString(16).padStart(2, '0')).join('').toUpperCase();
    return null;
  }

  // ------------------------------------------------------------------ transposition

  /**
   * MusicXML <transpose> for a part whose written pitch = sounding + t semitones (score.js part.transpose).
   * Diatonic steps follow the key-signature interval score.js uses (written key = concert key + 7t fifths).
   */
  function transposeElement(t) {
    if (!t) return null;
    const s = -t;                                   // written -> sounding, semitones
    const k = normFifths(7 * s);                    // the interval on the circle of fifths
    const steps = ((4 * k) % 7 + 7) % 7, semis = ((s % 12) + 12) % 12;
    const diatonicTotal = steps + 7 * Math.round((s - semis) / 12);
    const oct = Math.trunc(s / 12);
    return { diatonic: diatonicTotal - 7 * oct, chromatic: s - 12 * oct, octave: oct };
  }

  // Fallback when SV.instruments is not loaded: common transposing instruments, written = sounding + t.
  const FALLBACK = [
    [/\bbass\s*clar|\bb\.?\s*cl/i, 14], [/\b(e[b♭]|es)\s*clar|clarinet in e/i, -3], [/clarinet in a\b|\ba\s*clar/i, 3],
    [/clar|\bcl\b/i, 2], [/english horn|cor anglais|\bcor\.? ang/i, 7], [/alto\s*fl/i, 5], [/bass\s*fl/i, 12],
    [/piccolo|\bpicc/i, -12], [/sopr\w*\s*sax/i, 2], [/alto\s*sax/i, 9], [/tenor\s*sax/i, 14], [/bari\w*\s*sax/i, 21],
    [/contra\s*bassoon|contrabsn|\bcbsn/i, 12], [/flugel/i, 2], [/cornet/i, 2], [/trumpet in f/i, -5], [/trumpet in d/i, -2],
    [/trumpet in e[b♭]/i, -3], [/trumpet in c/i, 0], [/trumpet|\btpt|\btrp/i, 2], [/horn|\bhn\b|\bcor\b/i, 7],
    [/guitar|\bgtr/i, 12], [/glock/i, -24], [/xylo/i, -12], [/celest/i, -12],
    [/\b(contra|double|string)\s*bass|\bcb\b|\bkb\b|^bass(es)?$|^basses?\s/i, 12],
  ];
  const NON_TRANSPOSING = /trombone|\btbn|bassoon|\bbsn|tuba|timp|cello|viol|harp|piano|organ|oboe|flute|synth|pad|perc|drum/i;

  function fallbackTranspose(name) {
    name = cleanName(name);
    if (NON_TRANSPOSING.test(name) && !/bass\s*clar|alto\s*fl|bass\s*fl|contra\s*bassoon|piccolo/i.test(name)) return 0;
    const hit = FALLBACK.find(([re]) => re.test(name));
    return hit ? hit[1] : 0;
  }

  /** Semitones (written - sounding) for a part name: SV.instruments when given, else the built-in table. */
  function instrumentTranspose(name, instruments) {
    if (instruments && typeof instruments.lookup === 'function') {
      let info = null;
      try { info = instruments.lookup(cleanName(name)); } catch (e) { info = null; }
      if (!info) return 0;
      // SV.instruments.lookup() returns { inst: { transpose, ... }, label, abbr, ... }
      const inst = info.inst || info;
      for (const k of ['transpose', 'transposition', 'semitones']) if (typeof inst[k] === 'number') return inst[k];
      return 0;
    }
    return fallbackTranspose(name);
  }

  // MusicXML standard sound ids (Dorico uses <instrument-sound> to choose the instrument on import).
  const SOUNDS = [
    [/bass\s*clar/i, 'wind.reed.clarinet.bass'], [/(e[b♭]|es)\s*clar/i, 'wind.reed.clarinet.eflat'],
    [/clarinet in a\b/i, 'wind.reed.clarinet.a'], [/clar/i, 'wind.reed.clarinet.bflat'],
    [/contra\s*bassoon|contrabsn/i, 'wind.reed.contrabassoon'], [/bas+o+n|\bbsn/i, 'wind.reed.bassoon'],
    [/english horn|cor anglais/i, 'wind.reed.english-horn'], [/oboe/i, 'wind.reed.oboe'],
    [/sopr\w*\s*sax/i, 'wind.reed.saxophone.soprano'], [/alto\s*sax/i, 'wind.reed.saxophone.alto'],
    [/tenor\s*sax/i, 'wind.reed.saxophone.tenor'], [/bari\w*\s*sax/i, 'wind.reed.saxophone.baritone'],
    [/piccolo/i, 'wind.flutes.flute.piccolo'], [/alto\s*fl/i, 'wind.flutes.flute.alto'], [/flute/i, 'wind.flutes.flute'],
    [/bass\s*trom|\bbs\.?\s*trom|bass\s*tbn/i, 'brass.trombone.bass'], [/trom|\btbn/i, 'brass.trombone'],
    [/tuba/i, 'brass.tuba'], [/trumpet|\btpt|\btrp/i, 'brass.trumpet'], [/cornet/i, 'brass.cornet'],
    [/flugel/i, 'brass.flugelhorn'], [/horn/i, 'brass.french-horn'],
    [/violin|\bvln/i, 'strings.violin'], [/viola|\bvla\b/i, 'strings.viola'], [/cello|\bvc\b/i, 'strings.cello'],
    [/contrabass|double\s*bass|^bass(es)?\b/i, 'strings.contrabass'],
    [/harp/i, 'pluck.harp'], [/guitar/i, 'pluck.guitar'], [/timp/i, 'drum.timpani'],
    [/glock/i, 'pitched-percussion.glockenspiel'], [/xylo/i, 'pitched-percussion.xylophone'],
    [/marimba/i, 'pitched-percussion.marimba'], [/vibra/i, 'pitched-percussion.vibraphone'],
    [/celest/i, 'keyboard.celesta'], [/organ/i, 'keyboard.organ'], [/harpsi/i, 'keyboard.harpsichord'],
    [/piano/i, 'keyboard.piano'], [/choir|voices|chorus/i, 'voice.choir'],
  ];
  const soundId = name => { const hit = SOUNDS.find(([re]) => re.test(cleanName(name))); return hit ? hit[1] : null; };

  const KEYBOARD = /piano|harp|celest|organ|keys|keyboard|marimba|vibra|harpsi|clavi|cimbalom|synth|pad/i;

  /**
   * Makes the engraving that is exported: { mei, score, staves }. Rebuilds the MEI (same build options as
   * the view) only when something must differ from the screen:
   *   - writtenPitch: parts in concert pitch whose instrument transposes get part.transpose (written pitch);
   *   - singleStaff: non-keyboard parts that score.js split onto a grand staff go back to one staff.
   */
  function prepareExport(render, opts) {
    opts = opts || {};
    const SB = opts.ScoreBuilder;
    if (!render || !render.score || !SB) return { mei: render && render.mei, score: render && render.score, staves: render && render.staves, changed: [] };
    const changed = [];
    const parts = render.score.parts.map(p => {
      let q = p;
      if (opts.writtenPitch !== false && !p.transpose) {
        const t = instrumentTranspose(p.name || p.label, opts.instruments); // track name: what the instrument lookup knows
        const octaveOnly = t % 12 === 0;
        const clefDis = p.clef && !Array.isArray(p.clef) && p.clef.dis;
        if (t && !(octaveOnly && clefDis)) { q = { ...q, transpose: t }; changed.push(cleanName(p.name) + ': written pitch (' + (t > 0 ? '+' : '') + t + ')'); }
      }
      if (opts.singleStaff && p.grand == null && !KEYBOARD.test(p.label || p.name)) {
        const st = render.staves.filter(s => s.part === p.name);
        if (st.length > 1) { q = { ...q, grand: false }; changed.push(cleanName(p.name) + ': one staff'); }
      }
      return q;
    });
    if (!changed.length) return { mei: render.mei, score: render.score, staves: render.staves, changed };
    const score = { ...render.score, parts, keyFifths: render.keyFifths != null ? render.keyFifths : render.score.keyFifths };
    const built = SB.buildMEI(score, opts.buildOptions || {});
    return { mei: built.mei, score, staves: built.staves, changed };
  }

  // ------------------------------------------------------------------ MEI reading

  function readClef(el, prefix) {
    const shape = attr(el, prefix + 'shape');
    if (!shape) return null;
    return { shape, line: parseInt(attr(el, prefix + 'line') || (shape === 'F' ? 4 : shape === 'C' ? 3 : 2), 10),
             dis: parseInt(attr(el, prefix + 'dis') || '0', 10) || 0, place: attr(el, prefix + 'dis.place') || 'above' };
  }

  function readStaffDef(sd, defKey) {
    const clefEl = kid(sd, 'clef'), keyEl = kid(sd, 'keySig');
    let key = parseKeySig(attr(sd, 'keysig') || attr(sd, 'key.sig'));
    if (key == null && keyEl) key = parseKeySig(attr(keyEl, 'sig'));
    return { n: attr(sd, 'n'), clef: readClef(sd, 'clef.') || (clefEl && readClef(clefEl, '')), key: key == null ? defKey : key,
             label: childText(sd, 'label') || attr(sd, 'label') || '', abbr: childText(sd, 'labelAbbr') || attr(sd, 'label.abbr') || '' };
  }

  function readMeter(el) {
    const ms = kid(el, 'meterSig');
    const count = attr(el, 'meter.count') || (ms && attr(ms, 'count'));
    const unit = attr(el, 'meter.unit') || (ms && attr(ms, 'unit'));
    if (!count || !unit) return null;
    return { count: parseInt(count, 10), unit: parseInt(unit, 10), sym: attr(el, 'meter.sym') || (ms && attr(ms, 'sym')) };
  }

  function readScoreKey(el) {
    let k = parseKeySig(attr(el, 'keysig') || attr(el, 'key.sig'));
    const ks = kid(el, 'keySig');
    if (k == null && ks) k = parseKeySig(attr(ks, 'sig'));
    return k;
  }

  // Parts and part groups from the (possibly nested) staffGrp tree.
  function readStructure(scoreDef) {
    const defKey = readScoreKey(scoreDef);
    const parts = [], groups = [];
    const walk = (grp, depth) => {
      const sds = kids(grp).filter(k => k.localName === 'staffDef');
      const grps = kids(grp).filter(k => k.localName === 'staffGrp');
      const symbol = attr(grp, 'symbol') || (kid(grp, 'grpSym') && attr(kid(grp, 'grpSym'), 'symbol'));
      const label = childText(grp, 'label') || attr(grp, 'label') || '';
      const abbr = childText(grp, 'labelAbbr') || '';
      const defs = sds.map(sd => readStaffDef(sd, defKey));
      if (!grps.length && defs.length >= 2 && defs.every(d => !d.label) && (depth > 0 || symbol === 'brace')) {
        parts.push({ name: label, abbr, staves: defs });
        return;
      }
      const first = parts.length;
      kids(grp).forEach(k => {
        if (k.localName === 'staffDef') { const d = readStaffDef(k, defKey); parts.push({ name: d.label, abbr: d.abbr, staves: [d] }); }
        else if (k.localName === 'staffGrp') walk(k, depth + 1);
      });
      if (depth > 0 && parts.length - first >= 2) {
        groups.push({ first, last: parts.length - 1, depth, symbol: symbol || 'bracket', barThru: attr(grp, 'bar.thru') !== 'false', name: label, abbr });
      }
    };
    const top = kid(scoreDef, 'staffGrp');
    if (top) walk(top, 0);
    else kids(scoreDef).filter(k => k.localName === 'staffDef').forEach(sd => { const d = readStaffDef(sd, defKey); parts.push({ name: d.label, abbr: d.abbr, staves: [d] }); });
    return { parts, groups, key: defKey, meter: readMeter(scoreDef) };
  }

  // Events of one layer, in order. Containers (beam, tuplet, unknown wrappers) are flattened with context.
  function readLayer(layer, measureLen) {
    const events = [];
    const walk = (el, ctx) => {
      const name = el.localName;
      if (name === 'note' || name === 'chord') return pushNoteEvent(el, ctx);
      if (name === 'rest' || name === 'space') {
        const d = durFrac(attr(el, 'dur'), parseInt(attr(el, 'dots') || '0', 10));
        if (!d) return;
        return push({ kind: name, dur: d, type: attr(el, 'dur'), dots: +(attr(el, 'dots') || 0), el }, ctx);
      }
      if (name === 'mRest' || name === 'mSpace' || name === 'multiRest') return push({ kind: name === 'mSpace' ? 'space' : 'mrest', dur: measureLen, el }, ctx);
      if (name === 'clef') { const c = readClef(el, ''); if (c) events.push({ kind: 'clef', clef: c, dur: [0, 1] }); return; }
      if (name === 'beam' && !ctx.beam) {
        const group = [];
        kids(el).forEach(k => walk(k, { ...ctx, beam: group }));
        assignBeams(group);
        return;
      }
      if (name === 'tuplet') {
        const num = parseInt(attr(el, 'num') || '3', 10), numbase = parseInt(attr(el, 'numbase') || '2', 10);
        const tup = { num, numbase, level: ctx.tuplets.length + 1, bracket: attr(el, 'bracket.visible') !== 'false',
                      showNumber: attr(el, 'num.visible') !== 'false', placement: attr(el, 'bracket.place') };
        const startIdx = events.length;
        kids(el).forEach(k => walk(k, { ...ctx, tuplets: ctx.tuplets.concat([tup]) }));
        const inside = events.slice(startIdx).filter(e => e.kind !== 'clef' && !e.grace);
        if (inside.length) { inside[0].tupStart.push(tup); inside[inside.length - 1].tupStop.push(tup); }
        return;
      }
      if (/^(artic|verse|syl|accid|dot|stem)$/.test(name)) return;
      kids(el).forEach(k => walk(k, ctx));
    };
    const push = (ev, ctx) => {
      ev.tupStart = []; ev.tupStop = [];
      if (ctx.tuplets.length && ev.kind !== 'mrest') {
        const num = ctx.tuplets.reduce((a, t) => a * t.num, 1), base = ctx.tuplets.reduce((a, t) => a * t.numbase, 1);
        ev.tm = [num, base];
        if (!ev.grace) ev.dur = fmul(ev.dur, fr(base, num));
      }
      events.push(ev);
      if (ctx.beam && ev.kind === 'note' && !ev.grace) ctx.beam.push(ev);
    };
    const pushNoteEvent = (el, ctx) => {
      const noteEls = el.localName === 'chord' ? kids(el).filter(k => k.localName === 'note') : [el];
      if (!noteEls.length) return;
      const src = attr(el, 'dur') ? el : noteEls.find(n => attr(n, 'dur')) || el;
      const type = attr(src, 'dur') || '4', dots = parseInt(attr(src, 'dots') || '0', 10);
      const grace = attr(el, 'grace') || attr(noteEls[0], 'grace');
      const artics = [], technical = [];
      const addArtic = s => (s || '').split(/\s+/).forEach(a => {
        if (ARTIC[a] && !artics.includes(ARTIC[a])) artics.push(ARTIC[a]);
        if (TECHNICAL[a] && !technical.includes(TECHNICAL[a])) technical.push(TECHNICAL[a]);
      });
      [el, ...noteEls].forEach(x => { addArtic(attr(x, 'artic')); kids(x).filter(k => k.localName === 'artic').forEach(k => addArtic(attr(k, 'artic'))); });
      // Unmeasured tremolo: <bTrem> around the note/chord with @stem.mod="Nslash".
      const slash = /^(\d)slash$/.exec(attr(el, 'stem.mod') || attr(noteEls[0], 'stem.mod') || '');
      const notes = noteEls.map(n => {
        const accidEl = kid(n, 'accid');
        const accid = attr(n, 'accid') || (accidEl && attr(accidEl, 'accid'));
        const ges = attr(n, 'accid.ges') || (accidEl && attr(accidEl, 'accid.ges'));
        const alter = accid != null && ALTER[accid] != null ? ALTER[accid] : ges != null && ALTER[ges] != null ? ALTER[ges] : 0;
        return { step: (attr(n, 'pname') || 'c').toUpperCase(), oct: parseInt(attr(n, 'oct.ges') || attr(n, 'oct') || '4', 10), alter,
                 accidental: accid ? ACCIDENTAL[accid] : null, tie: attr(n, 'tie'), id: attr(n, 'xml:id') || n.getAttribute('id'),
                 color: color(attr(n, 'color') || attr(el, 'color')) };
      });
      push({ kind: 'note', dur: grace ? [0, 1] : durFrac(type, dots) || [1, 1], type, dots, notes, grace: !!grace, artics, technical,
             tremolo: slash ? +slash[1] : 0,
             slash: grace === 'unacc' }, ctx);
    };
    kids(layer).forEach(k => walk(k, { tuplets: [], beam: null }));
    return events;
  }

  // MusicXML <beam> values per level for one MEI beam group.
  function assignBeams(group) {
    if (group.length < 2) return;
    const nb = group.map(e => BEAMS[e.type] || 0);
    if (nb.some(b => !b)) return; // unbeamable value inside a beam (quarter etc.): leave unbeamed
    const max = Math.max(...nb), last = group.length - 1;
    group.forEach((e, i) => {
      e.beams = [];
      for (let L = 1; L <= nb[i]; L++) {
        const prev = i > 0 && nb[i - 1] >= L, next = i < last && nb[i + 1] >= L;
        let v;
        if (L === 1) v = i === 0 ? 'begin' : i === last ? 'end' : 'continue';
        else if (prev && next) v = 'continue';
        else if (prev) v = 'end';
        else if (next) v = 'begin';
        else v = i === 0 ? 'forward hook' : 'backward hook';
        e.beams.push(v);
      }
    });
    return max;
  }

  // ------------------------------------------------------------------ conversion

  /**
   * mei:  MEI string from ScoreBuilder.buildMEI.
   * opts: { DOMParser, title, score, staves, instruments, date }
   *       score/staves (from the render) give part.transpose and names; instruments = SV.instruments.
   * returns { xml, divisions, parts:[{id, name, staves, transpose}], measures, warnings }
   */
  function fromMEI(mei, opts) {
    opts = opts || {};
    const DP = opts.DOMParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) throw new Error('No DOMParser available');
    const doc = new DP().parseFromString(mei, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('MEI is not well-formed');
    const scoreEl = doc.getElementsByTagNameNS('*', 'score')[0];
    if (!scoreEl) throw new Error('No <score> in MEI');
    const scoreDef = kid(scoreEl, 'scoreDef');
    if (!scoreDef) throw new Error('No <scoreDef> in MEI');
    const warnings = [];
    const struct = readStructure(scoreDef);
    let meter = struct.meter || { count: 4, unit: 4 };

    // Score-model part (for transposition) per MEI part, via the render's staves list (staff n -> part name).
    const scoreParts = (opts.score && opts.score.parts) || [];
    const staffPart = new Map((opts.staves || []).map(s => [String(s.n), s.part]));
    const parts = struct.parts.map((p, i) => {
      const nm = staffPart.get(String(p.staves[0].n));
      const sp = scoreParts.find(x => x.name === nm) || (scoreParts.length === struct.parts.length ? scoreParts[i] : null);
      const name = cleanName(p.name || (sp && (sp.label || sp.name)) || 'Part ' + (i + 1));
      let info = null;
      if (opts.instruments && typeof opts.instruments.lookup === 'function') { try { info = opts.instruments.lookup(name); } catch (e) { info = null; } }
      const inst = info && (info.inst || info);
      return {
        id: 'P' + (i + 1), name, abbr: cleanName((info && (info.abbr || info.abbreviation || info.short)) || p.abbr || ''),
        instrumentName: (inst && (inst.name || inst.instrument)) || name,
        sound: (inst && (inst.sound || inst.musicxmlSound || inst.instrumentSound)) || soundId((inst && inst.name) || name),
        transpose: sp ? sp.transpose || 0 : 0, staves: p.staves,
        staffIdx: new Map(p.staves.map((s, k) => [String(s.n), k + 1])),
        measures: [],
      };
    });
    const staffOwner = new Map();
    parts.forEach(p => p.staves.forEach(s => staffOwner.set(String(s.n), p)));
    const staffState = new Map();
    parts.forEach(p => p.staves.forEach(s => staffState.set(String(s.n), { clef: s.clef || { shape: 'G', line: 2, dis: 0 }, key: s.key == null ? 0 : s.key })));

    // Walk sections; collect per-measure data and attribute changes.
    const measures = [];
    let pending = null;
    const touch = () => pending || (pending = { meter: null, keys: new Map(), clefs: new Map() });
    const applyStaffDef = sd => {
      const n = attr(sd, 'n'), st = staffState.get(String(n));
      if (!st) return;
      const c = readClef(sd, 'clef.') || (kid(sd, 'clef') && readClef(kid(sd, 'clef'), ''));
      if (c) { st.clef = c; touch().clefs.set(String(n), c); }
      const k = readScoreKey(sd);
      if (k != null) { st.key = k; touch().keys.set(String(n), k); }
    };
    const walkSection = el => kids(el).forEach(k => {
      const nm = k.localName;
      if (nm === 'measure') { measures.push({ el: k, changes: pending, meter }); pending = null; }
      else if (nm === 'scoreDef') {
        const m = readMeter(k);
        if (m) { meter = m; touch().meter = m; }
        const key = readScoreKey(k);
        if (key != null) staffState.forEach((st, n) => { st.key = key; touch().keys.set(n, key); });
        Array.from(k.getElementsByTagNameNS('*', 'staffDef')).forEach(applyStaffDef);
      } else if (nm === 'staffDef') applyStaffDef(k);
      else if (nm === 'section' || nm === 'ending' || nm === 'lem' || nm === 'rdg' || nm === 'app') walkSection(k);
    });
    Array.from(scoreEl.children).filter(k => k.localName === 'section').forEach(walkSection);
    if (!measures.length) throw new Error('MEI has no measures');

    // Control events: ties/slurs by id, directions by staff and time.
    const tieStart = new Set(), tieStop = new Set(), slurs = new Map(), trills = new Map(), hairpins = [], spans = [];
    const octStart = new Map(), octStop = new Map();
    let slurNo = 0;
    const addSlur = (id, v) => { if (!slurs.has(id)) slurs.set(id, []); slurs.get(id).push(v); };
    // Stand-ins shaped like MEI control events for directionXml (octave-shift and dash stops).
    const spanDir = (localName, props, staff, tstamp) => Object.assign({
      localName, textContent: '', children: [],
      hasAttribute: n => n === 'staff' || n === 'tstamp',
      getAttribute: n => n === 'staff' ? staff : n === 'tstamp' ? String(tstamp) : null,
    }, props);
    // Hairpins become <wedge> start/stop directions (stand-ins shaped like MEI elements for directionXml).
    const wedgeDir = (form, staff, tstamp) => ({
      localName: 'wedge', textContent: '', form,
      hasAttribute: n => n === 'staff' || n === 'tstamp' || n === 'place',
      getAttribute: n => n === 'staff' ? staff : n === 'tstamp' ? String(tstamp) : n === 'place' ? 'below' : null,
    });

    // Pass 1: events and durations (for <divisions>).
    let den = 1;
    measures.forEach(m => {
      const mlen = fr(m.meter.count * 4, m.meter.unit);
      m.len = mlen;
      den = lcm(den, mlen[1]);
      m.staves = new Map();
      m.dirs = [];
      kids(m.el).forEach(k => {
        const nm = k.localName;
        if (nm === 'staff') {
          const layers = kids(k).filter(l => l.localName === 'layer').map(l => ({ n: parseInt(attr(l, 'n') || '1', 10), events: readLayer(l, mlen) }));
          layers.forEach(L => L.events.forEach(e => { den = lcm(den, e.dur[1]); }));
          m.staves.set(String(attr(k, 'n')), layers);
        } else if (nm === 'tie') {
          const s = (attr(k, 'startid') || '').replace(/^#/, ''), e = (attr(k, 'endid') || '').replace(/^#/, '');
          if (s) tieStart.add(s); if (e) tieStop.add(e);
        } else if (nm === 'slur') {
          const s = (attr(k, 'startid') || '').replace(/^#/, ''), e = (attr(k, 'endid') || '').replace(/^#/, '');
          if (s && e) { const no = (slurNo++ % 6) + 1; addSlur(s, { type: 'start', no }); addSlur(e, { type: 'stop', no }); }
        } else if (/^(reh|dir|tempo|dynam)$/.test(nm)) {
          if (nm === 'dir' && /^\s*⚠/.test(k.textContent || '')) return; // Score View's own warnings (e.g. "⚠ ks"), not music
          m.dirs.push(k);
          // "accel. - - -": dashes from the text to @tstamp2.
          if (nm === 'dir' && attr(k, 'extender') === 'true' && attr(k, 'tstamp2')) spans.push({ m, el: k, kind: 'dashes' });
        } else if (nm === 'octave') {
          // Ottava lines -> <octave-shift> start before the first note, stop after the last (by id).
          const s = (attr(k, 'startid') || '').replace(/^#/, ''), e = (attr(k, 'endid') || '').replace(/^#/, '');
          const size = attr(k, 'dis') === '15' ? 15 : attr(k, 'dis') === '22' ? 22 : 8, below = attr(k, 'dis.place') === 'below';
          if (s && e) {
            octStart.set(s, { type: below ? 'up' : 'down', size, place: below ? 'below' : 'above' });
            octStop.set(e, { type: 'stop', size, place: below ? 'below' : 'above' });
          }
        } else if (nm === 'trill') {
          const s = (attr(k, 'startid') || '').replace(/^#/, '');
          if (s) trills.set(s, { accid: attr(k, 'accidupper') });
        } else if (nm === 'hairpin') {
          hairpins.push({ m, el: k });
        }
      });
    });
    // Dashed text extenders ("accel. - - -"): a dashes stop at @tstamp2.
    spans.forEach(({ m, el }) => {
      const staff = (attr(el, 'staff') || '1').split(/\s+/)[0];
      const t2 = /^(\d+)m\+([\d.]+)$/.exec(attr(el, 'tstamp2') || '');
      const mi = measures.indexOf(m) + (t2 ? +t2[1] : 0);
      if (mi < measures.length) measures[mi].dirs.push(spanDir('dashes', { type: 'stop' }, staff, t2 ? t2[2] : attr(el, 'tstamp') || '1'));
    });
    hairpins.forEach(({ m, el }) => {
      const staff = (attr(el, 'staff') || '1').split(/\s+/)[0];
      m.dirs.push(wedgeDir(attr(el, 'form') === 'dim' ? 'diminuendo' : 'crescendo', staff, attr(el, 'tstamp') || '1'));
      const t2 = /^(\d+)m\+([\d.]+)$/.exec(attr(el, 'tstamp2') || '');
      const mi = measures.indexOf(m) + (t2 ? +t2[1] : 0);
      if (mi < measures.length) measures[mi].dirs.push(wedgeDir('stop', staff, t2 ? t2[2] : attr(el, 'tstamp') || '1'));
    });
    const divisions = den;
    const toDiv = f => Math.round(f[0] * divisions / f[1]);

    // Pass 2: serialize each part.
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
    out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    out.push('<score-partwise version="4.0">');
    const title = opts.title || childText(doc.getElementsByTagNameNS('*', 'titleStmt')[0] || scoreEl, 'title') || '';
    if (title) out.push(`  <work><work-title>${esc(title)}</work-title></work>`);
    const date = opts.date || new Date().toISOString().slice(0, 10);
    out.push('  <identification><encoding><software>Score View (Bitwig Studio)</software>' +
             `<encoding-date>${date}</encoding-date>` +
             '<supports element="accidental" type="yes"/><supports element="beam" type="yes"/>' +
             '<supports element="stem" type="no"/></encoding></identification>');
    out.push('  <part-list>');
    parts.forEach((p, i) => {
      struct.groups.filter(g => g.first === i).sort((a, b) => a.depth - b.depth).forEach(g => {
        out.push(`    <part-group type="start" number="${g.depth}">` + (g.name ? `<group-name>${esc(g.name)}</group-name>` : '') +
                 (g.abbr ? `<group-abbreviation>${esc(g.abbr)}</group-abbreviation>` : '') +
                 `<group-symbol>${g.symbol === 'brace' ? 'brace' : g.symbol === 'line' ? 'line' : g.symbol === 'bracketsq' ? 'square' : 'bracket'}</group-symbol>` +
                 `<group-barline>${g.barThru ? 'yes' : 'no'}</group-barline></part-group>`);
      });
      out.push(`    <score-part id="${p.id}"><part-name>${esc(p.name)}</part-name>` +
               (p.abbr ? `<part-abbreviation>${esc(p.abbr)}</part-abbreviation>` : '') +
               `<score-instrument id="${p.id}-I1"><instrument-name>${esc(cleanName(p.instrumentName))}</instrument-name>` +
               (p.sound ? `<instrument-sound>${esc(p.sound)}</instrument-sound>` : '') + '</score-instrument></score-part>');
      struct.groups.filter(g => g.last === i).sort((a, b) => b.depth - a.depth)
        .forEach(g => out.push(`    <part-group type="stop" number="${g.depth}"/>`));
    });
    out.push('  </part-list>');

    const clefXml = (c, num) => {
      const sign = c.shape === 'perc' ? 'percussion' : c.shape === 'TAB' ? 'TAB' : c.shape;
      let s = `<clef${num ? ` number="${num}"` : ''}><sign>${esc(sign)}</sign>`;
      if (sign !== 'percussion' && sign !== 'TAB') s += `<line>${c.line}</line>`;
      if (c.dis) s += `<clef-octave-change>${(c.place === 'below' ? -1 : 1) * Math.round((c.dis - 1) / 7)}</clef-octave-change>`;
      return s + '</clef>';
    };
    const timeXml = mt => `<time${mt.sym === 'common' ? ' symbol="common"' : mt.sym === 'cut' ? ' symbol="cut"' : ''}>` +
                          `<beats>${mt.count}</beats><beat-type>${mt.unit}</beat-type></time>`;
    const keysXml = (p, keyOf) => {
      const ks = p.staves.map(s => keyOf(s));
      if (ks.every(k => k === ks[0])) return `<key><fifths>${ks[0]}</fifths></key>`;
      return ks.map((k, i) => `<key number="${i + 1}"><fifths>${k}</fifths></key>`).join('');
    };

    let totalNotes = 0, outOfRange = 0;
    parts.forEach(p => {
      out.push(`  <part id="${p.id}">`);
      const multi = p.staves.length > 1;
      const curKey = new Map(p.staves.map(s => [String(s.n), s.key == null ? 0 : s.key]));
      measures.forEach((m, mi) => {
        const num = attr(m.el, 'n') || String(mi + 1);
        out.push(`    <measure number="${esc(num)}">`);
        // Attributes: everything in the first measure, changes later.
        const ch = m.changes;
        if (mi === 0) {
          let a = `<attributes><divisions>${divisions}</divisions>` + keysXml(p, s => s.key == null ? 0 : s.key) + timeXml(m.meter);
          if (multi) a += `<staves>${p.staves.length}</staves>`;
          a += p.staves.map((s, k) => clefXml(s.clef || { shape: 'G', line: 2 }, multi ? k + 1 : 0)).join('');
          const tr = transposeElement(p.transpose);
          if (tr) a += `<transpose><diatonic>${tr.diatonic}</diatonic><chromatic>${tr.chromatic}</chromatic>` +
                       (tr.octave ? `<octave-change>${tr.octave}</octave-change>` : '') + '</transpose>';
          out.push('      ' + a + '</attributes>');
        } else if (ch) {
          let a = '';
          if (p.staves.some(s => ch.keys.has(String(s.n)))) {
            p.staves.forEach(s => { if (ch.keys.has(String(s.n))) curKey.set(String(s.n), ch.keys.get(String(s.n))); });
            a += keysXml(p, s => curKey.get(String(s.n)));
          }
          if (ch.meter) a += timeXml(ch.meter);
          p.staves.forEach((s, k) => { if (ch.clefs.has(String(s.n))) a += clefXml(ch.clefs.get(String(s.n)), multi ? k + 1 : 0); });
          if (a) out.push('      <attributes>' + a + '</attributes>');
        }

        // Directions belonging to this part, as { staff (1-based in part), tick, xml }.
        const dirs = [];
        m.dirs.forEach(d => {
          const sn = (attr(d, 'staff') || p.staves[0].n).split(/\s+/)[0];
          if (staffOwner.get(String(sn)) !== p) return;
          const ts = parseFloat(attr(d, 'tstamp') || '1');
          const tick = Math.max(0, Math.round((ts - 1) * 4 / m.meter.unit * divisions));
          const staffNo = multi ? p.staffIdx.get(String(sn)) : 0;
          if (directionXml(d, staffNo, 0)) dirs.push({ staff: p.staffIdx.get(String(sn)) || 1, tick, xml: off => directionXml(d, staffNo, off), done: false });
        });
        dirs.sort((a, b) => a.tick - b.tick);

        let pos = 0;
        const flushDirs = (staffNo, upto, force) => dirs.forEach(d => {
          if (d.done || d.staff !== staffNo || (!force && d.tick > upto)) return;
          d.done = true;
          out.push('      ' + d.xml(d.tick - pos));
        });
        p.staves.forEach((s, k) => {
          const staffNo = k + 1;
          const layers = m.staves.get(String(s.n)) || [];
          if (!layers.length) flushDirs(staffNo, 0, true);
          layers.forEach((L, li) => {
            if (pos > 0) { out.push(`      <backup><duration>${pos}</duration></backup>`); pos = 0; }
            const voice = (staffNo - 1) * 4 + (L.n || li + 1);
            L.events.forEach(e => {
              if (li === 0) flushDirs(staffNo, pos, false);
              const d = toDiv(e.dur);
              if (e.kind === 'clef') {
                out.push('      <attributes>' + clefXml(e.clef, multi ? staffNo : 0) + '</attributes>');
                return;
              }
              if (e.kind === 'space') {
                if (d > 0) out.push(`      <forward><duration>${d}</duration><voice>${voice}</voice>` + (multi ? `<staff>${staffNo}</staff>` : '') + '</forward>');
                pos += d;
                return;
              }
              if (e.kind === 'note') totalNotes += e.notes.length;
              const oct = map => e.kind === 'note' && e.notes.map(n => map.get(n.id)).find(Boolean);
              const os = oct(octStart), oe = oct(octStop);
              if (os) out.push('      ' + directionXml(spanDir('octave-shift', os), multi ? staffNo : 0, 0));
              out.push(noteXml(e, d, voice, multi ? staffNo : 0));
              if (oe) out.push('      ' + directionXml(spanDir('octave-shift', oe), multi ? staffNo : 0, 0));
              pos += d;
            });
            if (li === 0) flushDirs(staffNo, pos, true);
          });
        });
        dirs.forEach(d => { if (!d.done) { d.done = true; out.push('      ' + d.xml(d.tick - pos)); } });

        const left = attr(m.el, 'left'), right = attr(m.el, 'right');
        if (left === 'rptstart' || left === 'rptboth') out.push('      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>');
        const style = { end: 'light-heavy', dbl: 'light-light', rptend: 'light-heavy', rptboth: 'light-heavy', dashed: 'dashed', dotted: 'dotted', invis: 'none', heavy: 'heavy' }[right];
        if (style) out.push(`      <barline location="right"><bar-style>${style}</bar-style>` +
                            (right === 'rptend' || right === 'rptboth' ? '<repeat direction="backward"/>' : '') + '</barline>');
        out.push('    </measure>');
      });
      out.push('  </part>');
    });
    out.push('</score-partwise>');

    // One <note>, plus following <note><chord/> elements for chord members.
    function noteXml(e, d, voice, staffNo) {
      const tail = (k) => {
        let s = `<voice>${voice}</voice>`;
        if (e.kind === 'note' || (e.kind === 'rest')) s += e.type && TYPE[e.type] ? `<type>${TYPE[e.type]}</type>` : '';
        s += '<dot/>'.repeat(e.dots || 0);
        if (k && k.accidental) s += `<accidental>${k.accidental}</accidental>`;
        if (e.tm) s += `<time-modification><actual-notes>${e.tm[0]}</actual-notes><normal-notes>${e.tm[1]}</normal-notes></time-modification>`;
        if (staffNo) s += `<staff>${staffNo}</staff>`;
        return s;
      };
      const tupletNotations = () =>
        e.tupStart.map(t => `<tuplet type="start" number="${t.level}" bracket="${t.bracket ? 'yes' : 'no'}"` +
                             (t.showNumber ? '' : ' show-number="none"') + (t.placement ? ` placement="${t.placement === 'below' ? 'below' : 'above'}"` : '') + '/>').join('') +
        e.tupStop.map(t => `<tuplet type="stop" number="${t.level}"/>`).join('');
      if (e.kind !== 'note') {
        const rest = e.kind === 'mrest' ? '<rest measure="yes"/>' : '<rest/>';
        const nt = tupletNotations();
        return `      <note>${rest}<duration>${d}</duration>` + tail(null) + (nt ? `<notations>${nt}</notations>` : '') + '</note>';
      }
      return e.notes.map((n, i) => {
        let s = '      <note' + (n.color ? ` color="${n.color}"` : '') + '>';
        if (e.grace) s += e.slash ? '<grace slash="yes"/>' : '<grace/>';
        if (i > 0) s += '<chord/>';
        // MusicXML octaves are 0..9; notes below C0 are keyswitches (shown when "Hide keyswitches" is off).
        const oct = Math.max(0, Math.min(9, n.oct));
        if (oct !== n.oct) outOfRange++;
        s += `<pitch><step>${n.step}</step>` + (n.alter ? `<alter>${n.alter}</alter>` : '') + `<octave>${oct}</octave></pitch>`;
        if (!e.grace) s += `<duration>${d}</duration>`;
        const tStop = n.tie === 't' || n.tie === 'm' || tieStop.has(n.id);
        const tStart = n.tie === 'i' || n.tie === 'm' || tieStart.has(n.id);
        if (tStop) s += '<tie type="stop"/>';
        if (tStart) s += '<tie type="start"/>';
        s += tail(n);
        if (i === 0 && e.beams) s += e.beams.map((b, L) => `<beam number="${L + 1}">${b}</beam>`).join('');
        let nt = '';
        if (tStop) nt += '<tied type="stop"/>';
        if (tStart) nt += '<tied type="start"/>';
        (slurs.get(n.id) || []).forEach(sl => { nt += `<slur type="${sl.type}" number="${sl.no}"/>`; });
        if (i === 0) {
          nt += tupletNotations();
          const tr = e.notes.map(x => trills.get(x.id)).find(Boolean);
          if (tr || e.tremolo) {
            nt += '<ornaments>' + (tr ? '<trill-mark/>' + (tr.accid && ACCIDENTAL[tr.accid] ? `<accidental-mark placement="above">${ACCIDENTAL[tr.accid]}</accidental-mark>` : '') : '') +
                  (e.tremolo ? `<tremolo type="single">${Math.min(8, e.tremolo)}</tremolo>` : '') + '</ornaments>';
          }
          if (e.technical.length) nt += '<technical>' + e.technical.map(a => `<${a}/>`).join('') + '</technical>';
          if (e.artics.length) nt += '<articulations>' + e.artics.map(a => `<${a}/>`).join('') + '</articulations>';
        }
        if (nt) s += `<notations>${nt}</notations>`;
        return s + '</note>';
      }).join('\n');
    }

    if (outOfRange) warnings.push(`${outOfRange} notes outside octaves 0-9 (keyswitches?) were moved into range`);
    return { xml: out.join('\n'), divisions, measures: measures.length, notes: totalNotes, warnings,
             parts: parts.map(p => ({ id: p.id, name: p.name, staves: p.staves.length, transpose: p.transpose, sound: p.sound })) };
  }

  // <direction> for reh / dir / tempo / dynam.
  // off = <offset> in divisions when the direction falls between notes of the voice it is written with.
  function directionXml(el, staffNo, off) {
    const kind = el.localName;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const place = attr(el, 'place') === 'below' ? 'below' : 'above';
    const staff = (off ? `<offset>${off}</offset>` : '') + (staffNo ? `<staff>${staffNo}</staff>` : '');
    const dt = inner => `<direction-type>${inner}</direction-type>`;
    if (kind === 'reh') {
      if (!text) return null;
      return `<direction placement="above">${dt(`<rehearsal enclosure="square">${esc(text)}</rehearsal>`)}${staff}</direction>`;
    }
    if (kind === 'wedge') return `<direction placement="below">${dt(`<wedge type="${el.form}"/>`)}${staff}</direction>`;
    if (kind === 'octave-shift') return `<direction placement="${el.place}">${dt(`<octave-shift type="${el.type}" size="${el.size}" number="1"/>`)}${staff}</direction>`;
    if (kind === 'dashes') return `<direction placement="above">${dt(`<dashes type="${el.type}" number="1"/>`)}${staff}</direction>`;
    if (kind === 'dynam') {
      if (!text) return null;
      const t = text.toLowerCase();
      const inner = DYNAMICS.test(t) ? `<dynamics><${t}/></dynamics>` : `<words font-style="italic">${esc(text)}</words>`;
      return `<direction placement="${attr(el, 'place') === 'above' ? 'above' : 'below'}">${dt(inner)}${staff}</direction>`;
    }
    if (kind === 'tempo') {
      const tm = parseTempo(text, attr(el, 'mm'), attr(el, 'mm.unit'), attr(el, 'mm.dots'));
      let s = `<direction placement="above">`;
      if (tm.words) s += dt(`<words font-weight="bold">${esc(tm.words)}</words>`);
      if (tm.bpm) s += dt(`<metronome parentheses="no"><beat-unit>${tm.unit}</beat-unit>${tm.dot ? '<beat-unit-dot/>' : ''}<per-minute>${tm.bpm}</per-minute></metronome>`);
      if (!tm.words && !tm.bpm) return null;
      s += staff;
      if (tm.qpm) s += `<sound tempo="${tm.qpm}"/>`;
      return s + '</direction>';
    }
    if (!text) return null;
    const italic = kids(el).some(k => k.localName === 'rend' && attr(k, 'fontstyle') === 'italic');
    const dashes = attr(el, 'extender') === 'true' && attr(el, 'tstamp2') ? dt('<dashes type="start" number="1"/>') : '';
    return `<direction placement="${place}">${dt(`<words${italic ? ' font-style="italic"' : ''}>${esc(text)}</words>`)}${dashes}${staff}</direction>`;
  }

  const UNIT_NAMES = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th' };
  const UNIT_SYMBOLS = [
    [/^(♩|𝅘𝅥|q|quarter|crotchet)$/i, 4], [/^(𝅗𝅥|h|half|minim)$/i, 2], [/^(♪|𝅘𝅥𝅮|e|eighth|quaver)$/i, 8], [/^(𝅝|w|whole)$/i, 1],
  ];
  // "Allegro ♩ = 132", "q.=60", "120 bpm", or @mm/@mm.unit -> { words, unit, dot, bpm, qpm }.
  function parseTempo(text, mm, mmUnit, mmDots) {
    let words = text, unitN = 4, dot = false, bpm = null;
    const m = /(♩|𝅘𝅥|𝅗𝅥|♪|𝅘𝅥𝅮|𝅝|\bq\b|\bh\b|\be\b|quarter|half|eighth|crotchet|minim|quaver)\s*(\.?)\s*=\s*(\d+(?:\.\d+)?)/i.exec(text);
    if (m) {
      const hit = UNIT_SYMBOLS.find(([re]) => re.test(m[1]));
      unitN = hit ? hit[1] : 4; dot = !!m[2]; bpm = parseFloat(m[3]);
      words = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      const b = /(\d+(?:\.\d+)?)\s*bpm\b/i.exec(text);
      if (b) { bpm = parseFloat(b[1]); words = (text.slice(0, b.index) + text.slice(b.index + b[0].length)).replace(/\s+/g, ' ').trim(); }
    }
    if (bpm == null && mm) { bpm = parseFloat(mm); unitN = parseInt(mmUnit || '4', 10) || 4; dot = !!parseInt(mmDots || '0', 10); }
    if (bpm == null || !UNIT_NAMES[unitN]) return { words: text };
    const qpm = Math.round(bpm * (4 / unitN) * (dot ? 1.5 : 1) * 100) / 100;
    return { words, unit: UNIT_NAMES[unitN], dot, bpm: Math.round(bpm * 100) / 100, qpm };
  }

  function fileName(base) {
    const s = cleanName(base).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
    return (s || 'Score') + '.musicxml';
  }

  const api = { fromMEI, prepareExport, transposeElement, instrumentTranspose, fallbackTranspose, soundId, parseTempo, fileName };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.SVMusicXML = api;

  // ------------------------------------------------------------------ browser UI

  const SV = root.SV;
  if (!SV) return;
  SV.musicxml = api;
  const PREF = 'scoreview.musicxml.';
  const pref = (k, d) => { try { const v = localStorage.getItem(PREF + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(PREF + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };

  let lastBuildOpts = null;
  SV.hooks.buildOptions.push(buildOpts => { lastBuildOpts = buildOpts; });

  SV.addStyle(`
    #mxGroup select { max-width: 13em; }
    #mxGroup .mxOpt { color: var(--dim); white-space: nowrap; }
  `);
  const group = document.createElement('div');
  group.className = 'group';
  group.id = 'mxGroup';
  group.innerHTML =
    '<button class="btn" id="mxExport" title="Download MusicXML 4.0 for Dorico (written pitch, with transposition info)">Export MusicXML</button>' +
    '<select id="mxRange" title="What to export">' +
    '<option value="view">Current view</option>' +
    '<option value="song">Whole song</option>' +
    '<option value="songAll">Whole song, all tracks</option></select>' +
    '<label class="mxOpt" title="Strings, winds etc. that Score View split over two staves are exported on one staff (Dorico chooses clefs/ottavas)">' +
    '<input type="checkbox" id="mxSingle"> 1 staff for non-keyboard</label>';
  SV.addToolbar(group, { cluster: 'file', order: 140 });
  const $ = id => document.getElementById(id);
  $('mxSingle').checked = pref('singleStaff', true);
  $('mxSingle').addEventListener('change', e => setPref('singleStaff', e.target.checked));
  $('mxRange').value = pref('range', 'view');
  $('mxRange').addEventListener('change', e => setPref('range', e.target.value));
  const syncRange = () => {
    const scoreMode = SV.state.mode === 'score' && !!SV.state.base;
    ['song', 'songAll'].forEach(v => { $('mxRange').querySelector(`option[value="${v}"]`).disabled = !scoreMode; });
    if (!scoreMode && $('mxRange').value !== 'view') $('mxRange').value = 'view';
  };
  SV.hooks.afterRender.push(syncRange);

  // Renders with range/trackMode temporarily changed, calls fn(render), restores the view.
  function withScope(scope, fn) {
    const st = SV.state;
    const want = { range: scope === 'view' ? st.range : 'all', trackMode: scope === 'songAll' ? 'all' : st.trackMode };
    if (scope === 'view' || st.mode !== 'score' || (want.range === st.range && want.trackMode === st.trackMode)) return fn(st.render);
    const prev = { range: st.range, trackMode: st.trackMode };
    Object.assign(st, want);
    try { SV.render(); return fn(st.render); } finally { Object.assign(st, prev); SV.render(); }
  }

  function exportName(render, scope) {
    const st = SV.state;
    if (st.mode === 'score' && st.base) {
      let n = st.base.title || render.score.title || 'Score';
      if (scope === 'view' && st.range === 'clip' && render.measureOffset != null) {
        const a = render.measureOffset + 1;
        n += ` - bars ${a}-${a + render.measures - 1}`;
      }
      return fileName(n);
    }
    return fileName(SV.currentTrack() || render.score.title || 'Score');
  }

  /** Builds the MusicXML for scope 'view' | 'song' | 'songAll'; returns { filename, xml, info }. */
  function build(scope) {
    return withScope(scope || 'view', render => {
      if (!render) throw new Error('Nothing to export');
      const prep = prepareExport(render, { ScoreBuilder: SV.ScoreBuilder, buildOptions: lastBuildOpts || {}, instruments: SV.instruments,
                                           singleStaff: $('mxSingle').checked, writtenPitch: true });
      const res = fromMEI(prep.mei, { score: prep.score, staves: prep.staves, instruments: SV.instruments,
                                      title: (SV.state.base && SV.state.base.title) || cleanName(render.score.title) });
      return { filename: exportName(render, scope), xml: res.xml, info: { ...res, changed: prep.changed } };
    });
  }

  function download(filename, xml) {
    const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  function exportNow() {
    try {
      const r = build($('mxRange').value);
      download(r.filename, r.xml);
      api.lastExport = r;
      SV.flash(`Exported ${r.filename}: ${r.info.parts.length} parts, ${r.info.measures} bars, ${r.info.notes} notes`);
    } catch (err) {
      console.error('MusicXML export', err);
      SV.flash('MusicXML export failed: ' + err.message);
    }
  }
  $('mxExport').addEventListener('click', exportNow);
  api.build = build;
  api.exportNow = exportNow;
  SV.addHelp('<b>Export MusicXML</b> downloads the score for Dorico (File → Import → MusicXML). Transposing instruments are written in written pitch with transposition info.');
})(this);
