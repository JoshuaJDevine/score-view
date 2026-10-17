// Tiny Standard MIDI File writer for tests (import-test, import-e2e).
//   midiFile(format, ppq, [track([[tick, ...bytes], ...]), ...])   bytes may omit the status byte (running status)
//   notesTrack(name, ppq, [{start, dur, pitch, vel, ch}])          note list in beats -> track
export const vlq = n => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
export const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export const ascii = s => [...s].map(c => c.charCodeAt(0));
export const meta = (type, bytes) => [0xff, type, ...vlq(bytes.length), ...bytes];

export function track(events) {
  const data = [];
  let last = 0;
  events.slice().sort((a, b) => a[0] - b[0]).forEach(([t, ...bytes]) => { data.push(...vlq(t - last), ...bytes); last = t; });
  data.push(0, 0xff, 0x2f, 0);
  return [...ascii('MTrk'), ...u32(data.length), ...data];
}

export function midiFile(format, division, tracks) {
  return new Uint8Array([...ascii('MThd'), ...u32(6), 0, format, 0, tracks.length, (division >> 8) & 255, division & 255, ...tracks.flat()]);
}

export function notesTrack(name, ppq, notes) {
  const ev = [[0, ...meta(0x03, ascii(name))]];
  notes.forEach(n => {
    const ch = n.ch || 0;
    ev.push([Math.round(n.start * ppq), 0x90 | ch, n.pitch, n.vel || 100]);
    ev.push([Math.round((n.start + n.dur) * ppq), 0x80 | ch, n.pitch, 0]);
  });
  // note-offs before note-ons at the same tick (track() keeps this order)
  return track(ev.sort((a, b) => a[0] - b[0] || (a[1] & 0xf0) - (b[1] & 0xf0)));
}
