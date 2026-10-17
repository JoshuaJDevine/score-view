// Score View page core: the Bitwig connection — long poll of the selected clip (/api/notes), the transport feed
// (/api/play) and edits (/api/edit).
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, runHooks, live } = C;

  async function pollNotes() {
    let v = -1;
    for (;;) {
      try {
        const res = await fetch('/api/notes?v=' + v, { cache: 'no-store' });
        const d = await res.json();
        setConnected(true);
        if (d.v !== v) {
          v = d.v;
          const prev = state.liveData;
          state.liveData = d;
          state.source = d.source;
          C.markSeg('srcSeg', 'src', d.source);
          if (!prev || prev.track !== d.track) { state.align = null; state.trackSince = Date.now(); }
          // Another Bitwig project: drop the previous project's score, pins and remembered export.
          if (d.project && state.baseProject && d.project !== state.baseProject) C.dropProjectScore(d.project);
          const present = new Set(d.notes.map(C.liveId));
          state.selection.forEach(id => { if (!present.has(id) && !C.pendingIds.has(id)) state.selection.delete(id); });
          runHooks('liveData', d);
          if (!prev || noteSig(prev) !== noteSig(d) || trackSig(prev) !== trackSig(d) || prev.exists !== d.exists) C.requestRender();
          else C.updateStatus();
          C.renderTrackList();
        }
      } catch (e) {
        setConnected(false);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  const noteSig = d => d.track + '|' + d.length + '|' + d.playStart + '|' + d.num + '/' + d.den + '|' + d.notes.map(n => n.ch + ',' + n.x + ',' + n.y + ',' + n.d).join(';');
  const trackSig = d => (d.tracks || []).map(t => t.name + (t.sel ? '*' : '')).join('|');

  async function pollPlay() {
    for (;;) {
      try {
        const d = await (await fetch('/api/play', { cache: 'no-store' })).json();
        state.playing = d.playing;
        state.playPos = d.pos;
        runHooks('play', d);
        const ld = state.liveData;
        // While playing, the clip's arrangement position is exactly playhead - step.
        if (state.mode === 'score' && d.playing && d.step >= 0 && ld && ld.exists && state.source === 'arranger') {
          const off = Math.round((d.pos - d.step / ld.stepsPerBeat + C.clipStart(ld)) * 8) / 8; // visible clip start
          if (off >= 0 && (!state.align || state.align.track !== ld.track || Math.abs(state.align.offset - off) > 0.01)) {
            C.setAlign({ track: ld.track, key: C.clipKey(ld), offset: off, how: 'playhead', cands: state.align && state.align.key === C.clipKey(ld) ? state.align.cands : [] });
            C.requestRender();
          }
        }
        let beat = -1;
        if (state.mode === 'clip' && d.step >= 0 && ld) beat = d.step / ld.stepsPerBeat - C.clipStart(ld);
        if (state.mode === 'score') beat = d.pos;
        if (!d.playing && state.mode === 'clip') beat = -1;
        if (beat !== state.playBeat) { state.playBeat = beat; C.paintPlayhead(false); }
      } catch (e) { /* connection state handled by pollNotes */ }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  function setConnected(ok) {
    if (state.connected === ok) return;
    state.connected = ok;
    $('dot').classList.toggle('ok', ok);
    if (!ok) C.requestRender();
  }

  function send(lines) {
    if (!live || !lines.length) return;
    const d = state.liveData;
    if (d && d.exists && lines.some(l => /^(add|del|move|dur|vel) /.test(l))) state.editedTracks.add(d.track);
    fetch('/api/edit', { method: 'POST', body: lines.join('\n') });
  }

  Object.assign(C, { pollNotes, pollPlay, setConnected, send });
})();
