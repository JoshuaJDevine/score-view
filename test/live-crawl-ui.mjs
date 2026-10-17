// Clicks "Read arrangement" in the real page against the live extension (crawl-test copy only) and screenshots
// the resulting Score mode. Only the 'crawl' op is allowed through; every other edit is blocked.
import puppeteer from 'puppeteer-core';
import { CHROME } from './lib.mjs';
const t = await (await fetch('http://localhost:8765/api/transport')).json();
if (!/crawl/i.test(t.project)) { console.error('Refusing: project is ' + t.project); process.exit(2); }
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => errors.push(String(e)));
  await page.setRequestInterception(true);
  page.on('request', r => (r.method() === 'POST' && r.postData() !== 'crawl') ? r.abort() : r.continue());
  await page.evaluateOnNewDocument(() => { localStorage.setItem('scoreview.mode', '"score"'); localStorage.setItem('scoreview.range', '"all"'); });
  await page.goto('http://localhost:8765/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#svarRead', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));
  await page.click('#svarRead');
  await page.waitForFunction(() => /parts/.test(document.getElementById('svarStatus').textContent) || /could not|failed|Click any/i.test(document.getElementById('svarStatus').textContent), { timeout: 240000, polling: 1000 });
  await new Promise(r => setTimeout(r, 6000));
  console.log('status:', await page.$eval('#svarStatus', e => e.textContent));
  console.log('title :', await page.$eval('#title', e => e.textContent));
  console.log('base parts:', await page.evaluate(() => SV.state.base && SV.state.base.parts.map(p => p.name + '(' + p.notes.length + ')').join(', ')));
  await page.screenshot({ path: 'test/out-live-crawl.png' });
} finally {
  await browser.close();
  console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'no page errors');
}
