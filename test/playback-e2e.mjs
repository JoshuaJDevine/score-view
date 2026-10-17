// End-to-end test of web/features/playback.js against the mock server:
// rehearsal marks, play from a bar number (Clip and Score modes), Space, L / Shift+L loops, solo/mute buttons.
//   PORT=8872 node test/playback-e2e.mjs
import assert from 'assert';
import path from 'path';
import { withPage, ROOT } from './lib.mjs';

const PORT = Number(process.env.PORT || 8872);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastEdit = (srv, re) => srv.edits.filter(e => re.test(e)).pop();

// Bar number (measure id) holding each rendered rehearsal mark, with its text.
const rehBars = page => page.$$eval('#paper g.reh', els => els.map(el => ({
  bar: parseInt(el.closest('g.measure').id.slice(1), 10), text: el.textContent.trim() })));

async function clickBarNumber(page, n) {
  const box = await page.$eval(`#m${n} > g.mNum`, el => { el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.click(box.x, box.y);
}

// ---------------------------------------------------------------- Clip mode
await withPage({ port: PORT, mode: 'clip' }, async ({ page, srv, errors }) => {
  // Clip position unknown at first (Bitwig doesn't report it): no marks yet, and play-from explains why.
  assert.equal((await rehBars(page)).length, 0, 'no marks before the clip position is known');

  await page.keyboard.press('Space');
  await sleep(300);
  assert.equal(lastEdit(srv, /^(play|stop)$/), 'play', 'Space sends play');
  // Playing reveals the clip's arranger position (mock clip at beat 0) -> marks at bars 1, 9, 17.
  await page.waitForFunction(() => document.querySelectorAll('#paper g.reh').length === 3, { timeout: 5000 });
  assert.deepEqual(await rehBars(page), [{ bar: 1, text: 'Intro' }, { bar: 9, text: 'A' }, { bar: 17, text: 'B' }]);
  await page.waitForFunction(() => /bar \d+ beat \d/.test(document.getElementById('svpbPos').textContent), { timeout: 2000 });

  await page.keyboard.press('Space');
  await sleep(200);
  assert.equal(lastEdit(srv, /^(play|stop)$/), 'stop', 'Space again sends stop');

  await clickBarNumber(page, 5);
  await sleep(200);
  assert.equal(lastEdit(srv, /^playFrom/), 'playFrom 16', 'bar 5 -> beat 16');
  assert.equal(srv.state.play.playing, true);

  // Alt+click inside bar 10 also plays from there.
  const b10 = await page.$eval('#m10 > g.staff', el => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.keyboard.down('Alt'); await page.mouse.click(b10.x, b10.y); await page.keyboard.up('Alt');
  await sleep(200);
  assert.equal(lastEdit(srv, /^playFrom/), 'playFrom 36', 'Alt+click bar 10 -> beat 36');

  // L with a selected note loops that note's bar(s).
  const note = await page.evaluate(() => {
    const t = SV.state.render.timeline.find(e => SV.isLive(e.srcId) && e.start >= 20);
    const b = document.getElementById(t.svgId).getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, start: t.start, end: t.end };
  });
  await page.mouse.click(note.x, note.y);
  await page.keyboard.press('l');
  await sleep(200);
  const bar0 = Math.floor(note.start / 4) * 4, bar1 = Math.ceil(note.end / 4 - 1e-6) * 4;
  assert.equal(lastEdit(srv, /^loop/), `loop ${bar0} ${Math.max(4, bar1 - bar0)}`, 'L loops the selected bars');
  assert.equal(srv.state.play.loop.on, true);
  await page.waitForFunction(() => document.getElementById('svpbLoop').classList.contains('on'), { timeout: 2000 });
  await page.screenshot({ path: 'build/out-playback-clip.png' });
  await page.keyboard.down('Shift'); await page.keyboard.press('L'); await page.keyboard.up('Shift');
  await sleep(200);
  assert.equal(lastEdit(srv, /^loop/), 'loopOff', 'Shift+L sends loopOff');

  // Solo / mute buttons on the staff label ("Violin 1" is track index 2 in the fixture).
  const zone = await page.$('#paper .svpb-sm');
  assert(zone, 'solo/mute zone rendered');
  assert.equal(await zone.evaluate(z => z.dataset.track), '2');
  const zb = await zone.boundingBox();
  await page.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2);
  await page.click('#paper .svpb-sm button[data-op=solo]');
  await sleep(300);
  assert.equal(lastEdit(srv, /^solo/), 'solo 2 1');
  await page.click('#paper .svpb-sm button[data-op=mute]');
  await sleep(300);
  assert.equal(lastEdit(srv, /^mute/), 'mute 2 1');
  assert.equal(srv.state.data.tracks[2].solo, true);
  await page.waitForFunction(() => document.querySelector('#paper .svpb-sm button[data-op=mute]').classList.contains('on'), { timeout: 3000 });
  await page.screenshot({ path: 'build/out-playback-solo.png', clip: { x: 0, y: 60, width: 700, height: 300 } });
  await page.click('#paper .svpb-sm button[data-op=solo]');
  await sleep(200);
  assert.equal(lastEdit(srv, /^solo/), 'solo 2 0', 'solo toggles off');
  assert.deepEqual(errors, []);
  console.log('clip mode OK; edits:', srv.edits.filter(e => !/^(select|audition)/.test(e)).join(' | '));
});

// ---------------------------------------------------------------- Score mode (DAWproject markers)
// ---------------------------------------------------------------- Score mode (DAWproject markers)
await withPage({ port: PORT + 1, mode: 'score' }, async ({ page, srv, errors }) => {
  // The fixture's live "Violin 1" clip is found in the Mega Man 2 export at bar 25 (beat 96).
  srv.state.clipOffset = 96;
  srv.setMarkers([]);          // no Bitwig cue markers -> the DAWproject's markers are used
  const input = await page.$('#fileInput');
  await input.uploadFile(path.join(ROOT, 'test/fixtures/megaman2.dawproject'));
  await page.waitForFunction(() => SV.state.base, { timeout: 20000 });
  assert.equal(await page.evaluate(() => SV.state.base.markers.length), 15);
  await page.evaluate(() => { SV.togglePin(SV.state.base.parts[0].name); SV.togglePin(SV.state.base.parts[2].name); });

  // "Clip bars" range: bars 25-49 of the arrangement are rendered (measureOffset 24).
  await page.waitForFunction(() => SV.state.render && SV.state.render.measureOffset === 24 && document.querySelector('#m30 > g.mNum'), { timeout: 20000 });
  assert.deepEqual(await rehBars(page), [{ bar: 26, text: 'A`' }, { bar: 41, text: 'B' }, { bar: 49, text: "B'" }]);
  await clickBarNumber(page, 30);
  await sleep(300);
  assert.equal(lastEdit(srv, /^playFrom/), 'playFrom 116', 'clip-bars range: bar 30 -> beat 116');
  assert.equal(srv.state.play.playing, true);
  await page.keyboard.press('Space');
  await sleep(200);
  assert.equal(lastEdit(srv, /^(play|stop)$/), 'stop', 'Space stops');
  await page.evaluate(() => { document.getElementById('main').scrollTop = 0; });
  await page.screenshot({ path: 'build/out-playback-score.png' });

  // Live cue markers win over the export's.
  srv.setMarkers([{ name: 'Verse', beat: 100 }, { name: 'Chorus', beat: 132 }]);
  await page.waitForFunction(() => document.querySelectorAll('#paper g.reh').length === 2, { timeout: 5000 });
  assert.deepEqual(await rehBars(page), [{ bar: 26, text: 'Verse' }, { bar: 34, text: 'Chorus' }]);

  // Whole song: bar numbers are arranger bars from 1.
  srv.setMarkers([]);
  await page.click('#rangeSeg button[data-range=all]');
  await page.waitForFunction(() => SV.state.render && SV.state.render.measureOffset === 0 && document.querySelector('#m18 > g.mNum'), { timeout: 20000 });
  assert.equal((await rehBars(page)).length, 14, 'all export markers before the end (beat 512 is the end)');
  await clickBarNumber(page, 18);
  await sleep(200);
  assert.equal(lastEdit(srv, /^playFrom/), 'playFrom 68', 'whole song: bar 18 -> beat 68');
  assert.deepEqual(errors, []);
  console.log('score mode OK; edits:', srv.edits.filter(e => !/^(select|audition)/.test(e)).join(' | '));
});
console.log('playback e2e OK');
