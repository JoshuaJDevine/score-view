package claude.scoreview;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.sun.net.httpserver.HttpServer;

/**
 * Test helper (test/security-test.mjs).
 * <ul>
 * <li>{@code check}: prints one line per case of the pure HttpGuard.check / NewScoreWizard.allowedPresetFile rules
 *     ("name ok" or "name FAIL ..."), then "done".</li>
 * <li>{@code serve}: starts a real HttpServer on 127.0.0.1 (ephemeral port) whose contexts are wrapped exactly like the
 *     extension's (/api/edit POST only, /api/wizard and / read+write), prints "port N" and runs until stdin closes.</li>
 * </ul>
 */
public final class HttpGuardCheck
{
   private static int failures;

   public static void main(final String[] args) throws Exception
   {
      if (args.length > 0 && args[0].equals("serve")) { serve(); return; }
      final int p = 8765;
      final String h = "127.0.0.1:" + p, o = "http://127.0.0.1:" + p;
      expect("get page", HttpGuard.check("GET", h, null, null, p, false), 0);
      expect("get localhost", HttpGuard.check("GET", "localhost:" + p, null, null, p, false), 0);
      expect("get ipv6", HttpGuard.check("GET", "[::1]:" + p, null, null, p, false), 0);
      expect("bad host", HttpGuard.check("GET", "evil.example:" + p, null, null, p, false), 403);
      expect("wrong port", HttpGuard.check("GET", "127.0.0.1:9999", null, null, p, false), 403);
      expect("no host", HttpGuard.check("GET", null, null, null, p, false), 403);
      expect("post ok", HttpGuard.check("POST", h, o, "1", p, true), 0);
      expect("post localhost origin", HttpGuard.check("POST", "localhost:" + p, "http://localhost:" + p, "1", p, true), 0);
      expect("post no origin (node script)", HttpGuard.check("POST", h, null, "1", p, true), 0);
      expect("post foreign origin", HttpGuard.check("POST", h, "https://evil.example", "1", p, true), 403);
      expect("post null origin", HttpGuard.check("POST", h, "null", "1", p, true), 403);
      expect("post missing header", HttpGuard.check("POST", h, o, null, p, true), 403);
      expect("post header 0", HttpGuard.check("POST", h, o, "0", p, true), 403);
      expect("get on edit", HttpGuard.check("GET", h, null, null, p, true), 405);
      expect("put on edit", HttpGuard.check("PUT", h, o, "1", p, true), 405);
      expect("preflight on edit", HttpGuard.check("OPTIONS", h, "https://evil.example", null, p, true), 403);
      expect("preflight on wizard", HttpGuard.check("OPTIONS", h, "https://evil.example", null, p, false), 403);
      expect("post wizard bad host", HttpGuard.check("POST", "evil.example", o, "1", p, false), 403);
      expect("options with header on edit", HttpGuard.check("OPTIONS", h, null, "1", p, true), 403);
      expect("options with header on wizard", HttpGuard.check("OPTIONS", h, o, "1", p, false), 403);
      expect("patch on edit", HttpGuard.check("PATCH", h, o, "1", p, true), 405);
      expect("get with own origin", HttpGuard.check("GET", h, o, null, p, false), 0);
      expect("get with foreign origin", HttpGuard.check("GET", h, "https://evil.example", null, p, false), 403);
      expect("get with null origin", HttpGuard.check("GET", h, "null", null, p, false), 403);
      expect("get same-origin fetch", HttpGuard.check("GET", h, null, null, "same-origin", "cors", p, false), 0);
      expect("get typed url", HttpGuard.check("GET", h, null, null, "none", "navigate", p, false), 0);
      expect("get link from another site", HttpGuard.check("GET", h, null, null, "cross-site", "navigate", p, false), 0);
      expect("get cross-site no-cors", HttpGuard.check("GET", h, null, null, "cross-site", "no-cors", p, false), 403);
      expect("post cross-site with header", HttpGuard.check("POST", h, null, "1", "cross-site", "cors", p, true), 403);

      final Path dir = Files.createTempDirectory("svguard");
      final Path lib = Files.createDirectories(dir.resolve("Bitwig Studio/Library/Presets"));
      final Path inside = Files.writeString(lib.resolve("Map.bwpreset"), "x");
      final Path outside = Files.writeString(dir.resolve("evil.bwpreset"), "x");
      final List<Path> roots = List.of(dir.resolve("Bitwig Studio"));
      bool("preset inside", NewScoreWizard.allowedPresetFile(inside.toString(), roots), true);
      bool("preset outside", NewScoreWizard.allowedPresetFile(outside.toString(), roots), false);
      bool("preset dotdot", NewScoreWizard.allowedPresetFile(lib.resolve("../../../evil.bwpreset").toString(), roots), false);
      bool("preset missing", NewScoreWizard.allowedPresetFile(lib.resolve("nope.bwpreset").toString(), roots), false);
      bool("preset folder", NewScoreWizard.allowedPresetFile(lib.toString(), roots), false);
      final Path jar = Files.writeString(lib.resolve("Tool.jar"), "x");
      final Path upper = Files.writeString(lib.resolve("Loud.VSTPRESET"), "x");
      bool("preset wrong type", NewScoreWizard.allowedPresetFile(jar.toString(), roots), false);
      bool("preset upper-case type", NewScoreWizard.allowedPresetFile(upper.toString(), roots), true);
      bool("preset relative", NewScoreWizard.allowedPresetFile("Library/Presets/Map.bwpreset", roots), false);
      bool("unc backslash", NewScoreWizard.localAbsolutePath("\\\\attacker\\share\\x.bwpreset"), false);
      bool("unc slash", NewScoreWizard.localAbsolutePath("//attacker/share/x.bwpreset"), false);
      bool("unc mixed", NewScoreWizard.localAbsolutePath("/\\attacker/share/x.bwpreset"), false);
      bool("device path", NewScoreWizard.localAbsolutePath("\\\\?\\C:\\x.bwpreset"), false);
      bool("local absolute", NewScoreWizard.localAbsolutePath(inside.toString()), true);
      bool("preset unc", NewScoreWizard.allowedPresetFile("\\\\attacker\\share\\x.bwpreset", roots), false);
      bool("roots listed", !NewScoreWizard.presetRoots().isEmpty(), true);
      System.out.println(failures == 0 ? "done" : "done with " + failures + " failures");
   }

   private static void expect(final String name, final HttpGuard.Verdict v, final int status)
   {
      final int got = v == null ? 0 : v.status();
      if (got == status) System.out.println(name + " ok");
      else { failures++; System.out.println(name + " FAIL expected " + status + " got " + got); }
   }

   private static void bool(final String name, final boolean got, final boolean want)
   {
      if (got == want) System.out.println(name + " ok");
      else { failures++; System.out.println(name + " FAIL expected " + want); }
   }

   private static void serve() throws Exception
   {
      final HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      final int port = server.getAddress().getPort();
      final com.sun.net.httpserver.HttpHandler ok = ex -> {
         ex.getRequestBody().readAllBytes();
         final byte[] b = "ok".getBytes(StandardCharsets.UTF_8);
         ex.sendResponseHeaders(200, b.length);
         try (var os = ex.getResponseBody()) { os.write(b); }
      };
      server.createContext("/api/edit", HttpGuard.wrap(port, true, ok));
      server.createContext("/api/wizard", HttpGuard.wrap(port, false, ok));
      server.createContext("/", HttpGuard.wrap(port, false, ok));
      server.start();
      System.out.println("port " + port);
      System.out.flush();
      System.in.readAllBytes(); // until the test closes stdin
      server.stop(0);
   }
}
