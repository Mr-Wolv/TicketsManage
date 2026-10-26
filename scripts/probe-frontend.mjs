import { chromium } from 'playwright';

const pages = [
  'http://127.0.0.1:5178/#/overview',
  'http://127.0.0.1:5178/#/collect',
  'http://127.0.0.1:5178/#/tickets',
  'http://127.0.0.1:5178/#/staff',
  'http://127.0.0.1:5178/#/reviews',
  'http://127.0.0.1:5178/#/settings',
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  for (const url of pages) {
    console.log(`\n=== ${url} ===`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText);
    console.log(text.slice(0, 2500));
  }
  
  await browser.close();
})();
