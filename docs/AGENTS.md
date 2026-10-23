# Score View — guide for contributors and agents

Score View shows Bitwig Studio clips as standard music notation and edits them from the score.
The user is a composer who writes in notation (Sibelius/Finale/Dorico background) and uses Bitwig 6.1 with
large orchestral libraries (BBC Symphony Orchestra with Bitwig articulation maps).

**How a project gets into Score View (one way in).** Score View shows the Bitwig project that is open. Click any clip
in Bitwig's Arranger, press **⟳ Read project** once; the read is stored per project and kept current from then on
(features/arrangement.js: the mirror, Refresh N tracks, listening while playing). There is no "open a file" path: a
DAWproject export is no longer a way to open a score (its parser, web/dawproject.js, stays for the test fixtures, the
hidden `#fileInput` the suites use, and later "import extras from an export" — automation, plug-in states).
Before a read, Score view shows the project's instrument tracks with the selected clip live.

## Architecture

```
Bitwig Studio ──(Java extension API)──> src/claude/scoreview/ScoreViewExtension.java
                                         │  HTTP server on 127.0.0.1:8765 (serves web/ from the jar)
                                         ▼
                         web/index.html + web/core/*.js (UI shell, Bitwig polling, selection, editing)
                         web/style.css                 (core styles, --sv-* design tokens)
                         web/score.js                  (notes -> MEI: quantize, voices, ties, beams, spelling)
                         web/dawproject.js             (DAWproject file -> parts; test fixtures only)
                         web/align.js                  (places the live clip in the arrangement by note matching)
                         web/features/*.js             (feature modules, one per feature area)
                         Verovio (vendor/verovio-toolkit-wasm.js) engraves MEI -> SVG (big scores: in Web Workers,
                         core/engrave-worker.js, one system per chunk)
```

* **Rendering is model-now, SVG-when-ready** (core/render.js). `SV.render()` builds the score model synchronously:
  `SV.state.render` (timeline, bySrc/bySvg, staves, score, mei, …) is current when it returns. The engraving (Verovio →
  SVG) is synchronous too when it is small (≤ ~150 bars × staves not cached, e.g. Clip view) or cached; a big one runs in
  **Web Workers** (core/engrave.js + core/engrave-worker.js, up to 3, each with its own Verovio; every job starts from
  `resetOptions()`, since Verovio's `setOptions` merges and a chunk's options would leak into the next job) while the paper keeps
  the previous SVG. `state.render.drawn` turns true when the new SVG is on the paper; `await SV.rendered()` waits for it
  (tests: after anything that renders a big score, before reading `#paper`). The **afterRender** hooks run when it is
  drawn — for a big score also once when the systems in view are in and at most every 400 ms while chunks in or near
  the view arrive (not for off-screen ones), so
  **afterRender hooks must be idempotent**: kept engravings keep what a hook added (mark what you decorated, e.g.
  `.svpb-boxed`, `.svi-bound`, `data-sv-rotated`, or remove and rebuild your own overlays). A newer render drops the
  older one's waiting work (latest wins); hit tests (`SV.hitTest`, `SV.noteAt`, clicks) use the render the paper shows
  (`SV.core.shownRender()`) until the new one is drawn.
* **Chunked engraving** (core/chunks.js, `window.ScoreChunks`, pure / Node-testable): Page layout from ~400 bars × staves
  engraves one system per chunk: `#paper > .svc[data-key][data-a][data-b]` (0-based bar range) each holding its own
  `<svg>`; the SVG strings are cached by a hash of the chunk's MEI + options, so an edit re-engraves one chunk and every
  other chunk keeps its DOM node. System breaks are planned before engraving from bar-width features
  (`built.chunks.bars`, a linear model fitted to Verovio's widths) and are sticky (the previous plan's ranges are kept
  while they fit). Each chunk is `built.chunks.mei(a, b, {abbr, hide, system})` (score.js): the clefs, keys and meter in
  force at bar a in its scoreDef (time signature hidden unless it changes there), short staff names after the first
  system, staves with nothing to play left out (Hide empty staves; `ScoreChunks.hidden`), a `<sb/>` + Verovio breaks
  'encoded' so it is exactly one justified system; ties / slurs / hairpins / octave lines cut by a chunk edge run to the
  end of its last bar and continue from tstamp 0 in the next (tuplets and beams never cross a bar line). Ids stay
  unique across chunks (`n<srcId>`, `m<N>`, `m<N>s<staff>`). Chunks in view are engraved first; the others are
  placeholders (`.svc-wait`; `.svc-stale` = the previous engraving of the same bars) filled nearest first
  (IntersectionObserver moves scrolled-to ones up); off-screen chunks skip style / layout / paint
  (`content-visibility: auto`, sized by the SVG's height). Line layout and small scores are one document (one `.svc`).
  localStorage `scoreview.chunked = false` → one document always; `scoreview.engraveWorker = false` → no workers (the
  same queue on the main thread, one chunk per task). `SV.core.engrave.stats()` counts what was engraved where.
* **Render cost** (`SV.state.render.times` = ms of the last render: buildMEI, plan (chunk plan + MEI + hashes), engrave
  (on the main thread), dom, afterRender (all runs), chunks / engraved (how many engravings, how many were not cached),
  visible (until the systems in view were on the paper), total; `node tools/perf-bench.mjs` measures cold / cached /
  edit / live-edit / Clip view on the Mega Man 2 crawl).
  Verovio draws each glyph as `<use xlink:href="#E0A4-…">` of a `<symbol>`; `web/core/svg-inline.js`
  (`window.SvgInline.inlineGlyphs(svg)`, pure string code, Node-testable) rewrites them into inline `<path>`s before the
  SVG goes into the page (and into print pages): thousands of `<use>` shadow trees made the style recalc after
  `innerHTML` take seconds. So **#paper has no `<use>`/`<symbol>`**: a glyph is a `<path transform="translate(x,y)
  scale(…) scale(1,-1)" d=…>` inside its `g.notehead`/`g.rest`/`g.clef`/… (never a direct child of `g.staff`, so
  `g.staff > path` is still the staff lines). localStorage `scoreview.inlineGlyphs = false` turns it off.
  afterRender hooks: measure everything first, then write (append / setAttribute); a read after a write forces a
  layout of the whole score each time. Measuring a chunk the browser skips (off-screen, `content-visibility: auto`)
  forces its style and layout too: `SV.core.skipped(node)` says whether node's chunk is skipped, and
  `SV.core.whenShown(node, fn)` runs fn once it comes into view (sections.js group labels and playback.js solo / mute
  zones decorate off-screen systems that way; harmony.js still measures the whole paper when its colours are on).

* Two **views** (`state.view`, the Clip / Score buttons) set the engine's `mode`, `range` and `trackMode`
  (core/ui.js `applyView`; print / export may change range and trackMode for one render):
  * **Clip view**: the clip selected in Bitwig (arranger or launcher), live (mode clip). With other tracks **pinned**
    (📌 toggle, P, or Instruments ▾), their staves too, in the selected clip's bars widened to the overlapping clips:
    internally mode score, range clip, trackMode pinned (their notes come from the last Read).
  * **Score view**: bar 1 to the end of the last clip (mode score, range all) with all instruments (default) or only
    the pinned ones (`state.scoreShow`, Instruments ▾ or the section bar's Full / Pinned); the Read is the
    base for the other tracks; the selected clip is overlaid live and is the only editable material.
  A Read keeps the view and the shown tracks. `SV.core.setPinned(name, on)` / `.clearPins()` / `.setScoreShow('all'|'pinned')`.

### Bitwig API limits (important)
* An extension can read/write notes of **one selected clip** (cursor clip). It cannot read other arranger
  clips. Launcher clips can be read per track via several cursor tracks.
* Bitwig reports only **one** selected track.
* Notes are addressed by grid step: `x` (step, `stepsPerBeat` = 24 → 32nds and triplets), `y` (MIDI key), `ch`.
* `Application.getActions()` exposes ~780 actions (`GET /api/actions`), e.g. "Select Next Item".

### HTTP API (extension and mock)
* Request rules (`HttpGuard.java`, mirrored by `test/mock-server.mjs`): `Host` must be `127.0.0.1|localhost|[::1]:<port>`;
  any `Origin` sent must be our own and `Sec-Fetch-Site: cross-site` is refused outside a top-level navigation (403,
  GETs included, so a foreign page cannot hold the long-polls); anything but GET/HEAD needs `X-ScoreView: 1`; OPTIONS
  is always 403 (no CORS); `/api/edit` (and any path under that prefix) is POST only (405). The page adds the header to every same-origin `/api/*` fetch (wrapper in `web/core/guard.js`, the page's first script);
  Node scripts calling the extension must send it themselves. `withPage` fails a test when the mock refused a request.
* `GET /api/notes?v=N` — long poll; returns when the version differs from N:
  `{ v, source, exists, track, stepsPerBeat, length, playStart, loop, loopStart, loopLength, settled, changedMs, selPlayStart,
     num, den, tracks:[{name, index, group, sel, solo, mute}], markers:[{name, beat}],
     notes:[{ch, x, y, d (beats), vel (0-127), sel}], devices:{track, list:[{index, name, on}]} }`
  `devices` = the selected track's top-level devices (first 8; features/articulations.js warns about articulation-map
  Note FX, which re-send their own keyswitch before every note).
  **Timing fields** (`LiveSync.java`): `settled` (true once nothing changed for 100 ms, 200 ms after a burst that looks
  like a clip switch), `changedMs` (ms since the last change), `selPlayStart` (the play start marker in arranger beats,
  `null` for the launcher; Bitwig moves it to a selected arranger clip, so in a settled snapshot it is that clip's
  position unless the user moved the marker since).
  **Timing model.** Bitwig reports a clip switch as a burst: the old notes go and the new ones arrive one NoteStep
  callback at a time, the track name follows a moment later, the play start marker a little after that. Observer
  callbacks only mark the data changed; `flush()` and a 20 ms control-thread tick publish at most one version per
  20 ms (so edits still show within a tick, a burst costs a handful of versions, each `settled: false`), and one more
  version with `settled: true` once the quiet window has passed. A burst counts as a clip switch (200 ms window) when
  another track gets selected, the clip's existence / track name / play range / loop changes, or notes are both
  removed and added beyond a single move (> 3 changes). A NoteStep callback changes the notes and marks them changed
  under the same lock the JSON is built under, so no snapshot holds part of a burst with `settled: true`. While the
  crawler, the clip navigator or the Developer-mode `clipStepProbe` walks clips nothing is published or settled (and
  the crawl and goto / gotoStay refuse while the probe runs). The page (core/net.js) runs `hooks.liveSettled` and remembers an edited clip's
  overlay only on a settled snapshot and takes the clip position for its last-resort placement from `selPlayStart`
  there (core/sources.js `refreshPlayStartGuess`; a later settled value within 1.5 s of the switch corrects it). An
  extension without the fields (and the mock with `settle: false`): the page waits `SV.core.SETTLE_MS` (200 ms) of
  quiet itself and fetches `/api/transport` 400 ms after a switch. The windows are constants in `LiveSync.java`
  (verify on the live Bitwig: switching between clips of different tracks must never put one clip's notes on another
  track's staff in Score view, also with large clips).
  `tracks[].index` is the track's position in the extension's flat 128-track bank (the id used by `solo`/`mute`);
  `markers` are the arranger cue markers (beat = arranger beats), up to 128.
* `GET /api/play` — `{ playing, step (clip step or -1), pos (arranger beats), tempo,
   loop:{on, start, length} (arranger loop, beats), metronome }`
* `GET /api/actions` — `[{ id, name, category }]`
* `GET /api/midi?since=N` — long poll (15 s) of note events sounding on Bitwig's selected track (the MIDI bridge,
  see docs/midi-bridge.md): `{ seq, track, monitoring, playing, events:[{seq, t (ms), type:'on'|'off', key, vel, playing}] }`,
  events with seq > N from a ring of 256; without `since` it returns at once with the current seq. Mock: `srv.pushMidi(events)`.
* `POST /api/edit` — body = one op per line:
  `move ch x y dx dy` · `del ch x y` · `add ch x y vel(0-127) durBeats` · `dur ch x y beats` ·
  `vel ch x y 0..1` · `select ch x y add(0/1)` · `audition key` · `undo` · `redo` · `source arranger|launcher`.
  Transport (beats are arranger beats): `play` · `stop` · `toggle` · `playFrom beats` (sets play start + position, then
  plays) · `position beats` · `loop startBeats lengthBeats` (sets and enables the arranger loop) · `loopOff` ·
  `solo trackIndex 0|1` · `mute trackIndex 0|1` · `deviceOn deviceIndex 0|1` (a device of the selected track, the
  `devices.list` index) · `metronome 0|1`.
* `GET /api/listen?since=N` — the notes Bitwig reports as played on every track of the 128-track bank
  (`Channel.addNoteObserver`, NoteListen.java, ring of 512 per track), each stamped with the arranger beat (last
  `playPosition()` report moved on by the time since it at the tempo, ≤ 0.25 beat, wrapped at an arranger loop end):
  `{ seq, playing, pos, tracks:[{index, name, events:[[seq, on 1|0, key, vel, beat, t (ms), playing 1|0]]}] }`, only
  tracks with events seq > N; without `since` (or since > seq) no events, just the current seq. Returns at once;
  read-only. Before or after Note FX: unknown (test/listen-probe.mjs). Mock: plays its arrangement (`srv.listen`).
* `GET /api/meter` — each track's peak output level (0..127) since the previous call (read-only; `tools/meter-probe.mjs`
  plays from a beat and samples it, e.g. to measure how a library answers velocity, controls or keyswitch timing).
* The DAWproject parser also returns `markers:[{beat, name}]` (arrangement markers), `bpm`, and from the arrangement's
  `<TempoAutomation>` / `<TimeSignatureAutomation>` (`<TimeSignaturePoint time numerator denominator>`): `tempo` (bpm at
  the start), `tempoChanges:[{beat, bpm, endBeat?}]` (hold points → sudden, linear ramps → gradual, contiguous ramps
  merged) and `timeSigChanges:[{beat, num, den}]` (a point at 0 sets `timeSig`); parts carry
  `notes[].vel` (0..1), `automation: { dynamics?, expression?, cc:{[n]: points} }` (instrument "Dynamics"/"Expression"
  parameter lanes and MIDI CC lanes, points `[{t (beats), v (0..1)}]`), `plugin: {name, state}`, and — in a full export
  with `plugins/` — `articulations: {key: name}` + `articulationSource` read from BBC SO / Spitfire plugin states.
  New ops are added in `ScoreViewExtension.applyEdit` (runs on Bitwig's control thread) **and** in the op table
  `EditOps.java` (name, min/max args, handler, Developer-mode flag; unknown ops and too few arguments are refused and
  logged) **and** in the mock's `MOCK_OPS`; then regenerate `test/fixtures/ops.txt` with
  `node test/protocol-test.mjs --write`. `test/protocol-test.mjs` fails until all three agree. The mock records refused
  ops in `srv.refusedOps` (option `developerMode`).
* Render dynamics (CurvePlayer.java, docs/features/dynamics.md): ops `curveClear` · `curveSet id track(URL-encoded)
  profile target beat:value,…` · `curvePreview from to` · `curveRender from to` · `curveStop`; `GET /api/curve` (state,
  progress, message, run counter, device names per track). `GET/POST /api/marks`: the dynamics document (JSON object ≤ 65535 chars,
  kept in the project's DocumentState). Mock: `test/mock-curve.mjs` (`srv.curve`).
* If the HTTP port is busy, the extension shows a popup naming the port and where to change it (Settings > Controllers
  > Score View > HTTP port, then switch Score View off and on). The page uses relative URLs and `location.host`.

### New Score wizard (web/features/wizard.js, NewScoreWizard.java, docs/wizard.md)
* `POST /api/wizard` (plan text: `option` (`pos`, `tempo`, `meter=n/d`) / `marker` (`name`, `bar`) / `group` / `track` / `swap` lines of tab-separated `key=value`, `dev=kind:id|label`
  repeated in insertion order), `POST /api/wizard?cancel` (or op `wizardCancel`), `GET /api/wizard` → `{ state: idle|queued|
  running|done|error|cancelled, kind, message, step, steps, waitFocus ("" or the group waiting for a click into Bitwig), tracks:[{name, group, created, grouped, groupMsg, devices:[{ok, text}]}],
  groups, settings:[{ok, text}], errors, notes }`, `GET /api/wizard?caps` → the Group/header-focus actions found. Creates tracks, groups (Bitwig's
  "Group" action, verified via parent-track proxies), colours, Note FX + instrument devices; "Swap library…" in the
  instrument picker swaps one track's instrument. Optional starter settings set the tempo, time signature and named cue markers.
  Templates (10 in three sections, each with a brief and per-row patch hints; retired ones in docs/archive), categories, palette, plan and the
  starter sheet (`SV.wizard.sheet()`, toolbar **Brief**): `features/wizard-templates.js` (pure);
  installed plug-ins: `features/wizard-plugins.js`, generated by `node tools/scan-plugins.mjs` from Bitwig's plug-in cache.
* Mock: `test/mock-wizard.mjs` (`srv.wizard.plans`, `.swaps`, `.groupAction = false`, `.stepMs`, `.playing = true` skips markers; device ids containing
  `FAIL` / paths containing `MISSING` fail). Tests: `node test/wizard-test.mjs`, `PORT=… node test/wizard-e2e.mjs`.

### Live arrangement crawl (web/features/arrangement.js, ArrangementCrawler.java)
* `POST /api/edit` op `crawl` (or `crawl exact`) walks every arranger clip with Bitwig's selection actions
  (Move cursor to first/next lane, Select first/next item); `crawlCancel` stops it. Requires a clip to be
  selected in the arranger (that gives the timeline keyboard focus); refuses while playing. Collapsed groups are
  opened for the crawl and closed again; selection, play start and loop are restored. When focus is in a clip's notes
  (notes selected, e.g. from Score View) the actions walk notes: "Select next item" lands inside the item just read
  with the same notes, so the crawl stops with an error (no result) and restores play start, loop and groups only.
* Positions come from the play start marker (Bitwig moves it to the selection). Looping clips (and every clip with `exact`, only used by test/crawl-run.mjs --exact) are measured:
  visible length with Loop Selection and undoes that change immediately (verified; on doubt: redo + manual restore).
* `GET /api/crawl` → `{ state: idle|running|done|error, message, lane, lanes, clips, stepsPerBeat,
  tracks:[{name, group}] (when done), result:[{lane, track, start, playStart, playStop, loop, loopStart, loopLength,
  length? (exact only), notes:[[ch, x, y, durBeats, vel]]}] (when done), timing: safe|fast, skipLanes, skipped (lanes
  stepped past), laneOrder: unknown|verified|differs, rewalked, ms (elapsed / total) }`.
* **Speed** (perf/arrangement-listen; NOT verified live yet, so both default to the old walk): op words before
  `tracks` are flags, `crawl [exact] [safe|fast] [tracks …]`; `safe` / `fast` override the preferences for one read
  (test/crawl-run.mjs `--safe` / `--fast`, compared with test/crawl-compare.mjs). Preferences > Score View:
  * "Read arrangement timing" = Safe (fixed waits, default) | Fast (adaptive waits, experimental).
    `ArrangementCrawler.SAFE` = quiet 80 / min 110 / max 1500 / stable 120 / recheck 300 ms (the constants every read
    used before). `FAST` = quiet 40 / min 50 / stable 50 / lane move 40 ms: after an action the walk goes on once
    something changed, Bitwig called the extension's `flush()` after that change (`ScoreViewExtension.flush` records
    the time) and 40 ms passed quietly; the double read stays (50 ms apart) but only for an expected reading (the
    next clip of the lane's track, or the first clip of the track the bank predicts for the lane), else SAFE.stable;
    nothing changed (end of a lane) keeps SAFE's waits and the 300 ms recheck.
  * "Read arrangement: step past audio and effect lanes (experimental)" (default off): the bank (`LaneInfo`: name,
    group, `canHoldNoteData`, `trackType`, groups opened) predicts lane i = flat bank entry i; lanes whose track
    cannot hold notes (not groups) get only "Move cursor to next lane". Every clip seen for the first time checks
    the prediction (`laneOrder`); a mismatch stops skipping, and when lanes were already stepped past the walk starts
    again from the first lane without skipping (`rewalked`; clips already read are not read twice).
* Page wake-ups are suppressed while crawling. Debug ops: `act <actionId>`, `clipNext`/`clipPrev`, `selectTrack`,
  `moveTrackAfter`/`moveTrackBefore`, `clipStepProbe [n]` (ClipStepProbe.java: `CursorClip.selectNext()` n times from
  the VALID selected clip, then `selectPrevious()` n times, play start restored; result in `/api/transport` `probe`;
  test/clip-step-probe.mjs; never used by the crawl) (refused unless Bitwig Preferences > Score View > Developer mode is
  on; the page never sends them), `GET /api/transport` (read-only, always on).
* `crawlToScore(crawl)` (node-testable) builds the Score-mode base; `SV.setBase(score)` installs it. The raw crawl
  stays in `SV.state.crawl`; `clipEnd(clip, next)` gives a clip's visible end. `updateScore(score, crawl, tracks)`
  rebuilds only those tracks' parts (full rebuild when the set of tracks changed).
* **Targeted read**: op `crawl tracks <URL-encoded names...>` reads only those tracks. Lane numbers do not follow the
  track list (groups and other lanes sit in between), so on each lane the crawler selects the first item to learn
  whose lane it is, walks it only for a wanted track, and stops once all are read (and the original clip's lane was
  seen, for the restore). `/api/crawl` then adds `subset` (the names), `found` (tracks read) and `complete` (every lane
  that could hold one was looked at; false when cancelled): a wanted track not found in a complete walk has no clips.
* **Stored read** (ArrangementMirror.java): `GET /api/arrangement` → `{ project, cache (folder), doc }`, doc = the
  stored JSON of the open project or null; `POST /api/arrangement?project=<URL-encoded>` replaces it (JSON object ≤
  8 000 000 chars; 409 when `project` is not the open project, 400/413 for a bad or huge body; X-ScoreView as usual).
  Kept in memory per project name and in `Documents/Bitwig Studio/Score View Cache/<cleaned name>.json` (OneDrive
  Documents or ~/Bitwig Studio when that is where Bitwig's folder is; never the project folder), written off-thread.
  A finished full crawl is stored by the extension itself. doc = `{ v: 1, project, readAt, savedAt, tracksAtRead:
  [{name}], crawl }` (features/arrangement-mirror.js `makeDoc`).
* **Mirror** (features/arrangement-mirror.js, pure): the page restores the stored read on load and when a project opens
  (newest of the extension's and IndexedDB's copy; not over a fixture loaded by a test, nor when under half of today's
  tracks were in it). Once the selected arranger clip's data
  has been quiet `HARVEST_QUIET_MS` (300 ms) and the play start marker reads the same `CONFIRM_MS` (150 ms) later, the
  clip is upserted at the marker's beat (`placeSelected`: or where a gotoStay left it per `/api/nav stayed`; a marker
  that moved while the clip did not, a changed clip after the marker moved, and mostly new notes on the same track
  under an unmoved marker are reported as unsure, not guessed — except the same clip with every note kept in pitch and
  moved at most half a beat (`nudged`: Bitwig's quantize / humanize), which is this clip edited; `obs.edited` = Score View sent edits since the last
  call, `state.lastEditMs`), only its part is rebuilt (`SV.updateBase`) and the
  mirror is saved (1 s debounce). The same content at a new start makes the old clip `suspect: true`; so does a clip
  starting inside the new one. When the extension sends `settled: true` / `selPlayStart` in `/api/notes`
  (LiveSync.java) the page harvests at once from that snapshot: no quiet wait, no second look and no `/api/transport`
  fetch (`/api/nav` is still asked). A harvested clip replaces its edited-clip overlay (`SV.updateBase` drop): the
  read itself now holds the edit. The out-of-date dot lists only what the mirror could
  not fix (track list changes, suspects, unplaced or changed clips) and its popover offers Refresh N tracks.
* **Listen while playing** (features/arrangement-listen.js, pure; `GET /api/listen`): while Score view plays with a
  read, the page polls `/api/listen` (250 ms; once a second when stopped) and compares note-on onsets per track and
  bar with the read (keys ≥ C1 only, ±0.15 beat, a bar judged 0.3 beat after its end). The first 4 bars with notes
  after a read set each track's baseline (median match share); baseline < 0.6 = its Note FX change its output:
  ignored. A clean track (≥ 0.95) disagrees on any unmatched onset, others 0.3 below their baseline; a track is
  "changed at bar N" when the same bar disagrees on two hearings, or two neighbouring bars are far off in one pass.
  Not judged: the selected clip's track, edited, group, muted / soloed-out tracks, and tracks silent so far in the
  pass. It feeds the dot's reasons and Refresh N tracks (and the auto-refresh); a re-read or harvest of a track clears
  it. Preference `scoreview.arrangement.listen` (default on; `#svarListen` in the dot's popover); only listens.

### Writing into other clips (ClipNavigator.java, web/features/orchestrate.js — docs/orchestration.md)
* Op `goto <lane> <startBeats> <URL-encoded track>` selects that arranger clip (crawler actions); `gotoHome [lane]`
  returns to the clip selected before the first goto and ends the session; `navCancel` aborts. While a goto runs the
  edit queue waits; after a failed goto the following ops are dropped until the next goto/gotoHome. `GET /api/nav` →
  `{state, message, session, batches, dropped, lastTarget, home, results, stayed}`. The page sends one batch per target
  track: `goto … / add … / gotoHome`.
* Op `gotoStay <lane> <startBeats> <URL-encoded track>` navigates like `goto` and then ends the session on that clip (no
  return home; groups opened for it are collapsed again). `/api/nav` reports `stayed: {track, start}` and
  `lastTarget.stay`; a stay batch is counted in `batches` only once the edit queue behind it is empty, so `batches`
  rising with `session` false means its edits have landed (or were dropped). A failed or cancelled `gotoStay` goes
  home and drops the edits after it. Preference "Play start after pasting into another clip": leave it where it was
  (default) or move it to the pasted clip. features/passage.js sends it (copy/paste between staves, click a note to
  make its clip live); after a stay with the default the play start is no longer on the selected clip, so an
  Orchestrate write asks for the clip to be clicked again (its home check). Orchestrate shortcuts: Alt+X explode, Alt+B double, Alt+U reduce.
* Mock: `startMockServer({ arrangement: { tracks, home, clips:[{lane, track, start, playStart, playStop, notes}] } })`
  emulates the crawl (`/api/crawl`, also `crawl tracks …`), goto/gotoHome (`/api/nav`, `srv.nav`, `srv.arrangement`) and
  `/api/transport`; `srv.selectClip(i)` = the user clicks clip i (play start moves to it). `/api/arrangement`: `srv.mirror`
  (project → JSON text), `srv.mirrorPosts`; option `project` (default 'Mock'), `srv.setProject(name)` (also in
  `/api/notes`); option `mirror: false` answers 404 like an extension without the endpoint.

### score.js input model (`ScoreBuilder.buildMEI(score, opts)`)
```
score = { title, timeSig:{num,den}, keyFifths (null = auto-detect), lengthBeats, measureOffset,
          parts:[{ name, label?, grand?, clef? (['C',3] | {shape,line,dis,disPlace}),
                   transpose? (written = sounding + semitones), group?, measureOverrides?,
                   altClefs?:[clef] (clefs it may change to mid-staff), ottava?: {up, down} (octaves) | false,
                   notes:[{id, start, dur, pitch, color?, artic?, trem?, trill?}],
                   slurs?:[{start, end}], marks?:[{beat, text, kind:'dir'|'dynam', italic?}], hairpins?:[{start, end, form:'cres'|'dim'}] }],
          directions?:[{ beat, text, kind:'reh'|'tempo'|'dir', staff? }],
          groupLabels?, pickupBeats?,
          timeSigChanges?:[{beat, num, den}], keyChanges?:[{beat, fifths}] (concert),
          tempo? (quarter bpm at the start), tempoChanges?:[{beat, bpm, endBeat?}], offsetBeats? }
opts  = { grid (units of TPQ = 8 → 1 = 32nd, 2 = 16th, 4 = 8th), simplify, tuplets: 'auto'|'off',
          measureOverrides: { [measureNumber]: { grid, tuplets: 'auto'|'off'|'triplet', voices: 'auto'|'single', simplify } },
          clefChanges (default true), ottava (default true) }
returns { mei, keyFifths, timeline:[{svgId, srcId, start, end}], measureBeats, measures, measureOffset,
          staves:[{n, part, clef, fifths, transpose, clefs:[{beat, clef}], ottavas:[{start, end, shift}]}], pickupBeats,
          measureStarts (beats), measureLengths (beats), meters:[{measure, beat, num, den}], keyChanges:[{measure, beat, fifths}],
          offsetBeats, tuplets (count),
          chunks: { mei(a, b, {abbr, hide, system}) (bars a..b, 0-based, as their own document), bars (width features),
                    keyAcc(m), parts (staff numbers per part), labels, filled(n, a, b) } }   (core/chunks.js plans with it)
```
**Meters, keys, tempo, registers (issue #12).** All beats in the input are in the score's own time base (0 = first
rendered bar); everything returned (timeline, measureStarts, clefs, ottavas, meters) is absolute: `offsetBeats` (default
`measureOffset × measureBeats`) is added. `measureBeats` is the *first* meter's bar length — with `timeSigChanges` bars
differ, so use `measureStarts`/`measureLengths` or the helpers `ScoreBuilder.measureAt(render, beat)` → measure number,
`measureSpan(render, n)` → `{start, beats}`, `clefAt(staff, beat)`, `ottavaAt(staff, beat)` (+1 = 8va: sounding =
written + 12). The page core uses them for the playhead bar and `SV.hitTest` (pitch includes the ottava; `diatonic` is the
written staff position). Still assuming one bar length: harmony.js, playback.js (`barBeats`), entry.js
(`measureBeats()`), articulations.js and core/sources.js `currentScore`'s Clip-bars cut (features/notation.js re-bases it).
* A meter change inside a bar ends that bar early (`metcon="false"`), like the DAW. Changes emit
  `<scoreDef meter.count meter.unit>` between measures; key changes snap to the nearest bar line and emit
  `<scoreDef keysig>` (+ `<staffDef n keysig>` for transposed / unkeyed staves).
* Clef changes: per staff the clef is chosen per *phrase unit* (units split at bar lines nothing sounds across and at
  onsets after ≥ 1 beat of rest) by a Viterbi pass over ledger-line cost, a preference for the part's own clef and a
  switch penalty (hysteresis: short excursions keep the clef). Candidates: `part.clef` + `part.altClefs`
  (instruments.js fills these: cello/bassoon/trombones tenor, cello treble, viola treble, horn bass); a part
  without `part.clef` may switch treble ↔ bass (tenor first for cello/bassoon/trombone names); grand staves G ↔ F.
  A change in rests goes to the last bar line in the rest, as a `<clef>` at the end of the previous bar's layer 1
  (printed before the bar line); otherwise into layer 1 right before the phrase.
* Ottava lines on top of the clefs, same units and method (only from 4+ ledger lines); `part.ottava` {up, down}
  limits them (instruments.js: violin/flute/piccolo/guitar/mallets 8va, keyboards and harp 8va/15ma/8vb, brass,
  voices and low strings none); default by clef: treble 8va/15ma, bass 8vb. Emits `<octave dis dis.place startid
  endid>`; notes under it are written with `@oct` shifted and the real octave in `@oct.ges`.
* Tempo: `♩ = 164` (`<tempo mm mm.unit midi.bpm>`; `♩. =` in compound meters, `𝅗𝅥 =` in x/2) at the start and at each
  change; a gradual change (`endBeat`, ≥ 1 beat) prints italic "accel."/"rit." with a dashed line to `endBeat`, then
  the new mark there. Positions snap to the beat and to a bar line within a beat. Marks go above staff 1.
`part.group` (optional): consecutive parts with the same group share a bracket (nested `<staffGrp symbol="bracket"
bar.thru="true">`; barlines joined inside it; a group of one part gets no bracket; grand-staff braces nest inside).
Without any group the whole score keeps one outer bracket. `score.groupLabels: true` prints each bracket's group name
(bold italic; features/sections.js turns it vertical left of the staff names). sections.js sets both (orchestral family
in score order, Bitwig group in Bitwig order). Note: parsed DAWproject parts also carry `group` (the Bitwig group), but
the page core does not copy it into the engraved score; only transformScore hooks set it.

Notation extras (all optional, set by features/articulations.js): `note.artic` = MEI artic list (`stacc stacciss spicc ten
acc marc snap harm`, on the attack only), `note.trem` = unmeasured tremolo strokes (`<bTrem>` + `@stem.mod`, minus the
value's own beams), `note.trill` = upper-note interval in semitones (`<trill>`, `@accidupper` from the key, extender on
long notes); `part.slurs` (note ids → `<slur startid endid>`), `part.marks` (`dir` → italic `<dir>` above, `dynam` →
`<dynam>` below) and `part.hairpins` (beats → `<hairpin tstamp tstamp2>`) go on the part's first staff.
The page core (core/sources.js) also passes `part.keyswitches`: every note below C1 of that track (including ones before the shown range, with
negative starts), whatever "Hide keyswitches" says; `part.notes` keeps them only when hiding is off.

Optional extras: `score.pickupBeats` (bar 1 is an incomplete pickup bar, MEI `metcon="false"`) and
`part.measureOverrides` (same shape as `opts.measureOverrides`, for one part; the rhythm module's Q readings use it).
Internally score.js works at 48 ticks per quarter (`ScoreBuilder.TICKS_PER_QUARTER`) so 8th/16th/quarter-note
triplets are exact; `ScoreBuilder.TPQ` stays 8 because it is the unit of `grid`.
SVG element ids: notes `n<srcId>` (`-c<k>` for tied continuation pieces), measures `m<N>`, staves `m<N>s<staff>`.
Live note ids are `L<ch>_<x>_<y>`; anything else is read-only (another clip: click it in Bitwig to edit it).

### Feature hook API (`window.SV`, defined in web/core/*.js)
Feature modules live in `web/features/<name>.js` (already included by index.html) and must not edit
the page core (`web/core/*.js`, file map in `core/base.js`) unless a hook is genuinely missing (then add the smallest
possible hook and say so). Hooks run in registration order: `<script>` order in index.html, then push order inside a
module (`unshift` puts a handler first; controller.js and orchestrate.js do this for their panel-closing Esc).
`SV.hookOrder()` lists which script registered each hook; `test/hook-order-e2e.mjs` pins the order, so a deliberate
reorder updates its `EXPECTED` table in the same commit.
```
SV.hooks.transformScore.push((score, ctx) => score)   // edit parts/notes/directions before engraving
SV.hooks.buildOptions.push((buildOpts, verovioOpts, score) => {})
SV.hooks.afterRender.push(render => {})               // render = state.render (timeline, staves, score, ...), once its SVG
                                                      // is on the paper; may run again for the same render (chunks of a
                                                      // big score arriving): be idempotent
SV.hooks.keydown.push(e => true /* handled */)        // runs before built-in shortcuts
SV.hooks.noteClick.push((timelineEntry, e) => true)
SV.hooks.paperClick.push((e, hit) => true)            // hit = SV.hitTest(e): {measure, staff, part, beat, diatonic, pitch}
SV.hooks.paperMouseDown.push((e, noteEl) => true)     // any press on the paper, before the built-in click (features/mouse.js
                                                      // uses it for drags; SV.clickPaper(e) runs the built-in click later)
SV.hooks.liveData.push(d => {})                       // each update from Bitwig
SV.hooks.liveSettled.push(d => {})                    // on the snapshot the extension marks settled (/api/notes settled;
                                                      // else after SV.core.SETTLE_MS = 200 ms of quiet). After a clip
                                                      // switch Bitwig swaps notes before it reports the new track: act
                                                      // on settled data (SV.core.liveSettledNow() tells)
SV.hooks.play.push(p => {})                           // ~20 Hz transport feed
SV.hooks.visibleTracks.push((shown, allNames) => set) // score mode: which tracks to show; return a Set to override
                                                      // (first Set wins), undefined to keep the pin/all choice
SV.state  SV.render() (renders now: the model at once, the SVG at once or from the workers)  SV.rendered() (Promise of
  SV.state.render once drawn)  SV.requestRender() (at most one render per animation frame; prefer it for
  reactions to events)  SV.geom.rect(el)/.rects(els)/.invalidate() (#paper boxes cached per render; call invalidate()
  after a geometry change made only through CSS classes)  SV.hookOrder()
SV.send([ops])  SV.flash(msg, {kind: 'info'|'ok'|'warn'|'err', ms}?)  SV.liveNotes()  SV.currentTrack()
  (flash fires window 'sv-flash' {msg, kind, ms}; features/toasts.js stacks and keeps the history: SV.toasts)
SV.addToolbar(htmlOrEl, {cluster, order}?)  SV.addHelp(html)  SV.addStyle(css)  SV.isLive(id)  SV.parseId(id)
SV.renderTrackList()  SV.cycleAlign(±1)               // refresh the 📌 Pin toggle · step through clip placements
SV.keymap.get()/.set('scoreview'|'sibelius'|'dorico'|'classic')/.list()   (core/keyboard.js, View ▾ > Keys, saved as
  scoreview.keys; the arrow keys are registered per layout. Score View: ←→ note, Shift+←→ extend, Ctrl+←→ bar, Alt+←→
  move by the grid, Shift+Alt+←→ length, ↑↓ scale step, Alt+↑↓ semitone, Ctrl+↑↓ octave; Tab / Shift+Tab always step)
  SV.core.extendSelection(dir) / .stepBar(dir) / .stepSelection(dir)
Score mode bars and staves (core/sources.js): Whole song = bar 1 to the end of the last clip (Read clip ends, the live
  clip, remembered edited clips). View ▾ > Hide unused instruments (#hideUnused, saved): parts with no notes and no Read
  clip in the shown bars are left out (the live track and pinned tracks stay); the status bar's All staves
  (state.showAllStaves, this session) overrides it and Hide empty staves.
SV.noteAt(e) -> g.note|null  SV.clickPaper(e)  SV.moveSelection(dxSteps, y => dy) -> blocked count (never lands on a
  note that stays put)  SV.gridBeats()  SV.expectIds(ids) (keep ids selected until Bitwig reports them)
SV.mouse.copy()/.paste()/.beatAt(clientX, clientY, staffN)/.beatPos(beat, staffN)   (features/mouse.js: drag pitch/time/
  length, marquee, Ctrl+C/X/V)
SV.addToolbar opts: cluster 'score'|'write'|'play'|'file'|'view'|'more' and order (lower first) place the group in the
  feature bar (features/layout.js; without opts it guesses from the ids). Pass both for anything new. The View cluster
  shows in View ▾, and in the compact header (default) the File cluster in File ▾.
SV.layout.header()/.setHeader('compact'|'classic')/.reveal(el) (opens the menu holding el)   SV.palette.open()/.commands()
  (Ctrl+K / Ctrl+J; finds buttons, checkboxes, select options, menu items and SV.shortcuts entries by themselves — give
  controls a visible label or title)   SV.statusbar.refresh()
SV.shortcuts.register({keys: 'Alt+S' | [...], owner, desc, when?: 'always'|'normal'|'entry'|<named context>, label?})
  .list() .conflicts()   (core/shortcuts.js; descriptive: keep your keydown hook, but register every key it takes —
  the help table is built from it and test/shortcuts-e2e.mjs fails on two owners of one key in one context)
  .remove(entry) drops an entry register() returned (re-register keys that follow a preference, e.g. the entry keypad layout)
SV.passage.selection() -> {staves, from, to}|null  .copy() .paste() .repeat() .copyTo(track, bar) .takesKey(k)  (features/
  passage.js: Sibelius passage selection, copy/paste between staves through goto … gotoStay)
SV.expectClip({track, start, ids, clip?})            // after a gotoStay: place that clip at `start`, select ids once it arrives
SV.arrangement.staleReasons() -> [why the last read may be out of date]  .liveClip() -> {clip, exact}|null (the crawled
  clip the selected one is)  .staleTracks() -> [tracks a targeted re-read would fix]  .refreshTracks(names) (op 'crawl
  tracks …', merged into the mirror)  .mirrorInfo() -> {project, readAt, restoredAt, unsure}  .unconfirmed(clips) -> the
  crawl clips not seen in Bitwig since the read was restored from storage (passage.js refuses to paste into them)
  .prefs.autoRefresh / .listen
  .listenInfo() -> {on, pass, running, tracks: {name: {baseline, ignored, flagged, bad}}}  (features/arrangement.js)
SV.setBase(score, mtime?, project?)  installs a new base (clears edited tracks, snapshots, placement)
SV.updateBase(score, {drop:[{track, start?}], place:{track, start}, render})   swaps in an updated version of the same base
  (core/project.js; arrangement.js after a harvest or re-read): keeps the read's age and edited tracks, drops those
  snapshots, places the live clip exactly (align.how 'mirror'), re-renders only when render (default true)
SV.dynamics.doc()/.setDoc(d)/.enter('p<f')/.perform('preview'|'render', {fromBar, toBar})/.stop() + pure levelModel/
  buildCurves/curveOps/planVelocities   SV.libraryProfiles.detect({pluginId, deviceNames, ...})/.valueAt(target, level)
  (features/dynamics.js, library-profiles.js + .json; docs/features/dynamics.md)
SV.scoreModel(overrides?)                            // score model as render() would engrave it (transformScore applied),
                                                      // without engraving; overrides e.g. {range:'all'} apply for the call
SV.import.parseFile/parseMidi/parseMusicXML/planImport   SV.print.open()/build()   SV.theme.get()/set('light'|'dark'|'bitwig')
  .chrome()/.setChrome('dark'|'light') .density()/.setDensity('normal'|'compact') (saved; no toolbar control yet)
SV.sections.scoreInfo(name) -> {id, family, bracket, rank}   SV.sections.scoreOrder(parts)   (features/sections.js)
SV.notation.settings() / .set({clefs, ottava, tempo, harmonyKeys})   (features/notation.js, "Notation ▾" menu;
  first transformScore hook: copies base.timeSigChanges/tempo/tempoChanges into the score and re-bases Clip bars on
  the real bar line; Clip mode takes the tempo from the play feed; "Key changes from harmony analysis" (default off)
  turns SV.harmony.analyze() key regions lasting ≥ 4 bars into score.keyChanges)
SV.articulations.mapFor(track) -> {map:{key:name}, source, preset, family}   .resolve/.annotate/.deriveDynamics/
  .planWriteBack (pure)   (features/articulations.js; keys Shift+S/U/I/T/A/N/R on selected live notes)
SV.entry.rawHooks.push((data, tMs, portName) => consumed)   SV.entry.actions.{dur,rest,undo,caret,...}  (features/entry.js)
  SV.entry.prefs.{layout, rowIntervals, legatoOverlap, shortLen, rangeWarn} .setPref(k, v) .articAt(step) -> 'legato'|'short'|null
  .addInterval(n, dir)   SV.motifs.addInterval(n, dir) (Alt+2–9 on a selection outside entry)
SV.controller.bindingsFor(port) / ._raw(data, port)   (features/controller.js: MIDI Learn, see docs/midi-bridge.md)
window 'sv-ready' event fires once Verovio is loaded and polling has started.
```
Keep modules self-contained: inject your own CSS with `SV.addStyle` (appended after `style.css`, so it wins; use the
`--sv-*` tokens from `web/style.css` — colours, control height, radius, spacing, type, z-index layers, motion, focus
ring, shadows — the old names `--bar --bar2 --line --text --dim --accent --desk --paper --sel --play` remain aliases), put UI in `SV.addToolbar`, persist
preferences with localStorage keys prefixed `scoreview.<module>.`. Other modules may expose helpers on
`window.SV.<module>` (e.g. `SV.instruments.lookup(name)`) — check for existence before using.

### Clip placement (core/sources.js `alignLive`, web/align.js)
In score mode the live clip is placed exactly after a Read (the mirror: `how: 'mirror'`, from the clip's start in the
read); otherwise (no read, or a clip the read does not have) it is located in the base by note matching: candidates are scored mostly by how well the
clip's opening (first 16 beats / 16 notes) matches, then by the whole clip. Equally good places (repeated material)
are ordered by closeness to the arranger playhead (`state.playPos`), then earliest; the status shows
`✎ Bass @ bar 1 (1 of 4) ◀ ▶` and the arrows cycle them (`state.align.how = 'manual'`, kept until another clip is
selected — clip identity is track + length + loop). While playing, the playhead gives the exact position and always wins.
With a read, a read clip of the track starting at the play start marker (`selPlayStart`) wins over note matching
(`how: 'guess'`): matching against the read can land on old notes elsewhere when the clip changed since the read.
`state.align = { track, key, offset, how: 'match'|'playhead'|'manual'|'guess'|'mirror', cands:[offsets] }`.

## Feature pages and test helpers
* `docs/features/` has one short page per `web/features/*.js` module (purpose, owned ids / keys / API, hooks used,
  tests); start at `docs/features/README.md` and update a module's page when you change what it owns.
* e2e tests address the UI through `test/selectors.mjs` (`SEL`, `MENUS`, `TOOLS`, `openMenu(page, name)`,
  `clickTool(page, name)`, `setRange(page, name)`); when you add or rename a toolbar id, update that map.
* `bash test/run-all.sh -j N [tier] [suite ...]` runs suites N at a time (`npm test -- -j 3`); suite names after the
  tier run only those. CI: `.github/workflows/ci.yml`.

## Testing (never touch the user's running Bitwig)
* `node test/render-test.mjs` — engraving smoke test (writes test/out.svg).
* `node test/svg-inline-test.mjs` — glyph inlining on real Verovio output (synthetic score + Mega Man 2: geometry per
  glyph, the rest byte-identical) and edge cases. `PORT=… node test/render-perf-e2e.mjs` — the full crawl score with and
  without inlining, compared pixel by pixel at three places (`test/out.svg-inline-*.png`), and the number of layouts
  one render forces (afterRender hooks that interleave measuring and writing make it hundreds).
* `node test/chunks-test.mjs` — chunk MEI (state carried in, spanners cut and continued, hidden staves), system breaks
  (each chunk engraves as one system; sticky breaks), hashes. `PORT=… node test/chunked-e2e.mjs` — chunked Score view in
  the page: workers, previous SVG kept until ready, every bar / note id once, hit tests in a later chunk, an edit
  re-engraves one chunk, latest render wins, line layout, the no-worker and one-document fallbacks (uses PORT, PORT+1).
* `node tools/perf-bench.mjs [--runs N] [--no-inline] [--no-chunks] [--no-worker] [--root <checkout>]` — render timings
  (main-thread time, time to the systems in view, to the whole score, longest task, stages, slow afterRender hooks) for
  Score view cold / cached, an edit mid-score, a live edit through the mock, Clip view, Clip + 4 pins (Mega Man 2 crawl).
* `node test/e2e-smoke.mjs` — page + mock server + headless Chrome; clicks a note, presses ↑.
* `node test/rhythm-test.mjs` — tuplet/voice/pickup cases (writes test/out.rhythm-*.png); `test/rhythm-e2e.mjs`
  (Q readings in the page); `test/rhythm-perf.mjs` (buildMEI timing on the Mega Man 2 fixture).
* `test/mock-server.mjs` — fake extension API with a real in-memory clip (edits apply). Run standalone
  `node test/mock-server.mjs --port 88xx` or use `withPage({port}, fn)` from `test/lib.mjs`.
  **Use your own port** (8810-8899) so parallel runs don't collide.
  It sends the timing fields of `/api/notes` (option `settle: {quietMs, switchQuietMs}`, default 100/200; `settle: false`
  = an extension without them; `srv.sync`), and `srv.switchClip(target, {noteMs, trackMs, playStartMs})` delivers a
  clip switch like Bitwig (notes one by one, the track name and the play start marker later).
  It has cue markers (`markers` option / `srv.setMarkers`), per-track solo/mute, and simulates the transport: the
  `play`/`stop`/`toggle`/`playFrom`/`position` ops start a playhead that advances at tempo (and wraps in an
  enabled loop); `srv.setPlay({...})` switches the simulation off to pin exact values; `clipOffset` option /
  `srv.state.clipOffset` = arranger beat of the mock clip (drives `step`).
* `PORT=8861 node test/mouse-e2e.mjs` — mouse editing on `test/fixtures/live-mouse.json`: pitch drag (Alt chromatic),
  collision safety, Shift+drag in time, length handle, marquee, copy/cut/paste; screenshots `test/out-mouse-*.png`.
* `node test/entry-test.mjs` / `PORT=… node test/entry-keys-e2e.mjs` — keypad layouts, intervals, octave, bar caret,
  legato / short lengths, range warning.
* `node test/midi-bridge-e2e.mjs` — MIDI bridge in entry mode (Web MIDI stubbed; Auto fallback, chords, playing filter).
* `PORT=9590 node test/controller-e2e.mjs` — controller MIDI Learn (encoder/pad/CC button), default maps, generic keys, HUD/panel screenshots.
* `node test/playback-e2e.mjs` — rehearsal marks, play-from-bar, Space, L loops, solo/mute (ports PORT, PORT+1).
* `test/lib.mjs` — `withPage`, `loadFixtureScore` (Mega Man 2 DAWproject, 23 parts), `renderMEI`, `screenshotSvg`.
* `node test/sections-test.mjs` — score order / name matching, section brackets in MEI, clip placement (Bass → bar 1,
  Violin 1 → bar 25).
* `PORT=8812 node test/sections-e2e.mjs` — loads the DAWproject into the page (via `#fileInput`), checks section
  views, score order, Follow section, placement cycling and playhead; screenshots `test/out.sections-*.png`.
* `node test/articulations-test.mjs` — keyswitch resolution, notation, technique text, dynamics, write-back plans,
  BBC SO tables from the plugin states, MusicXML export (XSD). `PORT=8921 node test/articulations-e2e.mjs` — page:
  engraving, palette and Shift shortcuts writing keyswitches, Hide keyswitches, score mode with the full export.
  `node test/articulations-visual.mjs [name]` → `test/out-artic-*.png` (Mega Man 2 strings / brass / dynamics).
* `node test/import-test.mjs` — MIDI parser (files written by `test/midi-file.mjs`), MusicXML import round trip through the
  exporter (synthetic transposing parts + Mega Man 2), .mxl, `planImport` ops. `PORT=8861 node test/import-e2e.mjs` — Import…
  dialog into the mock clip (clip mode, 600-note chunked MIDI, score mode at an arranger bar; uses PORT and PORT+50).
* `PORT=8862 node test/print-e2e.mjs` — print view of the whole Mega Man 2 score (pages, header, n / N footer), a part,
  Letter landscape, PDF page count via `page.pdf()`; `test/out.print-*.png|pdf`. `PORT=8863 node test/theme-e2e.mjs` —
  dark/Bitwig paper with harmony colours (contrast checks), persistence; `test/out.theme-*.png`.
* `node test/notation-test.mjs` — clef changes (cello bass→tenor→bass), 8va/15ma/8vb, meter/key changes, tempo marks,
  DAWproject tempo/meter automation, notation.js re-basing, Mega Man 2 tempo ramp and buildMEI timing; writes
  `test/out-notation-*.png`. `PORT=8813 node test/notation-e2e.mjs` — the Notation menu and tempo marks in the page.
* Fixtures: `test/fixtures/megaman2.dawproject`, `live-violin1.json`, `live-bass.json`, `megaman2-plugins.json` (the
  articulation XML of the full export's BBC SO plugin states; `test/articulations-fixture.mjs` zips it with the project).
* `node test/protocol-test.mjs` — op table contract (Java `EditOps` = `test/fixtures/ops.txt` = mock `MOCK_OPS`), refusals,
  busy-port popup, and `test/java/NavigatorCheck.java` (real `ClipNavigator` against a fake Bitwig).
  `node test/nav-stay-test.mjs` — `gotoStay` on the mock over HTTP.
* `PORT=… node test/keymap-e2e.mjs` — arrow-key layouts (navigation, extend, bar, move, length, pitch; no clashes per layout).
* `node test/shortcuts-test.mjs` / `PORT=… node test/shortcuts-e2e.mjs` — shortcut registry, no key clashes, help table,
  toolbar clusters. `node test/arrangement-stale-test.mjs` / `PORT=… node test/arrangement-e2e.mjs` — read visibility,
  out-of-date dot, Inspire Melody over a read in Clip mode. `node test/arrangement-mirror-test.mjs` / `PORT=… node
  test/arrangement-mirror-e2e.mjs` (PORT, PORT+1) — the mirror: upsert / suspects / placement / merge, a reload keeps the
  read, a clip changed in Bitwig updates the score without a read, Refresh N tracks, IndexedDB fallback.
  `node test/crawler-check-test.mjs` — the real ArrangementCrawler (full and `crawl tracks`) and ArrangementMirror
  against a fake Bitwig (needs javac, ~1 min), also the fast walk (adaptive waits, stepping past lanes, a lane order
  that differs → walk again) and NoteListen. `node test/arrangement-listen-test.mjs` / `PORT=… node
  test/arrangement-listen-e2e.mjs` — listening while playing (baseline, Note FX ignored, changed at bar N → Refresh).
  `node test/crawl-compare-test.mjs` — the read comparer. Live and manual only: `test/listen-probe.mjs` (read-only:
  what the note observer delivers), `test/clip-step-probe.mjs` (Developer mode, a "crawl" project copy).
* `node test/passage-test.mjs` / `PORT=… node test/passage-e2e.mjs` — passage selection, copy/paste between staves on the
  mock arrangement (stay on the pasted clip, ↑↑, overwrite/merge, R, Alt+click, click a note to make its clip live).
* `node test/gui-test.mjs` / `PORT=… node test/gui-e2e.mjs` — palette, status bar, toasts, compact / classic header.
  Elements in File ▾ / View ▾ are hidden until opened: click them with `clickIn(page, sel)` / `clickTool` from
  `test/selectors.mjs`, or start with `withPage({ header: 'classic' })`.
* `node test/dynamics-test.mjs` / `node test/curve-player-test.mjs` (real CurvePlayer on a fake Bitwig, needs javac) /
  `PORT=… node test/dynamics-e2e.mjs` — dynamics marks, curve model, Render dynamics against the mock.
* `PORT=… node test/sync-e2e.mjs` — clip switches delivered in bursts: settled data, overlays and the Read watch never mix
  tracks; overlay / liveSettled within ~300 ms; selPlayStart instead of `/api/transport`; the fallback without the
  fields (PORT, PORT+1). `node test/protocol-test.mjs` also runs `test/java/LiveSyncCheck` (versions per burst, windows).
* `PORT=… node test/core-e2e.mjs` — requestRender batching, `SV.geom`, `scoreModel` overrides. `test/hook-order-e2e.mjs`
  — pinned hook order. `test/popover-e2e.mjs` — Orchestrate / Controller panels close on Esc and outside press,
  stray Learn click, bar-1 roman numeral clear of the tempo mark, tokens (PORT, PORT+1).
* `playback-e2e` writes screenshots into `build/`; a fresh checkout needs `mkdir -p build` (CI does this).
* Look at your output: screenshot it (puppeteer `page.screenshot`, or `screenshotSvg`) and read the PNG.

## Rules
* Do **not** run `build.sh`, copy anything into Bitwig's Extensions folder, or call the real server on
  port 8765 (`/api/edit` there changes the user's project). The lead integrates and deploys.
* Java changes must compile: `javac --release 21 -cp lib/extension-api-25.jar -d build/tmp src/claude/scoreview/*.java`.
* Commit your work on your branch with clear messages. Don't rewrite or reformat code you don't own.
* Match the existing style: 2-space JS, small focused functions, comments only where intent isn't obvious.
