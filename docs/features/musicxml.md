# musicxml — MusicXML 4.0 export
`web/features/musicxml.js` · loads 14th

## Purpose
Exports the engraved score as MusicXML 4.0 (score-partwise) for Dorico. The source is the MEI of the current render,
so the export matches the screen: spelling, voices, ties, beams, tuplets, clefs, keys. Notes are written pitch, with
`<transpose>` for transposing parts.

## Owns
- Toolbar group `#mxGroup`: `#mxExport`, range `#mxRange`, `#mxSingle`.
- `SV.musicxml`. localStorage `scoreview.musicxml.*`.

## Hooks
`buildOptions`, `afterRender`. Reads `SV.instruments`; read by print.

## Tests
`test/musicxml-test.mjs` (XSD validation, Mega Man 2), `test/e2e-musicxml.mjs` (export from the page); round trips
in import-test and articulations-test.
