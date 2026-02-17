import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDb, runQuery } from '../db.js';
import { getGoalLogCached, invalidateGoalLogCache, initBoofDir, recordPattern, getPatterns } from '../agent-memory.js';

const TEST_DB_PATH = './test-agent-memory.db';

let testIdCounter = 0;
function genTestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${testIdCounter++}`;
}

describe('agent-memory cache', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it('should cache goal_log queries', async () => {
    const goalId = genTestId('goal');
    const agentId = genTestId('agent');

    // Insert initial entries
    for (let i = 0; i < 3; i++) {
      runQuery(
        `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [genTestId('log'), goalId, agentId, 'test_action', `Summary ${i}`, new Date().toISOString()]
      );
    }

    // First call should hit DB
    const start1 = Date.now();
    const results1 = getGoalLogCached(goalId, 5);
    const duration1 = Date.now() - start1;

    // Second call should hit cache (much faster)
    const start2 = Date.now();
    const results2 = getGoalLogCached(goalId, 5);
    const duration2 = Date.now() - start2;

    assert.equal(results1.length, 3);
    assert.equal(results2.length, 3);
    assert.deepEqual(results1, results2);

    // Cache hit should be faster (though this might be flaky in fast environments)
    console.log(`DB call: ${duration1}ms, Cache hit: ${duration2}ms`);
  });

  it('should invalidate cache when requested', async () => {
    const goalId = genTestId('goal');
    const agentId = genTestId('agent');

    runQuery(
      `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [genTestId('log'), goalId, agentId, 'test', 'Initial', new Date().toISOString()]
    );

    // Prime the cache
    const results1 = getGoalLogCached(goalId, 5);
    assert.equal(results1.length, 1);

    // Add a new entry
    runQuery(
      `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [genTestId('log'), goalId, agentId, 'test', 'Second', new Date().toISOString()]
    );

    // Without invalidation, cache would still return 1 entry
    const cachedResults = getGoalLogCached(goalId, 5);
    assert.equal(cachedResults.length, 1, 'Cache should still have old data');

    // Invalidate and query again
    invalidateGoalLogCache(goalId);
    const freshResults = getGoalLogCached(goalId, 5);
    assert.equal(freshResults.length, 2, 'Should get fresh data after invalidation');
  });

  it('should handle different limits separately', async () => {
    const goalId = genTestId('goal');
    const agentId = genTestId('agent');

    for (let i = 0; i < 10; i++) {
      runQuery(
        `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [genTestId('log'), goalId, agentId, 'test', `Entry ${i}`, new Date().toISOString()]
      );
    }

    const limit5 = getGoalLogCached(goalId, 5);
    const limit10 = getGoalLogCached(goalId, 10);

    assert.equal(limit5.length, 5);
    assert.equal(limit10.length, 10);
  });

  it('should respect TTL and refresh after expiration', async (t) => {
    const goalId = genTestId('goal');
    const agentId = genTestId('agent');

    runQuery(
      `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [genTestId('log'), goalId, agentId, 'test', 'Initial', new Date().toISOString()]
    );

    // Prime cache
    const initial = getGoalLogCached(goalId, 5);
    assert.equal(initial.length, 1);

    // Add new entry
    runQuery(
      `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [genTestId('log'), goalId, agentId, 'test', 'Second', new Date().toISOString()]
    );

    // Still cached
    const stillCached = getGoalLogCached(goalId, 5);
    assert.equal(stillCached.length, 1);

    // Wait for TTL to expire (30 seconds)
    await new Promise(resolve => setTimeout(resolve, 31000));

    // Should get fresh data now
    const afterTTL = getGoalLogCached(goalId, 5);
    assert.equal(afterTTL.length, 2, 'Cache should auto-refresh after TTL');
  });
});

describe('agent-memory goal-pattern reinforcement', () => {
  let tmpDir: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-reinforcement-test-'));
    initBoofDir(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('completing a goal writes a reinforcement pattern entry', () => {
    const goalName = 'Add integration tests';
    const pattern = `Completed: "${goalName}" — modified src/server/__tests__/integration.test.ts`;

    // Simulate what autopilot does after a successful task: recordPattern
    recordPattern(tmpDir, pattern, 'autopilot');

    const patterns = getPatterns(tmpDir);
    assert.ok(patterns.length > 0, 'Should have at least one pattern after completion');
    const found = patterns.find(p => p.pattern === pattern);
    assert.ok(found !== undefined, 'Should find the completion reinforcement pattern');
    assert.equal(found?.source, 'autopilot', 'Pattern source should be autopilot');
  });

  it('getPatterns returns reinforcement entry on the next cycle', () => {
    // Simulate cycle 1: goal completes, reinforcement written
    const cycle1Pattern = 'Completed: "Goal A" — modified src/server/agent-memory.ts';
    recordPattern(tmpDir, cycle1Pattern, 'autopilot');

    // Simulate cycle 2: a new run reads patterns (fresh load from disk)
    const patternsOnNextCycle = getPatterns(tmpDir);
    assert.ok(patternsOnNextCycle.length >= 1, 'Next cycle should see the reinforcement entry');
    assert.ok(
      patternsOnNextCycle.some(p => p.pattern === cycle1Pattern),
      'Next cycle should return the pattern written in cycle 1'
    );
  });

  it('reinforcement patterns accumulate across multiple goal completions', () => {
    const goals = [
      'Completed: "Goal Alpha" — modified src/server/autopilot.ts',
      'Completed: "Goal Beta" — modified src/server/db.ts',
      'Completed: "Goal Gamma" — modified src/server/scheduler.ts',
    ];

    for (const goal of goals) {
      recordPattern(tmpDir, goal, 'autopilot');
    }

    const patterns = getPatterns(tmpDir);
    assert.equal(patterns.length, 3, 'Should have 3 reinforcement patterns');
    for (const goal of goals) {
      assert.ok(patterns.some(p => p.pattern === goal), `Should contain pattern: ${goal}`);
    }
  });

  it('duplicate goal completion patterns are not written twice', () => {
    const pattern = 'Completed: "Duplicate Goal" — modified src/server/utils.ts';

    // Record same pattern twice (simulating duplicate autopilot runs)
    recordPattern(tmpDir, pattern, 'autopilot');
    recordPattern(tmpDir, pattern, 'autopilot');

    const patterns = getPatterns(tmpDir);
    const matches = patterns.filter(p => p.pattern === pattern);
    assert.equal(matches.length, 1, 'Duplicate patterns should not be stored more than once');
  });

  it('getPatterns returns empty array when no patterns have been recorded', () => {
    // Fresh dir with initBoofDir but no patterns recorded
    const patterns = getPatterns(tmpDir);
    assert.ok(Array.isArray(patterns), 'Should return an array');
    assert.equal(patterns.length, 0, 'Should return empty array when no patterns recorded');
  });

  it('reinforcement entry has correct shape: pattern, source, learned_at', () => {
    const pattern = 'Completed: "Shape Test Goal" — modified src/server/ws-handler.ts';
    recordPattern(tmpDir, pattern, 'autopilot');

    const patterns = getPatterns(tmpDir);
    const entry = patterns.find(p => p.pattern === pattern);
    assert.ok(entry !== undefined, 'Should find the recorded pattern');
    assert.ok(typeof entry!.pattern === 'string' && entry!.pattern.length > 0, 'pattern should be non-empty string');
    assert.ok(typeof entry!.source === 'string' && entry!.source.length > 0, 'source should be non-empty string');
    assert.ok(typeof entry!.learned_at === 'string' && entry!.learned_at.length > 0, 'learned_at should be non-empty string');
    // learned_at should be a valid ISO timestamp
    assert.ok(!isNaN(Date.parse(entry!.learned_at)), 'learned_at should be a valid ISO timestamp');
  });
});
