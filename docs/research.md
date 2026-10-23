# Score View: research report (issue #8)

Date: 2026-10-15. Machine: the user's Windows 11 audio PC, Bitwig Studio 6.1.3, extension API 25.

Confidence levels: **H** (high) means verified on this machine or in primary source code/docs. **M** (medium) means a secondary source or an inference from several facts. **L** (low) means unverified or from memory.

Everything here was gathered read-only:
- local files, `javap` on `lib/extension-api-25.jar` and the API 25 sources jar from maven.bitwig.com;
- `GET /api/actions`, `GET /api/notes`, `GET /api/play`;
- Windows services and PnP listings;
- web research.

Nothing in Bitwig or the user's folders was changed.

---

## Executive summary: top 10 findings and recommendations

Ranked by value × feasibility.

**1. Articulations are keyswitch notes, and we can decode them exactly. (H)**
- Bitwig 6.0 and 6.1 have **no native articulation feature**. The "Articulation Map BBCSO …" presets are JSONBach's **Note FX Layer** presets, saved in Bitwig 5.3.13 (Aug 2025).
- In the Mega Man 2 clips, articulations are **ordinary MIDI notes on keys 0–19** (C-2…G-0). They sit just before the phrase. Some are short triggers, others are held across the phrase.
- The full DAWproject export contains each BBC Symphony Orchestra (BBCSO) plugin state as `.vstpreset`. Inside is readable XML that lists every articulation with its keyswitch (`a_name`, `t_keyswitch`, `t_type=1`).
- So Score View can build an exact *key → articulation* table per track. We confirmed it on all 23 BBCSO tracks.
- The live API already returns these notes (the live Bass clip shows keys 4 = Spiccato and 5 = Staccato). Writing an articulation back is just `add`/`del` of a keyswitch note.
- **Recommendation:** add `web/features/articulations.js`. It hides keyswitch notes from the staff, renders them as notation (staccato dots, tremolo slashes, *pizz.*/*arco*, *con sord.*, trills, slurs for Legato), and writes them back as keyswitch notes.

**2. A "live score crawler" is feasible, with one Java addition. (M-H)**
- The API cannot list arranger clips or read a clip's arrangement position.
- The action list has what we need: `Select first item`, `Select next item`, `Select item in next lane`, `Loop Selection` ("Loop Selected Region"), `jump_to_beginning_of_arranger_loop`, and `arranger_zoom_*`.
- Transport exposes `arrangerLoopStart()`, `arrangerLoopDuration()`, `isArrangerLoopEnabled()` and `playStartPosition()`, all settable, so we can save and restore them.
- Each step is: select a clip → `Loop Selection` → read the loop start/duration as the clip's position → read the notes from the arranger cursor clip.
- There is prior art: the modwig "play from selection" mod uses `Loop Selection` and then restores the loop.
- It needs a read-only-in-spirit `POST /api/crawl` in the Java extension, plus the consent-gated test plan in §C.

**3. Dynamics come from BBCSO parameter automation, not CC. (H)**
- In the export, strings and brass draw dynamics as **track-level automation of the BBCSO VST3 parameters "Dynamics" (paramID 20) and "Expression" (paramID 10)**. A few tracks also have CC1/CC74/CC82/pitch-bend lanes and per-note pressure.
- The extension API cannot read automation lanes. The DAWproject can.
- **Recommendation:** derive hairpins and dynamic marks from the "Dynamics" curve, with velocity as the fallback for short notes. See §B.

**4. Bitwig 6 clip aliases matter. (H)**
- Violin 1 has the *same* 64-beat "comp" / "MM2 Lead" content at 0, 96, 224, 352 and 448 beats. Bitwig 6.0 added alias clips: editing one Pattern edits all of them.
- The crawler and the score must treat aliases as one source with several placements. An edit in Score View propagates to every placement, and the UI should say so.

**5. A "New Score" wizard is mostly feasible. (M-H)**
- What the API can do:
  - create instrument tracks (`Application.createInstrumentTrack`, actions `Create Instrument Track` / `Create Group Track`);
  - name tracks (`Track.setName`);
  - insert plug-ins (`InsertionPoint.insertVST3Device(id)` / `insertCLAPDevice` / `insertVST2Device`);
  - insert presets (`InsertionPoint.insertFile(path)` with the JSONBach `.bwpreset` paths).
- What it cannot do directly: grouping. There is no "create group" call. Workarounds are the `Group` action on a track selection, or `Create Group Track` followed by `moveTracks`.
- What is impossible: choosing a BBCSO instrument *inside* the plug-in, other than through a saved `.vstpreset` or `.bwpreset`.
- **Recommendation:** ship a palette of `.bwpreset` "instrument cards" (BBCSO instrument + articulation map) and insert each with `insertFile`.

**6. Kontrol S88 MK3: use MIDI mode or the main port now; DAW mode is possible but conflicts with Bitwig. (H/M)**
- The MK3's DAW integration is NI's undocumented **NIHIA protocol v3**: CCs on channel 16 plus SysEx `F0 00 21 09 00 00 44 43 01 00 …`, on `MIDIIN2/MIDIOUT2 (KONTROL S88 MK3)`. DrivenByMoss (LGPL) has a complete implementation.
- Bitwig 6.1.3 here already has the S88 DAW ports assigned to a controller extension.
- The light guide is not reachable by MIDI. It goes through NI's Hardware Connection Service socket, which has been reverse-engineered on macOS only.
- **Recommendation:** for Score View, read notes from the main port in the browser. Use Bitwig's or DrivenByMoss's integration for transport and browse. Only consider our own NIHIA client as an opt-in "Score View controller mode".

**7. Windows MIDI Services is running here (`midisrv`, all S88 ports enumerated through it). (H for presence, M for behaviour)**
- With it, MIDI 1.0 ports are multi-client, so Chrome's Web MIDI (WinMM backend, default) and Bitwig should be able to open `KONTROL S88 MK3` at the same time.
- Leave `chrome://flags/#use-winrt-midi-api` **off**. Keep the keyboard in **MIDI 1.0 mode**.
- This needs a 2-minute test, in §Next experiments.

**8. "Play, then sculpt" design principles converge across Dorico, MuseScore, Sibelius and the research. (H)**
- Separate rhythm and pitch, with locks (Dorico's Lock to Duration, MuseScore's Re-pitch).
- Keep a persistent caret.
- Show quantization as **ranked readings**: Cemgil/Nakamura Bayesian rhythm models give top-N hypotheses naturally.
- Keep the raw performance visible under the notation (Notion's overlay).
- Use quiet, adjustable aim assist (Bateman et al., CHI 2011), radial menus with at most 8 items × 2 levels (Kurtenbach & Buxton), and audition every edit immediately (Nash's "liveness").

**9. API 25 adds nothing for clips, notes, articulations, arranger or key signature. (H)**
- The API 24 → 25 diff is only `TrackBankContentFilter` (beta).
- Bitwig 6.0 added a **project key signature** (Root/Scale parameters on transport lanes), Note Expression Lane, automation clips, aliases and Arranger Overdub. None of these are exposed to extensions.
- Keep auto-detecting the key. Optionally read it from the DAWproject if a future export includes it.

**10. Note expressions are readable and writable per note. (H)**
- `NoteStep` has getters and setters for `gain`, `pressure`, `timbre`, `pan`, `transpose`, `velocitySpread`, `releaseVelocity`, `chance`, `repeat*` and `isMuted`. These are the per-note *base values*, not the curves.
- The DAWproject has per-note pressure curves (`<Note><Points><Target expression="pressure"/>`).
- Use velocity plus note gain for accents and per-note dynamics. Bitwig gain is an easy "write-back" channel for accent marks.

---

## A. Articulations

### A1. What the Bitwig "Articulation Maps" are (H)

**No native feature exists.**
- The official 6.0 (11 Mar 2026) and 6.1 (26 Aug 2026) release notes never mention articulations or keyswitches:
  - https://downloads.bitwig.com/6.0/Release-Notes-6.0.html
  - https://downloads.bitwig.com/6.1/Release-Notes-6.1.html
- The API 25 sources contain no "articulation" anywhere.
- A VI-Control user on 6.0 says: "Still no native articulation mapping…" (https://vi-control.net/community/threads/bitwig-6-0-officially-released.170801/).

**The presets.** They are at `C:\Users\jd838\OneDrive\Documents\Bitwig Studio\Library\Presets\Note FX Layer\Articulation Map BBCSO *.bwpreset` (19 files + Template).
- Header metadata: `creator JSONBach`, `application_version_name 5.3.13`, `device_name Note FX Layer`, `tags "articulation play-aware"`, internal name `BBCSO_ArticulationMaps_Strings`.
- The binary `BtWg` container is readable enough with a strings scan.

Structure (Strings preset):
```
Note FX Layer "BBCSO String Articulations"
 ├─ CHAIN0 "Delay"       – Note Grid that delays gate/pitch/velocity (so the keyswitch arrives first)
 ├─ CHAIN1 "Transposer"  – Note Grid with a Pitch module (emits the keyswitch note)
 └─ Note FX Selector (INDEX parameter) with one chain per articulation,
      each chain = Note Transpose (COARSE/OCTAVES) named after the articulation
```

The point is ergonomics. You pick the articulation by **Selector index**, which can be set by a parameter, automation or modulators, and the map emits the right BBCSO keyswitch. Chain order is identical to BBCSO's own keyswitch order:

| Preset | Chains (index = BBCSO keyswitch key) |
|---|---|
| Strings | 0 Legato, 1 Long, 2 Long CS, 3 Long Flautando, 4 Spiccato, 5 Staccato, 6 Pizzicato, 7 Col Legno, 8 Tremolo, 9 Trill M2, 10 Trill m2, 11 Long Sul Tasto, 12 Long Harmonics, 13 Short Harmonics, 14 Bartók Pizz, 15 Long Marcato Attack, 16 Tremolo Sul Pont, 17 Tremolo CS, 18 Long Sul Pont, 19 Spiccato CS |
| Horns / Trumpets / Tenor Trombones | 0 Legato, 1 Long, 2 Staccatissimo, 3 Marcato, 4 Long Cuivré, 5 Long Sfz, 6 Long Flutter, 7 Multi-Tongue, 8 Trill M2, 9 Trill m2, 10 Long (Muted), 11 Staccatissimo (Muted), 12 Marcato (Muted) |
| Bass Trombones / Tuba | Same, without trills (Tuba also without muted shorts) |
| Flute / Clarinet / Piccolo | 0 Legato, 1 Long, 2 Trill M2, 3 Trill m2, 4 Staccatissimo, 5 Tenuto, 6 Marcato, 7 Long Flutter, 8 Multi-Tongue (Piccolo: 9 Rips, 10 Falls) |
| Oboe / Bassoon | Like Flute, without Flutter/Multi-Tongue respectively |
| Harp | 0 Sustained, 1 Damped, 2 Damped Medium, 3 Bisbigliando Trem, 4 Gliss FX |
| Timpani | 0 Hits, 1 Rolls, 2 Hits Soft, 3 (Rolls Soft), 4 Hits Hotrods, 5 Long Rolls Hotrods, 6 Hits Damped, 7 Hits Super Damped, 8 Hotrods Hits Damped, 9 Hits Damped Soft |
| Mallets | Hits / Rolls (Tubular Bells + Damped; Celeste Sustained/Damped/Damped Medium) |

**The current project does not use the maps.**
- The saved `Mega Man 2.bwproject` (5.3.13, Aug 2025) contains no "Note FX Layer", "Note FX Selector" or "Articulation Map" strings.
- The DAWproject export contains no Note FX devices either, though DAWproject may omit them anyway.
- The clips carry BBCSO keyswitch notes directly.

### A2. How a note's articulation is stored (H)

- **Keyswitch notes in the clip.**
  - From the DAWproject export: Violin 1 uses keys 0 (Legato), 4 (Spiccato) and 6 (Pizzicato). Cello uses 8 (Tremolo). Trumpet uses 2 (Staccatissimo) and 3 (Marcato). Bass uses 4 and 5.
  - Two placement styles occur:
    - a short trigger (0.25 beat) on the downbeat of a section, which latches;
    - a note held across the phrase, starting about 0.03–1 beat before the first note. For example, key 0 at beat 22.5 with duration 8.66 covers the 10 notes from beat 23.5 on.
  - Some keyswitch notes even carry per-note pressure curves, probably recorded from the keyboard.
- **Not used here:**
  - MIDI channel: every exported note is `channel="0"`.
  - Note expressions as articulation.
  - BBCSO's other trigger types (UACC CC32, program change, velocity). Every articulation shows `t_type 1` = keyswitch, and `t_cc 32` is present but unused.
- **The authoritative per-instrument table is in the plugin state.**
  - In the full export, `plugins/<uuid>.vstpreset` contains `<SPITFIREAUDIO_AUNTIE><META name="Core - Violins 1" …><ARTICS><ARTIC>…<SETTING id="a_name" value="b - Violins 1 - Legato"/>…<SETTING id="t_keyswitch" value="0"/><SETTING id="t_type" value="1"/>…`.
  - `project.xml` links the track to the state through `<Vst3Plugin deviceName="BBC Symphony Orchestra"><State path="plugins/…vstpreset"/>`.
  - Verified for all 23 BBCSO tracks: Violins 1/2, Violas, Celli, Basses, Horns a4, Trumpet(s), Trombones, Tuba, Flute(s), Oboes, Clarinet(s), Bassoons, Untuned Percussion ×2, Timpani, Harp.
  - BBCSO **Core** edition.
- **Caveat.** Woodwind tracks contain a few keys 12 and 16, beyond the 9 articulations those patches have. These are probably stray or legacy notes. Treat any key below the instrument's lowest playable note but outside the table as "unknown keyswitch" (show a small grey marker).

### A3. In the DAWproject (H)

- `<Note time duration channel key vel rel>` has no articulation attribute. Keyswitch notes are ordinary `<Note>` elements.
- Plugin states are only in the **full** export (with `plugins/`). The repo fixture is `project.xml` only.
- **Recommendation:** have `dawproject.js` optionally load `plugins/*.vstpreset`, extract the `<SPITFIREAUDIO_AUNTIE>` XML, and produce `part.articulations = {key: name}`.
- Also ship a static fallback table built from the JSONBach preset chain names above, keyed by BBCSO instrument family. That covers live-only use.

### A4. Extension API (H)

- `NoteStep` (API 25) has `x, y, channel, state, velocity, releaseVelocity, velocitySpread, duration, pan, timbre, pressure, gain, transpose, chance, occurrence, recurrence, repeat*, isMuted, isIsSelected`. There is **no articulation property**.
- Keyswitches are plain notes, so reading and writing work with today's ops (`add`, `del`, `dur`, `move`). The live `/api/notes` already returns them; the current Bass clip has keys 4 and 5.
- A future native articulation map could not be read anyway: no API surface exists.

### A5. Proposed rendering and write-back

**Model.** For each part, `ksRange` = keys of the articulation table (default: keys < 24 if the instrument's range starts higher).
- Split the notes into `musical` and `keyswitch`.
- Each keyswitch event sets the "current articulation" from its start time.
- For a held keyswitch, the articulation lasts until its end, then reverts to the previous latched one. A short keyswitch latches until the next one.
- Assign each musical note `art = currentArticulation(note.start + ε)`.

**Notation mapping.** All of these are MEI that Verovio supports:

| Articulation | Notation |
|---|---|
| Legato | Slur over consecutive notes while Legato is active (break at rests) |
| Long | No mark; *arco* after pizz. |
| Spiccato | `artic="spicc"`, or a staccato dot plus a "spicc." text at the first note |
| Staccato | `artic="stacc"` |
| Staccatissimo | `artic="stacciss"` |
| Tenuto | `artic="ten"` |
| Marcato | `artic="marc"` |
| Long Sfz | Dynamic `sfz` |
| Pizzicato | *pizz.* text at onset, *arco* when it ends |
| Bartók pizz | `artic="snap"` |
| Col legno | *col legno* text |
| Tremolo | `<bTrem>` with 3 slashes (`stem.mod="3slash"`) |
| Tremolo sul pont / CS | `<bTrem>` plus *sul pont.* / *con sord.* text |
| Trill M2/m2 | `<trill>` with an accidental above for m2/M2 depending on the scale |
| Long CS / Muted | *con sord.* at onset, *senza sord.* after |
| Flautando / Sul tasto / Sul pont | Technique text, then *ord.* when it ends |
| Harmonics | `artic="harm"` (natural-harmonic circle) |
| Flutter | `<bTrem>` plus *flz.* |
| Multi-tongue | *multi-tongue* text (or `<bTrem>` 2 slashes) |
| Hits / Rolls (perc.) | Rolls → `<bTrem>` 3 slashes |

**Write-back.**
- Put an articulation palette in the toolbar, plus a radial menu on the controller.
- Applying an articulation to a selection inserts a keyswitch at `start − 1/32` beat with the duration of the selection span, so the "held" style is preserved. Remove any keyswitches it covers.
- Use the existing ops: `add 0 x key 100 dur` and `del`.
- In the score's playback model, keep keyswitch velocity at 100 or the original value. It is irrelevant for BBCSO.
- **Optional Java:** an op `ks key x dur` that also deletes overlapping keyswitches atomically, so one undo step covers it. This needs testing: does Bitwig group the edits of one control-thread flush into one undo step? (L)

---

## B. Dynamics and expression

### B1. API (H)

- `NoteStep.velocity()`, `releaseVelocity()`, `gain()`, `pressure()`, `timbre()`, `pan()` and `transpose()` are all readable and settable. They are per-note scalar values (base expression), not curves.
- **Channel CC1/CC11 automation, track automation and plug-in parameter automation are not readable.**
  - `Parameter` objects give only the *current* value: a `CursorRemoteControlsPage` or `SpecificPluginDevice` parameter could sample BBCSO "Dynamics" during playback, but cannot read the lane.
  - Clip-internal automation is not exposed either.

### B2. DAWproject (H)

- **Track lanes:** `<Points><Target parameter="idN"/>` resolves to `RealParameter name="Dynamics" parameterID="20"` and `"Expression" parameterID="10"` on the BBCSO `Vst3Plugin`.
  - Present on Violin 1, Violin 2, Viola, Cello, Bass, Trumpets, Trombones, Tuba, Bassoons.
  - Trombones have 61 points, so they really are drawn dynamics.
  - Plus Volume, Send and On/Off automation.
- **CC lanes:** `<Target expression="channelController" controller="1|74|82"/>` and `pitchBend` on solo/synth tracks (Violin Solo, Flute, Super Audio Cart…).
- **Per-note curves:** `<Note …><Points><Target expression="pressure"/>…` (Violin 1, Cello, Bassoons, Flute). Audio clips can carry `transpose` points.
- `dawproject.js` should parse all three, keyed by track.

### B3. Recommended dynamics and hairpin derivation (M)

1. **Source priority** per part:
   1. BBCSO "Dynamics" parameter curve, or CC1 if mapped;
   2. CC11 / "Expression" as a multiplier;
   3. velocity, for short articulations (spiccato, staccato, pizz.; BBCSO shorts use velocity by default, `p_dynamicsVelocityMode`);
   4. note gain.
2. Resample the curve at each note onset (and at phrase level), then smooth with about a 1-beat median filter.
3. **Map to marks** with hysteresis on a 0–1 scale. Bands: `ppp <0.12, pp <0.25, p <0.38, mp <0.5, mf <0.62, f <0.75, ff <0.88, fff`. Emit a new mark only when the band changes **and** stays for at least 1 beat, or at a phrase start after a rest.
4. **Hairpins:** fit piecewise-linear segments (Ramer–Douglas–Peucker, ε ≈ 0.04).
   - A segment with a slope above 0.06/beat that lasts at least 1 beat becomes `<hairpin form="cres|dim">` from start to end.
   - End the hairpin with the dynamic of the target band. Skip it if the start and end bands are equal.
5. **Accents:** a note velocity at least 20 above the local median, or `gain` above 0, gives `>` (accent). Long Sfz or a spike-then-drop curve gives `sfz`/`fp`.
6. **Write-back (later):** dynamics edits on the score can only change velocity and gain through the API. Curve editing would need a re-import or manual drawing. Keep the derived marks read-only for now, with a toggle.

---

## C. Live score without export: the arranger crawler

### C1. What the API can and cannot do (H)

- The arranger cursor clip (`host.createArrangerCursorClip`) follows the clip selected in the UI. It gives notes, `getPlayStart/Stop`, loop, `getTrack()` and `color()`, but **no arrangement position**.
- `CursorClip` extends `Cursor`, which has `selectNext/Previous/First/Last` and `hasNext`. This is untested for the arranger cursor clip. It might walk clips without actions (L, a cheap experiment).
- Transport has `arrangerLoopStart()`, `arrangerLoopDuration()`, `isArrangerLoopEnabled()` (all settable, API ≥ 15), `playStartPosition()`, `getPosition()`, and `getInPosition/getOutPosition` (punch).
- `Application.getAction(id).invoke()` runs any of the 782 actions. Use `Application.focusPanel*`, `setPanelLayout`, `canUndo()`, `undo()`.
- `TimelineEditor.getHorizontalScrollbarModel()` has `zoomToContentRegion(start, end)` and `getContentPerPixel()`. We can re-zoom to a known region, but the current scroll offset cannot be read.

### C2. Relevant actions (from `GET /api/actions`, ids verbatim)

- **Selection:**
  - Single item: `Select first item`, `Select last item`, `Select next item`, `Select previous item`, `select_item_at_cursor`, `Unselect All`, `Select All`.
  - Lanes: `Select item in next lane`, `Select item in previous lane`, `Select item in first lane`, `Select item in last lane`.
  - Cursor (moves without selecting): `move_selection_cursor_to_first_item`, `…_to_next_item`, `…_to_previous_item`, `…_to_last_item`, `Move cursor to next lane`, `Move cursor to first lane`.
  - Spatial: `Select item to left/right/above/below`.
- **Time selection:** `switch_between_event_and_time_selection`, `move_time_selection_to_first_item`, `move_time_selection_one_event_later`, `extend_time_selection_range_to_next_item`, `select_start_of_selection_range`, `select_end_of_selection_range`.
- **Position probes:** `Loop Selection` ("Loop Selected Region"), `toggle_arranger_loop`, `jump_to_beginning_of_arranger_loop`, `jump_to_end_of_arranger_loop`, `play_from_time_selection`, `jump_to_playback_start_time`.
- **Panels and focus:**
  - Focus and toggle: `focus_or_toggle_arranger`, `focus_or_toggle_clip_detail_editor`, `focus_track_header_area`, `Focus panel above/below/left/right`, `Focus next panel`.
  - Layout: `toggle_arranger`, `Toggle maximized editing mode`, `Toggle Track Timeline vs. Clip Content Editing`.
- **Zoom:** `arranger_zoom_to_selection`, `arranger_zoom_to_fit`, `arranger_zoom_to_fit_selection_or_previous`, `Zoom to Selection`, `zoom_to_fit_selection_or_previous`, `detail_editor_zoom_to_fit`.
- **Tracks:** `Select next track`, `Select previous track`, `select_track1…40`, `Enter Group`, `Exit Group`, `toggle_all_track_groups_expanded`.
- **Other:** `open_in_editor`, `Toggle Edit View`, `Undo`, `Redo`.

### C3. Crawler design (M-H)

Implement it in Java on the control thread as a state machine driven by `host.scheduleTask`. Expose it as `POST /api/crawl {scope: "track"|"all"}`, with progress at `GET /api/crawl`. This is a new endpoint, separate from `/api/edit`.

```
SAVE   loopOn=isArrangerLoopEnabled, loopStart, loopDur, playStart=playStartPosition,
       followPlayhead=arranger.isPlaybackFollowEnabled, origTrackIndex=cursorTrack.position(),
       origClipFingerprint = hash(cursor clip notes + length + track)
       (optional) run "Loop Selection" once now to learn the original clip's position = origPos
PREP   arranger.isPlaybackFollowEnabled.set(false); focus_or_toggle_arranger (ensure arranger has focus)
       select_track1 (or cursorTrack.selectFirst) ; "Select first item"
LOOP   wait until cursor clip settles (no observer callbacks for ~60 ms, max 500 ms)
       invoke "Loop Selection"; wait for arrangerLoopStart/Duration observers (max 300 ms)
       record {track: cursorClip.getTrack().name, trackIndex, pos: loopStart, len: loopDur,
               playStart, loop*, notes[...], fingerprint}
       if (pos,trackIndex) already seen  → lane exhausted:
            "Select item in next lane" (or "Select next track" + "Select first item")
            if trackIndex didn't change → DONE
       else "Select next item"
RESTORE transport loop start/dur/enabled ← saved; playStartPosition ← saved;
        reselect original clip: select_track<origTrackIndex+1>, "Select first item",
        step "Select next item" until loopStart==origPos (or fingerprint matches),
        then restore loop again; arranger zoom: scrollbar.zoomToContentRegion(around origPos)
        followPlayhead ← saved
```

**Position-probe alternatives**, in order of preference:
- (a) `Loop Selection` + `arrangerLoopStart/Duration`. Prior art: the modwig `playFromSelection` mod (https://github.com/andyshand/modwig/blob/master/extra-resources/default-mods/playFromSelection.bitwig.js) saves the loop, runs `Loop Selection`, and restores it.
- (b) The Bitwig 6 Behaviour setting "move play start marker via events and time". With it on, selecting a clip moves the play-start marker, so read `playStartPosition()`. This avoids touching the loop, but depends on a user setting (M; VI-Control thread 170956, snippets only).
- (c) No mutation at all: fingerprint the cursor clip and match it against the DAWproject placements. Aliases make this ambiguous.

**Output.** A `parts[]` live score with the same shape as `dawproject.js`. Score mode can then run with no export, or **refresh** an export's stale tracks.
- Aliases: identical fingerprint and the same Pattern give one note source with several placements.

### C4. Risks

| Risk | Assessment | Mitigation |
|---|---|---|
| Undo-history pollution | Selection changes are normally **not** undoable in Bitwig (L). Loop-region changes **may** be (unknown). | Test T3 below. If they are, restore by setting values rather than by undo, and accept the entries, or use probe (b). |
| Visible UI jumping | The arranger scrolls and the selection flickers. The Clip editor follows the selection. | Disable follow-playhead, crawl while stopped, show a "crawling…" overlay, offer a "crawl on demand" button only, restore zoom. |
| Timing / races | Observers update asynchronously after `invoke()`. Large clips take longer to deliver steps (GRID_WIDTH 16384). | Settle detection, per-step timeout, retry once. Expect about 100–200 ms per clip, so about 15 s for 100 clips. |
| Wrong focus | If the detail editor has focus, `Select next item` walks *notes*, not clips. | Invoke `focus_or_toggle_arranger` first, and verify by checking that the cursor clip *identity* changes and its notes are unaffected. |
| Playback | Changing the loop during playback alters what the user hears. | Refuse to crawl while `isPlaying`. |
| Group tracks / folded groups | `Select item in next lane` may skip folded groups. | Expand all groups first (`toggle_all_track_groups_expanded`) or use `select_trackN`, which only reaches tracks 1–40. |
| Audio / automation clips | The walk also selects audio clips; the cursor clip is then empty or doesn't exist. | Record them as non-note placements and skip. |

### C5. Minimal test plan

Run this with the user's consent, in a **copy** of a small project (two tracks, three clips each, one alias, one audio clip), never in Mega Man 2. Each step is one action. The lead triggers it through a temporary debug op, then reads `/api/notes`, `/api/play` and a new `/api/transport` (loopStart, loopDur, loopOn, playStart, canUndo).

- **T0 Baseline.** Read `/api/transport` and `/api/notes`. Note the visible clip and the Undo menu text.
- **T1 Focus.** Invoke `focus_or_toggle_arranger`. Expect no visible change except focus.
- **T2 Walk.** `Select first item`, then `Select next item` ×3. After each step, check that `/api/notes` changes to the next clip on the **same track**, and record the track.
  - Then `Select item in next lane`: does it go to the next track at the same time?
  - Also try the API alternative `arrangerCursorClip.selectNext()`.
- **T3 Position.** `Loop Selection`. Check that `loopStart`/`loopDur` equal the clip's arranger start and length. Check whether Bitwig's Edit menu now shows "Undo Set Loop…". Restore the loop by setting the values directly, and check that the project-modified flag `Project.isModified()` and the undo entry are as expected.
- **T4 Alias.** Select two alias clips. Does the fingerprint match, and is the position different?
- **T5 Audio clip.** What do `exists` and the notes report?
- **T6 Restore.** Re-select the original clip by stepping. Measure the wall time per step.
- **T7 Probe (b).** With the Behaviour option "move play start marker" ON, repeat T2 and read `playStartPosition` instead of using the loop.
- **Pass criteria:** positions are exact to 1/24 beat, nothing undoable is created (or only loop entries), the original selection and loop are restored, and a step takes at most 250 ms.

### C6. Prior art (M)

- No published extension enumerates arranger clips.
- KVR (May–June 2026) has users asking for arranger clip APIs, with no staff answer: https://www.kvraudio.com/forum/viewtopic.php?p=9252574
- DrivenByMoss limits sequencing to launcher clips.
- The modwig `playFromSelection` mod is the closest working technique (action + loop readback + restore).
- A VI-Control script (thread 170956) uses the "move play start marker" setting to read positions.

---

## D. "New Score" wizard

### D1. API capability (H, from `javap`)

**Tracks.**
- Create with `Application.createInstrumentTrack(pos)`, `createAudioTrack` or `createEffectTrack`, or with the actions `Create Instrument Track` / `Create Group Track`.
- Name with `Track.setName` / `DeviceChain.name().set`.
- Move with `InsertionPoint.moveTracks(...)` (Track `afterTrackInsertionPoint` / `beforeTrackInsertionPoint`).
- Grouping: the `Group` action (Editing) on selected tracks, or `Create Group Track` + `moveTracks` into the group via `navigateIntoTrackGroup` / insertion points (M, needs testing).

**Devices.** `DeviceChain.endOfDeviceChainInsertionPoint()`, then any of:
- `insertVST3Device(String id)`. VST3 ids are in the DAWproject, e.g. BBCSO `56535453616E746262632073796D7068`, Kontakt 8 `5653544E694B386B6F6E74616B742038`.
- `insertCLAPDevice(id)`, `insertVST2Device(int)`, `insertBitwigDevice(UUID)` (Note FX Layer = `96456481-4c52-423a-8485-4604b15d0183`).
- `insertFile(path)` for `.bwpreset`, `.vstpreset`, `.multisample`… This loads an articulation map preset or a full instrument preset.
- `browse()` opens the browser.

**Presets.**
- `Device.loadPreset(i)` and `switchToNext/PreviousPreset` cover Bitwig's preset list.
- `createDeviceBrowser` / `PopupBrowser` give programmatic browsing: results column, `commit()`.
- **BBCSO patch selection cannot be set by parameters.** Use a saved `.vstpreset`/`.bwpreset` per instrument; the vstpresets in the full export are exactly that.

**Clips.** `ClipLauncherSlot.createEmptyClip(beats)` and `Track.createNewLauncherClip`. Arranger clips only via the `create_clip` action at the time selection.

### D2. Recommended wizard flow

1. The user picks an ensemble template (e.g. Classical orchestra, String quartet, Chamber winds) or instrument cards.
2. For each card: `createInstrumentTrack(end)`, then `setName`, then `insertFile("…/Score View/Cards/BBCSO Violins 1.bwpreset")`.
   - Each card is a Bitwig Instrument Layer or Chain preset containing the JSONBach articulation map plus BBCSO with the patch preloaded. We create one per instrument once, in Bitwig, and save it to the library.
3. Group tracks by family with the `Group` action.
4. Set the colour from the FCT/instrument family.
5. Save the card metadata (`articulations`, range, clef, transposition) in `SV.instruments`.

### D3. Installed instruments on this machine (H, folder scan)

**VST3** (`C:\Program Files\Common Files\VST3`):

- **Orchestral and cinematic:**
  - Spitfire: BBC Symphony Orchestra, Abbey Road One/Two, Appassionata Strings, Eric Whitacre Choir (+ Evo Grid), Hammers, Fractured Strings, Symphonic Motions, Aperture – The Stack, Fink – Signatures, Lea Bertucci – Xtended Vox, Oliver Patrice Weder (OPW, The Pool Project), BlankFor.ms Tape Synths.
  - Spitfire Originals: Cimbalom, Cinematic Frozen Strings, Cinematic Percussion, Epic Brass & Woodwinds, Epic Choir, Epic Strings, Felt Piano, Firewood Piano, Intimate Strings, Media Toolkit, Mrs Mills Piano, Rare Flutes.
  - Also: Sonuscore (Augmented BRASS/STRINGS/WOODWINDS/VOICES/MALLETS/GRAND PIANO/PERSIA/YANGTZE), Opus (EastWest), SINE Player (Orchestral Tools), UJAM Symphonic Elements (SE-STRIIIINGS/BRAAASS/PERRCS/DRUMS), Pocket Strings, BEAUTYFLUTE Pro, Choral, Virtual Pianist.
- **Samplers and hosts:** Kontakt / Kontakt 7 / Kontakt 8, Komplete Kontrol, Play (EastWest), Battery 4, Reaktor 6, Playbeat 4.
- **Synths:**
  - Arturia V Collection: ARP 2600, Acid V, Analog Lab 4/V, B-3, Buchla Easel, CMI, CP-70, CS-80, CZ, Clavinet, DX7, Emulator II, Farfisa, Jun-6, Jup-8 V4, Jup-8000, MS-20, Matrix-12, Mellotron, Mini V4, MiniBrute, MiniFreak V, Modular, OP-Xa, Piano V3, Prophet-5, Prophet-VS, SEM, SQ80, Solina, Stage-73, Synclavier, Synthi, Synthx, VOX Continental, Wurli.
  - Others: Pigments, Serum 2, Massive / Massive X, FM8, Absynth 6, Dexed, Kilohearts bundle, USYNTH, Chroma, Freak, Phasis, Solar, Panflow, Aparillo, Bite, Driver, Flair, Pendula, Raum, Replika/XT.
- **UJAM virtual instruments:** VB-*, VD-*, VG-*, VP-*, GM-ONE, BM-VICE, FIN-*.
- **MIDI tools:** Scaler 3, Fluid Chords (1 and 2), Fluid Pitch, Chordjam, Harmony Bloom, Filterstep, Gatelab.

**CLAP:** Chordjam, Dexed, Soundbox.

**VST2:**
- `C:\Program Files\VSTPlugins` and the same set under `Vstplugins`: largely duplicates, plus Kontakt 5, Absynth 5, Guitar Rig 5.
- `C:\Program Files\Steinberg\VSTPlugins`: iZotope, Ample Guitar L.
- `F:\VST`: Arturia dlls, plus EastWest, Spitfire, Indie/LSS string quartets, Super Audio Cart, Gregor Quendel, Crow Hill, Sonuscore lo ki, Waves libs…

**Kontakt / NI libraries** (Service Center list): Session Strings (Pro), Session Horns, Symphony Series Percussion, Emotive Strings, Action Strings/Strikes, Gentle Winds, Modal Runs, Kinetic Metal, Una Corda, The Giant, The Maverick, Scarbee keys and basses, Session Guitarist, many ethnic collections, Native Browser Preview Library.

**Palette idea.** Use family → card → articulation set. For non-BBCSO libraries, a card carries its own keyswitch table, entered once in Score View and stored in localStorage or a JSON file.

---

## E. Kontrol S88 MK3

- **This machine** (H):
  - USB `VID_17CC&PID_2120`, with interfaces MI_00 (MIDI), MI_03 "ODR" (display/LED bulk channel used by NI's service) and MI_04 (DFU).
  - Windows MIDI Services endpoints: `KONTROL S88 MK3`, `MIDIIN2/MIDIIN3 (KONTROL S88 MK3)`, `MIDIOUT2/MIDIOUT3 (KONTROL S88 MK3)`.
  - Services running: `NIHardwareService`, `NIHostIntegrationAgent`, `NIHardwareConnectionService`.
  - Bitwig 6.1.3 prefs reference `MIDIIN2/MIDIOUT2 (KONTROL S88 MK3)` and `MIDIIN3` as controller ports, so a Kontrol integration is configured.
  - There is also a **Launchkey MK4 49** and a Minilab3.
- **Protocol** (H, from DrivenByMoss source; NI's spec is NDA-only):
  - NIHIA v3 on the DAW port.
  - Handshake CC 0x01 (HELLO, value = protocol version) on channel 16 (0xBF). Transport CC 0x10–0x18, navigation 0x30–0x36, volume 0x50+, pan 0x58+, parameter changes 0x70.
  - Display and state via SysEx `F0 00 21 09 00 00 44 43 01 00 <cmd> …` (0x40–0x4B track info and names, 0x70–0x76 plugin/parameter names and values, 0x19 tempo).
  - Sources:
    - https://github.com/git-moss/DrivenByMoss/tree/master/src/main/java/de/mossgrabers/controller/ni/kontrol/mkii (LGPLv3)
    - https://community.native-instruments.com/discussion/comment/141434
- **Bitwig's own support** (H/M):
  - Bitwig ships the "Kontrol S-Series Mk3" extension (https://downloads.bitwig.com/extensions/Kontrol_S-Series_Mk3.pdf).
  - Firmware 2.x deep integration (browser, presets, remote pages) needs Bitwig ≥ 5.3.13 (NI KB 69000879637).
  - DrivenByMoss supports the MK3 since 24.3.0.
- **MIDI mode** (SHIFT+SETTINGS) turns encoders and buttons into user-template CCs. This is the clean way for Score View to get 8 encoders and buttons without NIHIA (https://docs.native-instruments.com/online-guides/kontrol-s-mk3-manual/en/midi-mode). The downside is losing Bitwig's DAW integration while in that mode.
- **Light guide** (M macOS / L Windows):
  - Not available over MIDI.
  - The reverse-engineered path is NI's Hardware Connection Service msgpack-RPC socket: 128 LEDs indexed by note, palette + intensity. See https://github.com/tillt/KompleteSynthesia/discussions/29 and gist skylerwshaw/be4b39e…
  - The other path is raw USB bulk, which kills MIDI.
  - The Windows transport (likely a named pipe) is undocumented. Treat this as a research spike only.
- **Recommendations:**
  1. Score View reads notes from the shared main port with Web MIDI (see F).
  2. Map Score View functions to the S88's **MIDI-mode** user template (encoders = caret, reading cycle, articulation wheel). Alternatively, have *our Bitwig extension* expose `RemoteControl`-style bindings so the official Bitwig MK3 script's encoders drive Score View parameters, e.g. a Score View "device" page. (M)
  3. Writing to the screen needs NIHIA ownership of the DAW port, which conflicts with Bitwig's script. Only consider it as an alternative "Score View controller" extension that replaces the Bitwig script. DrivenByMoss code is LGPL, so it is reusable with attribution.
  4. The Launchkey MK4 is a fully documented alternative surface: Novation publishes a programmer's reference with SysEx screen and pad LEDs. That makes it a good candidate for radial-menu and pad "skill bar" UI. (M, worth a look)

## F. Web MIDI on Windows (Windows MIDI Services)

- **Present and running** (H): `midisrv` (Windows MIDI Service, Manual start, Running). PnP shows the S88/Launchkey endpoints under `SWD\MIDISRV\…` and WinMM-compatible names under `SWD\MMDEVAPI\…`.
- **Multi-client** (M): Microsoft says every MIDI 1.0 port and MIDI 2.0 endpoint is multi-client, including WinMM apps routed through the service. Chrome's Web MIDI uses WinMM by default, so Chrome and Bitwig should both be able to open `KONTROL S88 MK3` at the same time. Sources:
  - https://blogs.windows.com/windowsexperience/2026/02/17/making-music-with-midi-just-got-a-real-boost-in-windows-11/
  - https://devblogs.microsoft.com/windows-music-dev/windows-midi-services-rollout-known-issues-and-workarounds/
- **Caveats:**
  - Do **not** enable `#use-winrt-midi-api`. It had a timestamp bug that dropped input (fixed by the April 2026 rollout, but there is no need for it).
  - Keep the S88 in MIDI 1.0 mode.
  - Devices hot-plugged after Chrome starts may not appear until reload.
  - "NI Service" virtual ports were sometimes invisible; restarting `midisrv` helps.
  - Both apps receive every note. Score View must not echo notes back into Bitwig.
  - Don't open the DAW port (`MIDIIN2/MIDIOUT2`) from the browser while Bitwig's Kontrol script uses it: two HELLO hosts would fight.
- **Alternative without Web MIDI** (H): our extension can open its own MIDI input. `defineMidiPorts(1,0)` with the user assigning the S88 main port in the controller settings, then forward events to the page via `/api/midi` long-poll or SSE. This works regardless of the Windows stack and keeps Bitwig's timing. Web MIDI is still simpler for low latency in the page.

## G. Note-entry prior art and HCI: design principles for "play, then sculpt"

### Prior art in brief

- **Finale**
  - Speedy Entry: duration key + MIDI pitch, one note at a time.
  - HyperScribe: real-time transcription; quantize settings must be chosen up front.
  - JW Rhythm Copy: pastes a rhythm on its own.
- **Sibelius**
  - Keypad layouts for durations, accidentals and articulations.
  - Flexi-time: real-time recording that needs cleanup afterwards.
  - Re-input Pitches (Ctrl+Shift+I): keeps the rhythm, replaces the pitches.
- **Dorico**
  - A persistent **caret**; chord mode (Q) holds the caret.
  - **Lock to Duration (L)**: the rhythm is kept while new pitches fill it.
  - **Pitch before Duration (K)** with a shadow note.
  - **Insert mode (I)**.
  - **Popovers**: typed micro-language, e.g. Shift+I "3" adds a third.
  - Docs: https://www.steinberg.help/r/dorico-pro/6.1/en/dorico/topics/write_mode/write_mode_caret/write_mode_caret_r.html and https://steinberg.help/dorico/v4/en/dorico/topics/write_mode/write_mode_note_input/write_mode_notes_pitch_changing_rhythm_locked_t.html
- **MuseScore**
  - Modes: Rhythm-only, **Re-pitch**, Insert, and Real-time (auto metronome or tapped beat on a pedal).
  - https://musescore.org/en/handbook-advanced-topics/note-input-modes
- **StaffPad:** converts handwriting when you leave the bar; works in recommended passes (notes → articulations → slurs/hairpins).
- **Notion:** Sequencer Overlay shows the raw MIDI under the notation.
- **LilyPond/Frescobaldi:** relative-octave entry; rhythm operations (double, halve, copy rhythm, paste rhythm) as commands.
- **Trackers:** Nash's study of 1,000+ users finds "liveness" (tight edit–listen loops) drives flow and virtuosity (https://nime.org/proc/nash2012).
- **Guitar Pro 8:** command palette (Ctrl+E).
- **Research:**
  - Rhythm quantization as Bayesian inference: Cemgil, Desain & Kappen, CMJ 2000; Cemgil & Kappen, JAIR 2003; Nakamura et al. 2017, merged-output HMM, code public (https://arxiv.org/abs/1701.08343).
  - Pen notation input: Anstice et al. (Canterbury, about 3× faster).
  - Marking menus: Kurtenbach & Buxton. Self-revelation, guidance, rehearsal; marks 3.5× faster than menu use; about 8 items × 2 levels.
  - Aim assist: Bateman, Mandryk, Stach & Gutwin, CHI 2011 (target gravity / area cursor reduce the skill gap); Gutwin et al., CHI PLAY 2016 (helping vs. learning).
  - Bubble cursor: Grossman & Balakrishnan, CHI 2005.

### Design principles

1. **Rhythm and pitch are separable and lockable.** Provide lock-rhythm (re-pitch from MIDI) and lock-pitch (re-rhythm from taps or cells). The lock turns itself off at the end of the selection, as in Dorico. *Implements: rhythm-first + MIDI pitch fill.*
2. **The caret is the reticle.** It is persistent and visible, advances on single notes and holds for chords. Bind it to an encoder; a held key or pedal gives chord mode.
3. **Readings, not a quantize setting.** Every played passage yields the top-N rhythm hypotheses (MAP + 2–4 alternatives) with scores. An encoder cycles them, and the score animates between them. This is the "aim assist" for time.
4. **Never destroy the performance.** Keep raw onsets as a faint overlay (Notion). Readings are views; "commit" writes the quantized notes into the clip. Undo restores the raw notes.
5. **Assist quietly and proportionately, with a visible strength control.** Gravity scales with confidence. Expose an "assist" slider, and let experts turn it down (Gutwin 2016).
6. **Snap to the nearest valid target (bubble cursor).** Harmonic snapping goes to the nearest chord or scale tone, using the FCT harmony model. Rhythm snapping goes to the nearest cell in the active cell set, not a uniform grid.
7. **Rhythm-cell skill bar = reusable named rhythms.** 8 slots, mapped to pads or number keys. Fill a slot from a selection; firing a slot lays the cell at the caret, ready for MIDI pitch fill.
8. **Radial menus that rehearse the expert gesture.** At most 8 items × 2 levels. The same press-hold-flick works without looking. Use them for articulations, dynamics and motif operations.
9. **Contextual actions.** What the "A button" does depends on the selection: note → articulation wheel; phrase → motif operations (transpose by scale degree, invert, retrograde, augment/diminish); empty bar → cell bar.
10. **Audition every edit immediately.** Play the changed span through Bitwig with the existing `audition` op, extended to a span. Liveness is the top predictor of flow.
11. **Direct keys plus a typed palette.** One-key bindings for the top 20 operations, and a Dorico-style popover or command palette for the long tail (`3` = add third, `q=120`, `pizz`, `cresc 2`).
12. **Work in passes, commit late.** Play → accept reading → sculpt pitch → articulations/dynamics. Nothing is committed to Bitwig until the caret leaves the bar or the user confirms. This also limits undo noise.
13. **Mode is always visible.** Insert vs. overwrite, lock state and assist level appear in the toolbar and on the controller screen or LEDs.
14. **Relative pitch input.** Encoder steps can mean scale degrees, not semitones. Octave is inferred from the previous note (LilyPond relative mode).
15. **Respect both novices and experts.** Keep the slow, visible path, such as the toolbar and menus, alongside the fast path.

## H. Bitwig 6.x changes that affect our plans (H)

- **6.0** (11 Mar 2026):
  - Clip **aliases** / shared Patterns (affects crawler and edit propagation).
  - **Automation clips**.
  - **Project key signature** (Root Note/Scale, transport-automatable).
  - **Note Expression Lane** (also shows velocity, chance, release).
  - Expression Overlay.
  - **Arranger Overdub**.
- **6.1** (26 Aug 2026): mostly the Sampler rework, Tuner and Merge Duplicate Patterns (action `merge_duplicate_patterns` / `…_for_project`). New controller scripts: Reliq, Erae 2, NI NKS Connect.
- **Not in either release:** notation or score view, articulations.
- **API 25 vs 24:** only beta `TrackBankContentFilter` overloads (`Track.createTrackBank(id, name, …, filter, userConfigurable)`) and `TrackBank.setContentFilter`. There is no new clip, arranger, note or key-signature API. Since bitwig-extensions switched to API 25 on 2026-03-26, API 25 is the minimum for Bitwig 6.
- **Implications:**
  - Keep the cursor-clip architecture.
  - Use `ALL_CHANNELS` track banks (beta) to see nested tracks inside groups for the tracks list.
  - Treat the project key as unknown (auto-detect), or let the user set it.

---

## Next experiments (ordered)

1. **Articulation module, offline** (no consent needed).
   - Implement `features/articulations.js` with the static BBCSO table.
   - Test on the fixture: Violin 1 keys 0/4/6, Cello 8, Trumpet 2/3.
   - Screenshot slurs, staccato and pizz.
2. **DAWproject plugin-state parsing.** Extend `dawproject.js` to read `plugins/*.vstpreset` → `<SPITFIREAUDIO_AUNTIE>` articulation tables, and the BBCSO "Dynamics"/"Expression" automation lanes. Add a test with the full export copied into a fixture, keeping only the needed vstpresets.
3. **Dynamics derivation prototype** on Trombones (61 Dynamics points) and Violin 2.
4. **Web MIDI multi-client check** (2 minutes, user present). Open a test page in Chrome listing `navigator.requestMIDIAccess()` inputs while Bitwig is running. Play the S88 and confirm both Bitwig and the page receive notes.
5. **Crawler tests T0–T7** (§C5), in a scratch project with consent. Add the Java debug ops `/api/transport` and `act <actionId>`, behind a setting that defaults to off.
6. **`arrangerCursorClip.selectNext()` probe.** It may walk clips without UI actions. This is one line in the debug op.
7. **Keyswitch write-back undo granularity.** Add plus delete in one flush: is it one undo step or several?
8. **Wizard spike.** In a scratch project, `createInstrumentTrack` + `insertFile(<JSONBach Strings map>)` + `insertVST3Device(BBCSO id)`, then `Group`.
9. **S88 MIDI-mode template.** Design a Score View user template (encoders: caret / reading / assist / articulation). Compare it with binding through Bitwig's MK3 script via remote controls.
10. **Light guide spike** (optional, low priority). Investigate the Windows transport of NI's Hardware Connection Service before committing to "light-guide hints".
