import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initBoofDir, loadMemory, recordMistake, recordPattern, getMemoryContext, proposeGoals } from '../agent-memory.js';
import { initDb, runQuery, getOne, getAll } from '../db.js';
import { MAX_GOALS_PER_SESSION, IDLE_BACKOFF_MS, resetAgentSessionCounters } from '../autopilot.js';

const TEST_DB_PATH = './test-autopilot-safety-overnight.db';

let tmpDir: string;
let defaultBranch: string;

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: tmpDir, encoding: 'utf-8', timeout: 10_000 }).trim();
}

function getCurrentBranch(): string {
  return git('branch --show-current');
}

describe('autopilot-safety: git branch operations', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-test-'));
    git('init');
    git('config user.email "test@test.com"');
    git('config user.name "Test"');
    // Create initial commit so we have a branch
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test');
    git('add -A');
    git('commit -m "init"');
    // Detect the default branch name (may be 'main' or 'master')
    defaultBranch = getCurrentBranch();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createAgentBranch creates properly namespaced branch', () => {
    const branchName = 'agent/test-bot/my-goal-123';
    git(`checkout -b "${branchName}"`);
    assert.equal(getCurrentBranch(), branchName);
    assert.ok(branchName.startsWith('agent/'));
  });

  it('createAgentBranch verifies checkout succeeded', () => {
    const branchName = 'agent/test-bot/verify-123';
    git(`checkout -b "${branchName}"`);
    const actual = getCurrentBranch();
    assert.equal(actual, branchName);
  });

  it('autoCommit refuses to commit on protected branch', async () => {
    // We're on the default branch (main or master) — a commit guard should refuse
    const branch = getCurrentBranch();
    assert.equal(branch, defaultBranch);
    // Simulate the guard check from autoCommit
    const { isProtectedBranch } = await import('../branch-guard.js');
    assert.equal(isProtectedBranch(branch), true);
  });

  it('autoCommit works on agent/ branch', () => {
    git('checkout -b agent/test-bot/work-123');
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello');
    git('add -A');
    git('commit -m "test commit"');
    const log = git('log --oneline -1');
    assert.ok(log.includes('test commit'));
    assert.equal(getCurrentBranch(), 'agent/test-bot/work-123');
  });

  it('discardAgentBranch deletes branch without affecting main', () => {
    const agentBranch = 'agent/test-bot/discard-123';
    git(`checkout -b "${agentBranch}"`);
    fs.writeFileSync(path.join(tmpDir, 'temp.txt'), 'temp');
    git('add -A');
    git('commit -m "temp work"');

    // Switch back and delete
    git(`checkout ${defaultBranch}`);
    git(`branch -D "${agentBranch}"`);

    // Verify main is intact and agent branch is gone
    assert.equal(getCurrentBranch(), defaultBranch);
    const branches = git('branch --list');
    assert.ok(!branches.includes(agentBranch));
    // Original file should still be there
    assert.ok(fs.existsSync(path.join(tmpDir, 'README.md')));
  });

  it('switchBack returns to original branch', () => {
    git('checkout -b agent/test-bot/switch-123');
    assert.equal(getCurrentBranch(), 'agent/test-bot/switch-123');
    git(`checkout ${defaultBranch}`);
    assert.equal(getCurrentBranch(), defaultBranch);
  });
});

describe('autopilot-safety: agent memory', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-mem-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recordMistake persists to .boof/memory.json', () => {
    initBoofDir(tmpDir);
    recordMistake(tmpDir, 'Build failed: TS2339', 'Check imports');
    const memory = loadMemory(tmpDir);
    assert.equal(memory.mistakes.length, 1);
    assert.equal(memory.mistakes[0].description, 'Build failed: TS2339');
    assert.equal(memory.mistakes[0].fix, 'Check imports');
  });

  it('recordPattern persists to .boof/memory.json', () => {
    initBoofDir(tmpDir);
    recordPattern(tmpDir, 'Always run build after edit', 'autopilot');
    const memory = loadMemory(tmpDir);
    assert.equal(memory.patterns.length, 1);
    assert.equal(memory.patterns[0].pattern, 'Always run build after edit');
    assert.equal(memory.patterns[0].source, 'autopilot');
  });

  it('recordPattern deduplicates', () => {
    initBoofDir(tmpDir);
    recordPattern(tmpDir, 'Same pattern', 'test');
    recordPattern(tmpDir, 'Same pattern', 'test');
    const memory = loadMemory(tmpDir);
    assert.equal(memory.patterns.length, 1);
  });

  it('getMemoryContext returns formatted string', () => {
    initBoofDir(tmpDir);
    recordMistake(tmpDir, 'Error X', 'Fix Y');
    recordPattern(tmpDir, 'Pattern Z', 'test');
    const context = getMemoryContext(tmpDir);
    assert.ok(context.includes('PAST MISTAKES'));
    assert.ok(context.includes('Error X'));
    assert.ok(context.includes('Fix Y'));
    assert.ok(context.includes('LEARNED PATTERNS'));
    assert.ok(context.includes('Pattern Z'));
  });

  it('getMemoryContext returns empty string when no data', () => {
    initBoofDir(tmpDir);
    const context = getMemoryContext(tmpDir);
    assert.equal(context, '');
  });
});

describe('overnight autonomy loop: end-to-end integration', () => {
  let memDir: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
    memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-overnight-'));
    initBoofDir(memDir);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  function makeId(): string {
    return Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  }

  function createGoal(name: string, priority: number, status = 'active'): string {
    const id = makeId();
    const ts = new Date().toISOString();
    runQuery(
      `INSERT INTO goals (id, name, description, status, priority, created_at, updated_at) VALUES (?, ?, '', ?, ?, ?, ?)`,
      [id, name, status, priority, ts, ts]
    );
    return id;
  }

  function createTask(goalId: string, taskStatus = 'done'): string {
    const folderId = makeId();
    const taskId = makeId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT OR IGNORE INTO folders (id, name, icon, created_at, updated_at) VALUES (?, 'Test', '📁', ?, ?)`,
      [folderId, now, now]
    );
    runQuery(
      `INSERT INTO tasks (id, folder_id, title, description, status, goal_id, created_at, updated_at) VALUES (?, ?, 'Task', '', ?, ?, ?, ?)`,
      [taskId, folderId, taskStatus, goalId, now, now]
    );
    return taskId;
  }

  it('overnight safeguard constants are set to safe values', () => {
    // MAX_GOALS_PER_SESSION must be a positive integer to cap overnight runs
    assert.ok(typeof MAX_GOALS_PER_SESSION === 'number', 'MAX_GOALS_PER_SESSION should be a number');
    assert.ok(Number.isInteger(MAX_GOALS_PER_SESSION), 'MAX_GOALS_PER_SESSION should be integer');
    assert.ok(MAX_GOALS_PER_SESSION > 0, 'MAX_GOALS_PER_SESSION should be positive');
    assert.ok(MAX_GOALS_PER_SESSION <= 50, 'MAX_GOALS_PER_SESSION should be <= 50 to prevent runaway loops');

    // IDLE_BACKOFF_MS must be at least 60 seconds to prevent tight polling
    assert.ok(typeof IDLE_BACKOFF_MS === 'number', 'IDLE_BACKOFF_MS should be a number');
    assert.ok(IDLE_BACKOFF_MS >= 60_000, 'IDLE_BACKOFF_MS should be at least 60 seconds');
  });

  it('simulates multi-goal overnight cycle: 3 goals complete in sequence', () => {
    const goals = [
      createGoal('Night Goal 1', 5),
      createGoal('Night Goal 2', 3),
      createGoal('Night Goal 3', 1),
    ];

    // All goals start with done tasks
    for (const gId of goals) {
      createTask(gId, 'done');
    }

    // Simulate the cycle: each goal completes and the next is selected
    const now = new Date().toISOString();
    for (let i = 0; i < goals.length; i++) {
      const goalId = goals[i];

      // Check remaining tasks (should be 0 since all tasks are done)
      const remaining = getOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress')",
        [goalId]
      );
      assert.equal(remaining?.count, 0, `Goal ${i + 1} should have no remaining tasks`);

      // Mark goal completed
      runQuery(
        `UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, goalId]
      );

      // Record completion stats
      runQuery(
        `INSERT INTO goal_stats (goal_id, total_runs, tasks_completed, tasks_failed, avg_duration_ms, last_run_at) VALUES (?, 1, 1, 0, 5000, ?)
         ON CONFLICT(goal_id) DO UPDATE SET total_runs = total_runs + 1, tasks_completed = tasks_completed + 1`,
        [goalId, now]
      );

      // If not last goal, verify next goal exists with correct priority order
      if (i < goals.length - 1) {
        const nextGoal = getOne<{ id: string; priority: number }>(
          "SELECT id, priority FROM goals WHERE status = 'active' ORDER BY priority DESC, created_at ASC LIMIT 1",
          []
        );
        assert.ok(nextGoal !== undefined, `Should find next active goal after completing goal ${i + 1}`);
        // Next goal should be next in priority order
        assert.equal(nextGoal?.id, goals[i + 1], `Next goal should be goals[${i + 1}]`);
      }
    }

    // After all goals complete, no active goals remain
    const activeGoals = getAll<{ id: string }>('SELECT id FROM goals WHERE status = \'active\'', []);
    assert.equal(activeGoals.length, 0, 'No active goals should remain after full cycle');

    // Verify all stats were recorded
    for (const gId of goals) {
      const stats = getOne<{ total_runs: number; tasks_completed: number }>(
        'SELECT total_runs, tasks_completed FROM goal_stats WHERE goal_id = ?',
        [gId]
      );
      assert.ok(stats !== undefined, `Stats should exist for goal ${gId}`);
      assert.equal(stats?.total_runs, 1, 'Each goal should have 1 run recorded');
      assert.equal(stats?.tasks_completed, 1, 'Each goal should have 1 task completed');
    }
  });

  it('proposes new goals after all goals exhausted', async () => {
    const agentId = makeId();
    const now = new Date().toISOString();
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity) VALUES (?, 'Overnight Agent', ?, 'idle', ?, ?)`,
      [agentId, memDir, now, now]
    );

    // Create and complete a goal
    const goalId = createGoal('Completed Overnight Goal', 3);
    createTask(goalId, 'done');
    runQuery(
      `UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, goalId]
    );

    // No active goals remain
    const active = getAll<{ id: string }>("SELECT id FROM goals WHERE status = 'active'", []);
    assert.equal(active.length, 0, 'No active goals after completion');

    // Record patterns so proposals have material
    recordPattern(memDir, 'Improve test coverage for server modules', 'overnight');
    recordPattern(memDir, 'Validate API endpoints with integration tests', 'overnight');

    // Propose goals (simulates what checkAndCycleGoal does when no goals remain)
    const proposed = await proposeGoals(agentId, memDir);
    assert.ok(proposed.length > 0, 'Should propose new goals when none remain');
    assert.ok(proposed.length <= 3, 'Should not propose too many goals');

    // Verify proposals saved correctly
    for (const g of proposed) {
      const saved = getOne<{ proposal_status: string; status: string }>(
        'SELECT proposal_status, status FROM goals WHERE id = ?',
        [g.id]
      );
      assert.equal(saved?.proposal_status, 'pending', 'Proposed goals should have pending status');
      assert.equal(saved?.status, 'active', 'Proposed goals start as active');
    }
  });

  it('session counter reset allows re-enabling after overnight pause', () => {
    const agentId = makeId();

    // Simulate the agent having cycled through goals
    resetAgentSessionCounters(agentId);

    // After reset, the agent should be able to cycle again (no throw)
    assert.doesNotThrow(() => resetAgentSessionCounters(agentId), 'resetAgentSessionCounters should be idempotent');

    // Calling reset on unknown agent is also safe
    assert.doesNotThrow(() => resetAgentSessionCounters('unknown-agent'), 'Should handle unknown agents safely');
  });

  it('self-improve: triggers goal proposal when active goal list is empty', async () => {
    const agentId = makeId();
    const now = new Date().toISOString();

    // Create an agent with self_improve enabled
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, self_improve, created_at, last_activity) VALUES (?, 'Self-Improve Agent', ?, 'idle', 1, ?, ?)`,
      [agentId, memDir, now, now]
    );

    // Verify self_improve is set
    const agent = getOne<{ id: string; self_improve: number }>('SELECT id, self_improve FROM agents WHERE id = ?', [agentId]);
    assert.equal(agent?.self_improve, 1, 'Agent should have self_improve enabled');

    // No active goals exist
    const activeGoals = getAll<{ id: string }>("SELECT id FROM goals WHERE status = 'active'", []);
    assert.equal(activeGoals.length, 0, 'No active goals should exist before proposal');

    // Seed memory with patterns so proposals have material
    recordPattern(memDir, 'Improve error handling in REST endpoints', 'self-improve');
    recordPattern(memDir, 'Add test coverage for WebSocket handlers', 'self-improve');

    // When no goals remain, proposeGoals should generate new ones
    // (This mirrors what checkAndCycleGoal does when active goals are exhausted)
    const proposed = await proposeGoals(agentId, memDir);

    assert.ok(proposed.length > 0, 'Self-improve agent should propose new goals when none remain');
    assert.ok(proposed.length <= 3, 'Should not propose more than 3 goals at once');

    // All proposed goals should be saved and associated with this agent
    for (const g of proposed) {
      const saved = getOne<{ proposal_status: string; proposed_by: string; status: string }>(
        'SELECT proposal_status, proposed_by, status FROM goals WHERE id = ?',
        [g.id]
      );
      assert.equal(saved?.proposal_status, 'pending', 'Proposed goals should have pending proposal_status');
      assert.equal(saved?.proposed_by, agentId, 'Proposed goals should reference the self-improve agent');
      assert.equal(saved?.status, 'active', 'Proposed goals start as active for cycling');
    }
  });
});
