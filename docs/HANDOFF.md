# Score View — handoff / where we left off

_Updated 2026-10-23 (main music PC). Waves 0–2 landed on 2026-10-16 (plan notes in `docs/wave2.md`); the 2026-10-18
performance pass is merged into master, pushed (GitHub: JoshuaJDevine/bitwig-score-view, private) and installed.
The project is under construction: the interface, its words and its features are being clarified, and the docs are
being rewritten to match as decisions land (see "Decisions" below)._

## How you use it (the one way in)
1. Open the project in Bitwig, open Score View (http://localhost:8765).
2. Click any clip in Bitwig's **Arranger** (the clip itself, not a note in the clip editor), press **⟳ Read project**.
   If it cannot read, a prompt says why and what to do; it tries again by itself once you click another clip.
3. From then on the read is stored for this project and kept current; F5 or reopening the project restores it.
   Only the clip selected in Bitwig is editable; click a clip in Bitwig to edit its notes from the score.
There is no "Open .dawproject" any more (see Decisions).

## Decisions
- **2026-10-18 — Bitwig is the only source.** A DAWproject export is no longer a way to open a score (the Open button,
  drag and drop, the remembered/auto-reloading export file are gone). Why: two competing ways in confused which notes
  were live, and an old export made the live clip land at the wrong bar (edits then hit read-only export notes).
  The button is now **⟳ Read project** (was "Read arrangement"); a failed read opens a prompt with the reason and
  Try again instead of a 12 px status line. The DAWproject parser stays (test fixtures; maybe later "import extras
  from an export": automation for dynamics, plug-in states for articulation tables). Not decided yet: whether the
  page reads a project it has never read by itself (today: a button); whether "New empty score" (File ▾) stays.
- **2026-10-18 — Lifecycle inside Score View: New and Read project (= Load).** New (the wizard) builds the ensemble in
  the open Bitwig project and stores it like a read (empty staves); Read project loads a project once, after that the
  stored read is kept current. A New inside a project that already has a read with clips leaves that read alone.
- **2026-10-18 — Templates: fewer, better.** 29 → 10 (see docs/wizard.md "Templates"); the 19 retired starters are in
  docs/archive/wizard-templates-retired.js. Grouping now waits for a click into Bitwig (live: Group only acts while
  Bitwig is in front; verified working with the click).

## Where things live
| What | Where |
|---|---|
| Repo (working directory) | main music PC: `C:\Users\jd838\bitwig-score` · laptop: `C:\bitwig-score` |
| Public copy | github.com/JoshuaJDevine/score-view (snapshot per sync, no `lib/`): how to update it and what is left out in `docs/PUBLIC-SYNC.md` (`tools/sync-public.sh`) |
| Installed extension | `<Documents>\Bitwig Studio\Extensions\ScoreView.bwextension`; on both machines Bitwig uses the **OneDrive** Documents (`%USERPROFILE%\OneDrive\Documents\…`). `build.sh` detects it; override with `BITWIG_EXT_DIR` |
| Page | http://localhost:8765 (open as a Chrome app window: `chrome --app=http://localhost:8765`) |
| Harvested instrument presets | `<Documents>\Bitwig Studio\Score View Presets` (main PC: BBC Symphony Orchestra + Kontakt 8 folders; re-run `tools/harvest-presets.mjs` to add more; index `web/features/wizard-presets.js`) |
| User's harmonic system | `docs/functional-color-theory.md` (source PDF: OneDrive Desktop `FCT.pdf`) |
| Architecture + hook API | `docs/AGENTS.md` (read first) · one page per feature module: `docs/features/README.md` · research: `docs/research.md` · `docs/library-profiles.md` (probe results) · `docs/harmony.md`, `docs/orchestration.md`, `docs/wizard.md`, `docs/midi-bridge.md` |

## Daily commands
```bash
cd /c/Users/jd838/bitwig-score     # main PC (laptop: /c/bitwig-score)
bash build.sh                      # build + install; Bitwig hot-reloads; F5 the page (--no-install: build only)
npm run test:smoke                 # fast tier (~25 s): render, unit tests, e2e smoke
PORT_BASE=8900 bash test/run-all.sh   # all suites against the mock (~10 min; -j 3 runs them in parallel; same as npm test)
npm run check:java && npm run check:js
node tools/perf-bench.mjs --port 8990  # render timings on the Mega Man 2 crawl (mock; --runs N, --no-inline, --no-chunks,
                                   # --no-worker, --root <other checkout> for before/after); Score all parts: systems in
                                   # view ~0.15 s, all ~1.3 s (workers); an edit ~0.2 s; Clip ~35 ms
node test/live-readonly-check.mjs  # read-only smoke test against the live Bitwig (blocks all edits)
node tools/harvest-presets.mjs "<export>.dawproject"   # add real patches for the New Score wizard
```
Live-test scripts that change a project refuse unless it's a safe copy: `test/crawl-run.mjs`, `test/crawl-probe.mjs`,
`test/live-orchestrate.mjs` (project name must contain "crawl"); `test/live-wizard.mjs` (project name starts with "New").
CI: GitHub Actions on windows-latest (`.github/workflows/ci.yml`).

## What exists (all deployed)
- **Clip / Score views** (Clip: the selected clip + pinned tracks; Score: the whole song, all or pinned instruments) · Verovio engraving (tuplets, voices, clef changes, 8va, meter/tempo/key changes, articulations
  from BBC SO keyswitches, dynamics/hairpins from velocity or exported automation, rehearsal marks from cue markers).
- **App bar** (compact, one row): View ▾ / File ▾ / Read ▾ menus, command palette **Ctrl+K** (Ctrl+J), `?` shortcut sheet,
  toasts with history, status bar (selection readout spelled in the key, entry duration). Classic header is a preference.
- **⟳ Read project**: crawls every arranger clip → full live score; the only way a project gets in. A dot marks the
  read out of date when another track changed. Looping clips are measured automatically. Needs a clip selected first.
  The read is stored per project and restored after F5, kept current as a mirror, and checked against what Bitwig plays.
- **Editing**: arrows, mouse drag pitch/time/length, marquee, Ctrl+C/X/V, motifs (Alt+S/I/R/A/D/O, Alt+2–9 any diatonic
  interval above, Alt+Shift below), orchestration (Alt+X explode, Alt+B double, Alt+U reduce), Q rhythm readings,
  articulations (palette / Shift+S/U/I/T/A, latch from the note on).
- **Passage selection + cross-staff copy/paste** (Sibelius-style, `web/features/passage.js`): click a bar = that staff's bar,
  Ctrl+C, click a bar on another staff, Ctrl+V writes into that track's clip and leaves Bitwig on it (`gotoStay`);
  overwrite by default, merge as a preference; R repeats; click a note to make its clip live.
- **Note entry** (N): keypad layouts (Sibelius default, Dorico, MuseScore), Alt+digit intervals, Ctrl+arrows,
  articulation-aware lengths (legato / short), range warning, A–G, MIDI (Web MIDI or bridge), rhythm-first, F1–F8 cells,
  tap capture, mouse entry, Controller… MIDI learn.
- **Dynamics** (`web/features/dynamics.js`, `CurvePlayer.java`): p/f marks and hairpins in the score (H, Shift+H, Ctrl+E),
  hairpin shapes (S-curve default, linear, late/early swell, messa di voce), human variation. **Dynamics ▾ → Preview**
  (plays, moves the controls live, writes nothing) / **Render** (records real arranger automation with write "touch",
  then restores write settings). Library profiles: BBC SO Dynamics (20) + Expression (10), Pocket Strings Timbre (48) +
  Expression (49), Spitfire CC1 + CC11 (experimental, `sendMidi` not recorded), Pigments (remote control 1 for now).
- **Inspire ▾**: Melody over the chords (Clip mode uses the last arrangement read), Continue the phrase, Underscore (stub).
- **Harmony** (H): Functional Color Theory colours, roman numerals, expectation marks, snap to chord tones.
- **New Score wizard** (= "New"): 10 templates (Orchestral & choral, Retro & chiptune, Film & modern), each with a brief;
  harvested presets, tempo/meter/markers, groups (waits for a click into Bitwig: its Group only acts in front). The new
  score is stored like a read of the project, so F5 / reopening restores it without a Read.
- **File**: MusicXML export (Dorico), MIDI/MusicXML import into a clip, Print/PDF, paper themes. (No DAWproject open.)
- **Security**: localhost-only server, `X-ScoreView: 1` header on non-GET, POST-only edits, Developer mode for debug ops
  (details in `docs/AGENTS.md` "HTTP API").

## Status on 2026-10-23 (printing a study score of "town-theme-2-scroe-view")
- **Score rhythms** (web/score.js `interpret()`, buildMEI `opts.interpret`, View ▾ "Score rhythms", on by default; print and
  MusicXML too): a sampler performance is read as the plainest rhythm it can mean. Onsets snap to the coarsest level
  (beat, then 8th) within 0.3 of it and half the gap to the neighbours, stepping finer when separate onsets would meet;
  ends within 0.4; tuplet beats are decided from the played notes and keep their played edges; a bar with a Q reading
  (grid/tuplets) is as played. User's rule: notation intent over fidelity, slurs never inferred; they report edge cases.
  Known: a lone 16th deliberately before the beat moves onto it (13/570 in the Mega Man fixture); the chunk planner does
  not meet old breaks again with the narrower bars (test pinned to `interpret: false`).
- **Crawler starts inside a group**: "Move cursor to first lane" goes to the first lane of the selected clip's group
  (inferred from 4 live reads: a Percussion clip selected → 8 of 69 clips; a Harp clip → Perc I/II, Timpani, Bassoons
  missed). `startedBelowTop()` now fails such a read ("click a clip in the top track"). TODO (needs a Save-As copy): get
  the cursor to the top by itself (e.g. "Select item in previous lane" until it stops, then first lane).
- **Mirror placement**: Bitwig does not always move the play start marker to a clicked clip (marker 28 with the bar 9
  clip selected; 48 left from a Clarinets clip while Sketch bar 53.5 was selected → written at bar 13; marker 0 → a
  clip over Violin 1's empty bar 1 clip). `markerOrContent()`: the marker counts only when the read agrees or it moved
  with the selection; else the one clip with exactly these notes; else unsure (Refresh).
- Still open: renaming / Save-As loses the stored read (keyed by name; copied by hand today), a project switch can
  harvest into the previous project's read, several open Score View tabs all write the stored read (idea: one writer
  tab via BroadcastChannel), auto key guessed B♭ for an A♭ project.

## Status on 2026-10-18
- Built and installed master; full mock suite 69/69. Josh live-checked rendering in the Chrome app window (item 8
  below): **fast, passes**. Then a read in Mega Man 2 failed ("stepping through the notes inside the clip") without
  him noticing, the page kept an Oct 15 export as the score and edits to Violin 1 hit "Read-only (from the export)":
  led to the decision above.

## Status on 2026-10-17
- Full mock suite on the main PC after the Wave 2 merge: **57 passed, 0 failed** (516 s); built and installed.
- **Not yet tried live by Josh:** cross-staff paste, Render dynamics on **BBC SO** (only Pocket Strings was proven on the
  laptop), the new app bar / palette, the note-entry keypad layouts.

## Performance pass (2026-10-18, merged into master)
Five branches merged in order: perf/render-quick, perf/render-worker, perf/sync-settled, perf/arrangement-mirror,
perf/arrangement-listen, plus integration fixes (the mirror harvests from the extension's settled snapshot and takes the
play start from `selPlayStart`, without an `/api/transport` fetch; three e2e suites adjusted to the mirror).
- **Rendering** (core/svg-inline.js, core/chunks.js, core/engrave.js + engrave-worker.js, core/render.js): Verovio's
  glyph `<use>`s become inline `<path>`s (the ~6 s style recalc is gone); Score view is engraved one system per chunk
  in Web Workers with a cache, the systems in view first; `SV.render()` still builds the model at once and
  `SV.rendered()` resolves when the paper is complete; afterRender hooks measure first, then write (buildSoloMute).
  Fallbacks: localStorage `scoreview.inlineGlyphs` / `scoreview.chunked` / `scoreview.engraveWorker` = false.
- **Sync** (LiveSync.java, core/net.js, core/sources.js): the extension publishes one `/api/notes` version per burst of
  observer callbacks and reports `settled` (100 ms quiet after an edit, 200 ms after something that looks like a clip
  switch), `changedMs` and `selPlayStart`. The page's own 600 ms wait is gone; `SETTLE_MS` = 200 ms is only the
  fallback for an extension without the field.
- **Read once per project** (ArrangementMirror.java, features/arrangement-mirror.js): stored under
  `<Documents>Bitwig StudioScore View Cache<project>.json` (IndexedDB fallback), restored on F5 / project open,
  the selected clip harvested into it once settled; the out-of-date dot offers "Refresh N tracks" (op `crawl tracks …`)
  and an opt-in auto-refresh.
- **Listen while playing** (NoteListen.java, `GET /api/listen`, features/arrangement-listen.js; on by default, read-only):
  Score view compares what Bitwig plays with the read and marks tracks changed at bar N. Faster reading ("Read
  arrangement timing" = Fast, "step past audio and effect lanes") exists but is **off by default** until checked live.

Measured (`node tools/perf-bench.mjs`, mock, Mega Man 2 crawl: 23 parts, 216 bars; median ms, master → perf/integration):
| scenario | master | perf/integration |
|---|---|---|
| Score view, all parts, cold | 9977 (page frozen) | systems in view ~100 · whole score ~975 · main thread at most ~100 (after the review fixes; was 119 / 1324 / 185) |
| Score view, cached / re-render | 9007 | 110 |
| Edit mid-score | 9312 | 194 (one system re-engraved) |
| Live edit (Bitwig → paper) | 8461 | 163 |
| Clip view | 38 | 46 |
| Clip view + 4 pins | 245 | 176 |
Sync (test/sync-e2e.mjs, mock): an edit is remembered ~110 ms after the last change, `liveSettled` ~210 ms after the
last change of a clip switch (was ≥ 600 ms of page-side quiet).
Full mock suite on perf/integration: **69 passed, 0 failed** (-j 3, ~185 s); `bash build.sh --no-install` OK.

### Needs live verification (in a Save-As copy of a project; nothing here was run against Bitwig)
1. **Settle windows** (LiveSync 100 / 200 ms): in Score view with a Read, click between arranger clips of different
   tracks quickly, including large clips (hundreds of notes): no clip's notes may ever show on another track's staff,
   and an edited clip's overlay must stay on its own track. Also: edit a note, switch clips at once, come back. If
   anything mixes, raise `LiveSync.SWITCH_QUIET_MS` (and look at the `changedMs` values in `/api/notes`).
2. **Play start from `selPlayStart`**: select a clip that is not under the play start marker in Score view without a
   Read: the live clip must be drawn at the clip's bar (not the marker's old position).
3. **Mirror harvest**: after a Read, edit a clip in Bitwig, select another clip, F5: the stored read must show the edit
   and no dot. Move a clip and select it: the old place is "suspect", the dot offers Refresh 1 track.
   Same track: click quickly between two clips of one track (same length, different notes) many times, then F5: no
   clip may hold the other's notes (a lagging play start marker makes the track "unsure" for a moment, never an
   overwrite). Duplicate a clip (Ctrl+D), edit the copy from Score View: the original keeps its notes and the dot offers
   Refresh 1 track. Click the ruler while a clip is selected, then edit that clip: the dot, no other clip changed.
4. **Stored read**: after a Read, check `<Documents>Bitwig StudioScore View Cache<project>.json` exists (on this PC
   `C:\Users\jd838\Documents\Bitwig Studio\Score View Cache`, not OneDrive: the plain Documents folder is checked first;
   `GET /api/arrangement` names the folder); restart Bitwig, open the project, open the page: the read is restored with its age shown.
   Two unsaved "Untitled" projects must not get each other's read. After the restore, a cross-staff paste into a clip
   not selected since must be refused ("restored … not been seen since"); click that clip once, then it pastes.
   Known limit: the stored read is keyed by the project **name** only (the API gives no file path), so a backup copy or
   a Save-As to another folder with the same name shares it; the paste guard above keeps such a read from driving
   writes, but it is shown and harvests from it overwrite the other copy's stored read.
5. **Refresh N tracks** (op `crawl tracks …`): change two tracks, use the dot's Refresh: only those lanes are walked and
   the rest of the score is unchanged; then auto-refresh on: stop playback, wait 4 s, it re-reads by itself once.
6. **Listen while playing**: play the arrangement in Score view after a fresh Read: no track may be flagged. Then change
   a clip in Bitwig without selecting it, play over it: that track is flagged at the right bar. Run
   `node test/listen-probe.mjs` (read-only) to learn whether notes are reported before or after Note FX (an arpeggiator
   track should end up ignored, not flagged), and check the beat stamps against the bar (tempo changes, arranger loop).
7. **Fast read / lane skipping** (Preferences > Score View, both off by default): in a Save-As copy run a Read with
   "Read arrangement timing" = Fast and compare with a Safe read (`test/crawl-run.mjs --safe` / `--fast` and
   `test/crawl-compare.mjs`, project name must contain "crawl"); then the same with "step past audio and effect lanes".
   Only switch the defaults when the reads match on several projects.
8. **Rendering in the real Chrome app window**: Score view all parts on a big project: systems in view appear in well
   under a second, glyphs (clefs, noteheads, accidentals, rests, dynamics) look identical to before, Print/PDF and
   MusicXML export unchanged; DevTools shows the `core/engrave-worker.js` workers running (served by the extension).
9. **flush() publishing**: `/api/notes` versions now publish from `flush()` and a sync tick; check the page still
   follows edits, solo/mute and track renames promptly and that Bitwig's CPU stays normal while playing (the note
   observers on all 128 tracks for listening).

## Open questions / next ideas (user's queue)
- **Try Render dynamics on BBC SO** on this PC (the main reason it was deferred here) — in a Save-As copy.
- Double gave **D D D F** for a line expected to be **E♭ D E♭ F**; spelling bug fixed, re-test and check the Key shown.
- **Dynamics both ways**: editing marks/hairpins rescales velocities (partly there: `planVelocities`); per-note pressure.
- Dynamics limits: launcher clips (planned: generated .mid via `insertFile`), marks stay at old beats when a clip moves,
  Pigments macro VST3 param id.
- Note entry has "many small details" the user wants to walk through one by one.
- Harvest more presets (Opus/Hollywood, Sonuscore, Super Audio Cart, SAC2 N64 bank); untested live: wizard tempo/meter/
  markers, Stop mid-run, Swap library.
- Spitfire LABS/Stratus/Kepler/Earth/Tutti/Albion NEO+Solstice weren't visible to Bitwig on the laptop (Spitfire App).

## Working style the user prefers
One issue at a time while testing; short cause → fix → "press F5" answers; quick targeted checks (full suite only before
bigger merges or when asked); options + a recommendation for design questions; they learn by trying and asking.
Never test project-changing features in their real project (use a Save-As copy or a new empty project).

## Housekeeping
- Finished agent worktrees may remain under `.claude/worktrees/` (ignored by git); remove with `git worktree list` /
  `git worktree remove --force <path>` and delete `worktree-agent-*` / `wave*` branches once merged.
- Open GitHub issues: #9 (articulations/dynamics follow-ups), #14 (wizard live tests).
