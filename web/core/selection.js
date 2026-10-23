// Score View page core: editing live notes — selection, moves (never onto a note that stays put), resizes.
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, TPQ } = C;

  const pendingIds = new Set(); // ids we expect to appear after an edit
  const parseId = id => { const [ch, x, y] = id.slice(1).split('_').map(Number); return { ch, x, y }; };
  const isLive = id => /^L\d+_\d+_\d+$/.test(id);
  const noteById = id => state.liveData && state.liveData.notes.find(n => C.liveId(n) === id);

  // Mirroring a click into Bitwig's note selection (clip.selectStepContents) puts Bitwig's selection actions into the
  // clip's notes until a clip is clicked in the Arranger, which breaks Read project and clip navigation. Off by
  // default; the page never reads Bitwig's note selection back.
  const SEL_KEY = 'scoreview.selectInBitwig';
  const selBox = $('bitwigSel');
  try { if (selBox) selBox.checked = localStorage.getItem(SEL_KEY) === 'true'; } catch (e) { /* default off */ }
  if (selBox) selBox.addEventListener('change', () => { try { localStorage.setItem(SEL_KEY, String(selBox.checked)); } catch (e) { /* ignore */ } });
  const selectInBitwig = () => !!(selBox && selBox.checked);

  // Moves the selected live notes by dx steps and dyFn(y) semitones; returns the number of notes that stayed put
  // (out of range, or their target is taken by a note that does not move).
  function moveSelection(dx, dyFn) {
    const sel = [...state.selection].map(id => ({ id, ...parseId(id) }));
    if (!sel.length) return 0;
    let moves = sel.map(n => ({ ...n, dx, dy: dyFn(n.y) }))
      .filter(n => n.x + n.dx >= 0 && n.y + n.dy >= 0 && n.y + n.dy <= 127 && (n.dx || n.dy));
    // Never land on a note that stays where it is (repeat: a blocked note blocks whatever would land on it).
    const pos = (x, y) => x + '_' + y;
    for (let changed = true; changed;) {
      const moving = new Set(moves.map(n => n.id));
      const fixed = new Set((state.liveData ? state.liveData.notes : []).filter(n => !moving.has(C.liveId(n))).map(n => pos(n.x, n.y)));
      const ok = moves.filter(n => !fixed.has(pos(n.x + n.dx, n.y + n.dy)));
      changed = ok.length !== moves.length;
      moves = ok;
    }
    const blocked = sel.length - moves.length;
    // Order so a moving note never lands on one that hasn't moved yet.
    moves.sort((a, b) => Math.sign(a.dy) * (b.y - a.y) || Math.sign(a.dx) * (b.x - a.x));
    const lines = moves.map(n => `move ${n.ch} ${n.x} ${n.y} ${n.dx} ${n.dy}`);
    const next = new Set(state.selection);
    pendingIds.clear();
    moves.forEach(n => { next.delete(n.id); const nid = 'L' + n.ch + '_' + (n.x + n.dx) + '_' + (n.y + n.dy); next.add(nid); pendingIds.add(nid); });
    state.selection = next;
    if ($('audition').checked && moves.some(n => n.dy)) moves.slice(0, 4).forEach(n => lines.push('audition ' + (n.y + n.dy)));
    C.send(lines);
    return blocked;
  }

  function resizeSelection(deltaBeats) {
    const lines = [];
    state.selection.forEach(id => {
      const n = noteById(id);
      if (n) lines.push(`dur ${n.ch} ${n.x} ${n.y} ${Math.max(gridBeats(), n.d + deltaBeats)}`);
    });
    C.send(lines);
  }

  const gridBeats = () => parseInt($('gridSel').value, 10) / TPQ;

  function selectNote(id, add) {
    if (!add) state.selection.clear();
    if (add && state.selection.has(id)) state.selection.delete(id); else state.selection.add(id);
    C.paintSelection();
    const { ch, x, y } = parseId(id);
    if (selectInBitwig()) C.send([`select ${ch} ${x} ${y} ${add ? 1 : 0}`]);
    if ($('audition').checked && !add) C.send(['audition ' + y]);
  }

  // The live notes' first engraved pieces in reading order (time, then low to high).
  function liveOrder() {
    const r = state.render;
    if (!r) return [];
    return [...r.bySrc.values()].map(a => a[0]).filter(t => isLive(t.srcId))
      .sort((a, b) => a.start - b.start || parseId(a.srcId).y - parseId(b.srcId).y);
  }
  const reveal = t => { const el = t && document.getElementById(t.svgId); if (el) C.scrollToEl(el); };

  // Shift+←/→ (Sibelius / Dorico): add the note after the last selected one (or before the first).
  function extendSelection(dir) {
    const order = liveOrder();
    const idx = order.map((t, i) => (state.selection.has(t.srcId) ? i : -1)).filter(i => i >= 0);
    if (!idx.length) { stepSelection(dir); return; }
    const t = order[dir > 0 ? Math.max(...idx) + 1 : Math.min(...idx) - 1];
    if (!t) return;
    selectNote(t.srcId, true);
    reveal(t);
  }

  // Ctrl+←/→: the first note of the next / previous bar that has notes.
  function stepBar(dir) {
    const r = state.render, order = liveOrder();
    if (!r || !order.length) return;
    const barOf = t => C.SB.measureAt(r, t.start);
    const sel = order.filter(t => state.selection.has(t.srcId));
    const cur = sel.length ? barOf(dir > 0 ? sel[sel.length - 1] : sel[0]) : (dir > 0 ? -Infinity : Infinity);
    const hit = dir > 0 ? order.find(t => barOf(t) > cur) : [...order].reverse().find(t => barOf(t) < cur);
    if (!hit) return;
    const first = order.find(t => barOf(t) === barOf(hit));
    selectNote(first.srcId, false);
    reveal(first);
  }

  function stepSelection(dir) {
    const r = state.render;
    if (!r) return;
    const firsts = liveOrder();
    if (!firsts.length) return;
    let idx = -1;
    if (state.selection.size) idx = firsts.findIndex(t => t.srcId === [...state.selection].pop());
    idx = idx < 0 ? (dir > 0 ? 0 : firsts.length - 1) : Math.min(firsts.length - 1, Math.max(0, idx + dir));
    selectNote(firsts[idx].srcId, false);
    const el = document.getElementById(firsts[idx].svgId);
    if (el) C.scrollToEl(el);
  }

  Object.assign(C, { pendingIds, parseId, isLive, noteById, moveSelection, resizeSelection, gridBeats, selectNote, stepSelection,
    extendSelection, stepBar });
})();
