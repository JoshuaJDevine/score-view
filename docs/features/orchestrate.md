# orchestrate — write into other tracks
`web/features/orchestrate.js` · loads 7th

## Purpose
Explode (spread a chord or passage over several instruments), Double (copy a line at unison / octave / third / sixth)
and Reduce (merge staves onto one track). Each target clip is reached with the extension's clip navigator, one batch
per target track: `goto … / add … / gotoHome` (the extension also has `gotoStay`, which ends the session on the target
clip; features/passage.js uses it for copy/paste between staves). Needs a live arrangement read. Alt+X / Alt+B / Alt+U.

## Owns
- Toolbar: **Orchestrate ▾** `#orcBtn`, panel `#orcPanel` (`#orcPreview`, `#orcApply`, `#orcClose`, …).
- `SV.orchestrate` (pure `Core` plus `apply`, `writeTracks`, `open`, `close`, `compute`, `planAll`, `lastReport`;
  `rebuildBase(crawl, tracks)` and `isBusy()` are shared with features/passage.js).
- localStorage `scoreview.orchestrate.prefs` (includes `stayOpen`, checkbox `#orcStay` "Stay open while I select
  notes", default on: a press in the score keeps the panel open, any other outside press or Esc closes it).
- Relies on `ClipNavigator.java` (ops `goto`, `gotoHome`, `navCancel`; `GET /api/nav`) and `GET /api/transport`.

## Hooks
`keydown` (an Esc handler unshifted to run first — it lets Esc through to mouse.js while a mouse button is held,
so Esc cancels a drag before it closes the panel — plus the Alt shortcuts in script order). Reads `SV.arrangement`, `SV.instruments`, `SV.sections`; calls `SV.setBase`.

## Tests
`test/orchestrate-test.mjs` (pure core), `test/orchestrate-e2e.mjs` (mock arrangement and navigator), `test/popover-e2e.mjs`
(Esc / outside press, Stay open, Esc during a drag).
`test/live-orchestrate.mjs` drives the real extension: manual only, never in run-all.

## Docs
docs/orchestration.md.
