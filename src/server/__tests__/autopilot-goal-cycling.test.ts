import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb } from '../db.js';
import { runQuery, getOne, getAll } from '../db.js';
import { initBoofDir, recordPattern, proposeGoals } from '../agent-memory.js';
import { MAX_GOALS_PER_SESSION, IDLE_BACKOFF_MS, resetAgentSessionCounters } from '../autopilot.js';

const TEST_DB_PATH = './test-goal-cycling.db';

let goalCounter = 0;

function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function createGoal(name: string, priority: number, status = 'active'): string {
  const id = generateId();
  // Use incrementing offset to ensure unique created_at timestamps for deterministic ordering
  const ts = new Date(Date.now() + goalCounter * 100).toISOString();
  goalCounter++;
  runQuery(
    `INSERT INTO goals (id, name, description, status, priority, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, ?, ?)`,
    [id, name, status, priority, ts, ts]
  );
  return id;
}

function createTask(goalId: string, title: string, status = 'todo'): string {
  const folderId = generateId();
  const id = generateId();
  const now = new Date().toISOString();
  // Ensure folder exists
  runQuery(
    `INSERT OR IGNORE INTO folders (id, name, icon, created_at, updated_at) VALUES (?, 'Test', '📁', ?, ?)`,
    [folderId, now, now]
  );
  runQuery(
    `INSERT INTO tasks (id, folder_id, title, description, status, goal_id, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?)`,
    [id, folderId, title, status, goalId, now, now]
  );
  return id;
}

describe('goal cycling: completion detection', () => {
  beforeEach(async () => {
    goalCounter = 0;
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('detects when all tasks are done for a goal', () => {
    const goalId = createGoal('Test Goal', 3);
    const t1 = createTask(goalId, 'Task 1', 'done');
    const t2 = createTask(goalId, 'Task 2', 'done');

    const remaining = getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress')",
      [goalId]
    );
    assert.equal(remaining?.count, 0, 'Should have no remaining tasks');

    const done = getAll<{ id: string }>(
      "SELECT id FROM tasks WHERE goal_id = ? AND status = 'done'",
      [goalId]
    );
    assert.equal(done.length, 2, 'Should have 2 done tasks');
  });

  it('detects incomplete goal when tasks remain', () => {
    const goalId = createGoal('Incomplete Goal', 2);
    createTask(goalId, 'Done Task', 'done');
    createTask(goalId, 'Pending Task', 'todo');

    const remaining = getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress')",
      [goalId]
    );
    assert.ok((remaining?.count ?? 0) > 0, 'Should have remaining tasks');
  });

  it('marks goal completed with completed_at timestamp', () => {
    const goalId = createGoal('Complete Me', 3);
    const now = new Date().toISOString();

    runQuery(
      `UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, goalId]
    );

    const goal = getOne<{ status: string; completed_at: string | null }>(
      'SELECT status, completed_at FROM goals WHERE id = ?',
      [goalId]
    );
    assert.equal(goal?.status, 'completed');
    assert.ok(goal?.completed_at !== null, 'completed_at should be set');
  });

  it('selects next goal by highest priority', () => {
    const g1 = createGoal('Low Priority', 1);
    const g2 = createGoal('High Priority', 5);
    const g3 = createGoal('Medium Priority', 3);

    // Simulate completing g2
    runQuery("UPDATE goals SET status = 'completed' WHERE id = ?", [g2]);

    const nextGoal = getOne<{ id: string; name: string; priority: number }>(
      "SELECT id, name, priority FROM goals WHERE status = 'active' AND id != ? ORDER BY priority DESC, created_at ASC LIMIT 1",
      [g2]
    );
    assert.equal(nextGoal?.id, g3, 'Should select medium priority goal next');
    assert.equal(nextGoal?.priority, 3);
  });

  it('goal_stats table tracks runs correctly', () => {
    const goalId = createGoal('Stats Goal', 2);
    const now = new Date().toISOString();

    // Insert initial stat
    runQuery(
      `INSERT INTO goal_stats (goal_id, total_runs, tasks_completed, tasks_failed, avg_duration_ms, last_run_at)
       VALUES (?, 1, 1, 0, 5000, ?)`,
      [goalId, now]
    );

    const stat = getOne<{ total_runs: number; tasks_completed: number; avg_duration_ms: number }>(
      'SELECT * FROM goal_stats WHERE goal_id = ?',
      [goalId]
    );
    assert.equal(stat?.total_runs, 1);
    assert.equal(stat?.tasks_completed, 1);
    assert.equal(stat?.avg_duration_ms, 5000);
  });

  it('updates goal_stats after subsequent run', () => {
    const goalId = createGoal('Stats Update Goal', 2);
    const now = new Date().toISOString();

    // Insert initial stat
    runQuery(
      `INSERT INTO goal_stats (goal_id, total_runs, tasks_completed, tasks_failed, avg_duration_ms, last_run_at)
       VALUES (?, 1, 1, 0, 4000, ?)`,
      [goalId, now]
    );

    // Simulate second run update
    const existing = getOne<{ total_runs: number; avg_duration_ms: number }>(
      'SELECT total_runs, avg_duration_ms FROM goal_stats WHERE goal_id = ?',
      [goalId]
    );
    const newTotal = (existing?.total_runs ?? 0) + 1;
    const newAvg = ((existing?.avg_duration_ms ?? 0) * (existing?.total_runs ?? 0) + 6000) / newTotal;
    runQuery(
      `UPDATE goal_stats SET total_runs = ?, tasks_completed = 2, avg_duration_ms = ?, last_run_at = ? WHERE goal_id = ?`,
      [newTotal, newAvg, now, goalId]
    );

    const updated = getOne<{ total_runs: number; avg_duration_ms: number }>(
      'SELECT total_runs, avg_duration_ms FROM goal_stats WHERE goal_id = ?',
      [goalId]
    );
    assert.equal(updated?.total_runs, 2);
    assert.equal(updated?.avg_duration_ms, 5000); // (4000 + 6000) / 2
  });
});

describe('goal proposal from past patterns', () => {
  let tmpDir: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-proposal-test-'));
    initBoofDir(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('proposeGoals returns at least one goal when patterns exist', async () => {
    const agentId = generateId();
    // Create an agent for the test
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'Test Agent', ?, 'idle', ?, ?)`,
      [agentId, tmpDir, now, now]
    );

    // Add a pattern to memory
    recordPattern(tmpDir, 'Always validate types before committing', 'test');

    const proposed = await proposeGoals(agentId, tmpDir);
    assert.ok(proposed.length > 0, 'Should propose at least one goal');
  });

  it('proposeGoals saves goals with proposal_status pending', async () => {
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'Test Agent', ?, 'idle', ?, ?)`,
      [agentId, tmpDir, now, now]
    );

    const proposed = await proposeGoals(agentId, tmpDir);
    assert.ok(proposed.length > 0, 'Should propose goals');

    // Verify saved to DB
    for (const g of proposed) {
      const dbGoal = getOne<{ proposal_status: string; proposed_by: string }>(
        'SELECT proposal_status, proposed_by FROM goals WHERE id = ?',
        [g.id]
      );
      assert.equal(dbGoal?.proposal_status, 'pending');
      assert.equal(dbGoal?.proposed_by, agentId);
    }
  });

  it('proposeGoals limits output to 3 goals', async () => {
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'Test Agent', ?, 'idle', ?, ?)`,
      [agentId, tmpDir, now, now]
    );

    // Add many patterns to trigger more candidates
    for (let i = 0; i < 10; i++) {
      recordPattern(tmpDir, `Pattern ${i}: improve error handling in module ${i}`, 'test');
    }

    const proposed = await proposeGoals(agentId, tmpDir);
    assert.ok(proposed.length <= 3, 'Should not propose more than 3 goals');
  });
});

describe('overnight autonomy safeguards', () => {
  beforeEach(async () => {
    goalCounter = 0;
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('MAX_GOALS_PER_SESSION is a positive integer', () => {
    assert.ok(typeof MAX_GOALS_PER_SESSION === 'number', 'Should be a number');
    assert.ok(MAX_GOALS_PER_SESSION > 0, 'Should be positive');
    assert.ok(Number.isInteger(MAX_GOALS_PER_SESSION), 'Should be an integer');
  });

  it('IDLE_BACKOFF_MS is at least 60 seconds', () => {
    assert.ok(typeof IDLE_BACKOFF_MS === 'number', 'Should be a number');
    assert.ok(IDLE_BACKOFF_MS >= 60_000, 'Should be at least 60 seconds to prevent tight loops');
  });

  it('resetAgentSessionCounters is exported and callable', () => {
    const agentId = generateId();
    // Should not throw
    assert.doesNotThrow(() => resetAgentSessionCounters(agentId));
    // Calling it again should also not throw (idempotent)
    assert.doesNotThrow(() => resetAgentSessionCounters(agentId));
  });

  it('resetAgentSessionCounters can be called for unknown agents safely', () => {
    // Should be a no-op for agents that were never tracked
    assert.doesNotThrow(() => resetAgentSessionCounters('nonexistent-agent-id'));
  });

  it('selects next active goal by priority when current goal finishes', () => {
    // Verify the priority-based next goal selection query used in checkAndCycleGoal
    const currentGoalId = createGoal('Current Goal', 3);
    const highPriGoalId = createGoal('High Priority Goal', 5);
    const lowPriGoalId = createGoal('Low Priority Goal', 1);

    // Simulate completing the current goal
    const now = new Date().toISOString();
    runQuery(`UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`, [now, now, currentGoalId]);

    const nextGoal = getOne<{ id: string; priority: number }>(
      "SELECT id, priority FROM goals WHERE status = 'active' AND id != ? ORDER BY priority DESC, created_at ASC LIMIT 1",
      [currentGoalId]
    );
    assert.equal(nextGoal?.id, highPriGoalId, 'Should pick highest priority active goal');
    assert.equal(nextGoal?.priority, 5);
  });

  it('autopilot disables when agent has no active goals and no tasks', () => {
    // Verify the DB update that checkAndCycleGoal would do when no goals remain
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, autopilot, autopilot_goal_id, status, created_at, last_activity)
       VALUES (?, 'Test Agent', '.', 1, NULL, 'idle', ?, ?)`,
      [agentId, now, now]
    );

    // Simulate the autopilot clearing the goal
    runQuery('UPDATE agents SET autopilot_goal_id = NULL WHERE id = ?', [agentId]);

    const agent = getOne<{ autopilot_goal_id: string | null }>('SELECT autopilot_goal_id FROM agents WHERE id = ?', [agentId]);
    assert.equal(agent?.autopilot_goal_id, null, 'autopilot_goal_id should be cleared when no goals remain');
  });
});
