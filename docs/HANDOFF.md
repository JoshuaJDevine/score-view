# Score View — handoff / where we left off

_Last session: 2026-10-15/16. Development notes kept between working sessions._

## Where things live
| What | Where |
|---|---|
| Repo (working directory) | wherever it is cloned — on the current laptop `C:\bitwig-score` (older notes may say `C:\Users\<user>\bitwig-score`: that was the previous machine) |
| Installed extension | `<Documents>\Bitwig Studio\Extensions\ScoreView.bwextension`; on this laptop Bitwig uses the **OneDrive** Documents (`%USERPROFILE%\OneDrive\Documents\…`). `build.sh` detects it; override with `BITWIG_EXT_DIR` |
| Page | http://localhost:8765 (open as a Chrome app window: `chrome --app=http://localhost:8765`) |
| Harvested instrument presets | `<Documents>\Bitwig Studio\Score View Presets` (24 on the previous machine; may be missing on a new one — re-run `tools/harvest-presets.mjs`; index `web/features/wizard-presets.js`) |
| User's harmonic system | `docs/functional-color-theory.md` (summary of the author's paper) |
| Architecture + hook API | `docs/AGENTS.md` (read first) · research: `docs/research.md` · per-feature: `docs/harmony.md`, `docs/orchestration.md`, `docs/wizard.md`, `docs/midi-bridge.md` |

## Daily commands
```bash
cd /c/bitwig-score                 # the repo on this laptop
bash build.sh                      # build + install; Bitwig hot-reloads; F5 the page (--no-install: build only)
npm run test:smoke                 # fast tier (~25 s): render, unit tests, e2e smoke
PORT_BASE=8900 bash test/run-all.sh   # all suites against the mock (~36 suites, ~10 min; same as npm test)
node test/live-readonly-check.mjs  # read-only smoke test against the live Bitwig (blocks all edits)
node tools/harvest-presets.mjs "<export>.dawproject"   # add real patches for the New Score wizard
```
Live-test scripts that change a project refuse unless it's a safe copy: `test/crawl-run.mjs`, `test/crawl-probe.mjs`,
`test/live-orchestrate.mjs` (project name must contain "crawl"); `test/live-wizard.mjs` (project name starts with "New").

## What exists (all deployed)
- **Clip / Score modes** · Verovio engraving (tuplets, voices, clef changes, 8va, meter/tempo/key changes, articulations
  from BBC SO keyswitches, dynamics/hairpins from velocity or exported automation, rehearsal marks from cue markers).
- **⟳ Read arrangement** (header, orange): crawls every arranger clip with Bitwig actions → full live score; optional
  "Exact clip lengths" (Loop Selection + verified undo). Needs a clip selected in the Arranger first.
- **Editing**: arrows (semitone/scale step/octave), mouse drag pitch/time/length, marquee, Ctrl+C/X/V (same clip),
  motifs (Alt+S/I/R/A/D/O/3/6), orchestration (Alt+X explode, Alt+B double, Alt+U reduce — writes into other tracks'
  clips via `ClipNavigator`), Q rhythm readings, articulation palette / Shift+S/U/I/T/A (latch from the note on).
- **Note entry** (N): keypad durations, A–G, S88/Launchkey via Web MIDI or the Bitwig bridge, rhythm-first slots,
  F1–F8 rhythm cells, tap capture, mouse entry, Controller… MIDI learn.
- **Harmony** (H): the user's Functional Color Theory colours, roman numerals, expectation marks, snap to chord tones.
- **New Score wizard**: 5 Essentials + 24 starter templates with briefs, patch hints, harvested presets, tempo/meter/
  markers; groups are formed by multi-select + Bitwig "Group" (moveTracks into groups is a no-op in Bitwig 6.1).
  Each new score starts fresh; switching projects drops the old score; "New empty score" builds one from the tracks.
- **File**: MusicXML export (Dorico), MIDI/MusicXML import into a clip, Print/PDF, paper themes.

## Fixed in the last hands-on session (deployed; targeted checks only — full suite not re-run since)
1. Trimmed clip start (Offset/playStart) honoured everywhere (`SV.contentOrigin()`), score re-renders on trim.
2. Score mode with no loaded score shows the project's instrument tracks; pins survive project switches.
3. UI pass: Read arrangement is the primary header button with status; toolbar grouped Score · Write · Play · File.
4. Notes painted on the wrong staff after switching clips: overlay snapshots only for edited clips, after 500 ms settle.
5. Double: diatonic thirds/sixths spell like an engraver (C B♮ C D → E♭ D E♭ F); key selector in the dialog.
6. Articulations latch from the selected note on; "Apply to the selected notes only" keeps the old behaviour.

**First thing tomorrow:** run `PORT_BASE=8900 bash test/run-all.sh` once (fixes 1–6 were only spot-checked), then F5.

## Open questions / next ideas (user's queue)
- Double gave **D D D F** for a line expected to be **E♭ D E♭ F** — the spelling bug is fixed, but the exact source notes
  weren't confirmed; re-test and check the Key shown in the dialog.
- **Cross-staff copy/paste** Sibelius-style (click a bar = select it on that staff; Ctrl+C; click a bar on another staff;
  Ctrl+V writes into that track's clip and leaves Bitwig on it so ↑↑ works). Design agreed; not built. Orchestrate ▾ Double
  covers part of it today.
- **Dynamics both ways**: editing marks/hairpins rescales velocities; optional per-note pressure → BBC SO Dynamics
  mapping (would need a saved track preset). Not built.
- Note entry has "many small details" the user wants to walk through one by one.
- Harvest more presets (Opus/Hollywood, Sonuscore, Super Audio Cart NES/SNES/N64 snapshots, SAC2 N64 bank) so the
  starter templates load real sounds; untested live: wizard tempo/meter/markers, Stop mid-run, Swap library.
- Possible "View ▾" menu to declutter the header row.
- Spitfire LABS/Stratus/Kepler/Earth/Tutti/Albion NEO+Solstice aren't visible to Bitwig (reinstall via Spitfire App).

## Working style the user prefers
One issue at a time while testing; short cause → fix → "press F5" answers; quick targeted checks (full suite only before
bigger merges or when asked); options + a recommendation for design questions; they learn by trying and asking.
Never test project-changing features in their real project (use a Save-As copy or a new empty project).

## Security (wave 0)
- The HTTP server answers only `Host: 127.0.0.1|localhost|[::1]:<port>`; anything but GET/HEAD needs the header
  `X-ScoreView: 1` (the page adds it in `web/core/guard.js`; Node scripts must send it); an Origin, when sent (GETs too), must
  be our own, and cross-site fetches (`Sec-Fetch-Site`) are refused except a top-level navigation; OPTIONS is 403;
  `/api/edit` is POST only (`HttpGuard.java`, mirrored in `test/mock-server.mjs`; `test/security-test.mjs`).
- Bitwig Preferences > Score View > **Developer mode (debug ops)**, default off: allows the `act`, `clipNext/Prev`,
  `selectTrack`, `moveTrackAfter/Before` ops (only the crawl research scripts use them) and wizard preset files from
  outside the Bitwig library / preset folders. Without it a wizard "file" device must be a local absolute path (never a
  UNC/network path, checked before anything opens it) with a preset or sample extension (`PRESET_EXTENSIONS`).

## Housekeeping
- 18 finished agent worktrees remain under `.claude/worktrees/` (ignored by git); safe to remove with
  `git worktree list` / `git worktree remove --force <path>` and deleting `worktree-agent-*` branches.
- Open GitHub issues: #9 (articulations/dynamics follow-ups), #14 (wizard live tests). Others are closed.
