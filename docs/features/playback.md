# playback — rehearsal marks and transport from the score
`web/features/playback.js` · loads 13th

## Purpose
Rehearsal marks from Bitwig's cue markers (live) or the DAWproject; click a bar number (or Alt+click in a bar) to play
from it, Space to play / stop, L to loop the selection's bars, Shift+L loop off; solo / mute on staff-label hover; a
compact transport strip.

## Owns
- Toolbar strip `#svpbStrip`: `#svpbPlay`, `#svpbPos`, `#svpbTempo`, `#svpbLoop`, `#svpbMarks`.
- `SV.playback` (`playFromBar`, `togglePlay`, `loopSelection`, `loopOff`, `markers`, `clipOffset`).
- localStorage `scoreview.playback.*`. Transport ops `play`, `stop`, `toggle`, `playFrom`, `position`, `loop`,
  `loopOff`, `solo`, `mute`.

## Hooks
`transformScore`, `keydown`, `afterRender`, `liveData`, `play`.

## Tests
`test/playback-e2e.mjs` (uses PORT and PORT+1).
