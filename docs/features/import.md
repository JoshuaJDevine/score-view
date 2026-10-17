# import — MusicXML / MIDI import into the live clip
`web/features/import.js` · loads 16th

## Purpose
Parses MusicXML (.musicxml / .xml / .mxl) or MIDI (.mid) into one beat-based model and imports a part (bar range,
transposition, target bar) into the live Bitwig clip.

## Owns
- Toolbar group `#sviGroup`: **Import…** `#svImportBtn`, hidden `#sviFile`; dialog `#sviDialog` (`#sviGo`, …).
- `SV.import` (`parseFile`, `parseMidi`, `parseMusicXML`, `planImport` → `/api/edit` ops).
- localStorage `scoreview.import.*`. Sends the ops in chunks, waiting for Bitwig to report each chunk.

## Hooks
`liveData`. Reads `SV.entry`.

## Tests
`test/import-test.mjs` (parsers, round trip, `planImport`; MIDI files from `test/midi-file.mjs`),
`test/import-e2e.mjs` (dialog, chunked import, score mode; uses PORT and PORT+50).
