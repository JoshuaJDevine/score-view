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
 */
final class ArrangementCrawler
{
   private enum Phase { IDLE, WAIT, BEGIN, FIRST_ITEM, RECORD_FIRST, RECORD_NEXT, LOOP_SEL, LOOP_READ, UNDO_CHECK, NEXT_ITEM, NEXT_LANE, R_FIRST_LANE, R_NEXT_LANE, R_FIRST_ITEM, R_CHECK, R_FINISH }

   private static final int SETTLE_QUIET_MS = 80, SETTLE_MIN_MS = 110, SETTLE_MAX_MS = 1500, MAX_STEPS_PER_LANE = 400, RECHECK_MS = 300, STABLE_MS = 120, LOOP_WAIT_MS = 800;

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
   private volatile int lane, lanes, clipCount;
   private final List<String> clipsJson = new ArrayList<>();
   private volatile String resultJson = "[]";
   private final Set<String> seen = new HashSet<>();
   private String prevKey, laneTrack;
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
   private int origLane = -1;
   private boolean cancel;

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

   /** exact: also measure each clip's visible length with Loop Selection (+ verified undo); off = faster, loop untouched. */
   void start(final boolean exact)
   {
      if (running()) return;
      exactLengths = exact;
      if (transport.isPlaying().get()) { fail("Stop playback first."); return; }
      if (!clip.exists().get()) { fail("Click any clip in the Arranger first (this puts Bitwig's focus on the timeline)."); return; }
      clipsJson.clear(); seen.clear(); resultJson = "[]";
      clipCount = 0; lane = 0; cancel = false; origLane = -1;
      origPlayStart = transport.playStartPosition().get();
      origClipStart = origPlayStart; // Bitwig moved the play start to the clip the user selected
      origTrack = clipTrack.name().get();
      origLoopOn = transport.isArrangerLoopEnabled().get();
      origLoopStart = transport.arrangerLoopStart().get();
      origLoopLength = transport.arrangerLoopDuration().get();
      useUndo = true;
      pendingClip = null;
      state = "running"; message = "Preparing";
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
         + (state.equals("done") ? ",\"tracks\":" + tracksJson + ",\"result\":" + resultJson : "") + "}";
   }

   private void fail(final String why)
   {
      state = "error"; message = why; phase = Phase.IDLE; onChange.run();
   }

   private void act(final String id, final Phase next)
   {
      final Action a = app.getAction(id);
      if (a == null) { fail("Bitwig action not found: " + id); return; }
      a.invoke();
      actAt = System.currentTimeMillis();
      after = next;
      phase = Phase.WAIT;
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
            final long since = now - actAt, quiet = now - lastChangeMs.getAsLong();
            if ((since >= SETTLE_MIN_MS && quiet >= SETTLE_QUIET_MS) || since >= SETTLE_MAX_MS) phase = after;
         }
         case BEGIN ->
         {
            lanes = Math.max(1, laneCount.getAsInt());
            tracksJson = trackListJson.get();
            message = "Reading lane 1 of " + lanes;
            act("Move cursor to first lane", Phase.FIRST_ITEM);
         }
         case FIRST_ITEM -> { laneSteps = 0; prevKey = null; laneTrack = null; act("Select first item", Phase.RECORD_FIRST); }
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
               if (recheckUntil == 0) { recheckUntil = now + RECHECK_MS; return; }
               if (now < recheckUntil) return;
               recheckUntil = 0;
               phase = Phase.NEXT_LANE;
               return;
            }
            recheckUntil = 0;
            if (!key.equals(stableKey)) { stableKey = key; stableAt = now; return; }
            if (now - stableAt < STABLE_MS) return;
            stableKey = null;
            if (first) laneTrack = track;
            final boolean fresh = seen.add(key);
            if (fresh) record(track, start);
            prevKey = key;
            if (++laneSteps >= MAX_STEPS_PER_LANE) { finishClip(-1); phase = Phase.NEXT_LANE; return; }
            if (fresh && !exactLengths) finishClip(-1);
            phase = fresh && exactLengths ? Phase.LOOP_SEL : Phase.NEXT_ITEM;
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
         case NEXT_ITEM -> act("Select next item", Phase.RECORD_NEXT);
         case NEXT_LANE ->
         {
            lane++;
            message = "Reading lane " + Math.min(lane + 1, lanes) + " of " + lanes + " — " + clipCount + " clips";
            onChange.run();
            if (lane >= lanes) beginRestore();
            else act("Move cursor to next lane", Phase.FIRST_ITEM);
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
            resultJson = "[" + String.join(",", clipsJson) + "]";
            state = "done";
            if (!message.startsWith("Cancelled")) message = "Read " + clipCount + " clips on " + lanes + " lanes";
            phase = Phase.IDLE;
            onChange.run();
         }
         default -> { }
      }
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
