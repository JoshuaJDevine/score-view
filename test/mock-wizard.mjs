// Mock of the extension's New Score wizard job (NewScoreWizard.java): GET /api/wizard (status, ?caps),
// POST /api/wizard (plan text; ?cancel). Steps run on a timer; created tracks are appended to the mock's
// track list so the page sees them. Failure injection: a device id containing "FAIL" is not confirmed,
// a "file:" device whose path contains "MISSING" is "file not found", w.groupAction = false (srv.wizard.groupAction)
// leaves groups unavailable. Starter settings (option tempo= / meter=, marker lines) change the mock's tempo
// (play.tempo), meter (data.num/den) and cue markers (data.markers); w.playing = true makes markers skip.
export function createMockWizard({ data, play = {}, bump, stepMs = 15, groupAction = true } = {}) {
  const w = { stepMs, groupAction, state: 'idle', kind: '', message: '', step: 0, steps: 0, tracks: [], groups: [], errors: [], notes: [],
              settings: [], plans: [], swaps: [], cancel: false, timer: null, playing: false };

  const fields = line => {
    const out = {};
    line.split('\t').slice(1).forEach(p => {
      const eq = p.indexOf('=');
      if (eq > 0) (out[p.slice(0, eq)] ||= []).push(p.slice(eq + 1));
    });
    return out;
  };
  const parseDev = d => {
    const c = d.indexOf(':'), rest = d.slice(c + 1), bar = rest.indexOf('|');
    return { kind: d.slice(0, c), id: bar >= 0 ? rest.slice(0, bar) : rest, label: bar >= 0 ? rest.slice(bar + 1) : rest };
  };
  const devProblem = d => d.kind === 'file' && /MISSING/.test(d.id) ? 'file not found: ' + d.id
    : /FAIL/.test(d.id) ? 'not confirmed by Bitwig (no new device in the chain)' : null;

  function addTrack(name) {
    const tracks = data.tracks;
    tracks.push({ name, index: tracks.length, group: false, sel: false, solo: false, mute: false });
    bump();
  }

  function status() {
    return { state: w.state, kind: w.kind, message: w.message, step: w.step, steps: w.steps,
             tracks: w.tracks.map(({ name, group, created, grouped, groupMsg, devices }) => ({ name, group, created, grouped, groupMsg, devices })),
             groups: w.groups.map(({ name, ok, msg }) => ({ name, ok, msg })), settings: w.settings, errors: w.errors, notes: w.notes };
  }

  /** Starter settings, as NewScoreWizard.planSettings does them. */
  function planSettings(lines, queue) {
    let tempo = 0, meter = null;
    lines.filter(l => l.startsWith('option\t')).forEach(l => {
      const f = fields(l);
      if (f.tempo) tempo = +f.tempo[0];
      if (f.meter) { const [n, d] = f.meter[0].split('/').map(Number); if (n > 0 && d > 0 && !(d & (d - 1))) meter = [n, d]; }
    });
    const set = (ok, text) => { w.settings.push({ ok, text }); if (!ok) w.errors.push(text); };
    if (tempo >= 20 && tempo <= 666) queue.push([`Setting tempo to ${tempo} BPM`, () => { play.tempo = tempo; set(true, `Tempo ${tempo} BPM`); }]);
    if (meter) queue.push([`Setting time signature ${meter[0]}/${meter[1]}`, () => {
      data.num = meter[0]; data.den = meter[1]; bump(); set(true, `Time signature ${meter[0]}/${meter[1]}`);
    }]);
    lines.filter(l => l.startsWith('marker\t')).forEach(l => {
      const f = fields(l), name = (f.name || ['Section'])[0], bar = Math.max(1, +(f.bar || [1])[0] | 0);
      queue.push([`Adding marker ${name}`, () => {
        const what = `Marker "${name}" at bar ${bar}`;
        if (w.playing) return set(false, what + ': skipped, stop playback in Bitwig first.');
        const beat = (bar - 1) * (data.num || 4) * 4 / (data.den || 4);
        const old = (data.markers ||= []).find(m => Math.abs(m.beat - beat) < 1e-3);
        if (old) return set(true, `${what}: kept the existing marker "${old.name}"`);
        data.markers.push({ name, beat });
        data.markers.sort((a, b) => a.beat - b.beat);
        bump();
        set(true, what);
      }]);
    });
  }

  function start(plan) {
    Object.assign(w, { state: 'running', message: 'Starting', step: 0, steps: 0, tracks: [], groups: [], settings: [], errors: [], notes: [], cancel: false });
    w.plans.push(plan);
    const queue = [];
    const lines = plan.split('\n').filter(l => l.trim());
    if (!lines.some(l => l.startsWith('swap\t'))) planSettings(lines, queue);
    const swap = lines.find(l => l.startsWith('swap\t'));
    if (swap) {
      w.kind = 'swap';
      const f = fields(swap);
      const name = (f.name || [''])[0], d = parseDev((f.dev || [''])[0]);
      const t = { name, group: null, created: true, grouped: false, groupMsg: '', devices: [] };
      w.tracks.push(t);
      queue.push(['Finding ' + name, () => { if (!data.tracks.some(x => x.name === name)) throw new Error('Track ' + name + ' not found'); }]);
      queue.push(['Loading ' + d.label, () => {
        const p = devProblem(d);
        t.devices.push({ ok: !p, text: d.label + (p ? ': ' + p : '') });
        if (p) w.errors.push(name + ': ' + d.label + ': ' + p);
        else w.swaps.push({ track: name, index: +(f.track || [-1])[0], lib: d, mode: (f.mode || ['disable'])[0] });
      }]);
    } else {
      w.kind = 'create';
      let prevGroup = null, run = null;
      lines.filter(l => l.startsWith('track\t')).forEach(l => {
        const f = fields(l);
        const t = { name: (f.name || ['Instrument'])[0], group: (f.group || [null])[0], created: false, grouped: false, groupMsg: '', devices: [] };
        w.tracks.push(t);
        if (t.group && t.group !== prevGroup) {
          run = { name: t.group, ok: false, msg: '' };
          w.groups.push(run);
          const g = run;
          queue.push(['Creating track ' + t.name, () => { addTrack(t.name); t.created = true; }]);
          queue.push(['Grouping ' + g.name, () => {
            if (!w.groupAction) { g.msg = 'Bitwig\'s "Group" action was not found; tracks left ungrouped.'; t.groupMsg = g.msg; return; }
            g.ok = true; t.grouped = true;
            const tr = data.tracks.find(x => x.name === t.name);
            data.tracks.splice(data.tracks.indexOf(tr), 0, { name: g.name, index: -1, group: true, sel: false, solo: false, mute: false });
            data.tracks.forEach((x, i) => { x.index = i; });
            bump();
          }]);
        } else {
          const g = t.group ? run : null;
          queue.push(['Creating track ' + t.name, () => { addTrack(t.name); t.created = true; }]);
          if (g) queue.push(['Moving ' + t.name + ' into ' + g.name, () => {
            if (g.ok) t.grouped = true; else t.groupMsg = 'Group not available; left ungrouped.';
          }]);
        }
        if (!t.group) run = null;
        prevGroup = t.group;
        (f.dev || []).map(parseDev).forEach(d => queue.push(['Loading ' + d.label + ' on ' + t.name, () => {
          const p = devProblem(d);
          t.devices.push({ ok: !p, text: d.label + (p ? ': ' + p : '') });
          if (p) w.errors.push(t.name + ': ' + d.label + ': ' + p);
        }]));
      });
    }
    w.steps = queue.length;
    const tick = () => {
      if (w.cancel) { w.notes.push('Cancelled by the user.'); return finish('cancelled'); }
      const s = queue.shift();
      if (!s) return finish();
      w.step++;
      w.message = s[0];
      try { s[1](); } catch (e) { w.errors.push(e.message); queue.length = 0; }
      w.timer = setTimeout(tick, w.stepMs);
    };
    w.timer = setTimeout(tick, w.stepMs);
  }

  function finish(forced) {
    w.timer = null;
    if (!w.groupAction) w.groups.forEach(g => { if (!g.ok) w.errors.push(g.name + ': ' + g.msg); });
    const made = w.tracks.filter(t => t.created).length;
    w.state = forced || (w.errors.length ? 'error' : 'done');
    w.message = w.kind === 'swap' ? (w.errors.length ? 'Swap incomplete' : 'Library swapped')
      : (forced ? 'Cancelled: ' : '') + `${made} of ${w.tracks.length} tracks created` + (w.errors.length ? `, ${w.errors.length} problems` : '');
  }

  function handle(req, res, url, json) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        if (url.searchParams.has('cancel')) { w.cancel = true; return json({ ok: true }); }
        if (w.state === 'running') return json({ ok: false, error: 'A wizard job is already running.' });
        start(body);
        json({ ok: true });
      });
      return;
    }
    if (url.searchParams.has('caps')) return json({ groupAction: w.groupAction ? { id: 'group', name: 'Group' } : null, headerFocus: null, bank: 256, tracks: data.tracks.length });
    json(status());
  }

  return { w, handle, status, close: () => { if (w.timer) clearTimeout(w.timer); } };
}
