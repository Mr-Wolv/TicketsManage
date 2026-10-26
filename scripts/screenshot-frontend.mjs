import { chromium } from 'playwright';
import fs from 'fs';

const pages = [
  { url: 'http://127.0.0.1:5178/#/overview', name: 'overview' },
  { url: 'http://127.0.0.1:5178/#/collect', name: 'collect' },
  { url: 'http://127.0.0.1:5178/#/tickets', name: 'tickets' },
  { url: 'http://127.0.0.1:5178/#/staff', name: 'staff' },
  { url: 'http://127.0.0.1:5178/#/reviews', name: 'reviews' },
  { url: 'http://127.0.0.1:5178/#/settings', name: 'settings' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  for (const { url, name } of pages) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const screenshotPath = `C:/Users/GIGABYTE/AppData/Local/hermes/cache/scratch/${name}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`${name}: ${screenshotPath}`);
  }
  
  await browser.close();
})();
