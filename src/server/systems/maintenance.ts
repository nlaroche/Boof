/**
 * Maintenance system — periodic git hygiene, failed-merge recovery, and orphan cleanup.
 *
 * Runs on a configurable interval (default: every 24 hours) and handles:
 *   1. Git state recovery (stuck MERGING/REBASING states)
 *   2. Retry failed goal-branch merges (agent branches that never merged)
 *   3. Orphan branch cleanup (old agent/goal branches)
 *   4. Stale worktree pruning
 *   5. Git housekeeping (gc, remote prune)
 *
 * Each operation is idempotent and safe to run at any time.
 * The system logs every action to `maintenance_log` for auditability.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { runQuery, getOne, getAll, generateId, getNow } from '../db-helpers.js';
import {
  getDefaultBranch,
  listAgentBranches,
  listGoalBranches,
  mergeToGoalBranch,
} from './git-ops.js';
import { Timeouts } from '../engine/constants.js';
import { getBroadcast } from '../ws-handler.js';
import type { Agent } from '../../client/lib/types.js';

const execAsync = promisify(exec);

// ── Types ────────────────────────────────────────────────────────────────────

export interface MaintenanceConfig {
  enabled: boolean;
  /** Interval between runs in hours (default 24) */
  interval_hours: number;
  /** Delete agent branches older than this many days (default 7) */
  orphan_branch_max_age_days: number;
  /** Re-attempt merges that previously failed (default true) */
  retry_failed_merges: boolean;
  /** Run git gc --auto (default true) */
  git_gc: boolean;
  /** Log what would happen without acting (default false) */
  dry_run: boolean;
}

export interface MaintenanceLogEntry {
  id: string;
  run_id: string;
  repo_path: string;
  action: string;
  detail: string;
  success: number;
  created_at: string;
}

interface MaintenanceResult {
  action: string;
  detail: string;
  success: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MaintenanceConfig = {
  enabled: true,
  interval_hours: 24,
  orphan_branch_max_age_days: 7,
  retry_failed_merges: true,
  git_gc: true,
  dry_run: false,
};

// ── State ────────────────────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;

// ── Config ───────────────────────────────────────────────────────────────────

export function getMaintenanceConfig(): MaintenanceConfig {
  const row = getOne<{ config: string }>(
    `SELECT config FROM maintenance_config WHERE id = 'default'`,
    [],
  );
  if (!row) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.config) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function updateMaintenanceConfig(partial: Partial<MaintenanceConfig>): MaintenanceConfig {
  const current = getMaintenanceConfig();
  const merged = { ...current, ...partial };
  const now = getNow();
  runQuery(
    `INSERT INTO maintenance_config (id, config, updated_at) VALUES ('default', ?, ?)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    [JSON.stringify(merged), now],
  );
  // Restart the loop if interval changed
  if (partial.interval_hours !== undefined || partial.enabled !== undefined) {
    stopMaintenanceLoop();
    if (merged.enabled) startMaintenanceLoop();
  }
  return merged;
}

// ── Logging ──────────────────────────────────────────────────────────────────

function logAction(runId: string, repoPath: string, result: MaintenanceResult): void {
  runQuery(
    `INSERT INTO maintenance_log (id, run_id, repo_path, action, detail, success, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [generateId(), runId, repoPath, result.action, result.detail, result.success ? 1 : 0, getNow()],
  );
}

function log(msg: string): void {
  console.log(`[maintenance] ${msg}`);
}

// ── Individual Operations ────────────────────────────────────────────────────

/**
 * 1. Recover stuck git state (MERGING, REBASING, CHERRY-PICKING).
 *    Aborts the operation and returns to the default branch.
 */
async function recoverGitState(cwd: string, dryRun: boolean): Promise<MaintenanceResult[]> {
  const results: MaintenanceResult[] = [];

  // Check for stuck merge/rebase state
  const gitDir = path.join(cwd, '.git');
  const stateFiles = [
    { file: 'MERGE_HEAD', abort: 'git merge --abort', label: 'merge' },
    { file: 'REBASE_HEAD', abort: 'git rebase --abort', label: 'rebase' },
    { file: 'CHERRY_PICK_HEAD', abort: 'git cherry-pick --abort', label: 'cherry-pick' },
  ];

  for (const { file, abort, label } of stateFiles) {
    const stateFile = path.join(gitDir, file);
    if (fs.existsSync(stateFile)) {
      if (dryRun) {
        results.push({ action: 'recover_git_state', detail: `[dry-run] Would abort stuck ${label}`, success: true });
        continue;
      }
      try {
        await execAsync(abort, { cwd, timeout: Timeouts.GIT_CHECKOUT });
        const base = getDefaultBranch(cwd);
        await execAsync(`git checkout ${base}`, { cwd, timeout: Timeouts.GIT_CHECKOUT });
        results.push({ action: 'recover_git_state', detail: `Aborted stuck ${label}, returned to ${base}`, success: true });
        log(`Recovered stuck ${label} state in ${cwd}`);
      } catch (err: any) {
        results.push({ action: 'recover_git_state', detail: `Failed to abort ${label}: ${err.message}`, success: false });
      }
    }
  }

  // Check if we're stranded on a non-default branch (goal/ or agent/)
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd, timeout: Timeouts.GIT_QUICK });
    const current = stdout.trim();
    if (current && (current.startsWith('goal/') || current.startsWith('agent/'))) {
      const base = getDefaultBranch(cwd);
      if (dryRun) {
        results.push({ action: 'recover_git_state', detail: `[dry-run] Would checkout ${base} (stranded on ${current})`, success: true });
      } else {
        await execAsync(`git checkout ${base}`, { cwd, timeout: Timeouts.GIT_CHECKOUT });
        results.push({ action: 'recover_git_state', detail: `Returned to ${base} from stranded branch ${current}`, success: true });
        log(`Returned to ${base} from stranded ${current}`);
      }
    }
  } catch { /* detached HEAD or other — not critical */ }

  return results;
}

/**
 * 2. Retry failed merges — find agent branches that should have merged
 *    into a goal branch but didn't.
 */
async function retryFailedMerges(cwd: string, dryRun: boolean): Promise<MaintenanceResult[]> {
  const results: MaintenanceResult[] = [];

  const agentBranches = await listAgentBranches(cwd);
  const goalBranches = await listGoalBranches(cwd);

  // Build a map: goalSlug -> goalBranch
  const goalMap = new Map<string, string>();
  for (const gb of goalBranches) {
    // goal/my-goal-slug -> my-goal-slug
    const slug = gb.replace('goal/', '');
    goalMap.set(slug, gb);
  }

  for (const ab of agentBranches) {
    // agent/agent-name/goal-slug-timestamp -> extract goal-slug
    const parts = ab.split('/');
    if (parts.length < 3) continue;
    const lastPart = parts.slice(2).join('/');
    // Remove the timestamp suffix (last segment after final -)
    const goalSlug = lastPart.replace(/-\d+$/, '');
    const goalBranch = goalMap.get(goalSlug);
    if (!goalBranch) continue;

    // Check if this agent branch has commits ahead of the goal branch
    try {
      const { stdout } = await execAsync(
        `git log --oneline "${goalBranch}..${ab}" --`,
        { cwd, timeout: Timeouts.GIT_QUICK },
      );
      const unmergedCommits = stdout.trim().split('\n').filter(Boolean).length;
      if (unmergedCommits === 0) continue; // Already merged or empty

      if (dryRun) {
        results.push({
          action: 'retry_merge',
          detail: `[dry-run] Would merge ${ab} (${unmergedCommits} commits) into ${goalBranch}`,
          success: true,
        });
        continue;
      }

      log(`Retrying merge: ${ab} → ${goalBranch} (${unmergedCommits} unmerged commits)`);
      const mergeResult = await mergeToGoalBranch(cwd, ab, goalBranch);
      results.push({
        action: 'retry_merge',
        detail: mergeResult.success
          ? `Merged ${ab} → ${goalBranch}`
          : `Failed to merge ${ab} → ${goalBranch}: ${mergeResult.output.slice(0, 200)}`,
        success: mergeResult.success,
      });
    } catch (err: any) {
      results.push({ action: 'retry_merge', detail: `Error checking ${ab}: ${err.message}`, success: false });
    }
  }

  return results;
}

/**
 * 3. Clean up orphaned agent branches older than maxAgeDays.
 *    Only deletes branches with no unmerged commits relative to their goal
 *    branch or the default branch.
 */
async function cleanOrphanBranches(cwd: string, maxAgeDays: number, dryRun: boolean): Promise<MaintenanceResult[]> {
  const results: MaintenanceResult[] = [];
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const agentBranches = await listAgentBranches(cwd);
  const base = getDefaultBranch(cwd);

  for (const branch of agentBranches) {
    try {
      // Get the timestamp from the branch name (last segment)
      const timestampMatch = branch.match(/-(\d{13})$/);
      if (!timestampMatch) continue;
      const branchTimestamp = parseInt(timestampMatch[1], 10);
      if (branchTimestamp > cutoff) continue; // Too recent

      // Check if fully merged into default branch
      const { stdout } = await execAsync(
        `git log --oneline "${base}..${branch}" --`,
        { cwd, timeout: Timeouts.GIT_QUICK },
      );
      const unmerged = stdout.trim().split('\n').filter(Boolean).length;

      if (unmerged > 0) {
        // Has unmerged work — skip, but log it
        results.push({
          action: 'orphan_skip',
          detail: `Skipped ${branch}: ${unmerged} unmerged commits (age: ${Math.round((Date.now() - branchTimestamp) / 86400000)}d)`,
          success: true,
        });
        continue;
      }

      if (dryRun) {
        results.push({ action: 'orphan_cleanup', detail: `[dry-run] Would delete ${branch}`, success: true });
        continue;
      }

      await execAsync(`git branch -d "${branch}"`, { cwd, timeout: Timeouts.GIT_QUICK });
      results.push({ action: 'orphan_cleanup', detail: `Deleted merged branch: ${branch}`, success: true });
      log(`Deleted orphan branch: ${branch}`);
    } catch (err: any) {
      results.push({ action: 'orphan_cleanup', detail: `Failed to clean ${branch}: ${err.message}`, success: false });
    }
  }

  return results;
}

/**
 * 4. Prune stale worktrees and clean up leftover agent directories.
 */
async function pruneWorktrees(cwd: string, dryRun: boolean): Promise<MaintenanceResult[]> {
  const results: MaintenanceResult[] = [];

  try {
    if (dryRun) {
      const { stdout } = await execAsync('git worktree list --porcelain', { cwd, timeout: Timeouts.GIT_QUICK });
      const stale = stdout.split('\n').filter(l => l.includes('prunable')).length;
      if (stale > 0) {
        results.push({ action: 'prune_worktrees', detail: `[dry-run] Would prune ${stale} stale worktree(s)`, success: true });
      }
    } else {
      await execAsync('git worktree prune', { cwd, timeout: Timeouts.GIT_CHECKOUT });
      results.push({ action: 'prune_worktrees', detail: 'Pruned stale worktrees', success: true });
    }
  } catch (err: any) {
    results.push({ action: 'prune_worktrees', detail: `Failed: ${err.message}`, success: false });
  }

  // Clean up orphaned -agents/ directories that have no active worktree
  const agentsDir = cwd + '-agents';
  if (fs.existsSync(agentsDir)) {
    try {
      const { stdout: wtList } = await execAsync('git worktree list --porcelain', { cwd, timeout: Timeouts.GIT_QUICK });
      const activeWorktrees = new Set(
        wtList.split('\n')
          .filter(l => l.startsWith('worktree '))
          .map(l => l.replace('worktree ', '').trim()),
      );

      const dirs = fs.readdirSync(agentsDir);
      for (const dir of dirs) {
        const fullPath = path.join(agentsDir, dir);
        if (!fs.statSync(fullPath).isDirectory()) continue;
        if (activeWorktrees.has(fullPath)) continue;

        if (dryRun) {
          results.push({ action: 'cleanup_agents_dir', detail: `[dry-run] Would remove orphaned dir: ${dir}`, success: true });
          continue;
        }

        try {
          // Remove node_modules junction first (Windows)
          const junctionPath = path.join(fullPath, 'node_modules');
          if (fs.existsSync(junctionPath)) {
            if (process.platform === 'win32') {
              await execAsync(`cmd /c rmdir "${junctionPath}"`, { timeout: Timeouts.GIT_QUICK });
            } else {
              fs.unlinkSync(junctionPath);
            }
          }
          fs.rmSync(fullPath, { recursive: true, force: true });
          results.push({ action: 'cleanup_agents_dir', detail: `Removed orphaned dir: ${dir}`, success: true });
          log(`Removed orphaned agent dir: ${dir}`);
        } catch (err: any) {
          results.push({ action: 'cleanup_agents_dir', detail: `Failed to remove ${dir}: ${err.message}`, success: false });
        }
      }
    } catch (err: any) {
      results.push({ action: 'cleanup_agents_dir', detail: `Failed to list worktrees: ${err.message}`, success: false });
    }
  }

  return results;
}

/**
 * 5. Git housekeeping — gc and remote prune.
 */
async function gitHousekeeping(cwd: string, dryRun: boolean): Promise<MaintenanceResult[]> {
  const results: MaintenanceResult[] = [];

  if (dryRun) {
    results.push({ action: 'git_gc', detail: '[dry-run] Would run git gc --auto', success: true });
    results.push({ action: 'remote_prune', detail: '[dry-run] Would run git remote prune origin', success: true });
    return results;
  }

  try {
    await execAsync('git gc --auto', { cwd, timeout: Timeouts.BUILD });
    results.push({ action: 'git_gc', detail: 'git gc --auto completed', success: true });
  } catch (err: any) {
    results.push({ action: 'git_gc', detail: `git gc failed: ${err.message}`, success: false });
  }

  try {
    await execAsync('git remote prune origin', { cwd, timeout: Timeouts.GIT_CHECKOUT });
    results.push({ action: 'remote_prune', detail: 'git remote prune origin completed', success: true });
  } catch (err: any) {
    results.push({ action: 'remote_prune', detail: `remote prune failed: ${err.message}`, success: false });
  }

  return results;
}

// ── Main Runner ──────────────────────────────────────────────────────────────

/**
 * Run all maintenance operations for every repo that has an autopilot agent.
 * Skips if another run is already in progress.
 */
export async function runMaintenance(configOverride?: Partial<MaintenanceConfig>): Promise<void> {
  if (running) {
    log('Skipping — another maintenance run is in progress');
    return;
  }
  running = true;
  const runId = generateId();
  const config = { ...getMaintenanceConfig(), ...configOverride };

  if (!config.enabled && !configOverride) {
    running = false;
    return;
  }

  log(`Starting maintenance run ${runId} (dry_run=${config.dry_run})`);
  const startTime = Date.now();
  const broadcast = getBroadcast();

  // Collect all unique repo paths from agents with autopilot enabled
  const agents = getAll<Agent>(
    `SELECT DISTINCT working_directory FROM agents WHERE autopilot = 1`,
    [],
  );
  const repoPaths = [...new Set(agents.map(a => a.working_directory))];

  if (repoPaths.length === 0) {
    log('No autopilot repos to maintain');
    running = false;
    return;
  }

  let totalActions = 0;
  let totalFailures = 0;

  for (const repoPath of repoPaths) {
    if (!fs.existsSync(repoPath)) {
      log(`Repo path does not exist, skipping: ${repoPath}`);
      continue;
    }

    log(`Maintaining: ${repoPath}`);
    const allResults: MaintenanceResult[] = [];

    // 1. Git state recovery (always runs first)
    const stateResults = await recoverGitState(repoPath, config.dry_run);
    allResults.push(...stateResults);

    // 2. Retry failed merges
    if (config.retry_failed_merges) {
      const mergeResults = await retryFailedMerges(repoPath, config.dry_run);
      allResults.push(...mergeResults);
    }

    // 3. Orphan branch cleanup
    if (config.orphan_branch_max_age_days > 0) {
      const orphanResults = await cleanOrphanBranches(repoPath, config.orphan_branch_max_age_days, config.dry_run);
      allResults.push(...orphanResults);
    }

    // 4. Worktree pruning
    const worktreeResults = await pruneWorktrees(repoPath, config.dry_run);
    allResults.push(...worktreeResults);

    // 5. Git housekeeping
    if (config.git_gc) {
      const gcResults = await gitHousekeeping(repoPath, config.dry_run);
      allResults.push(...gcResults);
    }

    // Log all results
    for (const result of allResults) {
      logAction(runId, repoPath, result);
      if (!result.success) totalFailures++;
      totalActions++;
    }
  }

  const duration = Date.now() - startTime;
  log(`Maintenance run ${runId} complete: ${totalActions} actions, ${totalFailures} failures, ${duration}ms`);

  // Record the run completion
  runQuery(
    `INSERT INTO maintenance_log (id, run_id, repo_path, action, detail, success, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [generateId(), runId, '*', 'run_complete', `${totalActions} actions, ${totalFailures} failures, ${duration}ms`, totalFailures === 0 ? 1 : 0, getNow()],
  );

  // Broadcast to connected UI clients
  if (broadcast) {
    broadcast({
      type: 'notify',
      agentId: 'system',
      title: 'Maintenance complete',
      body: `${totalActions} actions, ${totalFailures} failures (${Math.round(duration / 1000)}s)`,
    });
  }

  running = false;
}

// ── Loop Management ──────────────────────────────────────────────────────────

export function startMaintenanceLoop(): void {
  const config = getMaintenanceConfig();
  if (!config.enabled) {
    log('Maintenance disabled — not starting loop');
    return;
  }

  const intervalMs = config.interval_hours * 60 * 60 * 1000;
  log(`Starting maintenance loop (every ${config.interval_hours}h)`);

  // Run once on startup (after a short delay to let autopilot settle)
  setTimeout(() => runMaintenance(), 60_000);

  intervalId = setInterval(() => runMaintenance(), intervalMs);
}

export function stopMaintenanceLoop(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log('Maintenance loop stopped');
  }
}

/** Check if maintenance is currently running. */
export function isMaintenanceRunning(): boolean {
  return running;
}

/** Get recent maintenance log entries. */
export function getMaintenanceLog(limit = 50): MaintenanceLogEntry[] {
  return getAll<MaintenanceLogEntry>(
    `SELECT * FROM maintenance_log ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
}
