// Page core (web/core): SV.requestRender coalescing, SV.state.render reads flushing a pending request, SV.render
// staying synchronous, SV.geom boxes matching getBoundingClientRect (after scrolling, a re-render, an SVG change),
// and start-up when Verovio is ready before the scripts have all loaded.
//   PORT=8872 node test/core-e2e.mjs
import assert from 'assert';
import { withPage } from './lib.mjs';

const port = Number(process.env.PORT || 8872);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await withPage({ port, height: 500 }, async ({ page, errors, browser }) => {
  await page.evaluate(() => { window.__renders = 0; SV.hooks.afterRender.push(() => { window.__renders++; }); });

  // Five control changes in one task: one render on the next frame.
  const burst = await page.evaluate(async () => {
    window.__renders = 0;
    ['keySel', 'gridSel', 'condense', 'hideKs', 'simplify'].forEach(id => document.getElementById(id).dispatchEvent(new Event('change')));
    const sync = window.__renders;
    await new Promise(r => setTimeout(r, 400));
    return { sync, after: window.__renders };
  });
  assert.deepEqual(burst, { sync: 0, after: 1 }, 'five change events -> one render');
  console.log('ok   requestRender coalesces a burst into one render');

  // Reading SV.state.render with a request pending renders first (readers never see a stale render).
  const read = await page.evaluate(async () => {
    window.__renders = 0;
    const before = SV.state.render;
    const cb = document.getElementById('simplify');
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
    const r = SV.state.render;
    const n = window.__renders;
    await new Promise(res => setTimeout(res, 300));
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
    await new Promise(res => setTimeout(res, 300));
    return { fresh: r !== before, n, after: window.__renders };
  });
  assert.deepEqual(read, { fresh: true, n: 1, after: 2 }, 'state.render read flushes the pending render once');
  console.log('ok   SV.state.render read flushes a pending request');

  // SV.render() is synchronous and absorbs a pending request.
  const syncRender = await page.evaluate(async () => {
    window.__renders = 0;
    SV.requestRender(); SV.requestRender();
    SV.render();
    const n = window.__renders;
    await new Promise(res => setTimeout(res, 300));
    return { n, after: window.__renders };
  });
  assert.deepEqual(syncRender, { n: 1, after: 1 }, 'SV.render is synchronous and cancels the pending request');
  console.log('ok   SV.render stays synchronous');

  // SV.scoreModel(overrides) never engraves the page under its overrides, even when a transformScore hook reads
  // SV.state.render (entry.js does) while a request is pending.
  const model = await page.evaluate(async () => {
    const seen = [];
    const reader = score => { void SV.state.render; return score; };
    const spy = () => { seen.push(SV.state.range + '/' + SV.state.trackMode); };
    SV.hooks.transformScore.push(reader);
    SV.hooks.afterRender.push(spy);
    const want = SV.state.range + '/' + SV.state.trackMode;
    const other = { range: SV.state.range === 'all' ? 'clip' : 'all', trackMode: SV.state.trackMode === 'all' ? 'pinned' : 'all' };
    try {
      SV.requestRender();
      SV.scoreModel(other);
      await new Promise(res => setTimeout(res, 300));
    } finally {
      SV.hooks.transformScore.splice(SV.hooks.transformScore.indexOf(reader), 1);
      SV.hooks.afterRender.splice(SV.hooks.afterRender.indexOf(spy), 1);
    }
    return { want, seen };
  });
  assert.ok(model.seen.length === 1 && model.seen[0] === model.want, 'scoreModel overrides leaked into a render ' + JSON.stringify(model));
  console.log('ok   SV.scoreModel flushes a pending render before its overrides');

  // SV.geom matches getBoundingClientRect (to layout rounding, < 0.01 px), before and after scrolling, after a re-render and after an SVG change.
  const compare = () => page.evaluate(() => {
    const els = [...document.querySelectorAll('#paper g.note, #paper g.measure, #paper g.staff > path')];
    const boxes = SV.geom.rects(els);
    let worst = 0;
    els.forEach((el, i) => {
      const b = el.getBoundingClientRect(), g = boxes[i], one = SV.geom.rect(el);
      for (const k of ['left', 'top', 'right', 'bottom', 'width', 'height']) worst = Math.max(worst, Math.abs(b[k] - g[k]), Math.abs(b[k] - one[k]));
    });
    return { n: els.length, worst };
  });
  let c = await compare();
  assert.ok(c.n > 20 && c.worst < 0.01, 'geom = getBoundingClientRect ' + JSON.stringify(c));
  await page.evaluate(() => { const m = document.getElementById('main'); m.scrollTop = 120; window.scrollBy(0, 40); });
  await sleep(50);
  c = await compare();
  assert.ok(c.worst < 0.01, 'after scrolling ' + JSON.stringify(c));
  await page.evaluate(() => { document.getElementById('zoom').value = '30'; document.getElementById('zoom').dispatchEvent(new Event('input')); });
  await sleep(500);
  c = await compare();
  assert.ok(c.worst < 0.01, 'after a re-render at another zoom ' + JSON.stringify(c));
  const moved = await page.evaluate(() => {
    const el = document.querySelector('#paper g.note');
    const before = SV.geom.rect(el).left;
    el.setAttribute('transform', 'translate(500, 0)');
    const after = SV.geom.rect(el).left, real = el.getBoundingClientRect().left;
    el.removeAttribute('transform');
    return { changed: after !== before, exact: Math.abs(after - real) < 0.01, back: Math.abs(SV.geom.rect(el).left - before) < 0.01 };
  });
  assert.deepEqual(moved, { changed: true, exact: true, back: true }, 'an SVG change drops the cache at once');
  console.log('ok   SV.geom boxes match getBoundingClientRect');

  // Start-up order: Verovio may finish compiling before core/start.js runs, or before the feature modules have loaded.
  // Hold back core/start.js, then layout.js (the last feature module), until Verovio is up: the page must still start,
  // and only after every module has loaded (layout sorts the toolbar on 'sv-ready').
  for (const held of ['/core/start.js', '/features/layout.js']) {
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1500, height: 500 });
    await p2.setRequestInterception(true);
    p2.on('request', req => {
      if (!new URL(req.url()).pathname.endsWith(held)) return req.continue();
      const t0 = Date.now();
      const wait = () => p2.evaluate(() => !!(window.verovio && verovio.module.calledRun)).catch(() => false)
        .then(up => up || Date.now() - t0 > 20000 ? req.continue() : setTimeout(wait, 50));
      wait();
    });
    await p2.goto(page.url(), { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => document.querySelector('#paper svg'), { timeout: 30000 });
    const late = await p2.evaluate(() => ({ ready: !!SV.core.tk, clusters: document.querySelectorAll('#featureBar > .svl-cluster').length > 0 }));
    assert.deepEqual(late, { ready: true, clusters: true }, 'start-up with Verovio ready before ' + held);
    await p2.close();
  }
  console.log('ok   start-up waits for both Verovio and the feature modules');

  assert.deepEqual(errors, []);
});

// Score mode without anything to match the live clip against (no Read, no export): it is placed at the play start
// marker, which Bitwig moves to a clip you select (how 'guess'), not at bar 1.
await withPage({ port: port + 2, mode: 'score' }, async ({ page, srv, errors }) => {
  await page.waitForFunction(() => window.SV && SV.state.liveData && document.querySelector('#paper svg'), { timeout: 30000 });
  srv.state.clipOffset = 8;
  const len = srv.state.data.length + 1;
  srv.setData({ length: len }); // another clip: Score View takes the play start marker again (selPlayStart once settled)
  // (the previous clip's guess may still be up for a moment: wait for this clip's)
  await page.waitForFunction(l => SV.state.liveData.length === l && SV.state.align && SV.state.align.how === 'guess' &&
    SV.state.align.key === SV.core.clipKey(SV.state.liveData), { timeout: 5000 }, len);
  assert.equal(await page.evaluate(() => SV.state.align.offset), 8);
  const first = await page.evaluate(() => {
    const t = SV.state.render.timeline.filter(e => SV.isLive(e.srcId)).sort((a, b) => a.start - b.start)[0];
    return t && t.start;
  });
  assert.ok(first >= 8, 'the live notes start at the play start marker, not bar 1: ' + first);
  console.log('ok   no Read: the live clip sits at the play start marker');

  // A clip switch: Bitwig swaps the notes first and reports the new track a moment later. The edited clip's
  // snapshot (overlay) must keep its own notes, never one of the next clip's. The track name comes 100 ms after the
  // notes here, inside the extension's (and the mock's) clip-switch quiet window (LiveSync.SWITCH_QUIET_MS = 200).
  await page.evaluate(() => { SV.state.editedTracks.add(SV.state.liveData.track); SV.render(); });
  await page.waitForFunction(() => [...SV.state.overlays.values()].some(o => o.track === 'Violin 1'), { timeout: 5000 });
  const before = await page.evaluate(() => [...SV.state.overlays.values()].find(o => o.track === 'Violin 1').notes.length);
  const notes0 = srv.state.data.notes.map(n => ({ ...n }));
  srv.setData({ notes: notes0.slice(0, 3).concat([{ ch: 0, x: 4, y: 99, d: 1, vel: 90 }]) }); // half switched, still 'Violin 1'
  await new Promise(r => setTimeout(r, 100));
  await page.evaluate(() => SV.render()); // a redraw while half switched (the old code took its snapshot then)
  srv.setData({ track: 'Viola', notes: [{ ch: 0, x: 4, y: 99, d: 1, vel: 90 }] });
  await new Promise(r => setTimeout(r, 1000));
  const snap = await page.evaluate(() => [...SV.state.overlays.values()].filter(o => o.track === 'Violin 1').map(o => o.notes.map(n => n.pitch)));
  assert.ok(snap.length === 1 && snap[0].length === before && !snap[0].includes(99), 'the snapshot keeps Violin 1 only: ' + JSON.stringify(snap));
  console.log('ok   clip switch: no notes of the next clip in the edited clip\'s snapshot');
  assert.deepEqual(errors, []);
});
console.log('core-e2e OK');
