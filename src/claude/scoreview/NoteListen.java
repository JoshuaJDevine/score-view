package claude.scoreview;

import java.util.ArrayDeque;
import java.util.function.IntFunction;

/**
 * "Listen while playing" (GET /api/listen): the notes Bitwig reports as played on each track of the flat bank
 * (Channel.addNoteObserver), each stamped with the arranger position (beats) at which it arrived. The page compares
 * the onsets with its stored arrangement read (features/arrangement-listen.js) and marks tracks whose playback no
 * longer matches the read. Read-only: nothing here changes Bitwig.
 *
 * It is not known whether the observer reports a track's notes before or after its Note FX (articulation maps send
 * extra keyswitches, arpeggiators and harmonisers change the notes), so the page learns a per-track baseline instead
 * of expecting an exact match. test/listen-probe.mjs (live, read-only) shows what the observer delivers.
 *
 * Thread use: {@link #add} runs on the control thread (observer callbacks), {@link #json} on the HTTP threads.
 */
final class NoteListen
{
   /** Events kept per track (a dense orchestral bar at 16 notes per beat is ~64 onsets: several bars of history). */
   static final int PER_TRACK = 512;

   /** One event: seq (global, rising), note on/off, key, velocity (0..127), arranger beat, wall-clock ms, transport playing. */
   record Event(long seq, boolean on, int key, int vel, double beat, long t, boolean playing) {}

   private final Object lock = new Object();
   private final ArrayDeque<Event>[] rings;
   private long seq;

   @SuppressWarnings("unchecked")
   NoteListen(final int tracks)
   {
      rings = new ArrayDeque[tracks];
      for (int i = 0; i < tracks; i++) rings[i] = new ArrayDeque<>();
   }

   /** Records one event of track {@code index} (flat bank index); returns its seq (-1 when the index is out of range). */
   long add(final int index, final boolean on, final int key, final int vel, final double beat, final long t, final boolean playing)
   {
      if (index < 0 || index >= rings.length) return -1;
      synchronized (lock)
      {
         final ArrayDeque<Event> ring = rings[index];
         ring.addLast(new Event(++seq, on, key, Math.max(0, Math.min(127, vel)), beat, t, playing));
         while (ring.size() > PER_TRACK) ring.removeFirst();
         return seq;
      }
   }

   long seq()
   {
      synchronized (lock) { return seq; }
   }

   /**
    * {@code {seq, playing, pos, tracks:[{index, name, events:[[seq, on (1/0), key, vel, beat, t (ms), playing (1/0)]]}]}}
    * with the events whose seq &gt; since; only tracks with such events are listed. since &lt; 0 (or larger than seq: the
    * extension restarted) returns no events, only the current seq, so a page starts from "now".
    */
   String json(final long since, final boolean playing, final double pos, final IntFunction<String> names)
   {
      final StringBuilder sb = new StringBuilder(512);
      synchronized (lock)
      {
         final boolean fresh = since < 0 || since > seq;
         sb.append("{\"seq\":").append(seq).append(",\"playing\":").append(playing).append(",\"pos\":").append(pos)
           .append(",\"tracks\":[");
         boolean firstTrack = true;
         if (!fresh) for (int i = 0; i < rings.length; i++)
         {
            final ArrayDeque<Event> ring = rings[i];
            if (ring.isEmpty() || ring.peekLast().seq() <= since) continue;
            if (!firstTrack) sb.append(',');
            firstTrack = false;
            sb.append("{\"index\":").append(i).append(",\"name\":").append(ScoreViewExtension.jsonStr(names.apply(i))).append(",\"events\":[");
            boolean first = true;
            for (final Event e : ring)
            {
               if (e.seq() <= since) continue;
               if (!first) sb.append(',');
               first = false;
               sb.append('[').append(e.seq()).append(',').append(e.on() ? 1 : 0).append(',').append(e.key()).append(',')
                 .append(e.vel()).append(',').append(Math.round(e.beat() * 10000) / 10000.0).append(',').append(e.t())
                 .append(',').append(e.playing() ? 1 : 0).append(']');
            }
            sb.append("]}");
         }
         sb.append("]}");
      }
      return sb.toString();
   }

   /**
    * The arranger beat to stamp an event with: the last reported play position, moved on by the time since that report
    * at the current tempo while playing (Bitwig reports the position at its UI rate). The step is capped at
    * {@code maxAhead} beats and never crosses the end of an enabled arranger loop (it wraps to its start instead).
    */
   static double estimateBeat(final double reported, final long reportedAtMs, final long nowMs, final boolean playing,
      final double bpm, final double maxAhead, final boolean loopOn, final double loopStart, final double loopLength)
   {
      if (!playing || bpm <= 0 || reportedAtMs <= 0 || nowMs <= reportedAtMs) return reported;
      final double ahead = Math.min(maxAhead, (nowMs - reportedAtMs) / 60000.0 * bpm);
      final double est = reported + ahead;
      if (loopOn && loopLength > 0 && reported < loopStart + loopLength && est >= loopStart + loopLength)
         return loopStart + (est - loopStart - loopLength);
      return est;
   }
}
