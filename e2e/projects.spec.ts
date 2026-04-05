import { test, expect } from '@playwright/test';

async function waitForWsConnection(page: any) {
  await page.waitForTimeout(2000);
  await expect(page.locator('text=Reconnecting...')).not.toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);
}

test.describe('Projects - Mobile', () => {
  test('no render errors on projects screen', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err: any) => errors.push(err.message));
    page.on('console', (msg: any) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await waitForWsConnection(page);

    // Navigate to Projects
    await page.locator('nav button', { hasText: 'Projects' }).click();
    await page.waitForTimeout(1000);

    // Check for render error boundary
    const renderError = await page.locator('text=Render Error').count();
    if (renderError > 0) {
      const errorText = await page.locator('pre').first().textContent();
      console.log('RENDER ERROR:', errorText);
    }
    await page.screenshot({ path: 'test-results/projects-errors.png' });

    console.log('Page errors:', JSON.stringify(errors));
    expect(renderError).toBe(0);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toHaveLength(0);
  });

  test('create project flow works without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err: any) => errors.push(err.message));

    await page.goto('/');
    await waitForWsConnection(page);

    await page.locator('nav button', { hasText: 'Projects' }).click();
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();

    await page.getByRole('button', { name: '+ New', exact: true }).click();
    await expect(page.locator('input[placeholder="Project name"]')).toBeVisible({ timeout: 5000 });

    const projectName = `Test-${Date.now()}`;
    await page.locator('input[placeholder="Project name"]').fill(projectName);
    await page.getByRole('button', { name: 'Create Project' }).click();

    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: 'test-results/projects-created.png' });

    // Reload and verify
    await page.reload();
    await waitForWsConnection(page);
    await page.locator('nav button', { hasText: 'Projects' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/projects-reloaded.png' });

    const renderError = await page.locator('text=Render Error').count();
    if (renderError > 0) {
      const errorText = await page.locator('pre').first().textContent();
      console.log('RENDER ERROR AFTER RELOAD:', errorText);
    }

    expect(renderError).toBe(0);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toHaveLength(0);
    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Projects - Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('no render errors on desktop projects screen', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err: any) => errors.push(err.message));
    page.on('console', (msg: any) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await waitForWsConnection(page);

    // Check dashboard first (home on desktop)
    await page.waitForTimeout(500);
    const dashErrors = await page.locator('text=Render Error').count();
    if (dashErrors > 0) {
      const errorText = await page.locator('pre').first().textContent();
      console.log('DASHBOARD RENDER ERROR:', errorText);
      await page.screenshot({ path: 'test-results/dashboard-error.png' });
    }

    // Navigate to Projects
    await page.locator('nav button', { hasText: 'Projects' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/projects-desktop-errors.png' });

    const renderError = await page.locator('text=Render Error').count();
    if (renderError > 0) {
      const errorText = await page.locator('pre').first().textContent();
      console.log('DESKTOP RENDER ERROR:', errorText);
    }

    console.log('Desktop page errors:', JSON.stringify(errors));
    expect(renderError).toBe(0);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toHaveLength(0);
  });

  test('desktop create and view project', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err: any) => errors.push(err.message));

    await page.goto('/');
    await waitForWsConnection(page);

    await page.locator('nav button', { hasText: 'Projects' }).click();
    await expect(page.locator('h1', { hasText: 'Projects' })).toBeVisible();

    await page.getByRole('button', { name: '+ New', exact: true }).click();
    await expect(page.locator('input[placeholder="Project name"]')).toBeVisible({ timeout: 5000 });

    const projectName = `Desktop-${Date.now()}`;
    await page.locator('input[placeholder="Project name"]').fill(projectName);
    await page.getByRole('button', { name: 'Create Project' }).click();
    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10000 });

    // Reload
    await page.reload();
    await waitForWsConnection(page);
    await page.locator('nav button', { hasText: 'Projects' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/projects-desktop-reloaded.png' });

    const renderError = await page.locator('text=Render Error').count();
    expect(renderError).toBe(0);
    expect(errors.filter(e => e.includes('Maximum update depth'))).toHaveLength(0);
    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10000 });
  });
});
