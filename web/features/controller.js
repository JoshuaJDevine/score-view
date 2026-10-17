// Feature module: controller — controller-native note entry (GitHub #15). See docs/midi-bridge.md (Controller).
//
//  MIDI Learn for entry actions (durations, dot, tie, rest, caret, undo, pitch, transport …) from buttons, pads,
//  encoders, faders, program changes, pitch-bend zones, transport (Start/Stop) messages and keys outside the playing
//  range. Maps are stored per input port (localStorage, import/export as JSON); default maps for the Launchkey MK4,
//  the MiniLab 3 and any keyboard (lowest keys of an 88 as action keys) work before anything is learnt.
//  Encoders mapped to Duration / Caret / Pitch / Select scroll with smoothing and acceleration; a HUD shows what fired.
//  Input arrives through entry.js (SV.entry.rawHooks): Web MIDI carries everything, the Bitwig bridge notes only.
(function () {
  'use strict';
  const SV = window.SV;
  if (!SV || !SV.entry || !SV.entry.actions) return;
  const EN = SV.entry, A = EN.actions, E = EN.state;
  const $ = id => document.getElementById(id);
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('scoreview.controller.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem('scoreview.controller.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ------------------------------------------------------------------ actions
  //  kind: 'trigger' (button / pad / key), 'enc' (relative or absolute continuous control), 'mod' (held modifier).
  //  free: works while entry is off.
  const play = () => { if (SV.playback && SV.playback.togglePlay) SV.playback.togglePlay(); else SV.send(['toggle']); };
  const durName = k => EN.DURS[k].name;
  const ACTIONS = [
    { group: 'Durations', id: 'dur2', label: '32nd', run: () => A.dur(2) },
    { group: 'Durations', id: 'dur3', label: '16th', run: () => A.dur(3) },
    { group: 'Durations', id: 'dur4', label: '8th', run: () => A.dur(4) },
    { group: 'Durations', id: 'dur5', label: 'Quarter', run: () => A.dur(5) },
    { group: 'Durations', id: 'dur6', label: 'Half', run: () => A.dur(6) },
    { group: 'Durations', id: 'dur7', label: 'Whole', run: () => A.dur(7) },
    { group: 'Durations', id: 'durNext', label: 'Next duration (longer)', run: () => A.durNext() },
    { group: 'Durations', id: 'durPrev', label: 'Previous duration (shorter)', run: () => A.durPrev() },
    { group: 'Durations', id: 'dot', label: 'Dot', run: () => A.dot() },
    { group: 'Durations', id: 'triplet', label: 'Triplet', run: () => A.triplet() },
    { group: 'Entry', id: 'tie', label: 'Tie', run: () => A.tie() },
    { group: 'Entry', id: 'rest', label: 'Rest', run: () => A.rest() },
    { group: 'Entry', id: 'repeat', label: 'Repeat last', run: () => A.repeat() },
    { group: 'Entry', id: 'undo', label: 'Undo (take back)', run: () => A.undo() },
    { group: 'Entry', id: 'chord', label: 'Chord mode on/off', run: () => A.chordMode() },
    { group: 'Entry', id: 'rhythmFirst', label: 'Rhythm → Pitch on/off', run: () => A.rhythmFirst() },
    { group: 'Entry', id: 'tap', label: 'Tap rhythm (start/stop)', run: () => A.tap() },
    { group: 'Caret & selection', id: 'caretLeft', label: 'Caret left', run: () => A.caret(-1), repeat: true },
    { group: 'Caret & selection', id: 'caretRight', label: 'Caret right', run: () => A.caret(1), repeat: true },
    { group: 'Caret & selection', id: 'barPrev', label: 'Previous bar', run: () => A.bar(-1), repeat: true },
    { group: 'Caret & selection', id: 'barNext', label: 'Next bar', run: () => A.bar(1), repeat: true },
    { group: 'Caret & selection', id: 'selPrev', label: 'Select previous note', run: () => A.select(-1), repeat: true },
    { group: 'Caret & selection', id: 'selNext', label: 'Select next note', run: () => A.select(1), repeat: true },
    { group: 'Pitch (last / selected note)', id: 'sharp', label: 'Sharpen', run: () => A.accidental(1) },
    { group: 'Pitch (last / selected note)', id: 'flat', label: 'Flatten', run: () => A.accidental(-1) },
    { group: 'Pitch (last / selected note)', id: 'octUp', label: 'Octave up', run: () => A.octave(1) },
    { group: 'Pitch (last / selected note)', id: 'octDown', label: 'Octave down', run: () => A.octave(-1) },
    { group: 'Encoders', id: 'encDur', label: 'Duration', kind: 'enc', ticks: 2 },
    { group: 'Encoders', id: 'encCaret', label: 'Caret (by the current duration)', kind: 'enc', ticks: 1, accel: true },
    { group: 'Encoders', id: 'encPitch', label: 'Pitch (diatonic; with Shift chromatic)', kind: 'enc', ticks: 2 },
    { group: 'Encoders', id: 'encSelect', label: 'Select previous / next note', kind: 'enc', ticks: 2 },
    { group: 'Mode & transport', id: 'entry', label: 'Enter / leave entry mode', run: () => A.toggle(), free: true },
    { group: 'Mode & transport', id: 'play', label: 'Play / stop', run: play, free: true },
    { group: 'Mode & transport', id: 'stop', label: 'Stop', run: () => SV.send(['stop']), free: true },
    { group: 'Mode & transport', id: 'shift', label: 'Shift (modifier: pitch encoder chromatic)', kind: 'mod', free: true },
  ];
  const ACT = Object.fromEntries(ACTIONS.map(a => [a.id, a]));

  // ------------------------------------------------------------------ default maps
  //  ctl: { type: 'cc'|'note'|'pc'|'pb'|'rt', ch (0-15, null = any), num, mode (cc: btn|abs|rel2c|rel64|relSign|auto), zone (pb: up|down) }
  //  verified: checked against the maker's documentation; otherwise a best guess (shown with "?" in the panel).
  //  gate 'belowRange': a key only acts while it lies below the live instrument's range (else it enters the note).
  const cc = (ch, num, action, mode = 'btn', verified = false) => ({ action, ctl: { type: 'cc', ch, num, mode }, verified });
  const note = (ch, num, action, verified = false, gate) => ({ action, ctl: { type: 'note', ch, num }, verified, gate });
  const rt = (num, action, verified) => ({ action, ctl: { type: 'rt', ch: null, num }, verified });
  const pb = (zone, action) => ({ action, ctl: { type: 'pb', ch: null, zone }, verified: true });

  // Generic: the lowest keys of an 88-key board (A0–B1) as a Sibelius-like keypad, pitch bend as caret.
  const GENERIC = [
    note(null, 22, 'undo', true, 'belowRange'),   // A#0   (A0 stays the tap key)
    note(null, 23, 'rest', true, 'belowRange'),   // B0
    note(null, 24, 'dur2', true, 'belowRange'),   // C1  32nd
    note(null, 25, 'triplet', true, 'belowRange'),
    note(null, 26, 'dur3', true, 'belowRange'),   // D1  16th
    note(null, 27, 'tie', true, 'belowRange'),
    note(null, 28, 'dur4', true, 'belowRange'),   // E1  8th
    note(null, 29, 'dur5', true, 'belowRange'),   // F1  quarter
    note(null, 30, 'caretLeft', true, 'belowRange'),
    note(null, 31, 'dur6', true, 'belowRange'),   // G1  half
    note(null, 32, 'caretRight', true, 'belowRange'),
    note(null, 33, 'dur7', true, 'belowRange'),   // A1  whole
    note(null, 34, 'repeat', true, 'belowRange'),
    note(null, 35, 'dot', true, 'belowRange'),    // B1  dot
    pb('down', 'caretLeft'), pb('up', 'caretRight'),
  ];
  // Launchkey MK4 in standalone (MIDI) mode, MIDI port. Verified: the DAW-control buttons send CC on channel 16 and
  // Start/Stop send MIDI real-time messages (Programmer's Reference Guide v2, figure 1). Pads (Drum mode, channel 10,
  // notes 36–51 in the guide's layout) and encoders (Custom Mode CCs 21–24, set them to relative in Components)
  // are guesses until checked on the device.
  const LAUNCHKEY = [
    cc(15, 103, 'caretLeft', 'btn', true),   // Track ◀
    cc(15, 102, 'caretRight', 'btn', true),  // Track ▶
    cc(15, 74, 'tap', 'btn', true),          // Capture MIDI
    cc(15, 77, 'undo', 'btn', true),         // Undo
    cc(15, 75, 'rhythmFirst', 'btn', true),  // Quantise
    cc(15, 76, 'tie', 'btn', true),          // Metronome
    cc(15, 117, 'entry', 'btn', true),       // Record
    cc(15, 118, 'chord', 'btn', true),       // Loop
    rt(0xfa, 'play', true), rt(0xfc, 'stop', true),
    // Pads, Drum mode (ch 10). Top row 40 41 42 43 48 49 50 51, bottom row 36 37 38 39 44 45 46 47.
    note(9, 40, 'dur2'), note(9, 41, 'dur3'), note(9, 42, 'dur4'), note(9, 43, 'dur5'),
    note(9, 48, 'dur6'), note(9, 49, 'dur7'), note(9, 50, 'dot'), note(9, 51, 'triplet'),
    note(9, 36, 'rest'), note(9, 37, 'repeat'), note(9, 38, 'tie'), note(9, 39, 'flat'),
    note(9, 44, 'sharp'), note(9, 45, 'octDown'), note(9, 46, 'octUp'), note(9, 47, 'chord'),
    cc(null, 21, 'encDur', 'auto'), cc(null, 22, 'encCaret', 'auto'), cc(null, 23, 'encPitch', 'auto'), cc(null, 24, 'encSelect', 'auto'),
  ].concat(pb('down', 'caretLeft'), pb('up', 'caretRight'));
  // Arturia MiniLab 3, factory User program (all guesses): pads bank A notes 36–43 on channel 10, main encoder
  // CC 28, knobs 1–2 CC 74 / 71.
  const MINILAB = [
    note(9, 36, 'rest'), note(9, 37, 'repeat'), note(9, 38, 'tie'), note(9, 39, 'undo'),
    note(9, 40, 'dot'), note(9, 41, 'triplet'), note(9, 42, 'sharp'), note(9, 43, 'flat'),
    cc(null, 28, 'encDur', 'auto'), cc(null, 74, 'encCaret', 'auto'), cc(null, 71, 'encPitch', 'auto'),
  ].concat(pb('down', 'caretLeft'), pb('up', 'caretRight'));

  const DEFAULTS = [
    { id: 'launchkey', name: 'Launchkey MK4 (MIDI mode)', match: n => /launchkey/i.test(n) && !/daw|^midiin\d/i.test(n), bindings: LAUNCHKEY },
    { id: 'minilab', name: 'Arturia MiniLab 3', match: n => /minilab/i.test(n) && !/daw|^midiin\d/i.test(n), bindings: MINILAB },
    { id: 'generic', name: 'Generic keyboard (A0–B1 keypad, pitch bend)', match: () => true, bindings: GENERIC },
  ];
  const defaultFor = port => DEFAULTS.find(d => d.match(port || ''));
  const clone = o => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------------ maps per port
  const C = {
    maps: store.get('maps', {}),          // port -> { bindings, base (default id it started from) }
    listen: store.get('listen', false),   // keep MIDI open while entry is off
    sens: store.get('sens', 1),           // encoder ticks multiplier (0.5 fine … 2 coarse)
    ports: new Set(store.get('ports', [])),
    lastPort: null,
    learn: null,                          // { action, msgs, timer, port }
    shift: false, keyShift: false,
    st: new Map(),                        // per-binding runtime state (encoder accumulators, pressed flags)
    panelPort: null,
  };
  const saveMaps = () => store.set('maps', C.maps);
  function bindingsFor(port) {
    const m = C.maps[port];
    return m ? m.bindings : defaultFor(port).bindings;
  }
  function editableMap(port) {
    if (!C.maps[port]) C.maps[port] = { base: defaultFor(port).id, bindings: clone(defaultFor(port).bindings) };
    return C.maps[port];
  }
  function notePort(port) {
    C.lastPort = port;
    if (!C.ports.has(port)) { C.ports.add(port); store.set('ports', [...C.ports]); if (panelOpen()) renderPanel(); }
  }

  // ------------------------------------------------------------------ control descriptions
  const RT = { 0xfa: 'Start', 0xfb: 'Continue', 0xfc: 'Stop' };
  const MODE = { btn: 'button', abs: 'absolute', rel2c: 'relative (two\'s complement)', rel64: 'relative (64-centred)',
                 relSign: 'relative (sign bit)', incdec: 'inc/dec', auto: 'auto-detect' };
  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const keyName = n => NAMES[n % 12] + (Math.floor(n / 12) - 1);
  function ctlText(c) {
    const ch = c.ch == null ? '' : ' · ch ' + (c.ch + 1);
    if (c.type === 'note') return keyName(c.num) + ' (' + c.num + ')' + ch;
    if (c.type === 'cc') return 'CC ' + c.num + (c.mode === 'incdec' ? '/' + (c.num + 1) : '') + ch;
    if (c.type === 'pc') return 'Program ' + (c.num + 1) + ch;
    if (c.type === 'pb') return 'Pitch bend ' + (c.zone === 'up' ? '↑' : '↓') + ch;
    if (c.type === 'rt') return 'MIDI ' + (RT[c.num] || c.num.toString(16));
    return '?';
  }

  // ------------------------------------------------------------------ input
  const typeOf = st => (st >= 0xf8 ? (RT[st] ? 'rt' : null) :   // clock / active sensing are ignored
    ({ 0x80: 'off', 0x90: 'on', 0xb0: 'cc', 0xc0: 'pc', 0xe0: 'pb' })[st & 0xf0] || null);
  const matches = (c, type, ch, num) => c.type === type && (c.ch == null || c.ch === ch) &&
    (c.num === num || (c.type === 'cc' && c.mode === 'incdec' && c.num + 1 === num) || c.type === 'pb');

  // Lowest sounding pitch of the live instrument (generic action keys only act below it).
  function rangeLow() {
    const d = SV.state.liveData, I = SV.instruments;
    if (!d || !d.track || !I || !I.forPart) return null;
    try { const r = I.forPart({ name: String(d.track).replace(/ ✎$/, ''), notes: [] }); return r && r.range ? r.range[0] : null; } catch (e) { return null; }
  }
  const gateOk = b => b.gate !== 'belowRange' || rangeLow() == null || b.ctl.num < rangeLow();

  function raw(data, t, port) {
    const st = data[0], type = typeOf(st);
    if (!type) return false;
    notePort(port);
    if (C.learn) return learnMsg(data, t, port, type);
    const ch = st & 15, d1 = type === 'rt' ? st : data[1], d2 = data[2] || 0;
    const isOn = type === 'on' && d2 > 0, isOff = type === 'off' || (type === 'on' && d2 === 0);
    const ntype = isOn || isOff ? 'note' : type;
    const list = bindingsFor(port).filter(b => matches(b.ctl, ntype, ch, d1) && gateOk(b) &&
      !(b.gate && !E.on && ACT[b.action] && !ACT[b.action].free));   // keys stay keys while entry is off
    if (!list.length) return false;
    list.forEach(b => {
      const a = ACT[b.action];
      if (!a) return;
      if (ntype === 'note') onButton(b, a, isOn, port);
      else if (type === 'cc') onCC(b, a, d1, d2, t, port);
      else if (type === 'pc' || type === 'rt') onButton(b, a, true, port);
      else if (type === 'pb') onBend(b, a, (d1 | (d2 << 7)) - 8192, port);
    });
    return true;
  }

  function stateOf(b) {
    if (!C.st.has(b)) C.st.set(b, { acc: 0, t: 0, prev: null, down: false, hist: [], mode: null, rep: null });
    return C.st.get(b);
  }

  function onButton(b, a, down, port) {
    const s = stateOf(b);
    if (a.kind === 'mod') { C.shift = down; if (down) hud(a.label, b, port); return; }
    if (!down) { s.down = false; stopRepeat(s); return; }
    if (a.kind === 'enc') return fireEnc(b, a, 1, port);
    fire(a, b, port);
  }

  function fire(a, b, port) {
    if (!a.free && !E.on) { hud('Entry is off', b, port, 'Press N' + (findCtl('entry', port) ? ' or ' + findCtl('entry', port) : '') + ' first'); return; }
    a.run();
    hud(a.label, b, port, valueText(a));
  }
  const findCtl = (action, port) => { const b = bindingsFor(port).find(x => x.action === action); return b ? ctlText(b.ctl) : ''; };

  function onCC(b, a, num, v, t, port) {
    const s = stateOf(b), c = b.ctl;
    if (a.kind === 'mod') { C.shift = v >= 64; if (C.shift) hud(a.label, b, port); return; }
    if (a.kind !== 'enc') {                      // a button sending CC: fire on the rising edge (≥ 64)
      const down = v >= 64;
      if (down && !s.down) { s.down = true; fire(a, b, port); if (a.repeat) startRepeat(s, a, b, port); }
      else if (!down) { s.down = false; stopRepeat(s); }
      return;
    }
    let mode = c.mode;
    if (mode === 'incdec') return fireEnc(b, a, num === c.num ? 1 : -1, port, t);
    if (mode === 'auto') mode = s.mode || autoMode(s, v);
    if (mode === 'abs') {
      if (a.id === 'encDur') {                   // a knob or fader picks the duration directly
        const k = 2 + Math.min(5, Math.floor(v / 128 * 6));
        if (k !== E.digit) { if (!E.on) return fire({ label: 'Entry is off', run() {} }, b, port); A.dur(k); }
        hud('Duration', b, port, durStrip());
        return;
      }
      const prev = s.prev;
      s.prev = v;
      if (prev == null) return;
      return fireEnc(b, a, v - prev, port, t);
    }
    fireEnc(b, a, relDelta(mode, v), port, t);
  }
  const relDelta = (mode, v) => (mode === 'rel2c' ? (v < 64 ? v : v - 128) : mode === 'rel64' ? v - 64 : mode === 'relSign' ? (v & 64 ? -(v & 63) : v) : 0);

  // 'auto' CCs (defaults): decide relative vs absolute from the first values.
  function autoMode(s, v) {
    s.hist.push(v);
    const h = s.hist;
    const inR = (x, lo, hi) => x >= lo && x <= hi;
    if (h.some(x => !(inR(x, 1, 15) || inR(x, 113, 127) || inR(x, 57, 71)))) s.mode = 'abs';
    else if (h.length >= 3) {
      const mono = h.every((x, i) => i === 0 || x !== h[i - 1]) && (h.every((x, i) => i === 0 || x > h[i - 1]) || h.every((x, i) => i === 0 || x < h[i - 1]));
      s.mode = mono && h.length >= 4 ? 'abs' : h.every(x => inR(x, 57, 71)) ? 'rel64' : h.every(x => !inR(x, 57, 71)) ? 'rel2c' : 'abs';
    }
    if (!s.mode) return h.every(x => inR(x, 57, 71)) ? 'rel64' : 'rel2c'; // provisional
    if (s.mode === 'abs') s.prev = v;
    return s.mode;
  }

  // Encoder detents -> action steps, with per-action ticks per step, the sensitivity setting and acceleration.
  function fireEnc(b, a, delta, port, t) {
    if (!delta) return;
    const s = stateOf(b), now = t != null ? t : performance.now(), dt = now - s.t;
    if (dt > 400 || Math.sign(delta) !== Math.sign(s.acc)) s.acc = 0;
    s.t = now;
    const accel = a.accel && dt < 40 ? 3 : a.accel && dt < 90 ? 2 : 1;
    s.acc += delta * accel;
    const per = Math.max(0.5, a.ticks * C.sens);
    const steps = Math.trunc(s.acc / per);
    if (!steps) return;
    s.acc -= steps * per;
    if (!E.on) { hud('Entry is off', b, port, 'Press N first'); return; }
    const dir = Math.sign(steps), n = Math.abs(steps);
    if (a.id === 'encDur') { for (let i = 0; i < n; i++) dir > 0 ? A.durNext() : A.durPrev(); hud('Duration', b, port, durStrip()); }
    else if (a.id === 'encCaret') { A.caretSteps(steps * EN.curSteps()); hud('Caret', b, port, caretText()); }
    else if (a.id === 'encPitch') {
      const chrom = C.shift || C.keyShift;
      for (let i = 0; i < n; i++) chrom ? A.chromatic(dir) : A.diatonic(dir);
      hud('Pitch' + (chrom ? ' (chromatic)' : ''), b, port, lastText());
    } else if (a.id === 'encSelect') { for (let i = 0; i < n; i++) A.select(dir); hud('Select', b, port, lastText()); }
  }

  // Pitch bend: one action per push into a zone (> 60 % of the travel), auto-repeat while held for caret moves.
  function onBend(b, a, v, port) {
    const s = stateOf(b), inZone = b.ctl.zone === 'up' ? v > 4900 : v < -4900, out = Math.abs(v) < 2000;
    if (inZone && !s.down) { s.down = true; fire(a, b, port); if (a.repeat) startRepeat(s, a, b, port); }
    else if (out && s.down) { s.down = false; stopRepeat(s); }
  }
  function startRepeat(s, a, b, port) {
    stopRepeat(s);
    s.rep = setTimeout(function tick() { if (!s.down) return; fire(a, b, port); s.rep = setTimeout(tick, 110); }, 450);
  }
  function stopRepeat(s) { clearTimeout(s.rep); s.rep = null; }

  // ------------------------------------------------------------------ MIDI learn
  function startLearn(action) {
    if (C.learn) clearTimeout(C.learn.timer);
    C.learn = { action, msgs: [], timer: null };
    ensureListening();
    const a = ACT[action];
    hud('Learn: ' + a.label, null, null, a.kind === 'enc' ? 'Turn the encoder clockwise (or move the knob)…' : 'Press a button, pad or key…', true);
    renderPanel();
  }
  function cancelLearn() {
    if (!C.learn) return;
    clearTimeout(C.learn.timer);
    C.learn = null;
    hideHud();
    renderPanel();
    syncListen();
  }
  function learnMsg(data, t, port, type) {
    const L = C.learn, d2 = data[2] || 0;
    if (type === 'off' || (type === 'on' && d2 === 0)) return true;
    if (type === 'cc' && !L.msgs.length && d2 === 0 && ACT[L.action].kind !== 'enc') return true; // a button's release
    L.msgs.push({ data: [...data], t, port, type });
    if (type === 'on' || type === 'pc' || type === 'rt') { finishLearn(); return true; }
    if (!L.timer) L.timer = setTimeout(finishLearn, 500);
    return true;
  }
  function finishLearn() {
    const L = C.learn;
    if (!L || !L.msgs.length) return;
    clearTimeout(L.timer);
    C.learn = null;
    const a = ACT[L.action];
    // The control that sent the most messages (a touch-sense CC or stray clock does not win).
    const key = m => m.type + ':' + (m.data[0] & 15) + ':' + (m.type === 'pb' ? '' : m.data[1]) + ':' + m.port;
    const groups = new Map();
    L.msgs.forEach(m => { if (!groups.has(key(m))) groups.set(key(m), []); groups.get(key(m)).push(m); });
    const msgs = [...groups.values()].sort((p, q) => q.length - p.length)[0], m0 = msgs[0];
    const ch = m0.data[0] & 15, num = m0.data[1];
    let ctl;
    if (m0.type === 'on') ctl = { type: 'note', ch, num };
    else if (m0.type === 'pc') ctl = { type: 'pc', ch, num };
    else if (m0.type === 'rt') ctl = { type: 'rt', ch: null, num: m0.data[0] };
    else if (m0.type === 'pb') {
      const vals = msgs.map(m => (m.data[1] | (m.data[2] << 7)) - 8192);
      const peak = vals.reduce((p, v) => (Math.abs(v) > Math.abs(p) ? v : p), 0);
      ctl = { type: 'pb', ch: null, zone: peak >= 0 ? 'up' : 'down' };
    } else ctl = { type: 'cc', ch, num, mode: a.kind === 'enc' ? classify(num, msgs.map(m => m.data[2] || 0)) : 'btn' };
    const map = editableMap(m0.port);
    // One control drives one action (pitch-bend zones and inc/dec pairs count as their own control).
    const same = b => b.ctl.type === ctl.type && b.ctl.num === ctl.num && (b.ctl.ch == null || ctl.ch == null || b.ctl.ch === ctl.ch) && b.ctl.zone === ctl.zone;
    map.bindings = map.bindings.filter(b => !same(b));
    const b = { action: L.action, ctl, verified: true, learnt: true };
    map.bindings.push(b);
    saveMaps();
    C.st.clear();
    C.panelPort = m0.port;
    hud('Learnt: ' + a.label, b, m0.port, ctl.type === 'cc' ? MODE[ctl.mode] : '');
    renderPanel();
    syncListen();
  }
  // CC values seen while learning an encoder (turned clockwise) -> its mode.
  function classify(num, vals) {
    if (num === 96 || num === 97) return 'incdec';
    const inR = (x, lo, hi) => x >= lo && x <= hi;
    const distinct = new Set(vals).size;
    const mono = vals.length >= 3 && distinct === vals.length && (vals.every((x, i) => i === 0 || x > vals[i - 1]) || vals.every((x, i) => i === 0 || x < vals[i - 1]));
    if (mono && distinct >= 4) return 'abs';
    if (vals.every(x => inR(x, 1, 15)) || vals.every(x => inR(x, 113, 127))) return 'rel2c';
    if (vals.every(x => inR(x, 57, 71) && x !== 64)) return 'rel64';
    return vals.length === 1 && inR(vals[0], 1, 15) ? 'rel2c' : 'abs';
  }

  // ------------------------------------------------------------------ listening while entry is off
  const learningPanel = () => !!C.learn;
  EN.listeners.push(() => C.listen || learningPanel());
  function ensureListening() { if (E.midiSrc !== 'bitwig') EN.initMidi(); EN.syncBridge(); }
  function syncListen() { if (C.listen) ensureListening(); else EN.syncBridge(); }

  // ------------------------------------------------------------------ HUD
  function durStrip() {
    return '<span class="svc-strip">' + [2, 3, 4, 5, 6, 7].map(k =>
      `<span class="${k === E.digit ? 'on' : ''}">${EN.glyphSvg([{ b: EN.DURS[k].b, dot: k === E.digit && E.dot }], { triplet: k === E.digit && E.triplet })}</span>`).join('') + '</span>';
  }
  function caretText() {
    const s = EN.spb(), beats = E.caret / s, mb = SV.state.render ? SV.state.render.measureBeats : 4;
    return 'bar ' + (Math.floor(beats / mb + 1e-9) + 1) + ' · beat ' + +((beats % mb) + 1).toFixed(2);
  }
  const lastText = () => (E.last ? E.last.pitches.map(p => EN.pitchName(p, SV.state.render ? SV.state.render.keyFifths : 0)).join(' ') : '—');
  function valueText(a) {
    if (/^dur|^dot$|^triplet$/.test(a.id)) return durStrip();
    if (/^caret|^bar/.test(a.id)) return caretText();
    if (['sharp', 'flat', 'octUp', 'octDown', 'selNext', 'selPrev'].includes(a.id)) return lastText();
    if (a.id === 'chord') return E.chordMode ? 'on' : 'off';
    if (a.id === 'rhythmFirst') return E.rhythmFirst ? 'on' : 'off';
    if (a.id === 'tie') return E.tie ? 'on' : 'off';
    if (a.id === 'entry') return E.on ? 'on' : 'off';
    return '';
  }
  let hudTimer = 0;
  function hud(title, b, port, value, sticky) {
    let el = $('svc-hud');
    if (!el) { el = document.createElement('div'); el.id = 'svc-hud'; document.body.appendChild(el); }
    el.innerHTML = `<div class="t">${esc(title)}</div>` + (value ? `<div class="v">${value}</div>` : '') +
      (b ? `<div class="c">${esc(ctlText(b.ctl))}${b.verified === false ? ' <span title="Default map entry not yet verified on the device">?</span>' : ''}${port ? ' · ' + esc(port) : ''}</div>` : '');
    el.classList.add('show');
    el.classList.toggle('learn', !!sticky);
    clearTimeout(hudTimer);
    if (!sticky) hudTimer = setTimeout(hideHud, 1800);
    C.lastHud = { title, ctl: b ? ctlText(b.ctl) : null, port };
  }
  function hideHud() { const el = $('svc-hud'); if (el) el.classList.remove('show', 'learn'); }

  // ------------------------------------------------------------------ panel
  SV.addStyle(`
    #svc-hud { position: fixed; left: 50%; bottom: 120px; transform: translate(-50%, 12px); min-width: 220px; max-width: 80vw; z-index: 60;
               background: #1d1a2bee; color: #fff; border: 1px solid #7048e8; border-radius: 10px; padding: 8px 16px 9px; text-align: center;
               box-shadow: 0 6px 24px #0007; pointer-events: none; opacity: 0; transition: opacity .18s, transform .18s; font: 13px system-ui; }
    #svc-hud.show { opacity: 1; transform: translate(-50%, 0); }
    #svc-hud.learn { border-color: #f59f00; }
    #svc-hud .t { font: 600 17px system-ui; letter-spacing: .2px; }
    #svc-hud .v { margin-top: 4px; color: #e5dbff; font-size: 14px; }
    #svc-hud .c { margin-top: 4px; color: #a9a3c0; font-size: 11px; }
    .svc-strip { display: inline-flex; gap: 4px; align-items: flex-end; }
    .svc-strip > span { color: #8d86a8; padding: 1px 3px; border-radius: 4px; }
    .svc-strip > span.on { color: #fff; background: #7048e8; }
    #svc-panel { position: fixed; right: 16px; top: 60px; width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 90px); overflow: auto; z-index: 55;
                 background: var(--bar, #232323); color: var(--text, #eee); border: 1px solid var(--line, #444); border-radius: 8px;
                 box-shadow: 0 10px 40px #0008; font: 12.5px system-ui; padding: 10px 14px 12px; }
    #svc-panel h3 { margin: 0 0 6px; font: 600 15px system-ui; display: flex; align-items: center; gap: 8px; }
    #svc-panel h3 .x { margin-left: auto; }
    #svc-panel .row { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin: 4px 0; }
    #svc-panel select, #svc-panel button { background: var(--bar2, #2c2c2c); color: var(--text, #eee); border: 1px solid var(--line, #444);
                 border-radius: 4px; font: inherit; padding: 2px 7px; min-height: 24px; cursor: pointer; }
    #svc-panel button:hover { border-color: #7048e8; }
    #svc-panel button.learning { background: #f59f00; border-color: #f59f00; color: #111; }
    #svc-panel table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    #svc-panel td { padding: 1px 4px; border-top: 1px solid #ffffff10; vertical-align: middle; }
    #svc-panel td.g { padding-top: 7px; color: #b9a6ff; font-weight: 600; border-top: 0; }
    #svc-panel td.l { width: 40%; }
    #svc-panel td.b { width: 52px; text-align: right; }
    #svc-panel tr.hot td { background: #7048e833; }
    .svc-chip { display: inline-flex; align-items: center; gap: 3px; background: #ffffff12; border-radius: 10px; padding: 1px 4px 1px 8px; margin: 1px 3px 1px 0; white-space: nowrap; }
    .svc-chip.guess { border: 1px dashed #ffffff40; }
    .svc-chip .rm { cursor: pointer; color: #aaa; padding: 0 3px; }
    .svc-chip .rm:hover { color: #ff8787; }
    .svc-chip select { min-height: 18px !important; padding: 0 2px !important; font-size: 11px !important; }
    #svc-panel .note { color: var(--dim, #999); font-size: 11.5px; line-height: 1.4; margin-top: 8px; }
    #svc-panel textarea { width: 100%; height: 90px; font: 11px ui-monospace, monospace; background: #111; color: #ddd; border: 1px solid #444; }
  `);

  const btn = document.createElement('button');
  btn.className = 'sve-btn';
  btn.id = 'svc-open';
  btn.title = 'Controller: learn buttons, pads, encoders and keys for entry';
  btn.textContent = 'Controller…';
  SV.addToolbar(btn, { cluster: 'write', order: 110 });
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => (panelOpen() ? closePanel() : openPanel()));

  const panelOpen = () => !!$('svc-panel');
  function openPanel() {
    const el = document.createElement('div');
    el.id = 'svc-panel';
    document.body.appendChild(el);
    ensureListening();
    C.panelPort = C.panelPort || C.lastPort || (E.midi && E.midi.name) || EN.BRIDGE_PORT;
    renderPanel();
  }
  function closePanel() { cancelLearn(); const el = $('svc-panel'); if (el) el.remove(); syncListen(); }

  // Like the other popovers: a press outside the panel (or Esc, below) closes it. A Learn click counts only when the
  // press started on that same button, so a click aimed at something the panel covers never starts MIDI Learn.
  let pressedOn = null;
  document.addEventListener('mousedown', e => {
    const el = $('svc-panel');
    if (!el) return;
    if (el.contains(e.target)) { pressedOn = e.target.closest('[data-k]'); return; }
    pressedOn = null;
    if (!btn.contains(e.target)) closePanel();
  }, true);

  function portList() {
    const s = new Set([...C.ports, ...Object.keys(C.maps), ...EN.midiInputNames()]);
    if (C.panelPort) s.add(C.panelPort);
    s.add(EN.BRIDGE_PORT);
    return [...s];
  }

  function renderPanel() {
    const el = $('svc-panel');
    if (!el) return;
    const port = C.panelPort, user = C.maps[port], def = defaultFor(port), list = bindingsFor(port);
    let html = `<h3>Controller <span style="font-weight:400;color:var(--dim,#999);font-size:12px">MIDI Learn for note entry</span>
      <button class="x" data-k="close" title="Close">✕</button></h3>
      <div class="row">Device <select data-k="port">${portList().map(p => `<option${p === port ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <span style="color:var(--dim,#999)">${user ? 'your map' + (user.base ? ' (from ' + esc(DEFAULTS.find(d => d.id === user.base).name) + ')' : '') : 'default: ' + esc(def.name)}</span></div>
      <div class="row">
        <label><input type="checkbox" data-k="listen"${C.listen ? ' checked' : ''}> Listen while entry is off</label>
        <label>Encoders <select data-k="sens">${[[0.5, 'fine'], [1, 'normal'], [2, 'coarse']].map(([v, n]) => `<option value="${v}"${+C.sens === v ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Load <select data-k="load"><option value="">defaults…</option>${DEFAULTS.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>
        <button data-k="export">Export</button><button data-k="import">Import</button><button data-k="reset" title="Forget your map for this device">Reset</button>
      </div><table>`;
    let group = '';
    ACTIONS.forEach(a => {
      if (a.group !== group) { group = a.group; html += `<tr><td class="g" colspan="3">${esc(group)}</td></tr>`; }
      const bs = list.filter(b => b.action === a.id);
      const learning = C.learn && C.learn.action === a.id;
      html += `<tr data-a="${a.id}"${learning ? ' class="hot"' : ''}><td class="l">${esc(a.label)}</td><td>` +
        bs.map(b => {
          const i = list.indexOf(b), modeSel = b.ctl.type === 'cc' && a.kind === 'enc'
            ? ` <select data-k="mode" data-i="${i}">${['auto', 'abs', 'rel2c', 'rel64', 'relSign', 'incdec'].map(m => `<option value="${m}"${b.ctl.mode === m ? ' selected' : ''}>${MODE[m]}</option>`).join('')}</select>` : '';
          return `<span class="svc-chip${b.verified === false ? ' guess' : ''}" title="${b.verified === false ? 'Default guess — not verified on the device' : ''}${b.gate ? ' Acts only below the instrument\'s range.' : ''}">${esc(ctlText(b.ctl))}${b.verified === false ? ' ?' : ''}${modeSel}<span class="rm" data-k="rm" data-i="${i}" title="Remove">×</span></span>`;
        }).join('') +
        `</td><td class="b"><button data-k="learn"${learning ? ' class="learning"' : ''}>${learning ? 'Cancel' : 'Learn'}</button></td></tr>`;
    });
    html += `</table><div id="svc-io"></div>
      <div class="note">Click <b>Learn</b>, then press a button / pad / key or turn an encoder clockwise. Encoders are detected as absolute,
      relative two's-complement (1 / 127) or 64-centred (65 / 63) automatically; fix it in the chip's menu if needed.
      Dashed chips with "?" are default guesses. Generic keys (A0–B1) act only below the instrument's range, so a bass still plays them.
      <b>Bitwig bridge carries notes only</b>: CC, program change, pitch bend and Start/Stop need Web MIDI (MIDI source Auto or Web MIDI).
      On the Launchkey use standalone (MIDI) mode; its DAW port is never opened. On the Kontrol S88, MIDI mode (Shift+Settings) sends CCs.</div>`;
    el.innerHTML = html;
  }

  document.addEventListener('click', e => {
    const el = $('svc-panel');
    if (!el || !el.contains(e.target)) return;
    const t = e.target.closest('[data-k]');
    if (!t) return;
    const k = t.dataset.k, port = C.panelPort;
    if (k === 'close') closePanel();
    else if (k === 'learn') {
      if (e.detail > 0 && pressedOn !== t) return; // a stray click (pressed elsewhere); keyboard activation has detail 0
      const a = t.closest('tr').dataset.a; if (C.learn && C.learn.action === a) cancelLearn(); else startLearn(a); }
    else if (k === 'rm') { const m = editableMap(port), b = bindingsFor(port)[+t.dataset.i]; m.bindings = m.bindings.filter(x => !(x.action === b.action && JSON.stringify(x.ctl) === JSON.stringify(b.ctl))); saveMaps(); C.st.clear(); renderPanel(); }
    else if (k === 'reset') { delete C.maps[port]; saveMaps(); C.st.clear(); renderPanel(); }
    else if (k === 'export') {
      const json = JSON.stringify({ scoreview: 'controller-maps', version: 1, maps: C.maps }, null, 1);
      $('svc-io').innerHTML = `<textarea readonly>${esc(json)}</textarea><div class="row"><button data-k="download">Save .json</button></div>`;
      $('svc-io').querySelector('textarea').select();
    } else if (k === 'download') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ scoreview: 'controller-maps', version: 1, maps: C.maps }, null, 1)], { type: 'application/json' }));
      a.download = 'scoreview-controller-maps.json';
      a.click();
    } else if (k === 'import') {
      $('svc-io').innerHTML = `<textarea placeholder="Paste exported JSON here (or choose a file)"></textarea>
        <div class="row"><input type="file" accept=".json,application/json" data-k="file"><button data-k="doimport">Import</button></div>`;
    } else if (k === 'doimport') importJson($('svc-io').querySelector('textarea').value);
  });
  document.addEventListener('change', e => {
    const el = $('svc-panel');
    if (!el || !el.contains(e.target)) return;
    const t = e.target, k = t.dataset.k;
    if (k === 'port') { C.panelPort = t.value; cancelLearn(); renderPanel(); }
    else if (k === 'listen') { C.listen = t.checked; store.set('listen', C.listen); syncListen(); }
    else if (k === 'sens') { C.sens = +t.value; store.set('sens', C.sens); }
    else if (k === 'load' && t.value) { const d = DEFAULTS.find(x => x.id === t.value); C.maps[C.panelPort] = { base: d.id, bindings: clone(d.bindings) }; saveMaps(); C.st.clear(); renderPanel(); }
    else if (k === 'mode') { const m = editableMap(C.panelPort), b = m.bindings[+t.dataset.i]; if (b) { b.ctl.mode = t.value; saveMaps(); C.st.clear(); } }
    else if (k === 'file' && t.files[0]) t.files[0].text().then(importJson);
  });
  function importJson(text) {
    try {
      const j = JSON.parse(text), maps = j && j.maps;
      if (!maps || typeof maps !== 'object') throw new Error('no "maps"');
      Object.entries(maps).forEach(([p, m]) => {
        if (!m || !Array.isArray(m.bindings)) return;
        C.maps[p] = { base: m.base || null, bindings: m.bindings.filter(b => b && ACT[b.action] && b.ctl && b.ctl.type) };
      });
      saveMaps(); C.st.clear(); renderPanel();
      SV.flash('Controller maps imported (' + Object.keys(maps).length + ' device' + (Object.keys(maps).length === 1 ? '' : 's') + ')');
    } catch (err) { SV.flash('Import failed: ' + err.message); }
  }

  // Esc cancels a running Learn first, then closes the panel (also while a field in the panel has focus).
  function escape() {
    if (C.learn) cancelLearn(); else if (panelOpen()) closePanel(); else return false;
    return true;
  }
  if (SV.shortcuts) SV.shortcuts.register({ keys: 'Escape', owner: 'controller', desc: 'cancel Learn, then close the panel', when: 'Controller panel' });
  SV.hooks.keydown.unshift(e => e.key === 'Escape' && escape()); // before entry's Esc (leave entry)
  document.addEventListener('keydown', e => {
    const el = $('svc-panel'), tag = e.target.tagName;
    if (e.key !== 'Escape' || !el || !el.contains(e.target) || !(tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA')) return;
    if (escape()) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('keydown', e => { C.keyShift = e.shiftKey; }, true);
  window.addEventListener('keyup', e => { C.keyShift = e.shiftKey; }, true);

  EN.rawHooks.push(raw);
  if (C.listen) window.addEventListener('sv-ready', () => syncListen());

  SV.addHelp('<b>Controller…</b> MIDI Learn: buttons, pads, encoders, pitch bend and the lowest keys (A0–B1) drive entry — durations, rest, tie, caret, undo, pitch.');

  SV.controller = {
    state: C, actions: ACTIONS, defaults: DEFAULTS, bindingsFor, ctlText, classify,
    learn: startLearn, cancelLearn, open: openPanel, close: closePanel, importJson,
    // Test hook: a raw MIDI message from a named input, as Web MIDI would deliver it (goes through entry.js).
    _raw: (data, port, t) => EN._midi(data, t, port || 'Test MIDI'),
  };
})();
