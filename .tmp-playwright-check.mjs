import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('console', msg => console.log('console:', msg.type(), msg.text()));
page.on('pageerror', err => console.log('pageerror:', err.stack || err.message));
await page.goto('http://localhost:1420', { waitUntil: 'networkidle' });
console.log('title:', await page.title());
console.log('body-bytes:', (await page.content()).length);
await browser.close();
