# arrangement — live arrangement read
`web/features/arrangement.js` · loads 15th

## Purpose
Reads every arranger clip live (no DAWproject export needed) through the extension's crawler and installs the result
as the Score-mode base. layout.js moves its button into the header as the primary action.
After a read Score mode shows **every track with notes** (Tracks "All tracks"; a group section view switches to Full)
— preference "After ⟳ Read arrangement: show all tracks" in the Tracks ▾ panel, default on; off keeps the track
selection. A **● out-of-date dot** (`#svarStale`, tooltip lists why) appears when the read may be old: a clip seen
since the read (on a track other than the selected one, and not edited from Score View, whose edits are overlaid)
matches no crawled clip by notes and play range, or the track list changed. Heuristic and cheap (the extension reports
only the selected clip). Writes through `SV.orchestrate.writeTracks` update the crawl and rebuild the base, which
resets the watch (updates in the 1.5 s after a base install are ignored: clip navigation still arriving).

## Owns
- Toolbar: `#svarRead` (Read arrangement), `#svarExact`, `#svarCancel`, `#svarStatus`.
- `SV.arrangement` (`read`, `crawlToScore(crawl)` (node-testable), `clipEnd`, and pure `noteSig`, `clipSnapshot`,
  `matchClip(crawl, liveData)`, `clipChanged`, `staleReasons({...})`; page: `staleReasons()`, `liveClip()` (the crawled
  clip the selected one is), `prefs`); the raw crawl stays in `SV.state.crawl`.
- `#svarStale`, `#svarShowAll` (in `#trackPanel`); localStorage `scoreview.arrangement.afterRead` ('all' | 'keep');
  sets `scoreview.trackMode2`; window event `sv-read-stale` when the dot shows or hides.
- Relies on `ArrangementCrawler.java`: ops `crawl` / `crawl exact` / `crawlCancel`, `GET /api/crawl`,
  `GET /api/transport`.

## Hooks
`liveData` (the out-of-date watch). Installs the base with `SV.setBase(score)`; calls `SV.sections.showAll()`.

## Tests
`test/arrangement-test.mjs` (`crawlToScore` on `test/fixtures/crawl-megaman2*.json`), `test/arrangement-stale-test.mjs`
(clip matching, out-of-date reasons), `test/arrangement-e2e.mjs` (all tracks after a read, the preference, the dot,
writeTracks keeping it current, Inspire Melody over the read in Clip mode). `test/live-crawl-ui.mjs`,
`test/crawl-run.mjs`, `test/crawl-probe.mjs` and `test/crawl-lanes.mjs` talk to the real extension: manual only.

## Docs
docs/research.md section C (how the crawler works); AGENTS.md "Live arrangement crawl".
