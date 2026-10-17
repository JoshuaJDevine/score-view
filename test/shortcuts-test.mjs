// Unit test of the shortcut registry (web/core/shortcuts.js): key normalisation, contexts, clash detection.
import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createRegistry, normalize, overlaps } = require('../web/core/shortcuts.js');

// normalisation: modifier order and case, aliases, the Plus key
assert.equal(normalize('shift+alt+s'), 'Alt+Shift+S');
assert.equal(normalize('Cmd+Shift+z'), 'Ctrl+Shift+Z');
assert.equal(normalize('esc'), 'Escape');
assert.equal(normalize('Ctrl++'), 'Ctrl+Plus');
assert.equal(normalize('+'), 'Plus');
assert.equal(normalize('alt+arrowUp'), 'Alt+ArrowUp');
assert.equal(normalize('f1'), 'F1');
assert.throws(() => normalize('Ctrl+Shift'), /without a key/);

// contexts: 'always' overlaps normal and entry; named contexts only overlap themselves
assert.ok(overlaps('always', 'entry') && overlaps('normal', 'always') && overlaps('drag', 'drag'));
assert.ok(!overlaps('normal', 'entry') && !overlaps('always', 'drag') && !overlaps('Inspire panel', 'Orchestrate panel'));

const warn = console.warn; const warned = []; console.warn = m => warned.push(m);
try {
  const r = createRegistry();
  r.register({ keys: 'Alt+S', owner: 'motifs', desc: 'sequence up' });
  r.register({ keys: 'Shift+S', owner: 'articulations', desc: 'staccato', when: 'normal' });
  r.register({ keys: ['Shift+A', 'Shift+S'], owner: 'entry', desc: 'chord', when: 'entry' }); // entry vs normal: fine
  r.register({ keys: 'Escape', owner: 'core', when: 'normal' });
  r.register({ keys: 'Escape', owner: 'entry', when: 'entry' });
  r.register({ keys: 'Escape', owner: 'mouse', when: 'drag' });
  assert.deepEqual(r.conflicts(), [], 'different contexts do not clash');
  assert.equal(warned.length, 0);

  r.register({ keys: 'alt+s', owner: 'newModule', desc: 'oops' });           // same key, both 'always'
  r.register({ keys: 'Shift+S', owner: 'other', desc: 'x', when: 'always' }); // overlaps both normal and entry
  const c = r.conflicts();
  assert.deepEqual(c.map(x => x.key + ':' + x.owners.join('/')).sort(),
    ['Alt+S:motifs/newModule', 'Shift+S:articulations/other', 'Shift+S:entry/other']);
  assert.equal(warned.length, 2, 'a clash warns at registration');

  const l = r.list();
  assert.equal(l[0].owner, 'motifs');
  assert.deepEqual(l[2].keys, ['Shift+A', 'Shift+S']);
  l[0].keys.push('X');
  assert.deepEqual(r.list()[0].keys, ['Alt+S'], 'list() returns copies');
  assert.equal(r.keyText({ keys: ['Alt+ArrowUp', 'Alt+ArrowDown'] }), 'Alt+↑ / Alt+↓');
  assert.equal(r.keyText({ keys: ['A'], label: 'A–G' }), 'A–G');
  assert.throws(() => r.register({ keys: 'X' }), /owner/);
} finally { console.warn = warn; }

console.log('shortcuts-test OK');
