// Arrangement read, extension side (no Bitwig, no browser): compiles the extension with test/java/CrawlerCheck and runs
// the real ArrangementCrawler against a fake arranger — a full read, targeted reads of some tracks (op
// 'crawl tracks ...': only their lanes are walked, it stops once they are read, a track without clips is reported as
// not found), selection restored; the fast walk (adaptive waits, stepping past audio / effect lanes, a lane order that
// differs: walk again) gives the same result sooner — and ArrangementMirror (file names, memory + disk store of GET/POST
// /api/arrangement) and NoteListen (GET /api/listen).
// Skipped (passes) without javac.
//   node test/crawler-check-test.mjs
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let javac = true;
try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); } catch (e) { javac = false; }
if (!javac) { console.log('crawler-check-test: skipped (no javac)'); process.exit(0); }
const cp = path.join(ROOT, 'lib', 'extension-api-25.jar');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-crawler-'));
try {
  const srcs = fs.readdirSync(path.join(ROOT, 'src/claude/scoreview')).filter(f => f.endsWith('.java')).map(f => path.join(ROOT, 'src/claude/scoreview', f));
  execFileSync('javac', ['--release', '21', '-Xlint:-options', '-cp', cp, '-d', out, ...srcs,
    path.join(ROOT, 'test/java/NavigatorCheck.java'), path.join(ROOT, 'test/java/CrawlerCheck.java')]);
  const res = execFileSync('java', ['-cp', out + path.delimiter + cp, 'claude.scoreview.CrawlerCheck'], { encoding: 'utf8' });
  const lines = res.trim().split(/\r?\n/);
  lines.forEach(l => console.log('  ' + l));
  assert.deepEqual(lines.filter(l => / FAIL /.test(l)), [], 'CrawlerCheck failures');
  assert.equal(lines[lines.length - 1], 'done');
  console.log(`crawler-check-test: ${lines.filter(l => / ok$/.test(l)).length} checks passed`);
} finally { fs.rmSync(out, { recursive: true, force: true }); }
