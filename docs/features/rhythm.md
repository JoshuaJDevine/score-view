# rhythm — rhythm readings (aim assist)
`web/features/rhythm.js` · loads 4th

## Purpose
Play freely, then cycle interpretations of a bar instead of re-entering it: Q / Shift+Q on the selected note's bar (or
the last clicked bar) steps through readings (grid, tuplets, voices, simplify).

## Owns
- `SV.rhythm` (`READINGS`, `overridesFor(track)`, `cycle`).
- localStorage `scoreview.rhythm.<track>`, passed to `buildMEI` as `part.measureOverrides`.

## Hooks
`transformScore`, `paperClick`, `noteClick`, `keydown`, `afterRender`.

## Tests
`test/rhythm-test.mjs` (tuplet / voice / pickup engraving cases), `test/rhythm-e2e.mjs` (Q readings in the page),
`test/rhythm-perf.mjs` (buildMEI timing, not in run-all).
