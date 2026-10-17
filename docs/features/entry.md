# entry — note entry mode
`web/features/entry.js` · loads 10th

## Purpose
"Play, then sculpt": N toggles Entry mode; a caret on the live clip's staff takes input and advances. Letters A–G,
MIDI keys and chords (Web MIDI or the Bitwig MIDI bridge), R (repeat), mouse clicks with a ghost-note preview, and
rhythm-first slots (digits, F1–F8 cells, a tapped rhythm) that pitches then fill. Entering overwrites notes that start
in the entered span.

## Keys
The duration keys follow the **keypad layout** preference (⚙ next to Entry). Sibelius is the default.

| Key | Sibelius (default) | Dorico | MuseScore |
|---|---|---|---|
| 1 | 32nd | 128th (refused) | 64th (refused) |
| 2 | 16th | 64th (refused) | 32nd |
| 3 | 8th | 32nd | 16th |
| 4 | quarter | 16th | 8th |
| 5 | half | 8th | quarter |
| 6 | whole | quarter | half |
| 7 | ♮ natural | half | whole |
| 8 | ♯ sharp | whole | double whole (refused) |
| 9 | ♭ flat | double whole (refused) | longa (refused) |
| 0 | rest | ♮ natural | rest |
| `+` `-` `=` | ♯ ♭ ♮ | `=` ♯, `+` ♯, `-` ♭ | ♯ ♭ ♮ |
| `,` | — | rest | — |
| numpad Enter | tie | — | — |

Sources: Sibelius keypad, first layout (1 = 32nd … 6 = whole, 7/8/9 = ♮/♯/♭, 0 = rest, Enter = tie; 64ths and the
double whole are on its second layout); Dorico (6 = quarter, 5 = 8th, 7 = half …; 0/−/= = ♮/♭/♯; comma = rests);
MuseScore (5 = quarter; Score View's behaviour before Wave 2). The numpad gives the same as the number row. "Refused"
values flash a message: Score View writes 32nd … whole only (the 24-step-per-beat grid).

Same in every layout: `.` dot, Ctrl+3 triplets, T tie, R repeat, A–G note, Shift+A–G add to the chord, F1–F8 rhythm
cells, ←/→ caret (moves selected notes instead), Backspace take back, Esc leave (or close the ⚙ panel), and:

- **Ctrl+↑/↓** octave on the last entered note(s) (Sibelius). Outside entry, or on a selection that isn't the last
  entry, it moves the selected notes an octave.
- **Alt+2…9** adds a diatonic interval above the top note of the last entry (Alt+3 = third, Alt+8 = octave);
  **Alt+Shift+digit** below the bottom note. The new note takes the key signature (Sibelius and Dorico both use
  Alt+digit). Outside entry Alt+digit does the same to every selected note through `features/motifs.js` (with its
  "Fit to harmony" setting).
- **Ctrl+←/→** moves the caret to the previous / next bar line.
- Preference **Number row adds intervals (Sibelius)**, off by default: as in Sibelius, 1–9 on the number row add
  intervals (Shift: below) and only the numpad sets durations. Off suits a laptop without a numpad.

Every entry key is registered with `SV.shortcuts` (context `entry`; N and Ctrl+↑/↓ `always`). The layout keys are
re-registered when the layout changes (`SV.shortcuts.remove`), so the "All keyboard shortcuts" table, the footer help
line `#sve-help` and the "Keys in note entry" list in the ⚙ panel always show the current layout.

## Lengths written to Bitwig (articulation-aware)
The articulation at the caret is the keyswitch latched there (`SV.articulations.mapFor` + `resolve`, BBC SO maps), else
the track name ("Violins Legato", "Vc Spiccato"):
- **Legato** (preference *Legato overlap*: off / small = a 64th, default / medium = a 32nd / large = a 16th): when a note
  is entered right after a legato note, that note is lengthened to run into the new one by the overlap, so the library
  plays its legato transition. Both notes must be legato. Backspace takes the overlap back too. The engraving trims
  small overlaps, so the score does not change.
- **Short** (staccato, spiccato, pizz., marcato, hits; preference *Short notes*: as written / small gap, default / half
  length): small gap plays the note a 64th short (at most a quarter of it), which the engraving rounds back to the
  written value; half length plays half (a long note may then show shorter).
- The caret, ←/→ selection and repeat use the **written** length (remembered per note in `E.notated` as
  `{ steps, d }`; a record only counts while the note still plays length `d`, so a note resized in Bitwig or another
  clip's note at the same id falls back). For a note with no record (after a reload) the written length is worked back
  from the played one: `writtenBeats` undoes the short-note setting (with *small gap*, only for a length off the step
  grid: a note on the grid was written at full length, e.g. in Bitwig), and a legato note whose end lies the overlap
  past the next onset loses the overlap. "Non legato" / "non-legato" names are not legato.

## Range warning
Preference *Range warning*: off / outside the range (default) / also outside the comfortable range. After each entry
(letters, MIDI, mouse, Shift+letter, Alt+digit, octave), a pitch outside the instrument's range (from
`SV.instruments.forPart`, the same ranges as the Ranges colours) flashes e.g. "⚠ D3 is below the violin's range
(G3–E7)". The note is still written.

## Owns
- Toolbar: `#sve-toggle`, `#sve-prefs-btn` (⚙) with panel `#sve-prefs` (`#sve-layout`, `#sve-laytable`, `#sve-rowint`,
  `#sve-legato`, `#sve-short`, `#sve-range`, `#sve-keys`), pill `#sve-pill`, panel `#sve-panel` (`#sve-keypad`, `#sve-rf`,
  `#sve-tap`, `#sve-midi`, `#sve-midisrc`, `#sve-recplay`, `#sve-cells`); paper layer `#sve-layer`; footer help `#sve-help`.
- `SV.entry` (`rawHooks`, `actions.{dur, rest, undo, caret, bar, octave, interval, …}`, `prefs`, `setPref(k, v)`,
  `articAt(step)`, `addInterval(n, dir)`), used by controller, mouse, articulations, import, motifs. Node:
  `require('web/features/entry.js')` gives the pure core (`LAYOUTS`, `keyAction`, `keyFor`, `intervalPitch`,
  `articKind`, `playedBeats`, `writtenBeats`, `rangeIssue`).
- localStorage `scoreview.entry.*`: `layout` (`sibelius`|`dorico`|`musescore`), `rowIntervals`, `legatoOverlap`
  (`off`|`small`|`medium`|`large`), `shortLen` (`off`|`gap`|`half`), `rangeWarn` (`off`|`range`|`comfort`), plus
  `rhythmFirst`, `midiSource`, `recPlaying`, `tapKey`. Reads `GET /api/midi` (the MIDI bridge).
- `E.digit` stays the internal duration index (2 = 32nd … 7 = whole, MuseScore's numbers) whatever the layout.

## Hooks
`keydown`, `paperClick`, `noteClick`, `transformScore`, `afterRender`, `liveData`, `play`. Reads `SV.harmony`,
`SV.instruments`, `SV.articulations`, `SV.motifs`.

## Tests
`test/entry-test.mjs` (pure: the three layouts, intervals, articulation kinds, lengths, range),
`test/entry-keys-e2e.mjs` (layouts through ⚙, Alt+digit in and out of entry, Ctrl+arrows, legato / short lengths by
track name and keyswitch, range warning, registry + help), `test/e2e-entry.mjs` (sets the MuseScore layout),
`test/midi-bridge-e2e.mjs` (Web MIDI stubbed), `test/clip-offset-e2e.mjs`; also controller-e2e and mouse-e2e.

## Docs
docs/midi-bridge.md.
