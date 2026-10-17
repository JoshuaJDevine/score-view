# notation — clefs, ottava, meter / tempo / key changes
`web/features/notation.js` · loads 19th; its `transformScore` hook runs first

## Purpose
Score-level notation that score.js engraves: clef changes and ottava lines (toggles), meter changes and tempo marks
from the DAWproject (Clip mode takes the tempo from the transport), and optional key changes at confident
modulations from the harmony analysis. In the Clip bars range it re-bases the score on the real bar line.

## Owns
- Toolbar: **Notation ▾** `#svnBtn`, panel `#svnPop` (checkboxes by `data-k`: `clefs`, `ottava`, `tempo`,
  `harmonyKeys`).
- `SV.notation` (`settings()`, `set({...})`).
- localStorage `scoreview.notation.*`.

## Hooks
`transformScore` (put first), `buildOptions`, `play`. Reads `SV.harmony`.

## Tests
`test/notation-test.mjs` (engraving, DAWproject automation, re-basing), `test/notation-e2e.mjs` (the menu and tempo
marks in the page; uses `test/selectors.mjs`).
