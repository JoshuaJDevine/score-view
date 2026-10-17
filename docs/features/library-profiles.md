# library-profiles — which controls a dynamics curve drives
`web/features/library-profiles.js` + data `web/features/library-profiles.json` · loads right before `dynamics`

## Purpose
One table, shared by the page and the extension, that says how a 0..1 dynamics level becomes control values on a given
library. The extension reads the same JSON from its jar at start-up (`CurvePlayer.parseProfiles`) and creates a Bitwig
`Parameter` for every vst3 / remote target in `init()` — the only time the API allows it — so **adding a vst3 target
needs a rebuild and a restart of the extension** (switch Score View off and on).

## The table (`library-profiles.json`)
```
{ id, name, experimental?, fallback?, note?,
  match: { vst3: [VST3 class ids], names: [device / plug-in names, whole words] },
  targets: [{ id, label, kind: 'vst3'|'remote'|'cc', plugin?, param?, index?, cc?,
              role: 'dynamics'|'expression', min, max, gamma }] }
```
value = min + (max − min) × level^gamma. A profile with two targets is "dual" (Spitfire-style): the `expression` control
trails the `dynamics` one by up to ~0.04 beats with its own small wobble when human variation is on.

| Profile | Targets | Status |
|---|---|---|
| `pocket-strings` Crow Hill Pocket Strings `ABCDEF019182FAEB5443484344443032` | Timbre (VST3 48) + Expression (49) | probed (Timbre recorded as automation) |
| `bbcso` BBC Symphony Orchestra `56535453616E746262632073796D7068` | Dynamics (20) + Expression (10) | ids from the DAWproject export; to test on the main PC |
| `spitfire-cc` Spitfire / Kontakt (names) | CC1 + CC11 via `Track.sendMidi` | **experimental**: the plug-in follows, Bitwig does not record it |
| `pigments` Arturia Pigments `41727475415649534B61743150726F63` | remote control 1 of the device's current page (map Macro 1 there) | Pigments' VST3 macro param id is unknown; once probed add a vst3 target |
| `velocity` | none (velocities only) | fallback |

## Detection (`detect(info)`)
In order: the staff's choice in Dynamics ▾ (`override`), the plug-in's VST3 id, Bitwig device names on the track (from
`GET /api/curve` `devices`; a profile with a VST3 id beats the generic name-only Spitfire one), the DAWproject export's
plug-in name, the track name, else Velocity only. Returns `{profile, how}`.

## Owns
- `SV.libraryProfiles = { ready (Promise), list(), byId(id), detect(info), valueAt(target, level), dual(profile),
  describe(target), nameMatches(profile, name), fallback() }`; Node: `require(...)` loads the JSON itself.
- Served as `features/library-profiles.json` (build.sh copies `web/features/*.json`; content type application/json).

## Hooks
None.

## Tests
`test/dynamics-test.mjs` ("library profiles"), `test/curve-player-test.mjs` (the Java parser on the same file).

## Adding a library
Append a profile (find the VST3 id in Bitwig's plug-in cache / `features/wizard-plugins.js`, the param id from the
DAWproject's `<Parameter parameterID>` or the probe), add a line to the table above and to docs/library-profiles.md.
