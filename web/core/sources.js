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
    if (!d || !d.exists) { state.align = null; return; }
    const key = clipKey(d);
    const cur = state.align && state.align.key === key ? state.align : null;
    // Last resort: the play start marker, which Bitwig moves to a clip you select (how 'guess': anything better wins).
    const g = state.playStartGuess;
    const guess = g && g.key === key && g.beat != null ? { track: d.track, key, offset: g.beat, how: 'guess', cands: [] } : null;
    // After a Read, a read clip of this track starting at the play start marker is where the selected clip is: note
    // matching against the read can land on old notes elsewhere when the clip changed since (live 2026-10-18: a
    // quantized Violin 2 matched at bar 6 instead of its clip at bar 1).
    const readHere = guess && state.crawl && (state.crawl.result || []).some(c => c.track === d.track && Math.abs(c.start - guess.offset) < 1e-6);
    if (readHere && (!cur || cur.how === 'match' || cur.how === 'guess')) {
      if (!cur || cur.how !== 'guess' || cur.offset !== guess.offset) setAlign(guess);
      return;
    }
    const part = state.base && state.base.parts.find(p => p.name === d.track);
    if (!part) { if (!cur || (cur.how !== 'playhead' && cur.how !== 'guess')) state.align = guess; return; }
    const notes = liveNotes();
    if (!notes.length) return;
    const found = ClipAlign.findPlacements(notes, part.notes, { length: visLength(d), playPos: state.playPos });
    const cands = found.cands.map(c => c.offset).sort((a, b) => a - b);
    if (cur) {
      const fit = ClipAlign.openingScore(notes, part.notes, cur.offset);
      const keep = cur.how === 'match' ? !found.best || cands.includes(cur.offset) || fit >= found.best.open - 0.1
        : cur.how === 'guess' ? !found.best
        : !found.best || found.best.open < 0.8 || fit >= 0.3; // playhead/manual: unless another clip of this size fits elsewhere
      if (keep) { cur.cands = cands; return; }
    }
    setAlign(found.best ? { track: d.track, key, offset: found.best.offset, how: 'match', cands } : guess);
  }

  // Remembers where the play start marker is once another clip was selected (Bitwig moves it to the clip a little
  // after reporting the clip's notes): the placement of last resort for Score mode. The extension reports it with
  // the data (selPlayStart), trusted from settled snapshots only; a later settled snapshot within GUESS_WINDOW_MS of
  // the switch may still correct it (the marker came late), after that a moved marker no longer moves the clip.
  // An extension without the field: fetched from /api/transport 400 ms after the switch.
  const GUESS_WINDOW_MS = 1500;
  let guessTimer = 0;
  function refreshPlayStartGuess(d) {
    const key = clipKey(d);
    if ('selPlayStart' in d) {
      let g = state.playStartGuess;
      if (!g || g.key !== key) { clearTimeout(guessTimer); g = state.playStartGuess = { key, beat: null, since: Date.now() }; }
      if (!d.settled || d.selPlayStart == null || state.playing || g.beat === d.selPlayStart) return;
      if (g.beat != null && Date.now() - g.since > GUESS_WINDOW_MS) return;
      g.beat = d.selPlayStart;
      if (state.mode === 'score' && (!state.align || state.align.how === 'guess')) C.requestRender();
      return;
    }
    if (state.playStartGuess && state.playStartGuess.key === key) return;
    state.playStartGuess = { key, beat: null };
    clearTimeout(guessTimer);
    guessTimer = setTimeout(() => {
      fetch('/api/transport', { cache: 'no-store' }).then(r => r.json()).then(t => {
        const g = state.playStartGuess;
        if (!g || g.key !== key || t.playing || (t.clip && !t.clip.exists)) return;
        g.beat = t.playStart;
        if (state.mode === 'score' && (!state.align || state.align.how === 'guess')) C.requestRender();
      }).catch(() => {});
    }, 400);
  }

  // A clip position measured from the playhead (pos - step, ~0.1 beat of jitter): the nearest beat when within
  // PLAYHEAD_SLACK of it, else the nearest 16th (a clip that really starts off the beat).
  const PLAYHEAD_SLACK = 0.3;
  function playheadOffset(raw) {
    const beat = Math.round(raw);
    return Math.abs(raw - beat) <= PLAYHEAD_SLACK ? beat : Math.round(raw * 4) / 4;
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

  // Is the live data settled? On a clip switch Bitwig swaps the notes one by one and reports the new track (and moves
  // the play start marker) a moment later, so data taken meanwhile can put one clip's notes on another's staff.
  // The extension says so itself (d.settled, LiveSync.java: 100 ms of quiet, 200 ms after a clip switch); for one
  // that does not send the field the page waits SETTLE_MS of quiet (core/net.js runs hooks.liveSettled then).
  const SETTLE_MS = 200;
  function liveSettledNow() {
    const d = state.liveData;
    if (!d) return false;
    if (typeof d.settled === 'boolean') return d.settled;
    const now = Date.now();
    return now - state.trackSince >= SETTLE_MS && now - (state.liveChangedAt || 0) >= SETTLE_MS;
  }

  // Keeps a clip's current notes in the score after you leave it — only for clips edited from Score View, and only
  // from settled data (a snapshot taken mid-switch would paint one track's notes on another's staff).
  function rememberOverlay() {
    const d = state.liveData, a = state.align;
    if (!d || !d.exists || !a || a.track !== d.track) return;
    if (!state.editedTracks.has(d.track) || !liveSettledNow()) return;
    state.overlays.set(d.track + '@' + a.offset, {
      track: d.track, key: a.key, offset: a.offset, length: visLength(d),
      notes: liveNotes().map(n => ({ ...n, start: n.start + a.offset })),
    });
  }

  // Bitwig only reports one selected track, so multi-track views are built from pins.
  function visibleTrackNames() {
    const all = scoreTrackNames();
    let shown;
    if (state.trackMode === 'all') shown = new Set(all);
    else {
      const names = new Set(all.filter(n => state.pinned.has(n)));
      const cur = currentTrack();
      if (cur) names.add(cur);
      shown = names.size ? names : new Set(all);
    }
    // hooks may narrow it (features/sections.js: a section view in Score view)
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
    const on = !state.pinned.has(name);
    C.setPinned(name, on);
    C.flash((on ? 'Pinned ' : 'Unpinned ') + name + (on && state.view === 'clip' ? ': it stays in Clip view next to the clip you select' : ''));
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
    // Hide unused instruments (View ▾): parts with no notes in the shown bars go, except the live one and pinned ones.
    const hideUnused = () => $('hideUnused') && $('hideUnused').checked && !state.showAllStaves && !(state.base && state.base.fresh);
    // used: notes in the shown bars, or a clip there (an empty clip is somewhere to paste or write into)
    const crawlClips = (state.crawl && state.crawl.result) || [];
    const clipEndOf = (c, i, all) => { const fn = window.SV.arrangement && window.SV.arrangement.clipEnd; const next = all.filter(o => o.track === c.track && o.start > c.start).sort((a, b) => a.start - b.start)[0];
      return fn ? fn(c, next) : c.start + (c.playStop - c.playStart); };
    const hasClipIn = (name, from, to) => crawlClips.some((c, i, all) => c.track === name && c.start < to - 1e-6 && clipEndOf(c, i, all) > from + 1e-6);
    let shownFrom = 0, shownTo = Infinity;
    const used = p => p.name.endsWith(' ✎') || state.pinned.has(p.name) || p.notes.some(n => n.pitch >= ksMin()) || hasClipIn(p.name, shownFrom, shownTo);

    const ts = state.base ? state.base.timeSig : { num: d.num || 4, den: d.den || 4 };
    const mb = ts.num * 4 / ts.den;
    // Whole song: bar 1 to the end of the last clip, the live clip (and remembered edited clips) included.
    let measureOffset = 0, lengthBeats = state.base ? state.base.lengthBeats : (d ? visLength(d) : 0);
    if (d && d.exists && a) lengthBeats = Math.max(lengthBeats, a.offset + visLength(d));
    state.overlays.forEach(o => { lengthBeats = Math.max(lengthBeats, o.offset + o.length); });
    if (state.range === 'clip' && d && d.exists && (a || !state.base)) {
      const off = a ? a.offset : 0;
      // The selected clip's bars, widened to the clips on the shown staves that overlap it (Read): from the earliest
      // of them to the latest, so a pinned track's clip that starts earlier or ends later is not cut.
      let from = off, to = off + visLength(d);
      const shownNames = new Set(parts.map(p => p.name.replace(/ ✎$/, '')));
      crawlClips.forEach((c, i, all) => {
        if (!shownNames.has(c.track)) return;
        const end = clipEndOf(c, i, all);
        if (c.start < to - 1e-6 && end > from + 1e-6) { from = Math.min(from, c.start); to = Math.max(to, end); }
      });
      measureOffset = Math.floor(Math.max(0, from) / mb);
      const endBeat = Math.ceil(to / mb - 1e-6) * mb;
      const startBeat = measureOffset * mb;
      parts.forEach(p => {
        p.notes = p.notes.filter(n => n.start >= startBeat - 1e-6 && n.start < endBeat - 1e-6)
          .map(n => ({ ...n, start: n.start - startBeat, dur: Math.min(n.dur, endBeat - n.start) }));
        p.keyswitches = p.keyswitches.filter(n => n.start < endBeat - 1e-6).map(n => ({ ...n, start: n.start - startBeat }));
      });
      lengthBeats = endBeat - startBeat;
      shownFrom = startBeat; shownTo = endBeat;
    }
    if (hideUnused() && parts.some(used)) for (let i = parts.length - 1; i >= 0; i--) if (!used(parts[i])) parts.splice(i, 1);
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
    liveId, ksMin, clipStart, visLength, liveNotes, contentOrigin, clipKey, alignLive, setAlign, cycleAlign, playheadOffset, PLAYHEAD_SLACK,
    refreshPlayStartGuess,
    rememberOverlay, SETTLE_MS, liveSettledNow, visibleTrackNames, currentTrack, togglePin, bitwigTracks, scoreTrackNames, currentScore,
    transformedScore,
  });
})();
