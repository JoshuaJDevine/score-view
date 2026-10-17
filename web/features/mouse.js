// Mouse editing (Sibelius/Dorico style) for live notes, plus a note clipboard.
//  Drag a live note up/down           → pitch, by scale steps in the staff's key (Alt: semitones)
//  Shift+drag a live note left/right  → time, snapped to the Quantize grid
//  Drag the end handle of a note      → length, snapped to the grid (hover a live note to see its length bar)
//  Drag on empty paper                → marquee selection of live notes (Shift adds)
//  Ctrl+C / Ctrl+X / Ctrl+V           → copy / cut / paste (at the entry caret when entry is on, else after the
//                                       selection, else at the playhead, else at the clip start)
// Everything previews as ghosts while dragging and is sent as one batch on release. Esc cancels a drag.
(function () {
  'use strict';
  const SV = window.SV;
  if (!SV) return;
  const S = SV.state, SB = SV.ScoreBuilder;
  const $ = id => document.getElementById(id);
  const DRAG_PX = 4;
  const HANDLE_IN = 0.5; // length handle sits this many staff spaces before the note's end

  // ------------------------------------------------------------------ basics

  const live = () => { const d = S.liveData; return d && d.exists ? d : null; };
  const spb = () => (live() ? live().stepsPerBeat : 24);
  const lenSteps = () => (live() ? Math.round(live().length * spb()) : 0);
  const gridSteps = () => Math.max(1, Math.round(SV.gridBeats() * spb()));
  const clipOffset = () => (SV.contentOrigin ? SV.contentOrigin() : (S.mode === 'score' && S.align ? S.align.offset : 0)); // score beat of content beat 0
  const entryOn = () => !!(SV.entry && SV.entry.state && SV.entry.state.on);
  const idOf = (ch, x, y) => 'L' + ch + '_' + x + '_' + y;
  const noteById = id => { const d = live(); return d && d.notes.find(n => idOf(n.ch, n.x, n.y) === id); };
  const selectedNotes = () => [...S.selection].map(noteById).filter(Boolean);
  const LETTERS = 'cdefgab';
  const NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

  // First rendered piece (the attack) of a live note.
  function attackOf(id) {
    const list = S.render && S.render.bySrc.get(id);
    if (!list || !list.length) return null;
    return list.reduce((a, b) => (b.start < a.start ? b : a));
  }
  function headRect(svgId) {
    const el = document.getElementById(svgId);
    if (!el) return null;
    const b = (el.querySelector('.notehead') || el).getBoundingClientRect();
    return b.width ? b : null;
  }
  const staffNOf = el => {
    const st = el && el.closest('g.staff');
    return st ? parseInt((st.id.match(/s(\d+)$/) || [])[1], 10) : null;
  };
  const staffInfo = n => (S.render ? S.render.staves.find(s => s.n === n) : null) || { fifths: 0, transpose: 0 };

  // ------------------------------------------------------------------ geometry (beat <-> x on a staff)

  function staffGeomEl(st) {
    const lines = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect()).filter(b => b.width > 20)
      .sort((a, b) => a.top - b.top);
    if (lines.length < 5) return null;
    const y = b => b.top + b.height / 2;
    const top = y(lines[0]), bottom = y(lines[4]), gap = (bottom - top) / 4;
    let left = lines[0].left;
    st.querySelectorAll(':scope > .clef, :scope > .keySig, :scope > .meterSig').forEach(g => {
      const b = g.getBoundingClientRect();
      if (b.width) left = Math.max(left, b.right);
    });
    return { el: st, top, bottom, gap, left: left + gap * 1.2, right: lines[0].right - gap * 0.9, lineLeft: lines[0].left, lineRight: lines[0].right };
  }
  const staffGeom = (measure, n) => { const st = document.getElementById('m' + measure + 's' + n); return st ? staffGeomEl(st) : null; };

  let byMeasure = new Map(); // measure -> timeline entries starting in it
  function indexTimeline(r) {
    byMeasure = new Map();
    if (!r) return;
    r.timeline.forEach(t => {
      const m = Math.floor(t.start / r.measureBeats + 1e-9) + 1;
      if (!byMeasure.has(m)) byMeasure.set(m, []);
      byMeasure.get(m).push(t);
    });
  }

  // Beat/x anchors of a measure: content start, each rendered onset (notehead left), the barline.
  function anchors(measure, geom) {
    const mb = S.render.measureBeats, m0 = (measure - 1) * mb;
    const byBeat = new Map([[m0, geom.left]]);
    (byMeasure.get(measure) || []).forEach(t => {
      const b = headRect(t.svgId);
      if (!b) return;
      const k = Math.round(t.start * 96) / 96;
      byBeat.set(k, Math.min(byBeat.has(k) && k !== m0 ? byBeat.get(k) : Infinity, b.left));
    });
    byBeat.set(m0 + mb, geom.right);
    return [...byBeat.entries()].map(([beat, x]) => ({ beat, x })).sort((a, b) => a.beat - b.beat);
  }
  function lerp(list, key, val, out) {
    if (val <= list[0][key]) return list[0][out];
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (val <= b[key]) return b[key] === a[key] ? a[out] : a[out] + (b[out] - a[out]) * (val - a[key]) / (b[key] - a[key]);
    }
    return list[list.length - 1][out];
  }
  // Absolute beat -> { x, geom, measure } on staff n (a beat on a barline belongs to the measure before it if needed).
  function beatPos(beat, n) {
    const mb = S.render.measureBeats;
    let measure = Math.floor(beat / mb + 1e-9) + 1;
    let geom = staffGeom(measure, n);
    if (!geom && Math.abs(beat - (measure - 1) * mb) < 1e-6) { measure -= 1; geom = staffGeom(measure, n); }
    if (!geom) return null;
    return { x: lerp(anchors(measure, geom), 'beat', beat, 'x'), geom, measure };
  }
  // Mouse point -> absolute beat on staff n, in the system nearest to the mouse vertically.
  function beatAt(clientX, clientY, n) {
    const rows = [];
    document.querySelectorAll('#paper g.staff').forEach(st => {
      const m = st.id.match(/^m(\d+)s(\d+)$/);
      if (!m || +m[2] !== n) return;
      const geom = staffGeomEl(st);
      if (geom) rows.push({ measure: +m[1], geom, mb: st.closest('g.measure').getBoundingClientRect() });
    });
    if (!rows.length) return null;
    const vd = r => Math.max(0, r.geom.top - clientY, clientY - r.geom.bottom);
    const best = Math.min(...rows.map(vd));
    const sys = rows.filter(r => Math.abs(vd(r) - best) < 1 && Math.abs(r.geom.top - rows.find(q => vd(q) === best).geom.top) < 2)
      .sort((a, b) => a.mb.left - b.mb.left);
    const mb = S.render.measureBeats;
    let row = sys.find(r => clientX >= r.mb.left && clientX <= r.mb.right);
    if (!row) row = clientX < sys[0].mb.left ? sys[0] : sys[sys.length - 1];
    if (clientX > row.geom.right) return row.measure * mb;
    return lerp(anchors(row.measure, row.geom), 'x', clientX, 'beat');
  }

  // Written diatonic index (C4 = 28) of a sounding pitch on a staff.
  function diaOf(pitch, info) {
    const sp = SB.makeSpeller(info.fifths || 0)(pitch + (info.transpose || 0));
    return sp.oct * 7 + LETTERS.indexOf(String(sp.pname).toLowerCase()) + 7;
  }
  function pitchName(pitch, info) {
    const sp = SB.makeSpeller(info.fifths || 0)(pitch + (info.transpose || 0));
    return NAMES[LETTERS.indexOf(String(sp.pname).toLowerCase())] + (['𝄫', '♭', '', '♯', '𝄪'][sp.alter + 2] || '') + sp.oct;
  }

  // ------------------------------------------------------------------ overlay

  SV.addStyle(`
    #svm-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 6; }
    #svm-layer .svm-ghost { position: absolute; border-radius: 50%; background: var(--sel, #e8590c); opacity: .75;
      transform: rotate(-20deg); box-shadow: 0 0 6px #e8590c88; }
    #svm-layer .svm-ledger { position: absolute; height: 1.4px; background: var(--sel, #e8590c); opacity: .8; }
    #svm-layer .svm-bar { position: absolute; background: #e8590c38; border: 1px solid #e8590c88; border-radius: 3px; }
    #svm-layer .svm-bar.hover { background: #1c7ed61f; border-color: #1c7ed666; }
    #svm-layer .svm-handle { position: absolute; width: 4px; border-radius: 2px; background: #1c7ed6; }
    #svm-layer .svm-handle.on { background: var(--sel, #e8590c); }
    #svm-layer .svm-rect { position: absolute; border: 1px dashed #1c7ed6; background: #1c7ed614; }
    #svm-layer .svm-tag { position: absolute; font: 600 11px system-ui, sans-serif; color: #fff; background: #222d;
      padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
    #paper .svm-orig { opacity: .35; }
    body.svm-dragging #svaPalette { display: none; }
    #paper .svm-in, #paper .svm-in * { fill: #1c7ed6 !important; }
    body.svm-cur-ew #paper, body.svm-cur-ew #paper * { cursor: ew-resize !important; }
    body.svm-cur-ns #paper, body.svm-cur-ns #paper * { cursor: ns-resize !important; }
    body.svm-cur-move #paper, body.svm-cur-move #paper * { cursor: grabbing !important; }
    body.svm-cur-cross #paper, body.svm-cur-cross #paper * { cursor: crosshair !important; }
  `);

  function layer() {
    let L = $('svm-layer');
    if (!L) { L = document.createElement('div'); L.id = 'svm-layer'; $('main').appendChild(L); }
    return L;
  }
  function toLocal(x, y) {
    const m = $('main'), r = m.getBoundingClientRect();
    return { x: x - r.left + m.scrollLeft, y: y - r.top + m.scrollTop };
  }
  const box = (cls, x, y, w, h, extra = '') => {
    const p = toLocal(x, y);
    return `<div class="${cls}" style="left:${p.x}px;top:${p.y}px;width:${Math.max(0, w)}px;height:${Math.max(0, h)}px;${extra}"></div>`;
  };
  const tag = (x, y, text) => { const p = toLocal(x, y); return `<div class="svm-tag" style="left:${p.x}px;top:${p.y}px">${text}</div>`; };
  function setCursor(kind) {
    ['ew', 'ns', 'move', 'cross'].forEach(k => document.body.classList.toggle('svm-cur-' + k, k === kind));
  }
  function clearMarks() {
    document.querySelectorAll('#paper .svm-orig, #paper .svm-in').forEach(el => el.classList.remove('svm-orig', 'svm-in'));
  }

  // Ghost notehead centred at (cx, cy) on a staff, with ledger lines outside it.
  function ghostHtml(cx, cy, w, geom) {
    const g = geom.gap;
    let html = box('svm-ghost', cx - w / 2, cy - g / 2, w, g);
    for (let ly = geom.top - g; ly >= cy - g * 0.26; ly -= g) html += box('svm-ledger', cx - w * 0.85, ly, w * 1.7, 1.4);
    for (let ly = geom.bottom + g; ly <= cy + g * 0.26; ly += g) html += box('svm-ledger', cx - w * 0.85, ly, w * 1.7, 1.4);
    return html;
  }

  // Bar from beat a to beat b at height cy on staff n, split at measure (and system) boundaries.
  function spanHtml(cls, a, b, n, dy, h) {
    let html = '';
    const mb = S.render.measureBeats;
    for (let m = Math.floor(a / mb + 1e-9) + 1; (m - 1) * mb < b - 1e-9; m++) {
      const geom = staffGeom(m, n);
      if (!geom) continue;
      const list = anchors(m, geom);
      const s = Math.max(a, (m - 1) * mb), e = Math.min(b, m * mb);
      const x0 = lerp(list, 'beat', s, 'x'), x1 = e >= m * mb - 1e-9 ? geom.lineRight : lerp(list, 'beat', e, 'x');
      html += box(cls, x0, geom.top + dy - h / 2, x1 - x0, h);
    }
    return html;
  }

  // ------------------------------------------------------------------ live note geometry

  // { id, n (note), t (attack), head, staffN, geom, endBeat, endX } for a live note, or null if not rendered.
  function noteGeom(id) {
    const n = noteById(id), t = attackOf(id);
    if (!n || !t) return null;
    const head = headRect(t.svgId), el = document.getElementById(t.svgId);
    if (!head || !el) return null;
    const staffN = staffNOf(el), stEl = el.closest('g.staff');
    const geom = stEl && staffGeomEl(stEl);
    if (!geom) return null;
    const startBeat = n.x / spb() + clipOffset(), endBeat = startBeat + n.d;
    const ep = beatPos(endBeat, staffN);
    // Length handle: just before the end (the next onset's notehead sits on the end itself).
    let endX = ep && Math.abs(ep.geom.top - geom.top) < 2 ? ep.x - HANDLE_IN * geom.gap : geom.lineRight; // continues on the next system
    endX = Math.max(endX, head.right + geom.gap * 0.8);
    return { id, n, t, head, staffN, geom, startBeat, endBeat, endX, cy: head.top + head.height / 2 };
  }

  // Live note whose length handle (or notehead / length bar) is under the mouse; zone = 'end' | 'body'.
  function hoverAt(e) {
    const d = live();
    if (!d || !S.render) return null;
    let best = null;
    d.notes.forEach(n => {
      const id = idOf(n.ch, n.x, n.y), t = attackOf(id);
      if (!t) return;
      const head = headRect(t.svgId);
      if (!head) return;
      const cy = head.top + head.height / 2, half = head.height * 0.75;
      if (Math.abs(e.clientY - cy) > half || e.clientX < head.left - 4) return;
      const g = noteGeom(id);
      if (!g || e.clientX > g.endX + 6) return;
      const zone = e.clientX <= head.right ? 'head' : Math.abs(e.clientX - g.endX) <= 6 ? 'end' : 'body';
      const score = (zone === 'head' ? 0 : zone === 'end' ? 1 : 2) * 1000 + Math.abs(e.clientY - cy);
      if (!best || score < best.score) best = { ...g, zone, score };
    });
    return best;
  }

  let hovered = null;
  function drawHover() {
    if (drag) return;
    const L = layer();
    if (!hovered || entryOn()) { L.innerHTML = ''; setCursor(null); return; }
    const g = hovered, h = g.geom.gap * 0.8, dy = g.cy - g.geom.top;
    L.innerHTML = spanHtml('svm-bar hover', g.startBeat, g.endBeat, g.staffN, dy, h) +
      box('svm-handle' + (g.zone === 'end' ? ' on' : ''), g.endX - 2, g.cy - h * 0.8, 4, h * 1.6);
    setCursor(g.zone === 'end' ? 'ew' : null);
  }

  let hoverRaf = 0, lastMove = null;
  $('paper').addEventListener('mousemove', e => {
    if (drag) return;
    lastMove = { clientX: e.clientX, clientY: e.clientY };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      hovered = entryOn() || !lastMove ? null : hoverAt(lastMove);
      if (hovered && hovered.zone === 'body' && !S.selection.has(hovered.id)) hovered = null; // bar only for notes in reach
      drawHover();
    });
  });
  $('paper').addEventListener('mouseleave', () => { lastMove = null; if (!drag) { hovered = null; drawHover(); } });

  // ------------------------------------------------------------------ drags

  let drag = null;

  // Alt+press right on a *selected* live note starts a chromatic drag. It must reach us before playback.js's
  // Alt+click (play from bar), which listens on the document in the capture phase (registered after this module);
  // Alt+click anywhere else still plays from the bar. Alt can also be pressed once the drag has started.
  document.addEventListener('mousedown', e => {
    if (!e.altKey || e.button !== 0 || entryOn() || !S.render || !e.target.closest || !e.target.closest('#paper')) return;
    const noteEl = e.target.closest('#paper g.note'), t = noteEl && S.render.bySvg.get(noteEl.id);
    if (!t || !SV.isLive(t.srcId) || !S.selection.has(t.srcId)) return;
    e.stopImmediatePropagation();
    if (press(e, noteEl)) e.preventDefault();
  }, true);

  SV.hooks.paperMouseDown.push(press);
  function press(e, noteEl) {
    if (e.button !== 0 || entryOn() || !live() || !S.render) return false;
    if (e.target.closest && e.target.closest('g.label, g.labelAbbr')) return false;
    const base = { x0: e.clientX, y0: e.clientY, started: false, down: e };
    const h = hoverAt(e);
    if (h && h.zone === 'end') { // length handle
      if (!S.selection.has(h.id)) {
        if (!e.shiftKey) S.selection.clear();
        S.selection.add(h.id);
        SV.paintSelection();
      }
      drag = { ...base, kind: 'resize', anchor: h, ids: [...S.selection].filter(id => noteById(id)) };
      return true;
    }
    const t = noteEl && S.render.bySvg.get(noteEl.id);
    if (t) {
      if (!SV.isLive(t.srcId)) return false;
      const wasSelected = S.selection.has(t.srcId);
      if (!wasSelected) SV.clickPaper(e);          // select it now (built-in click: hooks, audition, Bitwig selection)
      if (!S.selection.has(t.srcId)) return true;   // shift-click removed it: nothing to drag
      const g = noteGeom(t.srcId);
      if (!g) return true;
      drag = { ...base, kind: e.shiftKey ? 'time' : 'pitch', anchor: g, clickOnUp: wasSelected };
      $('main').focus();
      return true;
    }
    SV.clickPaper(e); // empty paper: built-in behaviour (clears the selection unless Shift), then maybe a marquee
    drag = { ...base, kind: 'marquee', add: e.shiftKey, before: new Set(S.selection) };
    $('main').focus();
    return true;
 }

  document.addEventListener('mousemove', e => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_PX) return;
      drag.started = true;
      hovered = null;
      document.body.classList.add('svm-dragging');
      if (drag.kind !== 'marquee') markOriginals();
      else if (SV.passage) SV.passage.clear(); // a marquee selects notes: the passage selection (features/passage.js) goes
    }
    drag.last = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey };
    e.preventDefault();
    update();
  });

  document.addEventListener('mouseup', e => {
    if (!drag) return;
    const d = drag;
    if (d.started) { d.last = { clientX: e.clientX, clientY: e.clientY, altKey: e.altKey }; update(); }
    endDrag();
    if (!d.started) { if (d.clickOnUp) SV.clickPaper(d.down); return; }
    commit(d);
  });

  SV.hooks.keydown.push(e => {
    if (!drag || e.key !== 'Escape') return false;
    endDrag();
    return true;
  });

  if (SV.shortcuts) SV.shortcuts.register({ keys: 'Escape', owner: 'mouse', desc: 'cancel the drag', when: 'drag' });

  function endDrag() {
    drag = null;
    clearMarks();
    layer().innerHTML = '';
    setCursor(null);
    document.body.classList.remove('svm-dragging');
  }

  function markOriginals() {
    const ids = drag.kind === 'resize' ? [] : [...S.selection];
    ids.forEach(id => (S.render.bySrc.get(id) || []).forEach(t => {
      const el = document.getElementById(t.svgId);
      if (el) el.classList.add('svm-orig');
    }));
  }

  function update() {
    const d = drag;
    if (d.kind === 'pitch') updatePitch(d);
    else if (d.kind === 'time') updateTime(d);
    else if (d.kind === 'resize') updateResize(d);
    else updateMarquee(d);
  }

  // Pitch: half a staff space of mouse travel = one scale step (Alt: one semitone).
  function pitchPlan(d) {
    const a = d.anchor, chrom = d.last.altKey;
    let steps = Math.round((d.y0 - d.last.clientY) / (a.geom.gap / 2));
    const notes = selectedNotes();
    const info = staffInfo(a.staffN);
    const shift = (y, k) => {
      if (chrom) return y + k;
      let w = y + (info.transpose || 0);
      for (let i = 0; i < Math.abs(k); i++) w = SB.diatonicStep(w, info.fifths || 0, Math.sign(k));
      return w - (info.transpose || 0);
    };
    while (steps && notes.some(n => { const p = shift(n.y, steps); return p < 0 || p > 127; })) steps -= Math.sign(steps);
    return { steps, chrom, notes, to: y => shift(y, steps), info };
  }
  function updatePitch(d) {
    const p = d.plan = pitchPlan(d);
    setCursor('ns');
    let html = '';
    p.notes.forEach(n => {
      const g = noteGeom(idOf(n.ch, n.x, n.y));
      if (!g) return;
      const info = staffInfo(g.staffN);
      const ddia = diaOf(p.to(n.y), info) - diaOf(n.y, info);
      html += ghostHtml(g.head.left + g.head.width / 2, g.cy - ddia * g.geom.gap / 2, g.head.width, g.geom);
    });
    const an = d.anchor.n, to = p.to(an.y);
    const semis = to - an.y;
    html += tag(d.last.clientX + 14, d.last.clientY - 22,
      pitchName(to, staffInfo(d.anchor.staffN)) + ' (' + (semis > 0 ? '+' : '') + semis + (p.chrom ? ' st, chromatic' : ' st') + ')');
    layer().innerHTML = html;
  }

  // Time: the grabbed note snaps to the grid; the others keep their distance to it.
  function timePlan(d) {
    const a = d.anchor, s = spb(), grid = gridSteps();
    const b0 = beatAt(d.x0, d.y0, a.staffN), b1 = beatAt(d.last.clientX, d.last.clientY, a.staffN);
    if (b0 == null || b1 == null) return { dx: 0, notes: selectedNotes() };
    const notes = selectedNotes();
    let dx = Math.round((a.n.x + (b1 - b0) * s) / grid) * grid - a.n.x;
    const minX = Math.min(...notes.map(n => n.x)), maxX = Math.max(...notes.map(n => n.x));
    dx = Math.max(-minX, Math.min(dx, lenSteps() - 1 - maxX));
    return { dx, notes };
  }
  function updateTime(d) {
    const p = d.plan = timePlan(d);
    setCursor('move');
    let html = '';
    const s = spb(), off = clipOffset();
    p.notes.forEach(n => {
      const g = noteGeom(idOf(n.ch, n.x, n.y));
      if (!g) return;
      const pos = beatPos((n.x + p.dx) / s + off, g.staffN);
      if (!pos) return;
      html += ghostHtml(pos.x + g.head.width / 2, pos.geom.top + (g.cy - g.geom.top), g.head.width, pos.geom);
    });
    const nb = (d.anchor.n.x + p.dx) / s + off, mb = S.render.measureBeats;
    html += tag(d.last.clientX + 14, d.last.clientY - 22,
      'bar ' + (Math.floor(nb / mb + 1e-9) + 1) + ', beat ' + fmtBeat(nb - Math.floor(nb / mb + 1e-9) * mb + 1) +
      ' (' + (p.dx >= 0 ? '+' : '−') + fmtBeat(Math.abs(p.dx) / s) + ' beats)');
    layer().innerHTML = html;
  }
  const fmtBeat = b => String(+b.toFixed(3));

  // Length: the grabbed note's end snaps to the grid; the other selected notes change by the same amount.
  function resizePlan(d) {
    const a = d.anchor, s = spb(), grid = gridSteps();
    const b = beatAt(d.last.clientX + HANDLE_IN * a.geom.gap, d.last.clientY, a.staffN);
    const old = Math.round(a.n.d * s);
    let end = b == null ? a.n.x + old : Math.round(((b - clipOffset()) * s) / grid) * grid;
    const delta = Math.max(grid, end - a.n.x) - old;
    const notes = d.ids.map(noteById).filter(Boolean)
      .map(n => ({ n, d: Math.max(grid, Math.round(n.d * s) + delta) / s }));
    return { notes, anchorDur: (old + delta) / s };
  }
  function updateResize(d) {
    const p = d.plan = resizePlan(d);
    setCursor('ew');
    let html = '';
    const s = spb(), off = clipOffset();
    p.notes.forEach(({ n, d: dur }) => {
      const g = noteGeom(idOf(n.ch, n.x, n.y));
      if (!g) return;
      const a = n.x / s + off;
      html += spanHtml('svm-bar', a, a + dur, g.staffN, g.cy - g.geom.top, g.geom.gap * 0.8);
    });
    html += tag(d.last.clientX + 14, d.last.clientY - 22, fmtBeat(p.anchorDur) + ' beats');
    layer().innerHTML = html;
  }

  // Marquee: live notes whose notehead centre is inside the rectangle.
  function updateMarquee(d) {
    setCursor('cross');
    const l = Math.min(d.x0, d.last.clientX), r = Math.max(d.x0, d.last.clientX);
    const t = Math.min(d.y0, d.last.clientY), b = Math.max(d.y0, d.last.clientY);
    const inside = new Set();
    const ld = live();
    document.querySelectorAll('#paper .svm-in').forEach(el => el.classList.remove('svm-in'));
    if (ld) ld.notes.forEach(n => {
      const id = idOf(n.ch, n.x, n.y);
      (S.render.bySrc.get(id) || []).forEach(tl => {
        const h = headRect(tl.svgId);
        if (!h) return;
        const cx = h.left + h.width / 2, cy = h.top + h.height / 2;
        if (cx >= l && cx <= r && cy >= t && cy <= b) {
          inside.add(id);
          document.getElementById(tl.svgId).classList.add('svm-in');
        }
      });
    });
    d.inside = inside;
    layer().innerHTML = box('svm-rect', l, t, r - l, b - t);
  }

  function commit(d) {
    if (d.kind === 'pitch') {
      const p = d.plan;
      if (!p || !p.steps) return;
      const blocked = SV.moveSelection(0, y => p.to(y) - y);
      if (blocked) SV.flash(blocked + (blocked > 1 ? ' notes' : ' note') + ' not moved (the place is taken)');
    } else if (d.kind === 'time') {
      const p = d.plan;
      if (!p || !p.dx) return;
      const blocked = SV.moveSelection(p.dx, () => 0);
      if (blocked) SV.flash(blocked + (blocked > 1 ? ' notes' : ' note') + ' not moved (the place is taken)');
    } else if (d.kind === 'resize') {
      const p = d.plan, s = spb();
      if (!p) return;
      const lines = p.notes.filter(x => Math.round(x.n.d * s) !== Math.round(x.d * s))
        .map(x => `dur ${x.n.ch} ${x.n.x} ${x.n.y} ${+x.d.toFixed(6)}`);
      SV.send(lines);
    } else {
      const ids = d.inside || new Set();
      S.selection = d.add ? new Set([...d.before, ...ids]) : ids;
      SV.paintSelection();
      if (ids.size) SV.flash(S.selection.size + ' notes selected');
    }
  }

  // ------------------------------------------------------------------ clipboard

  const CLIP_KEY = 'scoreview.mouse.clipboard';
  let clipboard = null; // { notes: [{dx (steps from the first note), y, ch, vel, d (beats)}], spb, span (steps) }
  try { clipboard = JSON.parse(localStorage.getItem(CLIP_KEY)); } catch (e) { /* none */ }

  function copy() {
    const notes = selectedNotes();
    if (!notes.length) return false;
    const s = spb(), x0 = Math.min(...notes.map(n => n.x));
    clipboard = {
      spb: s,
      span: Math.max(...notes.map(n => n.x - x0 + Math.round(n.d * s))),
      notes: notes.map(n => ({ dx: n.x - x0, y: n.y, ch: n.ch, vel: n.vel == null ? 100 : n.vel, d: n.d })).sort((a, b) => a.dx - b.dx || a.y - b.y),
    };
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clipboard)); } catch (e) { /* ignore */ }
    if (SV.passage && SV.passage.notesCopied) SV.passage.notesCopied(); // the next Ctrl+V pastes these notes
    const info = staffInfo((S.render && S.render.staves[0] || {}).n);
    const text = clipboard.notes.map(n => `${fmtBeat(n.dx / s)}\t${pitchName(n.y, info)}\t${n.y}\t${fmtBeat(n.d)}\t${n.vel}`).join('\n');
    try { if (navigator.clipboard) navigator.clipboard.writeText('beat\tpitch\tkey\tbeats\tvel\n' + text).catch(() => {}); } catch (e) { /* ignore */ }
    return notes;
  }

  // Where Ctrl+V puts the first note: entry caret, after the selection, playhead, clip start.
  function pasteStep() {
    if (entryOn()) return SV.entry.state.caret;
    const sel = selectedNotes(), s = spb();
    if (sel.length) return Math.max(...sel.map(n => n.x + Math.round(n.d * s)));
    const first = Math.round(((S.liveData && S.liveData.playStart) || 0) * s); // the clip's visible start
    if (S.playBeat >= 0) {
      const b = S.playBeat - clipOffset(); // content beat under the playhead
      if (b * s >= first && b * s < lenSteps()) return Math.round(b * s);
    }
    return first;
  }

  function paste() {
    if (!clipboard || !clipboard.notes.length || !live()) { SV.flash('Nothing to paste (Ctrl+C copies selected notes)'); return; }
    const s = spb(), ratio = s / (clipboard.spb || s), at = pasteStep(), len = lenSteps();
    const notes = clipboard.notes.map(n => ({ ...n, x: at + Math.round(n.dx * ratio) }))
      .filter(n => n.x >= Math.round(((S.liveData && S.liveData.playStart) || 0) * s) && n.x < len && n.y >= 0 && n.y <= 127);
    const dropped = clipboard.notes.length - notes.length;
    if (!notes.length) { SV.flash('Paste would land after the end of the clip'); return; }
    SV.send(notes.map(n => `add ${n.ch} ${n.x} ${n.y} ${n.vel} ${+n.d.toFixed(6)}`));
    const ids = notes.map(n => idOf(n.ch, n.x, n.y));
    SV.expectIds(ids);
    S.selection = new Set(ids);
    SV.paintSelection();
    if (entryOn() && SV.entry.setCaret) SV.entry.setCaret(Math.min(len, at + Math.round(clipboard.span * ratio)));
    SV.flash('Pasted ' + notes.length + (notes.length > 1 ? ' notes' : ' note') + (dropped ? ' (' + dropped + ' past the clip end left out)' : ''));
  }

  SV.hooks.keydown.push(e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return false;
    const k = e.key.toLowerCase();
    // With a passage selected (features/passage.js) Ctrl+C copies the passage and Ctrl+V pastes a copied passage.
    if (SV.passage && SV.passage.takesKey && SV.passage.takesKey(k)) return false;
    if (k === 'c') { const n = copy(); if (n) SV.flash('Copied ' + n.length + (n.length > 1 ? ' notes' : ' note')); return !!n; }
    if (k === 'x') {
      const n = copy();
      if (!n) return false;
      SV.send(n.map(x => `del ${x.ch} ${x.x} ${x.y}`));
      S.selection.clear();
      SV.paintSelection();
      SV.flash('Cut ' + n.length + (n.length > 1 ? ' notes' : ' note'));
      return true;
    }
    if (k === 'v') { paste(); return true; }
    return false;
  });

  if (SV.shortcuts) {
    SV.shortcuts.register({ keys: 'Ctrl+C', owner: 'mouse', group: 'clipboard', desc: 'copy the selected notes' });
    SV.shortcuts.register({ keys: 'Ctrl+X', owner: 'mouse', group: 'clipboard', desc: 'cut the selected notes' });
    SV.shortcuts.register({ keys: 'Ctrl+V', owner: 'mouse', group: 'clipboard', desc: 'paste (at the entry caret, else after the selection, else at the playhead)' });
  }

  SV.hooks.afterRender.push(r => { indexTimeline(r); hovered = null; if (!drag) layer().innerHTML = ''; });

  SV.addHelp('<b>Mouse</b> drag a note ↕ pitch (<kbd>Alt</kbd> chromatic) · <kbd>Shift</kbd>+drag ↔ time · drag a note\'s end handle: length · ' +
    'drag on empty paper: select (<kbd>Shift</kbd> adds) · <kbd>Esc</kbd> cancels · <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>X</kbd>/<kbd>V</kbd> copy, cut, paste ' +
    '(at the entry caret, else after the selection, else at the playhead)');

  SV.mouse = { copy, paste, get clipboard() { return clipboard; }, beatAt, beatPos };
})();
