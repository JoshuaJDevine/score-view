# Wave 2 plan (agreed 2026-10-16)

Builds on Wave 1 (core split, op registry, test infra, design tokens). Josh's decisions are in the roadmap artifact and
`docs/library-profiles.md`.

## Headline: Render dynamics
Notation (p/f marks, hairpins, expressions) → per-library control curves, written as real Bitwig automation.
* **Preview** (plays the passage, moves the controls live, writes nothing) and **Render** (same with arranger automation
  write "touch", then restores the user's write settings). Proven by `tools/probe` (performance pass with `Parameter.touch()`).
* Library profiles split the level curve onto controls: Pocket Strings Timbre (48) + Expression (49); Spitfire CC1 + CC11;
  BBC SO Dynamics (20) + Expression (10); Pigments a macro. Targets come from the plug-in's VST3 id (Bitwig plug-in cache)
  + param id. Pocket Strings and Pigments first (laptop); BBC SO on the main PC.
* **Hairpin shapes:** S-curve (default), Linear, Late swell, Early swell, Messa di voce; global default in settings +
  per-hairpin override; a shape-strength control. Output stays plain, editable Bitwig automation (sensible point density).
* **Human variation:** on by default, subtle, with a slider (seeded; small lead/lag between the two controls).
* Launcher-clip option: generated .mid via `insertFile` (CC lanes + per-note pressure curves, proven by the probe).

## Also in Wave 2
* GUI slice 1: command palette (Ctrl+K), toasts, status bar, fixed app bar + View ▾.
* Note entry quick wins; Sibelius keypad default with Dorico/MuseScore as a preference.
* Cross-staff copy/paste + click-any-staff (overwrite by default, preference: merge). Built on branch wave2-paste:
  `web/features/passage.js`, docs/features/passage.md.
* **Score mode shows every track with notes after a Read arrangement** (today "Tracks: N shown" can leave only the
  selected track visible — Josh could only see Pocket Strings or Pigments, never both).
* **"Read is out of date" indicator** on ⟳ Read project when a track other than the live one changed since the last
  read (Score mode otherwise silently shows the old snapshot).
* Inspire Melody in Clip mode also uses the last arrangement read (not only the remembered pad) to find the chords.
* Done first (branch wave2-pre): the three items above, plus `SV.addToolbar(el, {cluster, order})` and the
  `SV.shortcuts` registry (A6, A7).
