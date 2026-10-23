// Unit test of test/crawl-compare.mjs (the manual check of a fast read against a safe one) on the Mega Man 2 read.
//   node test/crawl-compare-test.mjs
import assert from 'assert';
import fs from 'fs';
import { compareCrawls } from './crawl-compare.mjs';

const read = JSON.parse(fs.readFileSync(new URL('./fixtures/crawl-megaman2.json', import.meta.url), 'utf8'));
const copy = () => JSON.parse(JSON.stringify(read));
let r = compareCrawls(read, copy());
assert.ok(r.same, 'a read equals itself');
assert.equal(r.counts.a, read.result.length);

let b = copy();
b.result.splice(3, 1);
r = compareCrawls(read, b);
assert.ok(!r.same);
assert.deepEqual(r.lines.filter(l => l.startsWith('only in the first')).length, 1, 'a missing clip is named');

b = copy();
b.result.reverse(); // order does not matter
r = compareCrawls(read, b);
assert.ok(r.same);

b = copy();
const withNotes = b.result.find(c => c.notes.length > 1);
withNotes.notes[0] = withNotes.notes[0].slice();
withNotes.notes[0][2] += 1;
r = compareCrawls(read, b);
assert.equal(r.lines.length, 1);
assert.match(r.lines[0], /notes differ \(1 only in the first, 1 only in the second\)/);

b = copy();
b.result[0] = { ...b.result[0], start: b.result[0].start + 4 };
r = compareCrawls(read, b);
assert.deepEqual(r.lines.map(l => l.split(':')[0]), ['only in the first', 'only in the second'], 'a moved clip');
console.log('crawl-compare-test: all passed');
