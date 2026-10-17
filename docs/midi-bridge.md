# MIDI bridge: manual test plan (Kontrol S88 MK3 + Bitwig)

Note entry (`N`) can take keys from two sources:

* **Web MIDI.** The page opens the keyboard itself. This fails on Windows when the port is "busy".
* **Bitwig bridge.** The extension watches the notes that sound on the **selected track**
  (`CursorTrack.playingNotes()`). It forwards them to the page through `GET /api/midi`. No MIDI port is shared,
  and the S88 stays assigned to its Kontrol controller script.

The source selector sits in the entry toolbar, next to the **MIDI** button:

| Option | Behaviour |
|---|---|
| **Auto** (default) | Uses Web MIDI if it opens a device. Otherwise it uses the bridge. |
| **Web MIDI** | Uses Web MIDI only. |
| **Bitwig** | Uses the bridge only. Web MIDI is never requested. |

Only one source is active at a time, so a key is never entered twice.

## How to tell which path is active

Look at the MIDI part of the entry pill. Hover it for details; in Auto the tooltip also shows why Web MIDI was not used.

| Pill text | Meaning |
|---|---|
| `MIDI: KONTROL S88 MK3 ✓` | Web MIDI is active. |
| `MIDI: via Bitwig ✓` | The bridge is active. |
| `MIDI: via Bitwig ⏸ (playing)` | The bridge is active, but the transport is playing, so notes are ignored. |
| `MIDI: via Bitwig ✓ — track not monitoring` | The selected track does not receive the keyboard (see step 2). |
| `MIDI: Bitwig bridge needs the updated extension` | The installed extension has no `/api/midi` (404). |
| `MIDI: Bitwig bridge offline` | The page cannot reach the extension. |

DevTools → Network shows a pending `/api/midi?since=N` request while the bridge is active. With Web MIDI there is none.

## Steps

1. Install the new build (lead). Open Score View and select a MIDI clip on an **instrument track**
   (for example BBC SO Violins 1).
2. In Bitwig, check that playing the S88 sounds the selected track's instrument.
   Bitwig auto-monitors the selected instrument track by default, so this normally just works.
   If it doesn't, enable input monitoring on the track.
3. Press **N**. Set the selector to **Bitwig**. Expected: the pill shows `MIDI: via Bitwig ✓`.
4. Stop the transport. Play a single key, then a 3-note chord (all keys pressed within about 60 ms), then a short melody.
   * Expected: each entry lands at the caret with the current duration.
   * The chord is one stacked entry and the melody is consecutive notes.
   * Velocity follows the keys (check one note's velocity in Bitwig).
   * The sound comes from Bitwig's instrument. Score View itself doesn't play anything for MIDI entry.
5. Play a fast legato line: each key pressed before the previous one is released.
   Expected: separate notes, not chords. Notes more than 60 ms apart are separate entries.
6. **Audition echo:** with *Audition* ticked, type letters (`C`, `D`, …) or click notes.
   Expected: the auditioned sound is **not** entered a second time.
   The extension ignores its own audition notes for 600 ms per key.
7. **Playback is ignored:**
   1. Start the transport over the clip. Expected: the pill shows `⏸ (playing)`, and neither the clip's playback nor your keys enter notes.
   2. Tick **Record while playing**. Expected: keys enter again. The clip's own playback on that track would also enter, which is why this is off by default.
   3. Untick it and stop the transport.
8. **Track selection:** select a different instrument track and clip in Bitwig, then play.
   Expected: entry goes to the new clip. The bridge follows Bitwig's selected track.
9. **Auto:** set the selector to **Auto**, then press **MIDI** to reconnect.
   * If Chrome can open the S88, the pill shows `MIDI: KONTROL S88 MK3 ✓`.
   * Otherwise (busy or blocked) it shows `MIDI: via Bitwig ✓`, and the tooltip names the Web MIDI status.
   * Either way, each key enters exactly once.
10. **Web MIDI:** with the selector on **Web MIDI**, the bridge stops: the `/api/midi` requests disappear from the Network tab.
11. Press **Esc** to leave entry mode. The bridge stops polling.

## Known limitations

* The bridge only sees notes that reach the selected track. A track that is not monitoring, or a non-instrument track, gives no notes.
* Note-on and note-off only; no sustain pedal (CC 64). **Pedal tapping works only with Web MIDI.** Use the tap key instead.
* Timestamps come from Bitwig's control thread, when it reports the changed note set (ms resolution).
  Chord grouping uses these timestamps, not the arrival time over HTTP. If Bitwig batches two notes into one update,
  they get the same timestamp, which is harmless for chords.
* A key held across a transport start/stop still releases correctly. Only note-ons are filtered while playing.
* A key that is already sounding (for example a long clip note) and is pressed again is not reported again.
  `playingNotes` is a set of pitches, not an event stream.

# Controller: MIDI Learn for entry (web/features/controller.js, #15)

**Controller…** (toolbar) opens a panel that lists the entry actions:
* durations (32nd…whole, next/previous), dot, triplet, tie, rest, repeat, undo, chord mode, Rhythm → Pitch, tap;
* caret left/right, previous/next bar, select previous/next note;
* sharpen/flatten and octave up/down of the last or selected note;
* encoders for Duration, Caret, Pitch (diatonic; chromatic while a learnt **Shift** or the keyboard Shift is held) and Select;
* enter/leave entry mode, play/stop, stop.

Click **Learn**, then press a button, pad or key, or turn an encoder clockwise. The panel learns these controls:
* CC buttons (fire at ≥ 64);
* CC encoders and knobs. The mode is detected from the values: absolute, relative two's-complement (1 / 127), 64-centred (65 / 63), or inc/dec (CC 96/97). Sign-bit is available from the chip's menu.
* note-on (pads, keys), program change, pitch-bend zones (↑ / ↓) and MIDI Start/Stop.

Maps are stored per input port name in `scoreview.controller.maps` and can be exported and imported as JSON.
* **Load defaults…** replaces a device's map.
* **Reset** returns the device to its built-in default.
* **Listen while entry is off** keeps MIDI open, so the entry toggle and play/stop work before you press N.
* A HUD shows each action, its value (duration strip, caret bar/beat, pitch) and the control that fired it.

## The Bitwig bridge carries notes only

`/api/midi` forwards note-on/off. Over the bridge you can learn and use keys and pads, but not CC, program change, pitch bend or Start/Stop.
For those, set the MIDI source to **Auto** or **Web MIDI**.

## Default maps

Built-in maps apply until you learn something on that port. A dashed chip marked "?" is a guess.

| Device (port name) | Verified | Guessed |
|---|---|---|
| Launchkey MK4, standalone/MIDI mode, MIDI port (not the DAW port) | Channel 16 CCs from the Programmer's Reference Guide v2, fig. 1: Track ◀ 103 → caret left, Track ▶ 102 → caret right, Capture MIDI 74 → tap, Undo 77 → undo, Quantise 75 → Rhythm → Pitch, Metronome 76 → tie, Record 117 → entry on/off, Loop 118 → chord mode. Start/Stop real-time messages → play / stop. | Pads in Drum mode, ch 10, notes 36–51 (the guide's drum layout). Top row: durations 32nd…whole, dot, triplet. Bottom row: rest, repeat, tie, flat, sharp, octave down/up, chord. Encoders CC 21–24 (Custom Mode; mode auto-detected): duration, caret, pitch, select. Which button is Record and which is Loop (117/118) is read from the figure. |
| Arturia MiniLab 3 | — | Pads bank A, notes 36–43 on ch 10: rest, repeat, tie, undo, dot, triplet, sharp, flat. Main encoder CC 28 → duration. Knobs CC 74 → caret, 71 → pitch. |
| Anything else (e.g. Kontrol S88), and the Bitwig bridge | The A0–B1 keypad. These keys act only **below the live instrument's range**, so a bass still plays F1. White keys C1–A1 = 32nd…whole, B1 = dot, B0 = rest. Black keys A♯0 = undo, C♯1 = triplet, D♯1 = tie, F♯1 / G♯1 = caret ← / →, A♯1 = repeat. Pitch bend ↓ / ↑ = caret ← / →, auto-repeat while held. A0 stays the tap key. | — |

Kontrol S88 MK3: NI's DAW protocol is undocumented. Put the S88 in MIDI mode (Shift+Settings) and learn its encoders and buttons.
