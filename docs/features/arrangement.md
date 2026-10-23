# arrangement — live arrangement read, kept current
`web/features/arrangement-mirror.js` + `web/features/arrangement-listen.js` (pure helpers) + `web/features/arrangement.js` · load 15th

## Purpose
**The one way a project gets into Score View.** Reads every arranger clip live through the extension's crawler and
installs the result as the Score-mode base (there is no file to open). layout.js moves its button into the header as the primary action.
A read keeps the view and the shown tracks (Clip / Score view, pins, Instruments ▾ decide them).

**When a read cannot start or stops** (`/api/crawl` state `error`), a prompt opens under the button (`#svarFail`: the
reason, what to do, Try again `#svarRetry`, Close `#svarFailClose`) instead of a status line. The extension's `fix`
field says what helps: `clickClip` (Bitwig's focus is not on the Arranger timeline, or its selection actions walk the
notes inside a clip; the prompt also names View ▾ "Select in Bitwig too" when it is on) retries by itself once another
clip is selected; `stop` retries when playback stops; `""` only offers Try again. Cancel never opens it.

**Once per project.** The read is stored per project (extension `GET/POST /api/arrangement`, ArrangementMirror.java,
under Documents/Bitwig Studio/Score View Cache; IndexedDB `scoreview-arrangement` as a fallback for an older extension
or the mock) and restored on page load and when a project opens again; the header shows its age. A stored read
whose tracks share less than half of today's tracks is not restored (two unsaved projects may share a name). A restored
read is not trusted for writing: Bitwig may have changed while the page was closed, so each clip counts as unconfirmed
until it is seen again (selected and harvested, or re-read), and a cross-staff paste into an unconfirmed clip is
refused (`SV.arrangement.unconfirmed(clips)`); the header says "restored".

**Kept current (the mirror).** The clip selected in Bitwig is harvested into the read once its data has settled (quiet
300 ms, the play start marker reading the same 150 ms later; with `d.settled` / `d.selPlayStart` from the extension
it is harvested at once from that snapshot, without asking `/api/transport`): it replaces the clip at the same start on its track, or is added at its start. Its start
is the play start marker (Bitwig moves it to a selected clip), or where a gotoStay left it (`/api/nav stayed`). The
marker moving while the clip stays the same (a click in the ruler, or a selected copy) is not guessed: the track is
listed as unsure, and stays so while that clip is selected and edited (an edited copy and the old clip edited after a
ruler click look the same; neither is written over the clip at the old start or at the marker). A clip of the same
track with mostly other notes (more than one note changed) while the marker has not moved is not put at the marker
either: it is another clip whose marker has not arrived yet (or a big edit in Bitwig; Score View's own edits do not
count), so the track is unsure until the marker moves and places it. When the mirror holds exactly the selected notes
at the marker, that settles it. Only that track's part is rebuilt (`updateScore`) and nothing is re-rendered when the live clip is
already drawn there over a clip of the same span. The same content at a new start makes the old clip **suspect** (moved
or copied: the mirror cannot tell), as does a clip that now starts inside the new one; suspects are still engraved.

The **● out-of-date dot** (`#svarStale`) appears for what the mirror could not fix: the track list changed (new, gone,
reordered), suspect clips, unsure tracks, or a clip seen on another track that matches nothing. Clips are recorded for the watch only from settled snapshots
(`/api/notes` `settled` is not false; mid-switch the new clip's notes can arrive under the old track's name, which would
mark that track changed). Clicking it opens a
popover (`#svarPop`): the reasons, **Refresh N tracks** (`#svarRefresh`, op `crawl tracks …`: only those lanes are
walked; the result replaces those tracks and the track list is taken in; gone tracks are dropped; with N = 0 "Update
the track list" needs no read), **Read everything** (`#svarReadAll`), and the opt-in **auto-refresh** (`#svarAuto`,
default off): out-of-date tracks are re-read by themselves once playback stopped and nothing changed in Bitwig for 4 s
(once per stop; the same list is not retried). Writes through `SV.orchestrate.writeTracks` / passage paste update the
crawl and rebuild the base, which resets the watch and saves the mirror.

**Listening while playing** (`arrangement-listen.js`, default on, `#svarListen`): in Score view, while Bitwig plays,
the page polls `GET /api/listen` (the notes each track reports, stamped with the arranger beat) and compares note-on
onsets with the read per track and bar (keyswitches below C1 left out, ±0.15 beat). Each track learns a baseline on
its first bars after a read; a low one (a Note FX changes what it plays, e.g. an arpeggiator) makes it ignored. A
track is listed as "**X changed at bar N (heard while playing)**" when a bar disagrees on two hearings, or two
neighbouring bars are far off in one pass; it joins Refresh N tracks (and the auto-refresh). The selected clip's
track (harvested instead), edited, group, muted and soloed-out tracks are not judged. It changes nothing in Bitwig.
Whether Bitwig reports notes before or after Note FX is not known yet: `test/listen-probe.mjs` (live, read-only).

**Reading faster** (extension preferences, both off by default until checked live): "Read arrangement timing" Fast
(adaptive waits informed by `flush()`) and "step past audio and effect lanes"; see AGENTS.md "Live arrangement crawl".
`/api/crawl` reports `timing`, `skipped`, `laneOrder`, `ms`.

## Owns
- Toolbar: `#svarRead` (Read project), `#svarCancel`, `#svarStatus`, `#svarStale`; popover `#svarPop` (`#svarWhy`,
  `#svarRefresh`, `#svarReadAll`, `#svarAuto`, `#svarListen`); localStorage `scoreview.arrangement.autoRefresh`,
  `scoreview.arrangement.listen`; IndexedDB
  `scoreview-arrangement` (`mirror:<project>`).
- `SV.arrangement` (`read`, `refreshTracks(names)`, `crawlToScore(crawl)`, `updateScore(score, crawl, tracks)`,
  `clipEnd`, pure `noteSig`, `clipSnapshot`, `matchClip`, `clipChanged`, `staleInfo({...})`, `staleReasons({...})`,
  `mirror` (= arrangement-mirror.js), `listen` (= arrangement-listen.js); page: `staleReasons()`, `staleTracks()`,
  `liveClip()`, `mirrorInfo()`, `listenInfo()`, `prefs`);
  the raw crawl (the mirror) stays in `SV.state.crawl`.
- `window.SVArrangementMirror` (arrangement-mirror.js, pure): `clipFromLive`, `sameContent`, `upsertClip`,
  `mergeSubset`, `syncTracks`, `placeSelected`, `makeDoc`, `validDoc`, `pickDoc`.
- `window.SVArrangementListen` (arrangement-listen.js, pure): `expectedOnsets`, `heardOnsets`, `barScores`, `judge`,
  `createListener()` (`feed`, `reset`, `resetTracks`, `flagged`, `info`).
- Window event `sv-read-stale` when the dot shows or hides.
- Relies on `ArrangementCrawler.java` / `ArrangementMirror.java`: ops `crawl` / `crawl exact` / `crawl tracks <names>` /
  `crawlCancel`, `GET /api/crawl`, `GET/POST /api/arrangement`, `GET /api/transport`, `GET /api/nav`, `GET /api/listen`.

## Hooks
`liveData` (one handler: the out-of-date watch, restoring the stored read on the first update and on a project
change, scheduling the harvest). Listening polls /api/listen on its own timer (no play hook). Installs the base with `SV.setBase(score)`, updates it with `SV.updateBase(score,
{drop, place, render})`.

## Tests
`test/arrangement-test.mjs` (`crawlToScore` on `test/fixtures/crawl-megaman2*.json`), `test/arrangement-stale-test.mjs`
(clip matching, out-of-date reasons), `test/arrangement-mirror-test.mjs` (upsert, suspects, placement, merge, documents,
`updateScore` = `crawlToScore`), `test/arrangement-e2e.mjs` (all tracks after a read, the dot, writeTracks keeping it
current, Inspire Melody over the read in Clip mode), `test/arrangement-mirror-e2e.mjs` (reload keeps the read, a clip
changed in Bitwig updates the score without a read, a moved clip → suspect → Refresh 1 track, a new track, project
switch, IndexedDB fallback), `test/crawler-check-test.mjs` (the real crawler incl. `crawl tracks` and the store against
a fake Bitwig, plus the fast walk and NoteListen), `test/arrangement-listen-test.mjs` (onset matching, baseline, Note FX
ignored, consistency, silent tracks, loops), `test/arrangement-listen-e2e.mjs` (play in the mock: baselines, a clip
changed in Bitwig → "changed at bar 3" → Refresh 1 track, preference off), `test/crawl-compare-test.mjs`.
`test/live-crawl-ui.mjs`, `test/crawl-run.mjs` (`--safe` / `--fast`), `test/crawl-probe.mjs`, `test/crawl-lanes.mjs`,
`test/listen-probe.mjs` (read-only) and `test/clip-step-probe.mjs` talk
to the real extension: manual only.

## Docs
docs/research.md section C (how the crawler works); AGENTS.md "Live arrangement crawl".
