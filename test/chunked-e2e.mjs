// Chunked engraving in the page (core/render.js, core/engrave.js, core/chunks.js) on the full Mega Man 2 score (the
// saved crawl, all 23 parts in Score view):
// * the score engraves as one SVG per system (.svc), in Web Workers: SV.render() returns at once with the model
//   current, the previous SVG stays on the paper until the systems in view are ready, SV.rendered() resolves when all are;
// * every bar, note and staff id is on the paper exactly once; hit tests and note clicks work in any chunk;
// * an edit re-engraves one chunk and keeps every other chunk's DOM node; superseded renders never reach the paper;
// * the fallbacks: no workers (scoreview.engraveWorker = false), one document (scoreview.chunked = false), line layout.
// Screenshot: test/out.chunked-middle.png.
//   PORT=8873 node test/chunked-e2e.mjs
import fs from 'fs';
import assert from 'assert/strict';
import { withPage, ROOT } from './lib.mjs';

const PORT = Number(process.env.PORT || 8873);
const crawl = JSON.parse(fs.readFileSync(ROOT + '/test/fixtures/crawl-megaman2.json', 'utf8'));
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failures++; console.log('FAIL', name, '\n     ', e.message); } };

// Installs the crawl as the score and switches to Score view (all parts); resolves once it is all on the paper.
const scoreView = page => page.evaluate(async c => {
  SV.state.crawl = c;
  SV.setBase(SV.arrangement.crawlToScore(c, { title: 'Mega Man 2' }), Date.now());
  SV.core.setScoreShow('all');
  SV.core.setMode('score');
  const r = await SV.rendered();
  return r.times;
}, crawl);

// Ids on the paper: every bar m1..mN once, staves once, every timeline note once.
const paperIds = page => page.evaluate(() => {
  const r = SV.state.render, count = new Map();
  document.querySelectorAll('#paper [id]').forEach(el => { if (/^(m\d+(s\d+)?|n.+)$/.test(el.id)) count.set(el.id, (count.get(el.id) || 0) + 1); });
  const missingBars = [], missingNotes = [];
  for (let m = 1; m <= r.measures; m++) if (count.get('m' + (m + (r.measureOffset || 0))) !== 1) missingBars.push(m);
  r.timeline.forEach(t => { if (count.get(t.svgId) !== 1) missingNotes.push(t.svgId); });
  return { bars: r.measures, notes: r.timeline.length, chunks: document.querySelectorAll('#paper > .svc').length,
           dup: [...count].filter(([, n]) => n > 1).map(([k]) => k).slice(0, 5), missingBars: missingBars.slice(0, 5), missingNotes: missingNotes.slice(0, 5) };
});

await withPage({ port: PORT, width: 1500, height: 900 }, async ({ page, errors, srv }) => {
  srv.setData({ tracks: crawl.tracks.map((t, index) => ({ index, name: t.name, group: !!t.group, solo: false, mute: false, sel: t.name === srv.state.data.track })) });
  // Settled first: a later /api/notes version would let the Read's mirror harvest the mock's clip into the crawl
  // injected below, re-rendering the score in the middle of the measurement.
  await page.waitForFunction(n => SV.state.liveData && SV.state.liveData.tracks.length === n && SV.state.liveData.settled !== false &&
    SV.core.engrave.stats().ready > 0, { timeout: 60000 }, crawl.tracks.length);

  // Switch from the Clip view (the mock's small clip): the clip's SVG stays until the score's systems in view are ready.
  const sw = await page.evaluate(async c => {
    const before = document.querySelector('#paper > .svc');
    SV.state.crawl = c;
    SV.setBase(SV.arrangement.crawlToScore(c, { title: 'Mega Man 2' }), Date.now());
    SV.core.setScoreShow('all');
    SV.core.setMode('score');
    const r = SV.state.render; // the model is current at once
    const now = { model: !!(r && r.measures > 200 && r.timeline.length > 5000), drawn: r.drawn, kept: !!before && before.isConnected,
                  waits: document.querySelectorAll('#paper .svc-wait').length };
    await SV.rendered();
    return { ...now, after: { drawn: r.drawn, kept: before.isConnected, waits: document.querySelectorAll('#paper .svc-wait').length },
             stats: SV.core.engrave.stats(), times: r.times };
  }, crawl);
  console.log('      Score view: ' + JSON.stringify(sw.times));
  await check('Score view engraves in the workers; the previous SVG stays until the systems in view are in', () => {
    assert.ok(sw.model, 'SV.state.render (the model) is current when render() returns');
    assert.equal(sw.drawn, false, 'not drawn yet');
    assert.equal(sw.kept, true, 'the Clip view SVG is still on the paper');
    assert.equal(sw.waits, 0, 'no placeholders before the switch');
    assert.equal(sw.after.drawn, true);
    assert.equal(sw.after.kept, false, 'replaced');
    assert.equal(sw.after.waits, 0, 'every chunk engraved');
    assert.ok(sw.stats.worker >= 20, 'chunks engraved in workers: ' + JSON.stringify(sw.stats));
    assert.ok(sw.times.visible < sw.times.total, 'the systems in view came first (' + sw.times.visible + ' < ' + sw.times.total + ' ms)');
  });

  const ids = await paperIds(page);
  await check(`every bar, staff and note on the paper once (${ids.chunks} chunks, ${ids.bars} bars, ${ids.notes} notes)`, () => {
    assert.ok(ids.chunks > 20, 'one .svc per system');
    assert.deepEqual(ids.dup, []);
    assert.deepEqual(ids.missingBars, []);
    assert.deepEqual(ids.missingNotes, []);
  });

  // Group labels (sections.js) are turned only in chunks the browser renders; an off-screen one is turned when it is
  // scrolled into view (measuring it at once would force its layout).
  const groups = await page.evaluate(async () => {
    const isGroup = g => !!g.querySelector('tspan.rend[font-style="italic"][font-weight="bold"]');
    const count = c => {
      const ls = [...c.querySelectorAll('g.system > g.label')].filter(isGroup);
      return { all: ls.length, turned: ls.filter(g => g.querySelector('text').dataset.svRotated).length };
    };
    const chunks = [...document.querySelectorAll('#paper > .svc')], last = chunks[chunks.length - 1];
    const out = { first: count(chunks[0]), lastBefore: count(last), skipped: SV.core.skipped(last) };
    last.scrollIntoView();
    await new Promise(r => setTimeout(r, 300));
    out.lastAfter = count(last);
    document.getElementById('main').scrollTop = 0;
    return out;
  });
  console.log('      group labels: ' + JSON.stringify(groups));
  await check('group labels: turned in view at once, off-screen when scrolled to', () => {
    assert.ok(groups.first.all > 0 && groups.first.turned === groups.first.all, JSON.stringify(groups));
    assert.ok(groups.lastAfter.all > 0 && groups.lastAfter.turned === groups.lastAfter.all, JSON.stringify(groups));
    if (groups.skipped) assert.equal(groups.lastBefore.turned, 0, 'not measured while off-screen: ' + JSON.stringify(groups));
  });

  const sys = await page.evaluate(() => [...document.querySelectorAll('#paper > .svc')].map(c => c.querySelectorAll('g.system').length));
  await check('each chunk is exactly one system', () => assert.ok(sys.every(n => n === 1), JSON.stringify(sys)));

  // Hit testing in a chunk far down the score: the staff position under the mouse and a click on a (read-only) note.
  await page.evaluate(() => { const c = document.querySelectorAll('#paper > .svc')[20]; c.scrollIntoView(); });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const hit = await page.evaluate(() => {
    const chunk = document.querySelectorAll('#paper > .svc')[20];
    const st = chunk.querySelector('g.measure + g.measure > g.staff') || chunk.querySelector('g.measure > g.staff');
    const lines = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect()).filter(b => b.width > 20);
    const x = (lines[0].left + lines[0].right) / 2, y = lines[2].top; // the middle line
    const h = SV.hitTest({ clientX: x, clientY: y, target: st });
    const m = st.parentNode.id, n = parseInt(st.id.split('s')[1], 10);
    const note = chunk.querySelector('g.note'), nb = note.getBoundingClientRect();
    const found = SV.noteAt({ clientX: nb.left + nb.width / 2, clientY: nb.top + nb.height / 2 + 6, target: chunk });
    return { h, m, n, note: note.id, found: found && found.id };
  });
  await check('SV.hitTest and SV.noteAt work in a chunk far down the score', () => {
    assert.ok(hit.h, 'a hit');
    assert.equal('m' + hit.h.measure, hit.m, 'the bar under the mouse');
    assert.equal(hit.h.staff, hit.n, 'the staff under the mouse');
    assert.equal(hit.found, hit.note, 'the nearest note');
  });
  await page.screenshot({ path: ROOT + '/test/out.chunked-middle.png' });

  // An edit in the middle of the score: one chunk engraved, the others keep their DOM nodes (and their hook decorations).
  const edit = await page.evaluate(async () => {
    const nodes = [...document.querySelectorAll('#paper > .svc')];
    nodes.forEach((n, i) => { n.__mark = i; });
    const zones = document.querySelectorAll('#paper .svpb-sm').length;
    const p = SV.state.base.parts.find(p => p.notes.length > 100);
    const n = p.notes.find(n => n.start >= 396 && n.start < 400);
    n.pitch += 1;
    const t0 = performance.now();
    SV.render();
    const r = await SV.rendered();
    const after = [...document.querySelectorAll('#paper > .svc')];
    return { ms: Math.round(performance.now() - t0), engraved: r.times.engraved, chunks: r.times.chunks,
             kept: after.filter(x => x.__mark != null).length, total: after.length, zones, zonesAfter: document.querySelectorAll('#paper .svpb-sm').length,
             boxes: document.querySelectorAll('#paper g.reh rect').length, rehs: document.querySelectorAll('#paper g.reh').length };
  });
  console.log('      edit: ' + JSON.stringify(edit));
  await check('an edit re-engraves one chunk and keeps the others\' DOM', () => {
    assert.equal(edit.engraved, 1, 'one chunk engraved');
    assert.equal(edit.kept, edit.total - 1, 'every other chunk node kept');
    assert.equal(edit.zonesAfter, edit.zones, 'solo / mute zones: same number (none doubled)');
    assert.equal(edit.boxes, edit.rehs, 'one box per rehearsal mark (none doubled)');
  });

  // Superseded renders: three zoom changes in a row; only the last reaches the paper.
  const zoom = await page.evaluate(async () => {
    const z = document.getElementById('zoom');
    const seen = [];
    const hook = r => seen.push(r);
    SV.hooks.afterRender.push(hook);
    for (const v of ['50', '45', '40']) { z.value = v; SV.render(); }
    const last = SV.state.render;
    await SV.rendered();
    SV.hooks.afterRender.splice(SV.hooks.afterRender.indexOf(hook), 1);
    const svg = document.querySelector('#paper > .svc svg');
    return { onlyLast: seen.every(r => r === last), hooks: seen.length, drawn: last.drawn, waits: document.querySelectorAll('#paper .svc-wait, #paper .svc-stale').length,
             scale: svg && svg.querySelector('.definition-scale') ? 1 : 0 };
  });
  await check('superseded renders never reach the paper (latest wins)', () => {
    assert.ok(zoom.hooks >= 1);
    assert.equal(zoom.onlyLast, true, 'afterRender only ran for the last render');
    assert.equal(zoom.drawn, true);
    assert.equal(zoom.waits, 0);
  });
  const ids2 = await paperIds(page);
  await check('after the zoom changes: every bar and note once', () => {
    assert.deepEqual(ids2.dup, []);
    assert.deepEqual(ids2.missingBars, []);
    assert.deepEqual(ids2.missingNotes, []);
  });

  // Line layout: one document (no chunks), engraved in a worker.
  const line = await page.evaluate(async () => {
    document.querySelector('#layoutSeg [data-layout="line"]').click();
    await SV.rendered();
    const out = { chunks: document.querySelectorAll('#paper > .svc').length, systems: document.querySelectorAll('#paper g.system').length };
    document.querySelector('#layoutSeg [data-layout="page"]').click();
    await SV.rendered();
    return out;
  });
  await check('line layout: the whole score as one document', () => assert.deepEqual(line, { chunks: 1, systems: 1 }));

  // Verovio's setOptions merges into what is set: a chunk job (minLastJustification 0, no bottom margin, encoded
  // breaks) must not change the next single-document job on the same toolkit (core/engrave.js now(), the workers).
  const leak = await page.evaluate(async () => {
    const SB = window.ScoreBuilder, part = SV.state.base.parts.find(p => p.notes.length > 100);
    const small = { ...SV.state.base, parts: [{ ...part, notes: part.notes.filter(n => n.start < 96) }], lengthBeats: 96 };
    const single = SB.buildMEI(small, { grid: 2, simplify: true }).mei;
    const opts = { scale: 55, pageWidth: 1500, pageHeight: 60000, adjustPageHeight: true, breaks: 'auto', pageMarginLeft: 60,
      pageMarginRight: 40, pageMarginTop: 40, header: 'none', footer: 'none', condense: 'auto', condenseFirstPage: true,
      justifyVertically: false, spacingSystem: 14, mnumInterval: 1 };
    const chunk = SB.buildMEI(SV.state.base, { grid: 2, simplify: true }).chunks.mei(10, 13, { abbr: true, hide: null, system: true });
    const chunkOpts = { ...opts, breaks: 'encoded', condense: 'none', minLastJustification: 0, pageMarginTop: 126, pageMarginBottom: 0 };
    const fresh = new verovio.toolkit();
    fresh.setOptions(opts); fresh.loadData(single);
    // (ids Verovio makes up differ from toolkit to toolkit)
    const norm = svg => svg.replace(/ (id|xml:id|xlink:href|href|data-[a-z]+)="[^"]*"/g, '').replace(/(MilestoneEnd) [^"]*"/g, '$1"').replace(/ id-[a-z0-9]+/g, '');
    const want = norm(fresh.renderToSVG(1));
    const E = SV.core.engrave, tag = String(Math.random());
    // the main thread's toolkit
    E.now({ key: 'leak-chunk' + tag, mei: chunk, opts: chunkOpts, inline: false });
    const main = norm(E.now({ key: 'leak-single' + tag, mei: single, opts, inline: false }).svg);
    // a worker: the chunk job, then the single document (one worker engraves them when the others are busy or not
    // there; with several the check is weaker, never wrong)
    const viaWorker = await new Promise(res => {
      let got = 0, svg = '';
      E.request([{ key: 'leak-chunk-w' + tag, mei: chunk, opts: chunkOpts, inline: false },
                 { key: 'leak-single-w' + tag, mei: single, opts, inline: false }], (j, r) => {
        if (j.key.startsWith('leak-single')) svg = norm(r.svg);
        if (++got === 2) res(svg);
      });
    });
    const diff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i < Math.max(a.length, b.length) ? a.slice(Math.max(0, i - 80), i + 80) + ' ||| ' + b.slice(Math.max(0, i - 80), i + 80) : ''; };
    return { dmain: diff(main, want), main: main === want, worker: viaWorker === want, h: (/height="([\d.]+)px"/.exec(main) || [])[1], want: (/height="([\d.]+)px"/.exec(want) || [])[1] };
  });
  await check('a chunk job\'s options do not carry over into the next job on the same toolkit', () => {
    assert.equal(leak.main, true, 'main thread: ' + JSON.stringify(leak));
    assert.equal(leak.worker, true, 'worker: ' + JSON.stringify(leak));
  });
  check('no page errors', () => assert.deepEqual(errors, []));
});

// Fallbacks: no workers (the main thread engraves the chunks one per task), and one document per render.
for (const [key, want] of [['engraveWorker', 'chunks on the main thread'], ['chunked', 'one document']]) {
  await withPage({ port: PORT + 1, width: 1500, height: 900 }, async ({ page, errors }) => {
    await page.evaluate(k => { localStorage.setItem('scoreview.' + k, 'false'); }, key);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SV && SV.core.tk && document.querySelector('#paper svg'), { timeout: 30000 });
    await scoreView(page);
    const ids = await paperIds(page);
    const stats = await page.evaluate(() => SV.core.engrave.stats());
    await check(`fallback ${key} = false: ${want}, every bar and note once`, () => {
      assert.deepEqual(ids.dup, []);
      assert.deepEqual(ids.missingBars, []);
      assert.deepEqual(ids.missingNotes, []);
      if (key === 'engraveWorker') {
        assert.equal(stats.broken, true); assert.equal(stats.workers, 0); assert.ok(ids.chunks > 20);
        assert.ok(stats.main > 20, 'the chunks were engraved on the main thread: ' + JSON.stringify(stats));
      }
      else assert.equal(ids.chunks, 1);
    });
    check('no page errors', () => assert.deepEqual(errors, []));
  });
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('chunked-e2e: all passed');
