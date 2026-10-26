import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  await page.goto('http://127.0.0.1:5178/#/tickets', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  // Find the table-wrap element and screenshot just that area
  const tableWrap = await page.locator('.table-wrap').first();
  if (await tableWrap.count() > 0) {
    const bbox = await tableWrap.boundingBox();
    console.log('table-wrap bbox:', JSON.stringify(bbox));
    if (bbox) {
      await page.screenshot({ path: 'C:/Users/GIGABYTE/AppData/Local/hermes/cache/scratch/tickets-table.png', clip: bbox });
      console.log('saved tickets-table.png');
    }
  }
  
  await browser.close();
})();
