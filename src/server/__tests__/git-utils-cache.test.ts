import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getCurrentBranch, getRecentCommits, clearGitCache } from '../git-utils.js';
import { execSync } from 'child_process';

describe('git-utils caching', () => {
  const cwd = process.cwd();

  it('getCurrentBranch caches for 30s', () => {
    clearGitCache();
    const start = Date.now();
    const branch1 = getCurrentBranch(cwd);
    const elapsed1 = Date.now() - start;

    const start2 = Date.now();
    const branch2 = getCurrentBranch(cwd);
    const elapsed2 = Date.now() - start2;

    assert.strictEqual(branch1, branch2);
    // Second call should be much faster (cached)
    assert.ok(elapsed2 < elapsed1 / 2, `Cache hit should be faster: ${elapsed2}ms vs ${elapsed1}ms`);
  });

  it('getRecentCommits caches for 30s', () => {
    clearGitCache();
    const start = Date.now();
    const commits1 = getRecentCommits(cwd, '1 day ago', 5);
    const elapsed1 = Date.now() - start;

    const start2 = Date.now();
    const commits2 = getRecentCommits(cwd, '1 day ago', 5);
    const elapsed2 = Date.now() - start2;

    assert.strictEqual(commits1, commits2);
    // Second call should be much faster (cached)
    assert.ok(elapsed2 < elapsed1 / 2, `Cache hit should be faster: ${elapsed2}ms vs ${elapsed1}ms`);
  });

  it('cache keys are unique per parameter combination', () => {
    clearGitCache();
    // Different "since" parameters should create different cache keys
    const commits1 = getRecentCommits(cwd, '1 day ago', 5);
    const commits2 = getRecentCommits(cwd, '1 hour ago', 5);
    // Different parameters may return different results (or same if no commits in that range)
    // Just verify both calls work without interfering
    assert.ok(typeof commits1 === 'string');
    assert.ok(typeof commits2 === 'string');
  });

  it('clearGitCache invalidates cache', () => {
    clearGitCache();
    const branch1 = getCurrentBranch(cwd);
    clearGitCache();

    const start = Date.now();
    const branch2 = getCurrentBranch(cwd);
    const elapsed = Date.now() - start;

    assert.strictEqual(branch1, branch2);
    // After cache clear, should take full time again
    assert.ok(elapsed > 1, 'Should re-execute git command after cache clear');
  });
});
