# Feature modules

One page per module in `web/features/`: what it is for, what it owns, which `SV` hooks it uses and which tests cover
it. The hook API itself is in [docs/AGENTS.md](../AGENTS.md) ("Feature hook API"); these pages are a map, not a
spec — the module's header comment and its code are the authority.

Modules load in `web/index.html` order. Order matters: `notation` puts its `transformScore` hook first, and `layout`
loads last and sorts the toolbar the others filled.

| # | Module | Purpose |
|---|--------|---------|
| 1 | [instruments](instruments.md) | instrument database; clefs, labels, transposition, ranges per part |
| 2 | [articulations](articulations.md) | keyswitch articulations and dynamics, engraved and written back |
| 3 | [sections](sections.md) | section views, score order, family brackets |
| 4 | [rhythm](rhythm.md) | Q readings: cycle rhythmic interpretations of a bar |
| 4a | [library-profiles](library-profiles.md) | data: which controls a dynamics curve drives per library (shared with the extension) |
| 4b | [dynamics](dynamics.md) | dynamic marks + hairpins (H, Shift+H, Ctrl+E) and Render dynamics as Bitwig automation |
| 5 | [harmony](harmony.md) | Functional Color Theory analysis and colours |
| 6 | [motifs](motifs.md) | develop the selected figure; motif library |
| 7 | [orchestrate](orchestrate.md) | explode / double / reduce into other tracks' clips |
| 8–9 | [inspire](inspire.md) | quick starting material (underscore string chords), with its data file `inspire-library` |
| 10 | [entry](entry.md) | note entry mode (caret, letters, MIDI, rhythm-first) |
| 11 | [controller](controller.md) | MIDI Learn for entry actions on hardware controllers |
| 12 | [mouse](mouse.md) | drag pitch / time / length, marquee, clipboard |
| 12b | [passage](passage.md) | Sibelius-style passage selection; copy / paste between staves into Bitwig |
| 13 | [playback](playback.md) | rehearsal marks, transport from the score, solo / mute |
| 14 | [musicxml](musicxml.md) | MusicXML 4.0 export for Dorico |
| 15 | [arrangement](arrangement.md) | live arrangement read into Score mode, kept current as a stored mirror, listened to while playing (helpers: `arrangement-mirror`, `arrangement-listen`) |
| 16 | [import](import.md) | MusicXML / MIDI import into the live clip |
| 17 | [print](print.md) | print view and PDF |
| 18 | [theme](theme.md) | paper colour (light / dark / Bitwig) |
| 19 | [notation](notation.md) | clef changes, ottava, meter / tempo / key changes |
| 20–23 | [wizard](wizard.md) | New Score wizard, with its data files `wizard-plugins`, `wizard-presets`, `wizard-templates` |
| 24 | [toasts](toasts.md) | message stack and history |
| 25 | [statusbar](statusbar.md) | selection readout, entry duration, status controls |
| 26 | [palette](palette.md) | command palette (Ctrl+K / Ctrl+J) and the ? shortcut sheet |
| 27 | [layout](layout.md) | app bar (compact / classic), File ▾ / View ▾, toolbar clusters |

## Page template

```
# <module> — <one line>
File(s) · load position
## Purpose   what the user gets, in two or three sentences
## Owns      toolbar ids (SV.addToolbar(el, {cluster, order})), keys (SV.shortcuts.register), the SV.<module> API,
            localStorage keys (scoreview.<module>.*), extension endpoints it relies on
## Hooks     SV.hooks.* it pushes; other modules it reads (SV.<other>, always existence-checked)
## Tests     unit / e2e files (UI selectors the e2e tests use live in test/selectors.mjs)
## Docs      longer design notes, if any
```

When you change what a module owns or which hooks it uses, update its page in the same commit.
