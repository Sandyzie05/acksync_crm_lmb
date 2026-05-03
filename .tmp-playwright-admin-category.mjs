import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(4000);
const errors = [];
page.on('console', msg => {
  if (msg.type() === 'error') errors.push(`console:${msg.text()}`);
});
page.on('pageerror', err => errors.push(`pageerror:${err.stack || err.message}`));

try {
  await page.goto('http://localhost:1420', { waitUntil: 'domcontentloaded' });
  console.log('step:loaded');
  await page.getByRole('navigation').getByRole('button', { name: 'Admin' }).click();
  console.log('step:admin');
  await page.getByLabel('Category Name').fill('Milk Sweets');
  console.log('step:typed');
  await page.getByRole('button', { name: 'Add Category' }).click();
  console.log('step:clicked-save');
  await page.locator('.modal-sheet input').fill('1234');
  console.log('step:pin');
  await page.getByRole('button', { name: 'Continue' }).click();
  console.log('step:continue');
  await page.waitForTimeout(500);
  console.log('toast:', await page.locator('.toast').innerText());
} catch (error) {
  console.log('script-error:', error.stack || error.message || String(error));
}

console.log('errors:', JSON.stringify(errors, null, 2));
await browser.close();
