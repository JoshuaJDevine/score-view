// Score View page core: the Tracks ▾ picker (pins, groups, all / pinned) and the Pin button.
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, store, escapeHtml } = C;

  function renderTrackList() {
    const list = $('trackList');
    const names = C.scoreTrackNames();
    const shown = C.visibleTrackNames();
    const groups = new Map();
    names.forEach(n => {
      const p = state.base && state.base.parts.find(x => x.name === n);
      const g = (p && p.group) || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(n);
    });
    const all = state.trackMode === 'all', cur = C.currentTrack();
    let html = '';
    groups.forEach((ns, g) => {
      if (g) html += `<div class="tgroup"><a data-group="${escapeHtml(g)}" title="Pin/unpin the whole group">${escapeHtml(g)}</a></div>`;
      ns.forEach(n => {
        html += `<label><input type="checkbox" data-track="${escapeHtml(n)}" ${state.pinned.has(n) ? 'checked' : ''} ${all ? 'disabled' : ''}> ${escapeHtml(n)}` +
          (n === cur ? ' <span class="cur">selected</span>' : '') + '</label>';
      });
    });
    list.innerHTML = html || '<div class="tgroup">Load a .dawproject to list tracks</div>';
    document.querySelectorAll('input[name=trackMode]').forEach(r => { r.checked = r.value === state.trackMode; });
    $('trackBtn').textContent = 'Tracks: ' + (all ? 'all' : shown.size + ' shown') + ' ▾';
    $('pinBtn').textContent = cur ? (state.pinned.has(cur) ? 'Unpin ' : 'Pin ') + cur : 'Pin';
    $('pinBtn').disabled = !cur || all;
  }

  $('trackBtn').addEventListener('click', e => { $('trackPanel').classList.toggle('hidden'); e.stopPropagation(); });
  document.addEventListener('click', e => { if (!$('trackPanel').contains(e.target)) $('trackPanel').classList.add('hidden'); });
  $('trackPanel').addEventListener('change', e => {
    if (e.target.name === 'trackMode') {
      state.trackMode = e.target.value;
      store.set('trackMode2', state.trackMode);
    } else if (e.target.dataset.track) {
      if (e.target.checked) state.pinned.add(e.target.dataset.track); else state.pinned.delete(e.target.dataset.track);
      store.set('pinned', [...state.pinned]);
    }
    renderTrackList();
    C.requestRender();
  });
  $('trackPanel').addEventListener('click', e => {
    const g = e.target.dataset && e.target.dataset.group;
    if (!g || !state.base) return;
    const members = state.base.parts.filter(p => p.group === g).map(p => p.name);
    const allPinned = members.every(n => state.pinned.has(n));
    members.forEach(n => allPinned ? state.pinned.delete(n) : state.pinned.add(n));
    store.set('pinned', [...state.pinned]);
    renderTrackList();
    C.requestRender();
  });
  $('clearPins').addEventListener('click', () => {
    state.pinned.clear();
    store.set('pinned', []);
    renderTrackList();
    C.requestRender();
  });
  $('pinBtn').addEventListener('click', () => C.togglePin(C.currentTrack()));

  Object.assign(C, { renderTrackList });
})();
