// Score View page core: the engraving engine (SV.core.engrave), used by core/render.js.
// A job is { key, mei, opts (Verovio options), inline (glyph inlining) }; its result, the SVG string, is cached by key
// (a hash of the MEI and the options: core/chunks.js), so engraving the same chunk again costs nothing.
//   now(job)            engraves on the page's main thread at once (small jobs; the fallback) -> { ok, svg, log, ms }
//   request(jobs, fn)   engraves in Web Workers (core/engrave-worker.js), in the given order; fn(job, result) per job.
//                       A new request replaces the jobs still waiting (the latest render wins); jobs already running
//                       finish and are cached. Without workers (file://, a failed worker, localStorage
//                       scoreview.engraveWorker = false) the same queue runs on the main thread, one job per task.
//   cached(key)         { svg, h (px height) } or null      async()   true when workers are in use
//   stats()             counters for tests and tools/perf-bench.mjs
// The pool starts one worker when the page starts (core/start.js calls warm()) and adds more, up to MAX, while a long
// queue waits (a first full-score render), each with its own Verovio; the extra ones stop after a minute idle.
(function () {
  'use strict';
  const C = window.SV.core;
  const { store } = C;

  // ------------------------------------------------------------------ cache (least recently used out first)
  const cache = new Map();
  let chars = 0;
  const BUDGET = 64e6; // characters of SVG (a full Mega Man 2 score is ~10 M)
  const heightOf = svg => { const m = /<svg\b[^>]*?\bheight="([\d.]+)px"/.exec(svg); return m ? parseFloat(m[1]) : 0; };
  function cached(key) {
    const e = cache.get(key);
    if (!e) return null;
    cache.delete(key); cache.set(key, e); // most recently used last
    return e;
  }
  function put(key, svg) {
    if (cache.has(key)) return cache.get(key);
    const e = { svg, h: heightOf(svg) };
    cache.set(key, e);
    chars += svg.length;
    for (const [k, v] of cache) {
      if (chars <= BUDGET || cache.size <= 1) break;
      cache.delete(k); chars -= v.svg.length;
    }
    return e;
  }

  const stat = { worker: 0, main: 0, workerMs: 0, mainMs: 0, dropped: 0 };

  // ------------------------------------------------------------------ main thread
  function now(job) {
    const hit = cached(job.key);
    if (hit) return { ok: true, svg: hit.svg, cached: true };
    const tk = C.tk, t0 = performance.now();
    if (!tk) return { ok: false, svg: '', log: 'Verovio is not ready' };
    tk.resetOptions(); // setOptions merges: a chunk job's options must not carry over into the next job
    tk.setOptions(job.opts);
    if (!tk.loadData(job.mei)) return { ok: false, svg: '', log: tk.getLog() };
    let svg = '';
    for (let p = 1; p <= tk.getPageCount(); p++) svg += tk.renderToSVG(p);
    const t1 = performance.now();
    if (job.inline && window.SvgInline) svg = window.SvgInline.inlineGlyphs(svg);
    const ms = { engrave: Math.round(t1 - t0), inline: Math.round(performance.now() - t1) };
    stat.main++; stat.mainMs += ms.engrave + ms.inline;
    put(job.key, svg);
    return { ok: true, svg, ms };
  }

  // ------------------------------------------------------------------ workers
  const MAX = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  const IDLE_MS = 60000;  // idle workers beyond the first are stopped after this long
  let reapTimer = 0;
  function reap() {
    if (waiting.length) return;
    for (let i = workers.length - 1; i > 0; i--) {
      if (workers[i].job) continue;
      workers[i].w.terminate();
      workers.splice(i, 1);
    }
  }
  const workers = [];     // { w, ready, job }
  let broken = !window.Worker || store.get('engraveWorker', true) === false;
  let waiting = [];       // jobs not started yet, in order
  const running = new Map(); // key -> job running in a worker (or on the main thread fallback)
  let seq = 0, fallbackTimer = 0;

  function spawn() {
    if (broken || workers.length >= MAX) return;
    let w;
    try { w = new Worker('core/engrave-worker.js'); } catch (err) { fail(err); return; }
    const slot = { w, ready: false, job: null };
    workers.push(slot);
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'ready') { slot.ready = true; pump(); return; }
      const job = slot.job;
      slot.job = null;
      if (job && job.id === m.id) finish(job, m, 'worker');
      pump();
    };
    w.onerror = e => { e.preventDefault(); fail(e.message || 'worker failed'); };
    setTimeout(() => { if (!slot.ready && workers.includes(slot)) fail('the worker did not start'); }, 20000);
  }
  // A worker that cannot start (or crashes) turns the pool off: its jobs and the queue go to the main thread.
  function fail(err) {
    if (broken) return;
    console.warn('Score View: engraving worker unavailable, engraving on the page instead:', err);
    broken = true;
    workers.splice(0).forEach(s => {
      try { s.w.terminate(); } catch (e) { /* gone */ }
      if (s.job) { running.delete(s.job.key); waiting.unshift(s.job); }
    });
    pump();
  }
  function finish(job, m, where) {
    running.delete(job.key);
    const ok = !!(m.ok && m.svg);
    if (ok) put(job.key, m.svg);
    if (where === 'worker') { stat.worker++; stat.workerMs += (m.ms.load || 0) + (m.ms.render || 0) + (m.ms.inline || 0); }
    const res = { ok, svg: m.svg, log: m.log, ms: m.ms };
    job.done.forEach(fn => { try { fn(job, res); } catch (err) { console.error('engrave callback', err); } });
  }
  function pump() {
    if (broken) {
      if (!fallbackTimer && waiting.length) fallbackTimer = setTimeout(fallbackStep, 0);
      return;
    }
    if (waiting.length > workers.length && workers.length < MAX) spawn();
    // Each worker holds its own Verovio (tens of MB): the extra ones go after a while with nothing to do.
    clearTimeout(reapTimer);
    if (!waiting.length && workers.length > 1) reapTimer = setTimeout(reap, IDLE_MS);
    for (const s of workers) {
      if (!s.ready || s.job || !waiting.length) continue;
      const job = waiting.shift();
      s.job = job;
      job.id = ++seq;
      running.set(job.key, job);
      s.w.postMessage({ id: job.id, mei: job.mei, opts: job.opts, inline: job.inline });
    }
  }
  // No workers: one job per task, so the page stays responsive between chunks.
  function fallbackStep() {
    fallbackTimer = 0;
    const job = waiting.shift();
    if (!job) return;
    running.set(job.key, job);
    const r = now(job);
    finish(job, r, 'main');
    pump();
  }

  /** Engraves jobs (in this order) off the main thread; replaces what was still waiting. fn(job, result) per job. */
  function request(jobs, fn) {
    stat.dropped += waiting.length;
    waiting = [];
    jobs.forEach(j => {
      const hit = cached(j.key);
      if (hit) { fn(j, { ok: true, svg: hit.svg, cached: true }); return; }
      const run = running.get(j.key);
      if (run) { run.done.push(fn); return; }
      waiting.push({ key: j.key, mei: j.mei, opts: j.opts, inline: j.inline, done: [fn] });
    });
    pump();
  }

  /** Starts the first worker early, so its Verovio is compiled before the first big render. */
  function warm() { if (!broken && !workers.length) spawn(); }

  C.engrave = {
    now, request, cached, warm,
    async: () => !broken,
    stats: () => ({ ...stat, workers: workers.length, ready: workers.filter(s => s.ready).length, waiting: waiting.length,
                    running: running.size, cached: cache.size, cacheChars: chars, broken }),
    clearCache: () => { cache.clear(); chars = 0; },
  };
})();
