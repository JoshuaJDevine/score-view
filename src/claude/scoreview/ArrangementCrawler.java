package claude.scoreview;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;

import com.bitwig.extension.controller.api.Action;
import com.bitwig.extension.controller.api.Application;
import com.bitwig.extension.controller.api.Clip;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.NoteStep;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.Transport;

/**
 * Reads every note clip in the arrangement by walking it with Bitwig's own selection actions
 * (docs/research.md, section C): "Move cursor to first/next lane", "Select first item", "Select next item".
 * After each step the arranger cursor clip holds the selected clip's notes, and the play start marker
 * (which Bitwig moves to the selection) gives its position. The loop is never touched.
 *
 * Runs on the control thread as a state machine ticked by host.scheduleTask. Requires a clip to be
 * selected in the arranger when it starts (that is what gives the arranger timeline keyboard focus);
 * restores the original clip selection and play start afterwards.
 *
 * A targeted read (op {@code crawl tracks <names>}) reads only those tracks: on every lane it selects the first item to
 * learn whose lane it is (lane numbers do not follow the track list: groups and other lanes sit in between) and walks
 * the lane only when that track is wanted; it stops once every wanted track has been read. A wanted track whose lane
 * was never found after all lanes were walked has no clips. The status then lists {@code subset}, {@code found} and
 * {@code complete} (false when cancelled), and the page merges the result into its mirror of the arrangement.
 */
final class ArrangementCrawler
{
   private enum Phase { IDLE, WAIT, BEGIN, FIRST_ITEM, RECORD_FIRST, RECORD_NEXT, LOOP_SEL, LOOP_READ, UNDO_CHECK, NEXT_ITEM, NEXT_LANE, SKIP_LANE, REWALK, R_FIRST_LANE, R_NEXT_LANE, R_FIRST_ITEM, R_CHECK, R_FINISH }

   /**
    * The waits of one walk (ms). After an action the walk waits until Bitwig has been quiet {@code quiet} ms and at least
    * {@code min} ms have passed (at most {@code max}); a clip is recorded once its key reads the same twice,
    * {@code stable} ms apart; a step that looks like the end of a lane is looked at again {@code recheck} ms later;
    * {@code laneMove} is the pause after "Move cursor to next lane" when nothing is selected (fast walk only).
    */
   record Timing(String name, int quiet, int min, int max, int stable, int recheck, int laneMove) {}

   /** The waits every read used until 2026-10 (verified live on Mega Man 2): the default, and "crawl safe". */
   static final Timing SAFE = new Timing("safe", 80, 110, 1500, 120, 300, 110);
   /**
    * Adaptive waits ("crawl fast", Preferences > Read arrangement timing = Fast; NOT yet verified live). After an action
    * the walk goes on as soon as something changed since the action, Bitwig called flush() after that change (it had
    * delivered the batch) and FAST.quiet ms passed without another; otherwise it falls back to SAFE's waits. The
    * double read stays: FAST.stable apart, but only for a reading that is what the walk expects (the next clip of the
    * lane's track, or the first clip of the track the lane is predicted to belong to); anything else waits SAFE.stable.
    * The end-of-lane recheck (nothing changed) keeps SAFE.recheck: there is no change to learn from.
    */
   static final Timing FAST = new Timing("fast", 40, 50, 1500, 50, 300, 40);

   /** Preferences > Score View (ScoreViewExtension): the timing of a read and lane skipping, both off = SAFE walk. */
   static final String TIMING_SETTING = "Read arrangement timing", TIMING_SAFE = "Safe (fixed waits)",
      TIMING_FAST = "Fast (adaptive waits, experimental)";
   static final String SKIP_SETTING = "Read arrangement: step past audio and effect lanes (experimental)";

   /**
    * One entry of the flat track bank, in order (groups opened): the lane the walk expects at that position. notes =
    * Track.canHoldNoteData(); type = Track.trackType() (for the log).
    */
   record LaneInfo(String name, boolean group, boolean notes, String type) {}

   private static final int MAX_STEPS_PER_LANE = 400, LOOP_WAIT_MS = 800;

   private final ControllerHost host;
   private final Application app;
   private final Transport transport;
   private final Clip clip;
   private final Track clipTrack;
   private final Map<String, NoteStep> notes;
   private final Object lock;
   private final LongSupplier lastChangeMs;
   private final IntSupplier laneCount;
   private final Runnable onChange;
   private final java.util.function.BooleanSupplier expandGroups; // expands collapsed groups; true if any changed
   private final Runnable restoreGroups;
   private final java.util.function.Supplier<String> trackListJson; // flat track list, taken while groups are open
   private volatile String tracksJson = "[]";
   private final int stepsPerBeat;

   private Phase phase = Phase.IDLE, after;
   private long actAt;
   private volatile String state = "idle", message = "";
   /** What the user can do about an error (statusJson "fix"): "stop" playback, "clickClip" in the Arranger, or "" (none). */
   private volatile String fix = "";
   private volatile int lane, lanes, clipCount;
   private final List<String> clipsJson = new ArrayList<>();
   private volatile String resultJson = "[]";
   private final Set<String> seen = new HashSet<>();
   private String prevKey, laneTrack;
   // The item read before on this lane: when "Select next item" lands inside it with the same notes, Bitwig's focus is
   // in the clip's notes (e.g. after notes were selected from Score View) and the actions walk notes, not clips.
   private String prevContent;
   private double prevStart, prevSpan;
   // (Tried live, 2026-10-17: "Unselect All", "Focus panel above" and "focus_or_toggle_arranger" do not get the
   // selection actions out of the notes; only clicking a clip in the Arranger does. So the crawl stops instead.)
   private int laneSteps, restoreLane, restoreSteps;
   private long recheckUntil; // when a step looks like the end of a lane, look again once before believing it
   private String stableKey;  // a clip is recorded only after its key reads the same twice, STABLE_MS apart
   private long stableAt;
   private double origPlayStart, origClipStart;
   // The clip's visible length is not in the API; "Loop Selection" sets the loop to it exactly. Each loop change
   // is one undo entry, so it is undone straight away (verified; on any doubt: redo, restore by hand, stop undoing).
   private boolean origLoopOn, useUndo, exactLengths;
   private double origLoopStart, origLoopLength;
   private String pendingClip;
   private String origTrack;
   private String firstTrack; // the first clip recorded and its lane (startedBelowTop)
   private int firstLane;
   private int origLane = -1;
   private boolean cancel;
   // Targeted read: the wanted track names (null = every lane), those read so far, and whether every lane that could
   // hold one was looked at (false when cancelled).
   private Set<String> only;
   private final Set<String> found = new java.util.LinkedHashSet<>();
   private volatile boolean complete;
   private Runnable onDone = () -> { };

   // Speed (configure()): adaptive waits (FAST) and stepping past lanes of tracks that cannot hold notes.
   private LongSupplier flushClock = () -> 0;
   private java.util.function.Supplier<List<LaneInfo>> laneInfoSource = () -> null;
   private boolean adaptive, skipLanes;
   private Timing timing = SAFE;
   // The lanes the walk expects (the flat bank at BEGIN); verified on every clip seen for the first time: its track must
   // be the lane's. One that is not turns skipping off, and when lanes were already stepped past the walk starts again
   // from the first lane without skipping (clips already read are not read twice).
   private List<LaneInfo> laneInfo;
   private final Set<String> looked = new HashSet<>(); // every clip key a RECORD step has seen (a stale selection is not new)
   private volatile String laneOrder = "unknown";      // unknown | verified | differs
   private volatile int skipped, verified;
   private boolean rewalked, rewalkPending, pureWait;
   private int pureWaitMs;
   private volatile long startedAt, tookMs;

   ArrangementCrawler(final ControllerHost host, final Application app, final Transport transport, final Clip clip,
      final Track clipTrack, final Map<String, NoteStep> notes, final Object lock, final LongSupplier lastChangeMs,
      final IntSupplier laneCount, final Runnable onChange, final int stepsPerBeat,
      final java.util.function.BooleanSupplier expandGroups, final Runnable restoreGroups,
      final java.util.function.Supplier<String> trackListJson)
   {
      this.host = host; this.app = app; this.transport = transport; this.clip = clip; this.clipTrack = clipTrack;
      this.notes = notes; this.lock = lock; this.lastChangeMs = lastChangeMs; this.laneCount = laneCount;
      this.onChange = onChange; this.stepsPerBeat = stepsPerBeat;
      this.expandGroups = expandGroups; this.restoreGroups = restoreGroups; this.trackListJson = trackListJson;
   }

   boolean running() { return phase != Phase.IDLE; }

   /** True when the last crawl looked at every lane it had to (false when cancelled or failed). */
   boolean complete() { return complete; }

   /** True when the last (or current) crawl reads only some tracks. */
   boolean subset() { return only != null; }

   /** Runs on the control thread when a crawl finishes with a result (state "done"). */
   void setOnDone(final Runnable r) { onDone = r == null ? () -> { } : r; }

   /** When Bitwig last called the extension's flush() (ms), for the adaptive waits. */
   void setFlushClock(final LongSupplier clock) { flushClock = clock == null ? () -> 0 : clock; }

   /** The flat track bank in order, read at the start of a walk (null = unknown: every lane is walked). */
   void setLaneInfo(final java.util.function.Supplier<List<LaneInfo>> source) { laneInfoSource = source == null ? () -> null : source; }

   /** For the next start: adaptive waits (FAST) and stepping past lanes that cannot hold notes. Both false = SAFE walk. */
   void configure(final boolean adaptiveWaits, final boolean skipNoteless)
   {
      if (running()) return;
      adaptive = adaptiveWaits;
      skipLanes = skipNoteless;
   }

   /** exact: also measure each clip's visible length with Loop Selection (+ verified undo); off = faster, loop untouched. */
   void start(final boolean exact)
   {
      start(exact, null);
   }

   /** As {@link #start(boolean)}; tracks = only these track names (a targeted read), null = every lane. */
   void start(final boolean exact, final Set<String> tracks)
   {
      if (running()) return;
      only = tracks == null ? null : new java.util.LinkedHashSet<>(tracks);
      synchronized (found) { found.clear(); }
      complete = false;
      exactLengths = exact;
      if (transport.isPlaying().get()) { fail("Stop playback first.", "stop"); return; }
      if (!clip.exists().get()) { fail("Click any clip in Bitwig's Arranger timeline first (this puts Bitwig's focus on the timeline).", "clickClip"); return; }
      clipsJson.clear(); seen.clear(); resultJson = "[]";
      clipCount = 0; lane = 0; cancel = false; origLane = -1; firstTrack = null;
      timing = adaptive ? FAST : SAFE;
      looked.clear(); laneInfo = null; laneOrder = "unknown"; skipped = 0; verified = 0; rewalked = false; rewalkPending = false; pureWait = false;
      startedAt = System.currentTimeMillis(); tookMs = 0;
      origPlayStart = transport.playStartPosition().get();
      origClipStart = origPlayStart; // Bitwig moved the play start to the clip the user selected
      origTrack = clipTrack.name().get();
      origLoopOn = transport.isArrangerLoopEnabled().get();
      origLoopStart = transport.arrangerLoopStart().get();
      origLoopLength = transport.arrangerLoopDuration().get();
      useUndo = true;
      pendingClip = null;
      state = "running"; message = "Preparing"; fix = "";
      // Tracks inside collapsed groups have no lanes: open the groups first (closed again at the end).
      final boolean expanded = expandGroups.getAsBoolean();
      actAt = System.currentTimeMillis() + (expanded ? 400 : 0);
      after = Phase.BEGIN;
      phase = Phase.WAIT;
      host.scheduleTask(this::tick, 15);
   }

   void cancel() { if (running()) cancel = true; }

   /** JSON status; includes the clips once finished. */
   String statusJson()
   {
      return "{\"state\":\"" + state + "\",\"message\":" + ScoreViewExtension.jsonStr(message) + ",\"lane\":" + lane
         + ",\"lanes\":" + lanes + ",\"clips\":" + clipCount + ",\"stepsPerBeat\":" + stepsPerBeat
         + ",\"timing\":\"" + timing.name() + "\",\"skipLanes\":" + skipLanes + ",\"skipped\":" + skipped
         + ",\"fix\":\"" + fix + "\",\"laneOrder\":\"" + laneOrder + "\",\"rewalked\":" + rewalked
         + ",\"ms\":" + (running() ? System.currentTimeMillis() - startedAt : tookMs)
         + (only != null ? ",\"subset\":" + jsonList(only) + ",\"found\":" + jsonList(found) + ",\"complete\":" + complete : "")
         + (state.equals("done") ? ",\"tracks\":" + tracksJson + ",\"result\":" + resultJson : "") + "}";
   }

   private static String jsonList(final Set<String> names)
   {
      final StringBuilder sb = new StringBuilder("[");
      synchronized (names) { for (final String n : names) { if (sb.length() > 1) sb.append(','); sb.append(ScoreViewExtension.jsonStr(n)); } }
      return sb.append(']').toString();
   }

   private void fail(final String why) { fail(why, ""); }

   private void fail(final String why, final String fixIt)
   {
      state = "error"; message = why; fix = fixIt; phase = Phase.IDLE; onChange.run();
   }

   private void act(final String id, final Phase next)
   {
      final Action a = app.getAction(id);
      if (a == null) { fail("Bitwig action not found: " + id); return; }
      a.invoke();
      actAt = System.currentTimeMillis();
      after = next;
      phase = Phase.WAIT;
      pureWait = false;
   }

   /**
    * "Move cursor to next lane" (selects nothing, so no update is expected): the fast walk only pauses
    * timing.laneMove ms; the safe walk waits for quiet as after any action.
    */
   private void moveToNextLane(final Phase next)
   {
      act("Move cursor to next lane", next);
      if (phase == Phase.WAIT && timing != SAFE) { pureWait = true; pureWaitMs = timing.laneMove(); }
   }

   /** The phase for the lane the cursor has just reached: step past it (cannot hold notes) or select its first item. */
   private Phase laneEntry()
   {
      return canSkip(lane) ? Phase.SKIP_LANE : Phase.FIRST_ITEM;
   }

   /**
    * True when lane i may be stepped past: skipping is on, the lane order has not turned out different, and the bank
    * says the track there cannot hold notes (audio, effect, master). Groups are walked: whether a group lane can hold
    * note clips is not known.
    */
   private boolean canSkip(final int i)
   {
      if (!skipLanes || laneInfo == null || "differs".equals(laneOrder) || i < 0 || i >= laneInfo.size()) return false;
      final LaneInfo li = laneInfo.get(i);
      return !li.notes() && !li.group();
   }

   /** The track lane i is expected to belong to, or null when unknown. */
   private String expectedTrack(final int i)
   {
      return laneInfo != null && !"differs".equals(laneOrder) && i >= 0 && i < laneInfo.size() ? laneInfo.get(i).name() : null;
   }

   /**
    * A clip seen for the first time: is it on the track its lane was predicted to be? Returns true when the walk must
    * start again from the first lane (the order differs and lanes were already stepped past).
    */
   private boolean checkLaneOrder(final String track)
   {
      if (laneInfo == null || "differs".equals(laneOrder) || lane >= laneInfo.size()) return false;
      if (track.equals(laneInfo.get(lane).name())) { verified++; laneOrder = "verified"; return false; }
      laneOrder = "differs";
      host.println("Score View crawler: lane " + lane + " holds " + track + ", the track list says " + laneInfo.get(lane).name()
         + (skipped > 0 ? "; walking every lane again without stepping past any" : "; not stepping past lanes"));
      return skipped > 0 && !rewalked;
   }

   private void tick()
   {
      if (phase == Phase.IDLE) return;
      try { step(); }
      catch (final Exception e) { fail("Crawler error: " + e); host.errorln("Score View crawler: " + e); }
      if (phase != Phase.IDLE) host.scheduleTask(this::tick, 15);
   }

   private void step()
   {
      final long now = System.currentTimeMillis();
      if (cancel && phase.ordinal() < Phase.R_FIRST_LANE.ordinal() && phase != Phase.WAIT) { cancel = false; message = "Cancelled"; beginRestore(); return; }
      switch (phase)
      {
         case WAIT ->
         {
            final long since = now - actAt, last = lastChangeMs.getAsLong(), quiet = now - last;
            if (pureWait) { if (since >= pureWaitMs) phase = after; return; }
            final boolean settled = (since >= SAFE.min() && quiet >= SAFE.quiet()) || since >= SAFE.max();
            // Fast walk: something changed after the action, Bitwig flushed after that change, then a short quiet.
            final boolean delivered = timing != SAFE && last >= actAt && flushClock.getAsLong() >= last
               && since >= timing.min() && quiet >= timing.quiet();
            if (settled || delivered) phase = after;
         }
         case BEGIN ->
         {
            lanes = Math.max(1, laneCount.getAsInt());
            tracksJson = trackListJson.get();
            final List<LaneInfo> info = laneInfoSource.get();
            laneInfo = info != null && info.size() == lanes ? List.copyOf(info) : null; // a different count: no prediction
            message = "Reading lane 1 of " + lanes + (only != null ? " (" + only.size() + " track" + (only.size() == 1 ? "" : "s") + ")" : "");
            act("Move cursor to first lane", laneEntry());
         }
         case SKIP_LANE -> // the cursor is on a lane that cannot hold notes: on to the next one without selecting anything
         {
            skipped++;
            lane++;
            message = "Reading lane " + Math.min(lane + 1, lanes) + " of " + lanes + " — " + clipCount + " clips";
            if (lane >= lanes) { complete = true; beginRestore(); }
            else moveToNextLane(laneEntry());
         }
         case REWALK -> // the lane order differs from the track list after lanes were stepped past: walk them all again
         {
            rewalked = true;
            lane = 0;
            laneTrack = null; prevKey = null; prevContent = null;
            act("Move cursor to first lane", Phase.FIRST_ITEM);
         }
         case FIRST_ITEM -> { laneSteps = 0; prevKey = null; prevContent = null; laneTrack = null; act("Select first item", Phase.RECORD_FIRST); }
         case RECORD_FIRST, RECORD_NEXT ->
         {
            final boolean first = phase == Phase.RECORD_FIRST;
            final boolean exists = clip.exists().get();
            final String track = exists ? clipTrack.name().get() : "";
            final double start = transport.playStartPosition().get();
            final String key = track + "@" + start + "#" + fingerprint();
            final boolean endOfLane = !exists || (!first && (key.equals(prevKey) || !track.equals(laneTrack)));
            if (endOfLane)
            {
               // Bitwig may not have finished switching clips (e.g. an empty clip sends no note updates): recheck once.
               if (recheckUntil == 0) { recheckUntil = now + timing.recheck(); return; }
               if (now < recheckUntil) return;
               recheckUntil = 0;
               phase = Phase.NEXT_LANE;
               return;
            }
            recheckUntil = 0;
            // The fast walk trusts a shorter double read only for what it expects to see (see FAST).
            final boolean expected = first ? track.equals(expectedTrack(lane)) : track.equals(laneTrack);
            final int stable = timing != SAFE && expected ? timing.stable() : SAFE.stable();
            if (!key.equals(stableKey)) { stableKey = key; stableAt = now; return; }
            if (now - stableAt < stable) return;
            stableKey = null;
            final String content = track + "#" + fingerprint() + "|" + clip.getPlayStart().get();
            if (!first && content.equals(prevContent) && start > prevStart + 1e-6 && start < prevStart + prevSpan - 1e-6)
            {
               abortNotesFocus();
               return;
            }
            prevContent = content; prevStart = start; prevSpan = clip.getPlayStop().get() - clip.getPlayStart().get();
            if (first) laneTrack = track;
            if (looked.add(key) && checkLaneOrder(track)) rewalkPending = true; // a clip never seen before: whose lane?
            if (first && only != null)
            {
               // Targeted read: whose lane is this? Walk it only for a wanted track not read yet (an empty lane may
               // leave the previous lane's clip selected, which must not be read twice).
               if (track.equals(origTrack) && origLane < 0) origLane = lane; // to find the original clip again
               if (!only.contains(track) || found.contains(track)) { phase = Phase.NEXT_LANE; return; }
            }
            final boolean fresh = seen.add(key);
            if (fresh) record(track, start);
            prevKey = key;
            if (++laneSteps >= MAX_STEPS_PER_LANE) { finishClip(-1); phase = Phase.NEXT_LANE; return; }
            // A looping clip may repeat any number of times in the arranger and Bitwig does not report how far:
            // measure it (Loop Selection, undone at once). Other clips end at their content's play stop.
            final boolean measure = exactLengths || clip.isLoopEnabled().get();
            if (fresh && !measure) finishClip(-1);
            phase = fresh && measure ? Phase.LOOP_SEL : Phase.NEXT_ITEM;
         }
         case LOOP_SEL -> act("Loop Selection", Phase.LOOP_READ);
         case LOOP_READ ->
         {
            final double ls = transport.arrangerLoopStart().get(), ll = transport.arrangerLoopDuration().get();
            // Wait (bounded) for Bitwig to report the new loop before trusting it.
            if (Math.abs(ls - transport.playStartPosition().get()) > 1e-6 && now - actAt < LOOP_WAIT_MS) return;
            finishClip(Math.abs(ls - transport.playStartPosition().get()) < 1e-6 ? ll : -1);
            if (loopMoved() && useUndo) { app.undo(); actAt = now; after = Phase.UNDO_CHECK; phase = Phase.WAIT; }
            else phase = Phase.NEXT_ITEM;
         }
         case UNDO_CHECK ->
         {
            if (loopMoved() && now - actAt < LOOP_WAIT_MS) return; // give the undo time to land before judging it
            if (loopMoved())
            {
               // The undo did not revert our loop change, so it reverted something else: put that back,
               // restore the loop by hand and stop using undo for the rest of the crawl.
               app.redo();
               useUndo = false;
               restoreLoopRange();
               host.println("Score View crawler: undo did not revert the loop; restored by hand and stopped using undo");
            }
            phase = Phase.NEXT_ITEM;
         }
         case NEXT_ITEM ->
         {
            if (rewalkPending) { rewalkPending = false; phase = Phase.REWALK; return; }
            act("Select next item", Phase.RECORD_NEXT);
         }
         case NEXT_LANE ->
         {
            if (only != null && laneTrack != null && only.contains(laneTrack)) synchronized (found) { found.add(laneTrack); }
            if (rewalkPending) { rewalkPending = false; phase = Phase.REWALK; return; }
            lane++;
            message = "Reading lane " + Math.min(lane + 1, lanes) + " of " + lanes + " — " + clipCount + " clips"
               + (only != null ? " (" + found.size() + " of " + only.size() + " tracks)" : "");
            onChange.run();
            // A targeted read stops once every wanted track is read and the original clip's lane was seen (the restore
            // walks back to that lane).
            final boolean allFound = only != null && found.containsAll(only) && origLane >= 0;
            if (lane >= lanes || allFound) { complete = true; beginRestore(); }
            else moveToNextLane(laneEntry());
         }
         case R_FIRST_LANE -> { restoreLane = 0; act("Move cursor to first lane", origLane > 0 ? Phase.R_NEXT_LANE : Phase.R_FIRST_ITEM); }
         case R_NEXT_LANE ->
         {
            restoreLane++;
            act("Move cursor to next lane", restoreLane < origLane ? Phase.R_NEXT_LANE : Phase.R_FIRST_ITEM);
         }
         case R_FIRST_ITEM -> { restoreSteps = 0; act("Select first item", Phase.R_CHECK); }
         case R_CHECK ->
         {
            final boolean found = clip.exists().get() && Math.abs(transport.playStartPosition().get() - origClipStart) < 1e-6
               && origTrack.equals(clipTrack.name().get());
            if (found || ++restoreSteps > MAX_STEPS_PER_LANE) phase = Phase.R_FINISH;
            else act("Select next item", Phase.R_CHECK);
         }
         case R_FINISH ->
         {
            finishClip(-1);
            if (loopMoved()) restoreLoopRange();
            if (transport.isArrangerLoopEnabled().get() != origLoopOn) transport.isArrangerLoopEnabled().set(origLoopOn);
            transport.playStartPosition().set(origPlayStart);
            restoreGroups.run();
            final String below = message.startsWith("Cancelled") ? null : startedBelowTop();
            if (below != null)
            {
               clipsJson.clear(); clipCount = 0;
               host.println("Score View crawler: the walk began on " + below + " (lane " + firstLane + "), below other tracks; no result");
               fail("The read began at " + below + " instead of the top of the track list, so the tracks above it were "
                  + "missed (Bitwig's \"first lane\" stays inside the selected clip's group). Click a clip in the top "
                  + "track, then try again.", "clickClip");
               return;
            }
            resultJson = "[" + String.join(",", clipsJson) + "]";
            tookMs = System.currentTimeMillis() - startedAt;
            state = "done";
            if (!message.startsWith("Cancelled"))
               message = only != null ? "Read " + clipCount + " clips on " + found.size() + " of " + only.size() + " tracks"
                  : "Read " + clipCount + " clips on " + lanes + " lanes";
            phase = Phase.IDLE;
            onChange.run();
            onDone.run();
         }
         default -> { }
      }
   }

   /**
    * A full read whose walk did not begin at the top: "Move cursor to first lane" goes to the first lane of the group the
    * cursor is in (live 2026-10-23: a clip selected in the Percussion group, lane 0 = Percussion I, 8 of 69 clips read).
    * The first clip's track is returned when, in the flat track list, more note tracks outside its own group come before
    * it than lanes the walk had passed when it read that clip (a walk from the top passes at least one lane per track).
    * null = fine, or nothing to judge by (targeted read, no track list, no clip).
    */
   private String startedBelowTop()
   {
      if (only != null || laneInfo == null || firstTrack == null) return null;
      int idx = -1;
      for (int i = 0; i < laneInfo.size() && idx < 0; i++) if (!laneInfo.get(i).group() && laneInfo.get(i).name().equals(firstTrack)) idx = i;
      if (idx < 0) return null;
      final int grp = groupAbove(idx);
      int above = 0;
      for (int i = 0; i < idx; i++)
      {
         final LaneInfo li = laneInfo.get(i);
         if (!li.group() && li.notes() && !(grp >= 0 && groupAbove(i) == grp)) above++;
      }
      return firstLane < above ? firstTrack : null;
   }

   /** Index of the nearest group entry before i in the flat track list, or -1. */
   private int groupAbove(final int i)
   {
      for (int j = i - 1; j >= 0; j--) if (laneInfo.get(j).group()) return j;
      return -1;
   }

   /** Closes the pending clip's JSON with its visible length (beats), or without one when unknown (< 0). */
   private void finishClip(final double length)
   {
      if (pendingClip == null) return;
      clipsJson.add(pendingClip + (length > 0 ? ",\"length\":" + length : "") + "}");
      pendingClip = null;
   }

   private boolean loopMoved()
   {
      return Math.abs(transport.arrangerLoopStart().get() - origLoopStart) > 1e-6
         || Math.abs(transport.arrangerLoopDuration().get() - origLoopLength) > 1e-6;
   }

   private void restoreLoopRange()
   {
      transport.arrangerLoopStart().set(origLoopStart);
      transport.arrangerLoopDuration().set(origLoopLength);
   }

   /**
    * The selection actions are stepping through notes inside a clip: stop without a result (it would hold one copy of the
    * clip per note) and without the selection-based restore (it would walk notes too); put play start, loop and groups back.
    */
   private void abortNotesFocus()
   {
      clipsJson.clear(); pendingClip = null; clipCount = 0;
      if (loopMoved()) restoreLoopRange();
      if (transport.isArrangerLoopEnabled().get() != origLoopOn) transport.isArrangerLoopEnabled().set(origLoopOn);
      transport.playStartPosition().set(origPlayStart);
      restoreGroups.run();
      host.println("Score View crawler: the selection actions walk notes inside a clip; stopped");
      fail("Bitwig is stepping through the notes inside the clip, not through clips. Click the clip itself in the "
         + "Arranger timeline (not a note in the clip editor), then try again.", "clickClip");
   }


   private void beginRestore()
   {
      if (origLane >= 0) phase = Phase.R_FIRST_LANE;
      else { act("Unselect All", Phase.R_FINISH); }
   }

   private String fingerprint()
   {
      final StringBuilder fp = new StringBuilder();
      synchronized (lock)
      {
         int n = 0;
         for (final NoteStep s : notes.values()) { if (n++ >= 8) break; fp.append(s.x()).append(':').append(s.y()).append(','); }
         fp.append(notes.size());
      }
      return fp + "|" + clip.getPlayStop().get();
   }

   private void record(final String track, final double start)
   {
      if (track.equals(origTrack) && Math.abs(start - origClipStart) < 1e-6) origLane = lane;
      if (firstTrack == null) { firstTrack = track; firstLane = lane; }
      final StringBuilder sb = new StringBuilder(2048);
      sb.append("{\"lane\":").append(lane)
         .append(",\"track\":").append(ScoreViewExtension.jsonStr(track))
         .append(",\"start\":").append(start)
         .append(",\"playStart\":").append(clip.getPlayStart().get())
         .append(",\"playStop\":").append(clip.getPlayStop().get())
         .append(",\"loop\":").append(clip.isLoopEnabled().get())
         .append(",\"loopStart\":").append(clip.getLoopStart().get())
         .append(",\"loopLength\":").append(clip.getLoopLength().get())
         .append(",\"notes\":[");
      synchronized (lock)
      {
         boolean firstNote = true;
         for (final NoteStep s : notes.values())
         {
            if (!firstNote) sb.append(',');
            firstNote = false;
            sb.append('[').append(s.channel()).append(',').append(s.x()).append(',').append(s.y()).append(',')
              .append(s.duration()).append(',').append(Math.round(s.velocity() * 127)).append(']');
         }
      }
      sb.append(']');
      finishClip(-1);
      pendingClip = sb.toString();
      clipCount++;
   }
}
