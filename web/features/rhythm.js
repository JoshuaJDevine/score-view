// Feature module: rhythm "readings" (aim assist). Play freely, then cycle interpretations of a bar instead of
// re-entering it: Q / Shift+Q on the selected note's bar (or the last clicked bar) steps through readings,
// stored per track in localStorage (scoreview.rhythm.<track>) and passed to buildMEI as part.measureOverrides.
// See docs/AGENTS.md for the SV hook API.
(function () {
  'use strict';
  const SV = window.SV;
  if (!SV) return;

  const READINGS = [
    { label: 'automatic reading', ov: null },
    { label: 'straight 16ths', ov: { grid: 2, tuplets: 'off' } },
    { label: 'triplet reading', ov: { tuplets: 'triplet' } },
    { label: 'straight 8ths', ov: { grid: 4, tuplets: 'off' } },
    { label: 'single voice', ov: { voices: 'single' } },
    { label: 'straight 32nds', ov: { grid: 1, tuplets: 'off' } },
    { label: 'simplified', ov: { simplify: true } },
  ];
  const trackKey = name => String(name || '').replace(/\s*✎$/, '');
  const storeKey = track => 'scoreview.rhythm.' + track;
  const cache = new Map();

  // { [bar]: readingIndex } for a track.
  function load(track) {
    if (cache.has(track)) return cache.get(track);
    let v = {};
    try { v = JSON.parse(localStorage.getItem(storeKey(track)) || '{}') || {}; } catch (e) { v = {}; }
    cache.set(track, v);
    return v;
  }
  function save(track, v) {
    cache.set(track, v);
    try {
      if (Object.keys(v).length) localStorage.setItem(storeKey(track), JSON.stringify(v));
      else localStorage.removeItem(storeKey(track));
    } catch (e) { /* ignore */ }
  }

  function overridesFor(track) {
    const saved = load(track), out = {};
    Object.keys(saved).forEach(bar => { const r = READINGS[saved[bar]]; if (r && r.ov) out[bar] = r.ov; });
    return out;
  }

  SV.hooks.transformScore.push(score => {
    if (!score || !score.parts) return score;
    let changed = false;
    const parts = score.parts.map(p => {
      const ov = overridesFor(trackKey(p.name));
      if (!Object.keys(ov).length) return p;
      changed = true;
      return { ...p, measureOverrides: { ...(p.measureOverrides || {}), ...ov } };
    });
    return changed ? { ...score, parts } : score;
  });

  // Bar/track under the user's attention: the selected note, else the last clicked bar or note.
  let lastTarget = null;
  const staffPart = staffEl => {
    const r = SV.state.render;
    const n = staffEl && parseInt((staffEl.id.match(/s(\d+)$/) || [])[1], 10);
    const st = r && r.staves.find(s => s.n === n);
    return st ? st.part : null;
  };
  const targetOfSvg = svgId => {
    const el = document.getElementById(svgId);
    const m = el && el.closest('g.measure');
    if (!m) return null;
    const bar = parseInt(m.id.replace(/^m/, ''), 10);
    return isNaN(bar) ? null : { bar, part: staffPart(el.closest('g.staff')) };
  };

  SV.hooks.paperClick.push((e, hit) => {
    lastTarget = hit && hit.measure ? { bar: hit.measure, part: hit.part } : null;
    return false;
  });
  SV.hooks.noteClick.push(t => {
    lastTarget = targetOfSvg(t.svgId);
    return false;
  });

  function currentTarget() {
    const r = SV.state.render;
    if (r && SV.state.selection.size) {
      for (const id of SV.state.selection) {
        const t = (r.bySrc.get(id) || [])[0];
        const tg = t && targetOfSvg(t.svgId);
        if (tg) return { bar: tg.bar, part: SV.currentTrack() || tg.part };
      }
    }
    return lastTarget;
  }

  function cycle(dir) {
    const tg = currentTarget();
    if (!tg || !tg.part) { SV.flash('Select a note or click a bar, then press Q for another rhythm reading'); return; }
    const track = trackKey(tg.part);
    const saved = { ...load(track) };
    const idx = ((saved[tg.bar] || 0) + dir + READINGS.length) % READINGS.length;
    if (idx) saved[tg.bar] = idx; else delete saved[tg.bar];
    save(track, saved);
    SV.render();
    SV.flash(`Bar ${tg.bar}: ${READINGS[idx].label}` + (idx ? '' : ' (reset)'));
  }

  SV.hooks.keydown.push(e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'q') return false;
    cycle(e.shiftKey ? -1 : 1);
    return true;
  });

  if (SV.shortcuts) SV.shortcuts.register({ keys: ['Q', 'Shift+Q'], owner: 'rhythm', desc: 'next / previous rhythm reading of the bar' });

  // Tint the staff lines of bars whose reading is not automatic.
  SV.addStyle('#paper g.staff.sv-reading > path { stroke: #c77d1a; }');
  SV.hooks.afterRender.push(render => {
    (render.staves || []).forEach(st => Object.keys(overridesFor(trackKey(st.part))).forEach(b => {
      const el = document.getElementById('m' + b + 's' + st.n);
      if (el) el.classList.add('sv-reading');
    }));
  });

  SV.addHelp('<b>Q</b> / <b>Shift+Q</b> rhythm readings for the selected (or clicked) bar: straight, triplets, single voice…');
  SV.rhythm = { READINGS, overridesFor, cycle };
})();
