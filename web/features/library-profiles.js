// Feature module: library profiles — which controls a dynamics level curve drives on each library (Render dynamics,
// features/dynamics.js). The table itself is data: web/features/library-profiles.json, which the extension also reads
// from its jar (src/claude/scoreview/CurvePlayer.java creates a Bitwig Parameter for every target in init()).
// Add a library by appending a profile there; see docs/features/library-profiles.md.
//
// Page: SV.libraryProfiles = { ready (Promise), list(), byId(id), detect(info), valueAt(target, level), dual(profile) }.
// Node: require('web/features/library-profiles.js') exposes the same pure functions plus load() (reads the JSON).
(function (root) {
  'use strict';

  let table = { profiles: [] };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function setTable(t) { table = t && Array.isArray(t.profiles) ? t : { profiles: [] }; return table; }
  const list = () => table.profiles.slice();
  const byId = id => table.profiles.find(p => p.id === id) || null;
  const fallback = () => table.profiles.find(p => p.fallback) || { id: 'velocity', name: 'Velocity only', fallback: true, targets: [] };

  /** Does a device / plug-in name belong to this profile? (whole words, case-insensitive) */
  function nameMatches(profile, name) {
    const n = ' ' + norm(name) + ' ';
    return ((profile.match && profile.match.names) || []).some(m => m && n.includes(' ' + norm(m) + ' '));
  }

  /**
   * The profile for a track: info = { override (profile id), pluginId (VST3 id), deviceNames [Bitwig device names on the
   * track], pluginName (DAWproject export), trackName }. Returns { profile, how: 'override'|'plug-in id'|'device'|
   * 'export'|'track name'|'fallback' }. Plug-in ids win over names; a track name is the last guess.
   */
  function detect(info = {}) {
    const ps = table.profiles.filter(p => !p.fallback);
    if (info.override && byId(info.override)) return { profile: byId(info.override), how: 'override' };
    const id = String(info.pluginId || '').toUpperCase();
    if (id) { const p = ps.find(q => ((q.match && q.match.vst3) || []).some(v => v.toUpperCase() === id)); if (p) return { profile: p, how: 'plug-in id' }; }
    // device names: a vst3 profile's plug-in name is more specific than the generic Kontakt/Spitfire one, so it wins
    for (const name of info.deviceNames || []) {
      const p = ps.find(q => q.match && q.match.vst3 && nameMatches(q, name)) || ps.find(q => nameMatches(q, name));
      if (p) return { profile: p, how: 'device' };
    }
    if (info.pluginName) { const p = ps.find(q => nameMatches(q, info.pluginName)); if (p) return { profile: p, how: 'export' }; }
    if (info.trackName) { const p = ps.find(q => q.match && q.match.vst3 && nameMatches(q, info.trackName)); if (p) return { profile: p, how: 'track name' }; }
    return { profile: fallback(), how: 'fallback' };
  }

  /** A target's control value (0..1) for a level (0..1): min + (max - min) * level^gamma. */
  function valueAt(target, level) {
    const l = Math.max(0, Math.min(1, level));
    const lo = target.min != null ? target.min : 0, hi = target.max != null ? target.max : 1;
    return lo + (hi - lo) * Math.pow(l, target.gamma || 1);
  }
  /** Two controls moving together (Spitfire-style dynamics + expression). */
  const dual = profile => !!profile && (profile.targets || []).length >= 2;
  /** Short description of a target for the UI: "Timbre (VST3 48)", "CC1 Dynamics (MIDI CC 1)", ... */
  const describe = t => t.label + (t.kind === 'vst3' ? ` (VST3 ${t.param})` : t.kind === 'cc' ? ` (MIDI CC ${t.cc})` : t.kind === 'remote' ? ` (remote ${t.index + 1})` : '');

  const api = { setTable, list, byId, detect, valueAt, dual, describe, nameMatches, fallback };

  if (typeof module !== 'undefined' && module.exports) {
    api.load = (file) => {
      const fs = require('fs'), path = require('path');
      return setTable(JSON.parse(fs.readFileSync(file || path.join(__dirname, 'library-profiles.json'), 'utf8')));
    };
    api.load();
    module.exports = api;
    return;
  }
  const SV = root.SV;
  if (!SV) return;
  api.ready = fetch('features/library-profiles.json', { cache: 'no-store' }).then(r => r.json()).then(setTable)
    .catch(e => { console.warn('library profiles not loaded', e); return table; });
  SV.libraryProfiles = api;
})(typeof window !== 'undefined' ? window : globalThis);
