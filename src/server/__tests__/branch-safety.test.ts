/**
 * Test that the autopilot NEVER does a bare `git checkout main` (or any
 * protected branch) outside of the mergeToMain function.
 *
 * This is a static analysis test — it reads the source code and verifies
 * the invariant structurally. No git repos needed.
 *
 * Git operations live in systems/git-ops.ts (extracted from autopilot.ts).
 * Autopilot.ts delegates to git-ops.ts for all git branch operations.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOPILOT_PATH = path.resolve(__dirname, '..', 'autopilot.ts');
const GIT_OPS_PATH = path.resolve(__dirname, '..', 'systems', 'git-ops.ts');
const source = fs.readFileSync(AUTOPILOT_PATH, 'utf-8');
const gitOpsSource = fs.readFileSync(GIT_OPS_PATH, 'utf-8');

describe('autopilot branch safety', () => {

  it('should not contain switchBack function', () => {
    assert.ok(
      !source.includes('async function switchBack'),
      'switchBack function still exists — it should be deleted'
    );
  });

  it('should not contain discardAgentBranch function', () => {
    assert.ok(
      !source.includes('async function discardAgentBranch'),
      'discardAgentBranch function still exists — it should be deleted'
    );
  });

  it('should not reference originalBranch anywhere', () => {
    // Allow it in comments but not in code
    const codeLines = source.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const hasOriginalBranch = codeLines.some(l => l.includes('originalBranch'));
    assert.ok(!hasOriginalBranch, 'originalBranch variable still referenced in code');
  });

  it('should only have git checkout in createAgentBranch and mergeToMain', () => {
    // Git operations are in git-ops.ts — check both files
    const allSource = source + '\n' + gitOpsSource;
    const lines = allSource.split('\n');
    const violations: string[] = [];

    let currentFunction = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const funcMatch = line.match(/(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) currentFunction = funcMatch[1];

      if (line.includes('git checkout') && !line.trim().startsWith('//')) {
        const allowed = ['createAgentBranch', 'mergeToMain'];
        if (!allowed.includes(currentFunction)) {
          violations.push(`Line ${i + 1} in ${currentFunction || 'unknown'}: ${line.trim()}`);
        }
      }
    }

    assert.deepStrictEqual(
      violations, [],
      `Found git checkout outside allowed functions:\n${violations.join('\n')}`
    );
  });

  it('createAgentBranch should branch from the resolved default branch', () => {
    // Function is now in git-ops.ts. Git ops use execFile arg arrays (M10), so
    // the branch is created with a `checkout -b` on a base derived from the
    // repo's default branch (resolveBaseRef falls back to a local branch when
    // there is no origin remote — M9), not a hardcoded `origin/main`.
    const funcStart = gitOpsSource.indexOf('export async function createAgentBranch');
    assert.ok(funcStart >= 0, 'createAgentBranch not found in git-ops.ts');

    const funcBody = gitOpsSource.slice(funcStart, funcStart + 2000);
    assert.ok(
      /'checkout',\s*'-b'/.test(funcBody),
      'createAgentBranch should use `checkout -b` (execFile arg array) to create the branch'
    );
    assert.ok(
      funcBody.includes('getDefaultBranch(worktreePath)') && funcBody.includes('resolveBaseRef'),
      'createAgentBranch should derive its base from the default branch via resolveBaseRef'
    );
  });

  it('mergeToMain should commit uncommitted work before detaching', () => {
    // Function is now in git-ops.ts (execFile arg arrays — M10).
    const funcStart = gitOpsSource.indexOf('export async function mergeToMain');
    assert.ok(funcStart >= 0, 'mergeToMain not found in git-ops.ts');

    const funcBody = gitOpsSource.slice(funcStart, funcStart + 2000);
    const addIdx = funcBody.indexOf("'add', '-A'");
    const detachIdx = funcBody.indexOf("'checkout', '--detach'");
    assert.ok(addIdx >= 0 && detachIdx >= 0 && addIdx < detachIdx,
      'mergeToMain should stage/commit work before returning the worktree to detached HEAD');
  });

  it('mergeToMain should abort the merge on failure', () => {
    // Function is now in git-ops.ts (execFile arg arrays — M10).
    const funcStart = gitOpsSource.indexOf('export async function mergeToMain');
    assert.ok(funcStart >= 0, 'mergeToMain not found in git-ops.ts');

    const funcBody = gitOpsSource.slice(funcStart, funcStart + 3500);
    assert.ok(
      /'merge',\s*'--abort'/.test(funcBody),
      'mergeToMain should abort the merge on failure'
    );
  });

  it('abandonBranch should not do any git operations', () => {
    // Function is now in git-ops.ts
    const funcStart = gitOpsSource.indexOf('export function abandonBranch');
    assert.ok(funcStart >= 0, 'abandonBranch not found in git-ops.ts');

    const funcBody = gitOpsSource.slice(funcStart, funcStart + 500);
    const funcEnd = funcBody.indexOf('\n}');
    const body = funcBody.slice(0, funcEnd);

    assert.ok(!body.includes('execAsync'), 'abandonBranch should not run any git commands');
    assert.ok(!body.includes('git '), 'abandonBranch should not run any git commands');
  });

  it('should have zero references to needsBranchIsolation', () => {
    assert.ok(
      !source.includes('needsBranchIsolation'),
      'needsBranchIsolation still referenced — all runs should create branches unconditionally'
    );
  });
});
