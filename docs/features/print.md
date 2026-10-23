# print — print view and PDF
`web/features/print.js` · loads 17th

## Purpose
A print view with real pages (A4 or Letter, portrait or landscape), a title / composer header and page numbers, for
the full score or one part, engraved again at the paper size. The browser's print dialog ("Save as PDF") gets exactly
these pages. Ctrl+P.

## Owns
- Toolbar group `#svpPrintGroup`: **Print / PDF…** `#svpPrintBtn`. View `#svPrint` (pages `.svp-page`; controls
  `#svpGo`, `#svpClose`, `#svpPart`, `#svpPaper`, …), `#svPrintPages`.
- `SV.print` (`open()`, `build()`). localStorage `scoreview.print.*`.

## Hooks
`buildOptions`, `keydown`. Uses `SV.scoreModel()`; reads `SV.musicxml`, `SV.instruments`. Each page's glyph `<use>`s
are inlined like the paper's (`window.SvgInline`, web/core/svg-inline.js).

## Tests
`test/print-e2e.mjs` (whole score, a part, Letter landscape, PDF page count); theme-e2e checks the print view stays
white.
