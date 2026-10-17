# harmony — Functional Color Theory
`web/features/harmony.js` · loads 5th

## Purpose
The user's Functional Color Theory, live in the score: key / function analysis, note colours, a Roman-numeral ribbon,
overlays and aim assist (Alt+Shift+↑ on a live note). H toggles, Shift+H cycles views.

## Owns
- Toolbar: **Colors ▾** `#hvBtn`, panel `#hvPanel` (legend `#hvLegendBtn`).
- `SV.harmony` (`analyze()`, …). Pure engine for Node: `require('web/features/harmony.js')` →
  `analyzeFull(score, opts)`, `decorate(score, analysis, settings)`.
- localStorage `scoreview.harmony.settings`.

## Hooks
`transformScore`, `afterRender`, `keydown`. Read by notation (key changes), motifs and entry.

## Tests
`test/harmony-test.mjs`, `test/harmony-e2e.mjs`; theme-e2e checks harmony colours on dark paper; `test/popover-e2e.mjs` checks that
the bar-1 numeral keeps clear of the tempo mark (numerals touching tempo / rehearsal / text marks move up, or right at
the top of the page).

## Docs
docs/functional-color-theory.md (the system), docs/harmony.md (this implementation).
