package claude.scoreview;

/**
 * Test helper (test/protocol-test.mjs): drives {@link LiveSync} with a fake clock the way ScoreViewExtension does
 * (observer callbacks, flush() after each, the TICK_MS task) and checks how many /api/notes versions a burst costs and
 * when "settled" turns true. Prints "name ok" or "name FAIL ..." per check, then "done".
 */
public final class LiveSyncCheck
{
   static int published, settledAt;
   static long now;
   static LiveSync s;

   /** One control-thread step: the publish after a callback (flush) or a tick. */
   static void pub(final boolean suppressed)
   {
      final LiveSync.Publish p = s.publish(now, suppressed);
      if (p != LiveSync.Publish.NONE) published++;
      if (p == LiveSync.Publish.SETTLED && settledAt < 0) settledAt = (int) now;
   }

   /** Advances the clock to {@code to} in TICK_MS ticks. */
   static void runTo(final long to, final boolean suppressed)
   {
      while (now + LiveSync.TICK_MS <= to) { now += LiveSync.TICK_MS; pub(suppressed); }
      now = to;
   }

   static void reset()
   {
      s = new LiveSync();
      now = 1000;
      runTo(2000, false); // the start-up settle
      published = 0;
      settledAt = -1;
   }

   static void check(final String name, final boolean ok, final String detail)
   {
      System.out.println(name + (ok ? " ok" : " FAIL " + detail));
   }

   public static void main(final String[] args)
   {
      // A single edit: one version at flush, settled QUIET_MS later.
      reset();
      final long t0 = now;
      s.notes(1, 0); s.changed(now, false); pub(false);
      check("edit published at flush", published == 1 && !s.settled(), "published=" + published);
      runTo(t0 + 1000, false);
      check("edit settles after QUIET_MS", published == 2 && settledAt >= t0 + LiveSync.QUIET_MS
         && settledAt <= t0 + LiveSync.QUIET_MS + LiveSync.TICK_MS, "published=" + published + " settledAt=" + (settledAt - t0));

      // A move (remove + add) is an edit, not a clip switch.
      reset();
      final long t1 = now;
      s.notes(0, 1); s.changed(now, false); pub(false);
      s.notes(1, 0); s.changed(now, false); pub(false);
      runTo(t1 + 1000, false);
      check("move settles after QUIET_MS", settledAt - t1 <= LiveSync.QUIET_MS + LiveSync.TICK_MS, "settledAt=" + (settledAt - t1));

      // A clip switch: 40 notes go and 40 arrive 2 ms apart (flush after each), the track name 60 ms later, the play
      // start marker 50 ms after that. Few versions, all unsettled, then one settled SWITCH_QUIET_MS after the last.
      reset();
      final long t2 = now;
      long next = now;
      int unsettledSeen = 0;
      for (int i = 0; i < 80; i++)
      {
         runTo(next, false);
         s.notes(i < 40 ? 0 : 1, i < 40 ? 1 : 0); s.changed(now, false); pub(false);
         if (s.settled()) unsettledSeen = -999;
         next += 2;
      }
      runTo(now + 60, false);
      s.switched(); s.changed(now, false); pub(false); // track name
      runTo(now + 50, false);
      final long last = now;
      s.changed(now, false); pub(false);               // play start marker
      final int beforeSettle = published;
      runTo(t2 + 2000, false);
      check("switch costs few versions", beforeSettle <= 160 / (int) LiveSync.MIN_GAP_MS + 4, "versions=" + beforeSettle);
      check("switch never settled mid-burst", unsettledSeen == 0 && settledAt >= last, "settledAt=" + (settledAt - t2));
      check("switch settles after SWITCH_QUIET_MS", settledAt - last >= LiveSync.SWITCH_QUIET_MS
         && settledAt - last <= LiveSync.SWITCH_QUIET_MS + LiveSync.TICK_MS, "after last change " + (settledAt - last));
      check("one settled version per burst", published == beforeSettle + 1, "published=" + published);

      // The next quiet edit after a switch uses the short window again.
      final long t3 = now;
      settledAt = -1;
      s.changed(now, false); pub(false);
      runTo(t3 + 1000, false);
      check("switch window resets", settledAt - t3 <= LiveSync.QUIET_MS + LiveSync.TICK_MS, "settledAt=" + (settledAt - t3));

      // Suppressed (crawler / navigator): no versions, no settle; after it ends the data settles once.
      reset();
      final long t4 = now;
      for (int i = 0; i < 20; i++) { s.changed(now, true); pub(true); runTo(now + 30, true); }
      check("suppressed changes publish nothing", published == 0 && !s.settled(), "published=" + published);
      runTo(now + 500, true);
      check("no settle while suppressed", published == 0, "published=" + published);
      runTo(now + LiveSync.TICK_MS, false);
      check("settles once the walk ends", published == 1 && s.settled(), "published=" + published + " t=" + (now - t4));

      // Unsettled versions keep coming during a long burst (live editing feedback), at most one per MIN_GAP_MS.
      reset();
      final long t5 = now;
      for (int i = 0; i < 50; i++) { s.changed(now, false); pub(false); runTo(now + 10, false); }
      final int during = published;
      check("long burst streams versions", during >= 500 / (int) LiveSync.MIN_GAP_MS / 2 && during <= 500 / (int) LiveSync.MIN_GAP_MS + 1,
         "versions in 500 ms=" + during + " t=" + (now - t5));
      System.out.println("done");
   }
}
