// Compiles the extension (and the Java test helpers in test/java) against the Bitwig API jar into a temporary folder,
// like build.sh does but without packaging or installing anything. Usage: node tools/check-java.mjs  (npm run check:java)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const javaFiles = dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.java')).map(f => path.join(ROOT, dir, f));
const srcs = [...javaFiles('src/claude/scoreview'), ...javaFiles('test/java')];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-javac-'));
try {
  execFileSync('javac', ['--release', '21', '-Xlint:-options', '-cp', path.join(ROOT, 'lib', 'extension-api-25.jar'), '-d', out, ...srcs],
    { stdio: 'inherit' });
  console.log(`check:java OK (${srcs.length} files)`);
} catch (e) {
  console.error('check:java FAILED');
  process.exitCode = 1;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
