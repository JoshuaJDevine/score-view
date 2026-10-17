// Score View page core: built-in shortcuts. SV.hooks.keydown runs first (in registration order, see core/base.js);
// a hook returning true takes the key.
(function () {
  'use strict';
  const C = window.SV.core;
  const { SB, state, runHooks } = C;

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
    if (!ctrl && !e.altKey && e.key.toLowerCase() === 'p' && state.mode === 'score') { C.togglePin(C.currentTrack()); return; }
    if (!state.selection.size) return;
    const fifths = state.render ? state.render.keyFifths : 0;
    const gridSteps = Math.max(1, Math.round(C.gridBeats() * (state.liveData ? state.liveData.stepsPerBeat : 8)));
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        if (e.shiftKey) C.moveSelection(0, () => 12 * dir);
        else if (e.altKey) C.moveSelection(0, y => SB.diatonicStep(y, fifths, dir) - y);
        else C.moveSelection(0, () => dir);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        if (e.shiftKey) C.resizeSelection(dir * C.gridBeats());
        else C.moveSelection(dir * gridSteps, () => 0);
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
  K('P', 'Score mode: pin / unpin the selected clip\'s track');
  K(['ArrowUp', 'ArrowDown'], 'selected notes: semitone up / down');
  K(['Alt+ArrowUp', 'Alt+ArrowDown'], 'selected notes: scale step up / down');
  K(['Shift+ArrowUp', 'Shift+ArrowDown'], 'selected notes: octave up / down');
  K(['ArrowLeft', 'ArrowRight'], 'selected notes: move by the grid', 'normal');
  K(['Shift+ArrowLeft', 'Shift+ArrowRight'], 'selected notes: shorter / longer');
  K('Delete', 'delete the selected notes');
  K('Backspace', 'delete the selected notes', 'normal');
})();
