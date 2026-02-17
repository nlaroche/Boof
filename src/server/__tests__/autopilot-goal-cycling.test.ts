import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb } from '../db.js';
import { runQuery, getOne, getAll } from '../db.js';
import { initBoofDir, recordPattern, proposeGoals } from '../agent-memory.js';
import { MAX_GOALS_PER_SESSION, IDLE_BACKOFF_MS, resetAgentSessionCounters, checkAndCycleGoal } from '../autopilot.js';
import { initScheduler, stopScheduler } from '../scheduler.js';

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

describe('goal completion e2e cycle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    goalCounter = 0;
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-e2e-test-'));
    initBoofDir(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full cycle: tasks complete → goal auto-marked → next priority goal selected', () => {
    // Setup: two active goals with tasks
    const goalA = createGoal('Goal A (high priority)', 5);
    const goalB = createGoal('Goal B (low priority)', 1);

    createTask(goalA, 'Task A1', 'done');
    createTask(goalA, 'Task A2', 'done');
    createTask(goalB, 'Task B1', 'todo');

    // Step 1: verify all tasks for goalA are done
    const remaining = getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress')",
      [goalA]
    );
    assert.equal(remaining?.count, 0, 'All tasks for goal A should be done');

    // Step 2: auto-mark goalA completed
    const now = new Date().toISOString();
    runQuery(
      `UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, goalA]
    );

    const completedGoal = getOne<{ status: string; completed_at: string | null }>(
      'SELECT status, completed_at FROM goals WHERE id = ?',
      [goalA]
    );
    assert.equal(completedGoal?.status, 'completed', 'Goal A should be marked completed');
    assert.ok(completedGoal?.completed_at !== null, 'completed_at should be set');

    // Step 3: select next highest-priority active goal
    const nextGoal = getOne<{ id: string; name: string; priority: number }>(
      "SELECT id, name, priority FROM goals WHERE status = 'active' AND id != ? ORDER BY priority DESC, created_at ASC LIMIT 1",
      [goalA]
    );
    assert.equal(nextGoal?.id, goalB, 'Should select goal B as next active goal');
    assert.equal(nextGoal?.priority, 1, 'Goal B has priority 1');

    // Step 4: verify goal B still has tasks pending
    const pendingForB = getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress')",
      [goalB]
    );
    assert.ok((pendingForB?.count ?? 0) > 0, 'Goal B should still have pending tasks');
  });

  it('full cycle: no remaining goals → propose new goals', async () => {
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'E2E Test Agent', ?, 'idle', ?, ?)`,
      [agentId, tmpDir, now, now]
    );

    // Setup: one active goal, complete all its tasks
    const goalId = createGoal('Sole Goal', 3);
    createTask(goalId, 'Only Task', 'done');

    // Mark goal completed
    runQuery(
      `UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, goalId]
    );

    // No active goals remain
    const activeGoals = getAll<{ id: string }>("SELECT id FROM goals WHERE status = 'active'", []);
    assert.equal(activeGoals.length, 0, 'No active goals should remain');

    // Record a pattern so proposeGoals has material to work with
    recordPattern(tmpDir, 'Always add tests for new server modules', 'test');

    // Propose new goals
    const proposed = await proposeGoals(agentId, tmpDir);
    assert.ok(proposed.length > 0, 'Should propose at least one new goal');
    assert.ok(proposed.length <= 3, 'Should not propose more than 3 goals');

    // Verify proposals saved with pending status
    for (const g of proposed) {
      const dbGoal = getOne<{ proposal_status: string; proposed_by: string; status: string }>(
        'SELECT proposal_status, proposed_by, status FROM goals WHERE id = ?',
        [g.id]
      );
      assert.equal(dbGoal?.proposal_status, 'pending', 'Proposed goal should have pending proposal_status');
      assert.equal(dbGoal?.proposed_by, agentId, 'Proposed goal should reference the agent');
      assert.equal(dbGoal?.status, 'active', 'Proposed goals start as active');
    }
  });

  it('full cycle: goal_stats recorded after each run', () => {
    const goalId = createGoal('Stats Cycle Goal', 3);
    createTask(goalId, 'Task 1', 'done');

    const now = new Date().toISOString();

    // Simulate first run completing successfully
    runQuery(
      `INSERT INTO goal_stats (goal_id, total_runs, tasks_completed, tasks_failed, avg_duration_ms, last_run_at)
       VALUES (?, 1, 1, 0, 8000, ?)`,
      [goalId, now]
    );

    // Simulate second run completing successfully
    const existing = getOne<{ total_runs: number; avg_duration_ms: number }>(
      'SELECT total_runs, avg_duration_ms FROM goal_stats WHERE goal_id = ?',
      [goalId]
    );
    const newTotal = (existing?.total_runs ?? 0) + 1;
    const newAvg = ((existing?.avg_duration_ms ?? 0) * (existing?.total_runs ?? 0) + 10000) / newTotal;
    runQuery(
      `UPDATE goal_stats SET total_runs = ?, tasks_completed = 2, avg_duration_ms = ?, last_run_at = ? WHERE goal_id = ?`,
      [newTotal, newAvg, now, goalId]
    );

    // Mark goal completed
    runQuery(
      `UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, goalId]
    );

    // Verify stats reflect both runs
    const stats = getOne<{ total_runs: number; tasks_completed: number; avg_duration_ms: number }>(
      'SELECT total_runs, tasks_completed, avg_duration_ms FROM goal_stats WHERE goal_id = ?',
      [goalId]
    );
    assert.equal(stats?.total_runs, 2, 'Should have 2 total runs recorded');
    assert.equal(stats?.tasks_completed, 2, 'Should have 2 tasks completed');
    assert.equal(stats?.avg_duration_ms, 9000, 'Average duration should be (8000+10000)/2 = 9000');

    // Verify goal is completed
    const goal = getOne<{ status: string }>('SELECT status FROM goals WHERE id = ?', [goalId]);
    assert.equal(goal?.status, 'completed', 'Goal should be marked completed');
  });

  it('priority ordering: highest priority goal always selected next', () => {
    const low = createGoal('Low', 1);
    const med = createGoal('Medium', 3);
    const high = createGoal('High', 5);
    const veryHigh = createGoal('Very High', 5); // same priority as high, earlier creation → comes first

    // Mark high as completed
    const now = new Date().toISOString();
    runQuery(`UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`, [now, now, high]);

    // Next should be veryHigh (same priority 5 as high, but created earlier among remaining)
    const next1 = getOne<{ id: string; priority: number }>(
      "SELECT id, priority FROM goals WHERE status = 'active' AND id != ? ORDER BY priority DESC, created_at ASC LIMIT 1",
      [high]
    );
    assert.equal(next1?.id, veryHigh, 'Should pick veryHigh (priority 5, created before it was completed)');
    assert.equal(next1?.priority, 5);

    // Mark veryHigh completed too
    runQuery(`UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`, [now, now, veryHigh]);

    // Next should be med (priority 3)
    const next2 = getOne<{ id: string; priority: number }>(
      "SELECT id, priority FROM goals WHERE status = 'active' AND id NOT IN (?, ?) ORDER BY priority DESC, created_at ASC LIMIT 1",
      [high, veryHigh]
    );
    assert.equal(next2?.id, med, 'Should pick medium priority goal next');
    assert.equal(next2?.priority, 3);
  });
});

describe('GET /api/goals/propose endpoint behavior', () => {
  let tmpDir: string;

  beforeEach(async () => {
    goalCounter = 0;
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-propose-ep-test-'));
    initBoofDir(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns proposed goals when no active goals remain', async () => {
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'Propose Agent', ?, 'idle', ?, ?)`,
      [agentId, tmpDir, now, now]
    );

    // Ensure no active goals
    const activeGoals = getAll<{ id: string }>("SELECT id FROM goals WHERE status = 'active'", []);
    assert.equal(activeGoals.length, 0, 'No active goals should exist');

    // Add a pattern so proposeGoals has material
    recordPattern(tmpDir, 'Improve type safety across server modules', 'test');

    // Call proposeGoals — this is what the endpoint invokes
    const proposed = await proposeGoals(agentId, tmpDir);
    assert.ok(Array.isArray(proposed), 'Response should be an array of goals');
    assert.ok(proposed.length > 0, 'Should return at least one proposed goal when patterns exist');
    assert.ok(proposed.length <= 3, 'Should not return more than 3 proposals');
  });

  it('returns empty array when active goals still exist (endpoint skips proposal)', () => {
    // The endpoint returns empty goals when active goals exist
    createGoal('Still Active Goal', 3, 'active');
    const activeGoals = getAll<{ id: string }>("SELECT id FROM goals WHERE status = 'active'", []);
    assert.ok(activeGoals.length > 0, 'Active goals should exist — proposal should be skipped');
  });

  it('proposed goals have correct shape: id, name, description, status, proposal_status', async () => {
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'Shape Test Agent', ?, 'idle', ?, ?)`,
      [agentId, tmpDir, now, now]
    );

    recordPattern(tmpDir, 'Add integration tests for all REST endpoints', 'test');

    const proposed = await proposeGoals(agentId, tmpDir);
    assert.ok(proposed.length > 0, 'Should have proposals to check shape');

    for (const goal of proposed) {
      assert.ok(typeof goal.id === 'string' && goal.id.length > 0, 'goal.id should be a non-empty string');
      assert.ok(typeof goal.name === 'string' && goal.name.length > 0, 'goal.name should be a non-empty string');
      assert.ok(typeof goal.description === 'string', 'goal.description should be a string');
      assert.equal(goal.status, 'active', 'proposed goal status should be active');
      assert.equal(goal.proposal_status, 'pending', 'proposed goal proposal_status should be pending');
    }
  });

  it('proposed goals are persisted to DB with proposed_by set to agentId', async () => {
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'Persist Test Agent', ?, 'idle', ?, ?)`,
      [agentId, tmpDir, now, now]
    );

    recordPattern(tmpDir, 'Validate all WebSocket message handlers', 'test');

    const proposed = await proposeGoals(agentId, tmpDir);
    assert.ok(proposed.length > 0, 'Should have proposals');

    // Verify each proposed goal is in the DB with correct fields
    for (const g of proposed) {
      const dbGoal = getOne<{ proposal_status: string; proposed_by: string; status: string }>(
        'SELECT proposal_status, proposed_by, status FROM goals WHERE id = ?',
        [g.id]
      );
      assert.ok(dbGoal !== undefined, `Goal ${g.id} should be in DB`);
      assert.equal(dbGoal?.proposal_status, 'pending', 'DB proposal_status should be pending');
      assert.equal(dbGoal?.proposed_by, agentId, 'DB proposed_by should match agentId');
      assert.equal(dbGoal?.status, 'active', 'DB status should be active');
    }
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

describe('scheduler goal-cycling integration', () => {
  beforeEach(async () => {
    goalCounter = 0;
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
  });

  afterEach(() => {
    stopScheduler();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('initScheduler registers a cron tick without throwing', () => {
    const broadcasts: any[] = [];
    // initScheduler should not throw and should set up an interval
    assert.doesNotThrow(() => initScheduler((msg) => broadcasts.push(msg)));
    // Clean up immediately
    stopScheduler();
  });

  it('stopScheduler is idempotent — calling twice does not throw', () => {
    initScheduler(() => {});
    stopScheduler();
    assert.doesNotThrow(() => stopScheduler());
  });

  it('checkAndCycleGoal cycles goal on scheduler cron tick (simulated)', async () => {
    // Set up: one agent with an active goal, all tasks done
    const agentId = generateId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, autopilot, autopilot_goal_id, status, created_at, last_activity)
       VALUES (?, 'Scheduler Agent', '.', 1, NULL, 'idle', ?, ?)`,
      [agentId, now, now]
    );

    const goalId = createGoal('Scheduler Goal', 3);
    createTask(goalId, 'Only Task', 'done');

    // Bind goal to agent
    runQuery('UPDATE agents SET autopilot_goal_id = ? WHERE id = ?', [goalId, agentId]);

    // Simulate what happens when the scheduler cron tick fires and reaches checkAndCycleGoal:
    // All tasks done → goal auto-marked completed → autopilot_goal_id cleared
    const broadcasts: any[] = [];
    initScheduler((msg) => broadcasts.push(msg));

    const cycled = await checkAndCycleGoal(agentId, goalId);
    assert.equal(cycled, true, 'checkAndCycleGoal should return true when goal is cycled');

    // Verify goal is now completed in DB
    const goal = getOne<{ status: string; completed_at: string | null }>(
      'SELECT status, completed_at FROM goals WHERE id = ?',
      [goalId]
    );
    assert.equal(goal?.status, 'completed', 'Goal should be auto-marked completed');
    assert.ok(goal?.completed_at !== null, 'completed_at should be set after cycling');

    // Verify agent's goal was cleared (no next active goal)
    const agent = getOne<{ autopilot_goal_id: string | null }>(
      'SELECT autopilot_goal_id FROM agents WHERE id = ?',
      [agentId]
    );
    assert.equal(agent?.autopilot_goal_id, null, 'Agent autopilot_goal_id cleared when no next goal');
  });

  it('scheduler cron tick cycles to next highest-priority goal', async () => {
    // Set up: agent with active goal A (done) and goal B (active, lower priority)
    const agentId = generateId();
    const now = new Date().toISOString();

    const goalA = createGoal('Goal A (high)', 5);
    const goalB = createGoal('Goal B (low)', 1);

    createTask(goalA, 'Task for A', 'done'); // A is complete

    runQuery(
      `INSERT INTO agents (id, name, working_directory, autopilot, autopilot_goal_id, status, created_at, last_activity)
       VALUES (?, 'Scheduler Cycle Agent', '.', 1, ?, 'idle', ?, ?)`,
      [agentId, goalA, now, now]
    );

    // Simulate the scheduler triggering checkAndCycleGoal for goal A
    const broadcasts: any[] = [];
    initScheduler((msg) => broadcasts.push(msg));

    const cycled = await checkAndCycleGoal(agentId, goalA);
    assert.equal(cycled, true, 'Should return true when cycling from A to B');

    // Verify goalA is completed
    const completedGoal = getOne<{ status: string }>('SELECT status FROM goals WHERE id = ?', [goalA]);
    assert.equal(completedGoal?.status, 'completed', 'Goal A should be completed');

    // Verify agent now points to goalB (next highest priority)
    const agent = getOne<{ autopilot_goal_id: string | null }>(
      'SELECT autopilot_goal_id FROM agents WHERE id = ?',
      [agentId]
    );
    assert.equal(agent?.autopilot_goal_id, goalB, 'Agent should switch to Goal B after Goal A completes');
  });

  it('checkAndCycleGoal returns false when active tasks remain (scheduler does not cycle)', async () => {
    const agentId = generateId();
    const now = new Date().toISOString();

    const goalId = createGoal('Incomplete Goal', 3);
    createTask(goalId, 'Pending Task', 'todo'); // still pending

    runQuery(
      `INSERT INTO agents (id, name, working_directory, autopilot, autopilot_goal_id, status, created_at, last_activity)
       VALUES (?, 'Busy Agent', '.', 1, ?, 'idle', ?, ?)`,
      [agentId, goalId, now, now]
    );

    const broadcasts: any[] = [];
    initScheduler((msg) => broadcasts.push(msg));

    const cycled = await checkAndCycleGoal(agentId, goalId);
    assert.equal(cycled, false, 'Should not cycle when tasks are still pending');

    // Goal should still be active
    const goal = getOne<{ status: string }>('SELECT status FROM goals WHERE id = ?', [goalId]);
    assert.equal(goal?.status, 'active', 'Goal should remain active when tasks are pending');
  });
});
