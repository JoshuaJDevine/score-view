// Score View page core: the Bitwig connection — long poll of the selected clip (/api/notes), the transport feed
// (/api/play) and edits (/api/edit).
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, runHooks, live } = C;

  let settleTimer = 0;
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
          if (!prev || prev.track !== d.track) {
            state.align = null; state.trackSince = Date.now();
            if (state.view === 'clip' && C.applyView) C.applyView(); // another track: is it pinned, are others?
          }
          state.liveChangedAt = Date.now() - (d.changedMs || 0);
          // Another Bitwig project: drop the previous project's score, pins and remembered export.
          if (d.project && state.baseProject && d.project !== state.baseProject) C.dropProjectScore(d.project);
          const present = new Set(d.notes.map(C.liveId));
          state.selection.forEach(id => { if (!present.has(id) && !C.pendingIds.has(id)) state.selection.delete(id); });
          if (d.exists && d.source === 'arranger') C.refreshPlayStartGuess(d);
          runHooks('liveData', d);
          if (!prev || noteSig(prev) !== noteSig(d) || trackSig(prev) !== trackSig(d) || prev.exists !== d.exists) C.requestRender();
          else C.updateStatus();
          C.renderTrackList();
          // Settled data (remember an edited clip's notes, hooks.liveSettled): the extension says when (d.settled,
          // LiveSync.java publishes one more version once nothing changed for a quiet window); with an extension
          // that does not send the field (or an old mock) a page-side quiet timer of SETTLE_MS decides instead.
          clearTimeout(settleTimer);
          if (typeof d.settled === 'boolean') { if (d.settled) settled(); }
          else settleTimer = setTimeout(settled, C.SETTLE_MS + 20);
        }
      } catch (e) {
        setConnected(false);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  function settled() {
    state.settledAt = Date.now();
    if (state.mode === 'score') C.rememberOverlay();
    runHooks('liveSettled', state.liveData);
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
        // While playing, the clip's arrangement position is playhead - step. The two values are observed separately
        // and can be up to ~0.1 beat apart, so the result snaps to the beat and small differences are ignored (a clip
        // drawn 1/8 beat off engraves as tuplets and ties, and flickers between readings).
        if (state.mode === 'score' && d.playing && d.step >= 0 && ld && ld.exists && state.source === 'arranger') {
          const off = C.playheadOffset(d.pos - d.step / ld.stepsPerBeat + C.clipStart(ld)); // visible clip start
          const same = state.align && state.align.track === ld.track && state.align.key === C.clipKey(ld);
          if (off >= 0 && (!same || Math.abs(state.align.offset - off) > C.PLAYHEAD_SLACK)) {
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
    if (d && d.exists && lines.some(l => /^(add|del|move|dur|vel) /.test(l))) {
      state.editedTracks.add(d.track);
      state.lastEditMs = Date.now(); // features/arrangement.js: a big change after this is an edit, not another clip
    }
    fetch('/api/edit', { method: 'POST', body: lines.join('\n') });
  }

  Object.assign(C, { pollNotes, pollPlay, setConnected, send });
})();
