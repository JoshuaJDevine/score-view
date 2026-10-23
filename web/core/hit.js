// Score View page core: hit testing on the engraved paper — the nearest notehead, the staff position under the
// mouse (SV.hitTest), and the built-in click. Boxes come from SV.geom (cached per render, core/render.js).
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, SB, state, runHooks } = C;

  // Elements matching sel in the engravings (.svc: the whole score, or one chunk per system) within pad px of the
  // mouse's height: a chunked score measures only the systems near the mouse, not every note of the score.
  function near(e, sel, pad) {
    const chunks = document.querySelectorAll('#paper > .svc');
    if (chunks.length < 2) return [...document.querySelectorAll('#paper ' + sel)];
    const out = [];
    C.geom.rects(chunks).forEach((b, i) => {
      if (e.clientY >= b.top - pad && e.clientY <= b.bottom + pad) out.push(...chunks[i].querySelectorAll(sel));
    });
    return out;
  }

  // Nearest rendered notehead group (g.note) within a small radius of the mouse, or null.
  function noteAt(e) {
    const g = e.target.closest && e.target.closest('#paper g.note');
    if (g) return g;
    let best = null, bestD = 14 * 14;
    const els = near(e, 'g.note', 14);
    C.geom.rects(els).forEach((b, i) => {
      const dx = Math.max(b.left - e.clientX, 0, e.clientX - b.right), dy = Math.max(b.top - e.clientY, 0, e.clientY - b.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = els[i]; }
    });
    return best;
  }

  // The render whose SVG the mouse is on: SV.state.render, or while a big engraving is still running in the workers
  // (state.render.drawn false), the one the paper still shows.
  function paperRender() {
    const r = state.render; // flushes a pending requestRender
    return r && !r.drawn && C.shownRender() ? C.shownRender() : r;
  }

  // Click: nearest notehead within a small radius (features/mouse.js may take the press first, for drags).
  function clickPaper(e) {
    const r = paperRender();
    if (!r) return;
    const g = noteAt(e);
    if (!g) {
      if (runHooks('paperClick', e, hitTest(e))) { e.preventDefault(); return; }
      if (!e.shiftKey) { state.selection.clear(); C.paintSelection(); }
      return;
    }
    const t = r.bySvg.get(g.id);
    if (!t) return;
    if (runHooks('noteClick', t, e)) { e.preventDefault(); return; }
    if (C.isLive(t.srcId)) C.selectNote(t.srcId, e.shiftKey);
    else C.flash('This note is in another clip. Click that clip in Bitwig to edit it here.');
    $('main').focus();
    e.preventDefault();
  }
  $('paper').addEventListener('mousedown', e => {
    if (!state.render) return;
    if (runHooks('paperMouseDown', e, noteAt(e))) { e.preventDefault(); return; }
    clickPaper(e);
  });

  // Maps a mouse event on the paper to { measure, staff, part, beat, diatonic, pitch } using Verovio's SVG
  // (staff lines give the vertical scale; measure bounds give an approximate beat). Null when off-staff.
  // pitch is the natural (white-key) pitch under the mouse; apply the key signature yourself if needed.
  function hitTest(e) {
    const r = paperRender();
    if (!r) return null;
    const geom = C.geom;
    let best = null;
    near(e, 'g.measure', 120).forEach(mEl => {
      const mb = geom.rect(mEl);
      if (e.clientX < mb.left || e.clientX > mb.right) return;
      mEl.querySelectorAll(':scope > g.staff').forEach(stEl => {
        const lines = geom.rects(stEl.querySelectorAll(':scope > path')).filter(b => b.width > 20);
        if (lines.length < 5) return;
        const top = lines[0].top, bottom = lines[4].top, gap = (bottom - top) / 4;
        if (e.clientY < top - gap * 6 || e.clientY > bottom + gap * 6) return;
        const dist = Math.max(0, top - e.clientY, e.clientY - bottom);
        if (best && best.dist <= dist) return;
        const n = parseInt((stEl.id.match(/s(\d+)$/) || [])[1], 10); // staff ids are "m{measure}s{staff}" (score.js)
        best = { dist, mEl, stEl, n, stepsBelowTop: Math.round((e.clientY - top) / (gap / 2)), frac: (e.clientX - mb.left) / mb.width };
      });
    });
    if (!best) return null;
    const mNum = parseInt(best.mEl.id.replace(/^m/, ''), 10);
    const staffIdx = [...best.mEl.querySelectorAll(':scope > g.staff')].indexOf(best.stEl);
    const staff = r.staves.find(s => s.n === best.n) || r.staves[staffIdx];
    if (!staff || isNaN(mNum)) return null;
    // Diatonic number of the top staff line (C4 = 28): treble F5, bass A3, C-clefs from their line.
    // Clef and ottava in force at that point (score.js changes clefs mid-staff and adds 8va/8vb lines).
    const span = SB.measureSpan(r, mNum), beat = span.start + best.frac * span.beats;
    const c = SB.clefAt(staff, beat);
    const topLine = c.shape === 'G' ? 38 + (2 - c.line) * 2 : c.shape === 'F' ? 26 + (4 - c.line) * 2 : 28 + (5 - c.line) * 2;
    const diatonic = topLine - best.stepsBelowTop + (c.dis ? (c.disPlace === 'below' ? -7 : 7) * (c.dis / 8) : 0);
    const letter = ((diatonic % 7) + 7) % 7, oct = Math.floor(diatonic / 7);
    const pitch = (oct + 1) * 12 + [0, 2, 4, 5, 7, 9, 11][letter] + 12 * SB.ottavaAt(staff, beat);
    // pitch is the natural *written* pitch; transpose (written - sounding) converts it to what Bitwig plays.
    return { measure: mNum, staff: staff.n, part: staff.part, beat, diatonic, pitch, transpose: staff.transpose || 0, frac: best.frac };
  }

  Object.assign(C, { noteAt, clickPaper, hitTest });
})();
