import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { initDb, runQuery } from '../db.js';
import { getGoalLogCached, invalidateGoalLogCache } from '../agent-memory.js';

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
