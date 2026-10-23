# playback — rehearsal marks and transport from the score
`web/features/playback.js` · loads 13th

## Purpose
Rehearsal marks from Bitwig's cue markers (live) or the DAWproject; click a bar number (or Alt+click in a bar) to play
from it, Space to play / stop, L to loop the selection's bars, Shift+L loop off; solo / mute on staff-label hover; a
compact transport strip. "Click sets playhead" (on by default): a plain click on a live note while stopped moves
Bitwig's playhead (and with it the play start marker) to the note (toggle in View ▾); Orchestrate puts the marker back on the clip start
before it navigates.

## Owns
- Toolbar strip `#svpbStrip`: `#svpbPlay`, `#svpbPos`, `#svpbTempo`, `#svpbLoop`, `#svpbMarks`, `#svpbCue`.
- `SV.playback` (`playFromBar`, `togglePlay`, `loopSelection`, `loopOff`, `markers`, `clipOffset`, `noteArrangerBeat`).
- localStorage `scoreview.playback.*`. Transport ops `play`, `stop`, `toggle`, `playFrom`, `position`, `loop`,
  `loopOff`, `solo`, `mute`.

## Hooks
`transformScore`, `keydown`, `noteClick` (returns false: the built-in click still selects), `afterRender` (solo / mute zones and the 📌 of pinned tracks beside the staff names, `.svpb-pin`), `liveData`, `play`.
The zones sit inside each engraving (`#paper > .svc`: the whole score, or one system of a chunked score) and are only
built for engravings without them (`data-svpb` = the tracks / pins they were built for): kept chunks keep theirs.
Boxed rehearsal marks get `.svpb-boxed` (an afterRender run on a kept chunk does not box them twice).

## Tests
`test/playback-e2e.mjs` (uses PORT and PORT+1). `test/render-perf-e2e.mjs` checks a full-score render stays at a
handful of layouts: the afterRender hook measures every staff / rehearsal mark first, then adds the zones and boxes.
An off-screen chunk of a big score gets its zones when it comes into view (`SV.core.whenShown`): measuring it at once
forces the layout content-visibility skips.
