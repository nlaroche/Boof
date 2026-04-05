import { test, expect } from '@playwright/test';

// Run against dev server
test.use({ baseURL: 'http://localhost:5173' });

async function waitForWsConnection(page: any) {
  await page.waitForTimeout(2000);
  await expect(page.locator('text=Reconnecting...')).not.toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);
}

test.describe('Projects - Dev Server - Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('dashboard loads without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err: any) => errors.push(err.message));
    page.on('console', (msg: any) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await waitForWsConnection(page);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/dev-dashboard.png' });

    const renderError = await page.locator('text=Render Error').count();
    if (renderError > 0) {
      const errorText = await page.locator('pre').first().textContent();
      console.log('DEV DASHBOARD RENDER ERROR:', errorText);
    }

    console.log('Dev dashboard errors:', JSON.stringify(errors.slice(0, 5)));
    expect(renderError).toBe(0);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toHaveLength(0);
  });

  test('navigate to projects without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err: any) => errors.push(err.message));

    await page.goto('/');
    await waitForWsConnection(page);

    await page.locator('nav button', { hasText: 'Projects' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/dev-projects.png' });

    const renderError = await page.locator('text=Render Error').count();
    if (renderError > 0) {
      const errorText = await page.locator('pre').first().textContent();
      console.log('DEV PROJECTS RENDER ERROR:', errorText);
    }

    console.log('Dev project errors:', JSON.stringify(errors.slice(0, 5)));
    expect(renderError).toBe(0);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toHaveLength(0);
  });

  test('full create project flow', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err: any) => errors.push(err.message));

    await page.goto('/');
    await waitForWsConnection(page);

    await page.locator('nav button', { hasText: 'Projects' }).click();
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();

    await page.getByRole('button', { name: '+ New', exact: true }).click();
    await expect(page.locator('input[placeholder="Project name"]')).toBeVisible({ timeout: 5000 });

    const projectName = `DevTest-${Date.now()}`;
    await page.locator('input[placeholder="Project name"]').fill(projectName);
    await page.getByRole('button', { name: 'Create Project' }).click();

    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10000 });

    // Click the project to view detail
    await page.getByText(projectName).first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/dev-project-detail.png' });

    const renderError = await page.locator('text=Render Error').count();
    if (renderError > 0) {
      const errorText = await page.locator('pre').first().textContent();
      console.log('DEV DETAIL RENDER ERROR:', errorText);
    }

    expect(renderError).toBe(0);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toHaveLength(0);
  });
});
