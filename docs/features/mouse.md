# mouse — mouse editing and clipboard
`web/features/mouse.js` · loads 12th

## Purpose
Sibelius/Dorico-style mouse editing of live notes: drag for pitch (scale steps; Alt chromatic), Shift+drag for time,
the end handle for length, a marquee on empty paper, Ctrl+C / X / V.

## Owns
- Paper layer `#svm-layer`.
- `SV.mouse` (`copy`, `paste`, `clipboard`, `beatAt`, `beatPos`).
- localStorage `scoreview.mouse.clipboard`.

## Hooks
`paperMouseDown` (then `SV.clickPaper(e)` for the built-in click), `keydown`, `afterRender`. Uses `SV.moveSelection`,
`SV.expectIds`, `SV.gridBeats`, `SV.entry`.
Coexists with features/passage.js: Ctrl+C / V go to the passage when `SV.passage.takesKey(k)` says so (a passage is
selected; for V, a passage was copied last), `copy()` calls `SV.passage.notesCopied()`, and a marquee drag clears the
passage selection.

## Tests
`test/mouse-e2e.mjs` (fixture `test/fixtures/live-mouse.json`).
