package claude.scoreview;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;

import com.bitwig.extension.controller.api.Action;
import com.bitwig.extension.controller.api.Application;
import com.bitwig.extension.controller.api.Clip;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.Transport;

/**
 * Selects a given arranger clip so that edits ("add ..." ops) land in it: the extension can only write into the
 * arranger cursor clip, i.e. the selected clip. Uses the same Bitwig actions as {@link ArrangementCrawler}
 * ("Move cursor to first/next lane", "Select first/next item"); a clip is identified by its track and its arranger
 * start, which Bitwig reports through the play start marker when the clip gets selected.
 *
 * Ops (POST /api/edit):
 *   goto <lane> <startBeats> <trackName, URL-encoded>   select that clip (lane = crawl lane, a hint)
 *   gotoStay <lane> <startBeats> <trackName>              select that clip and END the session there (Sibelius-style
 *                                                         paste: Bitwig is left on the pasted clip). Groups opened for
 *                                                         the session are closed again; the play start marker goes back
 *                                                         where it was, or stays on the clip with Preferences > Score
 *                                                         View > "Play start after pasting into another clip"
 *                                                         (default: leave it where it was). No gotoHome, no auto-home.
 *                                                         On failure it returns home instead and the ops after it are
 *                                                         dropped (they never land in the home clip).
 *   gotoHome [lane]                                       select the clip that was selected before the first goto,
 *                                                         restore play start and groups, end the session
 *   navCancel                                             (handled on the HTTP thread) abort: drop the rest of the
 *                                                         batch except gotoHome
 * A navigation session starts with the first goto/gotoStay and ends with gotoHome or gotoStay (gotoHome is sent
 * automatically after AUTO_HOME_MS without further ops while a session is open). While a goto runs, the extension's
 * edit queue pauses; after a failed goto the following edit ops are dropped until the next goto/gotoStay/gotoHome,
 * so they never land in the wrong clip. A batch the navigator refuses (playing, launcher source, ...) is dropped up
 * to its gotoHome/gotoStay.
 * Status: GET /api/nav ({@link #statusJson}); {@code batches} counts the gotoHome/gotoStay ops handled (each ends a
 * batch the page waits for; a gotoStay's batch is counted once the edit queue has run empty, i.e. after the edits
 * that follow it have landed or been dropped), {@code stayed} = {track, start} of the clip the last gotoStay ended on (null otherwise),
 * {@code lastTarget.stay} marks a gotoStay target.
 */
final class ClipNavigator
{
   private enum Phase { IDLE, WAIT, BEGIN, NEXT_LANE, FIRST_ITEM, CHECK, NEXT_ITEM }

   private static final int SETTLE_QUIET_MS = 80, SETTLE_MIN_MS = 110, SETTLE_MAX_MS = 1500, STABLE_MS = 120,
      RECHECK_MS = 300, MAX_STEPS_PER_LANE = 400, GROUP_OPEN_MS = 400;
   static final long AUTO_HOME_MS = 2500;
   private static final double EPS = 1e-4;

   /** Preferences > Score View: where the play start marker goes after a gotoStay. */
   static final String STAY_PLAY_START_SETTING = "Play start after pasting into another clip",
      PLAY_START_KEEP = "Leave it where it was", PLAY_START_TARGET = "Move it to the pasted clip";
   private BooleanSupplier stayPlayStartAtTarget = () -> false;

   void setStayPlayStartAtTarget(final BooleanSupplier s) { stayPlayStartAtTarget = s; }

   private final ControllerHost host;
   private final Application app;
   private final Transport transport;
   private final Clip clip;
   private final Track clipTrack;
   private final LongSupplier lastChangeMs;
   private final IntSupplier laneCount;
   private final BooleanSupplier expandGroups;
   private final Runnable restoreGroups;
   private final Runnable onChange;
   private final BooleanSupplier arrangerActive;
   private final BooleanSupplier crawling;

   private Phase phase = Phase.IDLE, after;
   private long actAt;

   // session
   private volatile boolean session;
   private String homeTrack;
   private double homeStart, origPlayStart;
   private final Map<String, Integer> laneOfTrack = new HashMap<>();
   private boolean skipping, aborting;
   private volatile boolean cancelRequested;
   private int dropped;
   private final List<String> results = new ArrayList<>();
   private volatile long batches; // gotoHome/gotoStay batches handled (session ended, or batch refused): the page waits for this

   // gotoStay: the current navigation ends the session on its target; stayFailed = it failed, so the ops after it
   // are dropped even once the session has ended at home
   private boolean stay, stayFailed;
   // A session ended by a gotoStay (reached or failed) is counted in batches only once the queue has run empty: the
   // edits after the gotoStay are still queued then, and the page must not see its batch finished before they land
   // (or are dropped).
   private boolean batchEndPending;
   private volatile String stayed = "null";

   // current navigation
   private boolean toHome, scanning, scanned, firstItem, ticking;
   private int lane, curLane, lanes, steps;
   private double target;
   private String track, prevKey, stableKey;
   private long stableAt, recheckUntil;

   private volatile String state = "idle", message = "", lastTarget = "null";

   ClipNavigator(final ControllerHost host, final Application app, final Transport transport, final Clip clip,
      final Track clipTrack, final LongSupplier lastChangeMs, final IntSupplier laneCount,
      final BooleanSupplier expandGroups, final Runnable restoreGroups, final Runnable onChange,
      final BooleanSupplier arrangerActive, final BooleanSupplier crawling)
   {
      this.host = host; this.app = app; this.transport = transport; this.clip = clip; this.clipTrack = clipTrack;
      this.lastChangeMs = lastChangeMs; this.laneCount = laneCount; this.expandGroups = expandGroups;
      this.restoreGroups = restoreGroups; this.onChange = onChange; this.arrangerActive = arrangerActive;
      this.crawling = crawling;
   }

   /** A goto is in progress: the edit queue must not advance. */
   boolean running() { return phase != Phase.IDLE; }

   /** Between the first goto and gotoHome: the page is not woken (it would see foreign clips). */
   boolean inSession() { return session; }

   static boolean isNavOp(final String op) { return op.equals("goto") || op.equals("gotoStay") || op.equals("gotoHome"); }

   /** Ops that end a batch (the page waits for {@code batches} to count them). */
   private static boolean endsBatch(final String op) { return op.equals("gotoHome") || op.equals("gotoStay"); }

   /** Called by the HTTP thread. */
   void requestCancel() { cancelRequested = true; }

   /**
    * Whether an op taken from the edit queue may be applied (control thread). After a failed goto the edits for
    * that clip are dropped; after a cancel everything up to gotoHome is.
    */
   boolean accept(final String[] op)
   {
      if (cancelRequested && session && !aborting) { aborting = true; results.add("cancelled"); message = "Cancelled"; }
      cancelRequested = false;
      if (aborting)
      {
         if ("gotoStay".equals(op[0]))
         {
            // A refused or cancelled batch ends here too: keep aborting so its edits are dropped; an open session
            // still goes home (auto-home), a refused one is counted now.
            dropped++;
            if (!session) { batches++; onChange.run(); }
            return false;
         }
         if (!"gotoHome".equals(op[0])) { dropped++; return false; }
         aborting = false;
         if (!session) { batches++; onChange.run(); } // a refused batch ends here
         return session;
      }
      if (skipping)
      {
         if (!isNavOp(op[0])) { dropped++; return false; }
         skipping = false;
      }
      return true;
   }

   /** The edit queue ran empty: outside a session nothing is pending any more. */
   void queueEmpty()
   {
      if (!session && !running())
      {
         aborting = false; skipping = false;
         if (batchEndPending) { batchEndPending = false; batches++; onChange.run(); }
      }
   }

   // ---------------------------------------------------------------- ops

   /** goto and gotoStay (op[0] says which). */
   void gotoClip(final String[] op)
   {
      final boolean st = "gotoStay".equals(op[0]);
      if (op.length < 4) { failOp(op[0] + " needs: lane startBeats trackName", st); return; }
      final int l;
      final double s;
      try { l = Integer.parseInt(op[1]); s = Double.parseDouble(op[2]); }
      catch (final NumberFormatException e) { failOp(op[0] + ": bad number in " + String.join(" ", op), st); return; }
      final String t = URLDecoder.decode(String.join(" ", java.util.Arrays.copyOfRange(op, 3, op.length)), StandardCharsets.UTF_8);
      if (!session && !beginSession())
      {
         aborting = true; dropped = 0; // the whole batch is dropped
         if (st) { batches++; onChange.run(); } // and it ends here
         return;
      }
      stay = st;
      start(false, l, s, t);
   }

   void gotoHome(final String[] op)
   {
      aborting = false;
      skipping = false;
      if (!session) { batches++; onChange.run(); return; }
      int l = -1;
      if (op.length > 1) try { l = Integer.parseInt(op[1]); } catch (final NumberFormatException e) { l = -1; }
      goHome(l);
   }

   private void goHome(int l)
   {
      stay = false;
      if (l < 0) l = laneOfTrack.getOrDefault(homeTrack, -1);
      if (l < 0) l = 0; // unknown: the scan finds it
      start(true, l, homeStart, homeTrack);
   }

   private boolean beginSession()
   {
      results.clear();
      stayed = "null";
      if (crawling.getAsBoolean()) return refuse("The arrangement is being read; try again when it has finished.");
      if (transport.isPlaying().get()) return refuse("Stop playback first.");
      if (!arrangerActive.getAsBoolean()) return refuse("Switch Score View to the Arranger source first.");
      if (!clip.exists().get()) return refuse("Click a clip in the Arranger first (this puts Bitwig's focus on the timeline).");
      session = true;
      results.clear();
      dropped = 0;
      laneOfTrack.clear();
      homeTrack = clipTrack.name().get();
      origPlayStart = transport.playStartPosition().get();
      homeStart = origPlayStart; // Bitwig moved the play start to the clip the user selected
      // Tracks inside collapsed groups have no lanes (and the crawl's lane numbers assume open groups).
      groupsOpened = expandGroups.getAsBoolean();
      return true;
   }

   private boolean refuse(final String why)
   {
      state = "error"; message = why; results.add("error: " + why);
      lastTarget = "null";
      host.println("Score View nav: " + why);
      onChange.run();
      return false;
   }

   private void failOp(final String why, final boolean st)
   {
      refuse(why);
      if (!session)
      {
         // Outside a session the batch is refused like any other (its edits must not land in the current clip);
         // a gotoStay ends its batch right here.
         aborting = true; dropped = 0;
         if (st) { batches++; onChange.run(); }
         return;
      }
      skipping = true;
      if (st) { stayFailed = true; goHome(-1); } // a malformed gotoStay still ends the session (at home)
   }

   private void start(final boolean home, final int l, final double s, final String t)
   {
      toHome = home; lane = l; target = s; track = t;
      scanning = false; scanned = false;
      lastTarget = "{\"lane\":" + l + ",\"start\":" + s + ",\"track\":" + ScoreViewExtension.jsonStr(t) + ",\"home\":" + home
         + ",\"stay\":" + (!home && stay) + "}";
      state = "running";
      message = (home ? "Returning to " : "Going to ") + t + " @ " + fmt(s);
      lanes = Math.max(1, laneCount.getAsInt());
      actAt = System.currentTimeMillis();
      waitUntil = groupsOpened ? actAt + GROUP_OPEN_MS : 0; // collapsed groups were just opened: give them time
      groupsOpened = false;
      after = Phase.BEGIN;
      phase = Phase.WAIT;
      if (!ticking) host.scheduleTask(this::tick, 15); // from inside tick (a failed gotoStay going home) it continues
   }

   private long waitUntil;
   private boolean groupsOpened;

   /** JSON for GET /api/nav. */
   String statusJson()
   {
      return "{\"state\":\"" + state + "\",\"message\":" + ScoreViewExtension.jsonStr(message)
         + ",\"session\":" + session + ",\"batches\":" + batches + ",\"dropped\":" + dropped
         + ",\"lastTarget\":" + lastTarget
         + ",\"home\":" + (homeTrack == null ? "null" : "{\"track\":" + ScoreViewExtension.jsonStr(homeTrack) + ",\"start\":" + homeStart + "}")
         + ",\"stayed\":" + stayed
         + ",\"results\":[" + String.join(",", results.stream().map(ScoreViewExtension::jsonStr).toList()) + "]}";
   }

   // ---------------------------------------------------------------- state machine

   private void act(final String id, final Phase next)
   {
      final Action a = app.getAction(id);
      if (a == null) { finish(false, "Bitwig action not found: " + id); return; }
      a.invoke();
      actAt = System.currentTimeMillis();
      waitUntil = 0;
      after = next;
      phase = Phase.WAIT;
   }

   private void tick()
   {
      if (phase == Phase.IDLE) return;
      ticking = true;
      try { step(); }
      catch (final Exception e) { finish(false, "Navigation error: " + e); host.errorln("Score View nav: " + e); }
      finally { ticking = false; }
      if (phase != Phase.IDLE) host.scheduleTask(this::tick, 15);
   }

   private void step()
   {
      final long now = System.currentTimeMillis();
      if (cancelRequested && !toHome) { finish(false, "Cancelled"); return; }
      switch (phase)
      {
         case WAIT ->
         {
            if (now < waitUntil) return;
            final long since = now - actAt, quiet = now - lastChangeMs.getAsLong();
            if ((since >= SETTLE_MIN_MS && quiet >= SETTLE_QUIET_MS) || since >= SETTLE_MAX_MS) phase = after;
         }
         case BEGIN ->
         {
            if (transport.isPlaying().get()) { finish(false, "Stop playback first."); return; }
            curLane = scanning ? 0 : Math.min(lane, lanes - 1);
            act("Move cursor to first lane", curLane > 0 ? Phase.NEXT_LANE : Phase.FIRST_ITEM);
            stepsToLane = curLane;
         }
         case NEXT_LANE -> act("Move cursor to next lane", --stepsToLane > 0 ? Phase.NEXT_LANE : Phase.FIRST_ITEM);
         case FIRST_ITEM ->
         {
            steps = 0; prevKey = null; stableKey = null; firstItem = true;
            act("Select first item", Phase.CHECK);
         }
         case CHECK -> check(now);
         case NEXT_ITEM -> { firstItem = false; act("Select next item", Phase.CHECK); }
         default -> { }
      }
   }

   private int stepsToLane;

   private void check(final long now)
   {
      final boolean exists = clip.exists().get();
      final String t = exists ? clipTrack.name().get() : "";
      final double ps = transport.playStartPosition().get();
      final String key = t + "@" + ps + "|" + clip.getPlayStop().get() + "|" + clip.getPlayStart().get();
      // Read the same state twice, STABLE_MS apart, before trusting it.
      if (!key.equals(stableKey)) { stableKey = key; stableAt = now; return; }
      if (now - stableAt < STABLE_MS) return;

      final boolean onTrack = exists && t.equals(track);
      if (onTrack && Math.abs(ps - target) < EPS) { recheckUntil = 0; laneOfTrack.put(track, curLane); finish(true, null); return; }
      final boolean endOfLane = !onTrack || (!firstItem && key.equals(prevKey));
      if (endOfLane)
      {
         // Bitwig may not have finished switching clips: look once more before believing it.
         if (recheckUntil == 0) { recheckUntil = now + RECHECK_MS; stableKey = null; return; }
         if (now < recheckUntil) return;
         recheckUntil = 0;
         if (firstItem && !onTrack)
         {
            // The lane holds another track (tracks were added or moved since the crawl): scan every lane once.
            if (scanning)
            {
               if (++curLane >= lanes) { finish(false, "Track not found in the arranger: " + track); return; }
               act("Move cursor to next lane", Phase.FIRST_ITEM);
               return;
            }
            if (!scanned) { scanning = true; scanned = true; phase = Phase.BEGIN; return; }
            finish(false, "Track not found in the arranger: " + track);
            return;
         }
         finish(false, "No clip on " + track + " starting at beat " + fmt(target) + " (was it moved or deleted? read the arrangement again)");
         return;
      }
      recheckUntil = 0;
      stableKey = null;
      if (firstItem) laneOfTrack.put(track, curLane);
      prevKey = key;
      if (++steps > MAX_STEPS_PER_LANE) { finish(false, "Gave up looking for the clip on " + track); return; }
      phase = Phase.NEXT_ITEM;
   }

   private static String fmt(final double v)
   {
      return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(Math.round(v * 1000) / 1000.0);
   }

   private void finish(final boolean ok, final String why)
   {
      phase = Phase.IDLE;
      final boolean staying = stay && !toHome;
      final String what = (toHome ? "home " : staying ? "stay " : "goto ") + track + " @ " + fmt(target);
      if (ok)
      {
         results.add("ok: " + what);
         message = (toHome ? "Back at " : staying ? "Stayed at " : "At ") + track + " @ " + fmt(target);
         state = "done";
      }
      else
      {
         results.add("error: " + what + ": " + why);
         message = why;
         state = "error";
         if (!toHome) skipping = true;
         host.println("Score View nav: " + what + ": " + why);
      }
      if (toHome) endSession(ok, false);
      else if (staying)
      {
         if (ok)
         {
            stayed = "{\"track\":" + ScoreViewExtension.jsonStr(track) + ",\"start\":" + target + "}";
            endSession(true, true);
         }
         else { stayFailed = true; goHome(-1); } // never leave the session open on a foreign clip
      }
      onChange.run();
   }

   /** Ends the session: at home (gotoHome / a failed gotoStay) or on a gotoStay's target ({@code stayed}). */
   private void endSession(final boolean reached, final boolean stayedThere)
   {
      if (!stayedThere || !stayPlayStartAtTarget.getAsBoolean()) transport.playStartPosition().set(origPlayStart);
      restoreGroups.run();
      session = false;
      stay = false;
      skipping = stayFailed; // the edits meant for a gotoStay target that was not reached must not land at home
      if (stayedThere || stayFailed) batchEndPending = true; // its edits are still queued: counted in queueEmpty()
      else batches++;
      stayFailed = false;
      aborting = false;
      cancelRequested = false;
      if (!reached) message = (stayedThere ? "Could not select the clip (" : "Could not reselect the original clip (") + message + ")";
      else if (results.stream().anyMatch(r -> r.startsWith("error") || r.equals("cancelled")))
         { state = "error"; message = "Finished with errors: " + String.join("; ", results.stream().filter(r -> !r.startsWith("ok")).toList()); }
   }
}
