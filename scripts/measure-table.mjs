import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  await page.goto('http://127.0.0.1:5178/#/tickets', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  const metrics = await page.evaluate(() => {
    const tableWrap = document.querySelector('.table-wrap');
    const table = document.querySelector('.data-table');
    const headerCells = document.querySelectorAll('.data-table th');
    
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      tableWrapWidth: tableWrap?.getBoundingClientRect().width ?? 'N/A',
      tableWidth: table?.getBoundingClientRect().width ?? 'N/A',
      tableWrapScrollWidth: tableWrap?.scrollWidth ?? 'N/A',
      tableWrapClientWidth: tableWrap?.clientWidth ?? 'N/A',
      headerCount: headerCells.length,
      headers: Array.from(headerCells).map(th => th.textContent?.trim()),
    };
  });
  
  console.log(JSON.stringify(metrics, null, 2));
  await browser.close();
})();
