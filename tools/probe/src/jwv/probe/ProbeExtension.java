package jwv.probe;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;

import com.bitwig.extension.controller.ControllerExtension;
import com.bitwig.extension.controller.api.Clip;
import com.bitwig.extension.controller.api.ClipLauncherSlotBank;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.CursorDevice;
import com.bitwig.extension.controller.api.CursorRemoteControlsPage;
import com.bitwig.extension.controller.api.CursorTrack;
import com.bitwig.extension.controller.api.NoteStep;
import com.bitwig.extension.controller.api.Parameter;
import com.bitwig.extension.controller.api.Preferences;
import com.bitwig.extension.controller.api.SettableEnumValue;
import com.bitwig.extension.controller.api.SettableRangedValue;
import com.bitwig.extension.controller.api.SpecificPluginDevice;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.TrackBank;
import com.bitwig.extension.controller.api.Transport;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * Score View Probe — answers "can notation become continuous control in Bitwig?" (docs/library-profiles.md).
 * Run it only in a throwaway project.
 *
 * Driven over HTTP on 127.0.0.1:8767 (so it can be scripted) or from Bitwig's controller settings:
 *   GET  /status                       JSON snapshot (track, device, params, write state, slots, direct params, log tail)
 *   POST /cmd   (header X-Probe: 1)    one command per line:
 *     select track=<name> [device=<n>]   select a track (and its n-th device, 1-based; default 1)
 *     run target=<dynamics|expression|remote1|direct:<id>> write=<arranger|launcher|preview> seconds=<s> [from=<beat>]
 *                                        hairpin ramp 0.1→0.9→0.1 in real time with the given automation write (P1–P4)
 *     stop                               stop a ramp, stop transport if we started it, restore write state
 *     mkclip slot=<n> beats=<b> [key=<midi>]  create a launcher clip with one held note (for P2/P6)
 *     launch slot=<n>                    launch a launcher slot
 *     insert slot=<n> [file=<path>]      insertFile a .mid into a launcher slot (P5)
 *     pressure v=<0..1> [all=1]          per-note pressure on the selected notes (or all notes) of the cursor clip (P6)
 *     sendmidi cc=<n> seconds=<s> [record=1]  Track.sendMidi CC hairpin; record=1 arms the track and records (P7)
 * Results also go to <Bitwig Studio folder>/Score View Probe/probe-log.txt and the Controller Script Console.
 */
public class ProbeExtension extends ControllerExtension
{
   private static final String BBCSO_VST3 = "56535453616E746262632073796D7068";
   private static final String CAT = "Probe";
   private static final int PORT = 8767, TICK_MS = 10, SCENES = 8, TRACKS = 64, GRID_W = 4096, GRID_H = 128;
   private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");

   private ControllerHost host;
   private Transport transport;
   private CursorTrack track;
   private TrackBank bank;
   private CursorDevice device;
   private Parameter dynamics, expression, remote1;
   private final Map<String, Parameter> extra = new LinkedHashMap<>(); // from probe-targets.txt: name → plug-in parameter
   private ClipLauncherSlotBank slots;
   private Clip arrClip, lnchClip;
   private final Map<String, NoteStep> selArr = new LinkedHashMap<>(), selLnch = new LinkedHashMap<>();
   private final Map<String, NoteStep> allArr = new LinkedHashMap<>(), allLnch = new LinkedHashMap<>();
   private final Map<String, String> directNames = new ConcurrentHashMap<>();
   private final Map<String, Double> directValues = new ConcurrentHashMap<>();
   private volatile String[] directIds = new String[0];
   private SettableEnumValue target, writeMode;
   private SettableRangedValue seconds;
   private File logFile;
   private final Deque<String> logTail = new ArrayDeque<>();
   private final ConcurrentLinkedQueue<String> commands = new ConcurrentLinkedQueue<>();
   private volatile String status = "{}";
   private HttpServer server;

   // ramp state
   private boolean running, startedTransport, saved, recording;
   private String savedMode;
   private boolean savedArr, savedLnch, savedRec, savedArm;
   private long t0, ticks;
   private int runId;
   private String rampTarget, rampWrite;
   private double rampSeconds;

   protected ProbeExtension(final ProbeExtensionDefinition def, final ControllerHost host)
   {
      super(def, host);
   }

   @Override
   public void init()
   {
      host = getHost();
      logFile = logFile();
      transport = host.createTransport();
      transport.isPlaying().markInterested();
      transport.playPosition().markInterested();
      transport.automationWriteMode().markInterested();
      transport.isArrangerAutomationWriteEnabled().markInterested();
      transport.isClipLauncherAutomationWriteEnabled().markInterested();
      transport.isArrangerRecordEnabled().markInterested();

      track = host.createCursorTrack("JWV_PROBE_TRACK", "Probe", 0, SCENES, true);
      track.name().markInterested();
      track.arm().markInterested();
      bank = host.createMainTrackBank(TRACKS, 0, 0);
      for (int i = 0; i < TRACKS; i++) { bank.getItemAt(i).name().markInterested(); bank.getItemAt(i).exists().markInterested(); }
      device = track.createCursorDevice();
      device.name().markInterested();
      device.exists().markInterested();
      device.isPlugin().markInterested();
      device.addDirectParameterIdObserver(ids -> { directIds = ids; });
      device.addDirectParameterNameObserver(40, (id, name) -> directNames.put(id, name));
      device.addDirectParameterNormalizedValueObserver((id, v) -> directValues.put(id, v));
      final SpecificPluginDevice bbc = device.createSpecificVst3Device(BBCSO_VST3);
      dynamics = bbc.createParameter(20);
      expression = bbc.createParameter(10);
      // probe-targets.txt (next to the log): one "name vst3PluginId paramId" per line, e.g. "ps.expression ABCDEF01… 49"
      final File targets = new File(logFile.getParentFile(), "probe-targets.txt");
      if (targets.isFile())
      {
         try
         {
            for (final String l : java.nio.file.Files.readAllLines(targets.toPath()))
            {
               final String[] p = l.trim().split("\s+");
               if (p.length == 3 && !p[0].startsWith("#")) extra.put(p[0], device.createSpecificVst3Device(p[1]).createParameter(Integer.parseInt(p[2])));
            }
         }
         catch (final Exception e) { host.println("targets: " + e); }
      }
      final CursorRemoteControlsPage page = device.createCursorRemoteControlsPage(8);
      remote1 = page.getParameter(0);
      final List<Parameter> all = new ArrayList<>(List.of(dynamics, expression, remote1));
      all.addAll(extra.values());
      for (final Parameter p : all)
      {
         p.name().markInterested();
         p.exists().markInterested();
         p.value().markInterested();
         p.hasAutomation().markInterested();
      }
      slots = track.clipLauncherSlotBank();
      for (int i = 0; i < SCENES; i++) { slots.getItemAt(i).hasContent().markInterested(); slots.getItemAt(i).isPlaying().markInterested(); }

      arrClip = host.createArrangerCursorClip(GRID_W, GRID_H);
      lnchClip = track.createLauncherCursorClip("JWV_PROBE_CLIP", "Probe", GRID_W, GRID_H);
      arrClip.exists().markInterested();
      lnchClip.exists().markInterested();
      watchNotes(arrClip, selArr, allArr);
      watchNotes(lnchClip, selLnch, allLnch);

      final Preferences prefs = host.getPreferences();
      target = prefs.getEnumSetting("Ramp target", CAT,
         new String[] { "BBC SO Dynamics (param 20)", "BBC SO Expression (param 10)", "Remote control 1 of selected device" },
         "BBC SO Dynamics (param 20)");
      writeMode = prefs.getEnumSetting("Write mode", CAT,
         new String[] { "Arranger automation write", "Launcher automation write", "Preview (no write)" }, "Arranger automation write");
      seconds = prefs.getNumberSetting("Ramp length", CAT, 1, 20, 0.5, "s", 4);
      target.markInterested(); writeMode.markInterested(); seconds.markInterested();
      prefs.getSignalSetting("Run", CAT, "Run hairpin ramp").addSignalObserver(() -> {
         final String t = target.get(), w = writeMode.get();
         startRamp(t.startsWith("BBC SO Dynamics") ? "dynamics" : t.startsWith("BBC SO Expression") ? "expression" : "remote1",
            w.startsWith("Arranger") ? "arranger" : w.startsWith("Launcher") ? "launcher" : "preview", seconds.getRaw(), -1);
      });
      prefs.getSignalSetting("Stop", CAT, "Stop ramp + restore write state").addSignalObserver(() -> finish("stopped by user"));

      startServer();
      host.scheduleTask(this::poll, 50);
      log("Score View Probe ready on http://127.0.0.1:" + PORT + " · log: " + logFile.getPath());
   }

   @Override
   public void exit()
   {
      if (running || saved) restoreWriteState();
      if (server != null) server.stop(0);
   }

   @Override
   public void flush()
   {
   }

   // ------------------------------------------------------------------ control-thread loop

   private int pollCount;

   private void poll()
   {
      String c;
      while ((c = commands.poll()) != null)
      {
         try { run(c.trim()); }
         catch (final Exception e) { log("command failed: " + c + " → " + e); }
      }
      if (pollCount++ % 5 == 0) status = buildStatus();
      host.scheduleTask(this::poll, 40);
   }

   private static Map<String, String> args(final String[] parts)
   {
      final Map<String, String> m = new HashMap<>();
      for (int i = 1; i < parts.length; i++)
      {
         final int eq = parts[i].indexOf('=');
         if (eq > 0) m.put(parts[i].substring(0, eq), parts[i].substring(eq + 1).replace("%20", " ").replace('+', ' '));
      }
      return m;
   }

   private void run(final String line)
   {
      if (line.isEmpty()) return;
      final String[] parts = line.split("\\s+");
      final Map<String, String> a = args(parts);
      final double secs = Double.parseDouble(a.getOrDefault("seconds", "4"));
      switch (parts[0])
      {
         case "select" -> select(a.getOrDefault("track", ""), Integer.parseInt(a.getOrDefault("device", "1")));
         case "run" -> startRamp(a.getOrDefault("target", "dynamics"), a.getOrDefault("write", "arranger"), secs,
            Double.parseDouble(a.getOrDefault("from", "-1")));
         case "stop" -> finish("stop command");
         case "mkclip" -> mkclip(Integer.parseInt(a.getOrDefault("slot", "1")) - 1, Double.parseDouble(a.getOrDefault("beats", "8")),
            Integer.parseInt(a.getOrDefault("key", "60")));
         case "launch" -> { slots.launch(Integer.parseInt(a.getOrDefault("slot", "1")) - 1); log("launch slot " + a.get("slot")); }
         case "insert" -> insertMid(Integer.parseInt(a.getOrDefault("slot", "1")) - 1,
            a.getOrDefault("file", new File(logFile.getParentFile(), "probe-cc.mid").getPath()));
         case "pressure" -> pressure(Double.parseDouble(a.getOrDefault("v", "0.5")), "1".equals(a.get("all")));
         case "sendmidi" -> sendMidiRamp(Integer.parseInt(a.getOrDefault("cc", "1")), secs, "1".equals(a.get("record")));
         case "direct" -> {
            final String id = a.get("id");
            final double v = Double.parseDouble(a.getOrDefault("v", "0.5")), res = Double.parseDouble(a.getOrDefault("res", "1"));
            device.setDirectParameterValueNormalized(id, v, res);
            log("direct set " + id + " value=" + v + " res=" + res);
            host.scheduleTask(() -> log("  direct read " + id + " = " + fmt(directValues.getOrDefault(id, -1.0))), 300);
         }
         case "set" -> { param(a.get("target")).set(Double.parseDouble(a.getOrDefault("v", "0.5"))); log("set " + a.get("target") + " = " + a.get("v"));
            host.scheduleTask(() -> log("  read " + a.get("target") + " = " + fmt(param(a.get("target")).value().get()) + " exists " + param(a.get("target")).exists().get()), 300); }
         default -> log("unknown command: " + line);
      }
   }

   // ------------------------------------------------------------------ select

   private void select(final String name, final int deviceNo)
   {
      for (int i = 0; i < TRACKS; i++)
      {
         final Track t = bank.getItemAt(i);
         if (t.exists().get() && t.name().get().equalsIgnoreCase(name))
         {
            track.selectChannel(t);
            t.selectInMixer();
            t.makeVisibleInArranger();
            host.scheduleTask(() -> {
               device.selectFirstInChannel(track);
               for (int k = 1; k < deviceNo; k++) device.selectNext();
               host.scheduleTask(() -> log("selected track '" + track.name().get() + "', device '" + device.name().get() + "' (plugin "
                  + device.isPlugin().get() + ", " + directIds.length + " direct params)"), 400);
            }, 200);
            return;
         }
      }
      log("select: no track named '" + name + "'");
   }

   // ------------------------------------------------------------------ P1–P4 ramp

   private boolean targetExists(final String t)
   {
      if (t.startsWith("direct:")) return directNames.containsKey(t.substring(7)) || List.of(directIds).contains(t.substring(7));
      return param(t).exists().get();
   }

   private Parameter param(final String t)
   {
      if (extra.containsKey(t)) return extra.get(t);
      return "expression".equals(t) ? expression : "remote1".equals(t) ? remote1 : dynamics;
   }

   private String targetName(final String t)
   {
      return t.startsWith("direct:") ? "direct '" + directNames.getOrDefault(t.substring(7), t.substring(7)) + "'" : "'" + param(t).name().get() + "'";
   }

   private void setTarget(final String t, final double v)
   {
      if (t.startsWith("direct:")) device.setDirectParameterValueNormalized(t.substring(7), v, 1.0);
      else param(t).set(v);
   }

   private void touchTarget(final String t, final boolean on)
   {
      if (!t.startsWith("direct:")) param(t).touch(on);
   }

   private String automationOf(final String t)
   {
      return t.startsWith("direct:") ? "n/a (direct)" : String.valueOf(param(t).hasAutomation().get());
   }

   private double valueOf(final String t)
   {
      return t.startsWith("direct:") ? directValues.getOrDefault(t.substring(7), -1.0) : param(t).value().get();
   }

   private void startRamp(final String t, final String write, final double secs, final double from)
   {
      if (running) { log("A ramp is already running"); return; }
      if (!targetExists(t))
      {
         log("Target " + t + " not found on device '" + device.name().get() + "' (track '" + track.name().get() + "')");
         return;
      }
      saveWriteState();
      final boolean arr = "arranger".equals(write), lnch = "launcher".equals(write);
      transport.isArrangerAutomationWriteEnabled().set(arr);
      transport.isClipLauncherAutomationWriteEnabled().set(lnch);
      if (arr || lnch) transport.automationWriteMode().set("touch");
      if (lnch && !transport.isPlaying().get())
      {
         log("Launcher write: launch a clip first (launch slot=<n>), then run again");
         restoreWriteState();
         return;
      }
      if (from >= 0 && !transport.isPlaying().get()) transport.setPosition(from);
      startedTransport = !transport.isPlaying().get();
      if (startedTransport) transport.play();
      running = true;
      rampTarget = t; rampWrite = write; rampSeconds = secs;
      final int id = ++runId;
      log("RAMP start: write=" + write + " · target " + targetName(t) + " on '" + device.name().get() + "' / track '" + track.name().get()
         + "' · hasAutomation before=" + automationOf(t) + " · value before=" + fmt(valueOf(t)) + " · " + secs + " s");
      host.scheduleTask(() -> {
         if (!running || id != runId) return;
         touchTarget(t, true);
         t0 = System.nanoTime();
         ticks = 0;
         log("  touch(true) at play position " + fmt(transport.playPosition().get()) + " beats");
         tick(id);
      }, 400);
   }

   // Hairpin: 0.1 → 0.9 → 0.1 over the ramp length (crescendo then diminuendo).
   private void tick(final int id)
   {
      if (!running || id != runId) return;
      final double t = (System.nanoTime() - t0) / 1e9 / rampSeconds;
      if (t >= 1)
      {
         setTarget(rampTarget, 0.1);
         touchTarget(rampTarget, false);
         log("  touch(false) at play position " + fmt(transport.playPosition().get()) + " beats · " + ticks + " values sent ("
            + Math.round(ticks / rampSeconds) + "/s)");
         host.scheduleTask(() -> finish("ramp done"), 300);
         return;
      }
      final double v = 0.1 + 0.8 * (t < 0.5 ? t * 2 : (1 - t) * 2);
      setTarget(rampTarget, v);
      if (ticks < 2 || ticks % 100 == 0) log("  t=" + fmt(t * rampSeconds) + "s set=" + fmt(v) + " read=" + fmt(valueOf(rampTarget)) + " pos=" + fmt(transport.playPosition().get()));
      ticks++;
      host.scheduleTask(() -> tick(id), TICK_MS);
   }

   private void finish(final String why)
   {
      final boolean was = running || recording;
      running = false;
      recording = false;
      runId++;
      if (startedTransport) { transport.stop(); startedTransport = false; }
      restoreWriteState();
      if (!was) { log("Stop: nothing running (" + why + ")"); return; }
      final String t = rampTarget;
      host.scheduleTask(() -> log("END (" + why + "): " + (t != null ? "hasAutomation after=" + automationOf(t) + " · value now=" + fmt(valueOf(t)) : "")
         + " · arranger clip exists=" + arrClip.exists().get()), 700);
   }

   private void saveWriteState()
   {
      if (saved) return;
      savedMode = transport.automationWriteMode().get();
      savedArr = transport.isArrangerAutomationWriteEnabled().get();
      savedLnch = transport.isClipLauncherAutomationWriteEnabled().get();
      savedRec = transport.isArrangerRecordEnabled().get();
      savedArm = track.arm().get();
      saved = true;
   }

   private void restoreWriteState()
   {
      if (!saved) return;
      transport.isArrangerAutomationWriteEnabled().set(savedArr);
      transport.isClipLauncherAutomationWriteEnabled().set(savedLnch);
      transport.isArrangerRecordEnabled().set(savedRec);
      track.arm().set(savedArm);
      if (savedMode != null && !savedMode.isEmpty()) transport.automationWriteMode().set(savedMode);
      saved = false;
      log("  write state restored (arranger " + savedArr + ", launcher " + savedLnch + ", mode " + savedMode + ", record " + savedRec + ")");
   }

   // ------------------------------------------------------------------ clips, P5, P6

   private void mkclip(final int slot, final double beats, final int key)
   {
      slots.createEmptyClip(slot, (int) Math.round(beats));
      host.scheduleTask(() -> {
         slots.select(slot);
         slots.showInEditor(slot);
         host.scheduleTask(() -> {
            lnchClip.setStep(0, 0, key, 100, beats);
            log("mkclip slot " + (slot + 1) + ": " + beats + " beats, one note " + key + " (launcher clip exists=" + lnchClip.exists().get() + ")");
         }, 400);
      }, 300);
   }

   private void insertMid(final int i, final String path)
   {
      final File f = new File(path);
      if (!f.isFile()) { log("MIDI file not found: " + f.getPath()); return; }
      final boolean had = slots.getItemAt(i).hasContent().get();
      slots.getItemAt(i).replaceInsertionPoint().insertFile(f.getPath());
      log("P5: insertFile into slot " + (i + 1) + " of track '" + track.name().get() + "' (had content before: " + had + ")");
      host.scheduleTask(() -> {
         slots.select(i);
         slots.showInEditor(i);
         log("  slot " + (i + 1) + " has content now: " + slots.getItemAt(i).hasContent().get() + " · launcher clip notes " + allLnch.size());
      }, 1500);
   }

   private void watchNotes(final Clip clip, final Map<String, NoteStep> sel, final Map<String, NoteStep> all)
   {
      clip.setStepSize(1.0 / 24);
      clip.scrollToKey(0);
      clip.scrollToStep(0);
      clip.addNoteStepObserver(step -> {
         final String k = step.channel() + "_" + step.x() + "_" + step.y();
         if (step.state() == NoteStep.State.NoteOn) all.put(k, step); else all.remove(k);
         if (step.state() == NoteStep.State.NoteOn && step.isIsSelected()) sel.put(k, step); else sel.remove(k);
      });
   }

   private void pressure(final double v, final boolean all)
   {
      final boolean useArr = all ? !allArr.isEmpty() && allLnch.isEmpty() : !selArr.isEmpty();
      final Map<String, NoteStep> notes = all ? (useArr ? allArr : allLnch) : (useArr ? selArr : selLnch);
      final Clip clip = useArr ? arrClip : lnchClip;
      if (notes.isEmpty()) { log("P6: no " + (all ? "" : "selected ") + "notes in the cursor clip"); return; }
      final List<NoteStep> list = new ArrayList<>(notes.values());
      for (final NoteStep s : list) clip.getStep(s.channel(), s.x(), s.y()).setPressure(v);
      log("P6: pressure " + v + " on " + list.size() + " note(s) in the " + (useArr ? "arranger" : "launcher") + " clip");
      host.scheduleTask(() -> {
         final StringBuilder b = new StringBuilder("  read back:");
         list.stream().limit(6).forEach(s -> b.append(" key ").append(s.y()).append("→").append(fmt(clip.getStep(s.channel(), s.x(), s.y()).pressure())));
         log(b.toString());
      }, 400);
   }

   // ------------------------------------------------------------------ P7 Track.sendMidi

   private void sendMidiRamp(final int cc, final double len, final boolean record)
   {
      if (record)
      {
         saveWriteState();
         track.arm().set(true);
         transport.isArrangerRecordEnabled().set(true);
         recording = true;
         startedTransport = !transport.isPlaying().get();
         if (startedTransport) transport.play();
      }
      log("P7: Track.sendMidi CC" + cc + " hairpin on track '" + track.name().get() + "' for " + len + " s" + (record ? " with arranger RECORD" : ""));
      final long start = System.nanoTime() + 400_000_000L;
      host.scheduleTask(() -> sendMidiTick(cc, start, len, record), 400);
   }

   private void sendMidiTick(final int cc, final long start, final double len, final boolean record)
   {
      final double t = (System.nanoTime() - start) / 1e9 / len;
      if (t >= 1)
      {
         track.sendMidi(0xB0, cc, 13);
         log("  P7 done");
         if (record) host.scheduleTask(() -> finish("record pass done"), 300);
         return;
      }
      final int v = (int) Math.round(127 * (0.1 + 0.8 * (t < 0.5 ? t * 2 : (1 - t) * 2)));
      track.sendMidi(0xB0, cc, v);
      host.scheduleTask(() -> sendMidiTick(cc, start, len, record), TICK_MS);
   }

   // ------------------------------------------------------------------ status, HTTP, log

   private String buildStatus()
   {
      final StringBuilder b = new StringBuilder("{");
      b.append("\"track\":").append(q(track.name().get())).append(",\"device\":").append(q(device.name().get()))
         .append(",\"plugin\":").append(device.isPlugin().get())
         .append(",\"playing\":").append(transport.isPlaying().get()).append(",\"pos\":").append(fmt(transport.playPosition().get()))
         .append(",\"write\":{\"arranger\":").append(transport.isArrangerAutomationWriteEnabled().get())
         .append(",\"launcher\":").append(transport.isClipLauncherAutomationWriteEnabled().get())
         .append(",\"mode\":").append(q(transport.automationWriteMode().get())).append(",\"record\":").append(transport.isArrangerRecordEnabled().get()).append("}")
         .append(",\"params\":{");
      final List<String> keyList = new ArrayList<>(List.of("dynamics", "expression", "remote1"));
      keyList.addAll(extra.keySet());
      final String[] keys = keyList.toArray(new String[0]);
      for (int i = 0; i < keys.length; i++)
      {
         final Parameter p = param(keys[i]);
         if (i > 0) b.append(',');
         b.append(q(keys[i])).append(":{\"name\":").append(q(p.name().get())).append(",\"exists\":").append(p.exists().get())
            .append(",\"value\":").append(fmt(p.value().get())).append(",\"automation\":").append(p.hasAutomation().get()).append('}');
      }
      b.append("},\"slots\":[");
      for (int i = 0; i < SCENES; i++) b.append(i > 0 ? "," : "").append(slots.getItemAt(i).hasContent().get());
      b.append("],\"clips\":{\"arranger\":").append(arrClip.exists().get()).append(",\"launcher\":").append(lnchClip.exists().get())
         .append(",\"arrNotes\":").append(allArr.size()).append(",\"lnchNotes\":").append(allLnch.size()).append("}");
      b.append(",\"tracks\":[");
      boolean first = true;
      for (int i = 0; i < TRACKS; i++) if (bank.getItemAt(i).exists().get()) { b.append(first ? "" : ",").append(q(bank.getItemAt(i).name().get())); first = false; }
      b.append("],\"direct\":[");
      final String[] ids = directIds;
      for (int i = 0; i < ids.length && i < 400; i++)
         b.append(i > 0 ? "," : "").append("{\"id\":").append(q(ids[i])).append(",\"name\":").append(q(directNames.getOrDefault(ids[i], "")))
            .append(",\"v\":").append(fmt(directValues.getOrDefault(ids[i], -1.0))).append('}');
      b.append("],\"log\":[");
      synchronized (logTail) { first = true; for (final String l : logTail) { b.append(first ? "" : ",").append(q(l)); first = false; } }
      return b.append("]}").toString();
   }

   private static String q(final String s)
   {
      final StringBuilder b = new StringBuilder("\"");
      for (final char c : (s == null ? "" : s).toCharArray())
      {
         if (c == '"' || c == '\\') b.append('\\').append(c);
         else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
         else b.append(c);
      }
      return b.append('"').toString();
   }

   private void startServer()
   {
      try
      {
         server = HttpServer.create(new InetSocketAddress("127.0.0.1", PORT), 0);
         server.setExecutor(Executors.newFixedThreadPool(2, r -> { final Thread t = new Thread(r, "probe-http"); t.setDaemon(true); return t; }));
         server.createContext("/", this::handle);
         server.start();
      }
      catch (final IOException e)
      {
         host.showPopupNotification("Score View Probe: port " + PORT + " busy (" + e.getMessage() + ")");
      }
   }

   // Local scripts only: Host must be loopback, POST needs X-Probe: 1 and no foreign Origin.
   private void handle(final HttpExchange ex) throws IOException
   {
      final String h = String.valueOf(ex.getRequestHeaders().getFirst("Host")).toLowerCase();
      final String origin = ex.getRequestHeaders().getFirst("Origin");
      final String method = ex.getRequestMethod(), path = ex.getRequestURI().getPath();
      if (!(h.equals("127.0.0.1:" + PORT) || h.equals("localhost:" + PORT))) { send(ex, 403, "bad host"); return; }
      if ("GET".equals(method) && "/status".equals(path)) { send(ex, 200, status); return; }
      if ("POST".equals(method) && "/cmd".equals(path))
      {
         if (!"1".equals(ex.getRequestHeaders().getFirst("X-Probe")) || origin != null) { send(ex, 403, "forbidden"); return; }
         try (InputStream in = ex.getRequestBody())
         {
            for (final String l : new String(in.readAllBytes(), StandardCharsets.UTF_8).split("\n")) if (!l.isBlank()) commands.add(l);
         }
         send(ex, 200, "ok");
         return;
      }
      send(ex, 404, "not found");
   }

   private static void send(final HttpExchange ex, final int code, final String body) throws IOException
   {
      final byte[] b = body.getBytes(StandardCharsets.UTF_8);
      ex.getResponseHeaders().set("Content-Type", body.startsWith("{") ? "application/json" : "text/plain");
      ex.sendResponseHeaders(code, b.length);
      try (OutputStream o = ex.getResponseBody()) { o.write(b); }
   }

   private File logFile()
   {
      final String home = System.getProperty("user.home");
      File base = new File(home, "OneDrive/Documents/Bitwig Studio");
      if (!base.isDirectory()) base = new File(home, "Documents/Bitwig Studio");
      final File dir = new File(base, "Score View Probe");
      dir.mkdirs();
      return new File(dir, "probe-log.txt");
   }

   private void log(final String msg)
   {
      final String line = LocalTime.now().format(TIME) + "  " + msg;
      host.println(line);
      synchronized (logTail) { logTail.addLast(line); while (logTail.size() > 40) logTail.removeFirst(); }
      try (FileWriter w = new FileWriter(logFile, true)) { w.write(line + System.lineSeparator()); }
      catch (final IOException e) { host.println("log write failed: " + e); }
   }

   private static String fmt(final double v)
   {
      return String.format(java.util.Locale.ROOT, "%.3f", v);
   }
}
