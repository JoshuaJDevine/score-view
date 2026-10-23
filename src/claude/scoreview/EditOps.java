package claude.scoreview;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * The one table of POST /api/edit ops: name, argument count, which component handles it and whether it needs
 * Preferences > Score View > Developer mode. {@link ScoreViewExtension#applyEdit} dispatches these, test/mock-server.mjs
 * mirrors them (MOCK_OPS) and test/protocol-test.mjs checks that both sides list exactly the same ops and arities
 * (via test/fixtures/ops.txt, written by {@link #table()}; regenerate with node test/protocol-test.mjs --write).
 *
 * Arity: {@code minArgs}..{@code maxArgs} words after the op name ({@link #MANY} = the rest of the line, e.g. a URL-
 * encoded track name). Ops handled by the extension itself with fewer than minArgs are refused and logged; extra
 * words are ignored. Ops whose handler {@code validates} its own arguments (the clip navigator) always reach it, so
 * a malformed goto still fails the way the page expects (its edits are dropped).
 */
final class EditOps
{
   static final int MANY = Integer.MAX_VALUE;

   /** Who handles an op. HTTP = taken out of the body on the HTTP thread (never queued). */
   enum Handler { EXTENSION, NAVIGATOR, CRAWLER, WIZARD, CURVE, HTTP }

   record Op(String name, int minArgs, int maxArgs, Handler handler, boolean dev, String args)
   {
      boolean validates() { return handler == Handler.NAVIGATOR || handler == Handler.HTTP; }

      /** One line of test/fixtures/ops.txt: name min max handler dev|- */
      String line()
      {
         return name + " " + minArgs + " " + (maxArgs == MANY ? "*" : String.valueOf(maxArgs)) + " "
            + handler.name().toLowerCase() + " " + (dev ? "dev" : "-");
      }
   }

   private static Op op(final String name, final int min, final int max, final Handler h, final String args)
   {
      return new Op(name, min, max, h, false, args);
   }

   private static Op dev(final String name, final int min, final int max, final String args)
   {
      return new Op(name, min, max, Handler.EXTENSION, true, args);
   }

   private static final Handler X = Handler.EXTENSION;

   static final List<Op> ALL = List.of(
      // notes of the active clip (x = grid step, y = MIDI key)
      op("move", 5, 5, X, "ch x y dx dy"),
      op("del", 3, 3, X, "ch x y"),
      op("add", 5, 5, X, "ch x y vel(0-127) durBeats"),
      op("dur", 4, 4, X, "ch x y beats"),
      op("vel", 4, 4, X, "ch x y 0..1"),
      op("select", 4, 4, X, "ch x y add(0/1)"),
      op("audition", 1, 1, X, "key"),
      op("undo", 0, 0, X, ""),
      op("redo", 0, 0, X, ""),
      op("source", 1, 1, X, "arranger|launcher"),
      // transport (arranger beats)
      op("play", 0, 0, X, ""),
      op("stop", 0, 0, X, ""),
      op("toggle", 0, 0, X, ""),
      op("playFrom", 1, 1, X, "beats"),
      op("position", 1, 1, X, "beats"),
      op("loop", 2, 2, X, "startBeats lengthBeats"),
      op("loopOff", 0, 0, X, ""),
      op("solo", 2, 2, X, "trackIndex 0|1"),
      op("mute", 2, 2, X, "trackIndex 0|1"),
      op("deviceOn", 2, 2, X, "deviceIndex(selected track) 0|1"),
      op("metronome", 1, 1, X, "0|1"),
      // arrangement crawl (ArrangementCrawler)
      op("crawl", 0, MANY, Handler.CRAWLER, "[exact] [safe|fast] [tracks trackName(URL-encoded)...]"),
      op("crawlCancel", 0, 0, Handler.CRAWLER, ""),
      // clip navigation (ClipNavigator)
      op("goto", 3, MANY, Handler.NAVIGATOR, "lane startBeats trackName(URL-encoded)"),
      op("gotoStay", 3, MANY, Handler.NAVIGATOR, "lane startBeats trackName(URL-encoded)"),
      op("gotoHome", 0, 1, Handler.NAVIGATOR, "[lane]"),
      op("navCancel", 0, 0, Handler.HTTP, ""),
      // New Score wizard
      op("wizardCancel", 0, 0, Handler.WIZARD, ""),
      // Render dynamics (CurvePlayer): level curves on library controls, previewed or recorded as automation
      op("curveClear", 0, 0, Handler.CURVE, ""),
      op("curveSet", 5, 5, Handler.CURVE, "id track(URL-encoded) profile target beat:value,..."),
      op("curvePreview", 2, 2, Handler.CURVE, "fromBeats toBeats"),
      op("curveRender", 2, 2, Handler.CURVE, "fromBeats toBeats"),
      op("curveStop", 0, 0, Handler.CURVE, ""),
      // debug / research (Developer mode)
      dev("act", 1, MANY, "actionId"),
      dev("clipNext", 0, 0, ""),
      dev("clipPrev", 0, 0, ""),
      dev("clipStepProbe", 0, 1, "[n (1-8)]"),
      dev("selectTrack", 1, 1, "trackIndex"),
      dev("moveTrackAfter", 2, 2, "srcIndex dstIndex"),
      dev("moveTrackBefore", 2, 2, "srcIndex dstIndex"));

   static final Map<String, Op> BY_NAME;
   static
   {
      final Map<String, Op> m = new LinkedHashMap<>();
      for (final Op o : ALL) if (m.put(o.name(), o) != null) throw new IllegalStateException("duplicate op " + o.name());
      BY_NAME = m;
   }

   /** The Developer-mode ops (see ScoreViewExtension.DEV_OPS). */
   static final Set<String> DEV = ALL.stream().filter(Op::dev).map(Op::name).collect(Collectors.toUnmodifiableSet());

   static Op get(final String name) { return BY_NAME.get(name); }

   /**
    * Why the extension must not apply this op (unknown op, too few arguments), or null when it may go to its handler.
    * Developer-mode gating is checked separately (it depends on the preference).
    */
   static String problem(final String[] op)
   {
      final Op o = get(op[0]);
      if (o == null) return "unknown op " + op[0];
      if (!o.validates() && op.length - 1 < o.minArgs())
         return op[0] + " needs " + o.minArgs() + " argument" + (o.minArgs() == 1 ? "" : "s") + ": " + op[0] + " " + o.args();
      return null;
   }

   /** The contract fixture (test/fixtures/ops.txt). */
   static String table()
   {
      final StringBuilder sb = new StringBuilder("# POST /api/edit ops: name minArgs maxArgs(* = rest of line) handler dev|-\n"
         + "# Generated from EditOps.java by node test/protocol-test.mjs --write; test/mock-server.mjs must match it.\n");
      for (final Op o : ALL) sb.append(o.line()).append('\n');
      return sb.toString();
   }
}
