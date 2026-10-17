// Render dynamics, extension side (no Bitwig, no browser): compiles the extension with test/java/CurveCheck and runs
// the real CurvePlayer against a fake transport and pool rig on a virtual clock — profile table from
// web/features/library-profiles.json, Render (write settings to arranger + touch and back, touch on/off at the range
// ends, values follow the curve), Preview, Stop, a stop in Bitwig, the arranger loop, missing controls, refusals.
// Skipped (passes) without javac.
//   node test/curve-player-test.mjs
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let javac = true;
try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); } catch (e) { javac = false; }
if (!javac) { console.log('curve-player-test: skipped (no javac)'); process.exit(0); }
const cp = path.join(ROOT, 'lib', 'extension-api-25.jar');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-curve-'));
try {
  const srcs = fs.readdirSync(path.join(ROOT, 'src/claude/scoreview')).filter(f => f.endsWith('.java')).map(f => path.join(ROOT, 'src/claude/scoreview', f));
  execFileSync('javac', ['--release', '21', '-Xlint:-options', '-cp', cp, '-d', out, ...srcs, path.join(ROOT, 'test/java/CurveCheck.java')]);
  const res = execFileSync('java', ['-cp', out + path.delimiter + cp, 'claude.scoreview.CurveCheck', path.join(ROOT, 'web/features/library-profiles.json')], { encoding: 'utf8' });
  const lines = res.trim().split(/\r?\n/);
  lines.forEach(l => console.log('  ' + l));
  assert.deepEqual(lines.filter(l => / FAIL /.test(l)), [], 'CurveCheck failures');
  assert.equal(lines[lines.length - 1], 'done');
  console.log(`curve-player-test: ${lines.filter(l => / ok$/.test(l)).length} checks passed`);
} finally { fs.rmSync(out, { recursive: true, force: true }); }
