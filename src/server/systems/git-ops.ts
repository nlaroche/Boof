/**
 * Git operations for autopilot — branch management, merging, diffing.
 *
 * Extracted from autopilot.ts to keep git operations in one focused module.
 * These are internal to the autopilot system (not exported to ws-handler).
 */
import { execSync } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isProtectedBranch } from '../branch-guard.js';
import { Timeouts, Limits } from '../engine/constants.js';

const execAsync = promisify(exec);

/**
 * Detect the default branch for a repo (main, develop, master, etc.)
 */
export function getDefaultBranch(cwd: string): string {
  try {
    return execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd, encoding: 'utf-8', timeout: 5_000 })
      .trim().replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: check if develop or main exists
    try {
      execSync('git rev-parse --verify develop', { cwd, timeout: 5_000 });
      return 'develop';
    } catch {
      return 'main';
    }
  }
}

/**
 * Check if a working directory has uncommitted changes.
 * Ignores .boof/ and boof.db (our own files).
 */
export async function hasUncommittedChanges(workingDirectory: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: workingDirectory,
      timeout: Timeouts.GIT_QUICK,
    });
    const significant = stdout
      .split('\n')
      .filter((line) => line.trim() && !line.includes('.boof/'))
      .filter((line) => line.trim() && !line.includes('boof.db'));
    return significant.length > 0;
  } catch {
    return false;
  }
}

/** Get the current branch name. Throws if detached HEAD. */
export async function getCurrentBranch(workingDirectory: string): Promise<string> {
  const { stdout } = await execAsync('git branch --show-current', {
    cwd: workingDirectory,
    timeout: Timeouts.GIT_QUICK,
  });
  const branch = stdout.trim();
  if (!branch) {
    throw new Error('Could not determine current branch (detached HEAD or git failure)');
  }
  return branch;
}

/** Slugify text for use in branch names and file paths. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, Limits.MAX_SLUG_LENGTH);
}

/**
 * Create a new agent branch in a worktree, branching from main.
 * Returns the new branch name.
 */
export async function createAgentBranch(
  worktreePath: string,
  agentName: string,
  goalSlug: string
): Promise<string> {
  const timestamp = Date.now();
  const branchName = `agent/${slugify(agentName)}/${goalSlug}-${timestamp}`;
  const base = getDefaultBranch(worktreePath);
  await execAsync(`git checkout -b "${branchName}" origin/${base}`, {
    cwd: worktreePath,
    timeout: Timeouts.GIT_CHECKOUT,
  });
  // Verify we're on the new branch
  const { stdout } = await execAsync('git branch --show-current', {
    cwd: worktreePath,
    timeout: Timeouts.GIT_QUICK,
  });
  const actual = stdout.trim();
  if (actual !== branchName) {
    throw new Error(`Branch creation failed: expected "${branchName}", got "${actual}"`);
  }
  console.log(`[git-ops] Created branch: ${branchName} (from origin/${base}) in worktree ${worktreePath}`);
  return branchName;
}

/** Log that we're abandoning a branch. Does not delete it. */
export function abandonBranch(branchName: string, reason: string): void {
  console.log(`[git-ops] Abandoning branch ${branchName}: ${reason}`);
}

/**
 * Merge an agent branch into main.
 * Commits any uncommitted work in the worktree first,
 * then merges from the main repo dir.
 */
export async function mergeToMain(
  mainRepoDir: string,
  worktreePath: string,
  branchName: string
): Promise<{ success: boolean; output: string }> {
  try {
    // Commit any uncommitted agent work
    await execAsync('git add -A && git diff --cached --quiet || git commit -m "WIP: uncommitted agent work"', {
      cwd: worktreePath,
      timeout: Timeouts.GIT_CHECKOUT,
    }).catch(() => {});

    const base = getDefaultBranch(mainRepoDir);
    // Merge from the main repo dir
    const { stdout, stderr } = await execAsync(
      `git checkout ${base} && git merge --no-ff "${branchName}" -m "Merge ${branchName}"`,
      { cwd: mainRepoDir, timeout: Timeouts.GIT_MERGE }
    );

    // Delete the merged branch
    await execAsync(`git branch -d "${branchName}"`, {
      cwd: mainRepoDir,
      timeout: Timeouts.GIT_QUICK,
    }).catch(() => {});

    // Return worktree to detached HEAD at base
    await execAsync(`git checkout --detach ${base}`, {
      cwd: worktreePath,
      timeout: Timeouts.GIT_CHECKOUT,
    }).catch(() => {});

    return { success: true, output: stdout + stderr };
  } catch (err: any) {
    await execAsync('git merge --abort', { cwd: mainRepoDir, timeout: Timeouts.GIT_QUICK }).catch(() => {});
    return { success: false, output: err.stderr || err.stdout || String(err) };
  }
}

/** List all agent branches for a given working directory. */
export async function listAgentBranches(workingDirectory: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git branch --list "agent/*"', {
      cwd: workingDirectory,
      timeout: Timeouts.GIT_QUICK,
    });
    return stdout
      .split('\n')
      .map(b => b.trim().replace(/^\*\s*/, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── Worktree Management ──

/**
 * Create a git worktree for an agent with a symlinked node_modules.
 * Returns the worktree path on success, null on failure.
 */
export function createWorktree(
  workingDirectory: string,
  agentName: string,
  agentId: string,
): string | null {
  try {
    const safeName = (agentName || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, Limits.MAX_SAFE_NAME_LENGTH);
    const worktreePath = path.join(workingDirectory + '-agents', `${safeName}-${agentId.slice(0, 8)}`);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const base = getDefaultBranch(workingDirectory);
    execSync(`git worktree add --detach "${worktreePath}" ${base}`, {
      cwd: workingDirectory,
      timeout: Timeouts.GIT_CHECKOUT,
    });

    // Symlink node_modules into worktree
    const srcModules = path.join(workingDirectory, 'node_modules');
    const dstModules = path.join(worktreePath, 'node_modules');
    if (fs.existsSync(srcModules) && !fs.existsSync(dstModules)) {
      if (process.platform === 'win32') {
        execSync(`cmd /c mklink /J "${dstModules}" "${srcModules}"`, { timeout: Timeouts.JUNCTION });
      } else {
        fs.symlinkSync(srcModules, dstModules, 'dir');
      }
    }

    console.log(`[git-ops] Worktree created at ${worktreePath}`);
    return worktreePath;
  } catch (err: any) {
    console.error(`[git-ops] Failed to create worktree:`, err.message || err);
    return null;
  }
}

/**
 * Remove a git worktree and its node_modules junction.
 */
export function removeWorktree(
  workingDirectory: string,
  worktreePath: string,
): boolean {
  try {
    // Remove node_modules symlink/junction first — git worktree remove can't delete junctions on Windows
    const junctionPath = path.join(worktreePath, 'node_modules');
    try {
      const stat = fs.lstatSync(junctionPath);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        if (process.platform === 'win32') {
          execSync(`cmd /c rmdir "${junctionPath}"`, { timeout: Timeouts.GIT_QUICK });
        } else {
          fs.unlinkSync(junctionPath);
        }
      }
    } catch { /* symlink doesn't exist, fine */ }

    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: workingDirectory,
      timeout: Timeouts.GIT_CHECKOUT,
    });
    console.log(`[git-ops] Worktree removed: ${worktreePath}`);
    return true;
  } catch (err: any) {
    console.error(`[git-ops] Failed to remove worktree:`, err.message || err);
    return false;
  }
}

/**
 * Auto-commit changes on an agent branch.
 * Refuses to commit on protected or non-agent branches.
 * Returns diff stats on success, empty string on failure.
 */
export async function autoCommit(
  workingDirectory: string,
  goalSlug: string,
  summary: string
): Promise<string> {
  try {
    const { stdout: branchOut } = await execAsync('git branch --show-current', {
      cwd: workingDirectory,
      timeout: Timeouts.GIT_QUICK,
    });
    const currentBranch = branchOut.trim();
    if (isProtectedBranch(currentBranch)) {
      console.error(`[git-ops] Refusing to commit on protected branch: ${currentBranch}`);
      return '';
    }
    if (!currentBranch.startsWith('agent/')) {
      console.error(`[git-ops] Refusing to commit on non-agent branch: ${currentBranch}`);
      return '';
    }
    await execAsync('git add -A', { cwd: workingDirectory, timeout: Timeouts.GIT_CHECKOUT });
    const msg = `agent(${goalSlug}): ${summary.slice(0, Limits.MAX_COMMIT_MSG_LENGTH)}`.replace(/"/g, '\\"');
    await execAsync(`git commit -m "${msg}"`, {
      cwd: workingDirectory,
      timeout: Timeouts.GIT_CHECKOUT,
    });
    const { stdout } = await execAsync('git diff --stat HEAD~1', {
      cwd: workingDirectory,
      timeout: Timeouts.GIT_CHECKOUT,
    });
    return stdout.trim();
  } catch (err: any) {
    return err.stdout || '';
  }
}
