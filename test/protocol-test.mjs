// Protocol contract between the extension and the mock (no browser):
//  * the op table src/claude/scoreview/EditOps.java (dumped by test/java/ProtocolCheck "ops") equals the committed
//    test/fixtures/ops.txt, and test/mock-server.mjs MOCK_OPS lists exactly the same ops, arities, handlers and dev flags;
//  * every op of the table has a case in ScoreViewExtension.applyEdit (or is taken out on the HTTP thread), and no
//    case exists outside the table;
//  * EditOps.problem() and the mock's opProblem() agree; the mock really applies/refuses ops by the table;
//  * the port-busy popup (D5) and the clip navigator's goto/gotoStay/gotoHome (test/java/NavigatorCheck, ~10 s);
//  * /api/notes timing fields (settled, changedMs, selPlayStart) in notesJson and the mock, and LiveSync's
//    versions-per-burst / settle windows on a fake clock (test/java/LiveSyncCheck).
// Without javac the Java side is checked from the fixture only.
//   node test/protocol-test.mjs           (node test/protocol-test.mjs --write regenerates test/fixtures/ops.txt)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { MOCK_OPS, opProblem, startMockServer } from './mock-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test/fixtures/ops.txt');
const write = process.argv.includes('--write');
let passed = 0;
const ok = name => { passed++; console.log('  ok ' + name); };

// ---- Java side
let javac;
try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); javac = true; } catch (e) { javac = false; }
let java = null;
if (javac) {
  const cp = path.join(ROOT, 'lib', 'extension-api-25.jar');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-protocol-'));
  const srcs = fs.readdirSync(path.join(ROOT, 'src/claude/scoreview')).filter(f => f.endsWith('.java')).map(f => path.join(ROOT, 'src/claude/scoreview', f));
  execFileSync('javac', ['--release', '21', '-Xlint:-options', '-cp', cp, '-d', out, ...srcs,
    path.join(ROOT, 'test/java/ProtocolCheck.java'), path.join(ROOT, 'test/java/NavigatorCheck.java'),
    path.join(ROOT, 'test/java/LiveSyncCheck.java')]);
  const classpath = out + path.delimiter + cp;
  java = (cls, ...args) => execFileSync('java', ['-cp', classpath, 'claude.scoreview.' + cls, ...args], { encoding: 'utf8' });
  process.on('exit', () => fs.rmSync(out, { recursive: true, force: true }));
} else console.log('    (Java checks skipped: no javac; using test/fixtures/ops.txt)');

const parseTable = text => text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).map(l => {
  const [name, min, max, handler, dev] = l.trim().split(/\s+/);
  return { name, min: Number(min), max: max === '*' ? Infinity : Number(max), handler, dev: dev === 'dev' };
});

if (java) {
  const table = java('ProtocolCheck', 'ops');
  if (write) { fs.writeFileSync(FIXTURE, table); console.log('wrote ' + path.relative(ROOT, FIXTURE)); }
  assert.equal(fs.existsSync(FIXTURE) && fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'), table.replace(/\r\n/g, '\n'),
    'test/fixtures/ops.txt is out of date with EditOps.java: run node test/protocol-test.mjs --write');
  ok('ops.txt matches EditOps.java');
}
const ops = parseTable(fs.readFileSync(FIXTURE, 'utf8'));
assert(ops.length > 20 && ops.some(o => o.name === 'gotoStay'), 'ops.txt looks wrong');

// ---- mock table = Java table
const mockOps = Object.entries(MOCK_OPS).map(([name, [min, max, handler, dev]]) => ({ name, min, max, handler, dev: !!dev }));
const byName = list => Object.fromEntries(list.map(o => [o.name, o]));
const javaOps = byName(ops), mock = byName(mockOps);
assert.deepEqual(Object.keys(mock).filter(n => !javaOps[n]), [], 'ops in the mock but not in EditOps.java');
assert.deepEqual(Object.keys(javaOps).filter(n => !mock[n]), [], 'ops in EditOps.java but not in the mock (MOCK_OPS)');
for (const o of ops) assert.deepEqual(mock[o.name], o, `op ${o.name}: mock ${JSON.stringify(mock[o.name])} vs Java ${JSON.stringify(o)}`);
ok(`mock implements the same ${ops.length} ops (arity, handler, dev)`);

// ---- applyEdit has a case for every queued op, and only for those
{
  const src = fs.readFileSync(path.join(ROOT, 'src/claude/scoreview/ScoreViewExtension.java'), 'utf8');
  const body = src.slice(src.indexOf('private void applyEdit('), src.indexOf('// ---------------------------------------------------------------- MIDI bridge'));
  assert(body.length > 100, 'applyEdit not found');
  const cases = new Set();
  for (const m of body.matchAll(/^\s*case\s+((?:"[^"]+"\s*,?\s*)+)->/gm)) for (const n of m[1].matchAll(/"([^"]+)"/g)) cases.add(n[1]);
  const queued = ops.filter(o => o.handler !== 'http').map(o => o.name);
  assert.deepEqual(queued.filter(n => !cases.has(n)), [], 'ops without a case in applyEdit');
  assert.deepEqual([...cases].filter(n => !javaOps[n]), [], 'applyEdit cases missing from EditOps');
  assert(/equals\("navCancel"\)/.test(src), 'navCancel is taken out on the HTTP thread');
  ok('applyEdit covers the table');
}

// ---- EditOps.problem() and opProblem() agree
if (java) {
  const lines = java('ProtocolCheck', 'problems').trim().split(/\r?\n/);
  assert(lines.length >= 9);
  for (const l of lines) {
    const [line, want] = l.split(' => ');
    const got = opProblem(line.split(/\s+/));
    assert.equal(got === null, want === 'null', `problem("${line}"): Java ${want}, mock ${got}`);
  }
  assert(lines.includes('add 0 1 60 100 1 extra => null'), 'extra words are ignored');
  assert(lines.some(l => l.startsWith('add 0 1 60 100 => add needs 5 arguments')));
  ok('EditOps.problem matches the mock');
}

// ---- the mock applies by its table: every op with its minimum arity is accepted, short/unknown/dev ops are refused
{
  const srv = await startMockServer({ port: 0, markers: [] });
  const post = body => fetch(srv.url + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body });
  try {
    const sample = o => [o.name, ...Array(o.min).fill(o.name === 'source' ? 'arranger' : '0')].join(' ');
    await post(ops.filter(o => !o.dev && o.name !== 'navCancel').map(sample).join('\n'));
    assert.deepEqual(srv.refusedOps, [], 'ops at their minimum arity are accepted');
    await post('add 0 1 60\nfrobnicate\nact Save\ngoto');
    assert.deepEqual(srv.refusedOps.map(r => r.op), ['add 0 1 60', 'frobnicate', 'act Save'], 'short, unknown and dev ops are refused; nav ops validate themselves');
    assert.match(srv.refusedOps[2].why, /Developer mode/);
  } finally { await srv.close(); }
  const dev = await startMockServer({ port: 0, markers: [], developerMode: true });
  try {
    await fetch(dev.url + '/api/edit', { method: 'POST', headers: { 'X-ScoreView': '1' }, body: 'act Save\nclipNext' });
    assert.deepEqual(dev.refusedOps, []);
  } finally { await dev.close(); }
  ok('mock enforces the table');
}

// ---- D5: port busy popup
if (java) {
  const out = java('ProtocolCheck', 'port');
  assert.match(out, /exception java\.net\.BindException/, 'HttpServer.create reports a busy port as BindException:\n' + out);
  assert.match(out, /busy Score View: port PORT is busy .*Settings > Controllers > Score View > HTTP port.*off and on/);
  assert.match(out, /other Score View: could not start its web server on port 8765 \(boom\)/);
  ok('port-busy popup text');
}

// ---- ClipNavigator gotoStay / goto / gotoHome against a fake Bitwig
if (java) {
  const out = java('NavigatorCheck');
  const bad = out.split(/\r?\n/).filter(l => / FAIL /.test(l));
  assert.deepEqual(bad, [], 'NavigatorCheck:\n' + out);
  assert.match(out, /^done$/m);
  ok(`ClipNavigator (${out.split(/\r?\n/).filter(l => / ok$/.test(l)).length} checks)`);
}

// ---- /api/notes timing fields (LiveSync): the extension's notesJson and the mock send the same ones
{
  const TIMING = ['settled', 'changedMs', 'selPlayStart'];
  const src = fs.readFileSync(path.join(ROOT, 'src/claude/scoreview/ScoreViewExtension.java'), 'utf8');
  const body = src.slice(src.indexOf('private String notesJson()'), src.indexOf('private void handleMidi('));
  const javaKeys = new Set([...body.matchAll(/sb\.append\(",\\"(\w+)\\":/g)].map(m => m[1])); // top-level fields
  const EXTENSION_ONLY = ['project']; // the mock has no project (the page then keeps its score)
  TIMING.forEach(k => assert(javaKeys.has(k), 'notesJson does not send ' + k));
  const srv = await startMockServer({ port: 0 });
  try {
    const d = await (await fetch(srv.url + '/api/notes?v=-1')).json();
    assert.equal(typeof d.settled, 'boolean', 'mock settled');
    assert.equal(typeof d.changedMs, 'number', 'mock changedMs');
    assert.equal(typeof d.selPlayStart, 'number', 'mock selPlayStart (arranger)');
    const missing = [...javaKeys].filter(k => !(k in d) && !EXTENSION_ONLY.includes(k));
    assert.deepEqual(missing, [], '/api/notes fields the extension sends but the mock does not');
    srv.setData({ source: 'launcher' });
    assert.equal((await (await fetch(srv.url + '/api/notes?v=-1')).json()).selPlayStart, null, 'selPlayStart is null for the launcher');
  } finally { await srv.close(); }
  const old = await startMockServer({ port: 0, settle: false });
  try {
    const d = await (await fetch(old.url + '/api/notes?v=-1')).json();
    TIMING.forEach(k => assert(!(k in d), 'mock settle: false still sends ' + k));
  } finally { await old.close(); }
  ok('/api/notes timing fields (settled, changedMs, selPlayStart) in the extension and the mock');
}

// ---- LiveSync: /api/notes versions per observer burst and the settled flag (fake clock)
if (java) {
  const out = java('LiveSyncCheck');
  const bad = out.split(/\r?\n/).filter(l => / FAIL /.test(l));
  assert.deepEqual(bad, [], 'LiveSyncCheck:\n' + out);
  assert.match(out, /^done$/m);
  ok(`LiveSync (${out.split(/\r?\n/).filter(l => / ok$/.test(l)).length} checks)`);
}

console.log(`protocol-test: ${passed} passed`);
