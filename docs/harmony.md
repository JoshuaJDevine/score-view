# Harmony — Functional Color Theory in the score

`web/features/harmony.js` makes the user's **Functional Color Theory** (FCT, see
[functional-color-theory.md](functional-color-theory.md)) live in Score View. It analyses whatever is
being rendered (all visible parts), colours it by psychological function and marks expectation and
subversion. It is meant as a composition aid: edit a note in Bitwig and the colours update with the score.

## Using it

| | |
|---|---|
| **H** | harmony colours on/off |
| **Shift+H** | cycle the view: *Noteheads* → *Bands* → *Noteheads + bands* |
| **Ctrl+Shift+↑ / ↓** | move the selected live notes to the next chord tone up/down ("aim assist") |
| **Colors ▾** (toolbar) | the same switches, plus *Roman numerals above the score*, *Expectation marks*, *Snap to harmony*, *Swap cyan / magenta* and the **Legend** |

* **Noteheads** — every note takes the colour of its chord's function. Non-chord tones are neutral grey;
  borrowed (chromatic) chord tones are bright cyan/magenta. A colour another module already set on a note
  (e.g. an out-of-range warning) is never overwritten.
* **Bands** — a translucent band behind each harmonic region, spanning the whole system, with a stronger
  stripe where the harmony changes. Band length = harmonic rhythm.
* **Ribbon** — the Roman numeral of each region above the system's top staff, in its function colour. A key
  label (`c♯:`, `G:`) starts the piece and every modulation. Labels in parentheses are *implied* harmony
  (only one or two pitch classes sounding, e.g. a single melodic line).
* **Marks** — arcs from a dominant to its resolution (red arc = arrival home, grey = applied chord resolving);
  **deceptive** resolutions get a dashed orange outline round the deceptive chord and the tag
  *"deceptive — longing"*; a **?** after an unresolved dominant; the final chord gets *eternal question*
  (Blue), *eternal journey* (Yellow) or *we're home* (Red); modulations get a dotted line and
  *→ G major* / *home: C major*.
* **Legend** — colours with the user's teaching language ("We're home", "We're going somewhere",
  "We can't stay here", ...).

## Colour mapping

| Function | FCT colour | Chords (major / minor) |
|---|---|---|
| tonic (Rest) | Red | I, i, the tonic of any local key (temporary tonic) |
| subdominant (Motion) | Yellow | IV, iv; ♯vi° in minor (part of a Dorian IV⁷) |
| dominant (Tension) | Blue | V, v, V⁷, vii°, viiø⁷, vii°⁷; ♭II⁷ tritone substitute; VII in minor (subtonic); cadential I⁶₄ |
| supertonic (Motion+Tension) | Green | ii, ii⁷, ii°, iiø⁷ |
| mediant (Rest+Tension) | Purple | iii, iii⁷, ♭III, III |
| submediant (Rest+Motion) | Orange | vi, ♭VI, VI |
| borrowed, sharp side | **Cyan** | secondary dominants and leading-tone chords (V/V, V⁷/vi, vii°/V…), It/Fr/Ger+6, any chord on ♯4 |
| borrowed, flat side | **Magenta** | modal-interchange chords with no FCT slot: Neapolitan / ♭II, ♭VII in major |
| non-chord tones | grey | passing, neighbour, suspension, anticipation, appoggiatura, escape |

Individual **chord tones** that are chromatic in the local key are coloured by side, whatever the chord's
colour: raised degrees (♯4, ♯1, ♯5, raised 3 of a Picardy third…) cyan, lowered degrees (♭3, ♭6, ♭7, ♭2)
magenta. So `iv` in major is a Yellow chord with a magenta ♭6, and `♭VI` an Orange chord with magenta ♭6
and ♭3. In minor the raised 6th and 7th (melodic/harmonic minor) count as diatonic.

### Interpretations of FCT (please correct!)

The FCT document fixes the core colours; these are the places where the implementation had to choose:

1. **Cyan vs Magenta.** FCT says "bright Cyan/Magenta" for borrowed tones without assigning sides. Here
   **cyan = sharp side** (secondary dominants, augmented sixths, ♯4 — the "smoking gun") and
   **magenta = flat side** (modal interchange). *Colors ▾ → Swap cyan / magenta* reverses this.
2. **Modal-interchange chords keep their function colour when FCT names them** — iv Yellow, ♭III Purple,
   ♭VI Orange (all listed in FCT) — and show the borrowing on their chromatic noteheads (magenta).
   Chromatic chords **without** an FCT slot take the borrowed colour for the whole chord: ♭VII in major and
   the Neapolitan ♭II/N⁶ are magenta, secondary dominants/leading-tone chords and augmented sixths cyan.
3. **Secondary dominants are cyan as whole chords** (FCT lists them under borrowed), even V⁷/IV whose
   only chromatic tone is ♭7 (that note itself is magenta).
4. **Temporary tonic.** A chord is Red when it is the tonic of the *local* key. Local keys come from a
   windowed key finder (about ±5 bars), so a short tonicisation (V/V→V) stays an applied chord (cyan → Blue),
   while a passage that settles in a new key (a modulation) makes its tonic Red.
5. **VII in minor** (the subtonic, e.g. B major in C♯ minor) is **Blue**: in VI–VII–i it is the chord that
   "needs to go home". ♭VII in a major key is magenta (borrowed).
6. **Cadential I⁶₄** (tonic in second inversion over the dominant bass, followed by V) is **Blue** — it is the
   dominant's embellishment.
7. **♯vi° in minor** (raised-6 diminished chord, usually part of a Dorian IV⁷) is Yellow.
8. **Chromatic non-chord tones** are grey like other non-chord tones unless they have "harmonic weight"
   (≥ one beat, or accented and ≥ half a beat); then they are cyan/magenta by the direction they move
   (rising = sharp side, falling = flat side).
9. **Endings**: Red ending = *we're home*, Blue = *eternal question*, Yellow = *eternal journey*, anything
   else *open ending*. The mark goes on the last chord of the rendered range (in *Clip bars* view that is the end of the clip's bars, not necessarily the piece).
10. **Deceptive** = primary V (or vii°, ♭II⁷) going to vi in major / VI in minor. Other dominants that do not
    go to their target get a **?** ("unresolved"). Applied chords resolving to their target get a grey arc.

## Analysis method

All visible parts are analysed together (percussion tracks — names matching *percussion, drum, kit, snare,
cymbal…* — and keyswitch notes below C1 are ignored).

1. **Pitch-class weights per beat** (dotted quarter in compound metres, eighth in x/8): each note adds its
   overlap with the beat, ×1.3 on the downbeat / ×1.15 on the half bar / ×0.8 off the beat for the attack,
   ×0.6 for sustained continuation. The lowest sounding note of each beat (the bass) gets extra weight.
2. **Home key**: the rendered key signature (`keyFifths`, or the same auto-detection score.js uses) chooses
   between the major key and its relative minor by profile fit and the final bass note.
3. **Local keys** (modulation / temporary tonic): per bar, a ±5-bar triangular window is scored for every
   major/minor key by (a) how well the window's *pitch collection* fits the key signature — a key also
   explains its modal neighbours (Dorian/Phrygian, Lydian/Mixolydian) at a small cost, (b) a Temperley-style
   profile correlation, (c) **tonic evidence**: how often the bass on strong beats is that tonic, (d)
   **mode evidence**: whether the chord over that tonic bass has a major or minor third, and (e) a small home
   bonus. A Viterbi pass picks the key path; changing key costs more for relative and parallel keys (modal
   mixture should stay in the home key).
4. **Harmonic rhythm**: dynamic programming over the beats finds the best segmentation into chords.
   Segments may start on any beat (small penalty off the half-bar), may span whole bars when they start on a
   barline, and each segment costs a fixed penalty so a chord only changes when the evidence pays for it.
   Arpeggios and passing tones therefore merge into one chord. Identical neighbours (and V–V⁷, Vsus4–V,
   power chord + triad on the same root) are merged afterwards.
5. **Chord recognition** (per segment): every root × template — major, minor, diminished, augmented,
   power, sus2, sus4, dominant 7th, major 7th, minor 7th, half- and fully-diminished 7th, minor-major 7th,
   7sus4, add6, add9, 7♭5 — is scored by (chord-tone weight − non-chord weight) / total, minus penalties for
   missing root/third/seventh, plus a bass bonus for the root, plus a small bonus for chords diatonic to the
   local key. Context then decides symmetric chords (fully diminished 7ths take the root that leads by step
   to the next chord; augmented triads prefer I/V/III) and the special chords: **augmented sixths** (a
   dominant-7th / 7♭5 sonority on ♭6 that goes to V or a cadential 6/4: Ger+6, It+6 without fifth, Fr+6),
   **Neapolitan** (major triad on ♭2; N⁶ when the third is in the bass), **tritone substitution** (dominant
   7th on ♭2), **secondary dominants / leading-tone chords** (a chromatic major/dom7 or diminished chord whose
   target a fifth below / a step above is a consonant diatonic chord other than I) and the **cadential 6/4**.
6. **Spelling**: the chord root is spelled as a scale degree of the local key (♭VI, ♯iv°…) and each chord
   tone gets its degree and alteration, which gives the Roman numeral (case = third, °, ø, +, figured-bass
   inversions ⁶, ⁶₄, ⁶₅, ⁴₃, ⁴₂) and the sharp/flat side of every chromatic tone.
7. **Notes**: each note belongs to the region where it starts. Chord tones take the region's colour (or
   cyan/magenta if chromatic); other notes are classified from their melodic neighbours in the same part as
   passing, neighbour, suspension, anticipation, appoggiatura or escape tones.
8. **Events**: resolutions, deceptive resolutions, unresolved dominants, ii–V–I, modulations and the ending.

Analysis is cached by score identity and by a content hash (notes, key, metre, range), so re-renders that
don't change the music cost nothing.

## API for other modules — `window.SV.harmony`

Beats are **absolute** (measure offset applied), the same scale as `SV.hitTest(e).beat` and
`SV.state.render.timeline[].start`.

```js
SV.harmony.analyze(score)          // -> [{ start, end, root, rootName, quality, roman, func, color, keyFifths, key,
                                   //       chordPcs, borrowed: 'sharp'|'flat'|null, applied, bass, inversion,
                                   //       sharp4, implied }]   (score = a transformScore-style score object)
SV.harmony.regions()               // the same for the score currently rendered
SV.harmony.chordAt(beat)           // region at a beat, or null
SV.harmony.snap(pitch, beat, mode) // nearest chord tone (mode 'chord', default) or scale/chord tone ('scale');
                                   // equidistant -> the upper one
SV.harmony.nextChordTone(pitch, beat, dir)   // next chord tone strictly above (dir 1) / below (-1)
SV.harmony.enabled()               // colours on?
SV.harmony.snapEnabled()           // "Snap to harmony" ticked — note entry should call snap() when true
SV.harmony.events()                // [{type:'resolve'|'deceptive'|'unresolved'|'ii-V-I'|'modulation'|'ending', beat, text, ...}]
SV.harmony.settings() / set(patch) // { enabled, mode:'notes'|'bands'|'both', ribbon, marks, snap, sharpColour, flatColour }
SV.harmony.colourOf(func)          // hex colour of a function ('tonic', 'dominant', ..., 'sharp', 'flat')
SV.harmony.stats()                 // { analysisMs, overlayMs }
```

`func` is one of `tonic`, `subdominant`, `dominant`, `supertonic`, `mediant`, `submediant`, `sharp`
(borrowed, cyan by default), `flat` (borrowed, magenta by default).

The pure engine also loads in Node: `require('web/features/harmony.js')` →
`{ analyzeFull, decorate, snapIn, stepChordTone, regionAt, PALETTE, FUNCS, funcColour, ... }`.

## Tests

* `node test/harmony-test.mjs` — synthetic progressions (I–IV–V–I in C and E♭, ii⁷–V⁷–I, deceptive V⁷–vi,
  V⁷/V with ♯4, ♭VI, Neapolitan, German sixth + cadential 6/4, modulation to the dominant, passing and
  neighbour tones, tritone substitution, endings, snap) asserting Roman numeral, function and colour; plus
  the Mega Man 2 fixture timing.
* `PORT=8852 node test/harmony-e2e.mjs` — the page against the mock server: H / Shift+H, aim assist sends
  the right `move`, Mega Man 2 export in score mode (all tracks and a strings subset) with screenshots
  `test/out-harmony-*.png`.

Performance (Mega Man 2, 23 parts, 128 bars): analysis ≈ 20–35 ms, overlay ≈ 40 ms; Verovio's own engraving
of that score takes several seconds.

## Known limitations

* Key changes are detected at bar granularity and need a few bars of evidence; a one-bar tonicisation is
  shown as an applied chord instead.
* Harmonic rhythm is found at beat resolution; chords changing on off-beats are absorbed into a neighbour.
* Melody-only material (one line) gives *implied* harmony, shown in parentheses and lighter bands.
* Modal music is read against major/minor: Dorian/Phrygian/Mixolydian colour shows up as borrowed tones
  (e.g. Phrygian ♭II in magenta), which is the FCT reading but may be more colour than a modal composer wants.
* The ribbon uses Verovio `<dir>` text (so it gets engraving space) and is lifted to the top of the system
  afterwards; a very high top-staff note can push the ribbon line above the band.
* Selection (`.sel`) and playhead (`.play`) highlights are restyled while colours are on (dark notehead with
  an orange/blue glow) so they don't read as Orange/Blue functions.
* Aim assist updates `SV.state.selection` itself; the page core keeps its pending-move bookkeeping private, so if a
  Bitwig update arrives between the move and its echo the moved notes can drop out of the selection. A small
  hook (`SV.moveSelection(dx, dyFn)` exported from core/api.js) would let aim assist reuse the built-in path.
