# Score View — guide for contributors and agents

Score View shows Bitwig Studio clips as standard music notation and edits them from the score.
The user is a composer who writes in notation (Sibelius/Finale/Dorico background) and uses Bitwig 6.1 with
large orchestral libraries (BBC Symphony Orchestra with Bitwig articulation maps).

## Architecture

```
Bitwig Studio ──(Java extension API)──> src/claude/scoreview/ScoreViewExtension.java
                                         │  HTTP server on 127.0.0.1:8765 (serves web/ from the jar)
                                         ▼
                         web/index.html + web/core/*.js (UI shell, Bitwig polling, selection, editing)
                         web/style.css                 (core styles, --sv-* design tokens)
                         web/score.js                  (notes -> MEI: quantize, voices, ties, beams, spelling)
                         web/dawproject.js             (DAWproject export -> parts)
                         web/align.js                  (places the live clip in the arrangement by note matching)
                         web/features/*.js             (feature modules, one per feature area)
                         Verovio (vendor/verovio-toolkit-wasm.js) engraves MEI -> SVG
```

* **Clip mode**: the clip selected in Bitwig (arranger or launcher), live.
* **Score mode**: a DAWproject export is the base for all tracks; pinned tracks + the selected clip's
  track are shown; the selected clip is overlaid live and is the only editable material.

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
  `{ v, source, exists, track, stepsPerBeat, length, playStart, loop, loopStart, loopLength,
     num, den, tracks:[{name, index, group, sel, solo, mute}], markers:[{name, beat}],
     notes:[{ch, x, y, d (beats), vel (0-127), sel}] }`
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
  `solo trackIndex 0|1` · `mute trackIndex 0|1` · `metronome 0|1`.
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
  running|done|error|cancelled, kind, message, step, steps, tracks:[{name, group, created, grouped, groupMsg, devices:[{ok, text}]}],
  groups, settings:[{ok, text}], errors, notes }`, `GET /api/wizard?caps` → the Group/header-focus actions found. Creates tracks, groups (Bitwig's
  "Group" action, verified via parent-track proxies), colours, Note FX + instrument devices; "Swap library…" in the
  instrument picker swaps one track's instrument. Optional starter settings set the tempo, time signature and named cue markers.
  Templates (Essentials + 24 starter templates with a brief and per-row patch hints), categories, palette, plan and the
  starter sheet (`SV.wizard.sheet()`, toolbar **Brief**): `features/wizard-templates.js` (pure);
  installed plug-ins: `features/wizard-plugins.js`, generated by `node tools/scan-plugins.mjs` from Bitwig's plug-in cache.
* Mock: `test/mock-wizard.mjs` (`srv.wizard.plans`, `.swaps`, `.groupAction = false`, `.stepMs`, `.playing = true` skips markers; device ids containing
  `FAIL` / paths containing `MISSING` fail). Tests: `node test/wizard-test.mjs`, `PORT=… node test/wizard-e2e.mjs`.

### Live arrangement crawl (web/features/arrangement.js, ArrangementCrawler.java)
* `POST /api/edit` op `crawl` (or `crawl exact`) walks every arranger clip with Bitwig's selection actions
  (Move cursor to first/next lane, Select first/next item); `crawlCancel` stops it. Requires a clip to be
  selected in the arranger (that gives the timeline keyboard focus); refuses while playing. Collapsed groups are
  opened for the crawl and closed again; selection, play start and loop are restored.
* Positions come from the play start marker (Bitwig moves it to the selection). `exact` also measures each clip's
  visible length with Loop Selection and undoes that change immediately (verified; on doubt: redo + manual restore).
* `GET /api/crawl` → `{ state: idle|running|done|error, message, lane, lanes, clips, stepsPerBeat,
  tracks:[{name, group}] (when done), result:[{lane, track, start, playStart, playStop, loop, loopStart, loopLength,
  length? (exact only), notes:[[ch, x, y, durBeats, vel]]}] (when done) }`.
* Page wake-ups are suppressed while crawling. Debug ops: `act <actionId>`, `clipNext`/`clipPrev`, `selectTrack`,
  `moveTrackAfter`/`moveTrackBefore` (refused unless Bitwig Preferences > Score View > Developer mode is on; the page
  never sends them), `GET /api/transport` (read-only, always on).
* `crawlToScore(crawl)` (node-testable) builds the Score-mode base; `SV.setBase(score)` installs it. The raw crawl
  stays in `SV.state.crawl`; `clipEnd(clip, next)` gives a clip's visible end.

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
  emulates the crawl (`/api/crawl`), goto/gotoHome (`/api/nav`, `srv.nav`, `srv.arrangement`) and `/api/transport`.

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
          offsetBeats, tuplets (count) }
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
Live note ids are `L<ch>_<x>_<y>`; anything else is read-only (from the export).

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
SV.hooks.afterRender.push(render => {})               // render = state.render (timeline, staves, score, ...)
SV.hooks.keydown.push(e => true /* handled */)        // runs before built-in shortcuts
SV.hooks.noteClick.push((timelineEntry, e) => true)
SV.hooks.paperClick.push((e, hit) => true)            // hit = SV.hitTest(e): {measure, staff, part, beat, diatonic, pitch}
SV.hooks.paperMouseDown.push((e, noteEl) => true)     // any press on the paper, before the built-in click (features/mouse.js
                                                      // uses it for drags; SV.clickPaper(e) runs the built-in click later)
SV.hooks.liveData.push(d => {})                       // each update from Bitwig
SV.hooks.play.push(p => {})                           // ~20 Hz transport feed
SV.hooks.visibleTracks.push((shown, allNames) => set) // score mode: which tracks to show; return a Set to override
                                                      // (first Set wins), undefined to keep the pin/all choice
SV.state  SV.render() (engraves now)  SV.requestRender() (at most one render per animation frame; prefer it for
  reactions to events)  SV.geom.rect(el)/.rects(els)/.invalidate() (#paper boxes cached per render; call invalidate()
  after a geometry change made only through CSS classes)  SV.hookOrder()
SV.send([ops])  SV.flash(msg, {kind: 'info'|'ok'|'warn'|'err', ms}?)  SV.liveNotes()  SV.currentTrack()
  (flash fires window 'sv-flash' {msg, kind, ms}; features/toasts.js stacks and keeps the history: SV.toasts)
SV.addToolbar(htmlOrEl, {cluster, order}?)  SV.addHelp(html)  SV.addStyle(css)  SV.isLive(id)  SV.parseId(id)
SV.renderTrackList()  SV.cycleAlign(±1)               // refresh the Tracks menu · step through clip placements
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
  clip the selected one is)  .prefs.afterRead 'all'|'keep'   (features/arrangement.js)
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
In score mode the live clip is located in the export by note matching: candidates are scored mostly by how well the
clip's opening (first 16 beats / 16 notes) matches, then by the whole clip. Equally good places (repeated material)
are ordered by closeness to the arranger playhead (`state.playPos`), then earliest; the status shows
`✎ Bass @ bar 1 (1 of 4) ◀ ▶` and the arrows cycle them (`state.align.how = 'manual'`, kept until another clip is
selected — clip identity is track + length + loop). While playing, the playhead gives the exact position and always wins.
`state.align = { track, key, offset, how: 'match'|'playhead'|'manual', cands:[offsets] }`.

## Feature pages and test helpers
* `docs/features/` has one short page per `web/features/*.js` module (purpose, owned ids / keys / API, hooks used,
  tests); start at `docs/features/README.md` and update a module's page when you change what it owns.
* e2e tests address the UI through `test/selectors.mjs` (`SEL`, `MENUS`, `TOOLS`, `openMenu(page, name)`,
  `clickTool(page, name)`, `setRange(page, name)`); when you add or rename a toolbar id, update that map.
* `bash test/run-all.sh -j N [tier] [suite ...]` runs suites N at a time (`npm test -- -j 3`); suite names after the
  tier run only those. CI: `.github/workflows/ci.yml`.

## Testing (never touch the user's running Bitwig)
* `node test/render-test.mjs` — engraving smoke test (writes test/out.svg).
* `node test/e2e-smoke.mjs` — page + mock server + headless Chrome; clicks a note, presses ↑.
* `node test/rhythm-test.mjs` — tuplet/voice/pickup cases (writes test/out.rhythm-*.png); `test/rhythm-e2e.mjs`
  (Q readings in the page); `test/rhythm-perf.mjs` (buildMEI timing on the Mega Man 2 fixture).
* `test/mock-server.mjs` — fake extension API with a real in-memory clip (edits apply). Run standalone
  `node test/mock-server.mjs --port 88xx` or use `withPage({port}, fn)` from `test/lib.mjs`.
  **Use your own port** (8810-8899) so parallel runs don't collide.
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
* `node test/shortcuts-test.mjs` / `PORT=… node test/shortcuts-e2e.mjs` — shortcut registry, no key clashes, help table,
  toolbar clusters. `node test/arrangement-stale-test.mjs` / `PORT=… node test/arrangement-e2e.mjs` — read visibility,
  out-of-date dot, Inspire Melody over a read in Clip mode.
* `node test/passage-test.mjs` / `PORT=… node test/passage-e2e.mjs` — passage selection, copy/paste between staves on the
  mock arrangement (stay on the pasted clip, ↑↑, overwrite/merge, R, Alt+click, click a note to make its clip live).
* `node test/gui-test.mjs` / `PORT=… node test/gui-e2e.mjs` — palette, status bar, toasts, compact / classic header.
  Elements in File ▾ / View ▾ are hidden until opened: click them with `clickIn(page, sel)` / `clickTool` from
  `test/selectors.mjs`, or start with `withPage({ header: 'classic' })`.
* `node test/dynamics-test.mjs` / `node test/curve-player-test.mjs` (real CurvePlayer on a fake Bitwig, needs javac) /
  `PORT=… node test/dynamics-e2e.mjs` — dynamics marks, curve model, Render dynamics against the mock.
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
