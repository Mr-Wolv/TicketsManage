import { test, expect } from '@playwright/test';

test.describe('Collect page mode switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/collect');
    await page.waitForSelector('select.input', { timeout: 15000 });
  });

  test('shows date inputs in date mode', async ({ page }) => {
    const modeSelect = page.getByLabel('Collection mode');
    await modeSelect.selectOption('date');

    await expect(page.getByLabel('Starting ticket ID')).not.toBeVisible();
    await expect(page.getByLabel('Ending ticket ID')).not.toBeVisible();
    await expect(page.getByLabel('From', { exact: true })).toBeVisible();
    await expect(page.getByLabel('To', { exact: true })).toBeVisible();
  });

  test('shows id inputs in id mode', async ({ page }) => {
    const modeSelect = page.getByLabel('Collection mode');
    await modeSelect.selectOption('id');

    await expect(page.getByLabel('Starting ticket ID')).toBeVisible();
    await expect(page.getByLabel('Ending ticket ID')).toBeVisible();
    await expect(page.getByLabel('From', { exact: true })).not.toBeVisible();
    await expect(page.getByLabel('To', { exact: true })).not.toBeVisible();
  });

  test('shows both inputs in hybrid mode', async ({ page }) => {
    const modeSelect = page.getByLabel('Collection mode');
    await modeSelect.selectOption('hybrid');

    await expect(page.getByLabel('Starting ticket ID')).toBeVisible();
    await expect(page.getByLabel('Ending ticket ID')).toBeVisible();
    await expect(page.getByLabel('From', { exact: true })).toBeVisible();
    await expect(page.getByLabel('To', { exact: true })).toBeVisible();
  });
});
