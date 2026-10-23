// GUI slice 1 against the mock: the compact app bar (one row, File ▾ / View ▾, Read ▾), the header-layout preference
// (classic puts every moved element back), the status bar readout, the command palette (Ctrl+K / Ctrl+J), the "?"
// shortcut sheet and the toast stack with its history.
// SV_SHOTS=<dir> also writes screenshots there.
import assert from 'assert';
import fs from 'fs';
import { withPage } from './lib.mjs';
import { SEL, MENUS, openMenu, clickIn } from './selectors.mjs';

const PORT = Number(process.env.PORT || 8874);
const SHOTS = process.env.SV_SHOTS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/gui-${name}.png` }); } };
const visible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== 'hidden'; }, sel);
const inside = (page, sel, container) => page.evaluate((s, c) => { const e = document.querySelector(s); return !!e && !!e.closest(c); }, sel, container);
async function ctrl(page, key) { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); }

await withPage({ port: PORT, width: 1440, height: 900, mode: 'score' }, async ({ page, srv, errors }) => {
  await sleep(300);
  // ---- compact app bar: one row, ≈100 px of chrome with the feature bar and the status bar
  const m = await page.evaluate(() => {
    const h = document.querySelector('header');
    const tops = [...h.children].filter(c => c.offsetWidth).map(c => Math.round(c.getBoundingClientRect().top));
    const seen = {}; document.querySelectorAll('[id]').forEach(el => { seen[el.id] = (seen[el.id] || 0) + 1; });
    return { layout: document.documentElement.dataset.header, header: h.getBoundingClientRect().height,
      chrome: innerHeight - document.querySelector('main').getBoundingClientRect().height,
      rows: new Set(tops.map(t => Math.round(t / 8))).size, dups: Object.keys(seen).filter(k => seen[k] > 1),
      wraps: getComputedStyle(h).flexWrap };
  });
  assert.equal(m.layout, 'compact', 'compact header by default');
  assert.equal(m.wraps, 'nowrap');
  assert.equal(m.rows, 1, 'the app bar is one row');
  assert.ok(m.header <= 42, 'app bar height ' + m.header);
  assert.ok(m.chrome <= 106, 'header + feature bar + status bar = ' + m.chrome + ' px');
  assert.deepEqual(m.dups, [], 'duplicate ids');
  for (const id of ['#keySel', '#gridSel', '#layoutSeg', '#zoom', '#dot', '#renderTime', '#helpToggle'])
    assert.ok(await inside(page, id, SEL.statusBar), id + ' in the status bar');
  for (const id of ['#simplify', '#follow', '#condense', '#hideKs', '#audition', '#sviNames', '#sviTransposed', '#sviRanges', '#svaDyn', '#svpbMarks', '#svpSel'])
    assert.ok(await inside(page, id, MENUS.view.panel), id + ' in View ▾');
  for (const id of ['#freshBtn', '#svImportBtn', '#mxExport', '#svpPrintBtn', '#svwOpen'])
    assert.ok(await inside(page, id, MENUS.file.panel), id + ' in File ▾');
  assert.equal(await page.$(MENUS.read.button), null, 'no empty Read ▾ (exact clip lengths are automatic now)');
  assert.ok(await visible(page, '#svarRead'), 'Read project stays in the app bar');
  await shot(page, 'compact');

  // View ▾: a checkbox keeps the menu open, Esc closes it; a click outside closes it too
  await openMenu(page, 'view');
  const simplify0 = await page.$eval('#simplify', e => e.checked);
  await page.click('#simplify');
  assert.equal(await page.$eval('#simplify', e => e.checked), !simplify0, 'the checkbox toggled');
  assert.ok(await visible(page, MENUS.view.panel), 'View ▾ stays open after a checkbox');
  await shot(page, 'view-menu');
  await page.keyboard.press('Escape');
  assert.ok(!await visible(page, MENUS.view.panel), 'Esc closes View ▾');
  await page.click('#simplify').catch(() => {}); // hidden now: not clickable
  assert.equal(await page.$eval('#simplify', e => e.checked), !simplify0, 'a closed menu takes no clicks');
  await clickIn(page, '#simplify'); // opens View ▾ and clicks
  assert.equal(await page.$eval('#simplify', e => e.checked), simplify0, 'clickIn reveals and clicks');
  await page.mouse.click(700, 500);
  assert.ok(!await visible(page, MENUS.view.panel), 'a click outside closes View ▾');
  // File ▾: a button runs and closes the menu
  await openMenu(page, 'file');
  await page.click('#svImportBtn');
  await sleep(100);
  assert.ok(!await visible(page, MENUS.file.panel), 'File ▾ closes after a command');
  await page.keyboard.press('Escape'); // the import dialog
  await page.evaluate(() => { const d = document.querySelector('.svi-dlg, #sviDlg'); if (d) d.remove(); });
  // the compact rules hide only the shortcut footer and style only the app bar: a dialog's own <header>/<footer> stay
  await clickIn(page, '#svwOpen');
  await page.waitForSelector('.svw-dlg');
  assert.ok(await visible(page, '.svw-dlg footer') && await visible(page, '.svw-dlg [data-act="create"]'), 'New Score dialog footer visible');
  assert.notEqual(await page.$eval('.svw-dlg header', e => getComputedStyle(e).minHeight), '38px', 'dialog header not styled as the app bar');
  await page.click('.svw-dlg [data-act="close"]');
  await page.waitForFunction(() => !document.querySelector('.svw-dlg'), { timeout: 3000 });

  // ---- header layout preference: classic restores the old rows, compact moves them again
  await openMenu(page, 'view');
  await page.click(SEL.header('classic'));
  const classic = await page.evaluate(() => ({
    layout: document.documentElement.dataset.header,
    saved: JSON.parse(localStorage.getItem('scoreview.layout.header')),
    simplifyInHeader: !!document.querySelector('header .group #simplify'),
    keyInHeader: !!document.querySelector('header .group #keySel'),

    importInBar: !!document.querySelector('#featureBar .svl-cluster[data-k="file"] #svImportBtn'),
    dotInStatus: !!document.querySelector('#status #dot'),
    help: !!document.querySelector('footer #helpToggle'),
    rows: new Set([...document.querySelector('header').children].filter(c => c.offsetWidth).map(c => Math.round(c.getBoundingClientRect().top / 8))).size,
  }));
  assert.equal(classic.layout, 'classic');
  assert.equal(classic.saved, 'classic', 'saved as scoreview.layout.header');
  assert.ok(classic.simplifyInHeader && classic.keyInHeader && classic.importInBar && classic.dotInStatus && classic.help,
    'classic puts every element back: ' + JSON.stringify(classic));
  assert.ok(classic.rows > 1, 'classic header has stacked rows');
  await shot(page, 'classic');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#paper svg'), { timeout: 30000 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.header), 'classic', 'the preference survives a reload');
  await page.evaluate(() => SV.layout.setHeader('compact'));
  assert.ok(await inside(page, '#simplify', MENUS.view.panel) && await inside(page, '#keySel', SEL.statusBar), 'compact again');

  // ---- status bar: the selection readout and the entry duration
  assert.match(await page.$eval(SEL.selectionInfo, e => e.textContent), /nothing selected/i);
  const noteId = await page.$eval('#paper g.note[id^="nL"]', e => e.id);
  await page.click('#' + noteId);
  await page.waitForFunction(s => /^1 note · /.test(document.querySelector(s).textContent), { timeout: 3000 }, SEL.selectionInfo);
  const one = await page.$eval(SEL.selectionInfo, e => e.textContent);
  assert.match(one, /^1 note · .+ · bar \d+ beat [\d.]+ · [A-G][♯♭]?\d · /, one);
  await ctrl(page, 'a');
  await page.waitForFunction(s => /^\d+ notes · /.test(document.querySelector(s).textContent), { timeout: 3000 }, SEL.selectionInfo);
  assert.match(await page.$eval(SEL.selectionInfo, e => e.textContent), / – bar \d+ beat/, 'a range of bars for many notes');
  await page.keyboard.press('Escape');
  assert.ok(await page.$eval(SEL.entryInfo, e => e.hidden), 'no entry readout while entry is off');
  await page.evaluate(() => SV.entry.toggle(true));
  await page.waitForFunction(s => !document.querySelector(s).hidden, { timeout: 3000 }, SEL.entryInfo);
  assert.match(await page.$eval(SEL.entryInfo, e => e.textContent), /^Entry · .*(quarter|8th|16th|half|whole)/);
  await page.evaluate(() => SV.entry.toggle(false));
  await page.waitForFunction(s => document.querySelector(s).hidden, { timeout: 3000 }, SEL.entryInfo);

  // ---- command palette
  await page.click(SEL.main);
  await ctrl(page, 'k');
  await page.waitForSelector(SEL.palette.input, { visible: true });
  assert.ok(await page.evaluate(s => document.activeElement === document.querySelector(s), SEL.palette.input), 'focus in the input');
  const kinds = await page.evaluate(() => [...new Set(SV.palette.commands().map(c => c.kind))].sort());
  for (const k of ['button', 'checkbox', 'option', 'key', 'app']) assert.ok(kinds.includes(k), 'palette offers ' + k + ' commands: ' + kinds);
  await page.keyboard.type('hide keyswitches');
  const first = await page.$eval(SEL.palette.selected, e => e.textContent);
  assert.match(first, /Hide keyswitches/);
  const ks0 = await page.$eval('#hideKs', e => e.checked);
  await page.keyboard.press('Enter');
  await page.waitForFunction(s => !document.querySelector(s), { timeout: 2000 }, SEL.palette.box);
  await sleep(50);
  assert.equal(await page.$eval('#hideKs', e => e.checked), !ks0, 'Enter toggled Hide keyswitches');
  assert.match(await page.$eval(SEL.flash, e => e.textContent), /Hide keyswitches: (on|off)/);
  // a select option, opened with Ctrl+J; ↓ moves the choice
  await ctrl(page, 'j');
  await page.waitForSelector(SEL.palette.input, { visible: true });
  const recentFirst = await page.$eval(SEL.palette.item, e => e.textContent);
  assert.match(recentFirst, /Hide keyswitches/, 'the last command run comes first');
  await page.keyboard.type('quantize 8th');
  assert.match(await page.$eval(SEL.palette.selected, e => e.textContent), /Quantize: 8th/);
  await page.keyboard.press('Enter');
  await sleep(50);
  assert.equal(await page.$eval('#gridSel', e => e.value), '4', 'Quantize set to 8th');
  await page.$eval('#gridSel', e => { e.value = '2'; e.dispatchEvent(new Event('change')); });
  await ctrl(page, 'k');
  await page.waitForSelector(SEL.palette.input, { visible: true });
  await page.keyboard.type('hide');
  const before = await page.$eval(SEL.palette.selected, e => e.dataset.i);
  await page.keyboard.press('ArrowDown');
  assert.notEqual(await page.$eval(SEL.palette.selected, e => e.dataset.i), before, '↓ moves the choice');
  const edits0 = srv.edits.length;
  await page.keyboard.press('ArrowUp');
  assert.equal(srv.edits.length, edits0, 'keys in the palette do not reach the score');
  await page.keyboard.press('Escape');
  assert.equal(await page.$(SEL.palette.box), null, 'Esc closes the palette');
  // a shortcut entry runs by its key: "select all notes" (Ctrl+A)
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => SV.state.selection.size), 0);
  await page.click(SEL.palette.button);
  await page.waitForSelector(SEL.palette.input, { visible: true });
  await page.keyboard.type('select all notes');
  assert.match(await page.$eval(SEL.palette.selected, e => e.textContent), /Ctrl\+A/);
  await shot(page, 'palette');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => SV.state.selection.size > 0, { timeout: 2000 });
  await page.keyboard.press('Escape');

  // ---- "?" shortcut sheet, grouped by task, with a filter
  await page.click(SEL.main);
  await page.keyboard.press('?');
  await page.waitForSelector(SEL.keySheet.box, { visible: true });
  const heads = await page.$$eval(`${SEL.keySheet.body} h3`, hs => hs.map(h => h.textContent));
  for (const t of ['Select and edit notes', 'Note entry', 'Playback', 'App']) assert.ok(heads.includes(t), 'sheet has ' + t + ': ' + heads);
  await shot(page, 'sheet');
  await page.keyboard.type('loop');
  const filtered = await page.$eval(SEL.keySheet.body, e => e.textContent);
  assert.ok(/loop/i.test(filtered) && !/Sequence up/.test(filtered), 'the filter narrows the sheet');
  await page.keyboard.press('Escape');
  assert.equal(await page.$(SEL.keySheet.box), null, 'Esc closes the sheet');
  const conflicts = await page.evaluate(() => SV.shortcuts.conflicts());
  assert.deepEqual(conflicts, [], 'no shortcut clashes');

  // ---- toasts: a stack, #flash is the newest, and a history with a duration preference
  await page.waitForFunction(s => document.querySelector(s).classList.contains('hidden'), { timeout: 8000 }, SEL.flash);
  await page.evaluate(() => { SV.flash('First message'); SV.flash('Could not read the arrangement'); SV.flash('Third message', { kind: 'ok' }); });
  assert.equal(await page.$eval(SEL.flash, e => e.textContent), 'Third message');
  assert.ok(await inside(page, SEL.flash, SEL.toastStack));
  assert.equal(await page.$$eval(`${SEL.toastStack} .svt-old`, e => e.length), 2, 'two older messages stay above');
  assert.deepEqual(await page.$$eval(`${SEL.toastStack} .svt-old`, e => e.map(x => x.dataset.kind)), ['info', 'err'], 'kinds guessed');
  assert.ok(+(await page.$eval(`${SEL.toastButton} .svt-count`, e => e.textContent)) >= 3, 'unseen count');
  await page.click(SEL.toastButton);
  await page.waitForSelector(SEL.toastHistory, { visible: true });
  const hist = await page.$$eval(`${SEL.toastHistory} li span`, e => e.map(x => x.textContent));
  assert.deepEqual(hist.slice(0, 3), ['Third message', 'Could not read the arrangement', 'First message'], 'newest first');
  assert.equal(await page.$eval(`${SEL.toastButton} .svt-count`, e => e.textContent), '', 'seen');
  await shot(page, 'toasts');
  await page.select('#svToastMs', '6000');
  assert.equal(await page.evaluate(() => [SV.flash.ms, JSON.parse(localStorage.getItem('scoreview.toasts.ms'))].join()), '6000,6000');
  await page.click('#svToastClear');
  assert.equal(await page.evaluate(() => SV.toasts.history().length), 0, 'Clear empties the history');
  await page.keyboard.press('Escape');
  assert.equal(await page.$(SEL.toastHistory), null, 'Esc closes the history');
  await page.evaluate(() => SV.toasts.setDuration(2500));
  await sleep(2700);
  assert.ok(await page.$eval(SEL.flash, e => e.classList.contains('hidden')), '#flash hides after its time');

  assert.deepEqual(errors, []);
  console.log('gui-e2e OK: chrome', m.chrome, 'px, header', m.header, 'px');
});
