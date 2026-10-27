import { test, expect } from '@playwright/test';

test.describe('Collect page mode switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/collect');
    await page.waitForSelector('select.input', { timeout: 15000 });
  });

  test('shows id inputs in id mode', async ({ page }) => {
    const modeSelect = page.getByLabel('Collection mode');
    await modeSelect.selectOption('id');

    await expect(page.getByLabel('Starting ticket ID')).toBeVisible();
    await expect(page.getByLabel('Ending ticket ID')).toBeVisible();
    await expect(page.getByLabel('Ticket IDs')).not.toBeVisible();
  });

  test('shows manual id input in manual mode', async ({ page }) => {
    const modeSelect = page.getByLabel('Collection mode');
    await modeSelect.selectOption('manual');

    await expect(page.getByLabel('Ticket IDs')).toBeVisible();
    await expect(page.getByLabel('Starting ticket ID')).not.toBeVisible();
    await expect(page.getByLabel('Ending ticket ID')).not.toBeVisible();
  });
});
