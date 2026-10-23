# inspire — quick starting material
`web/features/inspire.js` (+ data file `web/features/inspire-library.js`) · loads 8th–9th

## Purpose
"Underscore string chords…": fills N bars of the selected clip with a sustained, voice-led chord pad from a mood
library (Hopeful, Melancholy, Suspense). One clip, one staff (divisi); spreading it over a section is Orchestrate ▾
Explode. Existing notes in the range are replaced by default; **Again** swaps the last roll for another progression.

**Melody** chords come from, in order: the harmony of the other staves (Score mode); in Clip mode the other tracks of
the last ⟳ Read project under the selected clip (`SV.arrangement.liveClip()` gives its crawled clip; content step 0
is at clip start − play start in arranger beats); the last pad Inspire wrote (`scoreview.inspire.lastPad`).

## Owns
- Toolbar: **Inspire ▾** `#insBtn`, panel `#insPanel` (`#insMood`, `#insBars`, `#insStart`, `#insKey`, `#insExisting`,
  `#insAgain`, `#insWrite`, `#insClose`).
- `SV.inspire` (pure core plus `open`, `close`, `write`, `library`); `window.SVInspireLibrary` (moods).
- localStorage `scoreview.inspire.prefs` (mood, bars, key, existing notes: replace | keep).
- Sends ordinary `del` / `add` edit ops.

## Hooks
None. Reads `SV.instruments` (range per part), `SV.harmony`, `SV.arrangement`, `SV.orchestrate`. Registers its panel
keys (Esc, Enter) with `SV.shortcuts`.

## Tests
`test/inspire-test.mjs` (pure core), `test/inspire-e2e.mjs` (dialog against the mock), `test/arrangement-e2e.mjs`
(Melody in Clip mode over a read).

## Docs
docs/library-profiles.md.
