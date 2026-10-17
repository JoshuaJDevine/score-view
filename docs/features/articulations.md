# articulations — keyswitch articulations and dynamics
`web/features/articulations.js` · loads 2nd

## Purpose
Reads BBC Symphony Orchestra (and similar) keyswitch notes below C1, gives every note the latched articulation and
engraves it: dots, wedges, accents, tenuto, tremolo, trills, legato slurs, and technique text where it changes.
Dynamics marks and hairpins come from the export's Dynamics/Expression automation (CC1/CC11 fallback) or velocities.
Write-back: the palette on note click and Shift+S/U/I/T/A/N/R insert keyswitches before the selected live notes.

## Owns
- Toolbar: **Articulations ▾** `#svaBtn` (menu `#svaMenu`, palette `#svaPalette`, `#svaDyn` dynamics toggle).
- `SV.articulations` (`mapFor(track)`, pure `resolve` / `annotate` / `deriveDynamics` / `planWriteBack`, settings,
  overrides). Node: `require('web/features/articulations.js')`.
- localStorage `scoreview.articulations.*`.

## Hooks
`transformScore`, `afterRender`, `keydown`, `noteClick`. Reads `SV.instruments`, `SV.entry`; writes keyswitches with
`SV.send`.

## Tests
`test/articulations-test.mjs` (resolution, notation, dynamics, write-back plans, BBC SO tables, MusicXML XSD),
`test/articulations-e2e.mjs` (page), `test/articulations-visual.mjs` (screenshots, not in run-all). The fixture helper
`test/articulations-fixture.mjs` writes `test/out.megaman2-full.dawproject`, which the unit and the e2e suite both
use; `run-all.sh -j N` runs them in separate phases.

## Docs
docs/research.md (articulation maps).
