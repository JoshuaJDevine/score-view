# New Score wizard (issue #14)

The wizard builds an ensemble's tracks in the project that is open in Bitwig, as Sibelius's "New Score" does. It
names the tracks, groups them by section and colours them. It can also insert an articulation-map Note FX preset and
an instrument plug-in on each track. Separately, **Swap library…** in the per-staff instrument picker loads another
plug-in on one existing track.

Files:

* `src/claude/scoreview/NewScoreWizard.java` runs the job on the control thread. `ScoreViewExtension` only
  constructs it, adds the `/api/wizard` context and the `wizardCancel` op.
* `web/features/wizard.js` is the dialog, the library palette and Swap library.
* `web/features/wizard-templates.js` holds the templates, resolution, palette and plan text. It is pure and
  node-testable.
* `web/features/wizard-plugins.js` is generated. Regenerate it with `node tools/scan-plugins.mjs` (see below).
* `test/mock-wizard.mjs` emulates the job in the mock server. `test/wizard-test.mjs` and `test/wizard-e2e.mjs` are
  the tests.

## How the user uses it

1. Click **New Score…** in the feature toolbar.
2. Pick a template and click **Load**, or click **Browse ideas…**: categories on the left, templates in the middle, and
   on the right the template's **starter brief** (tempo, meter, key, the form with bar numbers, a compositional prompt)
   and its tracks with the library and the patch to load in each. **Load this template** fills the list. The
   **Essentials** are Classical orchestra (BBC SO Core section names), Chamber strings, Film orchestra, String quartet
   and SATB choir + piano; the 24 starter templates are listed below.
3. Edit the list:
   * rename, regroup or recolour rows, reorder them with ▲▼, add or remove rows;
   * choose the **Notation** instrument (the `instruments.js` id; *Automatic* = guess from the name);
   * click **Library** to open the palette. It lists the installed instrument plug-ins grouped by vendor, plus your
     Bitwig library presets, and can be filtered;
   * choose an **Articulation map** (one of the "Note FX Layer" presets). The list is kept as a draft in
     localStorage;
   * edit the **Patch to load inside it** hint (free text; it goes into the summary and the starter sheet).
4. **Create in Bitwig…** shows a confirmation that names what will change. For a starter template it also offers
   **Set tempo & meter** (e.g. 150 BPM, 4/4) and **Add section markers** (one named arranger cue marker per form
   section, e.g. Intro bar 1, Stage A bar 5…); both are checkboxes, remembered. Then **Yes, add N tracks** runs the job
   with a progress bar, and **Stop** cancels it after the current step.
5. The summary lists the starter settings (✓/✗), each track (✓/✗), the group it ended up in, each device (✓/✗ with
   the reason) and, under it, **→ load: …** — the patch to choose inside that plug-in — followed by the problems,
   notes and the brief. Tracks whose name alone would not give the chosen notation instrument get an `instruments.js`
   override.
6. The brief and the tracks with their patch hints are saved as the **starter sheet** (localStorage
   `scoreview.wizard.sheet`). The **Brief** button in the toolbar opens it while you compose (Copy as text puts it on
   the clipboard).
7. Per staff: click a staff name, then **Swap library…**, then pick a plug-in. You choose either "Keep the old
   instrument, disabled" (the default) or "Replace it".

## Starter templates (24)

Each has a category, a one-line note, a brief (`{tempo, meter:[n,d], key, form:[[section, bars]], prompt}`) and 3–10
rows with a patch hint (`patch`: string, or `{[plug-in]: hint, '*': fallback}`). Hints name real snapshots, folders and
presets listed on the user's drives (Super Audio Cart `F:\VST\Super Audio Cart` + SAC2 Beta N64 bank, The Orchestra
Complete 4 snapshots, Opus instrument folders on `E:\VST` / `F:\VST\EastWest`, Spitfire `.zpreset` names under
`C:\Spitfire` / `F:\VST\Spitfire`, Arturia factory presets in `C:\ProgramData\Arturia\Presets`, Serum 2 factory presets,
NI Kontakt library folders). All 24 resolve to their first-choice plug-in in `wizard-plugins.js` (tested).

| Category | Templates |
|---|---|
| Retro & Chiptune | NES 2A03 stage theme · SNES Mode 7 adventure · N64 soundfont platformer · Cozy RPG village |
| Lo-fi & Chill | Lo-fi study beats · Background piano café trio · Tape & VHS daydream |
| Synth worlds | Serum synthwave night drive · Analog synth orchestra · Berlin School sequencers |
| Cinematic | The Orchestra: animated fantasy · Hollywood Fantasy quest · Northern saga · Abbey Road main title |
| Hybrid | Hybrid trailer in three acts · Minimalist machine (Glass / Reich) |
| Chamber & intimate | Home-recorded indie film · Neo-classical felt & cello · Berlin Free Orchestra pastoral · Cathedral at dusk |
| World & texture | Gamelan & hammered metals · Forest folk dance in 7/8 · Toy shop at midnight |
| Pop & groove | UJAM band in a box |

**Patch presets.** A row may name the exact patch for its host (`preset: {[plug-in]: patch}`; BBC SO rows via `bbc()`,
Super Audio Cart rows via `SACROW` → Kontakt 8 "Super Audio Cart"). When `web/features/wizard-presets.js` (generated by
`node tools/harvest-presets.mjs <export.dawproject>`) has that plug-in + patch (case-insensitive), resolution loads the
`.vstpreset` as a `file` device (label "BBC Symphony Orchestra — Violins 1", articulation map still first) and the
dialog shows "✓ patch preset"; otherwise the bare plug-in loads, with a warning and "plug-in only — load “X”
manually". Harvested presets also head the library palette. The SAC2 (N64) rows have no harvested state yet.

Not usable as plug-ins (sample folders exist under `C:\Spitfire`, but no plug-in in Bitwig's cache): Spitfire LABS,
Olafur Arnalds Stratus, Kepler Orchestra, Earth, Tutti, Albion NEO / Solstice, Contemporary Drama Toolkit. Albion ONE,
Orchestral Grand, Symphonic Organ, Crystal Bowls and Afterglow are Kontakt libraries and load through Kontakt 8.

## API findings (extension API 25, `javap` of `lib/extension-api-25.jar`)

| Need | What works | Evidence / how |
|---|---|---|
| Create tracks | `Application.createInstrumentTrack(int position)` (-1 = end). **It returns no handle.** | `javap Application`. The wizard diffs the flat track list (`createTrackBank(256,0,0,true)`) to find the new track, then tags it with a unique temporary name (`Name [sv<job>-<n>]`) so later steps find it after tracks shift. A final pass sets the real names, also after cancel or failure. |
| Name and colour | `Track.name().set` (`DeviceChain.name()` is a `SettableStringValue`) and `Channel.color().set(r,g,b)` | `javap Track/Channel/DeviceChain` |
| Groups | **No create-group call.** Bitwig's "Group" action is used on the selected track. | `Application` has no group method, and `Track.createParentTrack(int,int)` only gives a *proxy* of the parent. The wizard selects the first member alone (`selectInEditor`), invokes `focus_track_header_area` (so "Group" acts on tracks, not devices or clips), then invokes the action whose id or name is `group`/`Group`… (resolved at start-up; `GET /api/wizard?caps` shows what was found). It **verifies** the result through the parent-track proxy (`exists && isGroup`) before going on. |
| Move into group | `Track.afterTrackInsertionPoint().moveTracks(track)` after the previous member | `javap InsertionPoint`. Verified by checking that the parent proxy's name is the group's tag. No insertion point exists *inside an empty* group, which is why the first member is grouped with the action. |
| Insert devices | `endOfDeviceChainInsertionPoint().insertVST3Device(id)` / `insertCLAPDevice(id)` / `insertVST2Device(int)` / `insertBitwigDevice(UUID)` / `insertFile(path)` | `javap InsertionPoint`. Insertion is confirmed when the private cursor track's `DeviceBank.itemCount()` grows (timeout 15 s). `insertFile` is used for `.bwpreset` (Note FX Layer articulation maps, instrument presets); `.vstpreset`/`.nksf` should also work in principle (Bitwig's browser loads them) but are **untested**. |
| Choose a patch inside a plug-in (e.g. BBC SO "Violins 1") | **Not possible.** | No API reaches inside a plug-in. The workaround is a saved Bitwig preset per instrument (plug-in with the patch loaded, plus the articulation map), picked under "Presets" in the palette. |
| Plug-in ids | VST3 class ids and CLAP ids come from Bitwig's own plug-in cache. | `%LOCALAPPDATA%\Bitwig Studio\cache\vst3-metadata-*` / `clap-metadata-*` are tagged records (category, name, vendor, id). The BBC SO and Kontakt 8 ids match those in the DAWproject export (research §D1). |
| Swap library | `Device.replaceDeviceInsertionPoint()` and `afterDeviceInsertionPoint()`, `Device.isEnabled()` | `javap Device`. A private cursor track (`createCursorTrack(..., false)` + `selectChannel`) does not move the user's selection. A `FIRST_INSTRUMENT` cursor device finds the current instrument. "Disable" inserts the new plug-in after the old one, then disables the old one (non-destructive). "Replace" uses the replace insertion point. |
| Create a new project | No API (only `nextProject/previousProject`). | The wizard always adds to the current project, after a confirmation. |
| Tempo | `Transport.tempo().value().setRaw(bpm)` (raw = BPM, 20–666; the extension already reads `tempo().getRaw()`) | `javap Transport/Parameter/SettableRangedValue`. Verified by reading the raw value back. **Untested live.** |
| Time signature | `Transport.timeSignature().numerator()/denominator().set(n)` (`SettableIntegerValue`) | `javap TimeSignatureValue`. Verified by reading back. Sets the project meter at its start (no meter change mid-song). **Untested live.** |
| Named section markers | `Transport.setPosition(beat)` + `addCueMarkerAtPlaybackPosition()`, then `CueMarker.name().set(name)` on the marker found at that position in `Arranger.createCueMarkerBank(128)` | `javap Transport/CueMarker/CueMarkerBank`. There is no "create marker at beat"; the play position is moved, the marker added, then renamed; the original position is restored. Skipped while playing; an existing marker at the same beat is kept. bar → beat uses the (new) time signature. **Untested live.** |

Everything runs on the control thread as a queue of steps. Each step acts once, then waits until Bitwig reports the
change (minimum and maximum waits, polled every 30 ms). A failed device or group step is recorded and the job goes
on. A failed track creation stops the job, and then the final rename pass still runs.

## HTTP

* `POST /api/wizard`: the body is a plan (below). Returns `{ok:true}` or `{ok:false, error}` (for example when a job
  is already running).
* `POST /api/wizard?cancel`, or the `/api/edit` op `wizardCancel`: stop after the current step.
* `GET /api/wizard` returns:
  `{ state: idle|queued|running|done|error|cancelled, kind: create|swap, message, step, steps,
     tracks:[{name, group, created, grouped, groupMsg, devices:[{ok, text}]}], groups:[{name, ok, msg}], errors:[], notes:[] }`.
* `GET /api/wizard?caps` returns `{ groupAction:{id,name}|null, headerFocus, bank, tracks }`. Use it to check the live
  Bitwig's actions before running anything.

Plan text: one line per item, tab-separated `key=value` fields. `dev` repeats, in insertion order:

```
option	pos=-1                       (-1 = end of project, n = before main track n)
option	tempo=150                    (optional: BPM)
option	meter=4/4                    (optional: time signature)
marker	name=Stage A	bar=5        (optional, repeated: named arranger cue marker at that bar)
group	name=Strings	color=#d9a441
track	name=Violins 1	group=Strings	color=#d9a441	dev=file:C:\…\Articulation Map BBCSO Strings.bwpreset|label	dev=vst3:56535453616E746262632073796D7068|BBC Symphony Orchestra
swap	track=<flat index>	name=<track name>	dev=vst3:<id>|label	mode=disable|replace
```

Device kinds are `vst3`, `clap`, `vst2` (int id), `bitwig` (UUID) and `file` (absolute path).

## Plug-in inventory

`node tools/scan-plugins.mjs` reads Bitwig's plug-in cache and the user's `Bitwig Studio\Library\Presets` (read
only) and rewrites `web/features/wizard-plugins.js` with:

* instrument plug-ins (category Synth / Sampler / Drums…);
* Note FX Layer presets (articulation maps);
* the other `.bwpreset`s.

Re-run it after installing plug-ins, then rebuild. Templates name their libraries (`LIBS` in `wizard-templates.js`,
first installed wins). Articulation maps attach only when the library resolves to BBC SO, and the map name match
tolerates one typo (the user's file is "BBCSO Basoon").

## Limitations

* Patches inside plug-ins cannot be chosen (see above). The user picks them, or saves presets for the palette.
* Grouping depends on Bitwig's "Group" action behaving on a single selected track. This is verified each time; if it
  fails, the tracks stay ungrouped and the summary says so. Nested groups are not created.
* The wizard sees the first 256 flat tracks. A project bigger than that is refused.
* While the job runs, Bitwig's track selection moves, and every change is a separate undo step.
* Swap library finds the track by the flat index in `/api/notes` and checks its name. Tracks in collapsed groups are
  not in that list. "Disable" leaves two instruments in the chain: delete the disabled one in Bitwig when happy.
* `insertFile` with `.vstpreset`/`.nksf` is untested.
* Patch hints are text only: Kontakt snapshots, Opus instruments, SINE/Spitfire presets must be chosen by hand.
* Tempo, meter and markers change the whole project (one undo step each); markers need the transport stopped. The
  meter is set at the project start only; templates with a meter change are not possible.

**Live test (starter settings).** In an empty project load "NES 2A03 stage theme" with both options on: expect 150 BPM,
4/4, cue markers Intro (bar 1), Stage A (5), Stage B (13), Bridge (21), Turnaround (25), the play position back where it
was. Repeat with "Forest folk dance in 7/8": markers at 7/8 bar lengths (3.5 beats).

## Manual live test plan (lead; **new, empty Bitwig project only**)

Before you start: build and deploy as usual. In Bitwig use **File → New** and do not open a real project. Keep the
Bitwig controller console open (Settings → Controllers → Score View → console) for `Score View wizard:` errors.
Undo steps are listed so each test can be reverted.

1. **Capabilities.** Open `http://localhost:8765/api/wizard?caps`.
   * Expect `groupAction` non-null (note the id and name) and `headerFocus` = `focus_track_header_area`.
   * If `groupAction` is null, run `GET /api/actions` and search for "group". Add the real id to
     `NewScoreWizard`'s candidate list.
2. **One ungrouped track, no devices.** In New Score… add one row, set Library to "no instrument" and Articulation
   map to none, clear the group, then create.
   * Expect one track named as the row, in the row colour, at the end.
   * The summary shows ✓ and no errors.
3. **Device insertion.** Use one row (no group) with Library = Pigments (or any small VST3).
   * Expect the plug-in in the track's chain and ✓ in the summary.
   * Then repeat with a CLAP plug-in (Dexed CLAP) and with a `.bwpreset` (e.g. "Goomba's Celeste" from Presets).
4. **Articulation map + BBC SO.** Use one row: String quartet → keep only "Violin 1".
   * Expect the chain to be Note FX Layer "Articulation Map BBCSO Strings", then BBC Symphony Orchestra, in that
     order.
   * BBC SO opens empty (the patch is not selectable through the API).
5. **Grouping.** Load Chamber strings (5 rows, group "Strings") and choose "no instrument" for all rows (fast).
   * Expect one group "Strings" containing Violins 1 … Basses in order, all in the strings colour.
   * Watch for side effects: nothing else is grouped, and no devices or clips are grouped.
   * If the group is missing, note the summary messages and the console.
6. **Insert at start.** Repeat 5 with "Insert at: start of project" while another track already exists.
   * Expect the group before the existing track.
7. **Full template.** Run Classical orchestra with libraries (this loads 12 BBC SO instances and takes time).
   * Expect 4 groups (Woodwinds, Brass, Percussion, Strings), each track with its map and BBC SO.
   * Expect no temporary names (`[sv…]`) left.
8. **Cancel.** Start Film orchestra and press Stop after a few tracks.
   * Expect the job to stop after the current step and every created track to have its real name (no `[sv…]`).
9. **Failure path.** Edit a row's library to a bogus preset path. To do that, temporarily edit the draft in
   localStorage, or POST a plan with `dev=file:C:\nope.bwpreset|x` to `/api/wizard` from a test page on the
   extension's origin.
   * Expect the summary to show `✗ x: file not found` while the track itself is still created.
10. **Swap library.** Open the score on one of the new tracks, click its staff name, then Swap library…, pick Kontakt
    8, and keep "Keep the old instrument, disabled".
    * Expect Kontakt 8 after the old instrument and the old one disabled.
    * Undo, then repeat with "Replace it": the old device is replaced.
11. **Undo check.** Press Ctrl+Z repeatedly after a run. Note how many undo steps one track takes. This is
    information for the docs, not a pass/fail check.

Report for each step: pass/fail, timings for big libraries, and any console errors.
