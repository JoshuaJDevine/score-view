# theme — paper colour, chrome and density
`web/features/theme.js` · loads 18th

## Purpose
Light paper (default), dark paper (warm near-black with cream ink) or Bitwig (Bitwig's dark grey). Applied as a class
on `<html>`; the SVG inherits the ink, so switching needs no re-render. Harmony colours, selection, playhead and caret
are re-tuned for dark paper. Printing always uses white paper.

## Owns
- Toolbar group `#svpGroup`: Paper `#svpSel` (File cluster; in the compact header layout.js shows it in View ▾).
- `SV.theme` (`get`, `set('light'|'dark'|'bitwig')`, `modes`, `isDark`; `chrome`/`setChrome('dark'|'light')`,
  `density`/`setDensity('normal'|'compact')` — no toolbar control yet; light chrome is not ready for feature panels).
- localStorage `scoreview.theme.paper`, `scoreview.theme.chrome`, `scoreview.theme.density`.
- Dark paper sets the `--sv-*` tokens of `web/style.css`; the old names (`--paper`, `--sel`, …) follow.

## Hooks
None (CSS classes only).

## Tests
`test/theme-e2e.mjs` (contrast checks, persistence, print stays white; uses `test/selectors.mjs`), `test/popover-e2e.mjs` (tokens).
