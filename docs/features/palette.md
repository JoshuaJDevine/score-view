# palette — command palette and shortcut sheet
`web/features/palette.js` · loads 26th (after statusbar, before layout)

## Purpose
**Ctrl+K** (or **Ctrl+J**, or "⌕ Commands" in the app bar) opens a search box over every command the page offers:
toolbar and header buttons, segmented controls ("Mode: Score", "Bars: Whole song"), checkboxes (toggle, with their
on/off state), each option of a select ("Key: B♭ / gm", "Quantize: 8th"), items of menus whose panels are in the page
("Tracks: All tracks"), and every `SV.shortcuts` entry with its keys. Words match as substrings or word starts, every
word must match; with no query the recently run commands come first. Keyboard only: ↑/↓ (Tab) move, Enter runs, Esc
closes; keys typed there never reach the score. A shortcut runs by sending its key to the score; one that only works in
another context (e.g. note entry, a drag) says which key to press instead.

**?** opens the shortcut sheet: `SV.shortcuts.list()` grouped by task (Select and edit notes, Note entry,
Articulations and dynamics, Rhythm and harmony, Develop and orchestrate, Playback, Controller, App), with a filter.

## Owns
- `#svPaletteBtn` (placed by layout.js), overlays `#svPalette` (`#svPaletteInput`, `#svPaletteList`) and `#svKeySheet`
  (`#svKeySheetFilter`, `#svKeySheetBody`).
- Keys (registered): Ctrl+K / Ctrl+J (always), ? (always; not while typing in a text field). A capture-phase listener, so
  they work in note entry and from any control.
- `SV.palette`: `open()`, `close()`, `isOpen()`, `commands()` (the collected list: `{id, kind: button|checkbox|radio|
  option|key|info|app, label, ctx, keys?, state?}`), `run(cmd)`, `openSheet()`, `closeSheet()`, `sheetOpen()`,
  `recent()`, plus the pure helpers `fuzzyScore`, `rank`, `groupByTask`, `taskOf`, `keyInit`, `cleanLabel`.
- localStorage `scoreview.palette.recent` (ids of the last 12 commands run).

## Hooks
None. Reads `SV.shortcuts`, `SV.entry.state` (which shortcut contexts are live), `SV.toasts`, `SV.layout`.

## Tests
`test/gui-test.mjs` (matching, ranking, keys, task groups), `test/gui-e2e.mjs` (Ctrl+K / Ctrl+J, a checkbox, a select
option, a shortcut entry, recent first, keys stay in the palette, the sheet and its filter).
