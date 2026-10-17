// Mood library for Inspire (web/features/inspire.js). Pure data; loads in Node: require('web/features/inspire-library.js').
//
// A mood is a small, researched recipe for an underscore pad:
//   mode         'major' | 'minor' — scale the roman numerals are read in (minor = natural minor)
//   progressions roman numerals, read in the mood's mode. Case gives the triad (I major, i minor, i° / vii° diminished);
//                a ♭ or # prefix shifts the root a semitone (♭II in minor = Neapolitan); suffixes add colour:
//                7 (minor 7th), maj7, 6, add9, sus2, sus4. Each chord lasts `barsPerChord` bars.
//   barsPerChord harmonic rhythm
//   register     'low' | 'mid' | 'high' — where in the instrument's comfortable range the voicing sits
//   voices       number of sustained upper voices (divisi on one staff), plus the pedal if any
//   pedal        true: the lowest voice holds the tonic under the whole passage
//   velocity     0–127
//   answers      cadential tails for "Continue the phrase" (the answer ends with one; Again picks the next)
//   melody       how "Melody over the chords" writes in this mood:
//                  cells     one-bar rhythms in beats (negative = rest), scaled to the bar; a phrase is A A' B cadence
//                  cadences  rhythms for the phrase's last bar
//                  register  'low' | 'mid' | 'high' part of the instrument's comfortable range
//                  contour   'arch' (rise to ~60% of the phrase, fall) | 'fall' | 'flat'
//                  sigh      chance that a long strong-beat note leans in from the step above (appoggiatura)
//                  chromatic weak beats may use semitone neighbours outside the scale
//   sources      where the recipe comes from (so the library can be checked and extended)
//
// To add a mood: append an entry; the dialog picks it up. Library-specific variants (BBC SO, Spitfire, Crow Hill …)
// will hang off the same entries later, see docs/library-profiles.md.
(function (root) {
  'use strict';
  const MOODS = [
    {
      id: 'hopeful', name: 'Hopeful', blurb: 'Warm major pad, one chord a bar, added-9th colour. Rising, open, a little bittersweet on vi.',
      mode: 'major', barsPerChord: 1, register: 'mid', voices: 4, pedal: false, velocity: 72,
      progressions: [
        ['Iadd9', 'V', 'vi', 'IVadd9'],
        ['IVadd9', 'Iadd9', 'V', 'vi'],
        ['Iadd9', 'vi', 'IVadd9', 'Vsus4'],
        ['Iadd9', 'iii', 'IVadd9', 'IVadd9'],
      ],
      answers: [['IV', 'V', 'Iadd9', 'Iadd9'], ['ii', 'V', 'Iadd9', 'Iadd9'], ['vi', 'IVadd9', 'V', 'Iadd9'], ['IVadd9', 'Iadd9', 'V', 'Iadd9']],
      melody: { cells: [[1.5, 0.5, 2], [1, 1, 2], [2, 1, 1], [0.5, 0.5, 1, 2], [1, 0.5, 0.5, 2]], cadences: [[4], [3, 1]],
        register: 'high', contour: 'arch', velocity: 82, sigh: 0, chromatic: false },
      sources: 'I–V–vi–IV and its rotations are the common pop/film "uplift" loop; add9 on I and IV and a Vsus4 that '
        + 'does not resolve keep it open (Newman, Desplat-style warm underscore).',
    },
    {
      id: 'melancholy', name: 'Melancholy', blurb: 'Aeolian minor, two bars a chord: reflective, unresolved, no leading tone.',
      mode: 'minor', barsPerChord: 2, register: 'mid', voices: 4, pedal: false, velocity: 60,
      progressions: [
        ['i', 'VI', 'III', 'VII'],
        ['i', 'iv', 'VI', 'V'],
        ['VImaj7', 'VII', 'i', 'i'],
        ['i', 'VI', 'iv', 'iv'],
      ],
      answers: [['iv', 'V', 'i'], ['VI', 'iv', 'V', 'i'], ['iv', 'i'], ['VI', 'VII', 'i']],
      melody: { cells: [[3, 1], [2, 1, 1], [1.5, 0.5, 2], [2, 2]], cadences: [[4], [2, 2]],
        register: 'mid', contour: 'fall', velocity: 66, sigh: 0.6, chromatic: false },
      sources: 'Natural-minor (Aeolian) loops i–VI–III–VII and i–VI–iv avoid the leading tone, the standard sound of '
        + 'reflective/sad underscore; i–iv–VI–V adds one dominant for a sigh at the turn.',
    },
    {
      id: 'suspense', name: 'Suspense', blurb: 'Low minor pad over a tonic pedal, slow: Phrygian ♭II neighbour and a minor line cliché.',
      mode: 'minor', barsPerChord: 2, register: 'low', voices: 3, pedal: true, velocity: 50,
      progressions: [
        ['i', '♭II', 'i', '♭II'],
        ['i', 'imaj7', 'i7', 'i6'],
        ['i', 'VI', '♭II', 'V'],
        ['i', 'iv', 'i', '♭II'],
      ],
      answers: [['iv', '♭II', 'i'], ['VI', '♭II', 'V'], ['♭II', 'i'], ['iv', 'V', 'i']],
      melody: { cells: [[-2, 1, 1], [-1, 1, -2], [2, -2], [-3, 1], [1, 1, -2]], cadences: [[4], [-2, 2]],
        register: 'low', contour: 'flat', velocity: 54, sigh: 0, chromatic: true },
      sources: 'Tonic pedal with a semitone ♭II neighbour (Phrygian) is the classic thriller tension device; the minor '
        + 'line cliché i–i(maj7)–i7–i6 creeps chromatically; ♭II–V is the Neapolitan approach.',
    },
  ];
  const api = { MOODS, byId: id => MOODS.find(m => m.id === id) || null };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SVInspireLibrary = api;
})(typeof window !== 'undefined' ? window : globalThis);
