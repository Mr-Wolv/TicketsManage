import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  await page.goto('http://127.0.0.1:5178/#/tickets', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  const info = await page.evaluate(() => {
    const tableWrap = document.querySelector('.table-wrap');
    if (!tableWrap) return 'NO_TABLE_WRAP';
    
    const styles = window.getComputedStyle(tableWrap);
    return {
      overflowX: styles.overflowX,
      overflowY: styles.overflowY,
      maxHeight: styles.maxHeight,
      scrollWidth: tableWrap.scrollWidth,
      clientWidth: tableWrap.clientWidth,
      hasHorizontalOverflow: tableWrap.scrollWidth > tableWrap.clientWidth,
      hasVerticalOverflow: tableWrap.scrollHeight > tableWrap.clientHeight,
      scrollHeight: tableWrap.scrollHeight,
      clientHeight: tableWrap.clientHeight,
    };
  });
  
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
