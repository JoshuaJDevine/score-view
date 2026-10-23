# dynamics — marks, hairpins and Render dynamics
`web/features/dynamics.js` · loads after `rhythm` and `library-profiles`, before `harmony` (so H with notes selected is
a hairpin) · extension side `src/claude/scoreview/CurvePlayer.java`

## Purpose
Sibelius-style dynamics on the live clip's notes, stored in the Bitwig project, and performed on the real library:
select notes, press **H** (crescendo) / **Shift+H** (diminuendo) or **Ctrl+E** and type `pp … fff`, `fp`, `sfz`, `<`,
`>`, `<>` or Dorico-style `p<f` (mark + hairpin + mark over the selection). Marks also set the velocities of the notes
they govern ("both ways"). **Dynamics ▾ → Render** plays the chosen bars and records the library's controls (e.g. Pocket
Strings Timbre + Expression) as ordinary Bitwig arranger automation; **Preview** moves the controls without recording.

## Data flow
```
marks + hairpins (arranger beats, per track name; doc in the project) ─levelModel→ level 0..1 per beat
  ─levelPoints (≤ 16 points per hairpin, holds flat, seeded variation)→ ─targetPoints (profile min/max/gamma; the
  second control trails a little)→ curveClear / curveSet … / curveRender|curvePreview from to  ─→ CurvePlayer
```
* **Document** (`GET/POST /api/marks`, the extension's DocumentState string "Dynamics marks", hidden, ≤ 65535 chars,
  saved with the project): `{v:1, tracks:{[name]: {marks:[{id, beat, text, clip, co, ck, or}], hairpins:[{id, start,
  end, form, shape?, strength?, clip, co, ck, or}]}}}`. Beats are arranger beats; `clip` = arranger start of the clip
  they were entered in, `co` = arranger beat of that clip's content beat 0, `ck` = the clip's identity (length |
  loopStart | loopLength), `or` = how sure `co` was (2 exact, 1 placement, 0 guessed from the play start marker).
* **Where the clip is** (`liveOrigin()` → `{origin, how, rank}`): measured from the playhead while the clip played
  (`pos - step`, snapped; rank 2), else Score-mode placement (rank 1; 2 when it came from the playhead), else the last
  ⟳ Read project (rank 2), else the play start marker (rank 0: a guess): the extension's `selPlayStart` from the
  settled snapshot after the clip was selected (`SV.state.playStartGuess`, core/sources.js), or with an extension
  without that field `/api/transport` 400 ms after the switch. Without any of these entry is refused.
* **Re-anchoring** (`reanchor`, `reanchorLive`): once the live clip's origin is exact, its items (same `ck`) entered at a
  guessed origin move to it; items entered at an exact origin move only when a Read has no clip of the track at their
  old `co` any more (the clip moved; otherwise they belong to a copy).
* **Velocities**: every note a dynamic governs (from the first dynamic on; under a hairpin its curve) gets
  `humanVelocity(level)`: the level's velocity, a downbeat lift (0.6 H; other beats 0.25 H) and a seeded ±H wobble per
  note (H = Humanize, default 4). Deterministic, so re-applying changes nothing. Applied when a dynamic is entered (its
  notes), to new and moved notes as they appear (not while playing, not on a clip switch), and by "Apply to all
  marked notes". The controls (Dynamics / Expression) change only on Render / Preview.
* **Levels**: ppp .1 · pp .2 · p .32 · mp .45 · mf .57 · f .7 · ff .84 · fff .95; `fp` = f for a 16th then p; `sfz` & co.
  a short spike. A hairpin runs to the dynamic written at its end, else one step (±0.14).
* **Span of a selection**: from the first selected note to the next note's start when it comes within a beat of the last
  note's end, else that end rounded up to a 16th — so `p<f` puts the f on a rhythmic position, not mid-beat after a
  short note. Clear removes marks up to (not including) that end.
* **Shapes**: S-curve (default), Linear, Late swell, Early swell, Messa di voce (`<>`, engraved as `<` + `>`); global
  default + strength in the panel, per-hairpin shape/strength from a click on the hairpin.
* **CurvePlayer** (ops `curveClear`, `curveSet <id> <track> <profile> <target> <beat:value,…>`, `curvePreview|curveRender
  <from> <to>`, `curveStop`; `GET /api/curve` → `{state: idle|preparing|running|done|stopped|error, mode, message, from,
  to, pos, progress, written, restored, run (counts Preview/Render requests: the page waits until it changes), curves:[…],
  devices:{track:[device names]}}`): points a pool slot (8 cursor
  tracks made in init(), each with a 4-device bank holding a `createSpecificVst3Device(id).createParameter(n)` for every
  vst3 target of the profile table, plus remote-control pages) at each track, waits ≤ 3 s for the controls, sets play
  start 1 beat before the range and plays (positions are used once the playhead has reached that run-up start, so a stale
  old position is never taken for the range). Preview: arranger and launcher write off while it plays (else Bitwig would
  record the moves). Render: saves the write settings, arranger write on + mode "touch", launcher
  write off, `touch(true)` at the range start, `set()` every 10 ms at playhead + 0.02 beats (changes < 0.002 skipped),
  `touch(false)` at the end, stops, restores write settings and play start (also on Stop, a stop in Bitwig, a loop jump
  back, an error and extension exit). Refuses while playing, while a crawl / clip navigation runs, and after a failed
  `curveSet` until the next `curveClear`.

## Owns
- Toolbar: **Dynamics ▾** `#svdBtn` (Write cluster, order 90), panel `#svdPanel` (`#svdType`, `#svdList`,
  `select[data-profile]`, `input[data-track]`, `#svdFrom`, `#svdTo`, `#svdShape`, `#svdStrength`, `#svdVar`,
  `#svdAmount`, `#svdVelMarks`, `#svdVelHairpins`, `#svdVelNew`, `#svdHuman`, `#svdApplyVel`, `#svdKeys`, `#svdPreview`, `#svdRender`, `#svdStop`, `#svdStatus`).
  Popovers `#svdPop` (Ctrl+E) and `#svdItemPop` (click on a mark / hairpin).
- Keys (registered): H / Shift+H when live notes are selected (else harmony keeps them), or Alt+H / Alt+Shift+H by
  preference; Ctrl+E; Enter / Esc in the popover.
- Engraving: marks get MEI ids `dm_<id>`, hairpins `dh_<id>` (`dh2_` for the second half of `<>`); our marks replace the
  automation/velocity-derived dynamics of articulations.js on that staff (its sfz accents stay).
- `SV.dynamics`: the pure core (`parseEntry`, `planEntry`, `levelModel`, `levelPoints`, `targetPoints`, `buildCurves`,
  `curveOps`, `planVelocities`, `thin`, …) plus `doc()`, `setDoc(d)`, `reload()`, `enter(text)`, `perform('preview'|
  'render', {fromBar, toBar, tracks}?)`, `stop()`, `open()`, `close()`, `profileFor(track)`, `liveOrigin()`, `prefs`.
- localStorage `scoreview.dynamics.prefs`: `shape` ('s'), `strength` (0.7), `variation` (true), `amount` (0.35),
  `velMarks` (true: a mark sets velocities), `velHairpins` (true since pv 2), `velNew` (true: new notes follow),
  `humanize` (4, velocity units, slider `#svdHuman`), `keys` ('sibelius' | 'alt'), `profiles` ({track: profile id}
  overrides; Auto = detected), `pv` (prefs version).
- Edit ops `curve*` (EditOps handler CURVE), endpoints `/api/curve`, `/api/marks`; `vel` ops for "both ways".

## Hooks
`transformScore`, `afterRender` (click boxes on our hairpins), `paperMouseDown` (before mouse.js: a press on our mark /
hairpin opens its popover), `keydown`, `liveData` ×2 (load the document per project; play start of a newly selected
clip). Reads `SV.libraryProfiles`, `SV.arrangement`, `SV.entry` (no keys in entry mode).

## Tests
`test/dynamics-test.mjs` (typing, placement, document, level model, shapes, thinning, variation, profiles, curves,
ops, velocities, engraving ids), `test/curve-player-test.mjs` (+ `test/java/CurveCheck.java`: the real CurvePlayer on a
fake transport and rig — write settings, touch, values, stop, loop, refusals, exit), `test/dynamics-e2e.mjs` (page vs
the mock: keys, popovers, reload, Render / Preview / Stop on Pocket Strings), `test/security-test.mjs` (`/api/marks`
guard), `test/protocol-test.mjs` (ops). Mock: `test/mock-curve.mjs` (`srv.curve`: `devices`, `missing`, `speed`,
`runs`, `written`, `marks`).

## Limits / not yet
- Launcher clips: dynamics live on the arranger timeline only (a generated .mid via `insertFile` is the planned route).
- MIDI CC targets (Spitfire Kontakt profile) are sent live with `Track.sendMidi`; Bitwig does not record them — marked
  experimental.
- Notes are matched to marks by arranger beat. A moved clip's marks follow it only after a Read shows the move (or, for
  marks entered at a guessed position, once the clip plays). Marks saved before `co`/`ck` existed never move.

## Docs
[library-profiles](library-profiles.md), docs/library-profiles.md (probe results), docs/wave2.md.
