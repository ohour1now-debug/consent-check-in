'use strict';
/** Drives two mobile browsers (Person A and Person B) against a running server and saves PNGs.
 *  Usage: BASE_URL=http://localhost:3210 CHROME=/usr/bin/google-chrome node test/screenshots.js */
const path = require('path');
const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE_URL || 'http://localhost:3210';
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
  });
  const phone = async () => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    p.on('pageerror', (e) => console.error('pageerror', e.message));
    p.on('console', (m) => m.type() === 'error' && console.error('console', m.text()));
    return p;
  };
  // "tall" grows the viewport to the page height so the fixed Stop bar stays pinned at the bottom.
  const shot = async (p, name, tall = false) => {
    await sleep(400);
    if (tall) {
      const h = await p.evaluate(() => document.documentElement.scrollHeight);
      await p.setViewport({ width: 390, height: Math.max(844, h), deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(300);
    }
    await p.screenshot({ path: path.join(OUT, name) });
    if (tall) await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    console.log('saved', name);
  };

  const A = await phone(); const B = await phone();
  await A.goto(BASE, { waitUntil: 'networkidle0' });
  await A.click('#goCreate'); await A.type('#nick', 'Sky');
  await A.click('#createForm button[type=submit]');
  await A.waitForSelector('.code-big');
  const code = await A.$eval('.code-big', (e) => e.textContent.trim());
  await shot(A, '1-start-session-code-qr.png');

  await B.goto(`${BASE}/#join=${code}`, { waitUntil: 'networkidle0' });
  await B.type('#nick', 'River');
  await B.click('#joinForm button[type=submit]');
  await B.waitForSelector('#confirmForm');
  for (const sel of ['input[name=adult]', 'input[name=sober]', 'input[name=agree]', 'input[value=kissing]', 'input[value=cuddling]', 'input[value=touch_over]']) await B.$eval(sel, (e) => e.click());
  await B.type('#note', 'Check in with me often.');
  await shot(B, '2-check-in-form.png', true);

  // A confirms
  await A.waitForSelector('#confirmForm');
  for (const sel of ['input[name=adult]', 'input[name=sober]', 'input[name=agree]', 'input[value=kissing]', 'input[value=cuddling]', 'input[value=oral]', 'input[name=protection]']) await A.$eval(sel, (e) => e.click());
  await A.type('#note', "Let's go slow.");
  await A.click('#confirmForm button[type=submit]');
  await B.click('#confirmForm button[type=submit]');
  await A.waitForSelector('.status.active');
  await shot(A, '3-consent-active-both-confirmed.png', true);

  // B taps Stop -> A's screen
  await B.waitForSelector('#stopBtn');
  await B.click('#stopBtn');
  await A.waitForSelector('.endscreen');
  await shot(A, '4-consent-withdrawn-stop-now.png');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
