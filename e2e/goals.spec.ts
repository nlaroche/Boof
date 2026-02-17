import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Clean DB before test suite to ensure fresh state
test.beforeAll(() => {
  const dbPath = path.join(process.cwd(), 'boof.db');
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
});

async function waitForWsConnection(page: Page) {
  await page.waitForTimeout(2000);
  await expect(page.locator('text=Reconnecting...')).not.toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);
}

async function navigateTo(page: Page, tabName: string) {
  await page.locator('nav button', { hasText: tabName }).click();
}

async function createGoal(page: Page, name: string, description?: string) {
  await navigateTo(page, 'Goals');
  // When no goals exist, "+" New Goal" is in the empty state; when goals exist, "+" New" is in the header
  const newGoalBtn = page.getByRole('button', { name: '+ New Goal' });
  const newBtn = page.getByRole('button', { name: '+ New', exact: true });
  const btn = await newGoalBtn.isVisible().then(v => v ? newGoalBtn : newBtn);
  await btn.click();
  await expect(page.getByRole('heading', { name: 'New Goal' })).toBeVisible({ timeout: 5000 });
  await page.locator('input[placeholder*="Improve Boof"]').fill(name);
  if (description) {
    await page.locator('textarea[placeholder*="What should the agent"]').fill(description);
  }
  await page.locator('button', { hasText: 'Create Goal' }).click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 });
}

async function createFolderAndSelect(page: Page, name: string) {
  await navigateTo(page, 'Tasks');
  const folderSection = page.locator('h2', { hasText: 'Folders' }).locator('..');
  await folderSection.locator('button', { hasText: '+' }).click();
  const folderInput = page.locator('input[placeholder*="Folder name"]');
  await expect(folderInput).toBeVisible();
  await folderInput.fill(name);
  await page.locator('button', { hasText: 'Add' }).click();
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10000 });
  await page.getByText(name).first().click();
}

/** Submit a task via the input. Does NOT assert visibility (use when filter may hide it). */
async function submitTask(page: Page, title: string) {
  const taskInput = page.locator('input[placeholder*="Add a task"]');
  await expect(taskInput).toBeVisible();
  await taskInput.fill(title);
  await taskInput.press('Enter');
  await expect(taskInput).toHaveValue('', { timeout: 5000 });
  // Small wait for WS roundtrip
  await page.waitForTimeout(500);
}

/** Submit a task and wait for it to appear. Only use when no filter is active. */
async function createTask(page: Page, title: string) {
  await submitTask(page, title);
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10000 });
}

/** Click a goal pill by name. Uses getByRole with exact match to avoid substring issues. */
async function clickGoalPill(page: Page, goalName: string) {
  await page.getByRole('button', { name: goalName, exact: true }).click();
  await page.waitForTimeout(300);
}

// ─── Goals CRUD ────────────────────────────────────────────────────────

test.describe('Goals CRUD', () => {
  test('can create a goal with name and description', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `Goal-${Date.now()}`;
    await createGoal(page, goalName, 'Test description for this goal');

    await expect(page.getByText(goalName).first()).toBeVisible();
    await expect(page.getByText('Test description for this goal').first()).toBeVisible();
  });

  test('can cycle goal status', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `CycleGoal-${Date.now()}`;
    await createGoal(page, goalName);

    const statusBadge = page.locator('button', { hasText: 'Active' }).first();
    await expect(statusBadge).toBeVisible();

    // active → paused
    await statusBadge.click();
    await expect(page.locator('button', { hasText: 'Paused' }).first()).toBeVisible({ timeout: 5000 });

    // paused → completed
    await page.locator('button', { hasText: 'Paused' }).first().click();
    await expect(page.getByText('Done').first()).toBeVisible({ timeout: 5000 });

    // completed → active
    await page.locator('button', { hasText: 'Done' }).first().click();
    await expect(page.locator('button', { hasText: 'Active' }).first()).toBeVisible({ timeout: 5000 });
  });

  test('can edit a goal', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `EditGoal-${Date.now()}`;
    await createGoal(page, goalName);

    await page.getByText(goalName).first().click();
    await expect(page.locator('button', { hasText: 'Edit' })).toBeVisible({ timeout: 5000 });
    await page.locator('button', { hasText: 'Edit' }).click();

    await expect(page.locator('text=Edit Goal')).toBeVisible({ timeout: 5000 });
    const nameInput = page.locator('input[placeholder*="Improve Boof"]');
    await nameInput.clear();
    const newName = `Edited-${Date.now()}`;
    await nameInput.fill(newName);
    await page.locator('button', { hasText: 'Save Changes' }).click();

    await expect(page.getByText(newName).first()).toBeVisible({ timeout: 10000 });
  });

  test('can delete a goal', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `DeleteGoal-${Date.now()}`;
    await createGoal(page, goalName);

    await page.getByText(goalName).first().click();
    await expect(page.locator('button', { hasText: 'Delete' })).toBeVisible({ timeout: 5000 });

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('button', { hasText: 'Delete' }).click();

    await expect(page.getByText(goalName)).not.toBeVisible({ timeout: 10000 });
  });

  test('goal persists after page reload', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `PersistGoal-${Date.now()}`;
    await createGoal(page, goalName);

    await page.reload();
    await waitForWsConnection(page);
    await navigateTo(page, 'Goals');

    await expect(page.getByText(goalName).first()).toBeVisible({ timeout: 10000 });
  });
});

// ─── Goal Filter Pills ────────────────────────────────────────────────

test.describe('Goal Filter Pills', () => {
  test('shows goal filter pills when goals exist', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `PillGoal-${Date.now()}`;
    await createGoal(page, goalName);

    const folderName = `PillFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: goalName, exact: true })).toBeVisible();
  });

  test('newly created task inherits active goal filter', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `InheritGoal-${Date.now()}`;
    await createGoal(page, goalName);

    const folderName = `InheritFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    // Select the goal pill
    await clickGoalPill(page, goalName);

    // Create a task while goal filter is active
    const taskName = `InheritTask-${Date.now()}`;
    await submitTask(page, taskName);

    // Switch to "All" to see all tasks regardless of filter
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(300);

    // Task should exist
    await expect(page.getByText(taskName).first()).toBeVisible({ timeout: 10000 });

    // Task should have goal badge (span badge, not the filter pill button)
    const taskRow = page.locator('div', { hasText: taskName }).first();
    await expect(taskRow.locator(`span:has-text("${goalName}")`)).toBeVisible({ timeout: 5000 });
  });

  test('filters tasks by selected goal', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goal1 = `FilterGoalA-${Date.now()}`;
    const goal2 = `FilterGoalB-${Date.now() + 1}`;
    await createGoal(page, goal1);
    await createGoal(page, goal2);

    const folderName = `FilterFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    // Create task under goal1
    await clickGoalPill(page, goal1);
    const task1 = `TaskA-${Date.now()}`;
    await submitTask(page, task1);

    // Create task under goal2
    await clickGoalPill(page, goal2);
    const task2 = `TaskB-${Date.now()}`;
    await submitTask(page, task2);

    // Switch to "All" — both tasks and their goal badges should be visible
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText(task1).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(task2).first()).toBeVisible({ timeout: 10000 });

    // Verify goal badges prove tasks are linked to different goals (use span to avoid filter pill match)
    const row1 = page.locator('div', { hasText: task1 }).first();
    await expect(row1.locator(`span:has-text("${goal1}")`)).toBeVisible({ timeout: 5000 });
    const row2 = page.locator('div', { hasText: task2 }).first();
    await expect(row2.locator(`span:has-text("${goal2}")`)).toBeVisible({ timeout: 5000 });

    // Filter by goal1 — clicking the pill activates the filter
    await clickGoalPill(page, goal1);
    // Verify filter reduces visible tasks (task2 should be hidden)
    await expect(page.getByText(task2)).not.toBeVisible({ timeout: 5000 });
  });

  test('All pill shows all tasks', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `AllPillGoal-${Date.now()}`;
    await createGoal(page, goalName);

    const folderName = `AllPillFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    // Create task with goal filter
    await clickGoalPill(page, goalName);
    const task1 = `GoalTask-${Date.now()}`;
    await submitTask(page, task1);

    // Create task without goal filter
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(300);
    const task2 = `NoGoalTask-${Date.now()}`;
    await createTask(page, task2);

    // "All" — both should be visible
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText(task1).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(task2).first()).toBeVisible({ timeout: 5000 });
  });
});

// ─── Task-Goal Badges ─────────────────────────────────────────────────

test.describe('Task-Goal Badges', () => {
  test('displays goal badge on task with goal_id', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `BadgeGoal-${Date.now()}`;
    await createGoal(page, goalName);

    const folderName = `BadgeFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    // Select goal filter then create task
    await clickGoalPill(page, goalName);
    const taskName = `BadgeTask-${Date.now()}`;
    await submitTask(page, taskName);

    // Switch to "All" to see task regardless of filter state
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(300);

    await expect(page.getByText(taskName).first()).toBeVisible({ timeout: 10000 });

    // The goal badge should appear near the task (span badge, not filter pill)
    const taskRow = page.locator('div', { hasText: taskName }).first();
    await expect(taskRow.locator(`span:has-text("${goalName}")`)).toBeVisible({ timeout: 5000 });
  });

  test('task without goal shows no badge', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `NoBadgeGoal-${Date.now()}`;
    await createGoal(page, goalName);

    const folderName = `NoBadgeFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    // Keep "All" filter (no goal selected) and create task
    const taskName = `NoBadgeTask-${Date.now()}`;
    await createTask(page, taskName);

    // The task should NOT have a goal badge
    const taskRow = page.locator('div', { hasText: taskName }).first();
    const goalBadge = taskRow.locator('span.text-\\[\\#7c5bf5\\]');
    await expect(goalBadge).not.toBeVisible({ timeout: 3000 });
  });
});

// ─── DrawerModal Behavior ─────────────────────────────────────────────

test.describe('DrawerModal Behavior', () => {
  test('goal create modal opens and closes', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);
    await navigateTo(page, 'Goals');

    // When no goals exist, "+" New Goal" is in the empty state; when goals exist, "+" New" is in the header
    const newGoalBtn = page.getByRole('button', { name: '+ New Goal' });
    const newBtn = page.getByRole('button', { name: '+ New', exact: true });
    const btn = await newGoalBtn.isVisible().then(v => v ? newGoalBtn : newBtn);
    await btn.click();
    await expect(page.getByRole('heading', { name: 'New Goal' })).toBeVisible({ timeout: 5000 });

    // Close via X button
    await page.getByRole('button', { name: 'x', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New Goal' })).not.toBeVisible({ timeout: 5000 });
  });

  test('folder settings modal opens via gear icon', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const folderName = `GearFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    const folderCard = page.locator('button', { hasText: folderName });
    await folderCard.locator('button').click();

    await expect(page.getByText('Delete Folder?')).toBeVisible({ timeout: 5000 });
  });

  test('folder delete modal has cancel/edit/delete buttons', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const folderName = `ModalFolder-${Date.now()}`;
    await createFolderAndSelect(page, folderName);

    const folderCard = page.locator('button', { hasText: folderName });
    await folderCard.locator('button').click();
    await expect(page.getByText('Delete Folder?')).toBeVisible({ timeout: 5000 });

    const modal = page.locator('[class*="fixed bottom-0"]');
    await expect(modal.locator('button', { hasText: 'Cancel' })).toBeVisible();
    await expect(modal.locator('button', { hasText: 'Edit' })).toBeVisible();
    await expect(modal.locator('button', { hasText: 'Delete' })).toBeVisible();
  });
});

// ─── Proposed Goals ───────────────────────────────────────────────────

test.describe('Proposed Goals', () => {
  test('proposed goals section hidden when no proposals', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);
    await navigateTo(page, 'Goals');

    await expect(page.getByText('Proposed by Agents')).not.toBeVisible({ timeout: 3000 });
  });

  test('goal create modal works for editing existing goals', async ({ page }) => {
    await page.goto('/');
    await waitForWsConnection(page);

    const goalName = `EditModalGoal-${Date.now()}`;
    await createGoal(page, goalName);

    await page.getByText(goalName).first().click();
    await expect(page.locator('button', { hasText: 'Edit' })).toBeVisible({ timeout: 5000 });
    await page.locator('button', { hasText: 'Edit' }).click();

    await expect(page.locator('text=Edit Goal')).toBeVisible({ timeout: 5000 });
    const nameInput = page.locator('input[placeholder*="Improve Boof"]');
    await expect(nameInput).toHaveValue(goalName);

    await nameInput.clear();
    const newName = `EditedModal-${Date.now()}`;
    await nameInput.fill(newName);
    await page.locator('button', { hasText: 'Save Changes' }).click();

    await expect(page.getByText(newName).first()).toBeVisible({ timeout: 10000 });
  });
});
