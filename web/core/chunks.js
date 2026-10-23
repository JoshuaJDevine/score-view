// Score View page core: chunked engraving plans (window.ScoreChunks; used by core/render.js, loads in Node too).
//
// A big score is engraved as a stack of chunks, each a run of whole bars that makes one system, each its own Verovio
// document and SVG (ScoreBuilder's built.chunks.mei(a, b, opts) assembles one; core/engrave.js engraves and caches them).
// An edit then re-engraves only the chunks whose MEI changed. The system breaks are decided here, before engraving,
// from each bar's width features (built.chunks.bars: onsets across the staves, the spacing they need, accidentals):
// barWidth() is a linear model fitted to Verovio's natural bar widths (line mode) on the Mega Man 2 crawl, the
// DAWproject fixture and a 4-part slice (mean error 2.7 %); a system start (clef, key) adds startWidth. A chunk is
// engraved with a system break before its first bar and Verovio's breaks 'encoded', so it is always exactly one system,
// justified to the full width (minLastJustification 0) like a system of a full render; filling it to FILL keeps the
// spacing close to Verovio's own (a misjudged chunk is spaced a little wider or tighter, never wrapped).
// Breaks are sticky: a bar range of the previous plan is kept while it still fits, so an edit changes one chunk, not
// every chunk after it.
// Pure code (no DOM), so test/chunks-test.mjs can run it in Node.
(function (root) {
  'use strict';

  // Verovio units: 1 staff space = 180; a page is (pageWidth - margins) * 10 wide.
  const BAR = { base: 1694, gaps: 87.7, onsets: 212.9, acc: 19.1 };
  const FILL = 1.06;      // a new system is filled to this much of its width (Verovio packs its own to 1.0-1.08)
  const KEEP = 1.1;       // a previous bar range is kept up to this much (beyond FILL: spaced a little tighter)
  const MIN_KEEP = 0.6;   // ... and only while at least this full (else it takes more bars)

  /** Natural width of one bar (Verovio units) from its features { onsets, gaps, acc }. */
  const barWidth = f => (f ? BAR.base + BAR.gaps * f.gaps + BAR.onsets * f.onsets + BAR.acc * f.acc : BAR.base);
  /** Width left of a system's staves for the staff names (Verovio units), from the longest name's length. */
  const indent = chars => 900 + 150 * chars;
  // The clef and key signature every system starts with (measured: the first bar of a chunk is ~1450 wider).
  const startWidth = keyAcc => 1450 + 250 * keyAcc;

  /** 53-bit string hash (cyrb53) as a base-36 string: the cache key of a chunk's MEI. */
  function hash(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + str.length.toString(36);
  }

  /**
   * System breaks for built.chunks: [{a, b}] (0-based bars, inclusive), each meant to engrave as one system.
   * o: { pageWidth, marginLeft, marginRight } (Verovio options), prev: the previous plan's { ctx, ranges } or null,
   * ctx: a string naming the layout (width, zoom, staves): prev only counts with the same ctx.
   */
  function plan(chunks, o, prev, ctx) {
    const n = chunks.bars.length;
    const usable = (o.pageWidth - (o.marginLeft || 0) - (o.marginRight || 0)) * 10;
    const longest = k => Math.max(0, ...chunks.labels.map(l => String(l[k] || '').length));
    const avail = first => usable - indent(longest(first ? 0 : 1));
    const keep = new Map(), starts = new Set();
    if (prev && prev.ctx === ctx) prev.ranges.forEach(r => { keep.set(r.a, r.b); starts.add(r.a); });
    const out = [];
    let a = 0;
    while (a < n) {
      const room = avail(!out.length);
      const widthOf = b => { let w = startWidth(chunks.keyAcc(a)); for (let m = a; m <= b; m++) w += barWidth(chunks.bars[m]); return w; };
      const b0 = keep.get(a);
      if (b0 != null && b0 < n && widthOf(b0) <= KEEP * room && (widthOf(b0) >= MIN_KEEP * room || b0 === n - 1)) {
        out.push({ a, b: b0 }); a = b0 + 1; continue;
      }
      // Greedy; once at least half full, stop where a previous range started (the plan meets the old breaks again).
      let w = startWidth(chunks.keyAcc(a)), b = a;
      for (let m = a; m < n; m++) {
        const bw = barWidth(chunks.bars[m]);
        if (m > a && (w + bw > FILL * room || (starts.has(m) && w >= MIN_KEEP * room))) break;
        w += bw; b = m;
      }
      out.push({ a, b }); a = b + 1;
    }
    return out;
  }

  /**
   * The staves a chunk leaves out (Hide empty staves, as Verovio's condense would for a system): every staff of a part
   * with no notes in bars a..b. all: show every staff (the first system unless condenseFirstPage). A chunk that would
   * show none keeps the first part. Returns a Set of staff numbers, or null.
   */
  function hidden(chunks, a, b, all) {
    if (all) return null;
    const hide = new Set();
    let shown = 0;
    chunks.parts.forEach(idxs => {
      if (idxs.some(n => chunks.filled(n, a, b))) { shown++; return; }
      idxs.forEach(n => hide.add(n));
    });
    if (!shown && chunks.parts.length) chunks.parts[0].forEach(n => hide.delete(n));
    return hide.size ? hide : null;
  }

  const api = { plan, hidden, hash, barWidth, indent, FILL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScoreChunks = api;
})(typeof window !== 'undefined' ? window : globalThis);
