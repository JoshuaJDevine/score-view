# passage — passage selection and copy/paste between staves
`web/features/passage.js` · loads after mouse (13th)

## Purpose
Sibelius-style passage selection in Score mode: click an empty spot of a bar to select that bar on that staff (light
blue box), Shift+click to extend across bars and staves, Ctrl+click to add or remove a staff, Esc to clear. Ctrl+C copies
the passage (every selected staff, notes in arranger beats); click a bar on another staff and Ctrl+V writes it into that
track's clip. Several copied staves land on consecutive staves. Alt+click a bar copies the selected passage there
directly; R repeats it after itself (the selection moves on, so R R R continues). Clicking a note on another staff (or
in another clip of the live track) makes that clip live in Bitwig.

Every write is one clip-navigator batch: `goto <clip>` + `del` / `dur` / `add` for each target clip, and the first
target's clip last with `gotoStay`, so Bitwig is **left on the pasted clip** with the pasted notes selected (↑↑ works at
once). The base is rebuilt from the updated crawl (no new read needed). Needs a ⟳ Read arrangement (clear message
otherwise); refused while playing; refused when the read is out of date for a target track (`SV.arrangement.staleReasons()`);
a target clip that loops more than once, or a bar with no clip, refuses the whole paste (nothing is written). A clip with
the same notes and play range elsewhere is reported as a possible **clip alias** (it would change too).

Overwrite (default): notes starting in the destination bars are deleted, notes ringing into them are shortened to the
start, the copy is cut at the passage end. Keyswitches (below C1) stay out of a copy and are left alone in the
destination, unless the preference includes them.

## Owns
- Toolbar: **Passage ▾** `#pasBtn` (cluster `write`, order 75), panel `#pasPanel` (`#pasCopy`, `#pasPaste`, `#pasRepeat`,
  preferences `#pasMode`, `#pasKs`, `#pasClick`, `#pasAlt`, `#pasLive`, `#pasEmpty`, `#pasStatus`, `#pasClose`).
- Paper layer `#pas-layer` (`.pas-box` per staff and system row).
- Keys (context `passage selected`): Ctrl+C, Ctrl+V, R, Esc (Ctrl+A and Tab select notes and drop the passage). Alt+click a bar (window capture listener, before
  playback.js's Alt+click = play from the bar; bar numbers still play; without a read or while playing Alt+click
  stays play-from-bar, since no copy could be written).
- `SV.passage` — pure core (`selectAt`, `copyPassage`, `pasteTargets`, `clipEdits`, `planPaste`, `batchLines`,
  `landedJobs`, `aliasWarnings`) plus `copy()`, `paste()`, `repeat()`, `copyTo(track, bar)`, `pasteAt(copy, bar,
  {track | tracks})`, `selection()`, `select({staves, from, to})`, `clear()`, `active()`, `takesKey(k)`,
  `notesCopied()`, `clipboard`, `staffNotes(track)`, `expectClip(...)`, `lastReport()`, `prefs`.
- `SV.expectClip({track, start, ids, clip?})`: once Bitwig reports that clip (after a `gotoStay`), place it at arranger
  beat `start` (manual placement) and select `ids`.
- localStorage `scoreview.passage.prefs` — `mode` 'overwrite' (default) | 'merge'; `keyswitches` false (default: left
  out of copies); `click` 'select' (default) | 'off'; `altClick` 'copy' (default) | 'play'; `noteClick` 'live' (default)
  | 'off'; `emptyStaves` false (default) — when on, tracks whose clips are all empty get an empty staff after a read (and
  Hide empty staves is set aside while they show) so they can be pasted into. `scoreview.passage.clipboard`.
- Relies on `ClipNavigator.java` (`goto`, `gotoStay`, `GET /api/nav`), `GET /api/transport`.

## Hooks
`paperClick` (bar selection), `noteClick` (clears the passage; another staff's note → make it live), `keydown`,
`liveData` (`expectClip`), `buildOptions` (no condensing while empty staves are shown), `afterRender` (boxes, empty parts).
Reads `SV.orchestrate` (`clipIndex`, `planTarget`, `firstPassEnd`, `barOf`, `rebuildBase`, `isBusy`), `SV.arrangement`
(`clipEnd`, `staleReasons`), `SV.entry` (off in note entry), `SV.core.clipKey` (placing the landed clip).
Coexistence with features/mouse.js: mouse.js asks `SV.passage.takesKey(k)` before Ctrl+C / V (with a passage selected
Ctrl+C copies the passage; Ctrl+V pastes a passage unless notes were copied since — `notesCopied()`), and a marquee drag
clears the passage. A click on a note clears the passage; a bar click clears the note selection.

## Tests
`test/passage-test.mjs` (pure core), `test/passage-e2e.mjs` (mock arrangement + navigator: selection and boxes, overwrite
with a note ringing in and a keyswitch, stay + ↑↑, two staves with a content offset, merge, R, Alt+click, alias warning,
click a note to make its clip live, refusals, the note clipboard). Screenshots `test/out.paste-*.png` (or `SHOTS_DIR`).
