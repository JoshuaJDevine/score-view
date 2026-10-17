# instruments — instrument database and per-part setup
`web/features/instruments.js` · loads 1st

## Purpose
Instrument database with a fuzzy track-name lookup. Before engraving it sets each part's clef (and the clefs it may
change to), label, grand staff, transposition and range colours. Clicking a staff name opens an instrument picker; the
choice is remembered per track.

## Owns
- Toolbar: **Instruments ▾** `#svInstrBtn` (panel `.svi-pop`, rows `.svi-row`); toggles `#sviNames` (instrument
  names), `#sviTransposed` (transposed score), `#sviRanges` (range colours).
- `SV.instruments` (`lookup(name, group)`, `setOverride(track, id|null)`, …), used by most other modules.
- localStorage `scoreview.instruments.*` (`overrides`, `ranges`, …).

## Hooks
`transformScore`, `afterRender`. Reads `SV.wizard` when present.

## Tests
`test/instruments-test.mjs` (lookup, clefs), `test/instruments-e2e.mjs` (label, picker, override, toggles; uses
`test/selectors.mjs`), `test/instruments-visual.mjs` (screenshots, not in run-all). Also exercised by the notation,
sections, orchestrate, musicxml and wizard tests.
