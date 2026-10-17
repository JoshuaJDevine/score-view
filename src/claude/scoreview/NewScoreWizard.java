package claude.scoreview;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BooleanSupplier;

import com.bitwig.extension.controller.api.Action;
import com.bitwig.extension.controller.api.Application;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.CueMarker;
import com.bitwig.extension.controller.api.CueMarkerBank;
import com.bitwig.extension.controller.api.CursorDeviceFollowMode;
import com.bitwig.extension.controller.api.CursorTrack;
import com.bitwig.extension.controller.api.Device;
import com.bitwig.extension.controller.api.DeviceBank;
import com.bitwig.extension.controller.api.InsertionPoint;
import com.bitwig.extension.controller.api.PinnableCursorDevice;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.TrackBank;
import com.bitwig.extension.controller.api.Transport;

/**
 * "New Score" wizard (issue #14, docs/wizard.md): builds the tracks of an ensemble in the current project, and swaps
 * the instrument plug-in of one track. Uses only the documented controller API:
 * <ul>
 * <li>{@code Application.createInstrumentTrack(position)} creates a track (no handle is returned: the new track is
 *     found by diffing the flat track list, then tagged with a unique temporary name so later steps can find it again
 *     after tracks shift; the real names are set in a final pass, also on cancel/failure).</li>
 * <li>{@code Track.name()/color()} name and colour it.</li>
 * <li>{@code endOfDeviceChainInsertionPoint().insertFile / insertVST3Device / insertCLAPDevice / insertVST2Device /
 *     insertBitwigDevice} add the Note FX preset and the instrument, in order.</li>
 * <li>Groups: there is no "create group" call. The first track of a group is selected ({@code selectInEditor}) and
 *     Bitwig's "Group" action is invoked (after focusing the track headers); the result is verified through
 *     {@code Track.createParentTrack}. Later members are moved after the previous member with
 *     {@code afterTrackInsertionPoint().moveTracks(...)} (which keeps them inside the group) and verified the same
 *     way. When grouping is not possible the tracks stay ungrouped and the summary says so.</li>
 * <li>Swap: a private cursor track ({@code selectChannel}) with a FIRST_INSTRUMENT cursor device; the new plug-in goes
 *     after the old one, which is then disabled ({@code isEnabled}), or replaces it ({@code replaceDeviceInsertionPoint}).</li>
 * <li>Starter settings (optional plan lines {@code option tempo=}, {@code option meter=n/d}, {@code marker name= bar=}):
 *     {@code Transport.tempo().value().setRaw(bpm)}, {@code timeSignature().numerator()/denominator().set}, and cue
 *     markers via {@code setPosition(beat)} + {@code addCueMarkerAtPlaybackPosition()}, then the new marker (found in a
 *     {@code CueMarkerBank} by its position) is renamed with {@code CueMarker.name().set}. Markers are skipped while
 *     playing; an existing marker at the same position is kept; the play position is restored afterwards.</li>
 * </ul>
 * Everything runs on the control thread, one step at a time; each step waits until Bitwig reports the change (or a
 * timeout). Plans arrive as text from {@code POST /api/wizard} (see {@link #submit}).
 */
final class NewScoreWizard
{
   static final int BANK = 256;
   private static final long TICK_MS = 30;

   /** Preferences > Score View > Developer mode (set by the extension): presets may then come from any folder. */
   private BooleanSupplier developerMode = () -> false;

   void setDeveloperMode(final BooleanSupplier developerMode)
   {
      this.developerMode = developerMode;
   }

   private final ControllerHost host;
   private final Application app;
   private final TrackBank bank;
   private final Track[] slots = new Track[BANK];
   private final Track[] parents = new Track[BANK];
   private final CursorTrack cursor;
   private final DeviceBank devices;
   private final PinnableCursorDevice instrument;
   private final Runnable onDone;
   private final Action groupAction, headerFocus;
   static final int CUES = 128;
   private final Transport transport;
   private final CueMarker[] cues = new CueMarker[CUES];

   // ---- requests from HTTP threads
   private volatile String pendingPlan;
   private volatile boolean cancelRequested;

   // ---- job state (control thread; read by statusJson from HTTP threads)
   private volatile String state = "idle", kind = "", message = "";
   private volatile int stepNo, stepTotal;
   private final Deque<Step> queue = new ArrayDeque<>();
   private Step current;
   private long startedAt;
   private int jobNo;
   private final List<Row> rows = new ArrayList<>();
   private final Map<String, GroupRun> groups = new LinkedHashMap<>();
   private final List<String> errors = new ArrayList<>();
   private final List<String> notes = new ArrayList<>();
   private final List<String> settings = new ArrayList<>(); // starter settings results: "ok:text" / "fail:text"
   private List<String> snapshot = List.of();
   private int nextTop;
   private boolean finalizing;
   private List<Path> presetRoots; // presetRoots(), listed once per plan (start() clears it)

   /** One step: act once, then wait until done() (after minMs) or fail after maxMs. */
   private static final class Step
   {
      final String label;
      final Runnable act;
      final BooleanSupplier done;
      final long minMs, maxMs;
      final Runnable onTimeout; // null = fatal

      Step(final String label, final Runnable act, final BooleanSupplier done, final long minMs, final long maxMs, final Runnable onTimeout)
      {
         this.label = label; this.act = act; this.done = done; this.minMs = minMs; this.maxMs = maxMs; this.onTimeout = onTimeout;
      }
   }

   /** A device to insert: kind = vst3 | clap | vst2 | bitwig | file. */
   private record Dev(String kind, String id, String label) {}

   /** One track of the plan, with what happened to it. */
   private static final class Row
   {
      String name, tag, group, color;
      final List<Dev> devs = new ArrayList<>();
      final List<String> devResults = new ArrayList<>(); // "ok:label" / "fail:label: why"
      boolean created, grouped;
      String groupMsg = "";
   }

   /** A run of consecutive rows sharing a group name. */
   private static final class GroupRun
   {
      String name, tag, color;
      String original = ""; // the name Bitwig gave the new group (members are recognised by it if renaming fails)
      boolean ok;
      String msg = "";
      final List<Row> members = new ArrayList<>();
   }

   NewScoreWizard(final ControllerHost host, final Application app, final Transport transport, final Runnable onDone)
   {
      this.host = host;
      this.app = app;
      this.transport = transport;
      this.onDone = onDone;
      transport.tempo().value().markInterested();
      transport.timeSignature().numerator().markInterested();
      transport.timeSignature().denominator().markInterested();
      transport.getPosition().markInterested();
      transport.isPlaying().markInterested();
      final CueMarkerBank cueBank = host.createArranger().createCueMarkerBank(CUES);
      for (int i = 0; i < CUES; i++)
      {
         final CueMarker m = cueBank.getItemAt(i);
         m.exists().markInterested();
         m.name().markInterested();
         m.position().markInterested();
         cues[i] = m;
      }
      bank = host.createTrackBank(BANK, 0, 0, true);
      bank.itemCount().markInterested();
      for (int i = 0; i < BANK; i++)
      {
         final Track t = bank.getItemAt(i);
         t.exists().markInterested();
         t.name().markInterested();
         t.isGroup().markInterested();
         slots[i] = t;
         final Track p = t.createParentTrack(0, 0);
         p.exists().markInterested();
         p.name().markInterested();
         p.isGroup().markInterested();
         parents[i] = p;
      }
      cursor = host.createCursorTrack("SCOREVIEW_WIZARD", "Score View wizard", 0, 0, false);
      cursor.exists().markInterested();
      cursor.name().markInterested();
      devices = cursor.createDeviceBank(32);
      devices.itemCount().markInterested();
      for (int d = 0; d < 32; d++) devices.getItemAt(d).isWindowOpen().markInterested();
      instrument = cursor.createCursorDevice("SCOREVIEW_WIZARD_INST", "Score View wizard instrument", 0, CursorDeviceFollowMode.FIRST_INSTRUMENT);
      instrument.exists().markInterested();
      instrument.name().markInterested();
      instrument.isEnabled().markInterested();
      groupAction = findAction(new String[] { "group", "group_tracks", "group_selected_tracks", "Group Tracks" },
         new String[] { "Group", "Group Tracks", "Group Selected Tracks", "Group Selection" });
      headerFocus = findAction(new String[] { "focus_track_header_area" }, new String[] { "Focus Track Header Area" });
      // Multi-selecting tracks (verified live): select the first, then per further track move the selection cursor
      // down and toggle the item at the cursor. Track.moveTracks into a group did nothing in Bitwig 6.1.
      cursorNext = findAction(new String[] { "move_selection_cursor_to_next_item" }, new String[] { "Move selection cursor to next item" });
      toggleSel = findAction(new String[] { "Toggle selection of item at cursor" }, new String[] { "Toggle selection of item at cursor" });
      host.scheduleTask(this::tick, TICK_MS);
   }

   private Action cursorNext, toggleSel;

   private Action findAction(final String[] ids, final String[] names)
   {
      final Action[] all = app.getActions();
      for (final String id : ids) for (final Action a : all) if (id.equalsIgnoreCase(a.getId())) return a;
      for (final String n : names) for (final Action a : all) if (n.equalsIgnoreCase(a.getName())) return a;
      return null;
   }

   // ---------------------------------------------------------------- requests (any thread)

   /** Queues a plan (text, see parse); returns an error message or null. Runs on the next control-thread tick. */
   String submit(final String plan)
   {
      if ("running".equals(state) || pendingPlan != null) return "A wizard job is already running.";
      pendingPlan = plan;
      state = "queued"; // so a poll right after POST does not read the previous job's final state
      message = "Waiting for Bitwig";
      return null;
   }

   void cancel()
   {
      cancelRequested = true;
   }

   /** GET /api/wizard (status; ?caps = what this Bitwig offers), POST /api/wizard (plan body; ?cancel). */
   void handle(final com.sun.net.httpserver.HttpExchange ex) throws java.io.IOException
   {
      final String q = ex.getRequestURI().getQuery() == null ? "" : ex.getRequestURI().getQuery();
      String json;
      if ("POST".equalsIgnoreCase(ex.getRequestMethod()))
      {
         final String body;
         try (java.io.InputStream in = ex.getRequestBody()) { body = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8); }
         if (q.contains("cancel")) { cancel(); json = "{\"ok\":true}"; }
         else
         {
            final String err = submit(body);
            json = err == null ? "{\"ok\":true}" : "{\"ok\":false,\"error\":" + ScoreViewExtension.jsonStr(err) + "}";
         }
      }
      else json = q.contains("caps") ? capsJson() : statusJson();
      final byte[] bytes = json.getBytes(java.nio.charset.StandardCharsets.UTF_8);
      ex.getResponseHeaders().set("Content-Type", "application/json");
      ex.getResponseHeaders().set("Cache-Control", "no-store");
      ex.sendResponseHeaders(200, bytes.length);
      try (java.io.OutputStream os = ex.getResponseBody()) { os.write(bytes); }
   }

   String capsJson()
   {
      return "{\"groupAction\":" + actionJson(groupAction) + ",\"headerFocus\":" + actionJson(headerFocus)
         + ",\"bank\":" + BANK + ",\"tracks\":" + bank.itemCount().get() + "}";
   }

   private static String actionJson(final Action a)
   {
      return a == null ? "null" : "{\"id\":" + ScoreViewExtension.jsonStr(a.getId()) + ",\"name\":" + ScoreViewExtension.jsonStr(a.getName()) + "}";
   }

   String statusJson()
   {
      final StringBuilder sb = new StringBuilder(1024);
      synchronized (rows)
      {
         sb.append("{\"state\":\"").append(state).append("\",\"kind\":\"").append(kind).append('"')
            .append(",\"message\":").append(ScoreViewExtension.jsonStr(message))
            .append(",\"step\":").append(stepNo).append(",\"steps\":").append(stepTotal)
            .append(",\"tracks\":[");
         for (int i = 0; i < rows.size(); i++)
         {
            final Row r = rows.get(i);
            if (i > 0) sb.append(',');
            sb.append("{\"name\":").append(ScoreViewExtension.jsonStr(r.name))
               .append(",\"group\":").append(ScoreViewExtension.jsonStr(r.group))
               .append(",\"created\":").append(r.created)
               .append(",\"grouped\":").append(r.grouped)
               .append(",\"groupMsg\":").append(ScoreViewExtension.jsonStr(r.groupMsg))
               .append(",\"devices\":[");
            for (int d = 0; d < r.devResults.size(); d++)
            {
               final String res = r.devResults.get(d);
               final boolean ok = res.startsWith("ok:");
               if (d > 0) sb.append(',');
               sb.append("{\"ok\":").append(ok).append(",\"text\":").append(ScoreViewExtension.jsonStr(res.substring(ok ? 3 : 5))).append('}');
            }
            sb.append("]}");
         }
         sb.append("],\"groups\":[");
         boolean first = true;
         for (final GroupRun g : groups.values())
         {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"name\":").append(ScoreViewExtension.jsonStr(g.name)).append(",\"ok\":").append(g.ok)
               .append(",\"msg\":").append(ScoreViewExtension.jsonStr(g.msg)).append('}');
         }
         sb.append("],\"settings\":[");
         for (int i = 0; i < settings.size(); i++)
         {
            final String res = settings.get(i);
            final boolean ok = res.startsWith("ok:");
            sb.append(i > 0 ? "," : "").append("{\"ok\":").append(ok).append(",\"text\":")
               .append(ScoreViewExtension.jsonStr(res.substring(ok ? 3 : 5))).append('}');
         }
         sb.append("],\"errors\":[");
         for (int i = 0; i < errors.size(); i++) sb.append(i > 0 ? "," : "").append(ScoreViewExtension.jsonStr(errors.get(i)));
         sb.append("],\"notes\":[");
         for (int i = 0; i < notes.size(); i++) sb.append(i > 0 ? "," : "").append(ScoreViewExtension.jsonStr(notes.get(i)));
         sb.append("]}");
      }
      return sb.toString();
   }

   // ---------------------------------------------------------------- engine (control thread)

   private void tick()
   {
      try { step(); }
      catch (final Exception e)
      {
         host.errorln("Score View wizard: " + e);
         error("Internal error: " + e.getMessage());
         queue.clear();
         current = null;
         if (!finalizing) beginFinalize(); else finish();
      }
      host.scheduleTask(this::tick, TICK_MS);
   }

   private void step()
   {
      final String plan = pendingPlan;
      if (plan != null && !"running".equals(state))
      {
         pendingPlan = null;
         start(plan);
      }
      if (!"running".equals(state)) return;
      if (cancelRequested && !finalizing)
      {
         cancelRequested = false;
         note("Cancelled by the user.");
         queue.clear();
         current = null;
         beginFinalize();
      }
      final long now = System.currentTimeMillis();
      if (current == null)
      {
         current = queue.pollFirst();
         if (current == null)
         {
            if (!finalizing) beginFinalize(); else finish();
            return;
         }
         stepNo++;
         message = current.label;
         startedAt = now;
         current.act.run();
         return;
      }
      final long age = now - startedAt;
      if (age >= current.minMs && current.done.getAsBoolean()) { current = null; return; }
      if (age > current.maxMs)
      {
         final Step s = current;
         current = null;
         if (s.onTimeout != null) s.onTimeout.run();
         else
         {
            error("Stopped: " + s.label + " did not complete.");
            queue.clear();
            if (!finalizing) beginFinalize(); else finish();
         }
      }
   }

   private void add(final String label, final Runnable act, final BooleanSupplier done, final long minMs, final long maxMs, final Runnable onTimeout)
   {
      queue.addLast(new Step(label, act, done, minMs, maxMs, onTimeout));
      stepTotal++;
   }

   private void error(final String s)
   {
      synchronized (rows) { errors.add(s); }
   }

   private void note(final String s)
   {
      synchronized (rows) { notes.add(s); }
   }

   private void start(final String plan)
   {
      synchronized (rows) { rows.clear(); groups.clear(); errors.clear(); notes.clear(); settings.clear(); }
      presetRoots = null;
      queue.clear();
      current = null;
      finalizing = false;
      cancelRequested = false;
      stepNo = 0;
      stepTotal = 0;
      jobNo++;
      nextTop = -1;
      state = "running";
      message = "Starting";
      String swapLine = null;
      int pos = -1;
      double tempo = 0;
      int[] meter = null;
      final List<Map<String, List<String>>> trackLines = new ArrayList<>();
      final List<Map<String, List<String>>> markerLines = new ArrayList<>();
      final Map<String, String> groupColors = new LinkedHashMap<>();
      for (final String line : plan.split("\n"))
      {
         final String t = line.replace("\r", "");
         if (t.isBlank()) continue;
         final Map<String, List<String>> f = fields(t);
         final String cmd = t.split("\t", 2)[0].trim();
         switch (cmd)
         {
            case "option" ->
            {
               if (f.containsKey("pos")) pos = Integer.parseInt(first(f, "pos").trim());
               if (f.containsKey("tempo")) tempo = parseTempo(first(f, "tempo"));
               if (f.containsKey("meter")) meter = parseMeter(first(f, "meter"));
            }
            case "group" -> groupColors.put(first(f, "name"), first(f, "color"));
            case "track" -> trackLines.add(f);
            case "marker" -> markerLines.add(f);
            case "swap" -> swapLine = t;
            default -> note("Ignored plan line: " + cmd);
         }
      }
      if (swapLine != null) { kind = "swap"; planSwap(fields(swapLine)); return; }
      kind = "create";
      if (trackLines.isEmpty() && tempo <= 0 && meter == null && markerLines.isEmpty())
      {
         state = "error";
         message = "The plan has no tracks.";
         return;
      }
      planSettings(tempo, meter, markerLines);
      if (bank.itemCount().get() + trackLines.size() * 2 >= BANK)
      {
         state = "error";
         message = "The project has too many tracks for the wizard (limit " + BANK + " incl. the new ones).";
         return;
      }
      nextTop = pos;
      String prevGroup = null;
      GroupRun run = null;
      Row prevMember = null;
      int k = 0, runNo = 0;
      for (final Map<String, List<String>> f : trackLines)
      {
         final Row r = new Row();
         r.name = sanitize(first(f, "name"));
         if (r.name.isEmpty()) r.name = "Instrument";
         r.tag = r.name + " [sv" + jobNo + "-" + (++k) + "]";
         r.group = blankToNull(first(f, "group"));
         r.color = first(f, "color");
         for (final String d : f.getOrDefault("dev", List.of()))
         {
            final int c = d.indexOf(':');
            if (c <= 0) { note("Ignored device \"" + d + "\""); continue; }
            final String devKind = d.substring(0, c), rest = d.substring(c + 1);
            final int bar = rest.indexOf('|'); // "vst3:<id>|<label>"
            final String id = bar >= 0 ? rest.substring(0, bar) : rest;
            final String label = bar >= 0 ? rest.substring(bar + 1) : id;
            r.devs.add(new Dev(devKind, id, label));
         }
         synchronized (rows) { rows.add(r); }
         final boolean newRun = r.group != null && !r.group.equals(prevGroup);
         if (newRun)
         {
            run = new GroupRun();
            run.name = r.group;
            run.tag = r.group + " [sv" + jobNo + "-g" + (++runNo) + "]";
            run.color = groupColors.get(r.group);
            synchronized (rows) { groups.put(run.tag, run); }
            prevMember = null;
         }
         if (r.group == null) { run = null; prevMember = null; }
         planTrack(r, run, prevMember);
         if (run != null) { run.members.add(r); prevMember = r; }
         prevGroup = r.group;
      }
      // Group each run of consecutive tracks in one go, once all tracks (and their devices) exist.
      final List<GroupRun> runs;
      synchronized (rows) { runs = new ArrayList<>(groups.values()); }
      for (final GroupRun g : runs) planGroupRun(g);
   }

   // ---------------------------------------------------------------- starter settings (tempo, meter, markers)

   private void setting(final boolean ok, final String text)
   {
      synchronized (rows) { settings.add((ok ? "ok:" : "fail:") + text); }
      if (!ok) error(text);
   }

   /** Tempo, time signature and named cue markers, each optional; run before the tracks are created. */
   private void planSettings(final double tempo, final int[] meter, final List<Map<String, List<String>>> markerLines)
   {
      if (tempo > 0)
      {
         final String what = "Tempo " + fmt(tempo) + " BPM";
         add("Setting tempo to " + fmt(tempo) + " BPM", () -> transport.tempo().value().setRaw(tempo),
            () -> Math.abs(transport.tempo().value().getRaw() - tempo) < 0.01, 50, 2000, () -> {});
         add("Checked tempo", () -> {
            final double now = transport.tempo().value().getRaw();
            setting(Math.abs(now - tempo) < 0.01, Math.abs(now - tempo) < 0.01 ? what : what + ": Bitwig reports " + fmt(now));
         }, () -> true, 0, 100, () -> {});
      }
      if (meter != null)
      {
         final String what = "Time signature " + meter[0] + "/" + meter[1];
         add("Setting time signature " + meter[0] + "/" + meter[1], () -> {
            transport.timeSignature().numerator().set(meter[0]);
            transport.timeSignature().denominator().set(meter[1]);
         }, () -> meterIs(meter), 50, 2000, () -> {});
         add("Checked time signature", () -> setting(meterIs(meter), meterIs(meter) ? what
            : what + ": Bitwig reports " + transport.timeSignature().numerator().get() + "/" + transport.timeSignature().denominator().get()),
            () -> true, 0, 100, () -> {});
      }
      if (markerLines.isEmpty()) return;
      final boolean[] skipAll = { false };
      final double[] home = { 0 };
      add("Preparing section markers", () -> {
         skipAll[0] = transport.isPlaying().get();
         home[0] = transport.getPosition().get();
         if (skipAll[0]) setting(false, "Section markers skipped: stop playback in Bitwig first.");
      }, () -> true, 0, 100, () -> {});
      for (final Map<String, List<String>> f : markerLines)
      {
         final String name = sanitize(first(f, "name")).isEmpty() ? "Section" : sanitize(first(f, "name"));
         final int bar = Math.max(1, parseIntOr(first(f, "bar"), 1));
         final double[] beat = { 0 };
         final String[] problem = { null };
         final boolean[] skip = { false };
         final String what = "Marker \"" + name + "\" at bar " + bar;
         add("Moving to bar " + bar, () -> {
            if (skipAll[0]) { skip[0] = true; return; }
            beat[0] = (bar - 1) * barBeats();
            final int existing = cueAt(beat[0]);
            if (existing >= 0)
            {
               skip[0] = true;
               setting(true, what + ": kept the existing marker \"" + cues[existing].name().get() + "\"");
               return;
            }
            transport.setPosition(beat[0]);
         }, () -> skip[0] || Math.abs(transport.getPosition().get() - beat[0]) < 1e-3, 30, 1500,
            () -> problem[0] = "the play position did not move there");
         add("Adding marker " + name, () -> {
            if (skip[0] || problem[0] != null) return;
            transport.addCueMarkerAtPlaybackPosition();
         }, () -> skip[0] || problem[0] != null || cueAt(beat[0]) >= 0, 60, 2000,
            () -> problem[0] = "Bitwig did not add a cue marker");
         add("Naming marker " + name, () -> {
            if (skip[0] || problem[0] != null) return;
            final int i = cueAt(beat[0]);
            if (i >= 0) cues[i].name().set(name);
         }, () -> {
            if (skip[0] || problem[0] != null) return true;
            final int i = cueAt(beat[0]);
            return i >= 0 && name.equals(cues[i].name().get());
         }, 30, 2000, () -> problem[0] = "added, but it could not be renamed");
         add("Checked marker " + name, () -> {
            if (!skip[0]) setting(problem[0] == null, problem[0] == null ? what : what + ": " + problem[0]);
         }, () -> true, 0, 100, () -> {});
      }
      add("Restoring the play position", () -> { if (!skipAll[0]) transport.setPosition(home[0]); }, () -> true, 30, 500, () -> {});
   }

   private boolean meterIs(final int[] m)
   {
      return transport.timeSignature().numerator().get() == m[0] && transport.timeSignature().denominator().get() == m[1];
   }

   /** Length of one bar in quarter-note beats (Bitwig's beat unit) in the current time signature. */
   private double barBeats()
   {
      final int num = transport.timeSignature().numerator().get(), den = transport.timeSignature().denominator().get();
      return num > 0 && den > 0 ? num * 4.0 / den : 4.0;
   }

   /** Index of the cue marker at a position (in the bank of {@link #CUES}), or -1. */
   private int cueAt(final double beat)
   {
      for (int i = 0; i < CUES; i++) if (cues[i].exists().get() && Math.abs(cues[i].position().get() - beat) < 1e-3) return i;
      return -1;
   }

   static double parseTempo(final String s)
   {
      try { final double v = Double.parseDouble(s.trim()); return v >= 20 && v <= 666 ? v : 0; }
      catch (final RuntimeException e) { return 0; }
   }

   /** "6/8" -> {6, 8}; null unless the numerator is 1..32 and the denominator a power of two up to 32. */
   static int[] parseMeter(final String s)
   {
      if (s == null) return null;
      final String[] p = s.trim().split("/");
      if (p.length != 2) return null;
      final int n = parseIntOr(p[0], 0), d = parseIntOr(p[1], 0);
      return n >= 1 && n <= 32 && d >= 1 && d <= 32 && (d & (d - 1)) == 0 ? new int[] { n, d } : null;
   }

   private static String fmt(final double v)
   {
      return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
   }

   // ---------------------------------------------------------------- create plan

   private void planTrack(final Row r, final GroupRun run, final Row prevMember)
   {
      final int[] created = { -1 };
      add("Creating track " + r.name, () -> {
         snapshot = names();
         app.createInstrumentTrack(nextTop);
      }, () -> bank.itemCount().get() > snapshot.size(), 60, 4000, null);
      add("Naming " + r.name, () -> {
         // At the end (-1) the new track is the last flat entry, which the diff finds. At a position, the diff can
         // be fooled by a neighbour with the same default name: then (only then) trust the nextTop-th top-level slot.
         final List<String> now = names();
         created[0] = newSlot(snapshot, now);
         final int expected = nextTop >= 0 ? topLevelSlot(nextTop) : -1;
         if (expected >= 0 && created[0] >= 0 && expected != created[0] && now.get(expected).equals(now.get(created[0])))
            created[0] = expected;
         if (created[0] >= 0) slots[created[0]].name().set(r.tag);
      }, () -> find(r.tag) >= 0, 30, 3000, null);
      add("Colouring " + r.name, () -> {
         r.created = true;
         // Tracks moved into a group do not take a top-level position; ungrouped ones (or a failed group's) do.
         if (nextTop >= 0) nextTop++; // every track starts top-level; grouping happens after all are created
         final float[] rgb = rgb(r.color);
         final int i = find(r.tag);
         if (rgb != null && i >= 0) slots[i].color().set(rgb[0], rgb[1], rgb[2]);
      }, () -> true, 0, 1000, () -> {});
      if (!r.devs.isEmpty()) planDevices(r);
   }

   /** True when the track at flat slot i sits directly under a group header that is its parent. */
   private boolean grouped(final int i)
   {
      return i > 0 && slots[i - 1].exists().get() && slots[i - 1].isGroup().get()
         && parents[i].exists().get() && parents[i].name().get().equals(slots[i - 1].name().get());
   }

   /** Selects the run's tracks (first + cursor/toggle for each further one), groups them, names/colours the group. */
   private void planGroupRun(final GroupRun run)
   {
      if (run.members.isEmpty()) return;
      if (groupAction == null || headerFocus == null || cursorNext == null || toggleSel == null)
      {
         run.msg = "Bitwig's Group / selection actions were not found; tracks left ungrouped.";
         for (final Row m : run.members) m.groupMsg = run.msg;
         error(run.name + ": " + run.msg);
         return;
      }
      final Row first = run.members.get(0);
      add("Selecting " + run.name + " tracks", () -> {
         final int i = find(first.tag);
         if (i >= 0) slots[i].selectInEditor();
         headerFocus.invoke();
      }, () -> true, 250, 1000, () -> {});
      for (int k = 1; k < run.members.size(); k++)
      {
         final Row m = run.members.get(k);
         add("Adding " + m.name + " to the selection", () -> { cursorNext.invoke(); toggleSel.invoke(); }, () -> true, 150, 600, () -> {});
      }
      add("Grouping " + run.name, groupAction::invoke, () -> grouped(find(first.tag)), 150, 3000, () -> {
         run.msg = "\"Group\" did not put the tracks in a group; tracks left ungrouped.";
         error(run.name + ": " + run.msg);
      });
      add("Naming group " + run.name, () -> {
         final int i = find(first.tag);
         if (!grouped(i)) return;
         run.ok = true;
         run.original = slots[i - 1].name().get();
         final Track g = slots[i - 1]; // the new group's header, just above its first member
         g.name().set(run.tag);
         g.isGroupExpanded().set(true); // members of a collapsed group are not in the flat track list
         final float[] rgb = rgb(run.color != null ? run.color : first.color);
         if (rgb != null) g.color().set(rgb[0], rgb[1], rgb[2]);
         if (nextTop >= 0) nextTop -= run.members.size() - 1; // n top-level tracks became one group
      }, () -> !run.ok || find(run.tag) >= 0, 30, 3000, () -> {
         run.msg = "Group created but could not be renamed.";
         error(run.name + ": " + run.msg);
      });
      add("Checking " + run.name, () -> {
         for (final Row m : run.members)
         {
            m.grouped = run.ok && inGroup(find(m.tag), run);
            if (!m.grouped && m.groupMsg.isEmpty()) m.groupMsg = run.ok ? "Not included in the group." : run.msg;
         }
      }, () -> true, 0, 100, () -> {});
   }

   private boolean inGroup(final int slot, final GroupRun run)
   {
      if (slot < 0 || !parents[slot].exists().get() || !parents[slot].isGroup().get()) return false;
      final String p = parents[slot].name().get();
      return run.tag.equals(p) || run.original.equals(p);
   }

   private void planDevices(final Row r)
   {
      final boolean[] focused = { false };
      add("Opening " + r.name + " devices", () -> {
         final int i = find(r.tag);
         if (i >= 0) cursor.selectChannel(slots[i]);
      }, () -> focused[0] = r.tag.equals(cursor.name().get()), 50, 3000, () -> {
         for (final Dev d : r.devs) r.devResults.add("fail:" + d.label() + ": track not reachable");
         error(r.name + ": could not reach the track to insert devices.");
      });
      for (final Dev d : r.devs)
      {
         final int[] before = { 0 };
         final String[] problem = { null };
         add("Loading " + d.label() + " on " + r.name, () -> {
            if (!focused[0] || !r.tag.equals(cursor.name().get())) { problem[0] = "track not reachable"; return; }
            before[0] = devices.itemCount().get();
            problem[0] = insert(cursor.endOfDeviceChainInsertionPoint(), d);
         }, () -> problem[0] != null || devices.itemCount().get() > before[0], 120, 15000, () -> {
            r.devResults.add("fail:" + d.label() + ": not confirmed by Bitwig (no new device in the chain)");
            error(r.name + ": " + d.label() + " did not appear in the device chain.");
         });
         add("Loaded " + d.label(), () -> {
            if (problem[0] != null) { r.devResults.add("fail:" + d.label() + ": " + problem[0]); error(r.name + ": " + d.label() + ": " + problem[0]); }
            else if (devices.itemCount().get() > before[0]) r.devResults.add("ok:" + d.label());
            closePluginWindows(); // Bitwig opens a plug-in's window on insert; they pile up and steal focus
         }, () -> true, 0, 100, () -> {});
         // Some plug-ins (BBC SO) open their window a moment after loading a preset: close again after a pause.
         add("Settling " + d.label(), () -> {}, () -> true, 900, 1200, () -> {});
         add("Closing windows", this::closePluginWindows, () -> true, 0, 100, () -> {});
      }
   }

   private void closePluginWindows()
   {
      for (int d = 0; d < 32; d++)
      {
         final com.bitwig.extension.controller.api.Device dev = devices.getItemAt(d);
         if (dev.isWindowOpen().get()) dev.isWindowOpen().set(false);
      }
   }

   /**
    * Folders a "file" device may come from. The page only sends preset files it found in the user's Bitwig library
    * or in the harvested "Score View Presets" folder (both under a "Bitwig Studio" documents folder: wizard-plugins.js,
    * wizard-presets.js); plug-ins themselves are inserted by id, never by path. Bitwig's own package/content folders and
    * the standard VST3 preset folders are allowed too. Anything else (a plan posted by something other than the page,
    * pointing at a file elsewhere on disk) is refused unless Developer mode is on.
    */
   static List<Path> presetRoots()
   {
      final String home = System.getProperty("user.home", "");
      final List<Path> roots = new ArrayList<>();
      final java.util.function.Consumer<String> add = p -> { try { roots.add(Path.of(p)); } catch (final Exception e) { /* bad path */ } };
      add.accept(home + "/Documents/Bitwig Studio");
      add.accept(home + "/Bitwig Studio");                           // Linux
      add.accept(home + "/.BitwigStudio");                           // Linux packages
      add.accept(home + "/Library/Application Support/Bitwig");      // macOS packages
      add.accept(home + "/Documents/VST3 Presets");
      add.accept(home + "/.vst3/presets");
      add.accept(home + "/Library/Audio/Presets");
      final File[] oneDrives = new File(home).listFiles(f -> f.isDirectory() && f.getName().startsWith("OneDrive"));
      if (oneDrives != null) for (final File od : oneDrives) add.accept(od.getPath() + "/Documents/Bitwig Studio");
      final String local = System.getenv("LOCALAPPDATA"), data = System.getenv("PROGRAMDATA");
      if (local != null) add.accept(local + "/Bitwig Studio");
      if (data != null) { add.accept(data + "/Bitwig Studio"); add.accept(data + "/VST3 Presets"); }
      return roots;
   }

   /** File types a wizard "file" device may be (presets and the samples Bitwig opens in a sampler), lower case. */
   static final Set<String> PRESET_EXTENSIONS = Set.of("bwpreset", "vstpreset", "fxp", "fxb", "multisample", "nksf",
      "wav", "aif", "aiff", "flac", "mp3", "ogg", "sf2", "sfz");

   /**
    * True for a path that is safe to hand to the file system at all: absolute and local. A UNC or device path
    * (two leading slashes or backslashes: a share, or a \\?\ or \\.\ device path) is refused before anything opens it,
    * because on Windows merely checking a UNC path makes an SMB connection that sends the user's credentials to that host.
    */
   static boolean localAbsolutePath(final String file)
   {
      if (file == null || file.isEmpty() || file.indexOf('\0') >= 0) return false;
      if (file.length() > 1 && isSlash(file.charAt(0)) && isSlash(file.charAt(1))) return false;
      try { return Path.of(file).isAbsolute(); }
      catch (final Exception e) { return false; }
   }

   private static boolean isSlash(final char c) { return c == '/' || c == '\\'; }

   /** {@link #presetRoots()} for the current plan. */
   private List<Path> roots()
   {
      if (presetRoots == null) presetRoots = presetRoots();
      return presetRoots;
   }

   /**
    * True when file is a local absolute path with a preset extension ({@link #PRESET_EXTENSIONS}) and an existing regular
    * file inside one of roots (after resolving "..", links and case). The path is checked as text before it is opened.
    */
   static boolean allowedPresetFile(final String file, final List<Path> roots)
   {
      if (!localAbsolutePath(file)) return false;
      final int dot = file.lastIndexOf('.');
      if (dot < 0 || !PRESET_EXTENSIONS.contains(file.substring(dot + 1).toLowerCase(java.util.Locale.ROOT))) return false;
      final Path real;
      try { real = Path.of(file).toRealPath(); }
      catch (final Exception e) { return false; }
      if (!Files.isRegularFile(real)) return false;
      for (final Path root : roots)
      {
         try { if (real.startsWith(root.toRealPath())) return true; }
         catch (final Exception e) { /* a root that does not exist on this machine */ }
      }
      return false;
   }

   /** Inserts one device; returns an error message or null. */
   private String insert(final InsertionPoint at, final Dev d)
   {
      switch (d.kind())
      {
         case "vst3" -> at.insertVST3Device(d.id());
         case "clap" -> at.insertCLAPDevice(d.id());
         case "vst2" ->
         {
            try { at.insertVST2Device(Integer.parseInt(d.id())); }
            catch (final NumberFormatException e) { return "bad VST2 id " + d.id(); }
         }
         case "bitwig" ->
         {
            try { at.insertBitwigDevice(UUID.fromString(d.id())); }
            catch (final IllegalArgumentException e) { return "bad Bitwig device id " + d.id(); }
         }
         case "file" ->
         {
            // The allow-list runs first: it checks the path as text (no network paths) before anything opens it.
            if (!developerMode.getAsBoolean() && !allowedPresetFile(d.id(), roots()))
               return "not a preset in the Bitwig library folders (allowed in Developer mode): " + d.id();
            if (!new File(d.id()).isFile()) return "file not found: " + d.id();
            at.insertFile(d.id());
         }
         default -> { return "unknown device kind " + d.kind(); }
      }
      return null;
   }

   /** Final pass (also after cancel or a fatal step): give every created track and group its real name. */
   private void beginFinalize()
   {
      finalizing = true;
      final List<Row> rs;
      synchronized (rows) { rs = new ArrayList<>(rows); }
      for (final Row r : rs)
      {
         if (r.tag == null) continue;
         add("Renaming " + r.name, () -> {
            final int i = find(r.tag);
            if (i >= 0) slots[i].name().set(r.name);
         }, () -> find(r.tag) < 0, 30, 2000, () -> error(r.name + ": temporary name could not be removed."));
      }
      final List<GroupRun> gs;
      synchronized (rows) { gs = new ArrayList<>(groups.values()); }
      for (final GroupRun g : gs)
      {
         add("Renaming group " + g.name, () -> {
            final int i = find(g.tag);
            if (i >= 0) slots[i].name().set(g.name);
         }, () -> find(g.tag) < 0, 30, 2000, () -> error(g.name + ": temporary group name could not be removed."));
      }
   }

   private void finish()
   {
      finalizing = false;
      final boolean cancelled = notes.contains("Cancelled by the user.");
      int made = 0;
      synchronized (rows) { for (final Row r : rows) if (r.created) made++; }
      state = cancelled ? "cancelled" : errors.isEmpty() ? "done" : "error";
      if ("create".equals(kind))
         message = (cancelled ? "Cancelled: " : "") + made + " of " + rows.size() + " tracks created"
            + (errors.isEmpty() ? "" : ", " + errors.size() + " problem" + (errors.size() == 1 ? "" : "s"));
      else message = errors.isEmpty() ? "Library swapped" : "Swap incomplete";
      onDone.run();
   }

   // ---------------------------------------------------------------- swap

   private void planSwap(final Map<String, List<String>> f)
   {
      final Row r = new Row();
      r.name = sanitize(first(f, "name"));
      r.tag = r.name;
      synchronized (rows) { rows.add(r); }
      final int hint = parseIntOr(first(f, "track"), -1);
      final String mode = first(f, "mode") == null ? "disable" : first(f, "mode");
      final String dev = first(f, "dev");
      if (dev == null || dev.indexOf(':') <= 0) { state = "error"; message = "No library given."; return; }
      final String devKind = dev.substring(0, dev.indexOf(':')), rest = dev.substring(dev.indexOf(':') + 1);
      final int bar = rest.indexOf('|');
      final Dev d = new Dev(devKind, bar >= 0 ? rest.substring(0, bar) : rest, bar >= 0 ? rest.substring(bar + 1) : rest);
      r.created = true;
      final int[] slot = { -1 };
      final String[] oldName = { null }, problem = { null };
      final int[] before = { 0 };
      add("Finding " + r.name, () -> {
         slot[0] = hint >= 0 && hint < BANK && slots[hint].exists().get() && r.name.equals(slots[hint].name().get()) ? hint : find(r.name);
         if (slot[0] >= 0) cursor.selectChannel(slots[slot[0]]);
      }, () -> slot[0] >= 0 && r.name.equals(cursor.name().get()), 300, 3000, null);
      add("Reading the current instrument", () -> {}, () -> true, 300, 1000, () -> {});
      add("Loading " + d.label(), () -> {
         before[0] = devices.itemCount().get();
         if (instrument.exists().get())
         {
            oldName[0] = instrument.name().get();
            note("Old instrument: " + oldName[0]);
            problem[0] = insert("replace".equals(mode) ? instrument.replaceDeviceInsertionPoint() : instrument.afterDeviceInsertionPoint(), d);
         }
         else
         {
            note("The track had no instrument; the new one goes at the end of its device chain.");
            problem[0] = insert(cursor.endOfDeviceChainInsertionPoint(), d);
         }
      }, () -> problem[0] != null || ("replace".equals(mode) && oldName[0] != null
            ? instrument.exists().get() && !oldName[0].equals(instrument.name().get()) || devices.itemCount().get() > before[0]
            : devices.itemCount().get() > before[0]), 150, 15000, () -> {
         problem[0] = "not confirmed by Bitwig (no new device in the chain)";
      });
      add("Disabling the old instrument", () -> {
         if (problem[0] != null) { r.devResults.add("fail:" + d.label() + ": " + problem[0]); error(r.name + ": " + d.label() + ": " + problem[0]); return; }
         r.devResults.add("ok:" + d.label());
         if (!"disable".equals(mode) || oldName[0] == null) return;
         // The FIRST_INSTRUMENT cursor still points at the old device (the new one was inserted after it).
         final Device old = instrument;
         if (oldName[0].equals(old.name().get()))
         {
            old.isEnabled().set(false);
            note("Disabled " + oldName[0] + " (kept in the chain; delete it in Bitwig when happy).");
         }
         else note("Old instrument not disabled: the cursor moved (" + old.name().get() + ").");
      }, () -> problem[0] != null || !"disable".equals(mode) || oldName[0] == null || !instrument.isEnabled().get()
            || !oldName[0].equals(instrument.name().get()), 100, 2000, () -> error("The old instrument could not be disabled."));
   }

   // ---------------------------------------------------------------- helpers

   private List<String> names()
   {
      final List<String> out = new ArrayList<>();
      final int n = Math.min(BANK, bank.itemCount().get());
      for (int i = 0; i < n; i++) out.add(slots[i].exists().get() ? slots[i].name().get() : "\u0000");
      return out;
   }

   /** Index of the one track that appeared between two flat track lists. */
   static int newSlot(final List<String> before, final List<String> after)
   {
      if (after.size() <= before.size()) return -1;
      for (int i = 0; i < before.size(); i++) if (!before.get(i).equals(after.get(i))) return i;
      return before.size();
   }

   /** Flat slot of the k-th top-level track (no parent group), or -1. */
   private int topLevelSlot(final int k)
   {
      final int n = Math.min(BANK, bank.itemCount().get());
      int count = 0;
      for (int i = 0; i < n; i++)
      {
         if (!slots[i].exists().get() || parents[i].exists().get() && parents[i].isGroup().get()) continue;
         if (count++ == k) return i;
      }
      return -1;
   }

   private int find(final String name)
   {
      if (name == null) return -1;
      final int n = Math.min(BANK, bank.itemCount().get());
      for (int i = 0; i < n; i++) if (slots[i].exists().get() && name.equals(slots[i].name().get())) return i;
      return -1;
   }

   /** "track\tname=Violins 1\tdev=vst3:...\tdev=file:..." -> {name:[...], dev:[...]} (values keep their order). */
   static Map<String, List<String>> fields(final String line)
   {
      final Map<String, List<String>> out = new LinkedHashMap<>();
      final String[] parts = line.split("\t");
      for (int i = 1; i < parts.length; i++)
      {
         final int eq = parts[i].indexOf('=');
         if (eq <= 0) continue;
         out.computeIfAbsent(parts[i].substring(0, eq).trim(), k -> new ArrayList<>()).add(parts[i].substring(eq + 1));
      }
      return out;
   }

   private static String first(final Map<String, List<String>> f, final String key)
   {
      final List<String> v = f.get(key);
      return v == null || v.isEmpty() ? null : v.get(0);
   }

   static float[] rgb(final String hex)
   {
      if (hex == null || !hex.matches("#?[0-9a-fA-F]{6}")) return null;
      final int v = Integer.parseInt(hex.startsWith("#") ? hex.substring(1) : hex, 16);
      return new float[] { ((v >> 16) & 255) / 255f, ((v >> 8) & 255) / 255f, (v & 255) / 255f };
   }

   private static String sanitize(final String s)
   {
      return s == null ? "" : s.replaceAll("[\\t\\r\\n]", " ").trim();
   }

   private static String blankToNull(final String s)
   {
      return s == null || s.isBlank() ? null : s.trim();
   }

   private static int parseIntOr(final String s, final int d)
   {
      try { return s == null ? d : Integer.parseInt(s.trim()); }
      catch (final NumberFormatException e) { return d; }
   }
}
