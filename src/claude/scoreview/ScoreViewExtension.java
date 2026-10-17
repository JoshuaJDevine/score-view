package claude.scoreview;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;

import com.bitwig.extension.controller.ControllerExtension;
import com.bitwig.extension.controller.api.Action;
import com.bitwig.extension.controller.api.Application;
import com.bitwig.extension.controller.api.Clip;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.CueMarker;
import com.bitwig.extension.controller.api.CueMarkerBank;
import com.bitwig.extension.controller.api.CursorClip;
import com.bitwig.extension.controller.api.CursorTrack;
import com.bitwig.extension.controller.api.NoteStep;
import com.bitwig.extension.controller.api.PlayingNote;
import com.bitwig.extension.controller.api.SettableBooleanValue;
import com.bitwig.extension.controller.api.SettableEnumValue;
import com.bitwig.extension.controller.api.SettableRangedValue;
import com.bitwig.extension.controller.api.SettableStringValue;
import com.bitwig.extension.controller.api.Setting;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.TrackBank;
import com.bitwig.extension.controller.api.Transport;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

/**
 * Mirrors the notes of the selected Bitwig clip to a local web page (http://localhost:PORT)
 * that renders them as notation, and applies edits sent back from that page.
 */
public class ScoreViewExtension extends ControllerExtension
{
   static final int STEPS_PER_BEAT = 24; // 32nd notes and 16th/8th triplets
   static final int GRID_WIDTH = 16384; // ~680 beats
   static final int GRID_HEIGHT = 128;
   static final int MAX_TRACKS = 128;
   static final int MAX_MARKERS = 128;
   static final int MIDI_RING = 256;         // /api/midi keeps the last N note events
   static final long AUDITION_ECHO_MS = 600; // our own "audition" notes are not forwarded as input

   /** One clip being mirrored (arranger or launcher). */
   private final class Source
   {
      final String name;
      final Clip clip;
      final Track track;
      final Map<String, NoteStep> notes = new TreeMap<>();

      Source(final String name, final Clip clip)
      {
         this.name = name;
         this.clip = clip;
         this.track = clip.getTrack();
         clip.setStepSize(1.0 / STEPS_PER_BEAT);
         clip.scrollToKey(0);
         clip.scrollToStep(0);
         clip.exists().addValueObserver(v -> changed());
         clip.getPlayStop().addValueObserver(v -> changed());
         clip.getLoopLength().addValueObserver(v -> changed());
         clip.getLoopStart().addValueObserver(v -> changed());
         clip.isLoopEnabled().addValueObserver(v -> changed());
         clip.getPlayStart().addValueObserver(v -> changed());
         clip.color().markInterested();
         track.name().addValueObserver(v -> changed());
         clip.playingStep().markInterested();
         clip.addNoteStepObserver(step -> {
            synchronized (lock)
            {
               final String key = step.channel() + "_" + step.x() + "_" + step.y();
               if (step.state() == NoteStep.State.NoteOn) notes.put(key, step);
               else notes.remove(key);
            }
            changed();
         });
      }

      void changed()
      {
         bump();
      }
   }

   /** One entry of Bitwig's flat track list. */
   private final class TrackInfo
   {
      final Track track;
      final int index; // position in the flat bank; the "index" used by the solo/mute ops
      volatile boolean selected;

      TrackInfo(final Track track, final int index)
      {
         this.track = track;
         this.index = index;
         track.exists().addValueObserver(v -> bump());
         track.name().addValueObserver(v -> bump());
         track.isGroup().addValueObserver(v -> bump());
         track.isGroupExpanded().markInterested();
         track.solo().addValueObserver(v -> bump());
         track.mute().addValueObserver(v -> bump());
         track.trackType().markInterested();
         track.addIsSelectedInEditorObserver(v -> { selected = v; bump(); });
      }
   }

   /** Groups the crawler opened (by name: bank slots shift when a group opens), so it can close them again. */
   private final List<String> openedGroups = new ArrayList<>();

   private boolean expandCollapsedGroups()
   {
      openedGroups.clear();
      for (final TrackInfo t : tracks)
      {
         if (t.track.exists().get() && t.track.isGroup().get() && !t.track.isGroupExpanded().get())
         {
            openedGroups.add(t.track.name().get());
            t.track.isGroupExpanded().set(true);
         }
      }
      return !openedGroups.isEmpty();
   }

   private void restoreCollapsedGroups()
   {
      for (final TrackInfo t : tracks)
      {
         if (t.track.exists().get() && t.track.isGroup().get() && openedGroups.contains(t.track.name().get()))
            t.track.isGroupExpanded().set(false);
      }
      openedGroups.clear();
   }

   private void bump()
   {
      lastChangeMs = System.currentTimeMillis();
      // While crawling, every clip change would wake the page (and rebuild big JSON under the lock the note
      // observers need); the crawler only needs lastChangeMs. One real bump happens when the crawl finishes.
      if (crawler != null && crawler.running()) return;
      if (navigator != null && navigator.inSession()) return; // the page would see the other clips go by
      synchronized (lock)
      {
         version++;
         lock.notifyAll();
      }
   }

   private final Object lock = new Object();
   private final List<TrackInfo> tracks = new ArrayList<>();
   private final List<CueMarker> markers = new ArrayList<>();
   private String actionsJson = "[]";
   private volatile String lastAction = "";
   private volatile long lastChangeMs;
   private ArrangementCrawler crawler;
   private ClipNavigator navigator;
   private long lastOpMs;
   private NewScoreWizard wizard;
   /** Render dynamics: level curves on library controls (GET /api/curve, curve* ops). */
   private CurvePlayer curve;
   /** Dynamic marks and hairpins (JSON from features/dynamics.js), saved with the Bitwig project: GET/POST /api/marks. */
   private SettableStringValue marksSetting;
   private volatile String marksJson = "";
   private final java.util.concurrent.atomic.AtomicReference<String> pendingMarks = new java.util.concurrent.atomic.AtomicReference<>();
   static final int MARKS_MAX = 65535;
   private long version = 1;
   private final ConcurrentLinkedQueue<String[]> pendingEdits = new ConcurrentLinkedQueue<>();
   private ControllerHost host;
   private Transport transport;
   private Application application;
   private CursorTrack cursorTrack;
   private Source arranger, launcher;
   private volatile Source active;
   private HttpServer server;
   private int port;
   /** Preferences > Score View > Developer mode: allows the debug ops (DEV_OPS) and wizard presets from any folder. */
   private SettableBooleanValue developerMode;
   /** Preferences > Score View: where the play start marker ends up after a gotoStay (see ClipNavigator). */
   private SettableEnumValue stayPlayStart;
   private volatile boolean running;

   // ---- MIDI bridge: notes arriving at the cursor track, forwarded to the page via /api/midi
   /** One note event; {@code playing} = transport state when it happened (the page ignores those by default). */
   private record MidiEvent(long seq, long t, boolean on, int key, int vel, boolean playing) {}
   private final Object midiLock = new Object();
   private final ArrayDeque<MidiEvent> midiEvents = new ArrayDeque<>();
   private long midiSeq = 0;
   private final Map<Integer, Integer> sounding = new HashMap<>(); // control thread only: key -> velocity
   private final Map<Integer, Long> auditioned = new HashMap<>();  // control thread only: key -> echo deadline
   private final Set<Integer> swallowed = new HashSet<>();         // control thread only: echoed keys still held

   protected ScoreViewExtension(final ScoreViewExtensionDefinition definition, final ControllerHost host)
   {
      super(definition, host);
   }

   @Override
   public void init()
   {
      host = getHost();
      final SettableRangedValue portSetting = host.getPreferences().getNumberSetting("HTTP port", "Score View", 1024, 65535, 1, "", 8765);
      port = (int) Math.round(portSetting.getRaw());
      developerMode = host.getPreferences().getBooleanSetting("Developer mode (debug ops)", "Score View", false);
      developerMode.markInterested();
      stayPlayStart = host.getPreferences().getEnumSetting(ClipNavigator.STAY_PLAY_START_SETTING, "Score View",
         new String[] { ClipNavigator.PLAY_START_KEEP, ClipNavigator.PLAY_START_TARGET }, ClipNavigator.PLAY_START_KEEP);
      stayPlayStart.markInterested();

      transport = host.createTransport();
      transport.timeSignature().numerator().markInterested();
      transport.timeSignature().denominator().markInterested();
      transport.isPlaying().markInterested();
      transport.getPosition().markInterested();
      transport.tempo().value().markInterested();
      transport.isArrangerLoopEnabled().markInterested();
      transport.playStartPosition().addValueObserver(v -> bump());
      transport.arrangerLoopStart().addValueObserver(v -> bump());
      transport.arrangerLoopDuration().addValueObserver(v -> bump());
      transport.isMetronomeEnabled().markInterested();
      transport.playPosition().markInterested();          // CurvePlayer: the playhead while performing curves
      transport.automationWriteMode().markInterested();   // CurvePlayer saves and restores the user's write settings
      transport.isArrangerAutomationWriteEnabled().markInterested();
      markLauncherWrite();
      application = host.createApplication();
      application.projectName().markInterested();
      application.canUndo().markInterested();
      final StringBuilder actions = new StringBuilder("[");
      for (final Action a : application.getActions())
      {
         if (actions.length() > 1) actions.append(',');
         actions.append("{\"id\":").append(jsonStr(a.getId()))
            .append(",\"name\":").append(jsonStr(a.getName()))
            .append(",\"category\":").append(jsonStr(a.getCategory() == null ? null : a.getCategory().getName()))
            .append('}');
      }
      actionsJson = actions.append(']').toString();

      cursorTrack = host.createCursorTrack("SCOREVIEW_TRACK", "Score View", 0, 0, true);
      cursorTrack.name().markInterested();
      cursorTrack.isMonitoring().markInterested();
      // Notes sounding on the selected track: keyboard input (when the track monitors it) and clip playback.
      // Each callback carries the whole set; diffing it gives the note-on/off events of /api/midi.
      cursorTrack.playingNotes().addValueObserver(this::playingNotesChanged);
      arranger = new Source("arranger", host.createArrangerCursorClip(GRID_WIDTH, GRID_HEIGHT));
      launcher = new Source("launcher", cursorTrack.createLauncherCursorClip("SCOREVIEW_LAUNCHER", "Score View", GRID_WIDTH, GRID_HEIGHT));
      active = arranger;

      final TrackBank bank = host.createTrackBank(MAX_TRACKS, 0, 0, true);
      for (int t = 0; t < MAX_TRACKS; t++) tracks.add(new TrackInfo(bank.getItemAt(t), t));
      crawler = new ArrangementCrawler(host, application, transport, arranger.clip, arranger.track, arranger.notes, lock,
         () -> lastChangeMs, () -> (int) tracks.stream().filter(t -> t.track.exists().get()).count(), this::bump, STEPS_PER_BEAT,
         this::expandCollapsedGroups, this::restoreCollapsedGroups, () -> {
            final StringBuilder sb = new StringBuilder("[");
            for (final TrackInfo t : tracks)
            {
               if (!t.track.exists().get()) continue;
               if (sb.length() > 1) sb.append(',');
               sb.append("{\"name\":").append(jsonStr(t.track.name().get())).append(",\"group\":").append(t.track.isGroup().get()).append('}');
            }
            return sb.append(']').toString();
         });

      navigator = new ClipNavigator(host, application, transport, arranger.clip, arranger.track, () -> lastChangeMs,
         () -> (int) tracks.stream().filter(t -> t.track.exists().get()).count(),
         this::expandCollapsedGroups, this::restoreCollapsedGroups, this::bump, () -> active == arranger, crawler::running);
      wizard = new NewScoreWizard(host, application, transport, this::bump); // New Score wizard (#14): GET/POST /api/wizard
      wizard.setDeveloperMode(developerMode::get);
      navigator.setStayPlayStartAtTarget(() -> ClipNavigator.PLAY_START_TARGET.equals(stayPlayStart.get()));

      // Render dynamics: every library control must exist as a Parameter from init() on (CurvePlayer.BitwigRig).
      final Map<String, CurvePlayer.Profile> profiles = loadProfiles();
      curve = new CurvePlayer(transport, new CurvePlayer.BitwigRig(host, tracks.stream().map(t -> t.track).toList(), profiles),
         profiles, host::scheduleTask, host::println, () -> crawler.running() || navigator.inSession());
      marksSetting = host.getDocumentState().getStringSetting("Dynamics marks", "Score View", MARKS_MAX, "");
      if (marksSetting instanceof Setting s) s.hide(); // page data, not a control for the user
      marksSetting.addValueObserver(v -> { marksJson = v == null ? "" : v; });

      final CueMarkerBank cueBank = host.createArranger().createCueMarkerBank(MAX_MARKERS);
      for (int m = 0; m < MAX_MARKERS; m++)
      {
         final CueMarker marker = cueBank.getItemAt(m);
         marker.exists().addValueObserver(v -> bump());
         marker.name().addValueObserver(v -> bump());
         marker.position().addValueObserver(v -> bump());
         markers.add(marker);
      }

      running = true;
      host.scheduleTask(this::drainEdits, 20);
      final String failure = startServer();
      host.showPopupNotification(failure != null ? failure : "Score View: http://localhost:" + port);
   }

   /** Where the port is set (Bitwig shows extension preferences under Settings > Controllers). */
   static final String PORT_SETTING_PATH = "Settings > Controllers > Score View > HTTP port";

   /** The popup shown when the HTTP server cannot start (pure, for test/java/ProtocolCheck). */
   static String serverFailureMessage(final int port, final IOException e)
   {
      if (e instanceof java.net.BindException)
         return "Score View: port " + port + " is busy (another program or a second Score View is using it). "
            + "Choose another port in " + PORT_SETTING_PATH + ", then switch Score View off and on.";
      return "Score View: could not start its web server on port " + port + " (" + e.getMessage() + "). "
         + "Try another port in " + PORT_SETTING_PATH + ".";
   }

   @Override
   public void exit()
   {
      running = false;
      if (curve != null) curve.exit(); // never leave the user's automation write settings changed
      if (server != null) server.stop(0);
      synchronized (lock) { lock.notifyAll(); }
      synchronized (midiLock) { midiLock.notifyAll(); }
   }

   @Override
   public void flush()
   {
   }

   // ---------------------------------------------------------------- edits (control thread)

   private void drainEdits()
   {
      if (!running) return;
      final String marks = pendingMarks.getAndSet(null); // POST /api/marks: settings change on the control thread
      if (marks != null) marksSetting.set(marks);
      String[] op;
      // While a goto selects another clip the queue waits, so the following ops land in that clip.
      while (!navigator.running() && (op = pendingEdits.poll()) != null)
      {
         lastOpMs = System.currentTimeMillis();
         if (!navigator.accept(op)) continue;
         try { applyEdit(op); }
         catch (final Exception e) { host.errorln("Score View edit failed: " + String.join(" ", op) + " -> " + e); }
      }
      synchronized (pendingEdits) // a POST's ops are enqueued as one block: "empty" means its batch is complete
      {
         if (pendingEdits.isEmpty()) navigator.queueEmpty();
         // A session left open (page closed mid-batch, or a batch without gotoHome) returns to the original clip.
         if (navigator.inSession() && !navigator.running() && pendingEdits.isEmpty()
            && System.currentTimeMillis() - lastOpMs > ClipNavigator.AUTO_HOME_MS) navigator.gotoHome(new String[] { "gotoHome" });
      }
      host.scheduleTask(this::drainEdits, 20);
   }

   /**
    * Debug/research ops the shipped page never sends: "act" runs ANY Bitwig action by id (save, quit, delete,
    * export...), the others reorder or select tracks and step the arranger cursor. Only the live research scripts
    * (test/crawl-probe.mjs, test/crawl-lanes.mjs) use them, so they run only with Preferences > Score View >
    * Developer mode on (default off). The crawler and clip navigator invoke their actions inside the extension.
    */
   static final Set<String> DEV_OPS = EditOps.DEV; // the op table: EditOps.java

   private void applyEdit(final String[] op)
   {
      final Clip clip = active.clip;
      final String problem = EditOps.problem(op);
      if (problem != null)
      {
         lastAction = String.join(" ", op) + " (refused: " + problem + ")";
         host.errorln("Score View: " + problem);
         return;
      }
      if (DEV_OPS.contains(op[0]) && !developerMode.get())
      {
         lastAction = op[0] + " (refused: Developer mode is off)";
         host.errorln("Score View: op " + op[0] + " needs Developer mode (Preferences > Score View)");
         return;
      }
      switch (op[0])
      {
         case "source" -> { active = "launcher".equals(op[1]) ? launcher : arranger; bump(); }
         case "undo" -> application.undo();
         case "redo" -> application.redoAction().invoke();
         case "move" -> clip.moveStep(i(op[1]), i(op[2]), i(op[3]), i(op[4]), i(op[5]));
         case "del" -> clip.clearStep(i(op[1]), i(op[2]), i(op[3]));
         case "dur" -> clip.getStep(i(op[1]), i(op[2]), i(op[3])).setDuration(Double.parseDouble(op[4]));
         case "vel" -> clip.getStep(i(op[1]), i(op[2]), i(op[3])).setVelocity(Double.parseDouble(op[4]));
         case "add" -> clip.setStep(i(op[1]), i(op[2]), i(op[3]), i(op[4]), Double.parseDouble(op[5]));
         case "select" -> clip.selectStepContents(i(op[1]), i(op[2]), i(op[3]), "1".equals(op[4]));
         case "audition" ->
         {
            final int key = i(op[1]);
            if (key < 0 || key > 127) return;
            auditioned.put(key, System.currentTimeMillis() + AUDITION_ECHO_MS);
            active.track.startNote(key, 90);
            host.scheduleTask(() -> active.track.stopNote(key, 0), 250);
         }
         case "play" -> transport.play();
         case "stop" -> transport.stop();
         case "toggle" -> transport.togglePlay();
         case "position" -> transport.setPosition(Math.max(0, d(op[1])));
         case "playFrom" ->
         {
            final double beat = Math.max(0, d(op[1]));
            transport.playStartPosition().set(beat);
            transport.setPosition(beat);
            if (!transport.isPlaying().get()) transport.play();
         }
         case "loop" ->
         {
            transport.arrangerLoopStart().set(Math.max(0, d(op[1])));
            transport.arrangerLoopDuration().set(Math.max(1.0 / STEPS_PER_BEAT, d(op[2])));
            transport.isArrangerLoopEnabled().set(true);
         }
         case "loopOff" -> transport.isArrangerLoopEnabled().set(false);
         case "solo" -> trackAt(op[1]).solo().set("1".equals(op[2]));
         case "mute" -> trackAt(op[1]).mute().set("1".equals(op[2]));
         case "metronome" -> transport.isMetronomeEnabled().set("1".equals(op[1]));
         // Crawler research (docs/research.md section C): invoke a Bitwig action by id, or step the arranger cursor.
         // Debug/wizard research: select a track of the flat bank by index (as listed in /api/notes tracks[].index).
         case "selectTrack" -> { final int ti = i(op[1]); if (ti >= 0 && ti < tracks.size()) tracks.get(ti).track.selectInEditor(); }
         case "moveTrackAfter" -> // debug: moveTrackAfter <srcIndex> <dstIndex> (flat bank indices)
         {
            final int src = i(op[1]), dst = i(op[2]);
            tracks.get(dst).track.afterTrackInsertionPoint().moveTracks(tracks.get(src).track);
         }
         case "moveTrackBefore" -> // debug: moveTrackBefore <srcIndex> <dstIndex>
         {
            final int src = i(op[1]), dst = i(op[2]);
            tracks.get(dst).track.beforeTrackInsertionPoint().moveTracks(tracks.get(src).track);
         }
         case "crawl" -> { if (!navigator.inSession()) crawler.start(op.length > 1 && "exact".equals(op[1])); }
         // Clip navigation (ClipNavigator): select another arranger clip so the following ops edit it.
         case "goto", "gotoStay" -> navigator.gotoClip(op);
         case "gotoHome" -> navigator.gotoHome(op);
         case "crawlCancel" -> crawler.cancel();
         case "wizardCancel" -> wizard.cancel();
         // Render dynamics (CurvePlayer)
         case "curveClear", "curveSet", "curvePreview", "curveRender", "curveStop" -> curve.apply(op);
         case "act" ->
         {
            final String id = String.join(" ", java.util.Arrays.copyOfRange(op, 1, op.length));
            final Action a = application.getAction(id);
            lastAction = id + (a == null ? " (not found)" : "");
            if (a != null) a.invoke();
            bump();
         }
         case "clipNext", "clipPrev" ->
         {
            final boolean next = "clipNext".equals(op[0]);
            if (arranger.clip instanceof CursorClip cc) { if (next) cc.selectNext(); else cc.selectPrevious(); lastAction = op[0]; }
            else lastAction = op[0] + " (arranger clip is not a CursorClip)";
            bump();
         }
         default -> host.errorln("Score View: op " + op[0] + " is in EditOps but has no case in applyEdit");
      }
   }

   // ---------------------------------------------------------------- MIDI bridge (control thread)

   private void playingNotesChanged(final PlayingNote[] now)
   {
      final long t = System.currentTimeMillis();
      final boolean playing = transport.isPlaying().get();
      final Map<Integer, Integer> next = new HashMap<>();
      if (now != null) for (final PlayingNote n : now) next.put(n.pitch(), n.velocity());
      for (final Integer key : new ArrayList<>(sounding.keySet()))
      {
         if (next.containsKey(key)) continue;
         sounding.remove(key);
         if (!swallowed.remove(key)) addMidiEvent(t, false, key, 0, playing);
      }
      for (final Map.Entry<Integer, Integer> e : next.entrySet())
      {
         final int key = e.getKey();
         if (sounding.containsKey(key)) continue;
         sounding.put(key, e.getValue());
         final Long echo = auditioned.remove(key);
         if (echo != null && echo >= t) { swallowed.add(key); continue; } // our own audition, not the player
         addMidiEvent(t, true, key, e.getValue(), playing);
      }
   }

   private void addMidiEvent(final long t, final boolean on, final int key, final int vel, final boolean playing)
   {
      synchronized (midiLock)
      {
         midiEvents.addLast(new MidiEvent(++midiSeq, t, on, key, Math.max(0, Math.min(127, vel)), playing));
         while (midiEvents.size() > MIDI_RING) midiEvents.removeFirst();
         midiLock.notifyAll();
      }
   }

   private Track trackAt(final String index)
   {
      return tracks.get(i(index)).track;
   }

   private static double d(final String s)
   {
      return Double.parseDouble(s);
   }

   private static int i(final String s)
   {
      return Integer.parseInt(s);
   }

   // ---------------------------------------------------------------- HTTP (server threads)

   /** Starts the HTTP server; returns null, or the message to show when it could not (e.g. the port is busy). */
   private String startServer()
   {
      try
      {
         server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
         server.setExecutor(Executors.newFixedThreadPool(8, r -> {
            final Thread t = new Thread(r, "ScoreView-http");
            t.setDaemon(true);
            return t;
         }));
         // Every context goes through HttpGuard: Host allow-list; anything but GET/HEAD needs X-ScoreView: 1 and (if
         // sent) our own Origin. /api/edit is POST only; /api/wizard reads with GET and changes state only by POST.
         context("/api/notes", false, this::handleNotes);
         context("/api/play", false, this::handlePlay);
         context("/api/transport", false, this::handleTransport);
         context("/api/crawl", false, ex -> send(ex, 200, "application/json", crawler.statusJson().getBytes(StandardCharsets.UTF_8)));
         context("/api/nav", false, ex -> send(ex, 200, "application/json", navigator.statusJson().getBytes(StandardCharsets.UTF_8)));
         context("/api/midi", false, this::handleMidi);
         context("/api/wizard", false, ex -> wizard.handle(ex));
         context("/api/curve", false, ex -> send(ex, 200, "application/json", curve.statusJson().getBytes(StandardCharsets.UTF_8)));
         context("/api/marks", false, this::handleMarks);
         context("/api/edit", true, this::handleEdit);
         context("/api/actions", false, ex -> send(ex, 200, "application/json", actionsJson.getBytes(StandardCharsets.UTF_8)));
         context("/", false, this::handleStatic);
         server.start();
         host.println("Score View serving on http://localhost:" + port);
         return null;
      }
      catch (final IOException e)
      {
         host.errorln("Score View: could not start HTTP server on port " + port + ": " + e);
         if (server != null) { server.stop(0); server = null; }
         return serverFailureMessage(port, e);
      }
   }

   private void context(final String path, final boolean postOnly, final HttpHandler handler)
   {
      server.createContext(path, HttpGuard.wrap(port, postOnly, handler));
   }

   /** Long-poll: returns the note snapshot once its version differs from ?v=. */
   private void handleNotes(final HttpExchange ex) throws IOException
   {
      final String q = ex.getRequestURI().getQuery();
      long since = -1;
      if (q != null && q.startsWith("v=")) since = Long.parseLong(q.substring(2));
      String json;
      synchronized (lock)
      {
         final long deadline = System.currentTimeMillis() + 15000;
         while (running && versionKey() == since && System.currentTimeMillis() < deadline)
         {
            try { lock.wait(Math.max(1, deadline - System.currentTimeMillis())); }
            catch (final InterruptedException e) { break; }
         }
         json = notesJson();
      }
      send(ex, 200, "application/json", json.getBytes(StandardCharsets.UTF_8));
   }

   private long versionKey()
   {
      return version;
   }

   private String notesJson()
   {
      final Source s = active;
      final StringBuilder sb = new StringBuilder(4096);
      sb.append("{\"v\":").append(versionKey());
      sb.append(",\"source\":\"").append(s.name).append('"');
      sb.append(",\"exists\":").append(s.clip.exists().get());
      sb.append(",\"track\":").append(jsonStr(s.track.name().get()));
      sb.append(",\"project\":").append(jsonStr(application.projectName().get()));
      sb.append(",\"stepsPerBeat\":").append(STEPS_PER_BEAT);
      sb.append(",\"length\":").append(s.clip.getPlayStop().get());
      sb.append(",\"playStart\":").append(s.clip.getPlayStart().get());
      sb.append(",\"loop\":").append(s.clip.isLoopEnabled().get());
      sb.append(",\"loopStart\":").append(s.clip.getLoopStart().get());
      sb.append(",\"loopLength\":").append(s.clip.getLoopLength().get());
      sb.append(",\"tracks\":[");
      boolean firstTrack = true;
      for (final TrackInfo t : tracks)
      {
         if (!t.track.exists().get()) continue;
         if (!firstTrack) sb.append(',');
         firstTrack = false;
         sb.append("{\"name\":").append(jsonStr(t.track.name().get()))
            .append(",\"index\":").append(t.index)
            .append(",\"group\":").append(t.track.isGroup().get())
            .append(",\"type\":").append(jsonStr(t.track.trackType().get()))
            .append(",\"sel\":").append(t.selected)
            .append(",\"solo\":").append(t.track.solo().get())
            .append(",\"mute\":").append(t.track.mute().get()).append('}');
      }
      sb.append(']');
      sb.append(",\"markers\":[");
      boolean firstMarker = true;
      for (final CueMarker m : markers)
      {
         if (!m.exists().get()) continue;
         if (!firstMarker) sb.append(',');
         firstMarker = false;
         sb.append("{\"name\":").append(jsonStr(m.name().get()))
            .append(",\"beat\":").append(m.position().get()).append('}');
      }
      sb.append(']');
      sb.append(",\"num\":").append(transport.timeSignature().numerator().get());
      sb.append(",\"den\":").append(transport.timeSignature().denominator().get());
      sb.append(",\"notes\":[");
      boolean first = true;
      for (final NoteStep n : s.notes.values())
      {
         if (!first) sb.append(',');
         first = false;
         sb.append("{\"ch\":").append(n.channel())
            .append(",\"x\":").append(n.x())
            .append(",\"y\":").append(n.y())
            .append(",\"d\":").append(n.duration())
            .append(",\"vel\":").append(Math.round(n.velocity() * 127))
            .append(",\"sel\":").append(n.isIsSelected())
            .append('}');
      }
      sb.append("]}");
      return sb.toString();
   }

   /**
    * Long-poll for note events: {@code ?since=N} returns the events with seq > N, waiting up to 15 s for one.
    * Without {@code since} (or since=-1) it returns at once with the current seq and no events.
    */
   private void handleMidi(final HttpExchange ex) throws IOException
   {
      long since = -1;
      final String q = ex.getRequestURI().getQuery();
      if (q != null) for (final String part : q.split("&"))
      {
         if (!part.startsWith("since=")) continue;
         try { since = Long.parseLong(part.substring(6)); }
         catch (final NumberFormatException e) { since = -1; }
      }
      final StringBuilder sb = new StringBuilder(256);
      synchronized (midiLock)
      {
         if (since > midiSeq) since = -1; // the extension restarted: resync
         final long deadline = System.currentTimeMillis() + 15000;
         while (running && since >= 0 && midiSeq <= since && System.currentTimeMillis() < deadline)
         {
            try { midiLock.wait(Math.max(1, deadline - System.currentTimeMillis())); }
            catch (final InterruptedException e) { break; }
         }
         sb.append("{\"seq\":").append(midiSeq)
            .append(",\"track\":").append(jsonStr(cursorTrack.name().get()))
            .append(",\"monitoring\":").append(cursorTrack.isMonitoring().get())
            .append(",\"playing\":").append(transport.isPlaying().get())
            .append(",\"events\":[");
         boolean first = true;
         if (since >= 0) for (final MidiEvent e : midiEvents)
         {
            if (e.seq() <= since) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"seq\":").append(e.seq()).append(",\"t\":").append(e.t())
               .append(",\"type\":\"").append(e.on() ? "on" : "off").append('"')
               .append(",\"key\":").append(e.key()).append(",\"vel\":").append(e.vel())
               .append(",\"playing\":").append(e.playing()).append('}');
         }
         sb.append("]}");
      }
      send(ex, 200, "application/json", sb.toString().getBytes(StandardCharsets.UTF_8));
   }

   /** Crawler research: loop / play-start / undo state and a fingerprint of the arranger cursor clip. */
   private void handleTransport(final HttpExchange ex) throws IOException
   {
      final StringBuilder fp = new StringBuilder();
      int n = 0;
      synchronized (lock)
      {
         for (final NoteStep st : arranger.notes.values())
         {
            if (n++ < 12) fp.append(st.x()).append(':').append(st.y()).append(' ');
         }
      }
      final String json = "{\"project\":" + jsonStr(application.projectName().get())
         + ",\"canUndo\":" + application.canUndo().get()
         + ",\"loopOn\":" + transport.isArrangerLoopEnabled().get()
         + ",\"loopStart\":" + transport.arrangerLoopStart().get()
         + ",\"loopLength\":" + transport.arrangerLoopDuration().get()
         + ",\"playStart\":" + transport.playStartPosition().get()
         + ",\"pos\":" + transport.getPosition().get()
         + ",\"playing\":" + transport.isPlaying().get()
         + ",\"lastAction\":" + jsonStr(lastAction)
         + ",\"clip\":{\"exists\":" + arranger.clip.exists().get()
         + ",\"track\":" + jsonStr(arranger.track.name().get())
         + ",\"length\":" + arranger.clip.getPlayStop().get()
         + ",\"notes\":" + n
         + ",\"fp\":" + jsonStr(fp.toString().trim()) + "}}";
      send(ex, 200, "application/json", json.getBytes(StandardCharsets.UTF_8));
   }

   private void handlePlay(final HttpExchange ex) throws IOException
   {
      final String json = "{\"playing\":" + transport.isPlaying().get()
         + ",\"step\":" + active.clip.playingStep().get()
         + ",\"pos\":" + transport.getPosition().get()
         + ",\"tempo\":" + transport.tempo().getRaw()
         + ",\"loop\":{\"on\":" + transport.isArrangerLoopEnabled().get()
         + ",\"start\":" + transport.arrangerLoopStart().get()
         + ",\"length\":" + transport.arrangerLoopDuration().get() + "}"
         + ",\"metronome\":" + transport.isMetronomeEnabled().get() + "}";
      send(ex, 200, "application/json", json.getBytes(StandardCharsets.UTF_8));
   }

   /** Body: one op per line, space separated, e.g. "move 0 16 60 0 1". */
   private void handleEdit(final HttpExchange ex) throws IOException
   {
      try (InputStream in = ex.getRequestBody())
      {
         final String body = new String(in.readAllBytes(), StandardCharsets.UTF_8);
         final List<String[]> ops = new ArrayList<>();
         for (final String line : body.split("\n"))
         {
            final String t = line.trim();
            if (t.equals("navCancel")) navigator.requestCancel(); // must not wait behind the queue it cancels
            else if (!t.isEmpty()) ops.add(t.split("\\s+"));
         }
         synchronized (pendingEdits) { pendingEdits.addAll(ops); }
      }
      send(ex, 200, "text/plain", "ok".getBytes(StandardCharsets.UTF_8));
   }

   /**
    * Dynamics marks of this project (features/dynamics.js): GET returns the stored JSON ({} when there is none), POST
    * replaces it (a JSON object, at most MARKS_MAX characters; HttpGuard requires X-ScoreView). Stored in the project's
    * DocumentState, so it is saved with the Bitwig project and follows project switches.
    */
   private void handleMarks(final HttpExchange ex) throws IOException
   {
      if ("POST".equals(ex.getRequestMethod()))
      {
         final String body;
         try (InputStream in = ex.getRequestBody()) { body = new String(in.readNBytes(MARKS_MAX * 4 + 1), StandardCharsets.UTF_8).trim(); }
         if (body.length() > MARKS_MAX) { send(ex, 413, "text/plain", ("too many marks (" + body.length() + " > " + MARKS_MAX + " characters)").getBytes(StandardCharsets.UTF_8)); return; }
         if (!body.startsWith("{") || !body.endsWith("}")) { send(ex, 400, "text/plain", "marks must be a JSON object".getBytes(StandardCharsets.UTF_8)); return; }
         marksJson = body;
         pendingMarks.set(body);
         send(ex, 200, "text/plain", "ok".getBytes(StandardCharsets.UTF_8));
         return;
      }
      final String m = marksJson;
      send(ex, 200, "application/json", (m == null || m.isBlank() ? "{}" : m).getBytes(StandardCharsets.UTF_8));
   }

   @SuppressWarnings("deprecation") // still the launcher write switch in API 25; CurvePlayer restores it after a Render
   private void markLauncherWrite()
   {
      transport.isClipLauncherAutomationWriteEnabled().markInterested();
   }

   /** The library profile table (web/features/library-profiles.json in the jar), shared with the page. */
   private Map<String, CurvePlayer.Profile> loadProfiles()
   {
      try (InputStream in = ScoreViewExtension.class.getResourceAsStream("/web/features/library-profiles.json"))
      {
         if (in == null) { host.errorln("Score View: library-profiles.json missing from the extension"); return new java.util.LinkedHashMap<>(); }
         return CurvePlayer.parseProfiles(new String(in.readAllBytes(), StandardCharsets.UTF_8));
      }
      catch (final Exception e)
      {
         host.errorln("Score View: library-profiles.json: " + e);
         return new java.util.LinkedHashMap<>();
      }
   }

   private void handleStatic(final HttpExchange ex) throws IOException
   {
      String path = ex.getRequestURI().getPath();
      if (path.equals("/")) path = "/index.html";
      if (path.contains("..")) { send(ex, 404, "text/plain", new byte[0]); return; }
      try (InputStream in = ScoreViewExtension.class.getResourceAsStream("/web" + path))
      {
         if (in == null) { send(ex, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8)); return; }
         send(ex, 200, contentType(path), in.readAllBytes());
      }
   }

   private static String contentType(final String path)
   {
      if (path.endsWith(".html")) return "text/html; charset=utf-8";
      if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
      if (path.endsWith(".css")) return "text/css; charset=utf-8";
      if (path.endsWith(".svg")) return "image/svg+xml";
      if (path.endsWith(".json")) return "application/json; charset=utf-8";
      return "application/octet-stream";
   }

   private static void send(final HttpExchange ex, final int status, final String type, final byte[] body) throws IOException
   {
      ex.getResponseHeaders().set("Content-Type", type);
      ex.getResponseHeaders().set("Cache-Control", "no-store");
      ex.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
      try (OutputStream os = ex.getResponseBody()) { os.write(body); }
   }

   static String jsonStr(final String s)
   {
      if (s == null) return "null";
      final StringBuilder sb = new StringBuilder("\"");
      for (final char c : s.toCharArray())
      {
         if (c == '"' || c == '\\') sb.append('\\').append(c);
         else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
         else sb.append(c);
      }
      return sb.append('"').toString();
   }
}
