// HTTP request guard (CSRF / DNS rebinding), against both servers:
//  * the mock (test/mock-server.mjs guardRequest), which the e2e suites run the page against;
//  * the extension's own HttpGuard.java: the pure rules (test/java/HttpGuardCheck.java "check", which also covers the
//    wizard's preset-folder allow-list) and a real com.sun HttpServer wrapped like the extension ("serve").
// Usage: node test/security-test.mjs
import assert from 'assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { ROOT } from './lib.mjs';
import { startMockServer } from './mock-server.mjs';

let n = 0;
const ok = name => { n++; console.log('ok  ' + name); };

/** Raw request (node's http lets us set Host and Origin freely). Resolves { status, body }. */
function request(port, { method = 'GET', path: p = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    // A fresh connection per case (a refused request may close its socket) and an explicit length (an OPTIONS body
    // would otherwise go out chunked).
    const length = body ? { 'Content-Length': Buffer.byteLength(body) } : {};
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...length, ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The cases every server must pass; edit/wizard bodies are harmless (an unknown op, an empty plan is never sent). */
async function matrix(label, port) {
  const own = `http://127.0.0.1:${port}`;
  const hdr = { 'X-ScoreView': '1', 'Content-Type': 'text/plain' };
  const cases = [
    ['same-origin POST with header → 200', { method: 'POST', path: '/api/edit', headers: { ...hdr, Origin: own }, body: 'noop' }, 200],
    ['localhost origin POST → 200', { method: 'POST', path: '/api/edit', headers: { ...hdr, Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, body: 'noop' }, 200],
    ['node script POST (no Origin) with header → 200', { method: 'POST', path: '/api/edit', headers: hdr, body: 'noop' }, 200],
    ['foreign Origin POST → 403', { method: 'POST', path: '/api/edit', headers: { ...hdr, Origin: 'https://evil.example' }, body: 'noop' }, 403],
    ['"null" Origin POST → 403', { method: 'POST', path: '/api/edit', headers: { ...hdr, Origin: 'null' }, body: 'noop' }, 403],
    ['POST without X-ScoreView → 403', { method: 'POST', path: '/api/edit', headers: { Origin: own, 'Content-Type': 'text/plain' }, body: 'noop' }, 403],
    ['wizard POST without X-ScoreView → 403', { method: 'POST', path: '/api/wizard?cancel', headers: { Origin: own } }, 403],
    ['wizard POST from a foreign Origin → 403', { method: 'POST', path: '/api/wizard?cancel', headers: { ...hdr, Origin: 'https://evil.example' } }, 403],
    ['bad Host (DNS rebinding) GET → 403', { path: '/api/edit', headers: { Host: `evil.example:${port}` } }, 403],
    ['bad Host GET of the page → 403', { path: '/', headers: { Host: 'evil.example' } }, 403],
    ['bad Host POST with header → 403', { method: 'POST', path: '/api/edit', headers: { ...hdr, Host: 'evil.example' }, body: 'noop' }, 403],
    ['GET on /api/edit → 405', { path: '/api/edit' }, 405],
    ['CORS preflight on /api/edit → 403', { method: 'OPTIONS', path: '/api/edit', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-scoreview' } }, 403],
    ['OPTIONS with X-ScoreView on /api/edit → 403', { method: 'OPTIONS', path: '/api/edit', headers: hdr, body: 'noop' }, 403],
    ['OPTIONS with X-ScoreView on /api/wizard → 403', { method: 'OPTIONS', path: '/api/wizard?cancel', headers: { ...hdr, Origin: own } }, 403],
    ['GET on /api/edit/x (prefix route) → 405', { path: '/api/edit/x' }, 405],
    ['GET long-poll from a foreign Origin → 403', { path: '/api/midi?since=0', headers: { Origin: 'https://evil.example' } }, 403],
    ['GET long-poll, Sec-Fetch-Site cross-site → 403', { path: '/api/notes?v=0', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' } }, 403],
    ['page opened from a link on another site → 200', { path: '/', headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }, 200],
    ['same-origin GET with own Origin → 200', { path: '/api/wizard', headers: { Origin: own, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' } }, 200],
    ['plain GET of the page → 200', { path: '/' }, 200],
    ['GET wizard status (read) → 200', { path: '/api/wizard' }, 200],
  ];
  for (const [name, opts, status] of cases) {
    const r = await request(port, opts);
    assert.equal(r.status, status, `${label}: ${name} (got ${r.status} ${r.body})`);
    if (status === 403) assert.match(r.body, /Forbidden/, `${label}: ${name} has a short text body`);
    ok(`${label}: ${name}`);
  }
}

// ---- mock server
{
  const srv = await startMockServer({ port: 0 });
  try {
    await matrix('mock', srv.port);
    assert.equal(srv.edits.filter(e => e === 'noop').length, 3, 'only the three allowed POSTs reached the clip');
    assert.ok(srv.rejected.length > 0 && srv.rejected.every(r => r.status === 403 || r.status === 405));
    ok('mock: refused requests never reach the edit queue');
    // the dynamics document (/api/marks) changes the project: same rules as an edit
    const own = `http://127.0.0.1:${srv.port}`, body = '{"v":1,"tracks":{}}';
    assert.equal((await request(srv.port, { method: 'POST', path: '/api/marks', headers: { Origin: own, 'Content-Type': 'text/plain' }, body })).status, 403);
    assert.equal((await request(srv.port, { method: 'POST', path: '/api/marks', headers: { 'X-ScoreView': '1', Origin: 'https://evil.example' }, body })).status, 403);
    assert.equal(srv.curve.marksPosts, 0, 'refused marks never stored');
    assert.equal((await request(srv.port, { method: 'POST', path: '/api/marks', headers: { 'X-ScoreView': '1', Origin: own }, body })).status, 200);
    assert.equal((await request(srv.port, { path: '/api/marks' })).body, body);
    ok('mock: /api/marks POST needs the header and our Origin');
  } finally { await srv.close(); }
}

// ---- Java (HttpGuard.java)
let javac;
try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); javac = true; } catch (e) { javac = false; }
if (!javac) console.log('    (Java checks skipped: no javac)');
else {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-guard-'));
  const cp = path.join(ROOT, 'lib', 'extension-api-25.jar');
  const srcs = fs.readdirSync(path.join(ROOT, 'src/claude/scoreview')).filter(f => f.endsWith('.java')).map(f => path.join(ROOT, 'src/claude/scoreview', f));
  execFileSync('javac', ['--release', '21', '-Xlint:-options', '-cp', cp, '-d', out, ...srcs, path.join(ROOT, 'test/java/HttpGuardCheck.java')]);
  const classpath = out + path.delimiter + cp;
  const lines = execFileSync('java', ['-cp', classpath, 'claude.scoreview.HttpGuardCheck', 'check'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(lines.at(-1), 'done', lines.filter(l => /FAIL/.test(l)).join('\n'));
  ok(`java: HttpGuard.check + preset-folder rules (${lines.length - 1} cases)`);

  const child = spawn('java', ['-cp', classpath, 'claude.scoreview.HttpGuardCheck', 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', c => { buf += c; const m = /port (\d+)/.exec(buf); if (m) resolve(Number(m[1])); });
      child.on('exit', code => reject(new Error('java server exited ' + code)));
      setTimeout(() => reject(new Error('java server did not start')), 20000);
    });
    await matrix('java', port);
  } finally {
    child.stdin.end();
    child.kill();
    fs.rmSync(out, { recursive: true, force: true });
  }
}

console.log(`security-test: ${n} passed`);
