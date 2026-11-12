// Drives the webgpu-device-hung-test page in the INSTALLED Firefox (WebDriver BiDi via puppeteer-core), fresh profile per test.
// npm install puppeteer-core   then   node ffdrive.js <url> control,test,fix
// FIREFOX_EXE overrides the Firefox path. '-no-remote --new-instance' keep it from handing off to a Firefox already running.
const puppeteer = require('puppeteer-core');
const fs = require('fs'), os = require('os'), path = require('path');
const [url, list] = process.argv.slice(2);
const FIREFOX = process.env.FIREFOX_EXE || 'C:/Program Files/Mozilla Firefox/firefox.exe';
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wdhff_'));
  try {
    for (const t of list.split(',')) {
      const browser = await puppeteer.launch({ browser: 'firefox', executablePath: FIREFOX, headless: false, userDataDir: profile,
        protocolTimeout: 900000, args: ['-no-remote', '--new-instance'], dumpio: false, extraPrefsFirefox: { 'dom.webgpu.enabled': true } });
      try {
        const page = (await browser.pages())[0] || await browser.newPage();
        page.setDefaultTimeout(180000);
        await page.goto(url);
        await page.waitForSelector(`button[data-t=${t}]`);
        console.log('GPU: ' + (await page.$eval('#gpu', e => e.innerText)).replace(/\n/g, ' | '));
        await page.click(`button[data-t=${t}]`);
        const t0 = Date.now(); let st = '';
        while (Date.now() - t0 < 900000) {
          await new Promise(f => setTimeout(f, 1000));
          st = await page.$eval(`#st-${t}`, e => e.innerText);
          if (!(await page.$eval(`button[data-t=${t}]`, b => b.disabled))) break;
        }
        console.log(`RESULT ${t}: ${st}  [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
        console.log('REPLAY: ' + await page.evaluate(() => { const R = window.__replay; return JSON.stringify({ at: R.at, of: R.of, lost: R.lost, errors: R.errors.length, firstErrors: R.errors.slice(0, 5), reads: R.reads || 0, readMismatches: R.readMismatches || 0, mismatchAt: R.mismatchAt || [] }); }));
        if (t === list.split(',').pop()) console.log('REPORT:\n' + await page.$eval('#report', e => e.value));
      } finally { await browser.close(); }
    }
  } finally { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } }
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
