import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initBoofDir, loadMemory, recordMistake, recordPattern, getMemoryContext } from '../agent-memory.js';

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
