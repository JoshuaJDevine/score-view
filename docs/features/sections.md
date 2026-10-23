# sections — section views, score order and brackets
`web/features/sections.js` · loads 3rd

## Purpose
Section views (one Bitwig group plus the live clip's track, Full, or Pinned), with "Follow section" switching to the
selected clip's group; standard orchestral score order or Bitwig's track order; a bracket and vertical label per
family / section.

## Owns
- Toolbar group `#svSections`: section segment `#svSectionSeg`, `#svSectionFollow`, order segment `#svOrderSeg`.
- `SV.sections` (`scoreInfo(name)`, `scoreOrder(parts)`, `showAll()` — a group view switches to Full; arrangement.js
  calls it after a read); the name matcher is pure (`module.exports`).
- localStorage `scoreview.sections.*`.

## Hooks
`visibleTracks`, `transformScore`, `buildOptions`, `afterRender` (turns the group labels vertical; marks each turned
label `data-sv-rotated`, so a kept chunk is not turned twice; a system in an off-screen chunk is turned when it comes
into view, `SV.core.whenShown`), `liveData`. Reads `SV.instruments`; calls
`SV.renderTrackList()`.

## Tests
`test/sections-test.mjs` (score order, name matching, brackets in MEI, clip placement), `test/sections-e2e.mjs`
(views, order, Follow section, placement cycling, playhead).
