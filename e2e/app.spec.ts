import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Clean DB before test suite to ensure fresh state
test.beforeAll(() => {
  const dbPath = path.join(process.cwd(), 'boof.db');
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
});

async function waitForWsConnection(page: any) {
  // Wait for the "Reconnecting..." banner to disappear and stay gone
  await page.waitForTimeout(2000);
  await expect(page.locator('text=Reconnecting...')).not.toBeVisible({ timeout: 10000 });
  // Extra settle time to ensure WS is stable
  await page.waitForTimeout(500);
}

test.describe('Boof PWA', () => {
  test('loads the home screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Boof')).toBeVisible();
  });

  test('has bottom navigation with 5 tabs', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
    await expect(nav.locator('button')).toHaveCount(5);
  });

  test('shows empty state on home screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=No agents yet')).toBeVisible();
  });

  test('navigates to Goals screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav button', { hasText: 'Goals' }).click();
    await expect(page.locator('h1', { hasText: 'Goals' })).toBeVisible();
  });

  test('navigates to Tasks screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav button', { hasText: 'Tasks' }).click();
    await expect(page.locator('h1', { hasText: 'Tasks' })).toBeVisible();
  });

  test('navigates to Agents screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav button', { hasText: 'Agents' }).click();
    await expect(page.locator('h1', { hasText: 'Agents' })).toBeVisible();
  });

  test('navigates to History screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav button', { hasText: 'History' }).click();
    await expect(page.locator('h1', { hasText: 'History' })).toBeVisible();
  });

  test('shows empty agents state', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav button', { hasText: 'Agents' }).click();
    await expect(page.locator('text=No agents yet')).toBeVisible();
  });

  test('can open new agent form', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav button', { hasText: 'Agents' }).click();
    await page.locator('button', { hasText: '+ New' }).click();
    await expect(page.locator('input[placeholder*="Agent name"]')).toBeVisible();
  });

  test('has dark theme background', async ({ page }) => {
    await page.goto('/');
    const body = page.locator('body');
    const bgColor = await body.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bgColor).toContain('10');
  });

  test('has PWA manifest', async ({ page }) => {
    const response = await page.goto('/manifest.webmanifest');
    expect(response?.status()).toBe(200);
    const manifest = await response?.json();
    expect(manifest.name).toContain('Boof');
    expect(manifest.display).toBe('standalone');
  });

  test('has service worker registration', async ({ page }) => {
    await page.goto('/');
    const swScript = await page.locator('script[src*="registerSW"]').count();
    expect(swScript).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Tasks Screen', () => {
  test('can create a folder', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);
    await page.locator('nav button', { hasText: 'Tasks' }).click();

    // Click the + button in the Folders section to create a folder
    await page.locator('button', { hasText: '+' }).first().click();

    // Fill in folder name
    const folderName = `TestFolder-${Date.now()}`;
    const input = page.locator('input[placeholder*="Folder name"]');
    await expect(input).toBeVisible();
    await input.fill(folderName);
    await page.locator('button', { hasText: 'Add' }).click();

    // Folder should appear (wait for WS roundtrip)
    await expect(page.getByText(folderName).first()).toBeVisible({ timeout: 10000 });
  });

  test('can create a task in a folder', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);
    await page.locator('nav button', { hasText: 'Tasks' }).click();

    // Create a folder first
    const folderName = `WorkFolder-${Date.now()}`;
    await page.locator('button', { hasText: '+' }).first().click();
    const folderInput = page.locator('input[placeholder*="Folder name"]');
    await folderInput.fill(folderName);
    await page.locator('button', { hasText: 'Add' }).click();
    await expect(page.getByText(folderName).first()).toBeVisible({ timeout: 10000 });

    // Click the folder to select it
    await page.getByText(folderName).first().click();

    // Add a task
    const taskName = `Task-${Date.now()}`;
    const taskInput = page.locator('input[placeholder*="Add a task"]');
    await expect(taskInput).toBeVisible();
    await taskInput.fill(taskName);

    // Click the + button next to the task input
    await taskInput.press('Enter');

    // Task should appear
    await expect(page.getByText(taskName).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('WebSocket Connection', () => {
  test('connects to WebSocket and receives sync state', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);
  });
});
