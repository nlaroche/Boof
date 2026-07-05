/**
 * Git operations for autopilot — branch management, merging, diffing.
 *
 * Extracted from autopilot.ts to keep git operations in one focused module.
 * These are internal to the autopilot system (not exported to ws-handler).
 *
 * All operations that MUTATE the shared working tree / refs go through
 * `withRepoLock` (H6) so concurrent agents / consolidation / maintenance can
 * never race on `.git/index.lock` or check out the wrong branch underneath
 * each other.
 */
import { execSync, exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { isProtectedBranch } from '../branch-guard.js';
import { Timeouts, Limits } from '../engine/constants.js';
import { healMergeConflict } from './self-heal.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── Per-repo async mutex (H6) ──────────────────────────────────────────────
//
// Keyed by the git *common* directory so every worktree of the same repo
// shares one lock (worktrees share refs + object store). A simple promise
// chain serializes callers; failures in one holder never reject the next.

const repoLockKeyCache = new Map<string, string>();
const repoLocks = new Map<string, Promise<unknown>>();

function repoLockKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const cached = repoLockKeyCache.get(resolved);
  if (cached) return cached;
  let key = resolved;
  try {
    const common = execSync('git rev-parse --git-common-dir', {
      cwd, encoding: 'utf-8', timeout: Timeouts.GIT_QUICK,
    }).trim();
    key = path.isAbsolute(common) ? path.resolve(common) : path.resolve(cwd, common);
  } catch {
    // Not a git repo yet, or git unavailable — fall back to the path itself.
  }
  repoLockKeyCache.set(resolved, key);
  return key;
}

/**
 * Run `fn` with exclusive access to the repo's working tree/refs.
 * Exported so other modules (autopilot, ws-handler, command-lifecycle) can
 * route their own raw git mutations through the same lock.
 */
export function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = repoLockKey(repoPath);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  // Run fn regardless of whether the previous holder resolved or rejected.
  const run = prev.then(fn, fn);
  // Keep a settled-swallowing tail so waiters never see a prior rejection and
  // we never emit an unhandled rejection for the bookkeeping promise.
  repoLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

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
 * Resolve the base ref to branch from. Prefers the remote-tracking ref
 * (`origin/<branch>`) when it exists, but falls back to the local branch for
 * repos with no `origin` remote (M9) instead of hard-failing.
 */
async function resolveBaseRef(cwd: string, branch: string): Promise<string> {
  // If the caller already handed us a fully-qualified ref, trust it.
  if (branch.includes('/')) return branch;
  try {
    await execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `origin/${branch}`], {
      timeout: Timeouts.GIT_QUICK,
    });
    return `origin/${branch}`;
  } catch {
    return branch;
  }
}

/**
 * Find the worktree path that currently has `branch` checked out, if any.
 * Used to run rebases where the branch lives and to remove the worktree
 * before deleting a merged branch (H5).
 */
async function findWorktreeForBranch(mainRepoDir: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', mainRepoDir, 'worktree', 'list', '--porcelain'], {
      timeout: Timeouts.GIT_QUICK,
    });
    let currentPath: string | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        const name = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
        if (name === branch && currentPath) return currentPath;
      }
    }
    return null;
  } catch (err: any) {
    console.error(`[git-ops] findWorktreeForBranch failed: ${err.message || err}`);
    return null;
  }
}

/** Best-effort restore of the main repo to a known branch. */
async function restoreBranch(mainRepoDir: string, branch: string): Promise<void> {
  await execFileAsync('git', ['-C', mainRepoDir, 'checkout', branch], { timeout: Timeouts.GIT_CHECKOUT })
    .catch(e => console.error(`[git-ops] Failed to restore branch ${branch}: ${e.message || e}`));
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
  } catch (err: any) {
    console.error(`[git-ops] hasUncommittedChanges failed: ${err.message || err}`);
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
 * Create a new agent branch in a worktree, branching from the default branch.
 * Returns the new branch name.
 */
export async function createAgentBranch(
  worktreePath: string,
  agentName: string,
  goalSlug: string,
  baseBranch?: string,
): Promise<string> {
  return withRepoLock(worktreePath, async () => {
    const timestamp = Date.now();
    const branchName = `agent/${slugify(agentName)}/${goalSlug}-${timestamp}`;
    const base = baseBranch || await resolveBaseRef(worktreePath, getDefaultBranch(worktreePath));

    // Clean up any dirty state from a previous agent run.
    // Agent worktrees are disposable — uncommitted changes are leftovers from
    // a failed or interrupted run and safe to discard.
    try {
      const { stdout: status } = await execAsync('git status --porcelain', {
        cwd: worktreePath,
        timeout: Timeouts.GIT_QUICK,
      });
      if (status.trim()) {
        console.log(`[git-ops] Cleaning dirty worktree before branch creation (${status.trim().split('\n').length} files)`);
        await execAsync('git checkout -- .', { cwd: worktreePath, timeout: Timeouts.GIT_CHECKOUT });
        await execAsync('git clean -fd', { cwd: worktreePath, timeout: Timeouts.GIT_CHECKOUT });
      }
    } catch (cleanErr: any) {
      console.warn(`[git-ops] Worktree cleanup warning: ${cleanErr.message || cleanErr}`);
    }

    await execFileAsync('git', ['-C', worktreePath, 'checkout', '-b', branchName, base], {
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
    console.log(`[git-ops] Created branch: ${branchName} (from ${base}) in worktree ${worktreePath}`);
    return branchName;
  });
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
  return withRepoLock(mainRepoDir, async () => {
    // Commit any uncommitted agent work in the worktree.
    await execFileAsync('git', ['-C', worktreePath, 'add', '-A'], { timeout: Timeouts.GIT_CHECKOUT })
      .catch(e => console.warn(`[git-ops] mergeToMain: git add failed: ${e.message || e}`));
    try {
      // Exit 0 → nothing staged; exit 1 → staged changes to commit.
      await execFileAsync('git', ['-C', worktreePath, 'diff', '--cached', '--quiet'], { timeout: Timeouts.GIT_QUICK });
    } catch {
      await execFileAsync('git', ['-C', worktreePath, 'commit', '-m', 'WIP: uncommitted agent work'], { timeout: Timeouts.GIT_CHECKOUT })
        .catch(e => console.warn(`[git-ops] mergeToMain: WIP commit failed: ${e.message || e}`));
    }

    const base = getDefaultBranch(mainRepoDir);
    try {
      await execFileAsync('git', ['-C', mainRepoDir, 'checkout', base], { timeout: Timeouts.GIT_CHECKOUT });
      const { stdout, stderr } = await execFileAsync(
        'git', ['-C', mainRepoDir, 'merge', '--no-ff', branchName, '-m', `Merge ${branchName}`],
        { timeout: Timeouts.GIT_MERGE }
      );

      // Delete the merged branch
      await execFileAsync('git', ['-C', mainRepoDir, 'branch', '-d', branchName], { timeout: Timeouts.GIT_QUICK })
        .catch(e => console.warn(`[git-ops] mergeToMain: could not delete ${branchName}: ${e.message || e}`));

      // Return worktree to detached HEAD at base
      await execFileAsync('git', ['-C', worktreePath, 'checkout', '--detach', base], { timeout: Timeouts.GIT_CHECKOUT })
        .catch(e => console.warn(`[git-ops] mergeToMain: could not detach worktree: ${e.message || e}`));

      return { success: true, output: stdout + stderr };
    } catch (err: any) {
      await execFileAsync('git', ['-C', mainRepoDir, 'merge', '--abort'], { timeout: Timeouts.GIT_QUICK })
        .catch(e => console.error(`[git-ops] mergeToMain: merge --abort failed: ${e.message || e}`));
      return { success: false, output: err.stderr || err.stdout || String(err) };
    }
  });
}

// ── Goal Branch Operations ──

/**
 * Create a goal branch from the target branch.
 * Returns the branch name (goal/{goalSlug}).
 */
export async function createGoalBranch(
  cwd: string,
  goalSlug: string,
  targetBranch?: string,
): Promise<string> {
  return withRepoLock(cwd, async () => {
    const baseName = targetBranch || getDefaultBranch(cwd);
    const branchName = `goal/${slugify(goalSlug)}`;

    // Check if branch already exists
    try {
      await execFileAsync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', branchName], {
        timeout: Timeouts.GIT_QUICK,
      });
      console.log(`[git-ops] Goal branch already exists: ${branchName}`);
      return branchName;
    } catch {
      // Branch doesn't exist — create it
    }

    const base = await resolveBaseRef(cwd, baseName);
    await execFileAsync('git', ['-C', cwd, 'branch', branchName, base], {
      timeout: Timeouts.GIT_CHECKOUT,
    });

    console.log(`[git-ops] Created goal branch: ${branchName} (from ${base})`);
    return branchName;
  });
}

/** Remove a merged task branch, first removing its worktree if it has one (H5). */
async function deleteMergedTaskBranch(
  mainRepoDir: string,
  taskBranch: string,
  taskWorktree: string | null,
): Promise<void> {
  if (taskWorktree) {
    // The branch is merged into the goal branch (its work is safe), so we can
    // free the worktree to allow deletion. Maintenance would otherwise never be
    // able to clean it either (branch checked out → `git branch -d` refuses).
    console.log(`[git-ops] Removing worktree ${taskWorktree} so merged branch ${taskBranch} can be deleted`);
    removeWorktree(mainRepoDir, taskWorktree);
  }
  await execFileAsync('git', ['-C', mainRepoDir, 'branch', '-d', taskBranch], { timeout: Timeouts.GIT_QUICK })
    .catch(e => console.warn(`[git-ops] Could not delete merged branch ${taskBranch} (maintenance will retry): ${e.message || e}`));
}

/**
 * Merge a task/agent branch into a goal branch.
 * Operates from the main repo dir (not a worktree).
 *
 * On merge conflict the merge is left in place so self-heal can inspect and
 * resolve the actual conflicted files (C4). Only if healing fails do we abort
 * and report failure — the branch's commits are never silently dropped.
 */
export async function mergeToGoalBranch(
  mainRepoDir: string,
  taskBranch: string,
  goalBranch: string,
): Promise<{ success: boolean; output: string; conflict?: boolean }> {
  return withRepoLock(mainRepoDir, async () => {
    // Save current branch to restore later
    let originalBranch: string;
    try {
      const { stdout } = await execAsync('git branch --show-current', {
        cwd: mainRepoDir, timeout: Timeouts.GIT_QUICK,
      });
      originalBranch = stdout.trim() || getDefaultBranch(mainRepoDir);
    } catch {
      originalBranch = getDefaultBranch(mainRepoDir);
    }

    // ── Rebase task branch onto goal branch (H5) ──
    // Run the rebase where the branch actually lives. When the branch is checked
    // out in an agent worktree, checking it out in the main repo fails, so rebase
    // inside that worktree instead. Log loudly if the rebase is skipped.
    const taskWorktree = await findWorktreeForBranch(mainRepoDir, taskBranch);
    try {
      const rebaseCwd = taskWorktree || mainRepoDir;
      if (!taskWorktree) {
        await execFileAsync('git', ['-C', mainRepoDir, 'checkout', taskBranch], { timeout: Timeouts.GIT_CHECKOUT });
      }
      await execFileAsync('git', ['-C', rebaseCwd, 'rebase', goalBranch], { timeout: Timeouts.GIT_MERGE });
    } catch (rebaseErr: any) {
      console.warn(`[git-ops] Rebase of ${taskBranch} onto ${goalBranch} failed; aborting rebase and merging directly: ${rebaseErr.message || rebaseErr}`);
      const abortCwd = taskWorktree || mainRepoDir;
      await execFileAsync('git', ['-C', abortCwd, 'rebase', '--abort'], { timeout: Timeouts.GIT_QUICK })
        .catch(e => console.warn(`[git-ops] rebase --abort failed: ${e.message || e}`));
    }

    // ── Merge task branch into goal branch ──
    // Goal branches are never checked out in a worktree, so this checkout is safe.
    try {
      await execFileAsync('git', ['-C', mainRepoDir, 'checkout', goalBranch], { timeout: Timeouts.GIT_CHECKOUT });
    } catch (coErr: any) {
      console.error(`[git-ops] Failed to checkout goal branch ${goalBranch}: ${coErr.message || coErr}`);
      await restoreBranch(mainRepoDir, originalBranch);
      return { success: false, output: `checkout ${goalBranch} failed: ${coErr.message || coErr}` };
    }

    let mergeOutput = '';
    try {
      const { stdout, stderr } = await execFileAsync(
        'git', ['-C', mainRepoDir, 'merge', '--no-ff', taskBranch, '-m', `Merge task ${taskBranch} into ${goalBranch}`],
        { timeout: Timeouts.GIT_MERGE }
      );
      mergeOutput = stdout + stderr;
    } catch (mergeErr: any) {
      // Merge failed — most likely a conflict. Do NOT abort yet: leave the
      // conflict in the working tree so self-heal can genuinely inspect and
      // resolve the conflicted files (C4). We still hold the repo lock here, so
      // the conflicted state is safe from concurrent operations.
      const conflictOutput = (mergeErr.stdout || '') + (mergeErr.stderr || '') || String(mergeErr);
      console.warn(`[git-ops] Merge conflict merging ${taskBranch} into ${goalBranch}; attempting self-heal`);
      const heal = await healMergeConflict(mainRepoDir, conflictOutput);
      if (heal.success) {
        console.log(`[git-ops] Self-healed merge conflict for ${taskBranch}: ${heal.description}`);
        mergeOutput = `${conflictOutput}\n[self-heal] ${heal.description}`;
      } else {
        // Heal failed — abort the merge (don't leave the repo conflicted) and
        // report failure so the gate fails loudly. The branch is NOT dropped
        // silently; its commits remain on the task branch for manual handling.
        console.error(`[git-ops] Self-heal failed for ${taskBranch}: ${heal.description}`);
        await execFileAsync('git', ['-C', mainRepoDir, 'merge', '--abort'], { timeout: Timeouts.GIT_QUICK })
          .catch(e => console.error(`[git-ops] merge --abort failed: ${e.message || e}`));
        await restoreBranch(mainRepoDir, originalBranch);
        return {
          success: false,
          conflict: true,
          output: `Merge conflict in ${taskBranch} could not be auto-resolved: ${heal.description}\n${conflictOutput}`,
        };
      }
    }

    // ── Delete the merged task branch (H5) ──
    await deleteMergedTaskBranch(mainRepoDir, taskBranch, taskWorktree);

    // Return to original branch
    await restoreBranch(mainRepoDir, originalBranch);

    console.log(`[git-ops] Merged ${taskBranch} → ${goalBranch}`);
    return { success: true, output: mergeOutput };
  });
}

/**
 * Merge a goal branch into the target branch (final merge).
 * Supports squash or no-ff merge strategies.
 */
export async function mergeGoalToTarget(
  mainRepoDir: string,
  goalBranch: string,
  targetBranch: string,
  strategy: 'squash' | 'no-ff' = 'squash',
): Promise<{ success: boolean; output: string }> {
  return withRepoLock(mainRepoDir, async () => {
    try {
      await execFileAsync('git', ['-C', mainRepoDir, 'checkout', targetBranch], { timeout: Timeouts.GIT_CHECKOUT });

      let output = '';
      if (strategy === 'squash') {
        const m = await execFileAsync('git', ['-C', mainRepoDir, 'merge', '--squash', goalBranch], { timeout: Timeouts.GIT_MERGE });
        const c = await execFileAsync('git', ['-C', mainRepoDir, 'commit', '-m', `Merge goal ${goalBranch}`], { timeout: Timeouts.GIT_CHECKOUT });
        output = m.stdout + m.stderr + c.stdout + c.stderr;
      } else {
        const m = await execFileAsync('git', ['-C', mainRepoDir, 'merge', '--no-ff', goalBranch, '-m', `Merge goal ${goalBranch}`], { timeout: Timeouts.GIT_MERGE });
        output = m.stdout + m.stderr;
      }

      // Delete the goal branch after successful merge
      await execFileAsync('git', ['-C', mainRepoDir, 'branch', '-d', goalBranch], { timeout: Timeouts.GIT_QUICK })
        .catch(async () => {
          // Squash merges don't register as merged — force-delete.
          console.warn(`[git-ops] Goal branch ${goalBranch} not registered as merged (squash); force-deleting`);
          await execFileAsync('git', ['-C', mainRepoDir, 'branch', '-D', goalBranch], { timeout: Timeouts.GIT_QUICK })
            .catch(e => console.error(`[git-ops] force-delete ${goalBranch} failed: ${e.message || e}`));
        });

      console.log(`[git-ops] Merged ${goalBranch} → ${targetBranch} (strategy: ${strategy})`);
      return { success: true, output };
    } catch (err: any) {
      await execFileAsync('git', ['-C', mainRepoDir, 'merge', '--abort'], { timeout: Timeouts.GIT_QUICK })
        .catch(e => console.error(`[git-ops] mergeGoalToTarget: merge --abort failed: ${e.message || e}`));
      await execFileAsync('git', ['-C', mainRepoDir, 'checkout', targetBranch], { timeout: Timeouts.GIT_CHECKOUT })
        .catch(e => console.error(`[git-ops] mergeGoalToTarget: checkout ${targetBranch} failed: ${e.message || e}`));
      return { success: false, output: err.stderr || err.stdout || String(err) };
    }
  });
}

/**
 * Get the consolidated diff between a goal branch and its target branch.
 * This is what the review agent sees.
 */
export async function getConsolidatedDiff(
  cwd: string,
  goalBranch: string,
  targetBranch: string,
): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `git diff "${targetBranch}...${goalBranch}"`,
      { cwd, timeout: Timeouts.GIT_MERGE, maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout;
  } catch (err: any) {
    console.error(`[git-ops] Failed to get consolidated diff:`, err.message || err);
    return '';
  }
}

/**
 * List files changed between a goal branch and its target branch.
 */
export async function getGoalBranchFiles(
  cwd: string,
  goalBranch: string,
  targetBranch: string,
): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `git diff --name-only "${targetBranch}...${goalBranch}"`,
      { cwd, timeout: Timeouts.GIT_QUICK }
    );
    return stdout.split('\n').filter(Boolean);
  } catch (err: any) {
    console.error(`[git-ops] getGoalBranchFiles failed: ${err.message || err}`);
    return [];
  }
}

/**
 * List branches matching a pattern.
 * Uses `--format=%(refname:short)` so worktree markers (`*` current, `+`
 * checked-out-elsewhere) are never included in the branch name (H2).
 */
async function listBranches(workingDirectory: string, pattern: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', workingDirectory, 'branch', '--list', pattern, '--format=%(refname:short)'],
      { timeout: Timeouts.GIT_QUICK }
    );
    return stdout.split('\n').map(b => b.trim()).filter(Boolean);
  } catch (err: any) {
    console.error(`[git-ops] listBranches(${pattern}) failed: ${err.message || err}`);
    return [];
  }
}

/** List all goal branches for a given working directory. */
export async function listGoalBranches(workingDirectory: string): Promise<string[]> {
  return listBranches(workingDirectory, 'goal/*');
}

/** List all agent branches for a given working directory. */
export async function listAgentBranches(workingDirectory: string): Promise<string[]> {
  return listBranches(workingDirectory, 'agent/*');
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
 *
 * Uses execFile arg arrays so agent-authored summaries with backticks / $() /
 * quotes cannot be interpreted by a shell (M10).
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
    await execFileAsync('git', ['-C', workingDirectory, 'add', '-A'], { timeout: Timeouts.GIT_CHECKOUT });
    const msg = `agent(${goalSlug}): ${summary.slice(0, Limits.MAX_COMMIT_MSG_LENGTH)}`;
    await execFileAsync('git', ['-C', workingDirectory, 'commit', '-m', msg], { timeout: Timeouts.GIT_CHECKOUT });
    const { stdout } = await execFileAsync('git', ['-C', workingDirectory, 'diff', '--stat', 'HEAD~1'], {
      timeout: Timeouts.GIT_CHECKOUT,
    });
    return stdout.trim();
  } catch (err: any) {
    console.error(`[git-ops] autoCommit failed: ${err.message || err}`);
    return err.stdout || '';
  }
}
