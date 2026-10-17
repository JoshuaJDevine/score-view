# controller — controller-native note entry
`web/features/controller.js` · loads 11th

## Purpose
MIDI Learn for entry actions (durations, dot, tie, rest, caret, undo, pitch, transport, …) from buttons, pads,
encoders, faders, program changes, pitch-bend zones, transport messages and keys outside the playing range. Default
maps for the Launchkey MK4, the MiniLab 3 and any keyboard work before anything is learnt.

## Owns
- Toolbar `#svc-open`; panel `#svc-panel`, HUD `#svc-hud`, `#svc-io` (maps as JSON).
- `SV.controller` (`bindingsFor(port)`, `_raw(data, port)`).
- localStorage `scoreview.controller.*` (maps per input port). Sends `toggle` / `stop`.

## Hooks
`keydown` (unshifted: the first Esc cancels a running Learn, the second closes the panel; a press outside
also closes it; a Learn click counts only if the press started on that button); registers on `SV.entry.rawHooks`. Reads `SV.entry`, `SV.playback`, `SV.instruments`.

## Tests
`test/controller-e2e.mjs` (encoder / pad / CC button learn, default maps, generic keys, HUD and panel screenshots),
`test/popover-e2e.mjs` (Esc / outside press, stray Learn click).

## Docs
docs/midi-bridge.md (Controller).
