// Feature module: passage. Sibelius-style passage selection and copy/paste between staves in Score mode.
//  Click an empty spot of a bar      → select that bar on that staff (light blue box)
//  Shift+click                       → extend across bars and staves · Ctrl+click → add / remove a staff · Esc clears
//  Ctrl+C / Ctrl+V                   → copy the passage / paste it at the selected bar (several staves land on
//                                       consecutive staves), written into the tracks' clips through the clip navigator
//                                       and Bitwig is LEFT on the first pasted clip with the pasted notes selected
//  Alt+click a bar                   → copy the selected passage there directly · R → repeat it after itself
//  Click a note on another staff     → make that track's clip live (Bitwig selects it)
// One navigator batch per paste: goto <clip> / del|dur|add … for each target clip, the first target last with
// gotoStay (ClipNavigator.java). Needs a live arrangement read (SV.state.crawl, features/arrangement.js).
// The pure core loads in Node for unit tests: require('web/features/passage.js').
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ pure core

  const EPS = 1e-6;
  const KS = 24; // keyswitches sit below C1
  const fmt = v => String(Math.round(v * 1e6) / 1e6);
  const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-6;
  const O = (typeof window !== 'undefined' && window.SV && window.SV.orchestrate)
    || (typeof require === 'function' ? require('./orchestrate.js') : null);

  /**
   * The passage after a click on bar `hit.bar` of staff `hit.track`. sel: {staves:[track], from, to, anchor:{track, bar}}
   * or null; order: the shown staves top-down. mode 'set' (click) | 'extend' (Shift: a rectangle from the anchor) |
   * 'add' (Ctrl: add or remove that staff, the bars stay). Returns the new passage, or null when nothing is left.
   */
  function selectAt(sel, hit, order, mode = 'set') {
    const one = { staves: [hit.track], from: hit.bar, to: hit.bar, anchor: { track: hit.track, bar: hit.bar } };
    if (!sel || mode === 'set') return one;
    if (mode === 'extend') {
      const a = sel.anchor || { track: sel.staves[0], bar: sel.from };
      let i = order.indexOf(a.track), j = order.indexOf(hit.track);
      if (i < 0 || j < 0) return one;
      if (i > j) [i, j] = [j, i];
      return { staves: order.slice(i, j + 1), from: Math.min(a.bar, hit.bar), to: Math.max(a.bar, hit.bar), anchor: a };
    }
    const had = sel.staves.includes(hit.track);
    const staves = order.filter(t => (t === hit.track ? !had : sel.staves.includes(t)));
    if (!staves.length) return null;
    return { ...sel, staves, anchor: sel.anchor && staves.includes(sel.anchor.track) ? sel.anchor : { track: staves[0], bar: sel.from } };
  }

  /**
   * Copies a passage. notesOf(track) -> [{start, dur, pitch, vel 0..1}] in arranger beats; span = {start, end} (beats).
   * Notes starting inside are kept, relative to the start, and shortened at the end (nothing rings past the passage).
   * Keyswitches (below C1) stay out unless opts.keyswitches.
   */
  function copyPassage(notesOf, sel, span, { keyswitches = false } = {}) {
    const { start, end } = span;
    const staves = sel.staves.map(track => ({
      track,
      notes: (notesOf(track) || [])
        .filter(n => n.start >= start - EPS && n.start < end - EPS && (keyswitches || n.pitch >= KS))
        .map(n => ({ start: n.start - start, dur: Math.max(0, Math.min(n.dur, end - n.start)), pitch: n.pitch, vel: n.vel == null ? 0.8 : n.vel }))
        .sort((a, b) => a.start - b.start || a.pitch - b.pitch),
    }));
    return { beats: end - start, bars: sel.to - sel.from + 1, from: sel.from, keyswitches: !!keyswitches, staves };
  }

  /**
   * Where a copy lands: staff k of the copy goes to tracks[k] (explicit list), or to the k-th staff from `track` down
   * in `order`. at = arranger beat of the destination. -> { targets:[{track, start, end, notes (arranger beats)}] } | {error}
   */
  function pasteTargets(copy, { track, tracks, order = [], at }) {
    let names = tracks;
    if (!names) {
      const i = order.indexOf(track);
      if (i < 0) return { error: `${track} is not a staff of this score` };
      names = order.slice(i, i + copy.staves.length);
      if (names.length < copy.staves.length) {
        return { error: `The copy has ${copy.staves.length} staves but only ${names.length} ${names.length === 1 ? 'staff' : 'staves'} from ${track} down — click a higher staff` };
      }
    }
    return { targets: copy.staves.map((s, k) => ({ track: names[k], start: at, end: at + copy.beats,
      notes: s.notes.map(n => ({ ...n, start: n.start + at })) })) };
  }

  /**
   * The edits for one clip: rows = its current notes [[ch, x, y, durBeats, vel]], spanEnd = its visible end (arranger
   * beats), region = {start, end} being pasted over, adds = [{ch, x, y, vel, d}] (orchestrate planTarget).
   * Overwrite clears the region first (notes starting in it are deleted, notes ringing into it are shortened to its
   * start); keyswitches are left alone unless opts.keyswitches. -> { lines, rows (the clip's notes afterwards) }.
   */
  function clipEdits(c, rows, spanEnd, region, adds, { mode = 'overwrite', keyswitches = false, spb = 24 } = {}) {
    const lines = [], out = [];
    const startOf = r => c.start + r[1] / spb - (c.playStart || 0);
    rows.forEach(r => {
      const s = startOf(r);
      const visible = r[1] / spb >= (c.playStart || 0) - EPS && s < spanEnd - EPS;
      const touch = mode === 'overwrite' && visible && (keyswitches || r[2] >= KS);
      if (touch && s >= region.start - EPS && s < region.end - EPS) { lines.push(`del ${r[0]} ${r[1]} ${r[2]}`); return; }
      if (touch && s < region.start - EPS && s + r[3] > region.start + EPS) {
        const d = region.start - s;
        lines.push(`dur ${r[0]} ${r[1]} ${r[2]} ${fmt(d)}`);
        out.push([r[0], r[1], r[2], d, r[4]]);
        return;
      }
      out.push(r.slice());
    });
    adds.forEach(a => {
      lines.push(`add ${a.ch} ${a.x} ${a.y} ${a.vel} ${fmt(a.d)}`);
      const row = [a.ch, a.x, a.y, a.d, a.vel], i = out.findIndex(r => r[0] === a.ch && r[1] === a.x && r[2] === a.y);
      if (i >= 0) out[i] = row; else out.push(row);
    });
    return { lines, rows: out };
  }

  /**
   * Plans a paste into the arrangement read: targets from pasteTargets. opts: { clipEnd, measureBeats, rowsOf(clip) ->
   * current rows, mode, keyswitches }. -> { jobs:[{track, clip, lane, lines, rows, adds}], stay (the job Bitwig is left
   * on: the first target's first clip), errors:[{track, error}] }. Nothing is planned for a target with nothing to do.
   */
  function planPaste(crawl, targets, { clipEnd, measureBeats = 4, rowsOf = c => c.notes, mode = 'overwrite', keyswitches = false } = {}) {
    const spb = crawl.stepsPerBeat || 24;
    const index = O.clipIndex(crawl, clipEnd);
    const jobs = [], errors = [];
    targets.forEach(t => {
      const spans = index.get(t.track) || [];
      const hit = spans.filter(sp => sp.clip.start < t.end - EPS && sp.end > t.start + EPS);
      const looping = hit.find(sp => sp.end > O.firstPassEnd(sp.clip) + EPS);
      if (looping && (t.notes.length || mode === 'overwrite')) {
        errors.push({ track: t.track, error: `The clip on ${t.track} at bar ${O.barOf(looping.clip.start, measureBeats)} loops — a paste would repeat in every pass. Consolidate it (or turn its loop off) in Bitwig first` });
        return;
      }
      let writes = [];
      if (t.notes.length) {
        const p = O.planTarget(crawl, t.track, t.notes, { clipEnd, measureBeats, index });
        if (p.error) { errors.push({ track: t.track, error: p.error }); return; }
        writes = p.writes;
      }
      if (!hit.length && !writes.length) return;
      hit.forEach(sp => {
        const w = writes.find(x => x.clip === sp.clip);
        const adds = w ? w.adds : [];
        const e = clipEdits(sp.clip, rowsOf(sp.clip), sp.end, t, adds, { mode, keyswitches, spb });
        if (e.lines.length) jobs.push({ track: t.track, clip: sp.clip, lane: sp.clip.lane, lines: e.lines, rows: e.rows, adds });
      });
    });
    const first = targets.length ? jobs.find(j => j.track === targets[0].track) : null;
    return { jobs, stay: first || jobs[0] || null, errors };
  }

  /** The navigator batch: every other clip with goto, the stay clip last with gotoStay (its edits after it). */
  function batchLines(jobs, stay) {
    const lines = [];
    const nav = (op, j) => `${op} ${j.lane} ${j.clip.start} ${encodeURIComponent(j.track)}`;
    jobs.filter(j => j !== stay).forEach(j => { lines.push(nav('goto', j)); lines.push(...j.lines); });
    if (stay) { lines.push(nav('gotoStay', stay)); lines.push(...stay.lines); }
    return lines;
  }

  /**
   * Which jobs landed: /api/nav results hold one entry per goto/gotoStay, in batch order ('ok: goto …', 'error: stay …').
   * -> [true|false] per job in batch order (other jobs first, the stay job last). A refused batch fails them all.
   */
  function landedJobs(results, count) {
    const list = (results || []).filter(r => /^(ok|error): (goto|stay) /.test(r));
    return Array.from({ length: count }, (_, i) => !!list[i] && list[i].startsWith('ok'));
  }

  const sigOf = c => (c.notes || []).map(r => r[1] + ':' + r[2] + ':' + Math.round(r[3] * 1000)).sort().join(',');
  /** Clips that look like aliases of a target clip (same notes and play range, elsewhere): a paste changes them too. */
  function aliasWarnings(crawl, jobs, measureBeats = 4) {
    const out = [];
    jobs.forEach(j => {
      const c = j.clip;
      if (!c.notes || !c.notes.length) return;
      const s = sigOf(c);
      (crawl.result || []).forEach(o => {
        if (o === c || !o.notes || !o.notes.length || !near(o.playStart, c.playStart) || !near(o.playStop, c.playStop) || sigOf(o) !== s) return;
        out.push(`${o.track} bar ${O.barOf(o.start, measureBeats)} has the same notes as the ${c.track} clip at bar ${O.barOf(c.start, measureBeats)} — if it is a clip alias it changed too (⟳ Read project to see it)`);
      });
    });
    return [...new Set(out)];
  }

  const Core = { selectAt, copyPassage, pasteTargets, clipEdits, planPaste, batchLines, landedJobs, aliasWarnings, KS };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
  const SV = root.SV;
  if (!SV) return;

  // ------------------------------------------------------------------ page integration

  const S = SV.state, SB = SV.ScoreBuilder;
  const $ = id => document.getElementById(id);
  const PREF_KEY = 'scoreview.passage.prefs', CLIP_KEY = 'scoreview.passage.clipboard';
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  // click: an empty spot of a bar selects it ('select') or only clears the note selection ('off').
  // mode: paste 'overwrite' (clear the destination bars first) | 'merge'. keyswitches: copies include them.
  // altClick: Alt+click a bar with a passage selected copies it there ('copy') or plays from the bar ('play').
  // noteClick: a click on another staff's note makes its clip live ('live') or only says it is read-only ('off').
  // emptyStaves: after a read, tracks whose clips are all empty get a staff too, so they can be pasted into (off by
  // default: Score mode shows the tracks with notes).
  const prefs = Object.assign({ click: 'select', mode: 'overwrite', keyswitches: false, altClick: 'copy', noteClick: 'live', emptyStaves: false }, load(PREF_KEY, {}));
  const savePrefs = () => save(PREF_KEY, prefs);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const isLivePage = () => location.protocol.startsWith('http');
  const entryOn = () => !!(SV.entry && SV.entry.state && SV.entry.state.on);
  const orc = () => SV.orchestrate || {};

  let sel = null;                       // { staves:[track], from, to, anchor:{track, bar} }
  let clipboard = load(CLIP_KEY, null); // copyPassage() result
  let lastCopy = clipboard ? 'passage' : null; // 'passage' | 'notes' (features/mouse.js copied notes since)
  let busy = false, lastReport = null;

  const crawlOk = () => (S.crawl && S.base && S.base.source === 'crawl' ? S.crawl : null);
  const clipEndFn = () => (SV.arrangement && SV.arrangement.clipEnd) || ((c, next) => (next ? next.start : c.start + c.playStop - c.playStart));
  const measureBeats = () => { const ts = (S.base && S.base.timeSig) || { num: 4, den: 4 }; return ts.num * 4 / ts.den; };
  const trackOf = part => String(part || '').replace(/\s*✎$/, '');
  // The shown staves top-down, one entry per track (a grand staff has two staves).
  function staffOrder() {
    const r = S.render;
    return r ? [...new Set(r.staves.map(s => trackOf(s.part)))] : [];
  }
  const staffNums = track => (S.render ? S.render.staves.filter(s => trackOf(s.part) === track).map(s => s.n) : []);
  const barSpan = n => (S.render ? SB.measureSpan(S.render, n) : { start: (n - 1) * measureBeats(), beats: measureBeats() });
  const spanOf = p => ({ start: barSpan(p.from).start, end: barSpan(p.to).start + barSpan(p.to).beats });
  const barText = p => (p.from === p.to ? 'bar ' + p.from : 'bars ' + p.from + '–' + p.to);

  // Notes of a staff in arranger beats, as shown: the base, edited clips' snapshots, the live clip in its place.
  function staffNotes(track) {
    const base = S.base && S.base.parts.find(p => p.name === track);
    let notes = base ? base.notes.map(n => ({ start: n.start, dur: n.dur, pitch: n.pitch, vel: n.vel == null ? 0.8 : n.vel })) : [];
    const d = S.liveData, a = S.align, liveHere = d && d.exists && a && d.track === track;
    S.overlays.forEach(o => {
      if (o.track !== track || (liveHere && near(o.offset, a.offset))) return;
      notes = notes.filter(n => n.start < o.offset - EPS || n.start >= o.offset + o.length - EPS)
        .concat(o.notes.map(n => ({ start: n.start, dur: n.dur, pitch: n.pitch, vel: 0.8 })));
    });
    if (liveHere) {
      const spb = d.stepsPerBeat || 24, ps = d.playStart || 0, vis = Math.max(0, d.length - ps);
      notes = notes.filter(n => n.start < a.offset - EPS || n.start >= a.offset + vis - EPS)
        .concat(d.notes.map(n => ({ start: a.offset + n.x / spb - ps, dur: n.d, pitch: n.y, vel: (n.vel == null ? 100 : n.vel) / 127 }))
          .filter(n => n.start >= a.offset - EPS && n.start < a.offset + vis - EPS));
    }
    return notes;
  }

  // The current notes of a crawled clip: the live clip's own notes, an edited clip's snapshot, else the read.
  function rowsOf(c) {
    const d = S.liveData, a = S.align;
    if (d && d.exists && a && d.track === c.track && Math.abs(a.offset - c.start) < 1e-3) {
      return d.notes.map(n => [n.ch, n.x, n.y, n.d, n.vel == null ? 100 : n.vel]);
    }
    const o = S.overlays.get(c.track + '@' + c.start);
    if (o) {
      const spb = (S.crawl && S.crawl.stepsPerBeat) || 24;
      const vel = new Map(c.notes.map(r => [r[0] + '_' + r[1] + '_' + r[2], r[4]]));
      const hidden = c.notes.filter(r => r[1] / spb < (c.playStart || 0) - EPS); // before the visible start: not in the snapshot
      return hidden.map(r => r.slice()).concat(o.notes.filter(n => SV.isLive(n.id)).map(n => {
        const p = SV.parseId(n.id);
        return [p.ch, p.x, p.y, n.dur, vel.has(p.ch + '_' + p.x + '_' + p.y) ? vel.get(p.ch + '_' + p.x + '_' + p.y) : 100];
      }));
    }
    return c.notes.map(r => r.slice());
  }

  // ------------------------------------------------------------------ selection

  function setSel(next, quiet) {
    sel = next;
    paint();
    renderPanel();
    if (sel && !quiet) SV.flash(barText(sel).replace(/^b/, 'B') + ' · ' + sel.staves.join(', ') + ' — Ctrl+C copies');
  }
  const clear = () => { if (sel) setSel(null, true); };

  SV.addStyle(`
    #pas-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: var(--sv-z-overlay, 5); }
    #pas-layer .pas-box { position: absolute; background: #4dabf72e; border: 1.5px solid #1c7ed6b3; border-radius: 2px; }
    .pas { position: relative; }
    .pas-panel { position: fixed; z-index: var(--sv-z-pop, 40); width: 380px; max-width: calc(100vw - 32px); background: var(--sv-surface-2);
      border: 1px solid var(--sv-border); border-radius: var(--sv-radius-md); padding: 10px 12px; box-shadow: var(--sv-shadow-pop);
      color: var(--sv-text); font-size: var(--sv-fs-body); }
    .pas-panel h4 { margin: 8px 0 4px; font-size: var(--sv-fs-label); font-weight: 600; color: var(--sv-text-dim); text-transform: uppercase; letter-spacing: .04em; }
    .pas-panel label { display: block; margin: 3px 0; }
    .pas-info { color: var(--sv-text-dim); font-size: var(--sv-fs-control); white-space: pre-line; }
    .pas-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
    .pas-status { margin-top: 6px; font-size: var(--sv-fs-control); }
    .pas-status.bad { color: var(--sv-warn); }
  `);

  function layer() {
    let L = $('pas-layer');
    if (!L) { L = document.createElement('div'); L.id = 'pas-layer'; $('main').appendChild(L); }
    return L;
  }
  function staffBox(stEl) {
    const lines = SV.geom.rects(stEl.querySelectorAll(':scope > path')).filter(b => b.width > 20).sort((a, b) => a.top - b.top);
    if (lines.length < 5) return null;
    const gap = (lines[4].top - lines[0].top) / 4;
    return { left: lines[0].left, right: lines[0].right, top: lines[0].top - gap * 1.5, bottom: lines[4].bottom + gap * 1.5 };
  }
  // Light blue boxes: one per staff and system row of the selected bars.
  function paint() {
    const L = layer();
    if (!sel || !S.render || S.mode !== 'score') { L.innerHTML = ''; return; }
    const m = $('main'), mr = m.getBoundingClientRect();
    let html = '';
    const put = b => {
      if (!b) return;
      html += `<div class="pas-box" style="left:${b.left - mr.left + m.scrollLeft}px;top:${b.top - mr.top + m.scrollTop}px;width:${b.right - b.left}px;height:${b.bottom - b.top}px"></div>`;
    };
    sel.staves.forEach(track => staffNums(track).forEach(n => {
      let run = null;
      for (let bar = sel.from; bar <= sel.to; bar++) {
        const st = document.getElementById('m' + bar + 's' + n), b = st && staffBox(st);
        if (!b) { put(run); run = null; continue; }
        if (run && Math.abs(run.top - b.top) < 2 && b.left - run.right < 40) run.right = b.right;
        else { put(run); run = b; }
      }
      put(run);
    }));
    L.innerHTML = html;
  }

  // ------------------------------------------------------------------ copy / paste

  function copyNow(p = sel) {
    return Core.copyPassage(staffNotes, p, spanOf(p), { keyswitches: prefs.keyswitches });
  }
  function copy() {
    if (!sel) return null;
    clipboard = copyNow();
    lastCopy = 'passage';
    save(CLIP_KEY, clipboard);
    const n = clipboard.staves.reduce((s, x) => s + x.notes.length, 0);
    const msg = `Copied ${barText(sel)} of ${sel.staves.length === 1 ? sel.staves[0] : sel.staves.length + ' staves'} (${n} note${n === 1 ? '' : 's'})`
      + (crawlOk() ? '' : ' — ⟳ Read project before pasting into Bitwig');
    status(msg);
    SV.flash(msg);
    renderPanel();
    return clipboard;
  }

  // Why a write into Bitwig cannot start now (null = it can).
  async function precheck() {
    if (S.mode !== 'score') return 'Switch to Score mode to paste between staves';
    if (!crawlOk()) return 'Pasting between staves writes through the clip list of the last ⟳ Read project — read it first';
    if (!isLivePage()) return 'Not connected to Bitwig';
    if (busy || (orc().isBusy && orc().isBusy())) return 'Busy writing into Bitwig — wait for it to finish';
    if (S.playing) return 'Stop playback first';
    const d = S.liveData;
    if (!d || !d.exists) return 'Click a clip in the Arranger first (Bitwig needs the timeline focus to move between clips)';
    if (d.source !== 'arranger') return 'Score View must follow the Arranger: click a clip in the Arranger first';
    try { if ((await (await fetch('/api/transport', { cache: 'no-store' })).json()).playing) return 'Stop playback first'; } catch (e) { /* the nav refuses too */ }
    return null;
  }
  // The last read is out of date for these tracks (arrangement.js heuristic): refuse rather than clear the wrong notes.
  // Every reason that names a target track counts (changed, a clip that may have moved, an unsure clip, heard while
  // playing), and the track list.
  function staleFor(tracks) {
    const why = SV.arrangement && SV.arrangement.staleReasons ? SV.arrangement.staleReasons() : [];
    const hit = why.filter(r => /^tracks /.test(r) || tracks.some(t => r === t + ' changed' || r.startsWith(t + ': ') || r.startsWith(t + ' changed at bar ')));
    return hit.length ? `The last read is out of date (${hit.join('; ')}) — refresh it (the ● next to ⟳ Read) before pasting` : null;
  }
  // A read restored from storage (arrangement.js): clips not seen in Bitwig since may have changed while the page was
  // closed; a paste would clear and write them from old notes and bounds.
  function unconfirmedFor(jobs) {
    const un = SV.arrangement && SV.arrangement.unconfirmed ? SV.arrangement.unconfirmed(jobs.map(j => j.clip)) : [];
    if (!un.length) return null;
    const mb = measureBeats(), info = SV.arrangement.mirrorInfo();
    const list = un.map(c => `${c.track} bar ${Math.floor(c.start / mb + 1e-6) + 1}`).join(', ');
    return `The read was restored from ${new Date(info.readAt).toLocaleString()} and these clips have not been seen since ` +
      `(Bitwig may have changed them meanwhile): ${list} — click each in Bitwig once, or ⟳ Read project, then paste`;
  }

  async function runBatch(lines) {
    const nav = async () => (await fetch('/api/nav', { cache: 'no-store' })).json();
    const before = (await nav()).batches;
    await fetch('/api/edit', { method: 'POST', body: lines.join('\n') });
    const deadline = Date.now() + 20000 + lines.length * 50;
    while (Date.now() < deadline) {
      await sleep(120);
      const st = await nav();
      if (st.batches > before && !st.session) return st;
      if (st.state === 'running' || st.session) status((st.message || 'Moving between clips') + '…');
    }
    return { state: 'error', message: 'No answer from the extension (timeout)', results: [] };
  }

  // The crawl takes in what Score View shows for edited clips (snapshots, the live clip): the base is rebuilt from it.
  function syncCrawl(crawl) {
    crawl.result.forEach(c => {
      const d = S.liveData, a = S.align;
      const live = d && d.exists && a && d.track === c.track && Math.abs(a.offset - c.start) < 1e-3;
      if (live || S.overlays.has(c.track + '@' + c.start)) c.notes = rowsOf(c);
    });
  }

  /**
   * Pastes `copy` (copyPassage result) at bar `bar`: onto `opts.tracks`, or onto consecutive staves from `opts.track`.
   * Leaves Bitwig on the first target's clip with the pasted notes selected and the passage on the destination.
   * Returns the report { done, failed, info, error? }.
   */
  async function pasteAt(copyData, bar, opts = {}) {
    if (!copyData || !copyData.staves.some(s => s.notes.length) && prefs.mode !== 'overwrite') return report({ error: 'Nothing to paste' });
    const why = await precheck();
    if (why) return report({ error: why });
    const crawl = crawlOk(), at = barSpan(bar).start, mb = measureBeats();
    const t = Core.pasteTargets(copyData, { track: opts.track, tracks: opts.tracks, order: staffOrder(), at });
    if (t.error) return report({ error: t.error });
    const stale = staleFor(t.targets.map(x => x.track));
    if (stale) return report({ error: stale });
    const plan = Core.planPaste(crawl, t.targets, { clipEnd: clipEndFn(), measureBeats: mb, rowsOf, mode: prefs.mode, keyswitches: copyData.keyswitches });
    if (plan.errors.length) return report({ error: 'Nothing pasted — ' + plan.errors.map(e => e.error).join(' · ') });
    if (!plan.jobs.length) return report({ error: 'Nothing to change there' });
    const unseen = unconfirmedFor(plan.jobs);
    if (unseen) return report({ error: unseen });
    const info = Core.aliasWarnings(crawl, plan.jobs, mb);
    busy = true;
    setBusy(true);
    try {
      const order = plan.jobs.filter(j => j !== plan.stay).concat(plan.stay ? [plan.stay] : []);
      status('Pasting into ' + [...new Set(order.map(j => j.track))].join(', ') + '…');
      const st = await runBatch(Core.batchLines(plan.jobs, plan.stay));
      const ok = Core.landedJobs(st.results, order.length);
      const done = [], failed = [];
      syncCrawl(crawl);
      order.forEach((j, i) => {
        if (ok[i]) { j.clip.notes = j.rows; done.push(j.track); } else failed.push(j.track);
      });
      if (!done.length) {
        const msg = (st.results || []).filter(r => !r.startsWith('ok')).join('; ') || st.message;
        return report({ error: 'Nothing pasted — ' + msg });
      }
      orc().rebuildBase(crawl, [...new Set(done)]);
      const last = bar + copyData.bars - 1, tracks = t.targets.map(x => x.track);
      const inOrder = list => tracks.filter(x => list.includes(x)); // score order, not batch order
      if (plan.stay && ok[order.length - 1]) {
        const ids = plan.stay.adds.map(a => 'L' + a.ch + '_' + a.x + '_' + a.y);
        expectClip({ track: plan.stay.track, start: plan.stay.clip.start, ids, clip: plan.stay.clip });
      }
      setSel({ staves: tracks, from: bar, to: last, anchor: { track: tracks[0], bar } }, true);
      const where = (bar === last ? 'bar ' + bar : 'bars ' + bar + '–' + last);
      return report({ done: [`Pasted into ${inOrder(done).join(', ')}, ${where}`], failed: failed.length ? [`${inOrder(failed).join(', ')}: ${st.message}`] : [], info });
    } finally {
      busy = false;
      setBusy(false);
    }
  }
  function paste() {
    if (!clipboard) return Promise.resolve(report({ error: 'Nothing copied yet: select bars and press Ctrl+C' }));
    if (!sel) return Promise.resolve(report({ error: 'Click the bar to paste at (on the top staff it should go to)' }));
    return pasteAt(clipboard, sel.from, { track: sel.staves[0] });
  }
  /** Copies the selected passage to bar `bar` of `track` (and the staves below), leaving the clipboard alone (Alt+click). */
  function copyTo(track, bar) {
    if (!sel) return Promise.resolve(report({ error: 'Select a passage first' }));
    return pasteAt(copyNow(), bar, { track });
  }
  /** Repeats the selected passage right after itself, on the same staves (R). */
  function repeat() {
    if (!sel) return Promise.resolve(report({ error: 'Select a passage first' }));
    return pasteAt(copyNow(), sel.to + 1, { tracks: sel.staves.slice() });
  }

  // ------------------------------------------------------------------ landing on a clip (Q1b / F1)

  let expecting = null; // { track, start, ids, clip, until }
  /**
   * Once Bitwig reports the clip of `track` that starts at arranger beat `start` (after a gotoStay), places it there
   * in the score and selects `ids` (live note ids) so the arrow keys work on them straight away. Gives up after 20 s.
   */
  function expectClip({ track, start, ids = [], clip = null, timeout = 20000 }) {
    expecting = { track, start, ids: ids.slice(), clip, until: Date.now() + timeout };
    landed(S.liveData);
  }
  function landed(d) {
    const x = expecting;
    if (!x) return;
    if (Date.now() > x.until) { expecting = null; return; }
    if (!d || !d.exists || d.track !== x.track) return;
    if (x.clip && !(near(d.playStart, x.clip.playStart) && near(d.length, x.clip.playStop))) return; // another clip of that track
    const present = new Set(d.notes.map(SV.liveId));
    if (x.ids.length && !x.ids.some(id => present.has(id))) return; // not this clip yet
    expecting = null;
    const key = SV.core && SV.core.clipKey ? SV.core.clipKey(d) : null;
    if (key) S.align = { track: d.track, key, offset: x.start, how: 'manual', cands: [] };
    S.selection = new Set(x.ids.filter(id => present.has(id)));
    SV.expectIds(x.ids.filter(id => !present.has(id)));
    SV.paintSelection();
    SV.requestRender();
    const main = $('main');
    if (main && !(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) main.focus();
  }
  SV.hooks.liveData.push(landed);

  // F1: a click on a note of another staff (or another clip of this one) makes that clip live.
  async function makeLive(t) {
    const crawl = crawlOk();
    if (!crawl) return false;
    const el = document.getElementById(t.svgId), stEl = el && el.closest('g.staff');
    const n = stEl ? parseInt((stEl.id.match(/s(\d+)$/) || [])[1], 10) : NaN;
    const staff = S.render.staves.find(s => s.n === n);
    if (!staff) return false;
    const track = trackOf(staff.part);
    const first = (S.render.bySrc.get(t.srcId) || [t]).reduce((a, b) => (b.start < a.start ? b : a));
    const beat = first.start;
    const spans = orc().clipIndex(crawl, clipEndFn()).get(track) || [];
    const sp = spans.find(s => s.clip.start <= beat + EPS && beat < s.end - EPS);
    if (!sp) { SV.flash(`No clip of ${track} found under this note — ⟳ Read project again`); return true; }
    const why = await precheck();
    if (why && !/^Pasting between staves/.test(why)) { SV.flash(why); return true; }
    const c = sp.clip, spb = crawl.stepsPerBeat || 24;
    const part = S.render.score && S.render.score.parts.find(p => trackOf(p.name) === track);
    const note = part && part.notes.find(q => q.id === t.srcId);
    const x = Math.round((beat - c.start + (c.playStart || 0)) * spb);
    const row = note && rowsOf(c).find(r => r[1] === x && r[2] === note.pitch);
    SV.flash(`Opening ${track} at bar ${orc().barOf(c.start, measureBeats())}…`);
    busy = true;
    try {
      const st = await runBatch([`gotoStay ${c.lane} ${c.start} ${encodeURIComponent(track)}`]);
      if (!st.stayed) { SV.flash('Could not select that clip: ' + (st.message || 'no answer')); return true; }
      expectClip({ track, start: c.start, ids: row ? ['L' + row[0] + '_' + row[1] + '_' + row[2]] : [], clip: c });
    } finally { busy = false; }
    return true;
  }

  // ------------------------------------------------------------------ mouse and keys

  SV.hooks.paperClick.push((e, hit) => {
    if (prefs.click !== 'select' || S.mode !== 'score' || entryOn() || e.button !== 0) return false;
    if (!hit) { clear(); return false; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey && !sel) return false; // Shift+press on empty paper: a marquee that adds notes (features/mouse.js)
    const next = Core.selectAt(sel, { track: trackOf(hit.part), bar: hit.measure }, staffOrder(), ctrl ? 'add' : e.shiftKey ? 'extend' : 'set');
    if (S.selection.size) { S.selection.clear(); SV.paintSelection(); }
    setSel(next, true);
    $('main').focus();
    return true;
  });
  SV.hooks.noteClick.push((t, e) => {
    clear(); // a note selection replaces the passage
    if (SV.isLive(t.srcId) || prefs.noteClick !== 'live' || S.mode !== 'score' || entryOn() || e.button !== 0 || busy || !crawlOk()) return false;
    makeLive(t);
    return true;
  });

  // Alt+click a bar with a passage selected: copy it there. Runs before playback.js's Alt+click (play from the bar,
  // a capture listener on the document) and mouse.js's Alt+drag of a selected note (passage and note selection exclude
  // each other); bar numbers still play. Without a read, or while playing, no copy can be written, so Alt+click stays
  // playback.js's (a plain bar click selects a passage: taking Alt+click then would quietly lose play-from-bar).
  window.addEventListener('mousedown', e => {
    if (!e.altKey || e.button !== 0 || !sel || prefs.altClick !== 'copy' || S.mode !== 'score' || entryOn() || !S.render) return;
    if (!crawlOk() || S.playing) return;
    if (!e.target.closest || !e.target.closest('#paper') || e.target.closest('#paper g.mNum')) return;
    const hit = SV.hitTest(e);
    if (!hit) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    copyTo(trackOf(hit.part), hit.measure);
  }, true);

  SV.hooks.keydown.push(e => {
    if (e.key === 'Escape' && panelOpen()) { closePanel(); return true; }
    if (!sel || S.mode !== 'score' || entryOn()) return false;
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') { clear(); return false; } // the core then clears a note selection too
    // Keys that select notes (core: Ctrl+A, Tab / Shift+Tab) replace the passage, as a note click does, so the Ctrl+C
    // after them copies those notes (features/mouse.js), not the passage.
    if ((ctrl && !e.altKey && !e.shiftKey && k === 'a') || (e.key === 'Tab' && !ctrl && !e.altKey)) { clear(); return false; }
    if (ctrl && !e.altKey && !e.shiftKey && k === 'c') { copy(); return true; }
    if (ctrl && !e.altKey && !e.shiftKey && k === 'v' && clipboard && lastCopy === 'passage') { if (!e.repeat) paste(); return true; }
    if (!ctrl && !e.altKey && !e.shiftKey && k === 'r') { if (!e.repeat) repeat(); return true; }
    return false;
  });
  // Tracks with only empty clips have no part in the read's base (arrangement.js keeps tracks with notes); with the
  // preference on they get an empty one, in track order, so a paste can target them.
  function addEmptyParts() {
    const b = S.base, crawl = S.crawl;
    if (!prefs.emptyStaves || !b || b.source !== 'crawl' || !crawl || !crawl.result || b.passageEmpty === crawl) return false;
    b.passageEmpty = crawl;
    const have = new Set(b.parts.map(p => p.name));
    const missing = [...new Set(crawl.result.map(c => c.track))].filter(t => !have.has(t));
    if (!missing.length) return false;
    const groupOf = new Map(), order = [];
    let g = null;
    (crawl.tracks || []).forEach(t => { if (t.group) g = t.name; else { if (!groupOf.has(t.name)) groupOf.set(t.name, g); order.push(t.name); } });
    missing.forEach(name => b.parts.push({ name, group: groupOf.get(name) || undefined, notes: [], empty: true }));
    const at = name => (order.indexOf(name) + 1) || 1e9;
    b.parts.sort((p, q) => at(p.name) - at(q.name));
    return true;
  }
  // Hide empty staves would hide exactly those staves again: while some are shown, nothing is condensed.
  SV.hooks.buildOptions.push((buildOpts, vrvOpts, score) => {
    if (prefs.emptyStaves && S.mode === 'score' && S.base && S.base.parts.some(p => p.empty) && score.parts.some(p => !p.notes.length)) vrvOpts.condense = 'none';
  });
  SV.hooks.afterRender.push(() => {
    if (S.mode !== 'score') sel = null;
    if (addEmptyParts()) { SV.renderTrackList(); SV.requestRender(); return; }
    paint();
  });
  window.addEventListener('resize', () => setTimeout(paint, 250));

  if (SV.shortcuts) {
    const when = 'passage selected';
    SV.shortcuts.register({ keys: 'Ctrl+C', owner: 'passage', desc: 'copy the selected bars (every selected staff)', when });
    SV.shortcuts.register({ keys: 'Ctrl+V', owner: 'passage', desc: 'paste the copied bars here, into Bitwig (stays on the pasted clip)', when });
    SV.shortcuts.register({ keys: 'R', owner: 'passage', desc: 'repeat the selected bars after themselves', when });
    SV.shortcuts.register({ keys: 'Escape', owner: 'passage', desc: 'clear the passage selection', when });
  }
  SV.addHelp('<b>Passage</b> (Score mode) click an empty spot of a bar: select it · <kbd>Shift</kbd>+click extends · <kbd>Ctrl</kbd>+click adds a staff · '
    + '<kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> copy / paste between staves · <kbd>Alt</kbd>+click a bar: copy there · '
    + '<kbd>R</kbd> repeat · click another staff\'s note: make its clip live (needs ⟳ Read project)');

  // ------------------------------------------------------------------ toolbar panel (preferences)

  const group = SV.addToolbar('<div class="pas"><button class="btn" id="pasBtn" title="Passage selection and copy/paste between staves (Score mode): click a bar, Ctrl+C, click a bar on another staff, Ctrl+V">Passage ▾</button>'
    + '<div class="pas-panel hidden" id="pasPanel"></div></div>', { cluster: 'write', order: 75 });
  const panel = group.querySelector('#pasPanel');
  const panelOpen = () => !panel.classList.contains('hidden');
  const closePanel = () => panel.classList.add('hidden');
  let statusText = '', statusBad = false;

  function renderPanel() {
    if (!panelOpen()) return;
    const cb = clipboard;
    const info = (sel ? `Selected: ${barText(sel)} · ${sel.staves.join(', ')}` : 'Click an empty spot of a bar to select it; Shift+click extends, Ctrl+click adds a staff.')
      + '\n' + (cb ? `Copied: ${cb.bars} bar${cb.bars === 1 ? '' : 's'} × ${cb.staves.length} ${cb.staves.length === 1 ? 'staff' : 'staves'} (${cb.staves.map(s => s.track).join(', ')})` : 'Nothing copied yet.')
      + (crawlOk() ? '' : '\nPasting needs ⟳ Read project (it writes through the clip list of the read).');
    panel.innerHTML = `
      <div class="pas-info" id="pasInfo">${esc(info)}</div>
      <div class="pas-row"><button class="btn" id="pasCopy" ${sel ? '' : 'disabled'}>Copy</button>
        <button class="btn" id="pasPaste" ${sel && cb ? '' : 'disabled'}>Paste here</button>
        <button class="btn" id="pasRepeat" ${sel ? '' : 'disabled'} title="R">Repeat</button></div>
      <h4>Preferences</h4>
      <label>Paste <select id="pasMode"><option value="overwrite" ${prefs.mode === 'overwrite' ? 'selected' : ''}>overwrites the bars (recommended)</option>
        <option value="merge" ${prefs.mode === 'merge' ? 'selected' : ''}>merges with what is there</option></select></label>
      <label title="Notes below C1 (articulation keyswitches) belong to the destination's own sound"><input type="checkbox" id="pasKs" ${prefs.keyswitches ? '' : 'checked'}> Leave keyswitches out of copies</label>
      <label><input type="checkbox" id="pasClick" ${prefs.click === 'select' ? 'checked' : ''}> Click an empty spot of a bar to select it</label>
      <label><input type="checkbox" id="pasAlt" ${prefs.altClick === 'copy' ? 'checked' : ''}> Alt+click a bar copies the selected passage there (off: plays from the bar)</label>
      <label><input type="checkbox" id="pasLive" ${prefs.noteClick === 'live' ? 'checked' : ''}> Click a note on another staff to make its clip live</label>
      <label title="After ⟳ Read project, tracks whose clips have no notes yet get a staff too, so you can paste into them (Hide empty staves is set aside while they are shown)"><input type="checkbox" id="pasEmpty" ${prefs.emptyStaves ? 'checked' : ''}> Show tracks with empty clips (to paste into)</label>
      <div class="pas-status ${statusBad ? 'bad' : ''}" id="pasStatus">${esc(statusText)}</div>
      <div class="pas-row" style="justify-content:flex-end"><button class="btn" id="pasClose">Close</button></div>`;
  }
  function status(t, bad) {
    statusText = t; statusBad = !!bad;
    const el = panel.querySelector('#pasStatus');
    if (el) { el.textContent = t; el.classList.toggle('bad', !!bad); }
  }
  function setBusy(on) {
    panel.querySelectorAll('#pasPaste, #pasRepeat').forEach(b => { b.disabled = on || !sel; });
  }
  function report(r) {
    let msg;
    if (r.error) msg = r.error;
    else msg = [...(r.done || []), ...(r.failed && r.failed.length ? ['Not written — ' + r.failed.join(' · ')] : []), ...(r.info || [])].join('. ') || 'Nothing pasted';
    status(msg, !!(r.error || (r.failed && r.failed.length)));
    SV.flash(msg.length > 160 ? msg.slice(0, 157) + '…' : msg);
    lastReport = { ...r, message: msg };
    renderPanel();
    return lastReport;
  }

  group.querySelector('#pasBtn').addEventListener('click', e => {
    if (panelOpen()) closePanel();
    else {
      panel.classList.remove('hidden');
      renderPanel();
      const b = group.querySelector('#pasBtn').getBoundingClientRect();
      panel.style.top = Math.round(b.bottom + 4) + 'px';
      panel.style.left = Math.round(Math.max(16, Math.min(b.left, window.innerWidth - panel.offsetWidth - 16))) + 'px';
    }
    e.stopPropagation();
  });
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); e.stopPropagation(); });
  panel.addEventListener('change', e => {
    const id = e.target.id;
    if (id === 'pasMode') prefs.mode = e.target.value;
    if (id === 'pasKs') prefs.keyswitches = !e.target.checked;
    if (id === 'pasClick') { prefs.click = e.target.checked ? 'select' : 'off'; if (!e.target.checked) clear(); }
    if (id === 'pasAlt') prefs.altClick = e.target.checked ? 'copy' : 'play';
    if (id === 'pasLive') prefs.noteClick = e.target.checked ? 'live' : 'off';
    if (id === 'pasEmpty') {
      prefs.emptyStaves = e.target.checked;
      if (S.base && !prefs.emptyStaves) { S.base.parts = S.base.parts.filter(p => !p.empty); S.base.passageEmpty = null; }
      SV.renderTrackList();
      SV.requestRender();
    }
    savePrefs();
  });
  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    if (b.id === 'pasClose') closePanel();
    if (b.id === 'pasCopy') copy();
    if (b.id === 'pasPaste') paste();
    if (b.id === 'pasRepeat') repeat();
  });
  // A press outside closes the panel, except in the score (bars are selected there while it is open).
  document.addEventListener('mousedown', e => {
    if (!panelOpen() || group.contains(e.target) || (e.target.closest && e.target.closest('#main'))) return;
    closePanel();
  }, true);

  root.SV.passage = {
    ...Core, copy, paste, repeat, copyTo, pasteAt, expectClip, staffNotes, prefs,
    selection: () => (sel ? { ...sel, staves: sel.staves.slice() } : null),
    select(p) { setSel(p ? { anchor: { track: p.staves[0], bar: p.from }, ...p } : null, true); },
    clear,
    active: () => !!sel && S.mode === 'score',
    /** features/mouse.js asks before it takes Ctrl+C / X / V: with a passage selected those keys are the passage's. */
    takesKey: k => !!sel && S.mode === 'score' && !entryOn() && (k === 'c' || (k === 'v' && !!clipboard && lastCopy === 'passage')),
    /** features/mouse.js copied notes: the next Ctrl+V pastes those, not the passage. */
    notesCopied() { lastCopy = 'notes'; },
    get clipboard() { return clipboard; },
    lastReport: () => lastReport,
    savePrefs,
  };
  SV.expectClip = expectClip;
})(typeof window !== 'undefined' ? window : globalThis);
