// Feature module: playback. See docs/AGENTS.md for the SV hook API.
//  * Rehearsal marks from Bitwig's cue markers (live) or the DAWproject's arrangement markers.
//  * Transport from the score: click a bar number (or Alt+click in a bar) = play from that bar,
//    Space = play/stop, L = loop the selection's bars (or the last clicked bar), Shift+L = loop off.
//  * Solo/mute buttons on staff-label hover, and a compact transport strip in the toolbar.
// Beats sent to Bitwig are arranger beats. In Score mode the rendered bars are arranger bars
// (measure ids m<N> carry the absolute bar number); in Clip mode the clip's arranger position is
// taken from Score mode's alignment or learned from the playhead while the clip plays.
(function () {
  'use strict';
  const SV = window.SV;
  if (!SV) return;
  const S = SV.state;
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('scoreview.playback.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('scoreview.playback.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  let showMarks = store.get('marks', true);
  let play = { playing: false, pos: 0, tempo: 120, loop: null };
  let lastBar = null;               // { start, end } render beats of the last clicked bar
  const learnedOffsets = new Map(); // track name -> arranger beat of the clip start (from the playhead)

  const fmt = b => String(Math.round(b * 1e6) / 1e6);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ time mapping

  function timeSig() {
    if (S.mode === 'score' && S.base) return S.base.timeSig;
    const d = S.liveData;
    return { num: (d && d.num) || 4, den: (d && d.den) || 4 };
  }
  const barBeats = () => (S.render ? S.render.measureBeats : timeSig().num * 4 / timeSig().den);

  // Arranger beat of the selected clip's start, or null when unknown (launcher clip / never seen playing).
  function clipOffset() {
    const d = S.liveData;
    if (!d || !d.exists || S.source !== 'arranger') return null;
    if (S.align && S.align.track === d.track) return S.align.offset;
    return learnedOffsets.has(d.track) ? learnedOffsets.get(d.track) : null;
  }

  // Render beats (timeline / hitTest / measure numbers) -> arranger beats.
  function toArranger(beat) {
    if (S.mode === 'score') return beat;
    const off = clipOffset();
    return off == null ? null : off + beat;
  }

  function markers() {
    const d = S.liveData;
    if (d && Array.isArray(d.markers) && d.markers.length) return d.markers;
    return (S.base && S.base.markers) || [];
  }

  // ------------------------------------------------------------------ rehearsal marks

  SV.hooks.transformScore.push((score, ctx) => {
    if (!showMarks) return score;
    const ts = score.timeSig || { num: 4, den: 4 };
    const mb = ts.num * 4 / ts.den;
    let origin;
    if (ctx.mode === 'score') origin = (score.measureOffset || 0) * mb;
    else { origin = clipOffset(); if (origin == null) return score; }
    const len = score.lengthBeats || Infinity;
    const dirs = markers().map(m => ({ beat: m.beat - origin, text: String(m.name || '').trim() || '•', kind: 'reh' }))
      .filter(m => m.beat > -1e-6 && m.beat < len - 1e-6)
      .map(m => ({ ...m, beat: Math.max(0, m.beat) }));
    if (dirs.length) score.directions = (score.directions || []).concat(dirs);
    return score;
  });

  // ------------------------------------------------------------------ transport actions

  function playFromBar(n) {
    const mb = barBeats();
    const beat = (n - 1) * mb;
    lastBar = { start: beat, end: beat + mb };
    const arr = toArranger(beat);
    if (arr == null) return unknownClipPosition();
    SV.send(['playFrom ' + fmt(arr)]);
    play.playing = true;
    SV.flash('Play from bar ' + n);
    updateStrip();
  }

  function unknownClipPosition() {
    SV.flash(S.source === 'launcher'
      ? 'Play from the score works on the arranger timeline (switch to Arranger or Score mode).'
      : 'Clip position in the arrangement unknown — play it once in Bitwig, or use Score mode.');
  }

  function togglePlay() {
    SV.send([play.playing ? 'stop' : 'play']);
    play.playing = !play.playing;
    updateStrip();
  }

  // Bars covered by the selection (render beats), else the last clicked bar, else the bar under the playhead.
  function loopRange() {
    const r = S.render, mb = barBeats();
    if (r && S.selection.size) {
      let lo = Infinity, hi = -Infinity;
      S.selection.forEach(id => (r.bySrc.get(id) || []).forEach(t => { lo = Math.min(lo, t.start); hi = Math.max(hi, t.end); }));
      if (lo < Infinity) {
        const a = Math.floor(lo / mb + 1e-6), b = Math.max(a + 1, Math.ceil(hi / mb - 1e-6));
        return { start: a * mb, end: b * mb };
      }
    }
    if (lastBar) return lastBar;
    if (play.playing && S.playBeat >= 0) { const a = Math.floor(S.playBeat / mb); return { start: a * mb, end: (a + 1) * mb }; }
    return null;
  }

  function loopSelection() {
    const range = loopRange();
    if (!range) return SV.flash('Select notes or click a bar number first, then press L to loop.');
    const arr = toArranger(range.start);
    if (arr == null) return unknownClipPosition();
    const mb = barBeats(), a = Math.round(range.start / mb) + 1, b = Math.round(range.end / mb);
    SV.send(['loop ' + fmt(arr) + ' ' + fmt(range.end - range.start)]);
    play.loop = { on: true, start: arr, length: range.end - range.start };
    SV.flash('Loop ' + (a === b ? 'bar ' + a : 'bars ' + a + '–' + b));
    updateStrip();
  }

  function loopOff() {
    SV.send(['loopOff']);
    if (play.loop) play.loop = { ...play.loop, on: false };
    SV.flash('Loop off');
    updateStrip();
  }

  // ------------------------------------------------------------------ mouse: bar numbers / Alt+click

  function measureAt(e) {
    let hit = null;
    document.querySelectorAll('#paper g.measure').forEach(m => {
      const b = m.getBoundingClientRect();
      if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top - 20 && e.clientY <= b.bottom + 20) hit = hit || m;
    });
    return hit;
  }

  document.addEventListener('mousedown', e => {
    if (e.button !== 0 || !e.target.closest || !e.target.closest('#paper')) return;
    const num = e.target.closest('#paper g.mNum');
    if (!num && !e.altKey) return;
    const m = num ? num.closest('g.measure') : measureAt(e);
    const n = m && parseInt(m.id.replace(/^m/, ''), 10);
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    playFromBar(n);
  }, true);

  // ------------------------------------------------------------------ keys

  SV.hooks.keydown.push(e => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === ' ' && !ctrl && !e.altKey && !e.shiftKey) { togglePlay(); return true; }
    if (e.key.toLowerCase() === 'l' && !ctrl && !e.altKey) { if (e.shiftKey) loopOff(); else loopSelection(); return true; }
    return false;
  });

  if (SV.shortcuts) {
    SV.shortcuts.register({ keys: 'Space', owner: 'playback', desc: 'play / stop' });
    SV.shortcuts.register({ keys: 'L', owner: 'playback', desc: 'loop the selected bars' });
    SV.shortcuts.register({ keys: 'Shift+L', owner: 'playback', desc: 'loop off' });
  }

  // ------------------------------------------------------------------ solo / mute on staff labels

  const trackFor = partName => {
    const d = S.liveData;
    const name = String(partName || '').replace(/ ✎$/, '');
    return d && d.tracks ? d.tracks.find(t => t.name === name && t.index != null) : null;
  };

  function buildSoloMute() {
    const paper = document.getElementById('paper'), r = S.render;
    if (!paper || !r) return;
    const pr = paper.getBoundingClientRect();
    document.querySelectorAll('#paper g.system').forEach(sys => {
      const first = sys.querySelector('g.measure');
      if (!first) return;
      const seen = new Set();
      first.querySelectorAll(':scope > g.staff').forEach(st => {
        const n = parseInt((st.id.match(/s(\d+)$/) || [])[1], 10);
        const staff = r.staves.find(s => s.n === n);
        if (!staff || seen.has(staff.part)) return;
        seen.add(staff.part);
        const track = trackFor(staff.part);
        if (!track) return;
        const lines = [...st.querySelectorAll(':scope > path')].map(p => p.getBoundingClientRect()).filter(b => b.width > 20);
        if (lines.length < 5) return;
        const left = Math.min(...lines.map(b => b.left)) - pr.left, top = lines[0].top - pr.top, h = lines[4].top - lines[0].top;
        const zone = document.createElement('div');
        zone.className = 'svpb-sm';
        zone.dataset.track = track.index;
        zone.style.cssText = `left:0;width:${Math.max(40, left - 4)}px;top:${top - 4}px;height:${h + 8}px`;
        zone.innerHTML = `<button data-op="solo" title="Solo ${esc(track.name)}">S</button><button data-op="mute" title="Mute ${esc(track.name)}">M</button>`;
        paper.appendChild(zone);
      });
    });
    refreshSoloMute();
  }

  // The zones ignore the mouse (so staff names stay clickable, e.g. for the instrument picker);
  // light them up from the pointer position instead of :hover.
  let hotZone = null;
  document.addEventListener('mousemove', e => {
    let hit = null;
    document.querySelectorAll('#paper .svpb-sm').forEach(z => {
      const b = z.getBoundingClientRect();
      if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) hit = z;
    });
    if (hit === hotZone) return;
    if (hotZone) hotZone.classList.remove('hot');
    hotZone = hit;
    if (hit) hit.classList.add('hot');
  });

  function refreshSoloMute() {
    const d = S.liveData;
    if (!d || !d.tracks) return;
    document.querySelectorAll('#paper .svpb-sm').forEach(z => {
      const t = d.tracks.find(x => x.index === Number(z.dataset.track));
      z.querySelector('[data-op=solo]').classList.toggle('on', !!(t && t.solo));
      z.querySelector('[data-op=mute]').classList.toggle('on', !!(t && t.mute));
      z.classList.toggle('active', !!(t && (t.solo || t.mute)));
    });
  }

  document.addEventListener('mousedown', e => {
    const b = e.target.closest && e.target.closest('.svpb-sm');
    if (!b) return;
    e.stopPropagation(); // keep the paper from treating this as a click on the score
    e.preventDefault();
    const btn = e.target.closest('button');
    if (!btn) return;
    const idx = Number(b.dataset.track), op = btn.dataset.op;
    const t = S.liveData && S.liveData.tracks.find(x => x.index === idx);
    const on = !(t && t[op]);
    SV.send([op + ' ' + idx + ' ' + (on ? 1 : 0)]);
    if (t) t[op] = on;
    refreshSoloMute();
  }, true);

  // Rehearsal marks: boxed, and nudged right of the bar number they would otherwise sit on.
  function styleRehearsalMarks() {
    document.querySelectorAll('#paper g.reh').forEach(reh => {
      const num = reh.closest('g.measure') && reh.closest('g.measure').querySelector(':scope > g.mNum');
      const ctm = reh.getScreenCTM();
      if (num && ctm) {
        const a = reh.getBoundingClientRect(), b = num.getBoundingClientRect();
        if (a.left < b.right + 3 && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          reh.setAttribute('transform', `translate(${(b.right + 6 - a.left) / ctm.a},0)`);
        }
      }
      const bb = reh.getBBox(), pad = bb.height * 0.18;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', bb.x - pad); rect.setAttribute('y', bb.y - pad * 0.6);
      rect.setAttribute('width', bb.width + 2 * pad); rect.setAttribute('height', bb.height + pad * 1.2);
      rect.setAttribute('fill', 'none'); rect.setAttribute('stroke', 'currentColor');
      rect.setAttribute('stroke-width', Math.max(1, bb.height * 0.06));
      reh.insertBefore(rect, reh.firstChild);
    });
  }

  SV.hooks.afterRender.push(() => { styleRehearsalMarks(); buildSoloMute(); });

  // ------------------------------------------------------------------ live data / transport feed

  let markerSig = null;
  SV.hooks.liveData.push(d => {
    const sig = JSON.stringify(d.markers || []);
    if (markerSig !== null && sig !== markerSig && showMarks) setTimeout(SV.render, 0);
    markerSig = sig;
    refreshSoloMute();
  });

  SV.hooks.play.push(p => {
    play = { ...play, ...p };
    const d = S.liveData;
    // While an arranger clip plays, its start in the arrangement is playhead - step.
    if (p.playing && p.step >= 0 && d && d.exists && S.source === 'arranger') {
      const off = Math.round((p.pos - p.step / d.stepsPerBeat) * 8) / 8;
      const prev = learnedOffsets.get(d.track);
      if (off >= 0 && (prev == null || Math.abs(prev - off) > 0.01)) {
        learnedOffsets.set(d.track, off);
        if (S.mode === 'clip' && showMarks && markers().length && !(S.align && S.align.track === d.track)) SV.render();
      }
    }
    updateStrip();
  });

  // ------------------------------------------------------------------ toolbar strip

  SV.addStyle(`
    #paper { position: relative; }
    #paper g.mNum { cursor: pointer; }
    #paper g.mNum:hover { fill: var(--accent); }
    .svpb-sm { position: absolute; display: flex; align-items: center; justify-content: flex-start; gap: 2px; padding-left: 3px;
               opacity: 0; transition: opacity .1s; z-index: 2; pointer-events: none; }
    .svpb-sm button { pointer-events: auto; }
    .svpb-sm.hot, .svpb-sm.active { opacity: 1; }
    .svpb-sm.active:not(.hot) button:not(.on) { visibility: hidden; }
    .svpb-sm button { font: 600 10px/1 system-ui, sans-serif; width: 17px; height: 16px; padding: 0; cursor: pointer;
                      border: 1px solid #999; border-radius: 3px; background: #fff; color: #444; }
    .svpb-sm button[data-op=solo].on { background: #f2c94c; border-color: #c9a227; color: #111; }
    .svpb-sm button[data-op=mute].on { background: #4a90e2; border-color: #2f6db5; color: #fff; }
    #svpbStrip { gap: 8px; }
    #svpbStrip .btn { padding: 2px 9px; }
    #svpbPlay.on { background: #2f9e44; border-color: #2f9e44; color: #fff; }
    #svpbLoop.on { background: var(--accent); border-color: var(--accent); color: #111; }
    #svpbPos { font: 12px ui-monospace, monospace; color: #fff; min-width: 11ch; }
    #svpbTempo { color: var(--dim); font-size: 12px; }
  `);

  const strip = document.createElement('div');
  strip.className = 'group';
  strip.id = 'svpbStrip';
  strip.innerHTML = '<button class="btn" id="svpbPlay" title="Play / stop (Space)">▶</button>' +
    '<span id="svpbPos">bar 1 beat 1</span><span id="svpbTempo"></span>' +
    '<button class="btn" id="svpbLoop" title="L: loop the selected bars (or the last clicked bar) · Shift+L: loop off">⟳ Loop</button>' +
    `<label title="Rehearsal marks from Bitwig's cue markers / the DAWproject"><input type="checkbox" id="svpbMarks" ${showMarks ? 'checked' : ''}> Marks</label>`;
  SV.addToolbar(strip, { cluster: 'play', order: 130 });
  const $ = id => document.getElementById(id);
  $('svpbPlay').addEventListener('click', e => { togglePlay(); e.currentTarget.blur(); });
  $('svpbLoop').addEventListener('click', e => { if (play.loop && play.loop.on) loopOff(); else loopSelection(); e.currentTarget.blur(); });
  $('svpbMarks').addEventListener('change', e => { showMarks = e.target.checked; store.set('marks', showMarks); SV.render(); });

  function updateStrip() {
    const ts = timeSig(), mb = ts.num * 4 / ts.den, unit = 4 / ts.den;
    const pos = Math.max(0, play.pos || 0);
    const bar = Math.floor(pos / mb + 1e-9);
    const beat = Math.floor((pos - bar * mb) / unit + 1e-9) + 1;
    $('svpbPlay').textContent = play.playing ? '■' : '▶';
    $('svpbPlay').classList.toggle('on', !!play.playing);
    $('svpbPos').textContent = 'bar ' + (bar + 1) + ' beat ' + beat;
    $('svpbTempo').textContent = play.tempo ? Math.round(play.tempo * 10) / 10 + ' bpm' : '';
    const l = play.loop;
    const on = !!(l && l.on);
    $('svpbLoop').classList.toggle('on', on);
    if (on) {
      const a = Math.floor(l.start / mb + 1e-6) + 1, b = Math.max(a, Math.ceil((l.start + l.length) / mb - 1e-6));
      $('svpbLoop').textContent = '⟳ ' + (a === b ? 'bar ' + a : 'bars ' + a + '–' + b);
    } else $('svpbLoop').textContent = '⟳ Loop';
  }
  updateStrip();

  SV.addHelp('Click a bar number (or <kbd>Alt</kbd>+click a bar) to play from there · <kbd>Space</kbd> play/stop · ' +
    '<kbd>L</kbd> loop selected bars · <kbd>Shift</kbd>+<kbd>L</kbd> loop off · hover a staff name for Solo/Mute');

  SV.playback = { playFromBar, togglePlay, loopSelection, loopOff, markers, clipOffset };
})();
