import { test, expect } from '@playwright/test';

test.describe('Settings save flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/settings');
    await page.waitForSelector('button:has-text("Save settings")', { timeout: 15000 });
  });

  test('saves settings and shows saving state', async ({ page }) => {
    const ollamaInput = page.getByLabel('Ollama URL');
    await expect(ollamaInput).toBeVisible();

    const originalValue = await ollamaInput.inputValue();
    const testValue = originalValue ? `${originalValue}-e2e` : 'http://127.0.0.1:11434-e2e';

    await ollamaInput.fill(testValue);
    await expect(ollamaInput).toHaveValue(testValue);

    const saveButton = page.getByRole('button', { name: 'Save settings' });
    await saveButton.click();

    await expect(saveButton).toBeEnabled({ timeout: 15000 });
    await expect(ollamaInput).toHaveValue(testValue);

    await ollamaInput.fill(originalValue ?? 'http://127.0.0.1:11434');
    await saveButton.click();
    await expect(saveButton).toBeEnabled({ timeout: 15000 });
  });
});
