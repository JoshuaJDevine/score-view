# Score View

**A live music-notation view and editor for Bitwig Studio.** Score View shows the clip selected in Bitwig (or the whole
arrangement) as engraved notation and lets a composer edit it from the score: the way Sibelius, Finale or Dorico users
think, inside a DAW that has no notation view.

Score View is a Bitwig Studio 6.1 controller extension (Java) that serves a web page on `127.0.0.1:8765`. The page turns
Bitwig's note data into MEI and engraves it with [Verovio](https://www.verovio.org/). Edits are sent back to the extension and
applied to the clip in Bitwig.

## Highlights

- **Clip and Score modes.** The clip view is live. **⟳ Read project** reads every arranger clip into a full score
  that includes tuplets, voices, clef, meter, tempo and key changes, 8va, rehearsal marks and articulations. The read
  is stored per project and kept current as you work.
- **Score rhythms.** A sampler performance is written as the rhythm it means, not as played: notes a little early or
  late and lengths a little short or long are read as the plainest value that fits, while real 16th runs and tuplets
  stay.
- **Editing from the score.**
  - Keyboard and mouse editing.
  - Sibelius-style note entry: keypad durations with Dorico and MuseScore layouts, Alt+digit intervals, and MIDI input
    from a keyboard.
  - Passage selection with copy and paste between staves.
  - Motif tools.
  - Orchestration: explode, double and reduce into other tracks' clips.
- **Render dynamics.** Dynamic marks and hairpins can be previewed, or recorded as real Bitwig automation on each
  sample library's own controls. Library profiles cover Spitfire BBC SO, Crow Hill Pocket Strings and Arturia Pigments.
  Hairpin shapes can be changed: S-curve, linear, late or early swell, and messa di voce. A slight human variation is
  added on top.
- **Articulations.** Keyswitch articulations are read from BBC SO / Bitwig articulation maps, engraved, and written back.
- **Harmony.** Analysis is coloured with *Functional Color Theory*, my own system for visualising harmonic function
  ([docs/functional-color-theory.md](docs/functional-color-theory.md)).
- **Inspire ▾.** Mood-based underscore chord pads, a melody over the chords, and *Continue the phrase*, which answers an
  8-bar question with a consequent phrase in both tracks.
- **New Score wizard.** Templates set up the tracks, plug-ins and articulation maps for a new score.
- **Import and export.** MusicXML 4.0 export for Dorico, MusicXML and MIDI import, DAWproject reading, and print or PDF
  output.
- **Interface.** A command palette (Ctrl+K), a shortcut sheet (?), a status bar, and light, dark and Bitwig themes.

## Engineering notes

- **Extension (Java 21), `src/claude/scoreview/`:**
  - an HTTP server with long-polling note and transport state
  - a registry of edit operations
  - a clip navigator that writes into other tracks' clips through the single cursor-clip API
  - an arrangement crawler
  - a curve player that records automation in real time, because the API cannot write automation points directly
- **Request hardening (`HttpGuard`):** Host and Origin allow-lists, a required custom header on anything that is not a
  read-only request, and no CORS, so other web pages cannot drive the DAW.
- **Front end:** plain JavaScript with no framework or bundler. It is split into a small core (`web/core/`) and about 30
  feature modules (`web/features/`) that plug into a documented hook API. Each module has a page in
  [docs/features/](docs/features/README.md).
- **Tests:** about 75 suites. Unit tests run in Node, and end-to-end tests drive headless Chrome against a mock of the
  extension (`test/mock-server.mjs`). A contract test keeps the mock in step with the Java operation table. GitHub
  Actions CI runs Java and JS checks plus the full suite.
- **Probe extension (`tools/probe/`):** used to test the Bitwig API's limits for automation, CC and per-note expression
  writing. The findings are in [docs/library-profiles.md](docs/library-profiles.md).

[docs/AGENTS.md](docs/AGENTS.md) is the architecture and API guide. I wrote this project with AI pair-programming
(Claude Code), and that guide is shared by human and AI contributors.

## Build and run

You need Bitwig Studio 6.1, JDK 21, Node 20+ and Git Bash on Windows (or any bash).

```bash
npm install            # also fetches the Bitwig extension API jar from maven.bitwig.com into lib/
bash build.sh          # builds ScoreView.bwextension and installs it into Bitwig's Extensions folder
                       # (BITWIG_EXT_DIR overrides the folder; --no-install only builds)
```

In Bitwig, add the **Score View** controller under Settings → Controllers, then open
<http://localhost:8765>. Chrome's `--app=` window works well.

```bash
npm run test:smoke     # fast tier
npm test               # all suites (mock server + headless Chrome; set CHROME if Chrome isn't found)
```

## Changelog

**2026-10-23**
- Score rhythms (View ▾, on by default): performances are read as the plainest intended rhythm before the Quantize grid;
  print and MusicXML export use the same reading.
- A read that began inside a track group (Bitwig's "first lane" stays in the selected clip's group) is refused with a
  prompt instead of storing a partial score.
- A clip selected in Bitwig is placed in the stored score only where the read agrees; Bitwig does not always move the
  play start marker to a clicked clip.

**2026-10-18**
- Bitwig is the only source: the DAWproject "Open" is gone, **Read arrangement** is now **⟳ Read project**, and a failed
  read opens a prompt that tries again once the cause is fixed.
- The read is stored per project, restored on reload and kept current as a mirror of the arrangement; targeted re-reads
  of changed tracks; listen-while-playing marks tracks whose clips changed.
- Faster engraving: Verovio runs in Web Workers, one system per chunk with a cache (a full score from ~9 s to well under
  1 s; an edit re-engraves one system), and inline glyphs instead of SVG `<use>`.
- The extension reports when note data has settled; the page no longer waits 600 ms after every change.
- New Score wizard: 10 templates in 3 categories, grouping after all tracks exist; a new score is stored like a read.

**2026-10-17**
- First public snapshot.

## Status

This is a personal project in active development by Joshua Devine. The source is public for reference, and no licence
has been chosen yet.
