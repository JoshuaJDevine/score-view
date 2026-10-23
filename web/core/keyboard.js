// Score View page core: built-in shortcuts. SV.hooks.keydown runs first (in registration order, see core/base.js);
// a hook returning true takes the key.
(function () {
  'use strict';
  const C = window.SV.core;
  const { SB, state, store, runHooks } = C;

  // Arrow-key layouts (View ▾ > Keys, saved as scoreview.keys). Each action names the modifiers it takes ('' = none;
  // 'Ctrl+Shift+Alt' order). nav/extend/bar select notes; move/resize edit them; step/semi/oct change the pitch.
  const KEYMAPS = {
    scoreview: { label: 'Score View', nav: '', extend: 'Shift', bar: 'Ctrl', move: 'Alt', resize: 'Shift+Alt', step: '', semi: 'Alt', oct: 'Ctrl' },
    sibelius: { label: 'Sibelius', nav: '', extend: 'Shift', bar: 'Ctrl', move: 'Alt', resize: 'Shift+Alt', step: 'Alt', semi: '', oct: 'Ctrl' },
    dorico: { label: 'Dorico', nav: '', extend: 'Shift', bar: 'Ctrl', move: 'Alt', resize: 'Shift+Alt', step: 'Alt', semi: 'Shift+Alt', oct: 'Ctrl+Alt' },
    classic: { label: 'Classic', nav: null, extend: null, bar: null, move: '', resize: 'Shift', step: 'Alt', semi: '', oct: 'Shift' },
  };
  let keymap = KEYMAPS[store.get('keys', 'scoreview')] ? store.get('keys', 'scoreview') : 'scoreview';
  const modsOf = e => [(e.ctrlKey || e.metaKey) && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt'].filter(Boolean).join('+');
  const actionFor = (mods, vertical) => {
    const m = KEYMAPS[keymap];
    return (vertical ? ['step', 'semi', 'oct'] : ['nav', 'extend', 'bar', 'move', 'resize']).find(a => m[a] === mods) || null;
  };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
    if (runHooks('keydown', e)) { e.preventDefault(); return; }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { C.send([e.shiftKey ? 'redo' : 'undo']); e.preventDefault(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { C.send(['redo']); e.preventDefault(); return; }
    if (e.key === 'Escape') { state.selection.clear(); C.paintSelection(); return; }
    if (ctrl && e.key.toLowerCase() === 'a') {
      state.selection = new Set(C.liveNotes().filter(n => n.pitch >= C.ksMin()).map(n => n.id));
      C.paintSelection(); e.preventDefault(); return;
    }
    if (e.key === 'Tab') { C.stepSelection(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
    if (!ctrl && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') { C.togglePin(C.currentTrack()); return; }
    // Left / right navigation works without a selection too (it starts at the first / last note).
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowRight' ? 1 : -1, act = actionFor(modsOf(e), false);
      if (act === 'nav') { C.stepSelection(dir); e.preventDefault(); return; }
      if (act === 'extend') { C.extendSelection(dir); e.preventDefault(); return; }
      if (act === 'bar') { C.stepBar(dir); e.preventDefault(); return; }
    }
    if (!state.selection.size) return;
    const fifths = state.render ? state.render.keyFifths : 0;
    const gridSteps = Math.max(1, Math.round(C.gridBeats() * (state.liveData ? state.liveData.stepsPerBeat : 8)));
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = e.key === 'ArrowUp' ? 1 : -1, act = actionFor(modsOf(e), true);
        if (act === 'oct') C.moveSelection(0, () => 12 * dir);
        else if (act === 'step') C.moveSelection(0, y => SB.diatonicStep(y, fifths, dir) - y);
        else if (act === 'semi') C.moveSelection(0, () => dir);
        else handled = false;
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowRight' ? 1 : -1, act = actionFor(modsOf(e), false);
        if (act === 'resize') C.resizeSelection(dir * C.gridBeats());
        else if (act === 'move') C.moveSelection(dir * gridSteps, () => 0);
        else handled = false;
        break;
      }
      case 'Delete':
      case 'Backspace':
        C.send([...state.selection].map(id => { const { ch, x, y } = C.parseId(id); return `del ${ch} ${x} ${y}`; }));
        state.selection.clear();
        break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  // The registry (core/shortcuts.js) lists these in the help; the handler above stays the authority.
  const K = (keys, desc, when = 'always') => window.SV.shortcuts.register({ keys, owner: 'core', group: 'editing', desc, when });
  K(['Ctrl+Z'], 'undo in Bitwig');
  K(['Ctrl+Y', 'Ctrl+Shift+Z'], 'redo in Bitwig');
  K('Escape', 'clear the selection', 'normal');
  K('Ctrl+A', 'select all notes of the clip');
  K(['Tab', 'Shift+Tab'], 'next / previous note');
  K('P', 'pin / unpin the selected clip\'s track (Clip view shows the pinned tracks too)');
  K('Delete', 'delete the selected notes');
  K('Backspace', 'delete the selected notes', 'normal');

  // The arrow keys follow the layout: registered (and the footer line written) for the current one, again on a change.
  const DESC = {
    nav: 'previous / next note', extend: 'extend the selection to the previous / next note', bar: 'first note of the previous / next bar',
    move: 'selected notes: move by the grid', resize: 'selected notes: shorter / longer',
    step: 'selected notes: scale step up / down', semi: 'selected notes: semitone up / down', oct: 'selected notes: octave up / down',
  };
  const SHORT = { nav: 'note', extend: 'extend', bar: 'bar', move: 'move', resize: 'length', step: 'scale step', semi: 'semitone', oct: 'octave' };
  const VERTICAL = ['step', 'semi', 'oct'];
  let arrowEntries = [];
  const combo = (mods, key) => (mods ? mods + '+' : '') + key;
  const kbd = (mods, a, b) => (mods ? mods.split('+').map(m => '<kbd>' + m + '</kbd>+').join('') : '') + '<kbd>' + a + '</kbd><kbd>' + b + '</kbd>';
  function applyKeymap() {
    arrowEntries.forEach(en => window.SV.shortcuts.remove(en));
    const m = KEYMAPS[keymap];
    arrowEntries = Object.keys(DESC).filter(a => m[a] != null).map(a => window.SV.shortcuts.register({
      keys: VERTICAL.includes(a) ? [combo(m[a], 'ArrowUp'), combo(m[a], 'ArrowDown')] : [combo(m[a], 'ArrowLeft'), combo(m[a], 'ArrowRight')],
      owner: 'core', group: 'editing', desc: DESC[a], when: 'normal' }));
    const help = document.getElementById('helpKeys');
    if (help) help.innerHTML = ['nav', 'move', 'resize', 'step', 'semi', 'oct'].filter(a => m[a] != null)
      .map(a => kbd(m[a], VERTICAL.includes(a) ? '↑' : '←', VERTICAL.includes(a) ? '↓' : '→') + ' ' + SHORT[a]).join(' · ');
  }
  const presetSel = document.getElementById('keyPreset');
  if (presetSel) {
    presetSel.value = keymap;
    presetSel.addEventListener('change', () => { keymap = presetSel.value; store.set('keys', keymap); applyKeymap(); presetSel.blur(); });
  }
  applyKeymap();
  window.SV.keymap = {
    list: () => Object.keys(KEYMAPS).map(id => Object.assign({ id }, KEYMAPS[id])), get: () => keymap,
    set(id) { if (!KEYMAPS[id]) return; keymap = id; store.set('keys', id); if (presetSel) presetSel.value = id; applyKeymap(); },
  };
})();
