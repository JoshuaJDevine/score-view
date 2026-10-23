# articulations — keyswitch articulations and dynamics
`web/features/articulations.js` · loads 2nd

## Purpose
Reads BBC Symphony Orchestra (and similar) keyswitch notes below C1, gives every note the latched articulation and
engraves it: dots, wedges, accents, tenuto, tremolo, trills, legato slurs, and technique text where it changes.
Dynamics marks and hairpins come from the export's Dynamics/Expression automation (CC1/CC11 fallback) or velocities.
Legato keyswitches draw slurs only with Articulations ▾ → **Slur legato passages** (setting `slurLegato`, off by default; `annotate(…, {slurs})`).

Write-back: the palette (Shift+K, or Articulations ▾ → Palette for the selected notes; on note click only by preference) and Shift+S/U/I/T/A/N/R insert keyswitches before the selected live notes.

Keyswitch timing (measured on BBC SO in Bitwig, 2026-10-17): a keyswitch at the same moment as its note does **not**
fire; the note keeps the previous articulation. `keyswitchSlot` puts a switch an eighth of a beat before its note (after
the previous note, never on the note); the clip's first note has no room, so write-back warns (start clips with some
empty space) and never moves notes. `lateKeyswitches` flags switches on or just after their note with a `⚠ ks`
direction (`late: true`, left out of MusicXML); Articulations ▾ → **Fix keyswitch timing** (`planKeyswitchFix`) moves
them earlier where there is room.

Articulation-map Note FX (JSONBach "Articulation Map BBCSO …", any enabled device whose name contains "articulation"
on the selected track, from `/api/notes` `devices`) re-send their own keyswitch before every note: a warning bar
(`#svaMapWarn`) offers **Turn the map off** (op `deviceOn i 0`) or ✕ for the session.

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
