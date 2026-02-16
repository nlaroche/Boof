/**
 * Test that the autopilot NEVER does a bare `git checkout main` (or any
 * protected branch) outside of the mergeToMain function.
 *
 * This is a static analysis test — it reads the source code and verifies
 * the invariant structurally. No git repos needed.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOPILOT_PATH = path.resolve(__dirname, '..', 'autopilot.ts');
const source = fs.readFileSync(AUTOPILOT_PATH, 'utf-8');

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
    const lines = source.split('\n');
    const violations: string[] = [];

    let currentFunction = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Track which function we're in
      const funcMatch = line.match(/(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) currentFunction = funcMatch[1];

      // Check for git checkout commands
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

  it('createAgentBranch should always branch from main', () => {
    // Find the createAgentBranch function body
    const funcStart = source.indexOf('async function createAgentBranch');
    assert.ok(funcStart >= 0, 'createAgentBranch not found');

    // Find the checkout command within it
    const funcBody = source.slice(funcStart, funcStart + 2000);
    const checkoutMatch = funcBody.match(/git checkout -b.*?main/);
    assert.ok(
      checkoutMatch,
      'createAgentBranch should use `git checkout -b "..." main` to branch from main'
    );
  });

  it('mergeToMain should commit uncommitted work before checkout', () => {
    const funcStart = source.indexOf('async function mergeToMain');
    assert.ok(funcStart >= 0, 'mergeToMain not found');

    const funcBody = source.slice(funcStart, funcStart + 2000);
    const commitBeforeCheckout = funcBody.indexOf('git add -A') < funcBody.indexOf('git checkout main');
    assert.ok(
      commitBeforeCheckout,
      'mergeToMain should commit/stash before checking out main'
    );
  });

  it('mergeToMain should return to agent branch on merge failure', () => {
    const funcStart = source.indexOf('async function mergeToMain');
    assert.ok(funcStart >= 0, 'mergeToMain not found');

    const funcBody = source.slice(funcStart, funcStart + 2000);
    assert.ok(
      funcBody.includes('git merge --abort') && funcBody.includes('git checkout "${branchName}"'),
      'mergeToMain should abort the merge and return to agent branch on failure'
    );
  });

  it('abandonBranch should not do any git operations', () => {
    const funcStart = source.indexOf('function abandonBranch');
    assert.ok(funcStart >= 0, 'abandonBranch not found');

    const funcBody = source.slice(funcStart, funcStart + 500);
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
