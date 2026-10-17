package claude.scoreview;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.CursorRemoteControlsPage;
import com.bitwig.extension.controller.api.CursorTrack;
import com.bitwig.extension.controller.api.Device;
import com.bitwig.extension.controller.api.DeviceBank;
import com.bitwig.extension.controller.api.Parameter;
import com.bitwig.extension.controller.api.SpecificPluginDevice;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.Transport;

/**
 * Render dynamics (docs/features/dynamics.md): plays level curves on library controls during playback. The page
 * (web/features/dynamics.js) turns dynamic marks and hairpins into one curve per control and sends them as edit ops:
 * <pre>
 *   curveClear                                         forget all curves
 *   curveSet &lt;id&gt; &lt;track(URL-encoded)&gt; &lt;profile&gt; &lt;target&gt; &lt;beat:value,...&gt;   arranger beats, values 0..1
 *   curvePreview &lt;fromBeat&gt; &lt;toBeat&gt;             play the range and move the controls (nothing is recorded)
 *   curveRender &lt;fromBeat&gt; &lt;toBeat&gt;              the same with arranger automation write on, mode "touch":
 *                                                      touch(true) at fromBeat, set() every tick, touch(false) at toBeat
 *   curveStop                                          stop now (touch off, transport off, write settings restored)
 * </pre>
 * The working mechanism comes from tools/probe (docs/library-profiles.md "Probe results"): Parameter.touch(true) +
 * Parameter.set() during playback, with transport.isArrangerAutomationWriteEnabled() true and automationWriteMode
 * "touch", on parameters made by createSpecificVst3Device(pluginId).createParameter(paramId) — those can only be made
 * in init(), so {@link BitwigRig} builds a pool of cursor tracks (not following the selection) with device banks and
 * a parameter for every target of the profile table (web/features/library-profiles.json, read from the jar) up front,
 * and points a pool slot at a track (selectChannel) before playing. The user's write settings, play start and
 * transport are restored on finish, stop, cancel and exit. Status: GET /api/curve ({@link #statusJson()}).
 *
 * The engine talks to Bitwig through {@link Rig} and {@link Transport} only, so test/java/CurveCheck runs it against
 * a fake.
 */
@SuppressWarnings("deprecation") // Transport.isClipLauncherAutomationWriteEnabled: the probe used it; restoring it matters
final class CurvePlayer
{
   static final int POOL = 8;          // tracks per Render
   static final int DEVICES = 4;       // devices searched per track for the library's plug-in
   static final int TICK_MS = 10;      // ~42 values/s reached Bitwig in the probe
   static final double LOOKAHEAD = 0.02; // beats: the value for slightly ahead of the playhead
   static final double PREROLL = 1.0;  // beats of run-up before the range, so the transport is moving at fromBeat
   static final double MIN_DELTA = 0.002; // smaller changes are not sent (fewer recorded points)
   static final long PREPARE_MS = 3000; // pool slots must find their devices within this

   // ------------------------------------------------------------------ profile table (library-profiles.json)

   /** One control a level curve can drive: kind vst3 (plugin + param), remote (index) or cc (cc). */
   record Target(String profile, String id, String label, String kind, String plugin, int param, int index, int cc)
   {
      String describe()
      {
         return switch (kind)
         {
            case "vst3" -> label + " (VST3 param " + param + ")";
            case "remote" -> label + " (remote control " + (index + 1) + ")";
            default -> label + " (MIDI CC " + cc + ")";
         };
      }
   }

   /** A profile: id, display name, the names it matches (device / plug-in names) and its targets. */
   record Profile(String id, String name, List<String> names, List<Target> targets) {}

   /** Parses library-profiles.json into profiles by id (unknown kinds are skipped). */
   @SuppressWarnings("unchecked")
   static Map<String, Profile> parseProfiles(final String json)
   {
      final Map<String, Profile> out = new LinkedHashMap<>();
      final Object root = Json.parse(json);
      if (!(root instanceof Map<?, ?> m) || !(m.get("profiles") instanceof List<?> list)) return out;
      for (final Object o : list)
      {
         if (!(o instanceof Map<?, ?> p)) continue;
         final String id = str(p.get("id"));
         if (id.isEmpty()) continue;
         final List<String> names = new ArrayList<>();
         if (p.get("match") instanceof Map<?, ?> match && match.get("names") instanceof List<?> ns) for (final Object n : ns) names.add(str(n));
         final List<Target> targets = new ArrayList<>();
         if (p.get("targets") instanceof List<?> ts) for (final Object t : ts)
         {
            if (!(t instanceof Map<?, ?> tm)) continue;
            final String kind = str(tm.get("kind"));
            if (!List.of("vst3", "remote", "cc").contains(kind)) continue;
            targets.add(new Target(id, str(tm.get("id")), str(tm.get("label")), kind, str(tm.get("plugin")).toUpperCase(Locale.ROOT),
               num(tm.get("param")), num(tm.get("index")), num(tm.get("cc"))));
         }
         out.put(id, new Profile(id, str(p.get("name")), names, targets));
      }
      return out;
   }

   private static String str(final Object o) { return o == null ? "" : String.valueOf(o); }
   private static int num(final Object o) { return o instanceof Number n ? n.intValue() : -1; }

   // ------------------------------------------------------------------ curves

   /** One curve: points in arranger beats (sorted), values 0..1. */
   record Curve(String id, String track, String profile, String target, double[] beats, double[] values)
   {
      /** Linear interpolation; holds the first/last value outside the points. */
      double valueAt(final double beat)
      {
         if (beats.length == 0) return 0;
         if (beat <= beats[0]) return values[0];
         for (int i = 1; i < beats.length; i++)
         {
            if (beat <= beats[i])
            {
               final double span = beats[i] - beats[i - 1];
               return span <= 0 ? values[i] : values[i - 1] + (values[i] - values[i - 1]) * (beat - beats[i - 1]) / span;
            }
         }
         return values[values.length - 1];
      }
   }

   /** "0:0.32,4.5:0.7" -> {beats, values}; throws IllegalArgumentException on a malformed list. */
   static double[][] parsePoints(final String text)
   {
      final String[] parts = text.split(",");
      final double[] b = new double[parts.length], v = new double[parts.length];
      for (int i = 0; i < parts.length; i++)
      {
         final int c = parts[i].indexOf(':');
         if (c <= 0) throw new IllegalArgumentException("point " + (i + 1) + " is not beat:value");
         b[i] = Double.parseDouble(parts[i].substring(0, c));
         v[i] = Math.max(0, Math.min(1, Double.parseDouble(parts[i].substring(c + 1))));
         if (!Double.isFinite(b[i]) || (i > 0 && b[i] < b[i - 1])) throw new IllegalArgumentException("beats must increase");
      }
      return new double[][] { b, v };
   }

   // ------------------------------------------------------------------ Bitwig, abstracted

   /** A control the engine moves (a Parameter, or MIDI CC sent to a track). */
   interface Control
   {
      boolean exists();
      void touch(boolean on);
      void set(double v);
      double value();
   }

   /** The pool of cursor tracks and their controls. */
   interface Rig
   {
      int slots();
      /** Points pool slot `slot` at the track named `track`; false when there is no such track. */
      boolean point(int slot, String track);
      /** The name of the track the slot points at now. */
      String slotTrack(int slot);
      /** The control for a target on the slot's track, or null while it is not (yet) found. */
      Control control(int slot, Target t);
      /** Device names on the slot's track (for messages). */
      List<String> slotDevices(int slot);
      /** Device names per track of the project, for library detection: {"track": ["Pocket Strings", ...]}. */
      String devicesJson();
   }

   interface Scheduler { void schedule(Runnable r, long ms); }

   // ------------------------------------------------------------------ engine

   enum State { IDLE, PREPARING, RUNNING, DONE, STOPPED, ERROR }

   private final Transport transport;
   private final Rig rig;
   private final Map<String, Profile> profiles;
   private final Scheduler sched;
   private final Consumer<String> log;
   private final BooleanSupplier busy; // crawler or clip navigator running
   /** Guarded by itself: set on the control thread, listed by GET /api/curve on the HTTP thread. */
   private final Map<String, Curve> curves = new LinkedHashMap<>();
   private java.util.function.LongSupplier clock = System::currentTimeMillis;

   private volatile State state = State.IDLE;
   private volatile String mode = "", message = "";
   private volatile double from, to, pos;
   private volatile long written;
   private volatile boolean restored = true;
   /** Counts curvePreview / curveRender requests (refused ones too), so the page can tell its run from the last one. */
   private volatile int runs;
   /** A curveSet that failed since the last curveClear: the next run is refused (it would play without that curve). */
   private String setError;
   private int runId;
   private long startMs;
   private boolean touched, startedTransport, savedWrite;
   /** The playhead has been seen at the run-up start (positions reported right after play() may be the old ones). */
   private boolean arrived;
   private double startBeat;
   private boolean savedArr, savedLnch;
   private String savedMode;
   private double savedPlayStart = -1;
   private final List<Binding> bindings = new ArrayList<>();

   /** A curve bound to its control on a pool slot. */
   private static final class Binding
   {
      final Curve curve;
      final Target target;
      final int slot;
      Control control;
      double last = Double.NaN;

      Binding(final Curve c, final Target t, final int slot) { this.curve = c; this.target = t; this.slot = slot; }
   }

   CurvePlayer(final Transport transport, final Rig rig, final Map<String, Profile> profiles, final Scheduler sched,
      final Consumer<String> log, final BooleanSupplier busy)
   {
      this.transport = transport;
      this.rig = rig;
      this.profiles = profiles;
      this.sched = sched;
      this.log = log;
      this.busy = busy;
   }

   /** Test hook (test/java/CurveCheck): a virtual clock in ms. */
   CurvePlayer clock(final java.util.function.LongSupplier c) { clock = c; return this; }

   State state() { return state; }
   boolean running() { return state == State.PREPARING || state == State.RUNNING; }

   /** Handles one curve op (control thread). */
   void apply(final String[] op)
   {
      switch (op[0])
      {
         case "curveClear" -> { if (!running()) { synchronized (curves) { curves.clear(); } setError = null; } }
         case "curveSet" -> set(op);
         case "curvePreview" -> start("preview", op);
         case "curveRender" -> start("render", op);
         case "curveStop" -> { if (running()) finish(State.STOPPED, "Stopped."); }
         default -> log.accept("CurvePlayer: unknown op " + op[0]);
      }
   }

   private void set(final String[] op)
   {
      if (running()) { error("Busy: stop the running " + mode + " first"); return; }
      try
      {
         final String track = java.net.URLDecoder.decode(op[2], java.nio.charset.StandardCharsets.UTF_8);
         final Profile p = profiles.get(op[3]);
         if (p == null) throw new IllegalArgumentException("unknown library profile " + op[3]);
         if (p.targets().stream().noneMatch(t -> t.id().equals(op[4]))) throw new IllegalArgumentException(p.name() + " has no control " + op[4]);
         final double[][] pts = parsePoints(op[5]);
         synchronized (curves) { curves.put(op[1], new Curve(op[1], track, op[3], op[4], pts[0], pts[1])); }
      }
      catch (final RuntimeException e)
      {
         setError = "curveSet " + op[1] + ": " + e.getMessage();
         error(setError);
      }
   }

   private void error(final String why)
   {
      state = State.ERROR;
      message = why;
      log.accept("Score View dynamics: " + why);
   }

   private void start(final String m, final String[] op)
   {
      runs++;
      if (running()) { message = "Already running: stop it first"; return; }
      final double a, b;
      try { a = Double.parseDouble(op[1]); b = Double.parseDouble(op[2]); }
      catch (final NumberFormatException e) { error(op[0] + " needs fromBeat toBeat"); return; }
      mode = m;
      from = Math.max(0, a);
      to = b;
      written = 0;
      pos = from;
      if (!(to > from)) { error("The range is empty (" + a + " to " + b + ")"); return; }
      if (transport.isPlaying().get()) { error("Stop playback first: " + m + " starts the transport itself."); return; }
      if (busy.getAsBoolean()) { error("Score View is busy (reading the arrangement or writing into clips): try again when it is done."); return; }
      if (setError != null) { error(setError); return; }
      if (curves.isEmpty()) { error("No curves: add dynamics first."); return; }
      final List<String> tracks = new ArrayList<>(new LinkedHashSet<>(curves.values().stream().map(Curve::track).toList()));
      if (tracks.size() > rig.slots()) { error("At most " + rig.slots() + " tracks at a time"); return; }
      bindings.clear();
      for (int i = 0; i < tracks.size(); i++)
      {
         if (!rig.point(i, tracks.get(i))) { error("No track named '" + tracks.get(i) + "' in Bitwig"); return; }
         for (final Curve c : curves.values())
         {
            if (!c.track().equals(tracks.get(i))) continue;
            final Target t = profiles.get(c.profile()).targets().stream().filter(x -> x.id().equals(c.target())).findFirst().orElseThrow();
            bindings.add(new Binding(c, t, i));
         }
      }
      state = State.PREPARING;
      message = "Finding the library controls…";
      restored = false;
      final int id = ++runId;
      startMs = clock.getAsLong();
      sched.schedule(() -> prepare(id), 100);
   }

   /** Waits until every pool slot is on its track and every control exists, then starts the transport. */
   private void prepare(final int id)
   {
      if (id != runId || state != State.PREPARING) return;
      final List<String> missing = new ArrayList<>();
      for (final Binding b : bindings)
      {
         final boolean onTrack = b.curve.track().equals(rig.slotTrack(b.slot));
         b.control = onTrack ? rig.control(b.slot, b.target) : null;
         if (b.control == null || !b.control.exists())
            missing.add(profiles.get(b.target.profile()).name() + " " + b.target.describe() + " on '" + b.curve.track() + "'"
               + (onTrack ? " (devices: " + String.join(", ", rig.slotDevices(b.slot)) + ")" : " (track not reached)"));
      }
      if (!missing.isEmpty())
      {
         if (clock.getAsLong() - startMs < PREPARE_MS) { sched.schedule(() -> prepare(id), 100); return; }
         finish(State.ERROR, "Not found: " + String.join("; ", missing) + ". Choose another library profile for that staff, or check the plug-in.");
         return;
      }
      if (transport.isPlaying().get()) { finish(State.ERROR, "Playback started meanwhile: stop it and try again."); return; }
      savedPlayStart = transport.playStartPosition().get();
      // Render: arranger write on, mode touch. Preview: both write switches off, or Bitwig would record the moves as
      // well (the probe saw plain set() recorded while write is on). restore() puts the user's settings back.
      savedMode = transport.automationWriteMode().get();
      savedArr = transport.isArrangerAutomationWriteEnabled().get();
      savedLnch = transport.isClipLauncherAutomationWriteEnabled().get();
      savedWrite = true;
      transport.isClipLauncherAutomationWriteEnabled().set(false);
      transport.isArrangerAutomationWriteEnabled().set("render".equals(mode));
      if ("render".equals(mode)) transport.automationWriteMode().set("touch");
      final double start = Math.max(0, from - PREROLL);
      startBeat = start;
      arrived = false;
      pos = start;
      transport.playStartPosition().set(start);
      transport.setPosition(start);
      transport.play();
      startedTransport = true;
      touched = false;
      state = State.RUNNING;
      startMs = clock.getAsLong();
      message = ("render".equals(mode) ? "Rendering" : "Previewing") + "…";
      sched.schedule(() -> tick(id), TICK_MS);
   }

   private void tick(final int id)
   {
      if (id != runId || state != State.RUNNING) return;
      final boolean playing = transport.isPlaying().get();
      final double p = transport.playPosition().get();
      if (!playing && clock.getAsLong() - startMs > 1500) { finish(State.STOPPED, "Playback was stopped in Bitwig: stopped."); return; }
      if (playing && !arrived)
      {
         // the first positions after play() can still be the old playhead: wait until it is at the run-up start
         if (p >= startBeat - 0.25 && p <= startBeat + PREROLL + 0.5) arrived = true;
         else if (clock.getAsLong() - startMs > 3000) { finish(State.ERROR, "The playhead did not move to beat " + fmt(startBeat) + ": try again."); return; }
         else { sched.schedule(() -> tick(id), TICK_MS); return; }
      }
      if (playing && p < pos - 0.5)
      {
         finish(State.ERROR, "The arranger loop jumped back at beat " + fmt(pos) + " before the end of the range: switch the loop off or render a range inside it.");
         return;
      }
      if (playing) pos = p;
      if (playing && p >= to - 1e-9)
      {
         sendAll(to);
         finish(State.DONE, ("render".equals(mode) ? "Rendered " : "Previewed ") + describeRange() + " · " + written + " values"
            + ("render".equals(mode) ? " recorded as arranger automation (Ctrl+Z in Bitwig undoes it)." : "."));
         return;
      }
      if (playing && p >= from - LOOKAHEAD)
      {
         if (!touched && "render".equals(mode))
         {
            for (final Binding b : bindings) if (!"cc".equals(b.target.kind())) b.control.touch(true);
            touched = true;
         }
         sendAll(Math.max(from, p + LOOKAHEAD));
         message = ("render".equals(mode) ? "Rendering " : "Previewing ") + describeRange() + " · beat " + fmt(p);
      }
      sched.schedule(() -> tick(id), TICK_MS);
   }

   private void sendAll(final double beat)
   {
      for (final Binding b : bindings)
      {
         final double v = b.curve.valueAt(beat);
         if (!Double.isNaN(b.last) && Math.abs(v - b.last) < MIN_DELTA) continue;
         b.control.set(v);
         b.last = v;
         written++;
      }
   }

   private String describeRange() { return "beats " + fmt(from) + "–" + fmt(to); }

   /** Ends a run: releases the controls, stops the transport we started, restores the user's settings. */
   private void finish(final State end, final String why)
   {
      runId++;
      if (touched) for (final Binding b : bindings) if (b.control != null && !"cc".equals(b.target.kind())) b.control.touch(false);
      touched = false;
      if (startedTransport) { transport.stop(); startedTransport = false; }
      restore();
      state = end;
      message = why;
      log.accept("Score View dynamics: " + why);
   }

   private void restore()
   {
      if (savedWrite)
      {
         transport.isArrangerAutomationWriteEnabled().set(savedArr);
         transport.isClipLauncherAutomationWriteEnabled().set(savedLnch);
         if (savedMode != null && !savedMode.isEmpty()) transport.automationWriteMode().set(savedMode);
         savedWrite = false;
      }
      if (savedPlayStart >= 0) { transport.playStartPosition().set(savedPlayStart); savedPlayStart = -1; }
      restored = true;
   }

   /** Extension exit: never leave the user's write settings changed. */
   void exit()
   {
      if (running()) finish(State.STOPPED, "Score View stopped.");
      else restore();
   }

   // ------------------------------------------------------------------ status

   String statusJson()
   {
      final StringBuilder sb = new StringBuilder(512);
      final double span = to - from;
      final double progress = state == State.DONE ? 1 : state == State.RUNNING && span > 0 ? Math.max(0, Math.min(1, (pos - from) / span)) : 0;
      sb.append("{\"state\":\"").append(state.name().toLowerCase(Locale.ROOT)).append('"')
         .append(",\"mode\":").append(ScoreViewExtension.jsonStr(mode))
         .append(",\"message\":").append(ScoreViewExtension.jsonStr(message))
         .append(",\"from\":").append(fmt(from)).append(",\"to\":").append(fmt(to)).append(",\"pos\":").append(fmt(pos))
         .append(",\"progress\":").append(fmt(progress)).append(",\"written\":").append(written)
         .append(",\"restored\":").append(restored).append(",\"run\":").append(runs)
         .append(",\"curves\":[");
      boolean first = true;
      final List<Curve> list;
      synchronized (curves) { list = new ArrayList<>(curves.values()); }
      for (final Curve c : list)
      {
         if (!first) sb.append(',');
         first = false;
         sb.append("{\"id\":").append(ScoreViewExtension.jsonStr(c.id())).append(",\"track\":").append(ScoreViewExtension.jsonStr(c.track()))
            .append(",\"profile\":").append(ScoreViewExtension.jsonStr(c.profile())).append(",\"target\":").append(ScoreViewExtension.jsonStr(c.target()))
            .append(",\"points\":").append(c.beats().length).append('}');
      }
      sb.append("],\"devices\":").append(rig.devicesJson()).append('}');
      return sb.toString();
   }

   static String fmt(final double v)
   {
      return String.format(Locale.ROOT, "%.3f", v).replaceAll("\\.?0+$", "");
   }

   // ================================================================== the real Bitwig rig

   /**
   * Pool of {@link #POOL} cursor tracks (own ids, not following the selection), each with a bank of {@link #DEVICES}
   * devices; every device gets a parameter for every vst3 target of the table and a remote-controls page. Also one
   * small device bank per project track, for the device names /api/curve reports. All created in init().
   */
   static final class BitwigRig implements Rig
   {
      private final List<Track> tracks;
      private final List<DeviceBank> trackDevices = new ArrayList<>();
      private final List<CursorTrack> pool = new ArrayList<>();
      private final List<DeviceBank> banks = new ArrayList<>();
      /** [slot][device] -> "PLUGIN:param" -> parameter */
      private final List<List<Map<String, Parameter>>> vst3 = new ArrayList<>();
      private final List<List<CursorRemoteControlsPage>> remotes = new ArrayList<>();
      private final Map<String, Profile> profiles;

      BitwigRig(final ControllerHost host, final List<Track> tracks, final Map<String, Profile> profiles)
      {
         this.tracks = tracks;
         this.profiles = profiles;
         for (final Track t : tracks)
         {
            final DeviceBank db = t.createDeviceBank(DEVICES);
            for (int d = 0; d < DEVICES; d++) { db.getDevice(d).name().markInterested(); db.getDevice(d).exists().markInterested(); }
            trackDevices.add(db);
         }
         final Map<String, List<Integer>> params = new LinkedHashMap<>(); // plugin -> param ids
         boolean anyRemote = false;
         for (final Profile p : profiles.values()) for (final Target t : p.targets())
         {
            if ("vst3".equals(t.kind()) && !t.plugin().isEmpty()) { final List<Integer> l = params.computeIfAbsent(t.plugin(), k -> new ArrayList<>()); if (!l.contains(t.param())) l.add(t.param()); }
            if ("remote".equals(t.kind())) anyRemote = true;
         }
         for (int s = 0; s < POOL; s++)
         {
            final CursorTrack ct = host.createCursorTrack("SCOREVIEW_CURVE_" + s, "Score View dynamics " + (s + 1), 0, 0, false);
            ct.name().markInterested();
            ct.exists().markInterested();
            final DeviceBank bank = ct.createDeviceBank(DEVICES);
            final List<Map<String, Parameter>> perDevice = new ArrayList<>();
            final List<CursorRemoteControlsPage> pages = new ArrayList<>();
            for (int d = 0; d < DEVICES; d++)
            {
               final Device dev = bank.getDevice(d);
               dev.name().markInterested();
               dev.exists().markInterested();
               final Map<String, Parameter> m = new LinkedHashMap<>();
               for (final Map.Entry<String, List<Integer>> e : params.entrySet())
               {
                  final SpecificPluginDevice sp = dev.createSpecificVst3Device(e.getKey());
                  for (final int id : e.getValue())
                  {
                     final Parameter p = sp.createParameter(id);
                     p.exists().markInterested();
                     p.value().markInterested();
                     p.name().markInterested();
                     m.put(e.getKey() + ":" + id, p);
                  }
               }
               perDevice.add(m);
               if (anyRemote)
               {
                  final CursorRemoteControlsPage page = dev.createCursorRemoteControlsPage(8);
                  for (int i = 0; i < 8; i++) { page.getParameter(i).exists().markInterested(); page.getParameter(i).value().markInterested(); }
                  pages.add(page);
               }
            }
            pool.add(ct);
            banks.add(bank);
            vst3.add(perDevice);
            remotes.add(pages);
         }
      }

      @Override public int slots() { return POOL; }

      @Override public boolean point(final int slot, final String name)
      {
         for (final Track t : tracks)
         {
            if (t.exists().get() && name.equals(t.name().get())) { pool.get(slot).selectChannel(t); return true; }
         }
         return false;
      }

      @Override public String slotTrack(final int slot) { return pool.get(slot).name().get(); }

      @Override public List<String> slotDevices(final int slot)
      {
         final List<String> out = new ArrayList<>();
         final DeviceBank b = banks.get(slot);
         for (int d = 0; d < DEVICES; d++) if (b.getDevice(d).exists().get()) out.add(b.getDevice(d).name().get());
         return out;
      }

      @Override public Control control(final int slot, final Target t)
      {
         switch (t.kind())
         {
            case "vst3" ->
            {
               for (final Map<String, Parameter> m : vst3.get(slot))
               {
                  final Parameter p = m.get(t.plugin() + ":" + t.param());
                  if (p != null && p.exists().get()) return param(p);
               }
               return null;
            }
            case "remote" ->
            {
               final Profile prof = profiles.get(t.profile());
               final DeviceBank b = banks.get(slot);
               for (int d = 0; d < DEVICES && d < remotes.get(slot).size(); d++)
               {
                  final Device dev = b.getDevice(d);
                  if (!dev.exists().get() || prof.names().stream().noneMatch(n -> dev.name().get().toLowerCase(Locale.ROOT).contains(n.toLowerCase(Locale.ROOT)))) continue;
                  final Parameter p = remotes.get(slot).get(d).getParameter(Math.max(0, Math.min(7, t.index())));
                  return p.exists().get() ? param(p) : null;
               }
               return null;
            }
            case "cc" ->
            {
               final CursorTrack ct = pool.get(slot);
               return new Control()
               {
                  int last = -1;
                  @Override public boolean exists() { return ct.exists().get(); }
                  @Override public void touch(final boolean on) { }
                  @Override public void set(final double v)
                  {
                     final int cc = (int) Math.round(Math.max(0, Math.min(1, v)) * 127);
                     if (cc != last) { ct.sendMidi(0xB0, t.cc(), cc); last = cc; }
                  }
                  @Override public double value() { return last / 127.0; }
               };
            }
            default -> { return null; }
         }
      }

      private static Control param(final Parameter p)
      {
         return new Control()
         {
            @Override public boolean exists() { return p.exists().get(); }
            @Override public void touch(final boolean on) { p.touch(on); }
            @Override public void set(final double v) { p.set(v); }
            @Override public double value() { return p.value().get(); }
         };
      }

      @Override public String devicesJson()
      {
         final StringBuilder sb = new StringBuilder("{");
         boolean first = true;
         for (int i = 0; i < tracks.size(); i++)
         {
            final Track t = tracks.get(i);
            if (!t.exists().get()) continue;
            final DeviceBank db = trackDevices.get(i);
            final List<String> names = new ArrayList<>();
            for (int d = 0; d < DEVICES; d++) if (db.getDevice(d).exists().get()) names.add(ScoreViewExtension.jsonStr(db.getDevice(d).name().get()));
            if (names.isEmpty()) continue;
            if (!first) sb.append(',');
            first = false;
            sb.append(ScoreViewExtension.jsonStr(t.name().get())).append(":[").append(String.join(",", names)).append(']');
         }
         return sb.append('}').toString();
      }
   }

   // ================================================================== a small JSON reader (the profile table)

   /** Minimal JSON parser: objects -> LinkedHashMap, arrays -> ArrayList, numbers -> Double, true/false/null. */
   static final class Json
   {
      private final String s;
      private int i;

      private Json(final String s) { this.s = s; }

      static Object parse(final String text)
      {
         final Json j = new Json(text);
         final Object v = j.value();
         j.ws();
         if (j.i != j.s.length()) throw new IllegalArgumentException("JSON: trailing text at " + j.i);
         return v;
      }

      private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

      private Object value()
      {
         ws();
         if (i >= s.length()) throw new IllegalArgumentException("JSON: unexpected end");
         final char c = s.charAt(i);
         if (c == '{')
         {
            i++;
            final Map<String, Object> m = new LinkedHashMap<>();
            ws();
            if (s.charAt(i) == '}') { i++; return m; }
            while (true)
            {
               ws();
               final String k = string();
               ws();
               expect(':');
               m.put(k, value());
               ws();
               if (s.charAt(i) == ',') { i++; continue; }
               expect('}');
               return m;
            }
         }
         if (c == '[')
         {
            i++;
            final List<Object> l = new ArrayList<>();
            ws();
            if (s.charAt(i) == ']') { i++; return l; }
            while (true)
            {
               l.add(value());
               ws();
               if (s.charAt(i) == ',') { i++; continue; }
               expect(']');
               return l;
            }
         }
         if (c == '"') return string();
         if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
         if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
         if (s.startsWith("null", i)) { i += 4; return null; }
         final int st = i;
         while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
         if (st == i) throw new IllegalArgumentException("JSON: unexpected '" + c + "' at " + i);
         return Double.parseDouble(s.substring(st, i));
      }

      private void expect(final char c)
      {
         if (i >= s.length() || s.charAt(i) != c) throw new IllegalArgumentException("JSON: expected '" + c + "' at " + i);
         i++;
      }

      private String string()
      {
         expect('"');
         final StringBuilder b = new StringBuilder();
         while (i < s.length())
         {
            final char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c != '\\') { b.append(c); continue; }
            final char e = s.charAt(i++);
            switch (e)
            {
               case 'n' -> b.append('\n');
               case 't' -> b.append('\t');
               case 'r' -> b.append('\r');
               case 'b' -> b.append('\b');
               case 'f' -> b.append('\f');
               case 'u' -> { b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
               default -> b.append(e);
            }
         }
         throw new IllegalArgumentException("JSON: unterminated string");
      }
   }
}
