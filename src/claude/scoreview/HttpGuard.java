package claude.scoreview;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

/**
 * Request checks for the local HTTP server, so that only the Score View page (or a local script that opts in) can
 * drive Bitwig. The server binds to 127.0.0.1, but any web page the user opens can still send requests to it:
 * <ul>
 * <li><b>DNS rebinding</b>: a hostile domain re-resolved to 127.0.0.1 makes the browser treat our server as that
 *     domain (same-origin, responses readable). The Host header still names the hostile domain, so every request
 *     must carry {@code Host: 127.0.0.1:<port>}, {@code localhost:<port>} or {@code [::1]:<port>}.</li>
 * <li><b>CSRF</b>: a foreign page can POST a "simple" request (text/plain body) without a preflight. Every request
 *     that is not GET/HEAD therefore needs {@code X-ScoreView: 1}: a custom header forces a CORS preflight, which
 *     this server never grants (no Access-Control-Allow-* headers; OPTIONS itself fails this check). An Origin
 *     header, when present, must also be our own origin.</li>
 * <li>Endpoints that change state accept POST only (405 otherwise), so a GET (an image tag, a link) cannot.</li>
 * <li>OPTIONS is always refused (403): this server never grants CORS, and a POST-only endpoint runs on POST only.</li>
 * <li>GET requests stay header-free: they only read, and a foreign origin cannot read the responses (no CORS). They are
 *     still refused when they come from a foreign page (a foreign Origin header, or {@code Sec-Fetch-Site: cross-site}
 *     outside a top-level navigation), so a hostile page cannot tie up the server's threads with long-polls.</li>
 * </ul>
 * {@link #check} is pure so test/java/HttpGuardCheck.java can exercise it without a server.
 */
final class HttpGuard
{
   static final String HEADER = "X-ScoreView";

   /** Why a request was refused: an HTTP status and a short text body. */
   record Verdict(int status, String message) {}

   private HttpGuard() {}

   /** {@link #check(String, String, String, String, String, String, int, boolean)} without Sec-Fetch-* headers. */
   static Verdict check(final String method, final String host, final String origin, final String marker, final int port,
                        final boolean postOnly)
   {
      return check(method, host, origin, marker, null, null, port, postOnly);
   }

   /**
    * @param method    request method
    * @param host      Host header (null if missing)
    * @param origin    Origin header (null if missing)
    * @param marker    X-ScoreView header (null if missing)
    * @param fetchSite Sec-Fetch-Site header (null if missing)
    * @param fetchMode Sec-Fetch-Mode header (null if missing)
    * @param port      the port the server listens on
    * @param postOnly  true for endpoints that change state (only POST is allowed)
    * @return null when the request may proceed, else the refusal
    */
   static Verdict check(final String method, final String host, final String origin, final String marker,
                        final String fetchSite, final String fetchMode, final int port, final boolean postOnly)
   {
      if (!allowedHost(host, port)) return new Verdict(403, "Forbidden: bad Host header");
      final String m = method == null ? "" : method.toUpperCase(Locale.ROOT);
      if (m.equals("OPTIONS")) return new Verdict(403, "Forbidden: no CORS");
      if (postOnly && !m.equals("POST")) return new Verdict(405, "Method not allowed: use POST");
      if (origin != null && !allowedOrigin(origin, port)) return new Verdict(403, "Forbidden: foreign Origin");
      if (fetchSite != null && fetchSite.trim().equalsIgnoreCase("cross-site")
          && (fetchMode == null || !fetchMode.trim().equalsIgnoreCase("navigate")))
         return new Verdict(403, "Forbidden: cross-site request");
      if (m.equals("GET") || m.equals("HEAD")) return null;
      if (marker == null || !marker.trim().equals("1")) return new Verdict(403, "Forbidden: missing " + HEADER + " header");
      return null;
   }

   static boolean allowedHost(final String host, final int port)
   {
      if (host == null) return false;
      final String h = host.trim().toLowerCase(Locale.ROOT);
      return h.equals("127.0.0.1:" + port) || h.equals("localhost:" + port) || h.equals("[::1]:" + port);
   }

   static boolean allowedOrigin(final String origin, final int port)
   {
      final String o = origin.trim().toLowerCase(Locale.ROOT);
      return o.equals("http://127.0.0.1:" + port) || o.equals("http://localhost:" + port) || o.equals("http://[::1]:" + port);
   }

   /** Wraps a handler with {@link #check}; refused requests get the verdict's status and text. */
   static HttpHandler wrap(final int port, final boolean postOnly, final HttpHandler next)
   {
      return ex -> {
         final var h = ex.getRequestHeaders();
         final Verdict v = check(ex.getRequestMethod(), h.getFirst("Host"), h.getFirst("Origin"), h.getFirst(HEADER),
            h.getFirst("Sec-Fetch-Site"), h.getFirst("Sec-Fetch-Mode"), port, postOnly);
         if (v == null) { next.handle(ex); return; }
         refuse(ex, v);
      };
   }

   private static void refuse(final HttpExchange ex, final Verdict v) throws IOException
   {
      try
      {
         ex.getRequestBody().readAllBytes();
         final byte[] body = v.message().getBytes(StandardCharsets.UTF_8);
         ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
         ex.getResponseHeaders().set("Cache-Control", "no-store");
         if (v.status() == 405) ex.getResponseHeaders().set("Allow", "POST");
         ex.sendResponseHeaders(v.status(), body.length);
         try (OutputStream os = ex.getResponseBody()) { os.write(body); }
      }
      finally { ex.close(); }
   }
}
