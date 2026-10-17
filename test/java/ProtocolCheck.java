package claude.scoreview;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.InetAddress;

import com.sun.net.httpserver.HttpServer;

/**
 * Test helper (test/protocol-test.mjs).
 * <ul>
 * <li>{@code ops}: prints the edit op table (EditOps.table(), the content of test/fixtures/ops.txt).</li>
 * <li>{@code problems}: prints EditOps.problem() for a few op lines, one per line ("line => problem|null").</li>
 * <li>{@code port}: occupies an ephemeral port, starts an HttpServer on it the way the extension does and prints the
 *     exception class and the popup text the extension would show ("busy ..."), plus the generic message.</li>
 * </ul>
 */
public final class ProtocolCheck
{
   public static void main(final String[] args) throws Exception
   {
      switch (args.length > 0 ? args[0] : "")
      {
         case "ops" -> System.out.print(EditOps.table());
         case "problems" ->
         {
            for (final String line : new String[] { "add 0 1 60 100", "add 0 1 60 100 1", "add 0 1 60 100 1 extra", "frobnicate 1",
               "goto", "gotoStay 1", "act", "undo", "crawl exact" })
               System.out.println(line + " => " + EditOps.problem(line.split("\\s+")));
         }
         case "port" ->
         {
            try (ServerSocket busy = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")))
            {
               final int p = busy.getLocalPort();
               try
               {
                  HttpServer.create(new InetSocketAddress("127.0.0.1", p), 0).stop(0);
                  System.out.println("bound?! " + p);
               }
               catch (final IOException e)
               {
                  System.out.println("exception " + e.getClass().getName());
                  System.out.println("busy " + ScoreViewExtension.serverFailureMessage(p, e).replace(String.valueOf(p), "PORT"));
               }
            }
            System.out.println("other " + ScoreViewExtension.serverFailureMessage(8765, new IOException("boom")));
         }
         default -> { System.err.println("usage: ProtocolCheck ops|problems|port"); System.exit(2); }
      }
   }
}
