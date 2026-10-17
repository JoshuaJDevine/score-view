package claude.scoreview;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

import com.bitwig.extension.controller.api.Action;
import com.bitwig.extension.controller.api.Application;
import com.bitwig.extension.controller.api.BooleanValue;
import com.bitwig.extension.controller.api.Clip;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.SettableBeatTimeValue;
import com.bitwig.extension.controller.api.SettableBooleanValue;
import com.bitwig.extension.controller.api.SettableStringValue;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.Transport;

/**
 * Test helper (test/protocol-test.mjs): runs the real {@link ClipNavigator} against a fake Bitwig (API interfaces
 * proxied) whose arranger answers the lane/item selection actions like Bitwig does: selecting a clip moves the play
 * start marker to it. Ops are fed through accept() like ScoreViewExtension.drainEdits; "add" ops record the clip they
 * land in. Prints "name ok" or "name FAIL ..." per check, then "done". Runs in real time (~10 s: the navigator
 * waits for Bitwig to settle between actions).
 */
public final class NavigatorCheck
{
   // ------------------------------------------------------------------ fake arranger

   static final class Arr
   {
      final String[] laneTracks;
      final double[][] clips; // starts per lane
      int curLane, selLane, selIdx;
      double playStart;
      boolean playing;
      volatile long changed;
      int restores;

      Arr(final String[] laneTracks, final double[][] clips, final int homeLane, final int homeIdx)
      {
         this.laneTracks = laneTracks; this.clips = clips;
         selLane = homeLane; selIdx = homeIdx; playStart = clips[homeLane][homeIdx];
      }

      String track() { return laneTracks[selLane]; }
      double start() { return clips[selLane][selIdx]; }
      String sel() { return track() + "@" + fmt(start()); }

      void act(final String id)
      {
         switch (id)
         {
            case "Move cursor to first lane" -> curLane = 0;
            case "Move cursor to next lane" -> curLane = Math.min(curLane + 1, laneTracks.length - 1);
            case "Select first item" -> { if (clips[curLane].length > 0) select(curLane, 0); }
            case "Select next item" -> { if (selLane == curLane && selIdx + 1 < clips[curLane].length) select(curLane, selIdx + 1); }
            default -> throw new IllegalStateException("unexpected action " + id);
         }
         changed = System.currentTimeMillis();
      }

      private void select(final int lane, final int idx)
      {
         selLane = lane; selIdx = idx;
         playStart = clips[lane][idx]; // Bitwig moves the play start marker to the selected clip
      }
   }

   static String fmt(final double v) { return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v); }

   // ------------------------------------------------------------------ proxies

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
         if (r == long.class) return 0L;
         if (r == double.class) return 0.0;
         if (r == float.class) return 0f;
         return null;
      });
   }

   static SettableBooleanValue bool(final Supplier<Boolean> get)
   {
      return fake(SettableBooleanValue.class, Map.of("get", a -> get.get()));
   }

   static SettableBeatTimeValue beats(final Supplier<Double> get, final Consumer<Double> set)
   {
      return fake(SettableBeatTimeValue.class, Map.of("get", a -> get.get(), "set", a -> { set.accept(((Number) a[0]).doubleValue()); return null; }));
   }

   // ------------------------------------------------------------------ scheduler (real time)

   private record Task(long due, long seq, Runnable r) {}
   private static final PriorityQueue<Task> tasks = new PriorityQueue<>((a, b) -> a.due != b.due ? Long.compare(a.due, b.due) : Long.compare(a.seq, b.seq));
   private static long seq;

   static void runTasks(final long maxMs) throws InterruptedException
   {
      final long deadline = System.currentTimeMillis() + maxMs;
      while (!tasks.isEmpty() && System.currentTimeMillis() < deadline)
      {
         final Task t = tasks.poll();
         final long wait = t.due - System.currentTimeMillis();
         if (wait > 0) Thread.sleep(wait);
         t.r.run();
      }
   }

   // ------------------------------------------------------------------ one scenario

   static final class Rig
   {
      final Arr arr;
      final ClipNavigator nav;
      final List<String> landed = new ArrayList<>(); // "add" ops: the clip each one was written into
      final List<String> batchesAtAdd = new ArrayList<>(); // GET /api/nav batches when each "add" was applied
      boolean targetPlayStart;

      Rig()
      {
         // lane 1 is a group track without clips
         arr = new Arr(new String[] { "Piano", "Strings", "Violins 1", "Cellos" },
            new double[][] { { 0, 16 }, {}, { 0, 8 }, { 4 } }, 0, 0);
         final ControllerHost host = fake(ControllerHost.class, Map.of(
            "scheduleTask", a -> { if (a.length == 2) tasks.add(new Task(System.currentTimeMillis() + ((Number) a[1]).longValue(), seq++, (Runnable) a[0])); return null; },
            "println", a -> null, "errorln", a -> { System.err.println(a[0]); return null; }));
         final Application app = fake(Application.class, Map.of("getAction", a -> {
            final String id = (String) a[0];
            return fake(Action.class, Map.of("invoke", x -> { arr.act(id); return null; }, "getId", x -> id));
         }));
         final Transport transport = fake(Transport.class, Map.of(
            "isPlaying", a -> bool(() -> arr.playing),
            "playStartPosition", a -> beats(() -> arr.playStart, v -> arr.playStart = v)));
         final Clip clip = fake(Clip.class, Map.of(
            "exists", a -> fake(BooleanValue.class, Map.of("get", x -> true)),
            "getPlayStop", a -> beats(() -> 4.0, v -> { }),
            "getPlayStart", a -> beats(() -> 0.0, v -> { })));
         final Track track = fake(Track.class, Map.of("name", a -> fake(SettableStringValue.class, Map.of("get", x -> arr.track()))));
         nav = new ClipNavigator(host, app, transport, clip, track, () -> arr.changed, () -> arr.laneTracks.length,
            () -> false, () -> arr.restores++, () -> { }, () -> true, () -> false);
         nav.setStayPlayStartAtTarget(() -> targetPlayStart);
      }

      /** One POST body: ops applied like drainEdits (the queue waits while a navigation runs). */
      Rig post(final String... ops) throws InterruptedException
      {
         for (final String line : ops)
         {
            if (nav.running()) { runTasks(20000); }
            final String[] op = line.split("\\s+");
            if (!nav.accept(op)) continue;
            switch (op[0])
            {
               case "goto", "gotoStay" -> nav.gotoClip(op);
               case "gotoHome" -> nav.gotoHome(op);
               case "add" -> { landed.add(arr.sel()); batchesAtAdd.add(status().replaceAll(".*\"batches\":(\\d+).*", "$1")); }
               default -> throw new IllegalStateException(op[0]);
            }
         }
         runTasks(20000);
         nav.queueEmpty();
         return this;
      }

      String status() { return nav.statusJson(); }
   }

   // ------------------------------------------------------------------ checks

   private static int failures;

   static void expect(final String name, final Object got, final Object want)
   {
      if (String.valueOf(got).equals(String.valueOf(want))) System.out.println(name + " ok");
      else { failures++; System.out.println(name + " FAIL got " + got + " want " + want); }
   }

   static void contains(final String name, final String hay, final String needle)
   {
      if (hay.contains(needle)) System.out.println(name + " ok");
      else { failures++; System.out.println(name + " FAIL " + needle + " not in " + hay); }
   }

   public static void main(final String[] args) throws Exception
   {
      // 1. gotoStay: ends on the target, play start restored, groups closed, no return home.
      Rig r = new Rig().post("gotoStay 2 8 Violins%201", "add 0 0 60 100 1");
      expect("stay selection", r.arr.sel(), "Violins 1@8");
      expect("stay add landed", r.landed, List.of("Violins 1@8"));
      expect("stay session ended", r.nav.inSession(), false);
      expect("stay play start restored", r.arr.playStart, 0.0);
      expect("stay groups restored", r.arr.restores, 1);
      contains("stay status stayed", r.status(), "\"stayed\":{\"track\":\"Violins 1\",\"start\":8.0}");
      contains("stay status done", r.status(), "\"state\":\"done\"");
      contains("stay status batches", r.status(), "\"batches\":1");
      expect("stay batch counted after its edits", r.batchesAtAdd, List.of("0")); // the page must not see it done early
      contains("stay lastTarget", r.status(), "\"stay\":true");
      r.post("add 0 24 62 100 1"); // a later batch edits the clip it stayed on
      expect("stay later add", r.landed.get(1), "Violins 1@8");

      // 2. Preference "Move it to the pasted clip"; a wrong lane hint is found by scanning.
      r = new Rig();
      r.targetPlayStart = true;
      r.post("gotoStay 0 4 Cellos", "add 0 0 48 100 1");
      expect("pref selection", r.arr.sel(), "Cellos@4");
      expect("pref play start at clip", r.arr.playStart, 4.0);
      expect("pref add landed", r.landed, List.of("Cellos@4"));

      // 3. A gotoStay that fails returns home; its edits are dropped (never written into the home clip).
      r = new Rig().post("gotoStay 3 32 Cellos", "add 0 0 48 100 1", "add 0 24 50 100 1");
      expect("fail selection home", r.arr.sel(), "Piano@0");
      expect("fail adds dropped", r.landed, List.of());
      expect("fail session ended", r.nav.inSession(), false);
      contains("fail status error", r.status(), "\"state\":\"error\"");
      contains("fail status batches", r.status(), "\"batches\":1");
      contains("fail status dropped", r.status(), "\"dropped\":2");
      contains("fail stayed null", r.status(), "\"stayed\":null");
      r.post("add 0 0 60 100 1"); // the next batch is not dropped
      expect("fail next batch applies", r.landed, List.of("Piano@0"));

      // 4. goto then gotoStay in one session.
      r = new Rig().post("goto 3 4 Cellos", "add 0 0 48 100 1", "gotoStay 2 0 Violins%201", "add 0 0 72 100 1");
      expect("mixed adds", r.landed, List.of("Cellos@4", "Violins 1@0"));
      expect("mixed selection", r.arr.sel(), "Violins 1@0");
      expect("mixed session ended", r.nav.inSession(), false);
      contains("mixed batches", r.status(), "\"batches\":1");
      contains("mixed results", r.status(), "\"results\":[\"ok: goto Cellos @ 4\",\"ok: stay Violins 1 @ 0\"]");

      // 5. goto / gotoHome unchanged.
      r = new Rig().post("goto 2 8 Violins%201", "add 0 0 60 100 1", "gotoHome");
      expect("home add landed", r.landed, List.of("Violins 1@8"));
      expect("home selection", r.arr.sel(), "Piano@0");
      expect("home play start", r.arr.playStart, 0.0);
      contains("home stayed null", r.status(), "\"stayed\":null");
      contains("home batches", r.status(), "\"batches\":1");

      // 6. Refused (playing): the batch is dropped and counted.
      r = new Rig();
      r.arr.playing = true;
      r.post("gotoStay 2 8 Violins%201", "add 0 0 60 100 1");
      expect("refused selection", r.arr.sel(), "Piano@0");
      expect("refused adds dropped", r.landed, List.of());
      contains("refused batches", r.status(), "\"batches\":1");
      contains("refused error", r.status(), "Stop playback first.");

      // 7. Malformed gotoStay inside a session: ends at home, its edits dropped.
      r = new Rig().post("goto 2 8 Violins%201", "gotoStay 2", "add 0 0 60 100 1");
      expect("malformed selection home", r.arr.sel(), "Piano@0");
      expect("malformed adds dropped", r.landed, List.of());
      expect("malformed session ended", r.nav.inSession(), false);
      contains("malformed batches", r.status(), "\"batches\":1");

      // 8. Malformed goto outside a session: the batch is refused, its edits never reach the current clip.
      r = new Rig().post("goto 2", "add 0 0 60 100 1", "gotoHome");
      expect("malformed goto adds dropped", r.landed, List.of());
      contains("malformed goto batches", r.status(), "\"batches\":1");
      r.post("add 0 0 60 100 1");
      expect("malformed goto next batch applies", r.landed, List.of("Piano@0"));

      System.out.println(failures == 0 ? "done" : "done with " + failures + " failures");
   }
}
