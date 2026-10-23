// Score View engraving worker (core/engrave.js starts one or more): Verovio off the page's main thread.
//   in:  { id, mei, opts (Verovio options), inline (glyph inlining, core/svg-inline.js) }
//   out: { type: 'ready' } once Verovio is up;
//        { type: 'done', id, svg, ok, log, ms: { load, render, inline } } per job, in the order received
// One job at a time; the page sends the next when one is done, so it can drop or reorder what is still waiting.
/* global importScripts, verovio, SvgInline */
'use strict';
importScripts('../vendor/verovio-toolkit-wasm.js', 'svg-inline.js');

let tk = null;
const waiting = [];

function run(job) {
  const t0 = performance.now();
  tk.resetOptions(); // setOptions merges: a chunk job's options must not carry over into the next job
  tk.setOptions(job.opts);
  const ok = tk.loadData(job.mei);
  const t1 = performance.now();
  let svg = '';
  if (ok) for (let p = 1; p <= tk.getPageCount(); p++) svg += tk.renderToSVG(p);
  const t2 = performance.now();
  if (ok && job.inline) svg = SvgInline.inlineGlyphs(svg);
  const t3 = performance.now();
  postMessage({ type: 'done', id: job.id, ok, svg, log: ok ? '' : tk.getLog(),
    ms: { load: Math.round(t1 - t0), render: Math.round(t2 - t1), inline: Math.round(t3 - t2) } });
}

function drain() {
  while (tk && waiting.length) {
    const job = waiting.shift();
    try { run(job); } catch (err) { postMessage({ type: 'done', id: job.id, ok: false, svg: '', log: String(err), ms: {} }); }
  }
}

self.onmessage = e => { waiting.push(e.data); drain(); };

function start() {
  tk = new verovio.toolkit();
  postMessage({ type: 'ready' });
  drain();
}
// Emscripten may already have finished (calledRun) by the time this line runs; otherwise wait for it.
if (verovio.module.calledRun) start();
else verovio.module.onRuntimeInitialized = start;
