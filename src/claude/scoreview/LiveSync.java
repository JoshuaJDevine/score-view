package claude.scoreview;

/**
 * When to wake the page's long poll (GET /api/notes) and when its data can be trusted ("settled").
 *
 * Bitwig delivers a clip switch as a burst: the old notes go and the new ones arrive one NoteStep callback at a time,
 * the track name follows a moment later and the play start marker moves to the selected arranger clip a little after
 * that. Waking the page on every callback sent it dozens of half-switched snapshots (and rebuilt the JSON for each),
 * and the page had to guess when the burst was over (it waited 600 ms of quiet).
 *
 * Here every observer callback only marks the data changed; {@link #publish} (called from ScoreViewExtension.flush()
 * and a TICK_MS task on the control thread) turns the changes of one tick into one new version, so the page still
 * sees edits within a tick but a burst costs a handful of versions. Once nothing has changed for QUIET_MS (SWITCH_QUIET_MS
 * after a burst that looks like a clip switch) one more version is published with settled = true: the page commits
 * snapshots of edited clips, compares notes for dynamics and reads the clip's arranger position (play start) only
 * from such a snapshot.
 *
 * Pure (the clock is passed in) and thread-safe: observers call it on Bitwig's control thread, the HTTP threads read
 * {@link #settled()} and {@link #lastChangeMs()} while building the JSON. Checked by test/java/LiveSyncCheck.java.
 */
final class LiveSync
{
   /** The control-thread task that publishes changes and the settled state runs this often. */
   static final long TICK_MS = 20;
   /** At most one unsettled version per this many ms (flush() may come after every single callback of a burst). */
   static final long MIN_GAP_MS = 20;
   /** Settled after this long without any change (an edit, a velocity, a solo...). */
   static final long QUIET_MS = 100;
   /**
    * Settled after this long without any change when the burst looked like a clip switch (another track selected, the
    * clip's track name / existence / play range changed, or notes both removed and added beyond a single move): the
    * track name and the play start marker can follow the notes by a moment. Was 600 ms on the page (a guess); live
    * verification of this margin is listed in docs/AGENTS.md (/api/notes).
    */
   static final long SWITCH_QUIET_MS = 200;
   /** A burst removing and adding notes, more than this many changes in all, counts as a clip switch (a move is 2). */
   static final int SWITCH_NOTES = 3;

   /** What {@link #publish} asks the caller to do. */
   enum Publish { NONE, CHANGED, SETTLED }

   private boolean dirty;          // changed since the last published version (and not suppressed)
   private boolean settled;
   private boolean switchLike;     // the current burst looks like a clip switch
   private int added, removed;     // notes added / removed in the current burst
   private long lastChangeMs;
   private long lastPublishMs = Long.MIN_VALUE / 2;

   /**
    * Something the page shows changed. {@code suppressed}: the crawler or the clip navigator is walking clips, so the
    * page must not be woken (it would see the other clips go by); the change still resets the quiet window.
    */
   synchronized void changed(final long now, final boolean suppressed)
   {
      lastChangeMs = now;
      settled = false;
      if (!suppressed) dirty = true;
   }

   /** Marks the current burst as a clip switch (the longer quiet window applies). Call before {@link #changed}. */
   synchronized void switched()
   {
      switchLike = true;
   }

   /** A NoteStep callback added and/or removed notes. Call before {@link #changed}. */
   synchronized void notes(final int add, final int remove)
   {
      added += add;
      removed += remove;
      if (added > 0 && removed > 0 && added + removed > SWITCH_NOTES) switchLike = true;
   }

   /**
    * Decides whether a new version is due: CHANGED when something changed (at most once per MIN_GAP_MS), SETTLED
    * when the quiet window has passed since the last change. Nothing settles while {@code suppressed}.
    */
   synchronized Publish publish(final long now, final boolean suppressed)
   {
      if (dirty)
      {
         if (now - lastPublishMs < MIN_GAP_MS) return Publish.NONE; // the next tick publishes it
         dirty = false;
         lastPublishMs = now;
         return Publish.CHANGED;
      }
      if (settled || suppressed || now - lastChangeMs < quietMs()) return Publish.NONE;
      settled = true;
      switchLike = false;
      added = removed = 0;
      lastPublishMs = now;
      return Publish.SETTLED;
   }

   /** The quiet window the current burst needs. */
   synchronized long quietMs()
   {
      return switchLike ? SWITCH_QUIET_MS : QUIET_MS;
   }

   synchronized boolean settled()
   {
      return settled;
   }

   synchronized long lastChangeMs()
   {
      return lastChangeMs;
   }
}
