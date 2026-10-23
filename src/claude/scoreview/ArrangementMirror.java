package claude.scoreview;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * The last arrangement read of each project (GET/POST /api/arrangement), so a Read is a once-per-project step: kept in
 * memory per project name and on disk under the user's documents ("Bitwig Studio/Score View Cache/<project>.json"),
 * never in the project folder. The document is the page's JSON (features/arrangement-mirror.js: {v, project, readAt,
 * savedAt, tracksAtRead, crawl}); this class only stores it. A finished full crawl is stored here by the extension
 * itself, so a page reloaded during the crawl still finds it; the page posts the updated mirror after it harvests
 * a clip or re-reads some tracks.
 *
 * Disk writes run on one background thread (temp file + rename), so neither the control thread nor an HTTP thread
 * waits for the disk. Reads go to memory first, then to the file. Thread-safe.
 */
final class ArrangementMirror
{
   /** Largest document accepted (characters): ~25 bytes per note, so room for a few hundred thousand notes. */
   static final int MAX_CHARS = 8_000_000;
   static final String FOLDER = "Score View Cache";

   private final Path dir; // null = memory only (no documents folder found)
   private final Consumer<String> log;
   private final Map<String, String> docs = new ConcurrentHashMap<>();
   private final ExecutorService disk = Executors.newSingleThreadExecutor(r -> {
      final Thread t = new Thread(r, "ScoreView-mirror");
      t.setDaemon(true);
      return t;
   });

   ArrangementMirror(final Path dir, final Consumer<String> log)
   {
      this.dir = dir;
      this.log = log;
   }

   /** The folder the documents are written to (null = memory only). */
   Path dir() { return dir; }

   /** The stored document of this project, or null. */
   String get(final String project)
   {
      if (project == null) return null;
      final String mem = docs.get(project);
      if (mem != null || dir == null) return mem;
      final Path f = dir.resolve(fileName(project));
      try
      {
         if (!Files.isRegularFile(f) || Files.size(f) > MAX_CHARS * 4L) return null;
         final String s = Files.readString(f, StandardCharsets.UTF_8).trim();
         if (!looksLikeObject(s)) return null;
         docs.putIfAbsent(project, s);
         return s;
      }
      catch (final IOException | RuntimeException e)
      {
         log.accept("Score View: could not read " + f + ": " + e);
         return null;
      }
   }

   /** Why a document must not be stored (too large, not a JSON object), or null. */
   static String problem(final String doc)
   {
      if (doc == null) return "no document";
      if (doc.length() > MAX_CHARS) return "too large (" + doc.length() + " > " + MAX_CHARS + " characters)";
      if (!looksLikeObject(doc)) return "the document must be a JSON object";
      return null;
   }

   /** Stores the document for this project (memory now, disk in the background). */
   void put(final String project, final String doc)
   {
      if (project == null || problem(doc) != null) return;
      final String d = doc.trim();
      docs.put(project, d);
      if (dir == null) return;
      disk.execute(() -> write(project, d));
   }

   /** Waits (bounded) for the pending disk writes: test/java/MirrorCheck. */
   void flush() throws InterruptedException
   {
      final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
      disk.execute(done::countDown);
      done.await(5, java.util.concurrent.TimeUnit.SECONDS);
   }

   private void write(final String project, final String doc)
   {
      if (!doc.equals(docs.get(project))) return; // a newer document is queued behind this one
      final Path f = dir.resolve(fileName(project));
      try
      {
         Files.createDirectories(dir);
         final Path tmp = dir.resolve(fileName(project) + ".tmp");
         Files.writeString(tmp, doc, StandardCharsets.UTF_8);
         try { Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
         catch (final AtomicMoveNotSupportedException e) { Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING); }
      }
      catch (final IOException | RuntimeException e)
      {
         log.accept("Score View: could not write " + f + ": " + e);
      }
   }

   private static boolean looksLikeObject(final String s)
   {
      final String t = s.trim();
      return t.startsWith("{") && t.endsWith("}");
   }

   private static final java.util.regex.Pattern RESERVED = java.util.regex.Pattern.compile("(?i)(con|prn|aux|nul|com\\d|lpt\\d)");

   /**
    * A file name for a project name: letters, digits, space and {@code . _ - ( )} kept, anything else replaced by '_',
    * at most 80 characters; when anything was changed (or the name is empty or a reserved Windows device name) a hash
    * of the full name is appended, so two names that clean up the same still get different files.
    */
   static String fileName(final String project)
   {
      final String name = project == null ? "" : project;
      final StringBuilder sb = new StringBuilder();
      for (final char c : name.toCharArray())
         sb.append((Character.isLetterOrDigit(c) && c < 0x80) || c == ' ' || c == '.' || c == '_' || c == '-' || c == '(' || c == ')' ? c : '_');
      String clean = sb.toString().trim();
      while (clean.startsWith(".")) clean = clean.substring(1); // no hidden files, no ".."
      while (clean.endsWith(".")) clean = clean.substring(0, clean.length() - 1); // Windows drops trailing dots
      if (clean.length() > 80) clean = clean.substring(0, 80).trim();
      final boolean changed = !clean.equals(name) || clean.isEmpty() || RESERVED.matcher(clean).matches();
      if (changed) clean = (clean.isEmpty() ? "project" : clean) + "-" + Integer.toHexString(name.hashCode());
      return clean + ".json";
   }

   /**
    * The cache folder: "Score View Cache" inside the first existing "Bitwig Studio" documents folder (the user's
    * Documents, a OneDrive Documents, ~/Bitwig Studio on Linux), else inside the user's Documents, else in the home
    * folder. Like NewScoreWizard.presetRoots(), the folder Bitwig itself keeps its library in.
    */
   static Path defaultDir()
   {
      final String home = System.getProperty("user.home", "");
      if (home.isEmpty()) return null;
      final List<String> candidates = new ArrayList<>();
      candidates.add(home + "/Documents/Bitwig Studio");
      final File[] oneDrives = new File(home).listFiles(f -> f.isDirectory() && f.getName().startsWith("OneDrive"));
      if (oneDrives != null) for (final File od : oneDrives) candidates.add(od.getPath() + "/Documents/Bitwig Studio");
      candidates.add(home + "/Bitwig Studio"); // Linux
      for (final String c : candidates)
      {
         try { final Path p = Path.of(c); if (Files.isDirectory(p)) return p.resolve(FOLDER); }
         catch (final RuntimeException e) { /* bad path */ }
      }
      try
      {
         final Path docs = Path.of(home, "Documents");
         return (Files.isDirectory(docs) ? docs.resolve("Bitwig Studio") : Path.of(home, ".scoreview")).resolve(FOLDER);
      }
      catch (final RuntimeException e) { return null; }
   }
}
