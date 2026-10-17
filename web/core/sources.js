// Score View page core: note sources — the live clip, its placement in the arrangement, overlays of edited clips,
// the visible tracks and the score model handed to the render pipeline.
(function () {
  'use strict';
  const C = window.SV.core;
  const { $, state, store, hooks } = C;

  const liveId = n => 'L' + n.ch + '_' + n.x + '_' + n.y;
  const ksMin = () => $('hideKs').checked ? 24 : 0; // BBCSO-style keyswitches sit below C1

  // A clip plays its content from playStart (Bitwig's "Offset", moved by trimming the clip's start) to playStop
  // (d.length). The score shows that visible window: beat 0 = the clip's visible start.
  const clipStart = d => (d && d.playStart) || 0;
  const visLength = d => Math.max(0, ((d && d.length) || 0) - clipStart(d));

  function liveNotes() {
    const d = state.liveData;
    if (!d || !d.exists) return [];
    const ps = clipStart(d);
    return d.notes.map(n => ({ id: liveId(n), start: n.x / d.stepsPerBeat - ps, dur: n.d, pitch: n.y }))
      .filter(n => n.start > -1e-6 && n.start < visLength(d) - 1e-6);
  }

  /** Where the clip's content beat 0 sits on the score's beat axis (step x = (scoreBeat - origin) * stepsPerBeat). */
  function contentOrigin() {
    const d = state.liveData;
    const placed = state.mode === 'score' && state.align ? state.align.offset : 0;
    return placed - clipStart(d);
  }

  // Finds where the live clip sits in the arrangement by matching its notes against the export (web/align.js):
  // the opening notes count most (a clip edited later still starts the same); equally good places are ordered by
  // closeness to the playhead and can be cycled with ◀ ▶. The playhead while playing is exact and always wins;
  // a placement picked by hand is kept until another clip is selected.
  const clipKey = d => [d.track, d.length, d.playStart, d.loopStart, d.loopLength].join('|');
  function alignLive() {
    const d = state.liveData;
    if (!d || !d.exists || !state.base) { state.align = null; return; }
    const key = clipKey(d);
    const cur = state.align && state.align.key === key ? state.align : null;
    const part = state.base.parts.find(p => p.name === d.track);
    if (!part) { if (!cur || cur.how !== 'playhead') state.align = null; return; }
    const notes = liveNotes();
    if (!notes.length) return;
    const found = ClipAlign.findPlacements(notes, part.notes, { length: visLength(d), playPos: state.playPos });
    const cands = found.cands.map(c => c.offset).sort((a, b) => a - b);
    if (cur) {
      const fit = ClipAlign.openingScore(notes, part.notes, cur.offset);
      const keep = cur.how === 'match' ? !found.best || cands.includes(cur.offset) || fit >= found.best.open - 0.1
        : !found.best || found.best.open < 0.8 || fit >= 0.3; // playhead/manual: unless another clip of this size fits elsewhere
      if (keep) { cur.cands = cands; return; }
    }
    setAlign(found.best ? { track: d.track, key, offset: found.best.offset, how: 'match', cands } : null);
  }

  // Changes the placement; a snapshot recorded for this clip at a place it turned out not to be is dropped.
  function setAlign(a) {
    const old = state.align;
    if (old && (!a || a.key === old.key) && (!a || a.offset !== old.offset)) {
      const o = state.overlays.get(old.track + '@' + old.offset);
      if (o && o.key === old.key) state.overlays.delete(old.track + '@' + old.offset);
    }
    state.align = a;
  }

  // Steps through the equally good placements (status bar ◀ ▶).
  function cycleAlign(dir) {
    const a = state.align;
    if (!a) return;
    const list = [...new Set([...(a.cands || []), a.offset])].sort((x, y) => x - y);
    if (list.length < 2) return;
    const i = (list.indexOf(a.offset) + dir + list.length) % list.length;
    setAlign({ ...a, offset: list[i], how: 'manual' });
    C.render();
  }

  // Keeps a clip's current notes in the score after you leave it — only for clips edited from Score View, and only
  // once the selection has settled (on a clip switch Bitwig can report the new notes before the new track name;
  // a snapshot taken then would paint one track's notes on another's staff).
  function rememberOverlay() {
    const d = state.liveData, a = state.align;
    if (!d || !d.exists || !a || a.track !== d.track) return;
    if (!state.editedTracks.has(d.track) || Date.now() - state.trackSince < 500) return;
    state.overlays.set(d.track + '@' + a.offset, {
      track: d.track, key: a.key, offset: a.offset, length: visLength(d),
      notes: liveNotes().map(n => ({ ...n, start: n.start + a.offset })),
    });
  }

  // Bitwig only reports one selected track, so multi-track views are built from pins.
  function visibleTrackNames() {
    const all = scoreTrackNames();
    if (state.trackMode === 'all') return new Set(all);
    const names = new Set(all.filter(n => state.pinned.has(n)));
    const cur = currentTrack();
    if (cur) names.add(cur);
    const shown = names.size ? names : new Set(all);
    for (const fn of hooks.visibleTracks) {
      try { const r = fn(shown, all); if (r instanceof Set) return r; } catch (err) { console.error('hook visibleTracks', err); }
    }
    return shown;
  }

  function currentTrack() {
    const d = state.liveData;
    return d && d.exists ? d.track : null;
  }

  function togglePin(name) {
    if (!name) return;
    if (state.pinned.has(name)) state.pinned.delete(name); else state.pinned.add(name);
    store.set('pinned', [...state.pinned]);
    C.flash((state.pinned.has(name) ? 'Pinned ' : 'Unpinned ') + name);
    C.renderTrackList();
    C.render();
  }

  /** Bitwig's instrument tracks (with their group) — the staves when no score is loaded. */
  function bitwigTracks() {
    const d = state.liveData, out = [];
    let group = null;
    ((d && d.tracks) || []).forEach(t => {
      if (t.group) { group = t.name; return; }
      if (/effect|master/i.test(t.type || '') || /^master$/i.test(t.name)) { group = null; return; }
      if (t.type && !/instrument|hybrid/i.test(t.type)) return; // audio tracks have no notation
      out.push({ name: t.name, group: group || undefined });
    });
    return out;
  }

  function scoreTrackNames() {
    // With no score loaded (fresh page, new project) the project's instrument tracks are the staves.
    const names = state.base ? state.base.parts.map(p => p.name) : bitwigTracks().map(t => t.name);
    const d = state.liveData;
    if (d && d.exists && !names.includes(d.track)) names.push(d.track);
    return names;
  }

  function currentScore() {
    const key = $('keySel').value === 'auto' ? null : parseInt($('keySel').value, 10);
    const min = ksMin();
    const d = state.liveData;
    const filt = notes => notes.filter(n => n.pitch >= min);
    // part.keyswitches: every note below C1 (also those before the shown range), for features/articulations.js.
    const keyswitches = notes => notes.filter(n => n.pitch < 24);

    if (state.mode === 'clip') {
      if (!d || !d.exists) return null;
      const ln = liveNotes();
      return { title: d.track, timeSig: { num: d.num || 4, den: d.den || 4 }, keyFifths: key, lengthBeats: visLength(d),
               parts: [{ name: d.track || 'Clip', notes: filt(ln), keyswitches: keyswitches(ln) }] };
    }

    if (!state.base && !(d && d.exists)) return null;
    alignLive();
    rememberOverlay();
    const show = visibleTrackNames();
    const a = state.align, liveTrack = d && d.exists ? d.track : null;
    const parts = [];
    scoreTrackNames().forEach(name => {
      if (!show.has(name)) return;
      const basePart = state.base && state.base.parts.find(p => p.name === name);
      let notes = basePart ? basePart.notes.slice() : [];
      state.overlays.forEach(o => {
        if (o.track !== name) return;
        if (name === liveTrack && a && o.offset === a.offset) return; // replaced by live notes below
        notes = notes.filter(n => n.start < o.offset - 1e-6 || n.start >= o.offset + o.length - 1e-6)
          .concat(o.notes.map(n => ({ ...n, id: 'o' + n.id })));
      });
      if (name === liveTrack) {
        const off = a ? a.offset : 0;
        notes = notes.filter(n => n.start < off - 1e-6 || n.start >= off + visLength(d) - 1e-6)
          .concat(liveNotes().map(n => ({ ...n, start: n.start + off })));
      }
      const group = basePart ? basePart.group : ((bitwigTracks().find(t => t.name === name) || {}).group);
      parts.push({ name: name === liveTrack ? name + ' ✎' : name, group, notes: filt(notes),
                   keyswitches: keyswitches(notes) });
    });
    if (!parts.length) return null;

    const ts = state.base ? state.base.timeSig : { num: d.num || 4, den: d.den || 4 };
    const mb = ts.num * 4 / ts.den;
    let measureOffset = 0, lengthBeats = state.base ? state.base.lengthBeats : (d ? visLength(d) : 0);
    if (state.range === 'clip' && d && d.exists && (a || !state.base)) {
      const off = a ? a.offset : 0;
      measureOffset = Math.floor(off / mb);
      const endBeat = Math.ceil((off + visLength(d)) / mb - 1e-6) * mb;
      const startBeat = measureOffset * mb;
      parts.forEach(p => {
        p.notes = p.notes.filter(n => n.start >= startBeat - 1e-6 && n.start < endBeat - 1e-6)
          .map(n => ({ ...n, start: n.start - startBeat, dur: Math.min(n.dur, endBeat - n.start) }));
        p.keyswitches = p.keyswitches.filter(n => n.start < endBeat - 1e-6).map(n => ({ ...n, start: n.start - startBeat }));
      });
      lengthBeats = endBeat - startBeat;
    }
    return { title: state.base ? state.base.title : '', timeSig: ts, keyFifths: key, lengthBeats, measureOffset, parts };
  }

  /** currentScore() with the transformScore hooks applied: what render() engraves. */
  function transformedScore() {
    let score = currentScore();
    if (score) hooks.transformScore.forEach(fn => {
      try { score = fn(score, { mode: state.mode, liveTrack: currentTrack() }) || score; } catch (err) { console.error('transformScore', err); }
    });
    return score;
  }

  Object.assign(C, {
    liveId, ksMin, clipStart, visLength, liveNotes, contentOrigin, clipKey, alignLive, setAlign, cycleAlign,
    rememberOverlay, visibleTrackNames, currentTrack, togglePin, bitwigTracks, scoreTrackNames, currentScore,
    transformedScore,
  });
})();
