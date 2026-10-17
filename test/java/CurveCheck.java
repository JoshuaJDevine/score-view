package claude.scoreview;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.function.Function;

import com.bitwig.extension.controller.api.BeatTimeValue;
import com.bitwig.extension.controller.api.SettableBeatTimeValue;
import com.bitwig.extension.controller.api.SettableBooleanValue;
import com.bitwig.extension.controller.api.SettableEnumValue;
import com.bitwig.extension.controller.api.Transport;

/**
 * Test helper (test/curve-player-test.mjs): runs the real {@link CurvePlayer} against a fake transport and pool rig on
 * a virtual clock (120 bpm = 2 beats/s). Checks the profile table and JSON reader, curve points, Render (write
 * settings switched to arranger + touch and restored, touch on at fromBeat and off at toBeat, values follow the
 * curve), Preview (no touch, no write change), Stop, a stop in Bitwig, the arranger loop, missing controls and the
 * refusals. Prints "name ok" / "name FAIL ..." per check, then "done".
 *   java -cp … claude.scoreview.CurveCheck web/features/library-profiles.json
 */
public final class CurveCheck
{
   // ------------------------------------------------------------------ virtual time

   static long now;
   private record Task(long due, long seq, Runnable r) {}
   static final PriorityQueue<Task> tasks = new PriorityQueue<>((a, b) -> a.due != b.due ? Long.compare(a.due, b.due) : Long.compare(a.seq, b.seq));
   static long seq;

   static void schedule(final Runnable r, final long ms) { tasks.add(new Task(now + ms, seq++, r)); }

   static void runFor(final long ms)
   {
      final long end = now + ms;
      while (!tasks.isEmpty() && tasks.peek().due <= end)
      {
         final Task t = tasks.poll();
         now = t.due;
         t.r.run();
      }
      now = end;
   }

   // ------------------------------------------------------------------ fake transport

   static final class FakeTransport
   {
      boolean playing, arrWrite, lnchWrite, loop;
      String mode = "latch";
      double pos, playStart = 10, anchorPos, loopStart = 0, loopEnd = 0;
      long anchorT, playAt = -1;
      int plays, stops;

      long staleMs, staleUntil = -1; // staleMs > 0: after play() the old position is reported for that long
      double stalePos;

      double position()
      {
         if (playing && now < staleUntil) return stalePos;
         if (!playing) return pos;
         double p = anchorPos + (now - anchorT) / 1000.0 * 2;
         if (loop && p >= loopEnd) p = loopStart + (p - loopStart) % (loopEnd - loopStart);
         return p;
      }

      boolean isPlaying() { if (playAt >= 0 && now >= playAt) { playing = true; anchorT = playAt; anchorPos = pos; playAt = -1; } return playing; }

      Transport proxy()
      {
         final Map<String, Function<Object[], Object>> m = new HashMap<>();
         m.put("isPlaying", a -> fake(SettableBooleanValue.class, Map.of("get", x -> isPlaying())));
         m.put("playPosition", a -> fake(BeatTimeValue.class, Map.of("get", x -> position())));
         m.put("automationWriteMode", a -> fake(SettableEnumValue.class, Map.of("get", x -> mode, "set", x -> { mode = (String) x[0]; return null; })));
         m.put("isArrangerAutomationWriteEnabled", a -> fake(SettableBooleanValue.class, Map.of("get", x -> arrWrite, "set", x -> { arrWrite = (Boolean) x[0]; return null; })));
         m.put("isClipLauncherAutomationWriteEnabled", a -> fake(SettableBooleanValue.class, Map.of("get", x -> lnchWrite, "set", x -> { lnchWrite = (Boolean) x[0]; return null; })));
         m.put("playStartPosition", a -> fake(SettableBeatTimeValue.class, Map.of("get", x -> playStart, "set", x -> { playStart = ((Number) x[0]).doubleValue(); return null; })));
         m.put("setPosition", a -> { if (staleMs > 0) { stalePos = pos; staleUntil = now + 60 + staleMs; } pos = ((Number) a[0]).doubleValue(); if (playing) { anchorPos = pos; anchorT = now; } return null; });
         m.put("play", a -> { plays++; if (!playing) playAt = now + 60; return null; });
         m.put("stop", a -> { stops++; pos = position(); playing = false; playAt = -1; return null; });
         return fake(Transport.class, m);
      }
   }

   @SuppressWarnings("unchecked")
   static <T> T fake(final Class<T> c, final Map<String, Function<Object[], Object>> impl)
   {
      return (T) Proxy.newProxyInstance(c.getClassLoader(), new Class<?>[] { c }, (p, m, args) -> {
         final Function<Object[], Object> f = impl.get(m.getName());
         if (f != null) return f.apply(args == null ? new Object[0] : args);
         switch (m.getName())
         {
            case "toString": return c.getSimpleName();
            case "hashCode": return System.identityHashCode(p);
            case "equals": return p == args[0];
            default: break;
         }
         final Class<?> r = m.getReturnType();
         if (r == boolean.class) return false;
         if (r == int.class) return 0;
         if (r == double.class) return 0.0;
         return null;
      });
   }

   // ------------------------------------------------------------------ fake rig

   static final class FakeControl implements CurvePlayer.Control
   {
      final String name;
      final FakeTransport tr;
      final List<double[]> sets = new ArrayList<>(); // [pos, value]
      final List<String> touches = new ArrayList<>(); // "on@pos" / "off@pos"
      boolean touching;

      FakeControl(final String name, final FakeTransport tr) { this.name = name; this.tr = tr; }
      @Override public boolean exists() { return true; }
      @Override public void touch(final boolean on) { touching = on; touches.add((on ? "on@" : "off@") + CurvePlayer.fmt(tr.position())); }
      @Override public void set(final double v) { sets.add(new double[] { tr.position(), v, touching ? 1 : 0, tr.arrWrite ? 1 : 0 }); }
      @Override public double value() { return sets.isEmpty() ? 0 : sets.get(sets.size() - 1)[1]; }
   }

   static final class FakeRig implements CurvePlayer.Rig
   {
      final Map<String, List<String>> devices = new HashMap<>(); // track -> device names (Pocket Strings has Timbre/Expression)
      final String[] at = new String[CurvePlayer.POOL];
      final Map<String, FakeControl> controls = new HashMap<>();
      final FakeTransport tr;

      FakeRig(final FakeTransport tr) { this.tr = tr; }
      @Override public int slots() { return CurvePlayer.POOL; }
      @Override public boolean point(final int slot, final String track)
      {
         if (!devices.containsKey(track)) return false;
         at[slot] = "";
         schedule(() -> at[slot] = track, 150); // Bitwig takes a moment to move a cursor track
         return true;
      }
      @Override public String slotTrack(final int slot) { return at[slot] == null ? "" : at[slot]; }
      @Override public List<String> slotDevices(final int slot) { return devices.getOrDefault(slotTrack(slot), List.of()); }
      @Override public CurvePlayer.Control control(final int slot, final CurvePlayer.Target t)
      {
         final String track = slotTrack(slot);
         final boolean has = devices.getOrDefault(track, List.of()).stream().anyMatch(d -> d.toLowerCase().contains(t.profile().split("-")[0]));
         return has ? controls.computeIfAbsent(track + "/" + t.id(), k -> new FakeControl(k, tr)) : null;
      }
      @Override public String devicesJson() { return "{}"; }
   }

   // ------------------------------------------------------------------ checks

   static int fails;
   static void check(final String name, final boolean ok, final String detail)
   {
      System.out.println(name + (ok ? " ok" : " FAIL " + detail));
      if (!ok) fails++;
   }

   static CurvePlayer player(final FakeTransport tr, final FakeRig rig, final Map<String, CurvePlayer.Profile> profiles, final List<String> log)
   {
      return new CurvePlayer(tr.proxy(), rig, profiles, CurveCheck::schedule, log::add, () -> false).clock(() -> now);
   }

   static String[] op(final String line) { return line.split("\\s+"); }

   public static void main(final String[] args) throws Exception
   {
      // profile table + JSON reader
      final Map<String, CurvePlayer.Profile> profiles = CurvePlayer.parseProfiles(Files.readString(Path.of(args[0])));
      final CurvePlayer.Profile ps = profiles.get("pocket-strings");
      check("profiles", profiles.keySet().equals(java.util.Set.of("pocket-strings", "bbcso", "spitfire-cc", "pigments", "velocity")), "" + profiles.keySet());
      check("pocket strings targets", ps.targets().size() == 2 && ps.targets().get(0).param() == 48 && ps.targets().get(1).param() == 49
         && ps.targets().get(0).plugin().equals("ABCDEF019182FAEB5443484344443032"), "" + ps.targets());
      check("bbcso / cc / remote", profiles.get("bbcso").targets().get(0).param() == 20 && profiles.get("spitfire-cc").targets().get(1).cc() == 11
         && profiles.get("pigments").targets().get(0).kind().equals("remote") && profiles.get("pigments").targets().get(0).index() == 0, "");
      final Object j = CurvePlayer.Json.parse("{\"a\": [1, -2.5e1, \"x\\\"y\\u00e9\", true, null, {}], \"b\": {\"c\": false}}");
      check("json", j.toString().equals("{a=[1.0, -25.0, x\"yé, true, null, {}], b={c=false}}"), j.toString());
      boolean threw = false;
      try { CurvePlayer.Json.parse("{\"a\": 1,}"); } catch (final IllegalArgumentException e) { threw = true; }
      check("json rejects junk", threw, "");

      // points
      final double[][] pts = CurvePlayer.parsePoints("0:0.2,4:0.6,8:1.4");
      final CurvePlayer.Curve c = new CurvePlayer.Curve("c", "T", "pocket-strings", "timbre", pts[0], pts[1]);
      check("points", c.valueAt(-1) == 0.2 && Math.abs(c.valueAt(2) - 0.4) < 1e-9 && c.valueAt(8) == 1 && c.valueAt(99) == 1, "");
      threw = false;
      try { CurvePlayer.parsePoints("4:0.1,2:0.3"); } catch (final IllegalArgumentException e) { threw = true; }
      check("points must increase", threw, "");

      // ---- Render
      final FakeTransport tr = new FakeTransport();
      final FakeRig rig = new FakeRig(tr);
      rig.devices.put("Pocket Strings", List.of("Articulation Map", "Pocket Strings"));
      rig.devices.put("Flute", List.of("Kontakt 7"));
      final List<String> log = new ArrayList<>();
      final CurvePlayer p = player(tr, rig, profiles, log);
      p.apply(op("curveClear"));
      p.apply(op("curveSet c1 Pocket%20Strings pocket-strings timbre 0:0.1,4:0.3,8:0.9,12:0.9"));
      p.apply(op("curveSet c2 Pocket%20Strings pocket-strings expression 0:0.5,8:1,12:1"));
      p.apply(op("curveRender 4 8"));
      check("render prepares", p.state() == CurvePlayer.State.PREPARING, p.statusJson());
      runFor(400);
      check("render running", p.state() == CurvePlayer.State.RUNNING && tr.arrWrite && "touch".equals(tr.mode) && !tr.lnchWrite, p.statusJson() + " mode " + tr.mode);
      check("preroll from beat 3", Math.abs(tr.playStart - 3) < 1e-9 && tr.plays == 1, "playStart " + tr.playStart);
      runFor(3500);
      final FakeControl timbre = rig.controls.get("Pocket Strings/timbre"), expr = rig.controls.get("Pocket Strings/expression");
      check("render done", p.state() == CurvePlayer.State.DONE, p.statusJson());
      check("touch on at from, off at to", timbre.touches.size() == 2 && timbre.touches.get(0).startsWith("on@") && timbre.touches.get(1).startsWith("off@")
         && Math.abs(Double.parseDouble(timbre.touches.get(0).substring(3)) - 4) < 0.05 && Double.parseDouble(timbre.touches.get(1).substring(4)) >= 8 - 1e-6, timbre.touches.toString());
      final boolean allTouched = timbre.sets.stream().allMatch(s -> s[2] == 1 && s[3] == 1 && s[0] >= 4 - 0.03 && s[0] <= 8.05);
      check("values only while touched, inside the range", allTouched && timbre.sets.size() > 20, timbre.sets.size() + " sets");
      final boolean follows = timbre.sets.stream().allMatch(s -> Math.abs(s[1] - c(0.3 + (Math.min(8, s[0] + CurvePlayer.LOOKAHEAD) - 4) / 4 * 0.6)) < 0.02);
      check("values follow the curve (+ lookahead)", follows, "");
      check("last value is the curve at to", Math.abs(timbre.value() - 0.9) < 1e-9 && Math.abs(expr.value() - 1) < 1e-9, timbre.value() + " / " + expr.value());
      check("restored", !tr.arrWrite && "latch".equals(tr.mode) && !tr.playing && tr.stops == 1 && Math.abs(tr.playStart - 10) < 1e-9, "arr " + tr.arrWrite + " mode " + tr.mode + " playStart " + tr.playStart);
      check("status", p.statusJson().contains("\"state\":\"done\"") && p.statusJson().contains("\"progress\":1") && p.statusJson().contains("\"restored\":true"), p.statusJson());

      // ---- Preview: no touch, and write switched off while it plays (the user's write was on), then restored
      timbre.touches.clear(); timbre.sets.clear();
      tr.arrWrite = true; tr.lnchWrite = true; tr.mode = "write";
      final String runBefore = p.statusJson().replaceAll(".*\"run\":(\\d+).*", "$1");
      p.apply(op("curvePreview 0 4"));
      check("run counter", !p.statusJson().replaceAll(".*\"run\":(\\d+).*", "$1").equals(runBefore), p.statusJson());
      runFor(400);
      check("preview: write off while playing", !tr.arrWrite && !tr.lnchWrite && "write".equals(tr.mode), "arr " + tr.arrWrite + " lnch " + tr.lnchWrite);
      runFor(2500);
      check("preview done", p.state() == CurvePlayer.State.DONE && timbre.touches.isEmpty() && !timbre.sets.isEmpty() && timbre.sets.stream().allMatch(s -> s[2] == 0 && s[3] == 0), p.statusJson());
      check("preview restores write", tr.arrWrite && tr.lnchWrite && "write".equals(tr.mode), "arr " + tr.arrWrite + " lnch " + tr.lnchWrite + " mode " + tr.mode);
      tr.arrWrite = false; tr.lnchWrite = false; tr.mode = "latch";

      // ---- a stale playhead right after play() (the old position) is not taken for the range
      timbre.touches.clear(); timbre.sets.clear();
      tr.pos = 40; tr.staleMs = 80;
      p.apply(op("curveRender 4 8"));
      runFor(4000);
      tr.staleMs = 0;
      check("stale playhead ignored", p.state() == CurvePlayer.State.DONE && timbre.sets.stream().allMatch(s -> s[0] < 9) && timbre.sets.size() > 20, p.statusJson());

      // ---- Stop mid-run restores
      tr.arrWrite = true; tr.mode = "latch"; tr.lnchWrite = true;
      timbre.touches.clear();
      p.apply(op("curveRender 0 8"));
      runFor(1200);
      check("stop: running first", p.state() == CurvePlayer.State.RUNNING && "touch".equals(tr.mode) && !tr.lnchWrite, p.statusJson());
      p.apply(op("curveStop"));
      check("stop restores", p.state() == CurvePlayer.State.STOPPED && tr.arrWrite && tr.lnchWrite && "latch".equals(tr.mode) && !tr.playing
         && timbre.touches.get(timbre.touches.size() - 1).startsWith("off@"), "mode " + tr.mode + " " + timbre.touches);
      runFor(500);

      // ---- stopped in Bitwig
      tr.arrWrite = false;
      p.apply(op("curveRender 0 8"));
      runFor(1500);
      tr.pos = tr.position(); tr.playing = false; // the user pressed stop in Bitwig
      runFor(2000);
      check("stopped in Bitwig", p.state() == CurvePlayer.State.STOPPED && !tr.arrWrite && "latch".equals(tr.mode), p.statusJson());

      // ---- arranger loop wrapping inside the range
      tr.loop = true; tr.loopStart = 4; tr.loopEnd = 6;
      p.apply(op("curveRender 4 8"));
      runFor(4000);
      check("loop wrap ends the render", p.state() == CurvePlayer.State.ERROR && p.statusJson().contains("loop") && !tr.arrWrite, p.statusJson());
      tr.loop = false;

      // ---- refusals and missing controls
      tr.playing = true;
      p.apply(op("curveRender 0 4"));
      check("refused while playing", p.state() == CurvePlayer.State.ERROR && p.statusJson().contains("Stop playback first"), p.statusJson());
      tr.playing = false;
      final int playsBefore = tr.plays;
      p.apply(op("curveSet c3 Flute pocket-strings timbre 0:0.5,4:0.6"));
      p.apply(op("curveRender 0 4"));
      runFor(3500);
      check("missing control", p.state() == CurvePlayer.State.ERROR && p.statusJson().contains("Not found: Crow Hill Pocket Strings Timbre (VST3 param 48) on 'Flute' (devices: Kontakt 7)")
         && !tr.arrWrite && tr.plays == playsBefore, p.statusJson());
      p.apply(op("curveClear"));
      p.apply(op("curveSet c1 Nobody pocket-strings timbre 0:0.5"));
      p.apply(op("curveRender 0 4"));
      check("unknown track", p.statusJson().contains("No track named 'Nobody'"), p.statusJson());
      p.apply(op("curveSet c1 X nope timbre 0:0.5"));
      check("unknown profile", p.statusJson().contains("unknown library profile nope"), p.statusJson());
      final int playsBad = tr.plays;
      p.apply(op("curveRender 0 4"));
      runFor(1000);
      check("a failed curveSet refuses the run", p.state() == CurvePlayer.State.ERROR && p.statusJson().contains("unknown library profile nope") && tr.plays == playsBad, p.statusJson());
      p.apply(op("curveClear"));
      p.apply(op("curveRender 0 4"));
      check("no curves", p.statusJson().contains("No curves"), p.statusJson());
      p.apply(op("curveSet c1 Pocket%20Strings pocket-strings timbre 0:0.5,4:0.6"));
      p.apply(op("curveRender 4 4"));
      check("empty range", p.statusJson().contains("range is empty"), p.statusJson());
      p.exit();
      check("exit restores", !tr.arrWrite, "");

      System.out.println(fails == 0 ? "done" : "done with " + fails + " failures");
   }

   static double c(final double v) { return Math.max(0, Math.min(1, v)); }
}
