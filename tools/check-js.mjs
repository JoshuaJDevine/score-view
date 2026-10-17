// Syntax check (node --check) of every web/**/*.js and test/**/*.mjs, plus tools/*.mjs.
// Usage: node tools/check-js.mjs  (npm run check:js)
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor' && !e.name.startsWith('.')) walk(p, ext, out); }
    else if (ext.some(x => e.name.endsWith(x))) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(ROOT, 'web'), ['.js']), ...walk(path.join(ROOT, 'test'), ['.mjs']), ...walk(path.join(ROOT, 'tools'), ['.mjs'])];
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`FAIL ${path.relative(ROOT, f)}\n${r.stderr}`); }
}
console.log(`check:js ${bad ? 'FAILED' : 'OK'}: ${files.length - bad}/${files.length} files`);
process.exitCode = bad ? 1 : 0;
