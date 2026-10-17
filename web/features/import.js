// Import a MusicXML (.musicxml/.xml/.mxl) or MIDI (.mid) file into the live Bitwig clip.
//
// Both formats are parsed here (no Verovio round trip) into one model, in beats (quarter notes), independent of tempo:
//   { source: 'musicxml'|'midi', title, composer, timeSig:{num,den}, lengthBeats, measureStarts:[beats],
//     parts:[{ id, name, transpose (sounding - written semitones), notes:[{start, dur, pitch (sounding), written, vel}] }] }
// MusicXML: divisions per quarter, <backup>/<forward>, chords, ties merged, grace notes skipped, <transpose> applied
// (written -> concert pitch), dynamics -> velocity. Repeats are not unrolled. MIDI: SMF 0/1, PPQ timing, running
// status; one part per track (a track that uses several channels is split per channel).
// planImport() turns a part into /api/edit ops ('del ch x y', 'add ch x y vel durBeats'); the dialog sends them in
// chunks, waiting for Bitwig to report each chunk before the next one.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ MIDI file parser

  const GM_NAMES = ['Piano', 'Chromatic Perc.', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Pipe',
                    'Synth Lead', 'Synth Pad', 'Synth FX', 'Ethnic', 'Percussive', 'Sound FX'];

  function parseMidi(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let p = 0;
    const u8 = () => { if (p >= b.length) throw new Error('MIDI file ends early'); return b[p++]; };
    const u16 = () => (u8() << 8) | u8();
    const u32 = () => ((u8() << 24) >>> 0) + (u8() << 16) + (u8() << 8) + u8();
    const str = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
    const vlq = () => { let v = 0, c; do { c = u8(); v = v * 128 + (c & 0x7f); } while (c & 0x80); return v; };

    if (str(4) !== 'MThd') throw new Error('Not a MIDI file (no MThd header)');
    const hlen = u32();
    const format = u16(), ntrks = u16(), division = u16();
    p += hlen - 6;
    if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported (need PPQ timing)');
    const ppq = division;

    const tracks = [], timeSigs = [], tempos = [];
    let endTick = 0;
    for (let t = 0; t < ntrks && p + 8 <= b.length; t++) {
      const id = str(4), len = u32(), end = p + len;
      if (id !== 'MTrk') { p = end; t--; continue; }
      const tr = { index: tracks.length, name: '', instrument: '', programs: {}, notes: [] };
      const open = new Map(); // ch*128+key -> [{tick, vel}] (FIFO for overlapping same-key notes)
      let tick = 0, status = 0;
      while (p < end) {
        tick += vlq();
        let s = b[p];
        if (s & 0x80) { p++; if (s < 0xf0) status = s; } else if (status) s = status; else throw new Error('MIDI running status without a status byte');
        if (s === 0xff) {
          const type = u8(), l = vlq(), at = p;
          if (type === 0x03 && !tr.name) tr.name = decodeText(b.subarray(at, at + l));
          else if (type === 0x04 && !tr.instrument) tr.instrument = decodeText(b.subarray(at, at + l));
          else if (type === 0x51 && l === 3) tempos.push({ tick, usPerQ: (b[at] << 16) | (b[at + 1] << 8) | b[at + 2] });
          else if (type === 0x58 && l >= 2) timeSigs.push({ tick, num: b[at], den: Math.pow(2, b[at + 1]) });
          p = at + l;
          if (type === 0x2f) break;
          continue;
        }
        if (s === 0xf0 || s === 0xf7) { const l = vlq(); p += l; continue; }
        const kind = s & 0xf0, ch = s & 0x0f;
        const d1 = u8(), d2 = kind === 0xc0 || kind === 0xd0 ? 0 : u8();
        if (kind === 0x90 && d2 > 0) {
          const k = ch * 128 + d1;
          if (!open.has(k)) open.set(k, []);
          open.get(k).push({ tick, vel: d2 });
        } else if (kind === 0x80 || kind === 0x90) {
          const q = open.get(ch * 128 + d1);
          const on = q && q.shift();
          if (on) tr.notes.push({ ch, pitch: d1, vel: on.vel, t0: on.tick, t1: tick });
        } else if (kind === 0xc0 && tr.programs[ch] == null) tr.programs[ch] = d1;
      }
      p = end;
      open.forEach((q, k) => q.forEach(on => tr.notes.push({ ch: Math.floor(k / 128), pitch: k % 128, vel: on.vel, t0: on.tick, t1: tick })));
      endTick = Math.max(endTick, tick);
      tracks.push(tr);
    }

    // One part per track and channel.
    const parts = [];
    tracks.forEach(tr => {
      const chans = [...new Set(tr.notes.map(n => n.ch))].sort((x, y) => x - y);
      chans.forEach(ch => {
        const notes = tr.notes.filter(n => n.ch === ch)
          .map(n => ({ start: n.t0 / ppq, dur: Math.max(n.t1 - n.t0, 1) / ppq, pitch: n.pitch, written: n.pitch, vel: n.vel, ch }))
          .sort((x, y) => x.start - y.start || x.pitch - y.pitch);
        let name = tr.name || tr.instrument;
        if (!name) name = ch === 9 ? 'Drums' : tr.programs[ch] != null ? GM_NAMES[tr.programs[ch] >> 3] : 'Track ' + (tr.index + 1);
        if (chans.length > 1) name += ' (ch ' + (ch + 1) + ')';
        parts.push({ id: 'T' + tr.index + 'c' + ch, name, track: tr.index, channel: ch, transpose: 0, notes });
      });
    });
    timeSigs.sort((x, y) => x.tick - y.tick);
    const sigs = timeSigs.map(s => ({ beat: s.tick / ppq, num: s.num, den: s.den }));
    const lengthBeats = endTick / ppq;
    const ts = sigs[0] && sigs[0].beat === 0 ? { num: sigs[0].num, den: sigs[0].den } : { num: 4, den: 4 };
    return { source: 'midi', format, ppq, title: '', composer: '', timeSig: ts, lengthBeats,
             tempo: tempos.length ? Math.round(60e6 / tempos[0].usPerQ * 100) / 100 : 120,
             measureStarts: measureStartsFromSigs(sigs, ts, lengthBeats), parts };
  }

  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); } catch (e) { return String.fromCharCode(...bytes).trim(); }
  }

  // Bar start beats from time signature changes [{beat, num, den}] (a change mid-bar starts a new bar there).
  function measureStartsFromSigs(sigs, first, lengthBeats) {
    const out = [];
    let beat = 0, cur = first, i = 0;
    const end = Math.max(lengthBeats, 1e-9);
    while (beat < end - 1e-9 && out.length < 100000) {
      while (i < sigs.length && sigs[i].beat <= beat + 1e-9) cur = sigs[i++];
      out.push(beat);
      let next = beat + cur.num * 4 / cur.den;
      if (i < sigs.length && sigs[i].beat < next - 1e-9) next = sigs[i].beat;
      beat = next;
    }
    return out.length ? out : [0];
  }

  // ------------------------------------------------------------------ MusicXML parser

  const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const DYN_VEL = { pppp: 20, ppp: 30, pp: 42, p: 56, mp: 70, mf: 84, f: 98, ff: 110, fff: 120, ffff: 127,
                    sf: 108, sfz: 110, sffz: 116, fz: 108, rfz: 104, sfp: 100, fp: 98 };

  const kids = (el, name) => el ? [...el.children].filter(c => c.localName === name) : [];
  const kid = (el, name) => kids(el, name)[0] || null;
  const text = (el, name) => { const k = name ? kid(el, name) : el; return k ? k.textContent.trim() : ''; };
  const num = (el, name, d) => { const v = parseFloat(text(el, name)); return Number.isFinite(v) ? v : d; };

  function parseMusicXML(xml, opts) {
    opts = opts || {};
    const DP = opts.DOMParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) throw new Error('No DOMParser available');
    const doc = new DP().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The MusicXML file is not well-formed XML');
    const scoreEl = doc.documentElement;
    if (scoreEl.localName === 'score-timewise') throw new Error('Timewise MusicXML is not supported; export partwise MusicXML');
    if (scoreEl.localName !== 'score-partwise') throw new Error('Not a MusicXML score (root is <' + scoreEl.localName + '>)');

    const work = kid(scoreEl, 'work');
    const title = text(work, 'work-title') || text(scoreEl, 'movement-title') || '';
    const ident = kid(scoreEl, 'identification');
    const composerEl = kids(ident, 'creator').find(c => (c.getAttribute('type') || '') === 'composer') || kids(ident, 'creator')[0];
    const composer = composerEl ? composerEl.textContent.trim() : '';

    const names = new Map();
    const partList = kid(scoreEl, 'part-list');
    kids(partList, 'score-part').forEach(sp => {
      names.set(sp.getAttribute('id'), text(sp, 'part-name') || text(sp, 'part-abbreviation') || sp.getAttribute('id'));
    });

    let timeSig = null, measureStarts = null, lengthBeats = 0;
    const parts = kids(scoreEl, 'part').map((partEl, pi) => {
      const id = partEl.getAttribute('id') || 'P' + (pi + 1);
      const notes = [];
      const starts = [];
      const tiesOpen = new Map(); // "voice|pitch" -> note waiting for its tie stop
      let divisions = 1, transpose = 0, everTransposed = false, vel = 80, mStart = 0;
      kids(partEl, 'measure').forEach(m => {
        starts.push(mStart);
        let pos = 0, maxPos = 0, lastStart = 0;
        for (const el of m.children) {
          switch (el.localName) {
            case 'attributes': {
              divisions = num(el, 'divisions', divisions) || 1;
              const tr = kid(el, 'transpose');
              if (tr) { transpose = num(tr, 'chromatic', 0) + 12 * num(tr, 'octave-change', 0); everTransposed = everTransposed || transpose !== 0; }
              const time = kid(el, 'time');
              if (time && !timeSig && kid(time, 'beats')) {
                const beats = text(time, 'beats').split('+').reduce((a, v) => a + (parseInt(v, 10) || 0), 0);
                timeSig = { num: beats || 4, den: parseInt(text(time, 'beat-type'), 10) || 4 };
              }
              break;
            }
            case 'backup': pos -= num(el, 'duration', 0) / divisions; break;
            case 'forward': pos += num(el, 'duration', 0) / divisions; maxPos = Math.max(maxPos, pos); break;
            case 'direction': case 'sound': {
              const snd = el.localName === 'sound' ? el : kid(el, 'sound');
              if (snd && snd.getAttribute('dynamics') != null) vel = clampVel(parseFloat(snd.getAttribute('dynamics')) * 0.9);
              else if (el.localName === 'direction') {
                const dyn = el.getElementsByTagName('dynamics')[0];
                const mark = dyn && dyn.children[0] && DYN_VEL[dyn.children[0].localName];
                if (mark) vel = mark;
              }
              break;
            }
            case 'note': {
              if (kid(el, 'grace')) break;
              const dur = num(el, 'duration', 0) / divisions;
              const isChord = !!kid(el, 'chord');
              const start = isChord ? lastStart : pos;
              if (!isChord) { lastStart = pos; pos += dur; maxPos = Math.max(maxPos, pos); }
              const pitchEl = kid(el, 'pitch');
              if (!pitchEl || kid(el, 'rest') || kid(el, 'cue')) break;
              const written = (num(pitchEl, 'octave', 4) + 1) * 12 + (STEP_PC[text(pitchEl, 'step').toUpperCase()] || 0) +
                              Math.round(num(pitchEl, 'alter', 0));
              const pitch = written + transpose;
              const ties = kids(el, 'tie').map(t => t.getAttribute('type'));
              const voice = text(el, 'voice') || '1';
              const key = voice + '|' + pitch;
              const at = mStart + start;
              const nv = el.getAttribute('dynamics') != null ? clampVel(parseFloat(el.getAttribute('dynamics')) * 0.9) : vel;
              let n = null;
              if (ties.includes('stop')) {
                const prev = tiesOpen.get(key) || tiesOpen.get('*|' + pitch);
                if (prev && Math.abs(prev.start + prev.dur - at) < 1e-6) { prev.dur += dur; n = prev; }
                tiesOpen.delete(key);
              }
              if (!n) { n = { start: at, dur, pitch, written, vel: nv }; if (dur > 0) notes.push(n); }
              if (ties.includes('start')) tiesOpen.set(key, n);
              break;
            }
            default: break;
          }
        }
        // A measure is as long as its longest voice; an empty measure uses the time signature.
        const ts = timeSig || { num: 4, den: 4 };
        mStart += maxPos > 1e-9 ? maxPos : ts.num * 4 / ts.den;
      });
      notes.sort((x, y) => x.start - y.start || x.pitch - y.pitch);
      if (!measureStarts || starts.length > measureStarts.length) measureStarts = starts;
      lengthBeats = Math.max(lengthBeats, mStart);
      return { id, name: names.get(id) || id, transpose: everTransposed ? transpose : 0, notes };
    });
    return { source: 'musicxml', title, composer, timeSig: timeSig || { num: 4, den: 4 }, lengthBeats,
             measureStarts: measureStarts && measureStarts.length ? measureStarts : [0], parts };
  }

  const clampVel = v => Math.max(1, Math.min(127, Math.round(v)));

  // Reads the score inside a compressed .mxl (zip): META-INF/container.xml names the root file.
  function unzipMxl(bytes, fflate) {
    if (!fflate) throw new Error('fflate is needed to read .mxl files');
    const files = fflate.unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const dec = f => new TextDecoder().decode(f);
    let rootPath = null;
    if (files['META-INF/container.xml']) {
      const m = dec(files['META-INF/container.xml']).match(/<rootfile[^>]*full-path="([^"]+)"/);
      if (m) rootPath = m[1];
    }
    if (!rootPath || !files[rootPath]) rootPath = Object.keys(files).find(k => !k.startsWith('META-INF') && /\.(musicxml|xml)$/i.test(k));
    if (!rootPath) throw new Error('No score found in the .mxl archive');
    return dec(files[rootPath]);
  }

  /** Parses a dropped/picked file by content (MThd = MIDI, PK = zip/.mxl, else MusicXML text). */
  function parseFile(name, bytes, opts) {
    opts = opts || {};
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const head = String.fromCharCode(...b.subarray(0, 4));
    let res;
    if (head === 'MThd') res = parseMidi(b);
    else if (head.startsWith('PK')) res = parseMusicXML(unzipMxl(b, opts.fflate || root.fflate), opts);
    else res = parseMusicXML(new TextDecoder().decode(b), opts);
    res.fileName = name || '';
    if (!res.title) res.title = (name || '').replace(/\.[^.]+$/, '');
    res.parts = res.parts.filter(p => p.notes.length);
    if (!res.parts.length) throw new Error('No notes found in ' + (name || 'the file'));
    return res;
  }

  // ------------------------------------------------------------------ import plan

  /**
   * part:     a parsed part ({notes:[{start, dur, pitch, written, vel}]}).
   * opts:     { stepsPerBeat, targetBeat (clip beats), fromBeat, toBeat (source range, beats), written (use written pitch),
   *             transpose (extra semitones), mode: 'replace'|'merge', existing: live notes [{ch, x, y, d}], channel, clipLength }
   * returns { ops, adds, dels, startStep, endStep, beyondClip, skipped }
   */
  function planImport(part, opts) {
    const spb = opts.stepsPerBeat || 24;
    const from = opts.fromBeat || 0;
    const to = opts.toBeat == null ? Infinity : opts.toBeat;
    const target = opts.targetBeat || 0;
    const ch = opts.channel || 0;
    const shift = opts.transpose || 0;
    const chosen = new Map();
    let skipped = 0;
    part.notes.forEach(n => {
      if (n.start < from - 1e-6 || n.start >= to - 1e-6) return;
      const y = (opts.written ? (n.written != null ? n.written : n.pitch) : n.pitch) + shift;
      const x = Math.round((target + n.start - from) * spb);
      if (y < 0 || y > 127 || x < 0) { skipped++; return; }
      const dur = Math.max(1, Math.round(Math.min(n.dur, to - n.start) * spb)) / spb;
      const k = x + ':' + y, old = chosen.get(k);
      if (!old || old.dur < dur) chosen.set(k, { x, y, dur, vel: clampVel(n.vel == null ? 80 : n.vel) });
    });
    const adds = [...chosen.values()].sort((a, b) => a.x - b.x || a.y - b.y);
    const span = Number.isFinite(to) ? to - from : (adds.length ? Math.max(...adds.map(a => a.x / spb + a.dur)) - target : 0);
    const startStep = Math.round(target * spb), endStep = Math.round((target + span) * spb);
    const dels = opts.mode === 'replace' ? (opts.existing || []).filter(n => n.x >= startStep && n.x < endStep) : [];
    const fmt = v => String(Math.round(v * 1e6) / 1e6);
    const ops = dels.map(n => `del ${n.ch} ${n.x} ${n.y}`)
      .concat(adds.map(a => `add ${ch} ${a.x} ${a.y} ${a.vel} ${fmt(a.dur)}`));
    const clipSteps = opts.clipLength != null ? Math.round(opts.clipLength * spb) : Infinity;
    return { ops, adds, dels, startStep, endStep, skipped, beyondClip: adds.filter(a => a.x >= clipSteps).length };
  }

  const api = { parseMidi, parseMusicXML, parseFile, unzipMxl, planImport, measureStartsFromSigs };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.SVImport = api;

  // ------------------------------------------------------------------ browser UI

  const SV = root.SV;
  if (!SV) return;
  SV.import = api;
  const PREF = 'scoreview.import.';
  const pref = (k, d) => { try { const v = localStorage.getItem(PREF + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(PREF + k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const pname = p => NOTE[p % 12] + (Math.floor(p / 12) - 1);

  SV.addStyle(`
    .svi-back { position: fixed; inset: 0; background: #0009; z-index: 40; display: flex; align-items: center; justify-content: center; }
    .svi-dlg { background: var(--bar); color: var(--text); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 10px 40px #000c;
               width: min(860px, 96vw); max-height: 92vh; display: flex; flex-direction: column; }
    .svi-dlg h3 { margin: 0; padding: 12px 16px 8px; font-size: 15px; color: #fff; }
    .svi-dlg .svi-sub { color: var(--dim); font-weight: 400; font-size: 12px; margin-left: 8px; }
    .svi-body { padding: 4px 16px 10px; overflow: auto; }
    .svi-parts { width: 100%; border-collapse: collapse; margin: 4px 0 10px; }
    .svi-parts td, .svi-parts th { padding: 3px 6px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
    .svi-parts th { color: var(--dim); font-weight: 500; font-size: 11px; }
    .svi-parts tr { cursor: pointer; }
    .svi-parts tr.on td { background: #ff7a1a22; }
    .svi-parts canvas { display: block; }
    .svi-big { display: block; width: 100%; height: 120px; background: #1a1a1a; border: 1px solid var(--line); border-radius: 4px; margin-bottom: 10px; }
    .svi-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; align-items: center; }
    .svi-grid > label { color: var(--dim); }
    .svi-grid input[type=number] { width: 5em; background: var(--bar2); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 2px 4px; font: inherit; }
    .svi-grid .opt { color: var(--text); margin-right: 12px; white-space: nowrap; }
    .svi-info { margin-top: 10px; color: var(--dim); min-height: 2.6em; }
    .svi-info b { color: var(--text); }
    .svi-info .warn { color: #ffb347; }
    .svi-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid var(--line); }
    .svi-foot .primary { background: var(--accent); color: #111; font-weight: 600; border-color: var(--accent); }
  `);

  const g = SV.addToolbar('<button class="btn" id="svImportBtn" title="Import a part from MusicXML (.musicxml/.xml/.mxl) or MIDI (.mid) into the selected clip">Import…</button>' +
    '<input type="file" id="sviFile" accept=".musicxml,.xml,.mxl,.mid,.midi" class="hidden">', { cluster: 'file', order: 160 });
  g.id = 'sviGroup';
  const $ = id => document.getElementById(id);
  $('svImportBtn').addEventListener('click', () => {
    const d = SV.state.liveData;
    if (!d || !d.exists) { SV.flash('Select a clip in Bitwig first — the import goes into the selected clip'); return; }
    $('sviFile').value = '';
    $('sviFile').click();
  });
  $('sviFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { openDialog(parseFile(f.name, new Uint8Array(await f.arrayBuffer()))); } catch (err) { console.error('import', err); SV.flash('Import failed: ' + err.message); }
  });

  // Piano-roll thumbnail of notes in [from, to) beats.
  function drawRoll(canvas, notes, from, to, opts) {
    const dpr = root.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d');
    c.scale(dpr, dpr);
    c.clearRect(0, 0, w, h);
    const sel = notes.filter(n => n.start >= from - 1e-6 && n.start < to - 1e-6);
    if (opts && opts.bars) {
      c.strokeStyle = '#ffffff14';
      opts.bars.forEach(b => { if (b >= from && b < to) { const x = (b - from) / (to - from) * w; c.beginPath(); c.moveTo(x + .5, 0); c.lineTo(x + .5, h); c.stroke(); } });
    }
    if (!sel.length) return;
    let lo = Math.min(...sel.map(n => n.pitch)), hi = Math.max(...sel.map(n => n.pitch));
    if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6; }
    const nh = Math.max(1.5, h / (hi - lo + 1));
    c.fillStyle = (opts && opts.color) || '#ff7a1a';
    sel.forEach(n => {
      const x = (n.start - from) / (to - from) * w, ww = Math.max(1.5, n.dur / (to - from) * w - 0.5);
      c.fillRect(x, h - (n.pitch - lo + 1) * nh * (h - nh) / Math.max(h - nh, 1) - 0.5, ww, Math.max(1.5, nh - 0.5));
    });
  }

  function targetChoices() {
    const st = SV.state, d = st.liveData, spb = d.stepsPerBeat || 24;
    const out = [{ v: 'clip', label: 'Clip start', beat: 0 }];
    const sel = [...st.selection].filter(SV.isLive).map(SV.parseId);
    if (sel.length) out.push({ v: 'sel', label: 'Selection (bar ' + barOf(Math.min(...sel.map(n => n.x)) / spb) + ')', beat: Math.min(...sel.map(n => n.x)) / spb });
    const E = SV.entry && SV.entry.state;
    if (E && E.on) out.push({ v: 'caret', label: 'Entry caret (bar ' + barOf(E.caret / spb) + ')', beat: E.caret / spb });
    out.push({ v: 'bar', label: 'Bar', beat: null });
    return out;
  }

  // Bar numbers as the user sees them: clip bars in clip mode, arranger bars in score mode.
  function measureBeats() {
    const st = SV.state, d = st.liveData;
    const ts = st.mode === 'score' && st.base ? st.base.timeSig : { num: (d && d.num) || 4, den: (d && d.den) || 4 };
    return ts.num * 4 / ts.den;
  }
  const clipOffset = () => (SV.contentOrigin ? SV.contentOrigin() : (SV.state.mode === 'score' && SV.state.align ? SV.state.align.offset : 0)); // score beat of the clip's content beat 0
  const barOf = clipBeat => Math.floor((clipBeat + clipOffset()) / measureBeats() + 1e-9) + 1;
  const beatOfBar = bar => (bar - 1) * measureBeats() - clipOffset();

  let dlg = null;
  function close() { if (dlg) { dlg.remove(); dlg = null; } }

  function openDialog(file) {
    close();
    const st = SV.state, d = st.liveData;
    const bars = file.measureStarts;
    const nBars = bars.length;
    const cur = { part: 0, fromBar: 1, toBar: nBars, written: false, transpose: 0, target: pref('target', 'clip'), bar: barOf(0),
                  mode: pref('mode', 'replace') };
    const targets = targetChoices();
    if (!targets.some(t => t.v === cur.target)) cur.target = targets.some(t => t.v === 'caret') ? 'caret' : 'clip';

    dlg = document.createElement('div');
    dlg.className = 'svi-back';
    dlg.id = 'sviDialog';
    dlg.tabIndex = -1;
    const src = file.source === 'midi' ? `MIDI format ${file.format}, ${file.ppq} PPQ` : 'MusicXML';
    dlg.innerHTML = `<div class="svi-dlg" role="dialog" aria-label="Import">
      <h3>Import into “${esc(d.track || 'clip')}”<span class="svi-sub">${esc(file.fileName)} · ${src} · ${file.timeSig.num}/${file.timeSig.den} · ${nBars} bars${file.title ? ' · ' + esc(file.title) : ''}${file.composer ? ' — ' + esc(file.composer) : ''}</span></h3>
      <div class="svi-body">
        <table class="svi-parts"><thead><tr><th></th><th>Part</th><th>Notes</th><th>Range</th><th>Transposition</th><th>Preview</th></tr></thead><tbody>
        ${file.parts.map((p, i) => {
          const lo = Math.min(...p.notes.map(n => n.pitch)), hi = Math.max(...p.notes.map(n => n.pitch));
          return `<tr data-i="${i}"><td><input type="radio" name="sviPart" value="${i}"></td><td>${esc(p.name)}</td><td>${p.notes.length}</td>
            <td>${pname(lo)}–${pname(hi)}</td><td>${p.transpose ? 'sounds ' + (p.transpose > 0 ? '+' : '−') + Math.abs(p.transpose) + ' st (read as concert)' : '—'}</td>
            <td><canvas width="160" height="22" style="width:160px;height:22px"></canvas></td></tr>`;
        }).join('')}
        </tbody></table>
        <canvas class="svi-big" id="sviBig"></canvas>
        <div class="svi-grid">
          <label>Source bars</label>
          <div><input type="number" id="sviFrom" min="1" max="${nBars}" value="1"> to <input type="number" id="sviTo" min="1" max="${nBars}" value="${nBars}"></div>
          <label>Pitch</label>
          <div><label class="opt"><input type="radio" name="sviPitch" value="concert"> Concert (sounding)</label>
               <label class="opt"><input type="radio" name="sviPitch" value="written"> As written</label>
               Transpose <input type="number" id="sviShift" min="-48" max="48" step="1" value="0"> semitones</div>
          <label>Place at</label>
          <div>${targets.map(t => `<label class="opt"><input type="radio" name="sviTarget" value="${t.v}"> ${esc(t.label)}</label>`).join('')}
               <input type="number" id="sviBar" min="1" value="${cur.bar}"></div>
          <label>Existing notes</label>
          <div><label class="opt"><input type="radio" name="sviMode" value="replace"> Replace notes in the range</label>
               <label class="opt"><input type="radio" name="sviMode" value="merge"> Merge (keep them)</label></div>
        </div>
        <div class="svi-info" id="sviInfo"></div>
      </div>
      <div class="svi-foot"><button class="btn" id="sviCancel">Cancel</button><button class="btn primary" id="sviGo">Import</button></div>
    </div>`;
    document.body.appendChild(dlg);
    dlg.focus();
    const q = s => dlg.querySelector(s);
    const radios = name => [...dlg.querySelectorAll(`input[name="${name}"]`)];
    const setRadio = (name, v) => radios(name).forEach(r => { r.checked = r.value === String(v); });
    const getRadio = name => (radios(name).find(r => r.checked) || {}).value;

    dlg.querySelectorAll('.svi-parts tbody tr').forEach(tr => {
      const p = file.parts[+tr.dataset.i];
      drawRoll(tr.querySelector('canvas'), p.notes, 0, file.lengthBeats || 1, { color: '#c9a27a' });
      tr.addEventListener('click', () => { setRadio('sviPart', tr.dataset.i); update(); });
    });
    setRadio('sviPart', 0); setRadio('sviPitch', 'concert'); setRadio('sviTarget', cur.target); setRadio('sviMode', cur.mode);
    dlg.addEventListener('change', update);
    dlg.addEventListener('input', update);
    q('#sviCancel').addEventListener('click', close);
    dlg.addEventListener('mousedown', e => { if (e.target === dlg) close(); });
    dlg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.target.type !== 'number') go(); });
    q('#sviGo').addEventListener('click', go);

    let plan = null;
    function readForm() {
      cur.part = +(getRadio('sviPart') || cur.part);
      cur.fromBar = Math.max(1, Math.min(nBars, parseInt(q('#sviFrom').value, 10) || 1));
      cur.toBar = Math.max(cur.fromBar, Math.min(nBars, parseInt(q('#sviTo').value, 10) || nBars));
      cur.written = getRadio('sviPitch') === 'written';
      cur.transpose = parseInt(q('#sviShift').value, 10) || 0;
      cur.target = getRadio('sviTarget') || 'clip';
      cur.bar = parseInt(q('#sviBar').value, 10) || 1;
      cur.mode = getRadio('sviMode') || 'replace';
    }
    function targetBeat() {
      if (cur.target === 'bar') return beatOfBar(cur.bar);
      const t = targets.find(x => x.v === cur.target);
      return t ? t.beat : 0;
    }
    function update() {
      readForm();
      setRadio('sviPart', cur.part);
      dlg.querySelectorAll('.svi-parts tbody tr').forEach(tr => tr.classList.toggle('on', +tr.dataset.i === cur.part));
      q('#sviBar').disabled = cur.target !== 'bar';
      const part = file.parts[cur.part];
      radios('sviPitch').forEach(r => { r.disabled = !part.transpose; });
      const from = bars[cur.fromBar - 1], to = cur.toBar < nBars ? bars[cur.toBar] : Math.max(file.lengthBeats, from);
      drawRoll(q('#sviBig'), part.notes, from, to, { bars });
      const live = SV.state.liveData;
      const tb = targetBeat();
      const info = q('#sviInfo');
      if (tb < 0) { plan = null; info.innerHTML = '<span class="warn">That position is before the start of the clip.</span>'; q('#sviGo').disabled = true; return; }
      plan = planImport(part, { stepsPerBeat: live.stepsPerBeat || 24, targetBeat: tb, fromBeat: from, toBeat: to,
                                written: cur.written && !!part.transpose, transpose: cur.transpose, mode: cur.mode,
                                existing: live.notes || [], clipLength: live.length });
      q('#sviGo').disabled = !plan.adds.length;
      const endBar = barOf(plan.endStep / (live.stepsPerBeat || 24) - 1e-6);
      info.innerHTML = `<b>${plan.adds.length}</b> notes → bars ${barOf(tb)}–${endBar}` +
        (cur.mode === 'replace' ? `, <b>${plan.dels.length}</b> existing notes in that range are removed` : ', existing notes are kept') +
        (plan.beyondClip ? `<br><span class="warn">${plan.beyondClip} notes start after the clip end (${live.length} beats) — lengthen the clip in Bitwig to hear them.</span>` : '') +
        (plan.skipped ? `<br><span class="warn">${plan.skipped} notes are outside the MIDI range and are skipped.</span>` : '');
    }
    update();

    async function go() {
      if (!plan || !plan.adds.length) return;
      setPref('target', cur.target === 'sel' || cur.target === 'caret' ? 'clip' : cur.target);
      setPref('mode', cur.mode);
      const p = plan, name = file.parts[cur.part].name;
      close();
      await sendChunked(p.ops, (done, all) => SV.flash(`Importing ${name}… ${done}/${all}`));
      SV.flash(`Imported ${p.adds.length} notes of ${name}` + (p.dels.length ? ` (replaced ${p.dels.length})` : ''));
    }
  }

  // Sends ops in chunks; each chunk waits until Bitwig reports the clip again (or 4 s), so large imports stay ordered.
  const CHUNK = 250;
  async function sendChunked(ops, progress) {
    for (let i = 0; i < ops.length; i += CHUNK) {
      const chunk = ops.slice(i, i + CHUNK);
      const seen = new Promise(resolve => {
        const t = setTimeout(done, 4000);
        function done() { clearTimeout(t); const k = SV.hooks.liveData.indexOf(done); if (k >= 0) SV.hooks.liveData.splice(k, 1); resolve(); }
        SV.hooks.liveData.push(done);
      });
      SV.send(chunk);
      await seen;
      if (progress) progress(Math.min(ops.length, i + CHUNK), ops.length);
    }
  }

  api.openDialog = openDialog;
  api.sendChunked = sendChunked;
  api.close = close;
  SV.addHelp('<b>Import…</b> reads MusicXML (.musicxml/.xml/.mxl) or MIDI (.mid): pick a part, the bars and where it goes; the notes are written into the selected clip.');
})(this);
