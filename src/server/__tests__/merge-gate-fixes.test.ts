/**
 * Tests for the merge-gate integrity fixes:
 *  - C3: parseReviewOutput fails closed (no VERDICT ⇒ changes_requested/0)
 *  - H6: withRepoLock serializes concurrent same-repo git mutations
 *  - H2: branch listing strips worktree markers (`*` current, `+` elsewhere)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseReviewOutput } from '../systems/review-agent.js';
import { withRepoLock, listAgentBranches, listGoalBranches } from '../systems/git-ops.js';

// ── C3: parseReviewOutput fails closed ──────────────────────────────────────

describe('parseReviewOutput (fail closed — C3)', () => {
  it('defaults to changes_requested / score 0 when no VERDICT line parses', () => {
    const result = parseReviewOutput('the review agent crashed and printed garbage');
    assert.equal(result.verdict, 'changes_requested');
    assert.equal(result.score, 0);
    assert.ok(result.findings.length >= 1, 'should surface an unparseable finding');
    assert.match(result.summary, /unparseable/i);
  });

  it('treats empty output as changes_requested, not approval', () => {
    const result = parseReviewOutput('');
    assert.equal(result.verdict, 'changes_requested');
    assert.equal(result.score, 0);
  });

  it('honors an explicit approval verdict', () => {
    const result = parseReviewOutput('VERDICT: approve\nSCORE: 88\nSUMMARY: looks good');
    assert.equal(result.verdict, 'approve');
    assert.equal(result.score, 88);
  });

  it('honors an explicit changes_requested verdict without inventing a score', () => {
    const result = parseReviewOutput('VERDICT: changes_requested\nSCORE: 40\nSUMMARY: fix stuff');
    assert.equal(result.verdict, 'changes_requested');
    assert.equal(result.score, 40);
  });

  it('honors an explicit reject verdict', () => {
    const result = parseReviewOutput('VERDICT: reject\nSCORE: 5\nSUMMARY: broken');
    assert.equal(result.verdict, 'reject');
    assert.equal(result.score, 5);
  });
});

// ── H6: per-repo async mutex ────────────────────────────────────────────────

describe('withRepoLock (per-repo mutex — H6)', () => {
  it('serializes concurrent operations on the same repo (no interleaving)', async () => {
    const events: string[] = [];
    const key = path.join(os.tmpdir(), 'boof-lock-A');
    const op = (id: string, delay: number) =>
      withRepoLock(key, async () => {
        events.push(`${id}:start`);
        await new Promise((r) => setTimeout(r, delay));
        events.push(`${id}:end`);
        return id;
      });

    // 'a' starts first with the longest delay; if the lock works, b and c wait.
    const results = await Promise.all([op('a', 40), op('b', 5), op('c', 5)]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('does not block operations on different repos', async () => {
    let aDone = false;
    let bDone = false;
    await Promise.all([
      withRepoLock(path.join(os.tmpdir(), 'boof-lock-X'), async () => { aDone = true; }),
      withRepoLock(path.join(os.tmpdir(), 'boof-lock-Y'), async () => { bDone = true; }),
    ]);
    assert.ok(aDone && bDone);
  });

  it('a rejected holder does not wedge the chain', async () => {
    const key = path.join(os.tmpdir(), 'boof-lock-Z');
    await assert.rejects(withRepoLock(key, async () => { throw new Error('boom'); }), /boom/);
    const res = await withRepoLock(key, async () => 'ok');
    assert.equal(res, 'ok');
  });
});

// ── H2: branch listing strips worktree markers ──────────────────────────────

describe('branch listing strips worktree markers (H2)', () => {
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-branches-'));
    execSync('git init', { cwd: repo });
    execSync('git config user.email "t@example.com"', { cwd: repo });
    execSync('git config user.name "T"', { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
    execSync('git add -A', { cwd: repo });
    execSync('git commit -m init', { cwd: repo });
    // Current branch (whatever init named it) plus goal/agent branches.
    execSync('git branch "goal/my-goal"', { cwd: repo });
    execSync('git branch "agent/alice/my-goal-123"', { cwd: repo });
  });

  it('returns clean names even when a branch is checked out in a worktree (+ marker)', async () => {
    // Check out the agent branch in a linked worktree → main repo shows `+ agent/...`.
    worktree = repo + '-wt';
    execSync(`git worktree add "${worktree}" "agent/alice/my-goal-123"`, { cwd: repo });

    const agents = await listAgentBranches(repo);
    assert.ok(agents.includes('agent/alice/my-goal-123'),
      `expected clean agent branch name, got: ${JSON.stringify(agents)}`);
    // No decoration should leak into any name.
    for (const b of agents) {
      assert.ok(!/[*+]/.test(b) && !b.includes(' '), `branch name has a marker/space: "${b}"`);
    }
  });

  it('lists goal branches without markers', async () => {
    const goals = await listGoalBranches(repo);
    assert.deepEqual(goals, ['goal/my-goal']);
  });
});
