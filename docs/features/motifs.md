# motifs — motif development
`web/features/motifs.js` · loads 6th

## Purpose
Treats the selected live notes as a figure and develops it: sequence, inversion, retrograde, augmentation /
diminution, octave doubling, and any diatonic interval added above or below (Alt+2…9 above, Alt+Shift+2…9 below, as in
Sibelius / Dorico; the menu lists the third and sixth); saves motifs to a library and inserts them.

Keys: Alt+S / Shift+S sequence, Alt+I (+Shift) invert, Alt+R retrograde, Alt+A / D augment / diminish, Alt+O (+Shift)
octave, Alt+M save. Alt+digits are registered for the `normal` context: in note entry `features/entry.js` takes them for
the note just entered (the motifs hook yields). **Changed in Wave 2:** Alt+3 / Alt+6 used to add a third / sixth
*below*; they now add above, and below is Alt+Shift+3 / Alt+Shift+6.

## Owns
- Toolbar: **Motif ▾** `#mtfBtn`, panel `#mtfPanel` (`#mtfSave`, `#mtfName`, `#mtfOk`, `#mtfHarm`).
- `SV.motifs` (pure `Core` plus `run`, `addInterval(n, dir)`, `saveMotif`, `insertMotif`, `deleteMotif`, `library`, `actions`). Node:
  `require('web/features/motifs.js')`.
- localStorage `scoreview.motifs.library`, `scoreview.motifs.prefs`.

## Hooks
`keydown`, `liveData`. Reads `SV.harmony`, `SV.entry`.

## Tests
`test/motifs-test.mjs` (pure core), `test/motifs-e2e.mjs` (page; edits land in the mock clip).
