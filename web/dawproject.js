// Reads a DAWproject (.dawproject zip or project.xml text) into { title, timeSig, bpm, parts, lengthBeats,
// markers:[{beat, name}] } for ScoreBuilder.
// Parts also carry (when the export has them):
//   notes[].vel (0..1);
//   automation: { dynamics?, expression?, cc: { [controller]: points } }  points = [{ t (beats), v (0..1) }]
//     (the instrument's "Dynamics"/"Expression" parameter lanes, e.g. BBC Symphony Orchestra, and MIDI CC lanes);
//   plugin: { name, state (path in the zip) }; articulations: { [keyswitch key]: name }, articulationSource
//     (read from the plugin state -- Spitfire/BBC SO "SPITFIREAUDIO_AUNTIE" XML -- in full exports with plugins/).
(function (root) {
  'use strict';

  const kids = (el, tag) => [...el.children].filter(c => !tag || c.tagName === tag);
  const num = (el, attr, def) => { const v = el.getAttribute(attr); return v == null || v === '' ? def : parseFloat(v); };

  // Notes inside a timeline element, in that element's own time base.
  function contentNotes(el) {
    let out = [];
    for (const c of kids(el)) {
      if (c.tagName === 'Notes') {
        for (const n of kids(c, 'Note')) {
          out.push({ t: num(n, 'time', 0), d: num(n, 'duration', 0.25), key: num(n, 'key', 60), vel: num(n, 'vel', 0.8) });
        }
      } else if (c.tagName === 'Clips') {
        for (const clip of kids(c, 'Clip')) out = out.concat(clipNotes(clip));
      } else if (c.tagName === 'Lanes' || c.tagName === 'Clip') {
        out = out.concat(contentNotes(c));
      }
    }
    return out;
  }

  // Maps a clip's content (with play start and loop) onto its parent's time base.
  function clipNotes(clip) {
    const time = num(clip, 'time', 0), duration = num(clip, 'duration', 0);
    const playStart = num(clip, 'playStart', 0);
    const loopStart = num(clip, 'loopStart', null), loopEnd = num(clip, 'loopEnd', null);
    const end = time + duration;
    const inner = contentNotes(clip);
    const segs = [];
    if (loopEnd != null && loopStart != null && loopEnd > loopStart) {
      let g = time, s = playStart;
      while (g < end - 1e-9 && segs.length < 10000) {
        const e = s < loopEnd ? loopEnd : s + (loopEnd - loopStart);
        segs.push({ s, e, g });
        g += e - s;
        s = loopStart;
      }
    } else {
      segs.push({ s: playStart, e: playStart + duration, g: time });
    }
    const out = [];
    for (const seg of segs) {
      for (const n of inner) {
        if (n.t < seg.s - 1e-9 || n.t >= seg.e - 1e-9) continue;
        const t = seg.g + (n.t - seg.s);
        if (t >= end - 1e-9) continue;
        const d = Math.min(n.d, seg.e - n.t, end - t);
        out.push({ ...n, t, d });
      }
    }
    return out;
  }

  // Track-level automation lanes (<Points> directly in the track's lanes, not inside clips).
  function trackAutomation(lanes, params, toBeats, auto) {
    const walk = el => {
      for (const c of kids(el)) {
        if (c.tagName === 'Lanes' && !c.hasAttribute('track')) { walk(c); continue; }
        if (c.tagName !== 'Points') continue;
        const target = kids(c, 'Target')[0];
        if (!target) continue;
        const pts = kids(c).filter(p => /Point$/.test(p.tagName))
          .map(p => ({ t: num(p, 'time', 0) * toBeats, v: num(p, 'value', 0) }))
          .filter(p => isFinite(p.t) && isFinite(p.v));
        if (!pts.length) continue;
        const param = params[target.getAttribute('parameter')];
        if (param) {
          const name = String(param.name || '').toLowerCase();
          const span = param.max > param.min ? param.max - param.min : 1;
          const norm = pts.map(p => ({ t: p.t, v: (p.v - param.min) / span }));
          if (name === 'dynamics' || name === 'dynamic') auto.dynamics = norm;
          else if (name === 'expression') auto.expression = norm;
        } else if (target.getAttribute('expression') === 'channelController') {
          auto.cc[target.getAttribute('controller')] = pts;
        }
      }
    };
    walk(lanes);
    return auto;
  }

  // Articulation table from a plugin state: Spitfire/BBC SO keeps readable XML inside the .vstpreset.
  // Returns { name (instrument patch), map: { key: articulation name } } or null.
  function parsePluginState(bytes) {
    if (!bytes) return null;
    const find = (pat, from) => {
      const p = [...pat].map(c => c.charCodeAt(0));
      outer: for (let i = from || 0; i <= bytes.length - p.length; i++) {
        if (bytes[i] !== p[0]) continue;
        for (let j = 1; j < p.length; j++) if (bytes[i + j] !== p[j]) continue outer;
        return i;
      }
      return -1;
    };
    const a = find('<SPITFIREAUDIO_AUNTIE');
    if (a < 0) return null;
    const z = find('</SPITFIREAUDIO_AUNTIE>', a);
    return parseSpitfireXml(new TextDecoder().decode(bytes.subarray(a, z < 0 ? bytes.length : z)));
  }

  function parseSpitfireXml(xml) {
    const meta = /<META\b[^>]*\bname="([^"]*)"/.exec(xml);
    const setting = (block, id) => { const m = new RegExp('id="' + id + '" value="([^"]*)"').exec(block); return m ? m[1] : null; };
    const map = {};
    xml.split('<ARTIC>').slice(1).forEach(block => {
      block = block.split('</ARTIC>')[0];
      const name = setting(block, 'a_name'), key = setting(block, 't_keyswitch'), type = setting(block, 't_type');
      if (name == null || key == null || (type != null && type !== '1') || setting(block, 't_enabled') === '0') return;
      const k = parseInt(key, 10);
      // "b - Violins 1 - Short Spiccato" -> "Short Spiccato"
      if (k >= 0 && k < 128 && !(k in map)) map[k] = name.replace(/^\s*\w{1,2}\s+-\s+.*?\s+-\s+/, '').trim();
    });
    return Object.keys(map).length ? { name: meta ? meta[1] : '', map } : null;
  }

  function parseProjectXml(xml, title, states) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const proj = doc.documentElement;
    if (!proj || proj.tagName !== 'Project') throw new Error('Not a DAWproject project.xml');
    const transport = kids(proj, 'Transport')[0];
    const tsEl = transport && kids(transport, 'TimeSignature')[0];
    const tempoEl = transport && kids(transport, 'Tempo')[0];
    const timeSig = { num: tsEl ? num(tsEl, 'numerator', 4) : 4, den: tsEl ? num(tsEl, 'denominator', 4) : 4 };
    const bpm = tempoEl ? num(tempoEl, 'value', 120) : 120;

    const tracks = [];
    const byId = {};
    (function walk(el, group) {
      for (const t of kids(el, 'Track')) {
        const name = t.getAttribute('name') || 'Track';
        const ct = t.getAttribute('contentType') || '';
        if (/notes/.test(ct)) {
          const tr = { id: t.getAttribute('id'), name, group, notes: [], params: {}, plugin: null, automation: { cc: {} } };
          // Device parameters (automation targets) and the instrument plugin's state file.
          const channel = kids(t, 'Channel')[0];
          const devices = channel && kids(channel, 'Devices')[0];
          if (devices) {
            for (const dev of kids(devices)) {
              const params = kids(dev, 'Parameters')[0];
              if (params) for (const p of kids(params)) {
                tr.params[p.getAttribute('id')] = { name: p.getAttribute('name'), min: num(p, 'min', 0), max: num(p, 'max', 1) };
              }
              const state = kids(dev, 'State')[0];
              if (state && !tr.plugin && dev.getAttribute('deviceRole') === 'instrument') {
                tr.plugin = { name: dev.getAttribute('deviceName') || dev.getAttribute('name') || '', state: state.getAttribute('path') };
              }
            }
          }
          tracks.push(tr); byId[tr.id] = tr;
        }
        walk(t, group || (kids(t, 'Track').length ? name : null));
      }
    })(kids(proj, 'Structure')[0] || proj, null);

    const arrangement = kids(proj, 'Arrangement')[0];
    if (arrangement) {
      for (const lanes of arrangement.querySelectorAll('Lanes[track]')) {
        const tr = byId[lanes.getAttribute('track')];
        if (!tr) continue;
        const unitEl = lanes.closest('[timeUnit]');
        const toBeats = unitEl && unitEl.getAttribute('timeUnit') === 'seconds' ? bpm / 60 : 1;
        contentNotes(lanes).forEach(n => tr.notes.push({ start: n.t * toBeats, dur: n.d * toBeats, pitch: n.key, vel: n.vel }));
        trackAutomation(lanes, tr.params, toBeats, tr.automation);
      }
    }

    // Arrangement cue markers -> [{ beat, name }] (rehearsal marks).
    const markers = [];
    const markersEl = arrangement && kids(arrangement, 'Markers')[0];
    if (markersEl) {
      const unitEl = markersEl.closest('[timeUnit]');
      const toBeats = unitEl && unitEl.getAttribute('timeUnit') === 'seconds' ? bpm / 60 : 1;
      for (const m of kids(markersEl, 'Marker')) {
        markers.push({ beat: num(m, 'time', 0) * toBeats, name: (m.getAttribute('name') || '').trim() });
      }
      markers.sort((a, b) => a.beat - b.beat);
    }

    const { tempo, tempoChanges, tempoPoints } = readTempo(arrangement, bpm);
    const timeSigChanges = readTimeSignatures(arrangement, tempoPoints);
    if (timeSigChanges.length && timeSigChanges[0].beat <= 1e-6) {
      const first = timeSigChanges.shift();
      timeSig.num = first.num; timeSig.den = first.den;
    }

    let lengthBeats = 0;
    const parts = tracks.filter(t => t.notes.length).map((t, ti) => {
      t.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      t.notes.forEach((n, i) => { n.id = 't' + ti + '_' + i; lengthBeats = Math.max(lengthBeats, n.start + n.dur); });
      const part = { name: t.name, group: t.group, notes: t.notes };
      const a = t.automation;
      if (a.dynamics || a.expression || Object.keys(a.cc).length) part.automation = a;
      if (t.plugin) {
        part.plugin = t.plugin;
        const arts = states && parsePluginState(states[t.plugin.state]);
        if (arts) { part.articulations = arts.map; part.articulationSource = t.plugin.name + (arts.name ? ': ' + arts.name : ''); }
      }
      return part;
    });
    return { title, timeSig, bpm, tempo, tempoChanges, timeSigChanges, parts, lengthBeats, markers };
  }

  // Seconds -> beats along a tempo curve (points [{beat, sec, bpm, linear}] from readTempo).
  function secondsToBeats(sec, pts, bpm) {
    if (!pts || !pts.length) return sec * bpm / 60;
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1].sec <= sec) i++;
    const p = pts[i];
    if (sec <= p.sec) return p.beat - (p.sec - sec) * p.bpm / 60;
    const q = pts[i + 1];
    if (!q || !p.linear) return p.beat + (sec - p.sec) * p.bpm / 60;
    // Linear tempo in time between p and q: integrate bpm(t)/60.
    const f = (sec - p.sec) / (q.sec - p.sec), v = p.bpm + (q.bpm - p.bpm) * f;
    return p.beat + (sec - p.sec) * (p.bpm + v) / 120;
  }

  // Arrangement <TempoAutomation> (RealPoints in bpm) -> initial tempo and changes for the score:
  // tempoChanges [{beat, bpm}] (sudden) or [{beat, endBeat, bpm}] (gradual: linear ramp reaching bpm at endBeat).
  function readTempo(arrangement, bpm) {
    const el = arrangement && kids(arrangement, 'TempoAutomation')[0];
    const raw = el ? kids(el).filter(p => /Point$/.test(p.tagName))
      .map(p => ({ t: num(p, 'time', 0), v: num(p, 'value', bpm), linear: (p.getAttribute('interpolation') || 'hold') === 'linear' }))
      .filter(p => isFinite(p.t) && p.v > 0).sort((a, b) => a.t - b.t) : [];
    if (!raw.length) return { tempo: bpm, tempoChanges: [], tempoPoints: null };
    const unitEl = el.closest('[timeUnit]');
    const seconds = unitEl && unitEl.getAttribute('timeUnit') === 'seconds';
    // Point positions in beats (integrating the curve when the automation is timed in seconds).
    const pts = [];
    raw.forEach((p, i) => {
      if (!seconds) { pts.push({ beat: p.t, sec: null, bpm: p.v, linear: p.linear }); return; }
      const prev = pts[i - 1];
      const beat = !prev ? p.t * raw[0].v / 60
        : prev.beat + (p.t - prev.sec) * (prev.linear ? (prev.bpm + p.v) / 120 : prev.bpm / 60);
      pts.push({ beat, sec: p.t, bpm: p.v, linear: p.linear });
    });
    const changes = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      if (Math.abs(b.bpm - a.bpm) < 0.5) continue;
      if (a.linear && b.beat - a.beat >= 1) {
        const prev = changes[changes.length - 1];
        // Contiguous ramps in the same direction read as one accel./rit.
        if (prev && prev.endBeat != null && Math.abs(prev.endBeat - a.beat) < 1e-6 && Math.sign(b.bpm - a.bpm) === Math.sign(prev.bpm - prev.from)) {
          prev.endBeat = b.beat; prev.bpm = b.bpm;
        } else changes.push({ beat: a.beat, endBeat: b.beat, bpm: b.bpm, from: a.bpm });
      } else changes.push({ beat: b.beat, bpm: b.bpm });
    }
    changes.forEach(c => { delete c.from; });
    return { tempo: pts[0].bpm, tempoChanges: changes, tempoPoints: seconds ? pts : null };
  }

  // Arrangement <TimeSignatureAutomation> (<TimeSignaturePoint time numerator denominator/>) -> [{beat, num, den}].
  function readTimeSignatures(arrangement, tempoPoints) {
    const el = arrangement && kids(arrangement, 'TimeSignatureAutomation')[0];
    if (!el) return [];
    const unitEl = el.closest('[timeUnit]');
    const seconds = unitEl && unitEl.getAttribute('timeUnit') === 'seconds';
    const out = [];
    kids(el, 'TimeSignaturePoint').forEach(p => {
      const t = num(p, 'time', 0), n = num(p, 'numerator', 0), d = num(p, 'denominator', 0);
      if (!(n > 0 && d > 0) || !isFinite(t)) return;
      const beat = seconds ? secondsToBeats(t, tempoPoints, 120) : t;
      const prev = out[out.length - 1];
      if (prev && prev.num === n && prev.den === d) return;
      out.push({ beat: Math.round(beat * 1e6) / 1e6, num: n, den: d });
    });
    return out.sort((a, b) => a.beat - b.beat);
  }

  function parseDawProjectFile(arrayBuffer, title) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // zip
      const files = root.fflate.unzipSync(bytes, { filter: f => f.name === 'project.xml' });
      if (!files['project.xml']) throw new Error('project.xml not found in archive');
      const xml = root.fflate.strFromU8(files['project.xml']);
      // Full exports also contain plugin states; read the ones the project references (articulation tables).
      const wanted = new Set([...xml.matchAll(/<State path="([^"]+)"/g)].map(m => m[1]));
      let states = null;
      if (wanted.size) {
        try { states = root.fflate.unzipSync(bytes, { filter: f => wanted.has(f.name) && /\.vstpreset$/i.test(f.name) }); } catch (e) { states = null; }
      }
      return parseProjectXml(xml, title, states);
    }
    return parseProjectXml(new TextDecoder().decode(bytes), title);
  }

  root.DawProject = { parseDawProjectFile, parseProjectXml, parsePluginState, parseSpitfireXml };
})(this);
