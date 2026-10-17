# Library profiles (and Inspire)

_Started 2026-10-16 from Josh's notes. A living document: add to it whenever writing for a library teaches us something._

## The idea

Every sample library or synth gets a **hand-made profile**: Score View learns, one library at a time, how a composer's
notation should become *that* instrument's performance. A generic "MIDI with CC" mapping is not the goal. The BBC SO
articulation map (keyswitches from the plug-in state, `web/features/articulations.js`) is the proof that this pays off.

## What a profile knows

| Layer | Question it answers | BBC SO (Spitfire) | Spitfire dual-slider libraries | Crow Hill pocket strings | Synths (Pigments, UJAM, Sonuscore) |
|---|---|---|---|---|---|
| 1. Detect | Which plug-in/preset is on this track? | plug-in name + state (done) | plug-in name + state | _to learn_ | plug-in name, preset |
| 2. Articulations | How does `stacc.`, `pizz.`, `con sord.` select a sound? | keyswitch map from the plug-in (done) | keyswitch/UACC | _to learn_ | patterns/presets, not articulations |
| 3. Dynamics engine | How do `p`, `f`, hairpins become sound? | CC1 Dynamics (+ CC11 Expression) | **two sliders (CC1 + CC11) moving together along a hairpin, with slight human variation** | _different: Josh to describe_ | macros/filters/intensity |
| 4. Special features | What makes this library itself? | mic mixes, release | legato modes, vibrato CC21 | lush/dynamic features | macros, pattern switching, energy |
| 5. Writing hints | How should Inspire/Orchestrate write for it? | traditional score: long notes + swell | longs + shaped curves | _to learn_ | rhythmic patterns, macro arcs |

## The key technical question: answered by the CC spike (2026-10-16)

Layer 3 needs continuous control data. The extension API (v25) **cannot write automation points, CC lanes or
per-note expression curves directly**: `NoteStep` takes one scalar per note (velocity, gain, pressure, timbre, pan), and
`Parameter` can only be set, touched and have all automation deleted. Routes that do work:

1. **Performance pass (recommended):** the extension moves the target parameter in real time during playback with Bitwig's
   automation write on (`Parameter.touch()` exists for exactly this), so Bitwig records true automation lanes. BBC SO's
   Dynamics (VST3 param 20) and Expression (10) are the same lanes our DAWproject reader already turns back into hairpins.
   Without write it is a live preview.
2. **Per-note values + a conversion device** (Expressions modulator → MIDI CC, inserted by the wizard): instant and
   offline, but one value per note (terraced dynamics), no hairpin on a held note.
3. **Generated .mid inserted into a launcher slot** (Bitwig imports CC as clip automation): offline but replaces the clip.
4. **MIDI loopback** if 1 fails.

### Probe results (laptop, Bitwig 6.1, Crow Hill Pocket Strings, 2026-10-16) — `tools/probe`

| Route | Result |
|---|---|
| **Performance pass on a plug-in parameter** (`createSpecificVst3Device(id).createParameter(n)`, `touch()` + `set()` during playback, arranger write "touch") | **Works.** Pocket Strings Timbre (VST3 param 48): hasAutomation false → true, the plug-in followed (sent 0.738, read 0.758), ~42 values/s, recorded from beat 0.8 (400 ms start-up) to 8.9. Josh confirmed a smooth hairpin in the Timbre lane. |
| Direct parameter API (`setDirectParameterValueNormalized`) | **Records** a curve in the arranger Expression lane (Josh saw it), but the read-back value never changed — unreliable as a live preview. Use proper Parameters (plug-in VST3 id from Bitwig's plug-in cache + param id = the hex in the direct id `CONTENTS/PID31` → 0x31 = 49). |
| `Track.sendMidi` CC | Reaches the plug-in (Josh saw Pocket Strings' controls move). Recording it not tested yet. |
| Per-note pressure (`NoteStep.setPressure`) | **Works** (23 notes set to 0.9, read back 0.9). One value per note. |
| `insertFile(.mid)` into a launcher slot | **Works offline**: clip with the notes, CC1/CC11/CC21 lanes and the E4 per-note pressure curve (from poly aftertouch) — Josh confirmed. Launcher slots only; replaces the clip. The only offline route to per-note expression curves. |
| Launcher automation write, preview, undo steps | Not run yet. |

Pocket Strings (Crow Hill): Timbre (48) and Expression (49) are its two "sliders" — the same dual-control idea as Spitfire's
CC1/CC11; Long / Short / Pluck (0x626–0x628) select the articulation. Pigments VST3 id: 41727475415649534B61743150726F63.

## Render dynamics (built 2026-10-16, Wave 2)

Route 1 (performance pass) is implemented: `web/features/dynamics.js` (marks, hairpins, curve model, Dynamics ▾),
`web/features/library-profiles.json` (the profile table, shared with the extension) and
`src/claude/scoreview/CurvePlayer.java` (Preview / Render). Pages: docs/features/dynamics.md,
docs/features/library-profiles.md. Pigments still needs its macro's VST3 parameter id (today: remote control 1);
recording `Track.sendMidi` CC (Spitfire Kontakt profile) is untested and marked experimental.

## Inspire ▾ (first stub, 2026-10-16)

`web/features/inspire.js` + mood data in `web/features/inspire-library.js`.

* **Underscore string chords…** fills N bars of the selected clip with a sustained, voice-led chord pad. One clip,
  one staff (divisi); Orchestrate ▾ Explode spreads it over a section.
* Dialog: mood, bars, start bar (default: after the selection), key (default: from the key signature; minor moods use
  the relative minor), existing notes (preference: replace, default; or keep). **Again** swaps the last roll for the next
  progression/voicing of the same mood.
* Moods (3): Hopeful (I–V–vi–IV family, add9), Melancholy (Aeolian, 2 bars per chord), Suspense (low, tonic pedal,
  Phrygian ♭II, minor line cliché). Each mood lists its sources; add moods by appending entries.
* Voicing: voices stay inside the instrument's comfortable range (from `features/instruments.js`), common tones are held,
  the next chord is chosen for the smallest total voice motion.

* **Melody over the chords…** writes a single line into the selected clip over the chords it finds: in Score mode the
  harmony analysis of the other staves (`SV.harmony.analyze` on the score minus the live staff), in Clip mode the last
  pad Inspire wrote (remembered by clip bar). Four-bar phrases (motif, motif again, contrast, cadence); chord tones on
  strong beats, scale steps between (the scale bends to the chord: G♯ over E in A minor); leaps answered by a step back;
  phrases end on the 3rd or root; velocity follows the phrase arch. Each mood's `melody` entry sets the rhythm cells,
  register, contour (arch / fall / flat), sighs (appoggiaturas) and chromatic neighbours.

* **Continue the phrase…** answers the passage in the arrangement (the "question") with a consequent phrase written into
  both tracks at once (chord track + melody track, detected; through `SV.orchestrate.writeTracks` and the clip navigator, so
  Score mode + Read arrangement). **Parallel** (default): restate the opening chords and the melody's first two bars, then
  the mood's cadential tail (`answers` in the library: Hopeful …IV–V–I / …ii–V–I / …vi–IV–V–I / …IV–I–V–I; Melancholy
  …iv–V–i; Suspense …♭II–i or the unresolved …♭II–V). **Contrasting**: new opening, same cadence. The pad leads on from
  the question's last voicing; the melody connects from its last note and ends on the tonic. Again = next answer to the
  same question; Write again = continue after the answer. The clips must already reach the answer's bars (the extension
  cannot lengthen clips).

### Where Inspire goes next (ideas)
* Profile-aware output: on BBC SO write longs + a dynamics swell; on Spitfire shape both sliders; on synths draw macro arcs.
* Write across several tracks at once (string section voicing) instead of one staff + Explode.
* More moods; harmonic rhythm and register as dialog options; melody/ostinato generators over the pad.
