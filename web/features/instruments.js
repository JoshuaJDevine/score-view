// Feature module: instruments. See docs/AGENTS.md for the SV hook API.
// Instrument database + fuzzy track-name lookup; sets clefs, labels, grand staves, transposition and
// range colours on each part before engraving. Exposes window.SV.instruments for other modules.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ database
  const TREBLE = ['G', 2], BASS = ['F', 4], ALTO = ['C', 3], TENOR = ['C', 4], PERC = ['perc', 3];
  const TREBLE_8VB = { shape: 'G', line: 2, dis: 8, disPlace: 'below' };

  // Pitch numbers are MIDI (C4 = 60), sounding. `octave` = written-minus-sounding octave shift that is kept
  // even in a concert-pitch score (piccolo, glockenspiel, double bass...); `transpose` = the full
  // written-minus-sounding interval used in a transposed score. `tclef` = clef used in a transposed score.
  // aliases: space-separated words that must all occur in the track name (typos tolerated);
  // "word@family" only applies when the track's group looks like that family (e.g. "bass@voices").
  const DB = [];
  function def(id, name, plural, abbr, family, order, clef, range, comfort, o) {
    DB.push(Object.assign({ id, name, plural, abbr, family, order, clef, range, comfort,
      octave: 0, transpose: 0, grand: false, aliases: [] }, o || {}));
  }
  const WW = 'woodwinds', BR = 'brass', PC = 'percussion', KB = 'keyboards', VO = 'voices', ST = 'strings', OT = 'other';

  def('piccolo', 'Piccolo', 'Piccolos', 'Picc.', WW, 100, TREBLE, [74, 108], [74, 103],
    { octave: -12, transpose: -12, aliases: ['piccolo', 'picc', 'ottavino', 'piccolo flute'] });
  def('flute', 'Flute', 'Flutes', 'Fl.', WW, 110, TREBLE, [59, 98], [60, 93],
    { aliases: ['flute', 'fl', 'flauto', 'flauti'] });
  def('altoflute', 'Alto Flute', 'Alto Flutes', 'A. Fl.', WW, 120, TREBLE, [55, 91], [55, 86],
    { transpose: 5, keyName: 'G', aliases: ['alto flute', 'afl', 'alto fl', 'flute in g'] });
  def('bassflute', 'Bass Flute', 'Bass Flutes', 'B. Fl.', WW, 130, TREBLE, [48, 84], [48, 79],
    { octave: 12, transpose: 12, aliases: ['bass flute', 'bfl', 'bass fl', 'bs flute'] });
  def('oboe', 'Oboe', 'Oboes', 'Ob.', WW, 140, TREBLE, [58, 93], [60, 88],
    { aliases: ['oboe', 'ob', 'oboi'] });
  def('coranglais', 'Cor Anglais', 'Cors Anglais', 'C. A.', WW, 150, TREBLE, [52, 84], [52, 79],
    { transpose: 7, keyName: 'F', aliases: ['cor anglais', 'english horn', 'eh', 'ca', 'corno inglese', 'cor ang'] });
  def('clarinet-eb', 'Clarinet in E♭', 'Clarinets in E♭', 'E♭ Cl.', WW, 160, TREBLE, [55, 96], [55, 91],
    { transpose: -3, aliases: ['eb clarinet', 'clarinet eb', 'clarinet in eb', 'e flat clarinet', 'eb cl', 'piccolo clarinet'] });
  def('clarinet', 'Clarinet in B♭', 'Clarinets in B♭', 'Cl.', WW, 170, TREBLE, [50, 94], [50, 89],
    { transpose: 2, aliases: ['clarinet', 'cl', 'clar', 'clarinetto', 'klarinette', 'bb clarinet', 'clarinet bb', 'clarinet in bb'] });
  def('clarinet-a', 'Clarinet in A', 'Clarinets in A', 'Cl.', WW, 175, TREBLE, [49, 93], [49, 88],
    { transpose: 3, aliases: ['clarinet in a', 'clarinet a', 'a clarinet', 'cl in a'] });
  def('bassclarinet', 'Bass Clarinet', 'Bass Clarinets', 'B. Cl.', WW, 180, BASS, [34, 77], [38, 72],
    { transpose: 14, tclef: TREBLE, aliases: ['bass clarinet', 'bcl', 'bass cl', 'bs clarinet', 'bassklarinette'] });
  def('cbclarinet', 'Contrabass Clarinet', 'Contrabass Clarinets', 'Cb. Cl.', WW, 185, BASS, [22, 65], [26, 60],
    { transpose: 26, tclef: TREBLE, aliases: ['contrabass clarinet', 'contra clarinet', 'cb clarinet', 'cbcl'] });
  def('bassoon', 'Bassoon', 'Bassoons', 'Bsn.', WW, 190, BASS, [34, 76], [34, 72],
    { altClefs: [TENOR], aliases: ['bassoon', 'bsn', 'fagott', 'fagotto', 'fagotti'] });
  def('contrabassoon', 'Contrabassoon', 'Contrabassoons', 'Cbsn.', WW, 200, BASS, [22, 60], [22, 53],
    { octave: 12, transpose: 12, aliases: ['contrabassoon', 'contra bassoon', 'cbsn', 'contrafagotto', 'kontrafagott', 'cbassoon'] });
  def('sopranosax', 'Soprano Saxophone', 'Soprano Saxophones', 'S. Sax.', WW, 210, TREBLE, [56, 87], [58, 84],
    { transpose: 2, aliases: ['soprano sax', 'soprano saxophone', 'ssax'] });
  def('altosax', 'Alto Saxophone', 'Alto Saxophones', 'A. Sax.', WW, 220, TREBLE, [49, 80], [51, 77],
    { transpose: 9, aliases: ['alto sax', 'alto saxophone', 'asax', 'sax', 'saxophone'] });
  def('tenorsax', 'Tenor Saxophone', 'Tenor Saxophones', 'T. Sax.', WW, 230, BASS, [44, 75], [46, 72],
    { transpose: 14, tclef: TREBLE, aliases: ['tenor sax', 'tenor saxophone', 'tsax'] });
  def('barisax', 'Baritone Saxophone', 'Baritone Saxophones', 'Bar. Sax.', WW, 240, BASS, [37, 68], [39, 65],
    { transpose: 21, tclef: TREBLE, aliases: ['baritone sax', 'bari sax', 'baritone saxophone', 'bsax'] });

  def('horn', 'Horn in F', 'Horns in F', 'Hn.', BR, 300, TREBLE, [35, 77], [41, 72],
    { transpose: 7, altClefs: [BASS], aliases: ['horn', 'hn', 'hrn', 'french horn', 'horn in f', 'corno', 'corni', 'f horn'] });
  def('piccolotrumpet', 'Piccolo Trumpet in B♭', 'Piccolo Trumpets in B♭', 'Picc. Tpt.', BR, 310, TREBLE, [62, 91], [64, 88],
    { transpose: -10, aliases: ['piccolo trumpet', 'picc trumpet', 'picc tpt'] });
  def('trumpet-c', 'Trumpet in C', 'Trumpets in C', 'Tpt.', BR, 315, TREBLE, [54, 86], [54, 81],
    { aliases: ['trumpet in c', 'c trumpet', 'trumpet c', 'tpt in c', 'tpt c'] });
  def('trumpet', 'Trumpet in B♭', 'Trumpets in B♭', 'Tpt.', BR, 320, TREBLE, [52, 84], [52, 79],
    { transpose: 2, aliases: ['trumpet', 'tpt', 'trp', 'tromba', 'trombe', 'trompete', 'bb trumpet', 'trumpet bb', 'trumpet in bb'] });
  def('trombone', 'Trombone', 'Trombones', 'Tbn.', BR, 330, BASS, [40, 74], [40, 70],
    { altClefs: [TENOR], aliases: ['trombone', 'tbn', 'trb', 'tbone', 'tenor trombone', 'tn trombone', 'ten trombone', 'posaune', 'tromboni'] });
  def('basstrombone', 'Bass Trombone', 'Bass Trombones', 'B. Tbn.', BR, 340, BASS, [28, 67], [34, 62],
    { altClefs: [TENOR], aliases: ['bass trombone', 'bs trombone', 'b trombone', 'btbn', 'bass tbn', 'bs tbn', 'bass@brass'] });
  def('cimbasso', 'Cimbasso', 'Cimbassi', 'Cimb.', BR, 350, BASS, [26, 62], [29, 58],
    { aliases: ['cimbasso', 'cimbassi', 'cimb'] });
  def('tuba', 'Tuba', 'Tubas', 'Tba.', BR, 360, BASS, [26, 65], [29, 58],
    { aliases: ['tuba', 'tba', 'contrabass tuba', 'bass tuba'] });

  def('timpani', 'Timpani', 'Timpani', 'Timp.', PC, 400, BASS, [36, 60], [38, 57],
    { section: false, aliases: ['timpani', 'timp', 'timps', 'kettle drums', 'kettledrums', 'pauken'] });
  def('percussion', 'Percussion', 'Percussion', 'Perc.', PC, 410, PERC, null, null,
    { unpitched: true, section: false, aliases: ['percussion', 'perc', 'untuned percussion', 'drums', 'drum', 'drum kit', 'kit', 'snare',
      'bass drum', 'cymbal', 'cymbals', 'tam tam', 'gong', 'toms', 'triangle', 'tambourine', 'taiko', 'auxiliary'] });
  def('glockenspiel', 'Glockenspiel', 'Glockenspiels', 'Glock.', PC, 420, TREBLE, [79, 108], [79, 108],
    { octave: -24, transpose: -24, aliases: ['glockenspiel', 'glock', 'orchestral bells'] });
  def('crotales', 'Crotales', 'Crotales', 'Crot.', PC, 425, TREBLE, [84, 108], [84, 108],
    { octave: -24, transpose: -24, aliases: ['crotales', 'antique cymbals'] });
  def('xylophone', 'Xylophone', 'Xylophones', 'Xyl.', PC, 430, TREBLE, [65, 108], [65, 108],
    { octave: -12, transpose: -12, aliases: ['xylophone', 'xylo', 'xyl'] });
  def('vibraphone', 'Vibraphone', 'Vibraphones', 'Vib.', PC, 440, TREBLE, [53, 89], [53, 89],
    { aliases: ['vibraphone', 'vibes', 'vib', 'vibra'] });
  def('marimba', 'Marimba', 'Marimbas', 'Mar.', PC, 450, TREBLE, [33, 96], [45, 96],
    { grand: true, aliases: ['marimba', 'mrb', 'marimbaphone'] });
  def('tubularbells', 'Tubular Bells', 'Tubular Bells', 'T. Bells', PC, 460, TREBLE, [60, 77], [60, 77],
    { aliases: ['tubular bells', 'bells', 'chimes', 'tub bells', 'campane'] });

  def('harp', 'Harp', 'Harps', 'Hp.', KB, 500, TREBLE, [23, 104], [24, 103],
    { grand: true, aliases: ['harp', 'hp', 'arpa', 'harfe'] });
  def('celesta', 'Celesta', 'Celestas', 'Cel.', KB, 510, TREBLE, [60, 108], [60, 108],
    { octave: -12, transpose: -12, grand: true, aliases: ['celesta', 'celeste', 'cel', 'celesta'] });
  def('harpsichord', 'Harpsichord', 'Harpsichords', 'Hpd.', KB, 515, TREBLE, [29, 89], [29, 89],
    { grand: true, aliases: ['harpsichord', 'cembalo', 'hpsd'] });
  def('piano', 'Piano', 'Pianos', 'Pno.', KB, 520, TREBLE, [21, 108], [21, 108],
    { grand: true, aliases: ['piano', 'pno', 'pianoforte', 'grand piano', 'upright piano', 'klavier'] });
  def('organ', 'Organ', 'Organs', 'Org.', KB, 530, TREBLE, [24, 96], [24, 96],
    { grand: true, aliases: ['organ', 'org', 'orgel', 'pipe organ'] });
  def('guitar', 'Guitar', 'Guitars', 'Gtr.', KB, 540, TREBLE_8VB, [40, 83], [40, 79],
    { aliases: ['guitar', 'gtr', 'acoustic guitar', 'classical guitar', 'electric guitar', 'gitarre'] });
  def('bassguitar', 'Bass Guitar', 'Bass Guitars', 'B. Gtr.', KB, 545, BASS, [28, 67], [28, 60],
    { octave: 12, transpose: 12, aliases: ['bass guitar', 'electric bass', 'e bass', 'bass gtr', 'fretless bass'] });

  def('soprano', 'Soprano', 'Sopranos', 'S.', VO, 600, TREBLE, [60, 84], [62, 79],
    { aliases: ['soprano', 'sop', 'soprani', 'treble voice'] });
  def('alto', 'Alto', 'Altos', 'A.', VO, 610, TREBLE, [53, 77], [55, 74],
    { aliases: ['alto', 'contralto', 'mezzo', 'mezzo soprano', 'alti'] });
  def('tenor', 'Tenor', 'Tenors', 'T.', VO, 620, TREBLE_8VB, [48, 72], [50, 67],
    { aliases: ['tenor', 'tenori', 'tenor voice'] });
  def('bass-voice', 'Bass', 'Basses', 'B.', VO, 630, BASS, [40, 64], [41, 62],
    { aliases: ['bass voice', 'baritone', 'bass@voices', 'bassi@voices', 'basses@voices', 'baritone voice'] });

  def('violin', 'Violin', 'Violins', 'Vln.', ST, 700, TREBLE, [55, 100], [55, 93],
    { aliases: ['violin', 'vln', 'vn', 'vl', 'violino', 'violini', 'geige'] });
  def('viola', 'Viola', 'Violas', 'Vla.', ST, 710, ALTO, [48, 88], [48, 81],
    { altClefs: [TREBLE], aliases: ['viola', 'vla', 'va', 'viole', 'bratsche'] });
  def('cello', 'Cello', 'Cellos', 'Vc.', ST, 720, BASS, [36, 81], [36, 76],
    { altClefs: [TENOR, TREBLE], aliases: ['cello', 'vc', 'vlc', 'violoncello', 'celli', 'violoncelli'] });
  def('doublebass', 'Double Bass', 'Double Basses', 'Db.', ST, 730, BASS, [24, 67], [28, 55],
    { octave: 12, transpose: 12, aliases: ['double bass', 'contrabass', 'bass', 'db', 'cb', 'kb',
      'kontrabass', 'contrabassi', 'string bass', 'upright bass', 'bass@strings'] });

  def('synth', 'Synth', 'Synths', 'Syn.', OT, 900, null, null, null,
    { auto: true, section: false, aliases: ['synth', 'synthesizer', 'pad', 'lead', 'arp', 'pluck', 'sub', 'fx', 'sfx',
      'atmos', 'bass@other'] });
  def('other', 'Other', 'Other', '', OT, 950, null, null, null, { auto: true, section: false, aliases: [] });

  const BY_ID = new Map(DB.map(i => [i.id, i]));
  DB.forEach(inst => {
    inst.patterns = inst.aliases.map(a => {
      const [words, fam] = a.split('@');
      return { words: words.split(' '), fam: fam || null };
    });
  });

  // Group names -> family hint (for "Bass" in Strings vs Synth etc.).
  const GROUP_WORDS = [
    [ST, ['strings', 'string', 'str', 'streicher', 'violins', 'basses']],
    [BR, ['brass', 'blech', 'horns', 'trumpets', 'trombones']],
    [WW, ['woodwinds', 'woodwind', 'winds', 'wind', 'ww', 'holz', 'flutes', 'reeds']],
    [PC, ['percussion', 'perc', 'drums', 'tuned percussion', 'mallets']],
    [VO, ['choir', 'voices', 'vocals', 'vocal', 'vox', 'chorus', 'chor', 'singers']],
    [OT, ['synth', 'synths', 'electronic', 'electronics', 'pads', 'fx', 'sfx', 'sound design', 'chiptune']],
  ];

  // ------------------------------------------------------------------ fuzzy matching

  function editDistance(a, b) { // optimal string alignment (adjacent transpositions count 1)
    const d = [];
    for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  // How well a track-name token matches an alias word (0 = no match).
  function wordMatch(tok, word) {
    if (tok === word) return 1;
    const stems = [tok];
    if (tok.length > 3 && tok.endsWith('s')) stems.push(tok.slice(0, -1));
    if (tok.length > 4 && tok.endsWith('es')) stems.push(tok.slice(0, -2));
    if (stems.includes(word)) return 0.95;
    if (word.length <= 3 || tok.length <= 3) return 0;
    let best = 0;
    for (const s of stems) {
      const max = s.length >= 8 && word.length >= 8 ? 2 : s.length >= 5 && word.length >= 5 ? 1 : 0;
      if (max && Math.abs(s.length - word.length) <= max) {
        const dist = editDistance(s, word);
        if (dist <= max) best = Math.max(best, dist === 1 ? 0.8 : 0.6);
      }
    }
    if (!best && word.length >= 4 && tok.startsWith(word)) best = 0.7; // glock -> glockenspiel, perc -> percussion
    return best;
  }

  // Matches all words of a pattern against distinct tokens; returns summed quality or 0.
  function patternScore(tokens, words) {
    const used = new Set();
    let total = 0;
    for (const w of words) {
      let best = 0, bi = -1;
      tokens.forEach((t, i) => {
        if (used.has(i)) return;
        const q = wordMatch(t, w);
        if (q > best) { best = q; bi = i; }
      });
      if (!best) return 0;
      used.add(bi);
      total += best;
    }
    return total;
  }

  const lower = s => String(s || '').toLowerCase().replace(/✎/g, ' ').replace(/[–—]/g, '-')
    .replace(/\b([a-g])\s*(♭|-?flat\b)/g, '$1b').replace(/\b([a-g])\s*(♯|-?sharp\b)/g, '$1#');
  const splitDigits = s => s.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z]{3,})/g, '$1 $2');
  const normalize = s => splitDigits(lower(s));

  function familyOfGroup(group) {
    if (!group) return null;
    const toks = normalize(group).split(/[^a-z0-9#]+/).filter(Boolean);
    let best = null, bestQ = 0;
    GROUP_WORDS.forEach(([fam, words]) => words.forEach(w => {
      const q = patternScore(toks, w.split(' '));
      if (q > bestQ) { bestQ = q; best = fam; }
    }));
    return best;
  }

  const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
  const toRoman = n => ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] || String(n);

  // Splits a track name into instrument words and modifiers (section size, player number, solo).
  function parseName(name) {
    let s = lower(name);
    const info = { size: 0, number: 0, numberStyle: 'arabic', range: null, solo: false, section: false };
    s = s.replace(/\b(?:a|x)([2-9]|1[0-6])\b/, (m, n) => { info.size = +n; return ' '; });
    s = splitDigits(s);
    s = s.replace(/\b(\d{1,2})\s*(?:-|&|\+|\/|\.|,)\s*(\d{1,2})\b/, (m, a, b) => { info.range = [+a, +b]; return ' '; });
    s = s.replace(/^\s*(\d{1,2})\s+(?=[a-z])/, (m, n) => { info.size = +n; return ' '; });
    s = s.replace(/\b(\d)(?:st|nd|rd|th)\b/, (m, n) => { info.number = +n; return ' '; });
    if (/\bsolo\b|\bsoloist\b/.test(s)) { info.solo = true; s = s.replace(/\bsolo(ist)?\b/g, ' '); }
    if (/\b(section|sect|ens|ensemble|tutti)\b/.test(s)) { info.section = true; s = s.replace(/\b(section|sect|ens|ensemble|tutti)\b/g, ' '); }
    const tokens = s.split(/[^a-z0-9#]+/).filter(Boolean);
    const rest = [];
    tokens.forEach(t => {
      if (!info.number && /^\d{1,2}$/.test(t)) { info.number = +t; return; }
      if (!info.number && ROMAN[t] && t !== 'v' && t !== 'vi') { info.number = ROMAN[t]; info.numberStyle = 'roman'; return; }
      if (!info.number && (t === 'v' || t === 'vi') && rest.length) { info.number = ROMAN[t]; info.numberStyle = 'roman'; return; }
      rest.push(t);
    });
    if (info.range) info.size = info.range[1] - info.range[0] + 1;
    info.tokens = rest;
    return info;
  }

  /** Finds the instrument for a track name (group = the Bitwig group track's name, optional). */
  function lookup(name, group) {
    const info = parseName(name);
    const fam = familyOfGroup(group);
    let best = null;
    DB.forEach(inst => {
      inst.patterns.forEach(p => {
        if (p.fam && p.fam !== fam) return;
        let sc = patternScore(info.tokens, p.words);
        if (!sc) return;
        if (p.fam) sc += 0.3;
        if (fam && inst.family === fam) sc += 0.2;
        if (!best || sc > best.score + 1e-9) best = { inst, score: sc, words: p.words };
      });
    });
    const inst = best ? best.inst : fam === OT ? BY_ID.get('synth') : BY_ID.get('other');
    // "Horns", "Tumpets": a plural of the matched word means a section even without "a4".
    if (best) info.plural = info.tokens.some(t => /[^s]s$/.test(t) && best.words.some(w =>
      !w.endsWith('s') && wordMatch(t, w) > 0 && wordMatch(t.replace(/e?s$/, ''), w) >= wordMatch(t, w)));
    return describe(inst, info, name, !!best);
  }

  // Display label for an instrument with the modifiers from the track name.
  function describe(inst, info, trackName, matched) {
    const clean = String(trackName || '').replace(/\s*✎\s*$/, '').replace(/\s+/g, ' ').trim();
    const r = { id: inst.id, inst, matched, size: info.size, number: info.number, solo: info.solo, trackName: clean };
    if (inst.auto) { r.label = clean || inst.name; r.abbr = r.label; return r; }
    const n = info.number;
    const num = n ? (info.numberStyle === 'roman' || inst.family === ST ? toRoman(n) : String(n)) : '';
    if (inst.family === ST && !info.solo && inst.section !== false) {
      r.label = inst.plural + (num ? ' ' + num : '');
      r.abbr = inst.abbr.replace(/\.$/, 's.') + (num ? ' ' + num : '');
    } else if (inst.family === ST) {
      r.label = 'Solo ' + inst.name + (num ? ' ' + num : '');
      r.abbr = 'Solo ' + inst.abbr;
    } else if (info.size > 1 && inst.section !== false) {
      const lo = info.range ? info.range[0] : 1, hi = lo + info.size - 1;
      const players = lo + '–' + hi;
      r.label = inst.plural + ' ' + players;
      r.abbr = inst.abbr + ' ' + players;
    } else if (info.plural && !num && inst.section !== false) {
      r.label = inst.plural;
      r.abbr = inst.abbr;
    } else {
      r.label = inst.name + (num ? ' ' + num : '');
      r.abbr = inst.abbr + (num ? ' ' + num : '');
    }
    return r;
  }

  // Staff-middle pitch of a clef, for choosing between a primary and alternative clefs.
  function clefCenter(c) {
    const shape = Array.isArray(c) ? c[0] : c.shape, line = Array.isArray(c) ? c[1] : c.line;
    const dis = Array.isArray(c) ? 0 : (c.dis ? (c.disPlace === 'below' ? -12 : 12) * c.dis / 8 : 0);
    if (shape === 'G') return 71 + (line - 2) * -3.5 + dis;
    if (shape === 'F') return 50 + (line - 4) * -3.5 + dis;
    if (shape === 'C') return 60 + (line - 3) * -3.5 + dis;
    return 71;
  }

  // Ottava lines an instrument's players read (octaves up / down); score.js decides where per phrase.
  // Flutes, violins, guitar: 8va; keyboards and mallets: 8va/15ma and 8vb; brass, voices, low strings: none
  // (they change clef instead).
  const OTTAVA = {
    piccolo: { up: 1 }, flute: { up: 1 }, violin: { up: 1 }, guitar: { up: 1 }, crotales: { up: 1 },
    glockenspiel: { up: 1 }, xylophone: { up: 1 }, vibraphone: { up: 1 }, marimba: { up: 1, down: 1 },
    harp: { up: 1, down: 1 }, celesta: { up: 1, down: 1 }, harpsichord: { up: 1, down: 1 },
    piano: { up: 2, down: 1 }, organ: { up: 1, down: 1 },
  };
  function ottavaFor(inst) {
    if (inst.auto) return undefined;           // synths etc.: score.js default (by clef)
    const o = OTTAVA[inst.id];
    return o ? { up: o.up || 0, down: o.down || 0 } : false;
  }

  // Picks the clef for written pitches: primary unless the music sits well outside its staff.
  function chooseClef(inst, writtenPitches, transposed) {
    const primary = (transposed && inst.tclef) || inst.clef;
    if (!inst.altClefs || writtenPitches.length < 4) return primary;
    const sorted = writtenPitches.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const off = c => Math.abs(med - clefCenter(c));
    if (off(primary) <= 9) return primary;
    let best = primary;
    inst.altClefs.forEach(c => { if (off(c) + 2 < off(best)) best = c; });
    return best;
  }

  // Octave shift that centres unpitched (drum-map) notes on a percussion staff.
  function percussionShift(pitches) {
    if (!pitches.length) return 0;
    const sorted = pitches.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    return Math.round((71 - med) / 12) * 12;
  }

  // ------------------------------------------------------------------ settings (localStorage)
  const KEY = 'scoreview.instruments.';
  const store = {
    get(k, d) { try { const v = root.localStorage && root.localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (root.localStorage) root.localStorage.setItem(KEY + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const settings = {
    names: store.get('names', true),        // label staves with instrument names (else track names)
    transposed: store.get('transposed', false), // transposed score (default: concert pitch)
    ranges: store.get('ranges', false),     // colour notes outside the instrument's range
    overrides: store.get('overrides', {}),  // trackName -> instrument id
  };
  const save = () => {
    store.set('names', settings.names); store.set('transposed', settings.transposed);
    store.set('ranges', settings.ranges); store.set('overrides', settings.overrides);
  };

  const cleanName = n => String(n || '').replace(/\s*✎\s*$/, '').trim();

  // Group of a track: from the DAWproject export or Bitwig's flat track list (group rows precede members).
  function groupOf(name) {
    const SV = root.SV, st = SV && SV.state;
    if (!st) return null;
    name = cleanName(name);
    const bp = st.base && st.base.parts && st.base.parts.find(p => p.name === name);
    if (bp && bp.group) return bp.group;
    const tracks = st.liveData && st.liveData.tracks;
    if (tracks) {
      let g = null;
      for (const t of tracks) {
        if (t.group) g = t.name;
        else if (t.name === name) return g;
      }
    }
    return null;
  }

  /** Full instrument info for a part, honouring the user's manual override and the current mode. */
  function forPart(part, opts) {
    opts = opts || {};
    const transposed = opts.transposed != null ? opts.transposed : settings.transposed;
    const name = cleanName(part.name);
    const group = part.group != null ? part.group : groupOf(name);
    const auto = lookup(name, group);
    const ovId = (opts.overrides || settings.overrides)[name];
    const r = ovId && BY_ID.has(ovId) ? describe(BY_ID.get(ovId), parseName(name), name, true) : auto;
    r.auto = auto.id;
    r.override = ovId && BY_ID.has(ovId) ? ovId : null;
    r.group = group;
    const inst = r.inst;
    r.scoreOrder = inst.order + (inst.family === ST && r.solo ? -50 : 0) + (r.number || 0) * 0.01;
    r.range = inst.range; r.comfort = inst.comfort;
    r.grand = inst.grand;
    r.octave = inst.octave;
    r.transpose = transposed ? inst.transpose : inst.octave;
    if (inst.unpitched) {
      const ps = (part.notes || []).map(n => n.pitch).filter(p => p >= 24);
      r.transpose = percussionShift(ps);
    }
    if (inst.auto) r.clef = null;
    else if (inst.grand) r.clef = null;
    else {
      const written = (part.notes || []).filter(n => n.pitch >= 24).map(n => n.pitch + r.transpose);
      r.clef = chooseClef(inst, written, transposed);
      // Clefs score.js may change to mid-staff (the whole-part choice above stays preferred).
      const primary = (transposed && inst.tclef) || inst.clef;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      r.altClefs = [primary].concat(inst.altClefs || []).filter(c => !same(c, r.clef));
      if (!inst.altClefs) r.altClefs = [];
    }
    r.ottava = ottavaFor(inst);
    return r;
  }

  /** transformScore hook body: sets clef/label/grand/transpose and range colours on each part. */
  function transform(score, opts) {
    opts = opts || {};
    const names = opts.names != null ? opts.names : settings.names;
    const ranges = opts.ranges != null ? opts.ranges : settings.ranges;
    score.parts = score.parts.map(part => {
      const info = forPart(part, opts);
      const inst = info.inst;
      const p = Object.assign({}, part);
      p.instrument = info.id;
      p.scoreOrder = info.scoreOrder;
      if (!inst.auto) {
        p.grand = info.grand;
        if (info.clef) p.clef = info.clef;
        if (info.altClefs) p.altClefs = info.altClefs;
        if (info.ottava !== undefined) p.ottava = info.ottava;
        if (info.transpose) p.transpose = info.transpose; else delete p.transpose;
        if (inst.unpitched || inst.id === 'timpani') p.noKeySig = true; // percussion and timpani: no key signature
      }
      if (names && !inst.auto) {
        const live = /✎\s*$/.test(part.name);
        p.label = info.label + (live ? ' ✎' : '');
        p.abbr = info.abbr;
      }
      if (ranges && info.range) {
        const [lo, hi] = info.range, [clo, chi] = info.comfort || info.range;
        p.notes = part.notes.map(n => {
          if (n.pitch < 24) return n;
          const color = n.pitch < lo || n.pitch > hi ? '#d6336c' : n.pitch < clo || n.pitch > chi ? '#f08c00' : null;
          return color ? Object.assign({}, n, { color }) : n;
        });
      }
      return p;
    });
    return score;
  }

  const api = {
    lookup, forPart, transform, parseName,
    all: () => DB.slice(),
    get: id => BY_ID.get(id) || null,
    isTransposed: () => settings.transposed,
    showsInstrumentNames: () => settings.names,
    rangesOn: () => settings.ranges,
    settings,
    /** Sets (or clears with null) the manual instrument for a track; re-renders. */
    setOverride(trackName, id) {
      const n = cleanName(trackName);
      if (id) settings.overrides[n] = id; else delete settings.overrides[n];
      save();
      if (root.SV && root.SV.render) root.SV.render();
    },
    /** Written (staff) pitch -> sounding pitch for a part as currently engraved. */
    writtenToSounding: (part, p) => p - (part.transpose || 0),
    soundingToWritten: (part, p) => p + (part.transpose || 0),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const SV = root.SV;
  if (!SV) return;
  SV.instruments = api;
  SV.hooks.transformScore.push(score => transform(score));
  if (typeof document === 'undefined' || !SV.addToolbar) return;

  // ------------------------------------------------------------------ UI

  SV.addStyle(`
    .svi-pop { position: fixed; z-index: 40; background: var(--bar, #232323); color: var(--text, #ddd); border: 1px solid var(--line, #3a3a3a);
               border-radius: 6px; box-shadow: 0 6px 20px #000a; padding: 8px; width: 250px; max-height: 70vh; display: flex; flex-direction: column; font-size: 12px; }
    .svi-pop h4 { margin: 0 0 6px; font-size: 12px; color: #fff; font-weight: 600; }
    .svi-pop input[type=text] { background: var(--bar2, #2d2d2d); color: inherit; border: 1px solid var(--line, #3a3a3a); border-radius: 4px; padding: 3px 6px; margin-bottom: 6px; font: inherit; }
    .svi-list { overflow: auto; flex: 1; }
    .svi-list .fam { color: var(--dim, #888); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; margin: 6px 0 2px; }
    .svi-list a { display: block; padding: 2px 6px; border-radius: 3px; cursor: pointer; }
    .svi-list a:hover, .svi-list a.on { background: var(--accent, #ff7a1a); color: #111; }
    .svi-swap { display: block; margin-top: 6px; padding: 4px 6px 0; border-top: 1px solid var(--line, #3a3a3a); color: var(--accent, #ff7a1a); cursor: pointer; }
    .svi-row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 4px; cursor: pointer; border-radius: 3px; }
    .svi-row:hover { background: var(--bar2, #2d2d2d); }
    .svi-row .inst { color: var(--accent, #ff7a1a); }
    .svi-row .inst.auto { color: var(--dim, #888); }
    #paper g.label, #paper g.labelAbbr { cursor: pointer; }
    #paper g.label:hover text, #paper g.labelAbbr:hover text { fill: var(--accent, #ff7a1a); }
  `);

  const bar = SV.addToolbar(
    '<button class="btn" id="svInstrBtn" title="Instrument for each shown track">Instruments ▾</button>' +
    '<label title="Label staves with instrument names instead of Bitwig track names"><input type="checkbox" id="sviNames"> Instrument names</label>' +
    '<label title="Show transposing instruments at written pitch (off = concert pitch)"><input type="checkbox" id="sviTransposed"> Transposed score</label>' +
    '<label title="Red: outside the instrument\'s range. Orange: outside the comfortable range"><input type="checkbox" id="sviRanges"> Ranges</label>', { cluster: 'score', order: 10 });
  const q = id => bar.querySelector('#' + id);
  [['sviNames', 'names'], ['sviTransposed', 'transposed'], ['sviRanges', 'ranges']].forEach(([id, k]) => {
    const cb = q(id);
    cb.checked = settings[k];
    cb.addEventListener('change', () => { settings[k] = cb.checked; save(); SV.render(); });
  });

  let pop = null;
  const closePop = () => { if (pop) { pop.remove(); pop = null; } };
  document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && e.target.id !== 'svInstrBtn') closePop(); });
  document.addEventListener('keydown', e => { if (pop && e.key === 'Escape') closePop(); }, true);
  const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function placePop(x, y) {
    const r = pop.getBoundingClientRect();
    pop.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + 'px';
    pop.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }

  const FAMILY_NAMES = { [WW]: 'Woodwinds', [BR]: 'Brass', [PC]: 'Percussion', [KB]: 'Keyboards & plucked', [VO]: 'Voices', [ST]: 'Strings', [OT]: 'Other' };

  /** Opens the instrument picker for one track at screen position (x, y). */
  function openPicker(partName, x, y) {
    closePop();
    const part = (SV.state.render && SV.state.render.score.parts.find(p => p.name === partName)) || { name: partName, notes: [] };
    const info = forPart(part);
    const autoInst = BY_ID.get(info.auto);
    pop = document.createElement('div');
    pop.className = 'svi-pop';
    pop.innerHTML = `<h4>${escapeHtml(cleanName(partName))}</h4><input type="text" placeholder="Filter instruments…"><div class="svi-list"></div>` +
      (SV.wizard ? '<a class="svi-swap" title="Load another instrument plug-in on this Bitwig track">Swap library…</a>' : '');
    document.body.appendChild(pop);
    const swap = pop.querySelector('.svi-swap');
    if (swap) swap.addEventListener('click', () => {
      const r = pop.getBoundingClientRect();
      closePop();
      SV.wizard.openSwap(partName, r.left, r.top);
    });
    const list = pop.querySelector('.svi-list'), input = pop.querySelector('input');
    const draw = () => {
      const f = input.value.trim().toLowerCase();
      let html = `<a data-id="" class="${info.override ? '' : 'on'}">Automatic (${escapeHtml(autoInst.name)})</a>`;
      let fam = null;
      DB.forEach(inst => {
        if (f && !(inst.name + ' ' + inst.aliases.join(' ')).toLowerCase().includes(f)) return;
        if (inst.family !== fam) { fam = inst.family; html += `<div class="fam">${FAMILY_NAMES[fam]}</div>`; }
        html += `<a data-id="${inst.id}" class="${info.override === inst.id ? 'on' : ''}">${escapeHtml(inst.name)}</a>`;
      });
      list.innerHTML = html;
    };
    draw();
    input.addEventListener('input', draw);
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { const a = list.querySelector('a[data-id]:not([data-id=""])'); if (a) a.click(); }
    });
    list.addEventListener('click', e => {
      const a = e.target.closest('a[data-id]');
      if (!a) return;
      closePop();
      api.setOverride(partName, a.dataset.id || null);
    });
    placePop(x, y);
    input.focus();
  }

  // Toolbar panel: every shown track with its instrument.
  q('svInstrBtn').addEventListener('click', e => {
    if (pop) { closePop(); return; }
    const r = SV.state.render;
    const parts = r ? r.score.parts : [];
    pop = document.createElement('div');
    pop.className = 'svi-pop';
    pop.innerHTML = '<h4>Instruments of shown tracks</h4><div class="svi-list">' + (parts.length ? parts.map(p => {
      const info = forPart(p);
      return `<div class="svi-row" data-part="${escapeHtml(p.name)}"><span>${escapeHtml(cleanName(p.name))}</span>` +
        `<span class="inst ${info.override ? '' : 'auto'}">${escapeHtml(info.inst.name)}</span></div>`;
    }).join('') : '<div class="fam">No tracks shown</div>') +
      '</div><div class="fam" style="margin-top:6px">Click a track (or a staff name in the score) to choose its instrument.</div>';
    document.body.appendChild(pop);
    const br = e.target.getBoundingClientRect();
    placePop(br.left, br.bottom + 4);
    pop.addEventListener('click', ev => {
      const row = ev.target.closest('.svi-row');
      if (!row) return;
      const rr = row.getBoundingClientRect();
      openPicker(row.dataset.part, rr.right + 4, rr.top);
    });
  });

  // Staff labels in the engraved SVG open the picker for their part (nearest staff in the same system).
  function partForLabel(labelEl, render) {
    const sys = labelEl.closest('g.system');
    if (!sys) return null;
    const ly = labelEl.getBoundingClientRect();
    const cy = ly.top + ly.height / 2;
    const m = sys.querySelector('g.measure');
    if (!m) return null;
    let best = null, bd = Infinity;
    m.querySelectorAll('g.staff').forEach(st => {
      const mm = /^m\d+s(\d+)$/.exec(st.id || '');
      if (!mm) return;
      const b = st.getBoundingClientRect();
      const d = Math.abs(b.top + b.height / 2 - cy);
      if (d < bd) { bd = d; best = +mm[1]; }
    });
    const staff = best && render.staves.find(s => s.n === best);
    return staff ? staff.part : null;
  }

  SV.hooks.afterRender.push(render => {
    document.querySelectorAll('#paper g.label, #paper g.labelAbbr').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const name = partForLabel(el, render);
        if (name) openPicker(name, e.clientX + 6, e.clientY + 6);
      });
      el.addEventListener('mousedown', e => e.stopPropagation());
    });
  });
  SV.addHelp('Click a staff name to choose its instrument (clef, range, transposition).');
})(typeof window !== 'undefined' ? window : this);
