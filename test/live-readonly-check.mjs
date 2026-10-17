// Read-only check against the user's live Bitwig: loads the page, reports page errors and module
// presence. Sends no edits (no clicks or keys). Usage: node test/live-readonly-check.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './lib.mjs';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setRequestInterception(true);
  page.on('request', r => r.method() === 'POST' ? r.abort() : r.continue()); // never edit the project
  await page.goto('http://localhost:8765/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#paper svg'), { timeout: 30000 });
  await new Promise(r => setTimeout(r, 2000));
  const info = await page.evaluate(() => ({
    modules: ['instruments', 'sections', 'rhythm', 'harmony', 'motifs', 'entry', 'playback', 'musicxml'].filter(m => window.SV[m]),
    track: SV.state.liveData && SV.state.liveData.track, notes: document.querySelectorAll('#paper g.note').length,
    toolbar: [...document.querySelectorAll('#featureBar button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 30),
  }));
  console.log(JSON.stringify(info, null, 1));
  await page.screenshot({ path: 'test/out-live-check.png' });
} finally {
  await browser.close();
  console.log(errors.length ? 'PAGE ERRORS:\n  ' + errors.join('\n  ') : 'no page errors');
}
