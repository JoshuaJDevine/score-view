package claude.scoreview;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;

import com.bitwig.extension.controller.api.Clip;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.CursorClip;
import com.bitwig.extension.controller.api.NoteStep;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.Transport;

/**
 * Research only (Developer-mode op {@code clipStepProbe [n]}, test/clip-step-probe.mjs): does the arranger cursor clip's
 * own {@code CursorClip.selectNext()} walk arranger clips when it starts from a VALID selected clip? (The first probe ran
 * it with no clip selected and nothing happened.) If it did, a crawl could step clips without UI actions and keyboard
 * focus. The shipped crawl never uses it.
 *
 * From the selected clip it calls selectNext() n times, then selectPrevious() n times, and after each call records how
 * long the cursor clip took to change and what it shows (track, play start marker, note count, a fingerprint). Then
 * it puts the play start marker back. Result: GET /api/transport "probe". Control thread, ticked by host.scheduleTask.
 */
final class ClipStepProbe
{
   static final int SETTLE_MIN_MS = 150, SETTLE_QUIET_MS = 100, STEP_MAX_MS = 1500;

   private final ControllerHost host;
   private final Transport transport;
   private final Clip clip;
   private final Track clipTrack;
   private final Map<String, NoteStep> notes;
   private final Object lock;
   private final LongSupplier lastChangeMs;

   private volatile String state = "idle", message = "";
   private final List<String> steps = new ArrayList<>();
   private volatile String stepsJson = "[]", origin = "null";
   private int count, done;
   private boolean back;
   private long actAt;
   private String before, originKey;
   private double origPlayStart;

   ClipStepProbe(final ControllerHost host, final Transport transport, final Clip clip, final Track clipTrack,
      final Map<String, NoteStep> notes, final Object lock, final LongSupplier lastChangeMs)
   {
      this.host = host; this.transport = transport; this.clip = clip; this.clipTrack = clipTrack;
      this.notes = notes; this.lock = lock; this.lastChangeMs = lastChangeMs;
      if (clip instanceof CursorClip cc) { cc.hasNext().markInterested(); cc.hasPrevious().markInterested(); } // init time only
   }

   boolean running() { return "running".equals(state); }

   void start(final int n)
   {
      if (running()) return;
      steps.clear(); stepsJson = "[]"; origin = "null";
      if (!(clip instanceof CursorClip)) { state = "error"; message = "The arranger cursor clip is not a CursorClip in this API."; return; }
      if (!clip.exists().get()) { state = "error"; message = "Select a clip in the Arranger first: the probe must start from a valid clip."; return; }
      if (transport.isPlaying().get()) { state = "error"; message = "Stop playback first."; return; }
      count = n; done = 0; back = false;
      origPlayStart = transport.playStartPosition().get();
      originKey = key();
      origin = snapshot(-1, null);
      state = "running"; message = "selectNext() 1 of " + n;
      step();
   }

   String statusJson()
   {
      return "{\"state\":\"" + state + "\",\"message\":" + ScoreViewExtension.jsonStr(message) + ",\"origin\":" + origin
         + ",\"steps\":" + stepsJson + "}";
   }

   /** Calls the next selectNext()/selectPrevious() and starts waiting for the cursor clip to change. */
   private void step()
   {
      final CursorClip cc = (CursorClip) clip;
      before = key();
      actAt = System.currentTimeMillis();
      if (back) cc.selectPrevious(); else cc.selectNext();
      host.scheduleTask(this::tick, 15);
   }

   private void tick()
   {
      if (!running()) return;
      final long now = System.currentTimeMillis(), since = now - actAt, quiet = now - lastChangeMs.getAsLong();
      final boolean changed = !key().equals(before);
      if (!(since >= SETTLE_MIN_MS && quiet >= SETTLE_QUIET_MS) && since < STEP_MAX_MS) { host.scheduleTask(this::tick, 15); return; }
      steps.add(snapshot(changed ? Math.max(0, lastChangeMs.getAsLong() - actAt) : -1, back ? "prev" : "next"));
      stepsJson = "[" + String.join(",", steps) + "]";
      done++;
      if (!back && done >= count) { back = true; done = 0; }
      else if (back && done >= count) { finish(); return; }
      message = (back ? "selectPrevious() " : "selectNext() ") + (done + 1) + " of " + count;
      step();
   }

   private void finish()
   {
      final boolean home = key().equals(originKey);
      transport.playStartPosition().set(origPlayStart);
      state = "done";
      message = home ? "Back at the clip the probe started from" : "NOT back at the starting clip: select it again by hand";
      host.println("Score View clipStepProbe: " + statusJson());
   }

   /** What the cursor clip shows now; ms = how long it took to change after the call (-1: it did not). */
   private String snapshot(final long ms, final String dir)
   {
      final CursorClip cc = (CursorClip) clip;
      int n;
      synchronized (lock) { n = notes.size(); }
      return "{" + (dir != null ? "\"dir\":\"" + dir + "\",\"changedMs\":" + ms + "," : "")
         + "\"exists\":" + clip.exists().get() + ",\"track\":" + ScoreViewExtension.jsonStr(clipTrack.name().get())
         + ",\"playStart\":" + transport.playStartPosition().get() + ",\"length\":" + clip.getPlayStop().get()
         + ",\"notes\":" + n + ",\"hasNext\":" + cc.hasNext().get() + ",\"hasPrevious\":" + cc.hasPrevious().get()
         + ",\"fp\":" + ScoreViewExtension.jsonStr(fingerprint()) + "}";
   }

   private String key()
   {
      return clip.exists().get() + "|" + clipTrack.name().get() + "|" + transport.playStartPosition().get() + "|" + fingerprint();
   }

   private String fingerprint()
   {
      final StringBuilder fp = new StringBuilder();
      synchronized (lock)
      {
         int i = 0;
         for (final NoteStep s : notes.values()) { if (i++ >= 8) break; fp.append(s.x()).append(':').append(s.y()).append(' '); }
         fp.append('#').append(notes.size());
      }
      return fp + "|" + clip.getPlayStop().get();
   }
}
