# Orchestrate: writing into other tracks (GitHub #11)

Bitwig lets an extension write notes into **one** clip only: the arranger cursor clip, i.e. the selected clip.
Orchestration needs to write into other tracks, so Score View temporarily selects each target clip with Bitwig's
own selection actions (the same ones the arrangement crawler uses), writes the notes, and selects the original
clip again.

## How it works

```
page (web/features/orchestrate.js)                          extension (ClipNavigator.java)
  SV.state.crawl  ── clips: lane, track, start, playStart …
  per target track, one POST /api/edit batch:
     goto <lane> <clipStart> <track, URL-encoded>   ──►  Move cursor to first lane, next lane ×lane,
                                                         Select first item, Select next item … until the
                                                         play start marker = clipStart and the track matches
     add 0 x y vel dur   (x = round((beat − clip.start + clip.playStart) × 24))
     …                                                   (edit queue paused while a goto runs)
     gotoHome <lane of the original clip>           ──►  back to the clip that was selected before; play start
                                                         and collapsed groups restored
  poll GET /api/nav until `batches` increases, read `results`
  then put the notes into SV.state.crawl and rebuild the Score-mode base
```

* **Session.** The first `goto` starts a session: it remembers the selected clip (track + play start marker, which
  Bitwig moved there when the clip was selected), opens collapsed groups (lane numbers assume open groups, as in the
  crawl) and stops waking the page (it would see the other clips go by). `gotoHome` ends it. If no op arrives for
  2.5 s during a session, the extension returns home by itself (page closed mid-batch).
* **Safety.** While a `goto` runs, `drainEdits` does not take further ops. If a `goto` fails (clip moved or deleted,
  track not found), the following edit ops are **dropped** until the next `goto`/`gotoHome`, so they never land in
  the wrong clip. If the session cannot start (playing, Launcher source, no clip selected, crawl running) the whole
  batch up to `gotoHome` is dropped. `navCancel` (handled on the HTTP thread) aborts: everything except `gotoHome`
  is dropped.
* **Finding a clip.** The lane from the crawl is a hint. If the first item on that lane belongs to another track
  (tracks were added since the crawl), every lane is scanned once for the track. Then items are stepped until the play
  start marker equals the clip start (±0.0001 beat). Settle waits as in the crawler: ≥110 ms after each action, 80 ms
  without observer callbacks, at most 1.5 s; a state is trusted only when read twice 120 ms apart; an apparent end of
  lane is re-checked after 300 ms; at most 400 items per lane.

### Ops and endpoint

| op | meaning |
|---|---|
| `goto <lane> <startBeats> <track>` | select that arranger clip (track URL-encoded: `Flutes%20%20a3`) |
| `gotoHome [lane]` | select the clip that was selected before the first goto; ends the session |
| `navCancel` | abort the running batch (rest dropped, `gotoHome` still runs) |

`GET /api/nav` → `{ state: idle|running|done|error, message, session, batches, dropped, lastTarget:{lane, start, track,
home}, home:{track, start}, results:["ok: goto Viola @ 0", "error: goto … : why", "ok: home Piano @ 0"] }`.
`batches` counts handled `gotoHome` ops (finished sessions and refused batches); the page waits for it to increase.

## Using it

1. In Bitwig: click any clip in the Arranger (focus), press **⟳ Read project** in Score View.
2. Score mode: select notes of the live (✎) clip — or choose *Staves, bars* as the source in the dialog.
3. **Orchestrate ▾** (or the shortcut) opens the dialog; it stays open while you select notes:
   * **Explode** (<kbd>Alt</kbd>+<kbd>X</kbd>) — each chord's notes go top-down to the target instruments (ordered by
     range, then score order). One note per instrument: with more notes than instruments the top notes and the bass are
     kept; with fewer, instruments double (Vln I + II on the top note…). *Basses double the bass an octave lower*;
     *Keep instrument ranges* moves notes by octaves into the instrument's range (SV.instruments).
     Default targets: the source track's section (bracket), else the strings.
   * **Double** (<kbd>Alt</kbd>+<kbd>B</kbd>) — the line at unison, octave(s), or a diatonic third/sixth (key of the score)
     above/below in each target; the whole line is moved by the octave that fits the most notes into the range.
   * **Reduce** (<kbd>Alt</kbd>+<kbd>U</kbd>) — merges the chosen staves (bar range) onto one target track; optionally
     folded into its range.
4. The preview lists what each target gets and which targets cannot be written. **Write into Bitwig** sends one batch
   per target track. Targets without a clip at that place are reported — *"No clip on Basses at bar 1 — create one in
   Bitwig (or lengthen it), then Read project again"* — and nothing is written for them. Clips that loop more than
   once are refused (a note would repeat in every pass).
5. The written tracks are pinned for the session and the score is rebuilt from the updated crawl.

Undo: each written note is a Bitwig edit; use Bitwig's undo (or Ctrl+Z in the page, which sends `undo`) — several
times for several notes.

## Limitations

* Needs a live **crawl** (Score mode from a DAWproject export has no lanes/clip positions).
* The original clip is found again by the **play start marker**: if it was moved after selecting the clip, the page
  refuses ("Click the … clip in Bitwig again"). Requires the Bitwig behaviour that selecting a clip moves the play start
  marker (the crawler relies on it too).
* Notes must fall inside an existing clip; Score View cannot create clips. Notes are shortened to the clip end.
* Each onset of a passage is voiced on its own (no voice-leading across chords); a held note under moving voices
  can give an instrument overlapping notes.
* The selection visibly moves in Bitwig during a write (about 0.2 s per action: lanes + items before the target clip).
* Writing in the Launcher source is refused.

## Manual live test plan (lead; in a SAVE-AS COPY of a project, never the original)

Set-up: *File → Save As…* a copy of a small project with a group **Strings** (Violins 1, Violins 2, Violas, Cellos,
Basses), each with one MIDI clip over bars 1–8 (Basses: no clip in bars 1–4), plus a **Piano** track with a clip
holding a 4-note chord in bar 1 and a melody in bar 2. Collapse the Strings group. Open Score View.

| # | step | expect |
|---|---|---|
| L1 | Click the Piano clip, **⟳ Read project** | Score mode with the clips; `GET /api/nav` → `state: idle` |
| L2 | Select the bar-1 chord, <kbd>Alt</kbd>+<kbd>X</kbd>, untick Basses, *Write into Bitwig* | Bitwig's selection visits the string clips and returns to the Piano clip; group collapsed again; play start marker back on the Piano clip; Vln I/II/Vla/Vc each hold one chord note (check in Bitwig's editor); the page shows them |
| L3 | `GET /api/nav` | `state: done`, `results` all `ok`, `batches` = 4, `session: false` |
| L4 | Repeat with Basses ticked | dialog/flash: *No clip on Basses at bar 1 — create one in Bitwig*; the four others written again (unchanged); nothing in Basses |
| L5 | Select the bar-2 melody, <kbd>Alt</kbd>+<kbd>B</kbd>, Cellos, *Octave below* | melody an octave down in the Cellos clip at bar 2 |
| L6 | Move the Violas clip in Bitwig (don't re-read), explode again | Violas reported (*No clip on Violas starting at beat …*, *n notes not written*); **no stray notes in the Piano clip or elsewhere**; back on Piano |
| L7 | Start playback, try any write | refused: *Stop playback first* |
| L8 | Click the Piano clip, then click the ruler elsewhere (moves the play start), try a write | refused: *Click the Piano clip in Bitwig again* |
| L9 | Explode with a clip whose content starts later (clip start trimmed: playStart > 0) | notes at the right bar (x uses playStart) |
| L10 | Press Cancel in the dialog during a long batch (many targets) | stops; `gotoHome` still runs, Piano selected |
| L11 | Bitwig undo ×N | notes disappear one by one; selection changes are not in the undo history |
| L12 | Timing | note the time per target; expect < 2 s for lanes near the top |

Report any case where a note lands in a clip that was not the target — that is the one failure that must not happen.
