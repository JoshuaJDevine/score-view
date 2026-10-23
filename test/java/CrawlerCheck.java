package claude.scoreview;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.TreeMap;

import com.bitwig.extension.controller.api.Action;
import com.bitwig.extension.controller.api.Application;
import com.bitwig.extension.controller.api.BooleanValue;
import com.bitwig.extension.controller.api.Clip;
import com.bitwig.extension.controller.api.ControllerHost;
import com.bitwig.extension.controller.api.NoteStep;
import com.bitwig.extension.controller.api.SettableBooleanValue;
import com.bitwig.extension.controller.api.SettableStringValue;
import com.bitwig.extension.controller.api.Track;
import com.bitwig.extension.controller.api.Transport;

import static claude.scoreview.NavigatorCheck.beats;
import static claude.scoreview.NavigatorCheck.fake;

/**
 * Test helper (test/mirror-store-test.mjs): runs the real {@link ArrangementCrawler} (a full read and targeted reads of
 * some tracks, op "crawl tracks ...") against a fake Bitwig arranger whose lanes do not line up with the track list
 * (like Bitwig: groups and other lanes sit in between) and lanes without clips; and
 * {@link ArrangementMirror} (file names, memory + disk); the fast walk (adaptive waits with a flush clock, stepping past
 * lanes that cannot hold notes, a bank order that differs from the lanes); {@link NoteListen} (GET /api/listen).
 * Prints "name ok" / "name FAIL ..." per check, then "done".
 * Runs in real time (~10 s: the crawler waits for Bitwig to settle between actions).
 */
public final class CrawlerCheck
{
   // ------------------------------------------------------------------ fake arranger

   record FakeClip(double start, int[][] notes) {} // notes: {x, y}

   static final class Arr
   {
      final String[] laneTracks; // null = a lane without a track's clips (group header, automation)
      final FakeClip[][] clips;
      int curLane, selLane, selIdx;
      int firstLane; // where "Move cursor to first lane" goes (live: the first lane of the cursor's group)
      double playStart;
      boolean selected = true;
      volatile long changed, flushed;
      int splitMs; // > 0: the second half of a selected clip's notes arrives this much later (Bitwig sends them one by one)
      final List<String> actions = new ArrayList<>();
      final Map<String, NoteStep> notes = new TreeMap<>();

      Arr(final String[] laneTracks, final FakeClip[][] clips, final int homeLane, final int homeIdx)
      {
         this.laneTracks = laneTracks; this.clips = clips;
         select(homeLane, homeIdx);
      }

      String track() { return selected ? laneTracks[selLane] : ""; }
      FakeClip clip() { return clips[selLane][selIdx]; }
      String sel() { return track() + "@" + NavigatorCheck.fmt(clip().start()); }

      void act(final String id)
      {
         actions.add(id);
         switch (id)
         {
            case "Move cursor to first lane" -> curLane = firstLane;
            case "Move cursor to next lane" -> curLane = Math.min(curLane + 1, laneTracks.length - 1);
            // an empty lane selects nothing (the full read of Mega Man 2 recorded nothing on group lanes)
            case "Select first item" -> { if (clips[curLane].length > 0) select(curLane, 0); else selected = false; }
            case "Select next item" -> { if (selLane == curLane && selIdx + 1 < clips[curLane].length) select(curLane, selIdx + 1); }
            case "Unselect All" -> selected = false;
            default -> throw new IllegalStateException("unexpected action " + id);
         }
         changed = flushed = System.currentTimeMillis(); // Bitwig calls flush() after delivering a batch
      }

      private void select(final int lane, final int idx)
      {
         selLane = lane; selIdx = idx; selected = true;
         playStart = clips[lane][idx].start(); // Bitwig moves the play start marker to the selected clip
         notes.clear();
         final int[][] all = clips[lane][idx].notes();
         final int first = splitMs > 0 ? (all.length + 1) / 2 : all.length;
         for (int i = 0; i < first; i++) put(all[i]);
         if (first < all.length)
         {
            tasks.add(new Task(System.currentTimeMillis() + splitMs, seq++, () -> {
               if (selLane != lane || selIdx != idx) return;
               for (int i = first; i < all.length; i++) put(all[i]);
               changed = flushed = System.currentTimeMillis();
            }));
         }
      }

      private void put(final int[] n)
      {
         notes.put("0_" + n[0] + "_" + n[1], fake(NoteStep.class, Map.of("x", a -> n[0], "y", a -> n[1], "channel", a -> 0,
            "duration", a -> 1.0, "velocity", a -> 0.8)));
      }

      long count(final String id) { return actions.stream().filter(id::equals).count(); }
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

   static SettableBooleanValue bool(final java.util.function.Supplier<Boolean> get)
   {
      return fake(SettableBooleanValue.class, Map.of("get", a -> get.get(), "set", a -> null));
   }

   static final class Rig
   {
      final Arr arr;
      final ArrangementCrawler crawler;
      int restores, done;

      Rig()
      {
         // lanes: 0 group header, 1 Piano, 2 automation, 3 Strings (group, empty), 4 Violins 1, 5 an empty lane, 6 Cellos
         this(new Arr(new String[] { null, "Piano", null, null, "Violins 1", null, "Cellos" },
            new FakeClip[][] { {}, { new FakeClip(0, new int[][] { { 0, 60 } }), new FakeClip(16, new int[][] { { 0, 62 } }) },
               {}, {}, { new FakeClip(0, new int[][] { { 0, 72 }, { 24, 74 } }), new FakeClip(8, new int[][] { { 0, 76 } }) },
               {}, { new FakeClip(4, new int[][] { { 0, 48 } }) } }, 1, 1));
      }

      Rig(final Arr fakeArr)
      {
         arr = fakeArr;
         final ControllerHost host = fake(ControllerHost.class, Map.of(
            "scheduleTask", a -> { tasks.add(new Task(System.currentTimeMillis() + ((Number) a[1]).longValue(), seq++, (Runnable) a[0])); return null; },
            "println", a -> null, "errorln", a -> { System.err.println(a[0]); return null; }));
         final Application app = fake(Application.class, Map.of("getAction", a -> {
            final String id = (String) a[0];
            return fake(Action.class, Map.of("invoke", x -> { arr.act(id); return null; }, "getId", x -> id));
         }));
         final Transport transport = fake(Transport.class, Map.of(
            "isPlaying", a -> bool(() -> false),
            "isArrangerLoopEnabled", a -> bool(() -> false),
            "arrangerLoopStart", a -> beats(() -> 0.0, v -> { }),
            "arrangerLoopDuration", a -> beats(() -> 16.0, v -> { }),
            "playStartPosition", a -> beats(() -> arr.playStart, v -> arr.playStart = v)));
         final Clip clip = fake(Clip.class, Map.of(
            "exists", a -> fake(BooleanValue.class, Map.of("get", x -> arr.selected)),
            "getPlayStop", a -> beats(() -> 4.0, v -> { }),
            "getPlayStart", a -> beats(() -> 0.0, v -> { }),
            "getLoopStart", a -> beats(() -> 0.0, v -> { }),
            "getLoopLength", a -> beats(() -> 4.0, v -> { }),
            "isLoopEnabled", a -> bool(() -> false)));
         final Track track = fake(Track.class, Map.of("name", a -> fake(SettableStringValue.class, Map.of("get", x -> arr.track()))));
         crawler = new ArrangementCrawler(host, app, transport, clip, track, arr.notes, new Object(), () -> arr.changed,
            () -> arr.laneTracks.length, () -> { }, 24, () -> false, () -> restores++, () -> "[]");
         crawler.setOnDone(() -> done++);
         crawler.setFlushClock(() -> arr.flushed);
      }

      /** The bank the extension would report: one entry per lane, in the order it believes the lanes are. */
      Rig lanes(final ArrangementCrawler.LaneInfo... info)
      {
         crawler.setLaneInfo(() -> List.of(info));
         return this;
      }

      Rig crawl(final Set<String> only) throws InterruptedException
      {
         return crawl(only, false, false);
      }

      Rig crawl(final Set<String> only, final boolean adaptive, final boolean skip) throws InterruptedException
      {
         crawler.configure(adaptive, skip);
         crawler.start(false, only);
         runTasks(30000);
         return this;
      }

      String status() { return crawler.statusJson(); }

      long ms()
      {
         final java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"ms\":([0-9]+)").matcher(status());
         return m.find() ? Long.parseLong(m.group(1)) : -1;
      }

      /** Every clip of the result with its notes, to compare two reads exactly. */
      List<String> clipsWithNotes()
      {
         final List<String> out = new ArrayList<>();
         final java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"track\":\"([^\"]*)\",\"start\":([0-9.]+)[^\\]]*?\"notes\":\\[((?:\\[[^\\]]*\\],?)*)\\]").matcher(status());
         while (m.find()) out.add(m.group(1) + "@" + m.group(2) + ":" + m.group(3));
         return out;
      }

      /** "track@start" of every clip in the result, in order. */
      List<String> clips()
      {
         final List<String> out = new ArrayList<>();
         final java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"track\":\"([^\"]*)\",\"start\":([0-9.]+)").matcher(status());
         while (m.find()) out.add(m.group(1) + "@" + NavigatorCheck.fmt(Double.parseDouble(m.group(2))));
         return out;
      }
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

   static Set<String> set(final String... names) { return new LinkedHashSet<>(List.of(names)); }

   static ArrangementCrawler.LaneInfo li(final String name, final boolean group, final boolean notes)
   {
      return new ArrangementCrawler.LaneInfo(name, group, notes, group ? "Group" : notes ? "Instrument" : "Audio");
   }

   public static void main(final String[] args) throws Exception
   {
      // 1. Full read: every clip once, lanes without clips skipped, selection and play start restored.
      Rig r = new Rig().crawl(null);
      expect("full clips", r.clips(), List.of("Piano@0", "Piano@16", "Violins 1@0", "Violins 1@8", "Cellos@4"));
      contains("full done", r.status(), "\"state\":\"done\"");
      expect("full not a subset", r.status().contains("\"subset\""), false);
      expect("full complete", r.crawler.complete(), true);
      expect("full onDone", r.done, 1);
      expect("full selection restored", r.arr.sel(), "Piano@16");
      expect("full play start restored", r.arr.playStart, 16.0);

      // 2. Targeted read of one track: only its clips; stops after its lane (the original clip's lane came first).
      r = new Rig().crawl(set("Violins 1"));
      expect("subset clips", r.clips(), List.of("Violins 1@0", "Violins 1@8"));
      contains("subset list", r.status(), "\"subset\":[\"Violins 1\"]");
      contains("subset found", r.status(), "\"found\":[\"Violins 1\"]");
      contains("subset complete", r.status(), "\"complete\":true");
      contains("subset message", r.status(), "Read 2 clips on 1 of 1 tracks");
      expect("subset stopped early (no lane after Violins 1)", r.arr.count("Move cursor to next lane") - 1 /* restore */, 4L);
      expect("subset Piano lane not walked", r.arr.count("Select next item"), 3L); // 2 on Violins 1, 1 to find the original clip
      expect("subset selection restored", r.arr.sel(), "Piano@16");
      expect("subset onDone", r.done, 1);

      // 3. Two tracks, the last lane included.
      r = new Rig().crawl(set("Cellos", "Piano"));
      expect("two tracks clips", r.clips(), List.of("Piano@0", "Piano@16", "Cellos@4"));
      contains("two tracks found", r.status(), "\"found\":[\"Piano\",\"Cellos\"]");

      // 4. A track with no clips (deleted, or new and empty): every lane looked at, found stays empty, complete.
      r = new Rig().crawl(set("Harp"));
      expect("absent clips", r.clips(), List.of());
      contains("absent found", r.status(), "\"found\":[]");
      contains("absent complete", r.status(), "\"complete\":true");

      // 6. Stepping past lanes that cannot hold notes (audio lane 2, effect lane 5): not selected, the same clips.
      final ArrangementCrawler.LaneInfo[] bank = {
         li("Group", true, false), li("Piano", false, true), li("Audio 1", false, false), li("Strings", true, false),
         li("Violins 1", false, true), li("FX", false, false), li("Cellos", false, true) };
      final Rig safe = new Rig().lanes(bank).crawl(null);
      expect("notes compared", safe.clipsWithNotes().get(2), "Violins 1@0.0:[0,0,72,1.0,102],[0,24,74,1.0,102]");
      r = new Rig().lanes(bank).crawl(null, false, true);
      expect("skip clips", r.clipsWithNotes(), safe.clipsWithNotes());
      contains("skip count", r.status(), "\"skipped\":2");
      contains("skip lane order verified", r.status(), "\"laneOrder\":\"verified\"");
      expect("skip fewer selections", r.arr.count("Select first item") + " vs " + safe.arr.count("Select first item"), "6 vs 8");
      expect("skip selection restored", r.arr.sel(), "Piano@16");
      expect("safe read skips nothing", safe.status().contains("\"skipped\":0") && safe.status().contains("\"timing\":\"safe\""), true);
      r = new Rig().lanes(bank).crawl(set("Cellos"), false, true);
      expect("skip targeted clips", r.clips(), List.of("Cellos@4"));
      contains("skip targeted complete", r.status(), "\"complete\":true");

      // 7. The bank's order is not the lanes' order, found before anything was stepped past: skipping stops, all read.
      r = new Rig().lanes(li("Group", true, false), li("Cellos", false, true), li("Audio 1", false, false), li("Strings", true, false),
         li("Violins 1", false, true), li("FX", false, false), li("Piano", false, true)).crawl(null, false, true);
      expect("differs clips", r.clipsWithNotes(), safe.clipsWithNotes());
      contains("differs order", r.status(), "\"laneOrder\":\"differs\"");
      contains("differs nothing skipped", r.status(), "\"skipped\":0");
      contains("differs no rewalk", r.status(), "\"rewalked\":false");

      // 8. ... found after a lane was stepped past (the Harp lane looked like audio): every lane is walked again, the
      // Harp clip is read, nothing is read twice.
      final Arr three = new Arr(new String[] { "Piano", "Harp", "Violins 1" }, new FakeClip[][] {
         { new FakeClip(0, new int[][] { { 0, 60 } }) }, { new FakeClip(0, new int[][] { { 0, 67 } }) }, { new FakeClip(0, new int[][] { { 0, 72 } }) } }, 0, 0);
      r = new Rig(three).lanes(li("Piano", false, true), li("Audio 1", false, false), li("Harp", false, true)).crawl(null, false, true);
      expect("rewalk clips", r.clips(), List.of("Piano@0", "Violins 1@0", "Harp@0"));
      contains("rewalk flagged", r.status(), "\"rewalked\":true");
      contains("rewalk order", r.status(), "\"laneOrder\":\"differs\"");
      expect("rewalk selection restored", r.arr.sel(), "Piano@0");

      // 8b. "Move cursor to first lane" stays inside the selected clip's group (live 2026-10-23): the walk begins at Harp,
      // below Piano and Cellos, and would miss them. No result, an error that says why.
      final Arr inGroup = new Arr(new String[] { "Piano", "Cellos", null, "Harp" }, new FakeClip[][] {
         { new FakeClip(0, new int[][] { { 0, 60 } }) }, { new FakeClip(0, new int[][] { { 0, 48 } }) }, {}, { new FakeClip(0, new int[][] { { 0, 67 } }) } }, 3, 0);
      inGroup.firstLane = 3;
      r = new Rig(inGroup).lanes(li("Piano", false, true), li("Cellos", false, true), li("Perc", true, false), li("Harp", false, true)).crawl(null);
      contains("below top error", r.status(), "\"state\":\"error\"");
      contains("below top why", r.status(), "began at Harp");
      contains("below top fix", r.status(), "\"fix\":\"clickClip\"");
      // ... the same walk from the top lane reads all three
      final Arr fromTop = new Arr(inGroup.laneTracks, inGroup.clips, 3, 0);
      r = new Rig(fromTop).lanes(li("Piano", false, true), li("Cellos", false, true), li("Perc", true, false), li("Harp", false, true)).crawl(null);
      expect("from top clips", r.clips(), List.of("Piano@0", "Cellos@0", "Harp@0"));

      // 9. Adaptive waits (FAST): the same clips and notes, sooner. The fake flushes after every change.
      r = new Rig().lanes(bank).crawl(null, true, false);
      expect("fast clips", r.clipsWithNotes(), safe.clipsWithNotes());
      contains("fast timing", r.status(), "\"timing\":\"fast\"");
      System.out.println("  (timing: safe " + safe.ms() + " ms, fast " + r.ms() + " ms)");
      expect("fast is faster", r.ms() < safe.ms() * 0.85, true);
      final Rig both = new Rig().lanes(bank).crawl(null, true, true);
      expect("fast + skip clips", both.clipsWithNotes(), safe.clipsWithNotes());
      System.out.println("  (timing: fast + skip " + both.ms() + " ms)");
      // notes arriving in two batches 30 ms apart (each flushed): the fast walk waits for the second one
      Rig split = new Rig();
      split.arr.splitMs = 30;
      split.lanes(bank).crawl(null, true, false);
      expect("fast split notes", split.clipsWithNotes(), safe.clipsWithNotes());
      // the safe walk's margin: a second batch 150 ms later is still read
      split = new Rig();
      split.arr.splitMs = 150;
      split.lanes(bank).crawl(null);
      expect("safe split notes", split.clipsWithNotes(), safe.clipsWithNotes());

      // 10. NoteListen (GET /api/listen): per-track rings, events since a seq, beat estimate between position reports.
      final NoteListen nl = new NoteListen(4);
      contains("listen empty", nl.json(-1, false, 0, i -> "T" + i), "{\"seq\":0,\"playing\":false,\"pos\":0.0,\"tracks\":[]}");
      nl.add(1, true, 60, 100, 4.0, 1000, true);
      nl.add(1, false, 60, 0, 4.5, 1100, true);
      nl.add(3, true, 20, 90, 4.25, 1000, true);
      expect("listen out of range", nl.add(9, true, 60, 100, 0, 0, true), -1L);
      contains("listen since 0", nl.json(0, true, 5, i -> "T" + i),
         "{\"index\":1,\"name\":\"T1\",\"events\":[[1,1,60,100,4.0,1000,1],[2,0,60,0,4.5,1100,1]]},{\"index\":3,\"name\":\"T3\",\"events\":[[3,1,20,90,4.25,1000,1]]}");
      expect("listen since 2", nl.json(2, true, 5, i -> "T" + i).contains("\"index\":1"), false);
      contains("listen restarted", nl.json(99, true, 5, i -> "T" + i), "\"seq\":3,\"playing\":true,\"pos\":5.0,\"tracks\":[]");
      for (int i = 0; i < 600; i++) nl.add(0, true, 60, 100, i, i, true);
      final String ring = nl.json(3, true, 0, i -> "T" + i);
      expect("listen ring cap", ring.split("\\],\\[").length, NoteListen.PER_TRACK);
      expect("beat between reports", NoteListen.estimateBeat(8, 1000, 1100, true, 120, 0.25, false, 0, 0), 8.2);
      expect("beat capped", NoteListen.estimateBeat(8, 1000, 1500, true, 120, 0.25, false, 0, 0), 8.25);
      expect("beat stopped", NoteListen.estimateBeat(8, 1000, 1500, false, 120, 0.25, false, 0, 0), 8.0);
      expect("beat loop wraps", Math.round(NoteListen.estimateBeat(15.9, 1000, 1125, true, 120, 0.25, true, 0, 16) * 1000) / 1000.0, 0.15);

      // 5. ArrangementMirror: file names, memory + disk, a second instance reads the file.
      expect("name plain", ArrangementMirror.fileName("Mega Man 2"), "Mega Man 2.json");
      expect("name cleaned", ArrangementMirror.fileName("a/b:c").matches("a_b_c-[0-9a-f]+\\.json"), true);
      expect("name dots", ArrangementMirror.fileName("..").matches("project-[0-9a-f]+\\.json"), true);
      expect("name reserved", ArrangementMirror.fileName("CON").matches("CON-[0-9a-f]+\\.json"), true);
      expect("name differs", ArrangementMirror.fileName("a/b").equals(ArrangementMirror.fileName("a:b")), false);
      expect("problem object", ArrangementMirror.problem("[1]"), "the document must be a JSON object");
      expect("problem ok", ArrangementMirror.problem("{\"v\":1}"), null);
      final Path dir = Files.createTempDirectory("sv-mirror").resolve(ArrangementMirror.FOLDER);
      final ArrangementMirror m = new ArrangementMirror(dir, System.err::println);
      expect("mirror empty", m.get("Song"), null);
      m.put("Song", "{\"v\":1,\"project\":\"Song\"}");
      m.put("Bad", "not json");
      expect("mirror memory", m.get("Song"), "{\"v\":1,\"project\":\"Song\"}");
      m.flush();
      expect("mirror file", Files.readString(dir.resolve("Song.json")), "{\"v\":1,\"project\":\"Song\"}");
      expect("mirror bad not stored", Files.exists(dir.resolve("Bad.json")), false);
      final ArrangementMirror again = new ArrangementMirror(dir, System.err::println);
      expect("mirror from disk", again.get("Song"), "{\"v\":1,\"project\":\"Song\"}");
      expect("mirror other project", again.get("Other"), null);
      expect("mirror memory only", new ArrangementMirror(null, System.err::println).get("Song"), null);
      final Path def = ArrangementMirror.defaultDir();
      expect("default dir name", def == null || def.getFileName().toString().equals(ArrangementMirror.FOLDER), true);

      System.out.println(failures == 0 ? "done" : "done with " + failures + " failures");
   }
}
