// Feature module: notation (issue #12). Score-level notation that score.js engraves:
//   * clef changes and ottava lines (toggles -> buildMEI opts.clefChanges / opts.ottava),
//   * meter changes and tempo marks from the DAWproject (base.timeSigChanges, base.tempo, base.tempoChanges),
//     the live clip's tempo from Bitwig's transport in Clip mode,
//   * optional key-signature changes at confident modulations from the harmony module (SV.harmony).
// Runs first among the transformScore hooks: in the Clip range it re-bases the score on the real bar the
// clip starts in (the page core counts bars with the first meter only), so later hooks see final beats.
// Pure helpers (Node): require('web/features/notation.js') -> { applyBase, tempoAt, harmonyKeyChanges }.
(function (root) {
  'use strict';

  // Bar starts (beats) with the meter of each bar, from timeSig + changes [{beat, num, den}], up to `upto`.
  function bars(timeSig, changes, upto) {
    const ch = (changes || []).slice().sort((a, b) => a.beat - b.beat);
    const out = [];
    let t = 0, ts = timeSig, i = 0;
    while (t <= upto + 1e-9 && out.length < 100000) {
      while (i < ch.length && ch[i].beat <= t + 1e-9) ts = ch[i++];
      const len = ts.num * 4 / ts.den, next = i < ch.length ? Math.min(t + len, ch[i].beat) : t + len;
      out.push({ beat: t, num: ts.num, den: ts.den });
      t = next;
    }
    return out;
  }

  /** Tempo (bpm) at beat from tempo + changes [{beat, bpm, endBeat?}]; also { ramp } when inside a ramp. */
  function tempoAt(tempo, changes, beat) {
    let cur = tempo, ramp = null;
    (changes || []).slice().sort((a, b) => a.beat - b.beat).forEach(c => {
      if (c.beat > beat) return;
      if (c.endBeat != null && beat < c.endBeat) { ramp = c; cur = cur + (c.bpm - cur) * (beat - c.beat) / (c.endBeat - c.beat); }
      else cur = c.bpm;
    });
    return { bpm: cur, ramp };
  }

  /**
   * Copies the base's meter/tempo onto a score the page core built; when the score starts later (measureOffset > 0,
   * computed with the first meter's bar length), moves it onto the real bar line. Mutates and returns score.
   */
  function applyBase(score, base, opts) {
    opts = opts || {};
    const changes = base.timeSigChanges || [];
    const ts0 = base.timeSig || score.timeSig;
    const mb0 = ts0.num * 4 / ts0.den;
    const A = (score.measureOffset || 0) * mb0; // where the page core thinks the score starts
    let B = 0, k = 0, ts = ts0;
    if (A > 0) {
      const bs = bars(ts0, changes, A);
      for (let i = 0; i < bs.length && bs[i].beat <= A + 1e-9; i++) { B = bs[i].beat; k = i; ts = bs[i]; }
    }
    const shift = A - B;
    if (shift > 1e-9) {
      const mv = n => ({ ...n, start: n.start + shift });
      score.parts = score.parts.map(p => ({ ...p, notes: p.notes.map(mv), keyswitches: p.keyswitches && p.keyswitches.map(mv) }));
      score.lengthBeats = (score.lengthBeats || 0) + shift;
    }
    if (A > 0 || changes.length) {
      score.measureOffset = k;
      score.offsetBeats = B;
      score.timeSig = { num: ts.num, den: ts.den };
      score.timeSigChanges = changes.filter(c => c.beat > B + 1e-9).map(c => ({ ...c, beat: c.beat - B }));
    }
    if (opts.tempo !== false && base.tempo > 0) {
      const at = tempoAt(base.tempo, base.tempoChanges, B);
      score.tempo = Math.round(at.bpm * 100) / 100;
      score.tempoChanges = (base.tempoChanges || [])
        .filter(c => (c.endBeat != null ? c.endBeat : c.beat) > B + 1e-9)
        .map(c => c.beat < B ? { beat: 0, endBeat: c.endBeat - B, bpm: c.bpm } : { ...c, beat: c.beat - B, ...(c.endBeat != null ? { endBeat: c.endBeat - B } : {}) });
    }
    return score;
  }

  /**
   * Key changes at confident modulations from harmony regions [{start, end, keyFifths}] (absolute beats):
   * a key must hold for at least `minBars` bars to get a signature; shorter excursions keep the current one.
   */
  function harmonyKeyChanges(regions, { originBeats = 0, barBeats = 4, minBars = 4 } = {}) {
    const segs = [];
    regions.filter(r => r && r.keyFifths != null).forEach(r => {
      const last = segs[segs.length - 1];
      if (last && last.fifths === r.keyFifths) last.end = r.end;
      else segs.push({ start: r.start, end: r.end, fifths: r.keyFifths });
    });
    const solid = segs.filter(s => s.end - s.start >= minBars * barBeats - 1e-6);
    const out = [];
    solid.forEach(s => {
      if (out.length && out[out.length - 1].fifths === s.fifths) return;
      out.push({ beat: Math.max(0, s.start - originBeats), fifths: s.fifths });
    });
    return out;
  }

  const api = { applyBase, tempoAt, harmonyKeyChanges, bars };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  const SV = root.SV;
  if (!SV || !SV.hooks) return;

  // ------------------------------------------------------------------ settings
  const KEY = 'scoreview.notation.';
  const load = (k, d) => { try { const v = root.localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const settings = { clefs: load('clefs', true), ottava: load('ottava', true), tempo: load('tempo', true), harmonyKeys: load('harmonyKeys', false) };
  const save = () => { try { Object.keys(settings).forEach(k => root.localStorage.setItem(KEY + k, JSON.stringify(settings[k]))); } catch (e) { /* ignore */ } };
  let transportTempo = null;
  SV.hooks.play.push(p => { if (p && p.tempo > 0) transportTempo = p.tempo; });

  // First transformScore hook: meter, tempo and key changes before other modules place things by beat.
  SV.hooks.transformScore.unshift((score, ctx) => {
    const st = SV.state;
    if (st.mode === 'score' && st.base) applyBase(score, st.base, { tempo: settings.tempo });
    else if (settings.tempo && transportTempo) score.tempo = Math.round(transportTempo * 100) / 100;
    if (!settings.tempo) { delete score.tempo; delete score.tempoChanges; }
    if (settings.harmonyKeys && SV.harmony && SV.harmony.analyze) {
      try {
        const ts = score.timeSig, mb = ts.num * 4 / ts.den;
        const keys = harmonyKeyChanges(SV.harmony.analyze(score), { originBeats: (score.measureOffset || 0) * mb, barBeats: mb });
        if (keys.length && score.keyFifths == null) keys[0].beat = 0; // the opening key is the first one found
        score.keyChanges = keys.filter(k => score.keyFifths == null || k.beat > 0);
      } catch (err) { console.error('notation: harmony keys', err); }
    }
    return score;
  });
  SV.hooks.buildOptions.push(buildOpts => {
    buildOpts.clefChanges = settings.clefs;
    buildOpts.ottava = settings.ottava;
  });

  SV.notation = { settings: () => ({ ...settings }), set(patch) { Object.assign(settings, patch); save(); sync(); SV.render(); } };

  // ------------------------------------------------------------------ UI
  let panel = null;
  function sync() {
    if (!panel) return;
    panel.querySelectorAll('input[data-k]').forEach(i => { i.checked = !!settings[i.dataset.k]; });
  }
  if (typeof document === 'undefined' || !SV.addToolbar) return;
  SV.addStyle(`
    .svn-wrap { position: relative; display: inline-block; }
    .svn-pop { position: absolute; z-index: 40; top: 100%; left: 0; margin-top: 4px; background: var(--bar, #232323); color: var(--text, #ddd);
               border: 1px solid var(--line, #3a3a3a); border-radius: 6px; box-shadow: 0 6px 20px #000a; padding: 8px 10px; width: 270px; font-size: 12px; }
    .svn-pop label { display: block; padding: 3px 0; cursor: pointer; }
    .svn-pop small { color: var(--dim, #888); display: block; margin-left: 20px; }
  `);
  const wrap = document.createElement('span');
  wrap.className = 'svn-wrap';
  wrap.innerHTML = '<button class="btn" id="svnBtn" title="Clef changes, ottava lines, tempo marks, key changes">Notation ▾</button>' +
    '<div class="svn-pop hidden" id="svnPop">' +
    '<label><input type="checkbox" data-k="clefs"> Clef changes<small>tenor / treble / bass clef for sustained passages</small></label>' +
    '<label><input type="checkbox" data-k="ottava"> Ottava lines<small>8va / 15ma / 8vb for extreme registers</small></label>' +
    '<label><input type="checkbox" data-k="tempo"> Tempo marks<small>from the DAWproject tempo track, or Bitwig\'s tempo</small></label>' +
    '<label><input type="checkbox" data-k="harmonyKeys"> Key changes from harmony analysis<small>key signatures at confident modulations</small></label>' +
    '</div>';
  SV.addToolbar(wrap, { cluster: 'score', order: 190 });
  panel = wrap.querySelector('#svnPop');
  sync();
  wrap.querySelector('#svnBtn').addEventListener('click', e => { e.stopPropagation(); panel.classList.toggle('hidden'); });
  panel.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => panel.classList.add('hidden'));
  panel.addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (k) SV.notation.set({ [k]: e.target.checked });
  });
})(typeof window !== 'undefined' ? window : this);
