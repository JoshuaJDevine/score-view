# layout — app bar, menus and toolbar clusters
`web/features/layout.js` · loads last (27th)

## Purpose
Arranges what the core and the other modules put on the page.
- "⟳ Read project" sits in the header as the primary action, right after Clip | Score, with its read status:
  "✓ N parts read · 3 min ago", or "· out of date" in the warning colour when `SV.arrangement.staleReasons()` is not
  empty (event `sv-read-stale`).
- The feature toolbar is sorted into clusters: Score · Write · Play · File · View · More (empty ones hidden). A
  MutationObserver sorts again when a module adds to the bar later.
- **Header layout** preference (View ▾ → Header layout; `scoreview.layout.header`):
  - **Compact** (default): one app bar that never wraps — Clip | Score · ⟳ Read project ·
    📌 Pin · Arranger | Launcher · ⌕ Commands · File ▾ · View ▾ · title (Instruments ▾ chooses the shown tracks). The feature
    bar is one row (cluster labels hidden, and the entry pill only shows while entry is on). The status bar (features/statusbar.js) holds Key, Quantize, Page / Single
    line, Zoom, Messages, Shortcuts, render time and the connection dot; the footer help only shows when opened.
    File ▾ = New empty score, Open .dawproject… (Score mode) and the File cluster (Export MusicXML, Import…,
    Print / PDF…, New Score…, Brief). View ▾ = Simplify rhythms, Follow, Hide empty staves, Hide keyswitches, Audition,
    Instrument names, Transposed score, Ranges, Dynamics, Marks, Paper, the View cluster, Header layout.
    At 1440×900: header 38 px + feature bar 33 px + status bar 28 px = 99 px of chrome (classic: 209 px in Clip mode,
    235 px in Score mode, footer included).
  - **Classic**: the old stacked rows; View ▾ holds only the View cluster and Header layout.
  The same elements move (ids unchanged, listeners kept) and go back to where they came from on a switch.
- Menus: a button inside runs and closes the menu; checkboxes, selects and segmented controls keep it open.
  Esc or a press outside closes it (Esc also reaches a dialog the menu opened, e.g. Brief). Opening a menu cancels a
  close still pending from the last command.

## Owns
- Cluster boxes `.svl-cluster[data-k=score|write|play|file|view|more]` (in `#featureBar`; File in `#svFileItems` in the
  compact header, View always in `#svViewMore`). Each module says where its group goes: `SV.addToolbar(el, { cluster,
  order })` (stored as `data-sv-cluster` / `data-sv-order`); inside a cluster lower `order` comes first, items without
  one follow in call order. A call without opts is placed by the old id guess (`guessCluster`), else **More**. Orders
  in use (module number × 10): instruments 10, articulations 20, sections 30, harmony 50, motifs 60, orchestrate 70,
  inspire 80, entry 100, controller 110, playback 130, musicxml 140, arrangement 150, import 160, print 170, theme 180,
  notation 190, wizard 200.
- Menus: View ▾ `#svViewMenu` / `#svViewBtn` / `#svViewPanel` (`#svViewItems`, `#svViewMore`, `#svHeaderSeg`),
  File ▾ `#svFileMenu` / `#svFileBtn` / `#svFilePanel` (`#svFileScore`, `#svFileItems`), Read ▾ `#svlReadMenu` /
  `#svlReadMore` / `#svlReadPop`. `html[data-header="compact"|"classic"]`.
- `SV.layout`: `header()`, `setHeader('compact'|'classic')`, `headers`, `reveal(elOrSelector)` (opens the menu holding
  it), `openMenu('view'|'file'|'read')`, `closeMenus()`.
- localStorage `scoreview.layout.header`.

## Hooks
`afterRender` (read status).

## Tests
`test/gui-e2e.mjs` (one row, ≈100 px, what sits where, menus, classic restores everything and persists),
`test/e2e-smoke.mjs` (Import… in File, Instruments ▾ in Score, unique ids), `test/shortcuts-e2e.mjs` (every group
asked for its cluster, sits there in order, the id fallback). Tests click moved elements with `clickIn` / `clickTool`
from `test/selectors.mjs` (they open the menu first) or start with `withPage({ header: 'classic' })`.
