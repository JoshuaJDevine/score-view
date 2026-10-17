# statusbar — the line at the bottom
`web/features/statusbar.js` · loads 25th · markup `#svStatusBar` in `web/index.html`

## Purpose
Says what is selected: "1 note · Violin 1 · bar 5 beat 2.5 · F♯4 · dotted quarter · Legato" (several notes: count,
first – last position, lowest–highest pitch, the common length or "mixed lengths", the articulation from the track's
keyswitches when there is a map). While note entry is on it shows the entry duration ("Entry · dotted 8th · chord").
In the compact header (features/layout.js) the right side holds Key, Quantize, Page / Single line, Zoom, Messages,
Shortcuts, the render time and the connection dot. Pitch names are spelled in the key in force at the first selected
note (after a key change, the new key).

## Owns
- `#svSelInfo`, `#svEntryInfo`, slots `#svStatusTools` and `#svStatusRight` (filled by layout.js and toasts.js).
- `SV.statusbar`: `refresh()`, `text()`, pure `pitchName(p, spell)`, `durName(beats)`, `barBeat(beat, render, SB)`,
  `summary(notes, track, {render, SB, spell})`, `keyAt(render, beat)` (fifths in force at a beat).

## Hooks
None: refreshes on a 200 ms timer when its inputs changed (selection, clip version, entry state), and after mouse/key
releases. Reads `SV.articulations.mapFor/resolve`, `SV.entry.state` / `.DURS`.

## Tests
`test/gui-test.mjs` (names, bar/beat across a meter change, summaries), `test/gui-e2e.mjs` (one note, Ctrl+A, entry).
