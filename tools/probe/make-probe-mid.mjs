// Writes probe-cc.mid: format 0, 480 TPQ, 120 bpm, 4 bars.
// Bar 1-2: C4 held 8 beats, CC1 ramps 20->120, CC11 ramps 60->127 (hairpin on a held note).
// Bar 3:   E4 held 4 beats with poly aftertouch ramp 0->127 (per-note pressure curve?).
// Bar 4:   G4 held 4 beats with channel pressure ramp 127->0 and CC21 ramp 0->100.
import fs from 'fs';
const TPQ = 480, ev = [];
const at = (beat, bytes) => ev.push({ t: Math.round(beat * TPQ), bytes });
const ramp = (b0, b1, v0, v1, mk) => { for (let b = b0; b <= b1 + 1e-9; b += 0.125) at(b, mk(Math.round(v0 + (v1 - v0) * (b - b0) / (b1 - b0)))); };
at(0, [0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20]);           // tempo 120
at(0, [0xFF, 0x58, 0x04, 4, 2, 24, 8]);                // 4/4
at(0, [0x90, 60, 100]); at(8, [0x80, 60, 0]);
ramp(0, 7.875, 20, 120, v => [0xB0, 1, v]);
ramp(0, 7.875, 60, 127, v => [0xB0, 11, v]);
at(8, [0x90, 64, 100]); at(12, [0x80, 64, 0]);
ramp(8, 11.875, 0, 127, v => [0xA0, 64, v]);
at(12, [0x90, 67, 100]); at(16, [0x80, 67, 0]);
ramp(12, 15.875, 127, 0, v => [0xD0, v]);
ramp(12, 15.875, 0, 100, v => [0xB0, 21, v]);
ev.forEach((e, i) => e.i = i); ev.sort((a, b) => (a.t - b.t) || (((b.bytes[0] & 0xF0) === 0x80) - ((a.bytes[0] & 0xF0) === 0x80)) || (a.i - b.i));
const vlq = n => { const o = [n & 0x7F]; while ((n >>= 7)) o.unshift((n & 0x7F) | 0x80); return o; };
let last = 0; const body = [];
for (const e of ev) { body.push(...vlq(e.t - last), ...e.bytes); last = e.t; }
body.push(0, 0xFF, 0x2F, 0x00);
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const out = Buffer.from([0x4D,0x54,0x68,0x64, ...u32(6), 0,0, 0,1, TPQ >> 8, TPQ & 255, 0x4D,0x54,0x72,0x6B, ...u32(body.length), ...body]);
fs.writeFileSync(process.argv[2], out); console.log('wrote', process.argv[2], out.length, 'bytes,', ev.length, 'events');
