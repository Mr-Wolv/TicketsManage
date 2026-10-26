import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5178/#/settings');
  await page.waitForSelector('button:has-text("Save settings")', { timeout: 15000 });
  const btn = page.getByRole('button', { name: 'Save settings' });
  await btn.click();
  await page.waitForTimeout(500);
  const text = await btn.textContent();
  console.log('Button text after click:', JSON.stringify(text));
  await browser.close();
})();
