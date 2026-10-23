// Score View page core: inlines Verovio's glyph references (window.SvgInline; used by core/render.js and features/print.js).
//
// Verovio draws every SMuFL glyph (noteheads, rests, flags, clefs, accidentals, …) as
//   <use xlink:href="#E0A4-xyz" x="1330" y="489" height="720px" width="720px" />
// pointing at one <symbol id="E0A4-xyz" viewBox="0 0 1000 1000"><path transform="scale(1,-1)" d="…" /></symbol> in the
// page's <defs>. A full score has ~15,000 of them, and Chrome's style recalc of that many <use> shadow trees took ~6 s
// of a ~9 s render. inlineGlyphs() rewrites each such <use> into a plain <path> with the same geometry:
//   <path transform="[use transform] translate(x,y) scale(w/vbW,h/vbH) [path transform]" d="…" />
// (with the viewBox origin and preserveAspectRatio's centring folded in when they apply). Any other attribute of the
// <use> (class, id, fill, …) moves onto the <path>; everything else in the string stays byte-identical. Symbols that no
// longer have a reference are dropped, and an emptied <defs> with them.
// A <use> is left alone when it cannot be resolved exactly: unknown symbol, a symbol that is not a single <path>,
// width/height missing or not in user units / px, or a preserveAspectRatio other than the default or 'none'.
// Pure string work (no DOM), so it also loads in Node (module.exports) for test/svg-inline-test.mjs.
(function (root) {
  'use strict';

  const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  function attrs(s) {
    const out = [];
    let m;
    ATTR.lastIndex = 0;
    while ((m = ATTR.exec(s))) out.push([m[1], m[2]]);
    return out;
  }
  const get = (list, k) => { const a = list.find(p => p[0] === k); return a ? a[1] : null; };
  // 1, 1.5, -0.72 … ; a length in user units or px only (no %, em, mm: those need the viewport to resolve)
  const num = s => (s != null && /^\s*-?(\d+\.?\d*|\.\d+)(e-?\d+)?(px)?\s*$/i.test(s) ? parseFloat(s) : NaN);
  const fmt = n => String(Math.round(n * 1e6) / 1e6);

  /** Parses the <symbol>s of an SVG string: Map id -> { vb:[x,y,w,h], par, pathAttrs, pathTransform } (inlinable only). */
  function readSymbols(svg) {
    const map = new Map();
    const re = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g;
    let m;
    while ((m = re.exec(svg))) {
      const a = attrs(m[1]);
      const id = get(a, 'id');
      const body = m[2].trim();
      const p = body.match(/^<path\b([^>]*?)\s*\/>$/) || body.match(/^<path\b([^>]*)>\s*<\/path>$/);
      if (!id || !p) continue;
      const vb = (get(a, 'viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if (vb.length !== 4 || vb.some(v => !isFinite(v)) || vb[2] <= 0 || vb[3] <= 0) continue;
      const par = (get(a, 'preserveAspectRatio') || 'xMidYMid meet').trim();
      if (par !== 'none' && par !== 'xMidYMid' && par !== 'xMidYMid meet') continue;
      const pa = attrs(p[1]);
      if (pa.some(([k]) => k === 'id')) continue; // two copies of one id would be wrong
      map.set(id, {
        vb, stretch: par === 'none',
        pathTransform: get(pa, 'transform') || '',
        pathAttrs: pa.filter(([k]) => k !== 'transform').map(([k, v]) => ' ' + k + '="' + v + '"').join(''),
      });
    }
    return map;
  }

  /** One <use> (its attribute text) -> the inline <path>, or null to keep the <use>. */
  function inlineUse(attrText, symbols) {
    const a = attrs(attrText);
    const href = get(a, 'xlink:href') || get(a, 'href');
    if (!href || href[0] !== '#') return null;
    const s = symbols.get(href.slice(1));
    if (!s) return null;
    const x = get(a, 'x') == null ? 0 : num(get(a, 'x')), y = get(a, 'y') == null ? 0 : num(get(a, 'y'));
    const w = num(get(a, 'width')), h = num(get(a, 'height'));
    if (![x, y, w, h].every(isFinite) || w <= 0 || h <= 0) return null;
    const [vx, vy, vw, vh] = s.vb;
    let sx = w / vw, sy = h / vh, tx = x, ty = y;
    if (!s.stretch && sx !== sy) { // xMidYMid meet: uniform scale, centred in the viewport
      const k = Math.min(sx, sy);
      tx += (w - vw * k) / 2; ty += (h - vh * k) / 2;
      sx = sy = k;
    }
    tx -= vx * sx; ty -= vy * sy;
    const tf = [get(a, 'transform'), 'translate(' + fmt(tx) + ',' + fmt(ty) + ')',
      'scale(' + fmt(sx) + ',' + fmt(sy) + ')', s.pathTransform].filter(Boolean).join(' ');
    const keep = a.filter(([k]) => !['xlink:href', 'href', 'x', 'y', 'width', 'height', 'transform'].includes(k))
      .map(([k, v]) => ' ' + k + '="' + v + '"').join('');
    return '<path' + keep + ' transform="' + tf + '"' + s.pathAttrs + ' />';
  }

  /**
   * Rewrites the glyph <use>s of one Verovio SVG string (a page from renderToSVG) into inline <path>s; returns the new
   * string. Strings without <use> come back unchanged.
   */
  function inlineGlyphs(svg) {
    if (typeof svg !== 'string' || svg.indexOf('<use') < 0) return svg;
    const symbols = readSymbols(svg);
    if (!symbols.size) return svg;
    let out = svg.replace(/<use\b([^>]*?)\s*(?:\/>|>\s*<\/use>)/g, (m, at) => inlineUse(at, symbols) || m);
    // Drop the symbols nothing points at any more (any '#id' left in the string counts as a reference).
    out = out.replace(/[ \t]*<symbol\b([^>]*)>[\s\S]*?<\/symbol>[ \t]*\r?\n?/g, (m, at) => {
      const id = get(attrs(at), 'id');
      return id && symbols.has(id) && out.indexOf('#' + id) < 0 ? '' : m;
    });
    return out.replace(/[ \t]*<defs>\s*<\/defs>[ \t]*\r?\n?/, '');
  }

  /** On unless localStorage 'scoreview.inlineGlyphs' is false (a switch for comparisons: tools/perf-bench.mjs --no-inline). */
  function enabled() {
    try { return root.localStorage.getItem('scoreview.inlineGlyphs') !== 'false'; } catch (e) { return true; }
  }

  const api = { inlineGlyphs, enabled };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SvgInline = api;
})(typeof window !== 'undefined' ? window : globalThis);
