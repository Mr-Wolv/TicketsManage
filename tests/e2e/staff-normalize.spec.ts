import { test, expect } from '@playwright/test';

test.describe('Staff page normalize toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/staff');
    await page.waitForSelector('button', { timeout: 15000 });
  });

  test('toggles normalize on and off', async ({ page }) => {
    const normalizeButton = page.getByRole('button', { name: 'Normalize points' });
    await expect(normalizeButton).toBeVisible();

    await normalizeButton.click();
    await expect(page.getByRole('button', { name: 'Normalized view' })).toBeVisible();

    const normalizedButton = page.getByRole('button', { name: 'Normalized view' });
    await normalizedButton.click();
    await expect(page.getByRole('button', { name: 'Normalize points' })).toBeVisible();
  });
});
