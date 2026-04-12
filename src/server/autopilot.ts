import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { runQuery, getOne, getAll, generateId, getNow, estimateTokens } from './db-helpers.js';
import { createAgent, sendToAgent, hasAgent, killAgent } from './pty-manager.js';
import { getBroadcast } from './ws-handler.js';
import { initBoofDir, getMemoryContext, getStructuredMemoryContext, recordMistake, recordPattern, recordGuideline, getGoalLogCached, invalidateGoalLogCache, proposeGoals } from './agent-memory.js';
// branch-guard is used by systems/git-ops.ts directly
import { stripAnsi } from './git-utils.js';
import {
  hasUncommittedChanges, getCurrentBranch, slugify,
  createAgentBranch, abandonBranch, mergeToMain,
  mergeToGoalBranch, createGoalBranch,
  listAgentBranches as gitListAgentBranches, autoCommit,
  getDefaultBranch,
} from './systems/git-ops.js';
import { isGoalReadyForConsolidation, initiateConsolidation } from './systems/consolidation.js';
import { invalidateRepoMapCache } from './systems/repo-map.js';
import {
  classifyFailure as classifyTaskFailure, decideEscalation,
  recordSuccess, recordFailure, getConsecutiveFailures,
} from './systems/failure-tracker.js';
import { getProvider, calculateCost, getModelForRole } from './agent-providers.js';
import { AgentRole } from './engine/constants.js';
import { recordRunResult, onReflection as experimentOnReflection } from './systems/experiment-loop.js';
import { checkGoalBudget } from './db-helpers.js';
import {
  buildAutopilotPrompt, buildPlanningPrompt,
  getLastMatchedSkills, clearLastMatchedSkills,
  getCurrentExperimentPick, clearCurrentExperimentPick,
} from './systems/prompt-builder.js';
import { parseTasksFromOutput, createTaskForGoal, detectIndependentTasks } from './systems/goal-planner.js';
import { researchForTask as researchForTaskFn, shouldResearch as shouldResearchFn, formatResearchForPrompt as formatResearchForPromptFn } from './systems/research.js';
import { runBuildCheck, runTestCheck } from './systems/build-runner.js';
import {
  assessPerformance, identifyImprovements, awardXp,
  persistRunMetrics, updateRunMetricMerge, storeReflection, buildReflectionPrompt, parseReflectionResponse,
  getRecentReflections, getMatchingSkills, updateSkillUsage,
  buildSkillExtractionPrompt, extractSkillsFromOutput, saveSkill,
  getActivePromptVersion, seedPromptVersion, updatePromptVersionStats,
  shouldOptimizePrompt, buildPromptOptimizationMeta, createPromptVersion,
  getActiveExperiments, pickExperimentVariant, recordExperimentResult,
  createExperiment, rankTasks,
} from './self-improve.js';
import type { Agent, Goal, GoalLogEntry, Workflow, WSServerMessage, Improvement, Skill } from '../client/lib/types.js';
import { sendGoalCompletedNotification } from './notifications.js';

const execAsync = promisify(exec);

let loopInterval: ReturnType<typeof setInterval> | null = null;
const LOOP_INTERVAL_MS = 30_000;

// ── Overnight Autonomy Safeguards ────────────────────────────────────────
// Prevent runaway goal cycling during overnight unattended runs.

/** Max goals an agent may cycle through in one session before pausing. */
export const MAX_GOALS_PER_SESSION = 10;

/** Max goal cycles allowed per hour (time-based rate limit to prevent runaway loops). */
export const MAX_CYCLES_PER_HOUR = 6;

/** How long (ms) to back off between loop checks when no goals remain. */
export const IDLE_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

/** Base tasks before rotation — dynamically adjusted by momentum. */
export const BASE_TASKS_BEFORE_ROTATION = 3;

/** Tracks how many goals each agent has cycled through this session. */
const goalsCycledThisSession = new Map<string, number>();

/** Timestamps when each agent ran out of goals (for idle backoff). */
const agentIdleSince = new Map<string, number>();

/** Tracks how many consecutive tasks an agent has run on its current goal. */
const tasksOnCurrentGoal = new Map<string, number>();

/**
 * Per-agent sliding-window of goal-cycle timestamps (last 1 hour).
 * Used to enforce MAX_CYCLES_PER_HOUR.
 */
const agentCycleTimestamps = new Map<string, number[]>();

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Check whether an agent has exceeded the per-hour cycle rate limit.
 * Returns true if the agent is rate-limited (should NOT cycle now).
 * Records the current timestamp if not rate-limited.
 */
export function checkCycleRateLimit(agentId: string): boolean {
  const now = Date.now();
  const timestamps = agentCycleTimestamps.get(agentId) ?? [];
  // Prune timestamps older than 1 hour
  const recent = timestamps.filter(t => now - t < ONE_HOUR_MS);
  if (recent.length >= MAX_CYCLES_PER_HOUR) {
    return true; // rate-limited
  }
  recent.push(now);
  agentCycleTimestamps.set(agentId, recent);
  return false; // not rate-limited
}

/** Reset session counters for an agent (e.g. when new goals are assigned). */
export function resetAgentSessionCounters(agentId: string): void {
  goalsCycledThisSession.delete(agentId);
  agentIdleSince.delete(agentId);
  agentCycleTimestamps.delete(agentId);
  tasksOnCurrentGoal.delete(agentId);
}

// ── Worktree helpers ────────────────────────────────────────────────────

/** Return the effective working directory for an agent (worktree or fallback) */
export function getAgentCwd(agent: Agent): string {
  return agent.worktree_path || agent.working_directory;
}

// Track running autopilot agents to avoid double-triggering
const runningAutopilots = new Set<string>();

// ── Branch-based isolation (delegated to systems/git-ops.ts) ──
// Re-export for ws-handler compatibility
export { gitListAgentBranches as listAgentBranches };
export async function mergeAgentBranch(
  mainRepoDir: string,
  worktreePath: string,
  branchName: string
): Promise<{ success: boolean; output: string }> {
  return mergeToMain(mainRepoDir, worktreePath, branchName);
}


// ── Prompts: systems/prompt-builder.ts ──
// ── Goal planning: systems/goal-planner.ts ──

// ── Goal Logging ────────────────────────────────────────────────────────

function logToGoal(
  goalId: string,
  agentId: string,
  action: string,
  summary: string,
  diffStats: string,
  durationMs: number,
  success: boolean,
  tokens?: { prompt: number; completion: number; total: number }
): void {
  const broadcast = getBroadcast();
  const logId = generateId();
  const now = new Date().toISOString();
  const promptTokens = tokens?.prompt || 0;
  const completionTokens = tokens?.completion || 0;
  const totalTokens = tokens?.total || 0;

  runQuery(
    `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, diff_stats, cost_usd, duration_ms, success, prompt_tokens, completion_tokens, total_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [logId, goalId, agentId, action, summary, diffStats, 0, durationMs, success ? 1 : 0, promptTokens, completionTokens, totalTokens, now]
  );

  invalidateGoalLogCache(goalId);

  const entry = getOne<GoalLogEntry>('SELECT * FROM goal_log WHERE id = ?', [logId]);
  if (entry) {
    broadcast({ type: 'goal:log:entry', entry });
  }
}

// ── Agent Step Execution ────────────────────────────────────────────────

function runAgentStep(
  agentId: string,
  agent: Agent,
  prompt: string,
  broadcast: (msg: WSServerMessage) => void,
  options?: { skipWrap?: boolean; modelOverride?: string }
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    if (hasAgent(agentId)) {
      killAgent(agentId);
    }

    let output = '';
    const handleOutput = (id: string, chunk: string) => {
      output += chunk;
      broadcast({ type: 'agent:output', agentId: id, chunk });
    };

    const handleExit = (id: string, code: number) => {
      resolve({ code, output });
    };

    const model = options?.modelOverride || agent.agent_type;
    createAgent(agentId, getAgentCwd(agent), agent.name, handleOutput, handleExit, model);
    sendToAgent(agentId, prompt, { skipWrap: options?.skipWrap });
  });
}

// ── Workflow Execution ──────────────────────────────────────────────────

async function executeWorkflow(
  agentId: string,
  agent: Agent,
  workflow: Workflow,
  goal: Goal,
  broadcast: (msg: WSServerMessage) => void,
  branchName: string
): Promise<{ success: boolean; summary: string }> {
  const steps = workflow.steps;
  const results: string[] = [];

  broadcast({ type: 'agent:output', agentId, chunk: `\n=== Workflow: ${workflow.name} (${steps.length} steps) ===\n` });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    broadcast({ type: 'agent:output', agentId, chunk: `\n--- Step ${i + 1}/${steps.length}: ${step.name} ---\n` });

    let stepSuccess = false;
    let attempts = 0;
    const maxAttempts = step.on_fail === 'retry' ? (step.max_retries || 1) + 1 : 1;

    while (attempts < maxAttempts) {
      attempts++;
      const stepResult = await runAgentStep(agentId, agent, step.prompt, broadcast);
      stepSuccess = stepResult.code === 0;

      if (stepSuccess) break;
      if (step.on_fail === 'retry' && attempts < maxAttempts) {
        broadcast({ type: 'agent:output', agentId, chunk: `\nRetrying step "${step.name}" (attempt ${attempts + 1})...\n` });
      }
    }

    if (stepSuccess) {
      results.push(`${step.name}: OK`);
      logToGoal(goal.id, agentId, `workflow:${step.name}`, `Step completed`, '', 0, true);
    } else {
      results.push(`${step.name}: FAILED`);
      logToGoal(goal.id, agentId, `workflow:${step.name}`, `Step failed after ${attempts} attempt(s)`, '', 0, false);

      if (step.on_fail === 'stop') {
        return { success: false, summary: `Workflow stopped at step "${step.name}"` };
      }
      if (step.on_fail === 'revert') {
        abandonBranch(branchName, `workflow step "${step.name}" failed`);
        return { success: false, summary: `Step "${step.name}" failed — branch abandoned` };
      }
    }
  }

  return { success: true, summary: `Workflow "${workflow.name}" completed: ${results.join(', ')}` };
}

// ── Goal Cycling ────────────────────────────────────────────────────────

/** Update goal_stats after each run */
function updateGoalStats(goalId: string, durationMs: number, taskSucceeded: boolean): void {
  const existing = getOne<{ total_runs: number; tasks_completed: number; tasks_failed: number; avg_duration_ms: number }>(
    'SELECT * FROM goal_stats WHERE goal_id = ?',
    [goalId]
  );
  const now = new Date().toISOString();
  if (!existing) {
    runQuery(
      `INSERT INTO goal_stats (goal_id, total_runs, tasks_completed, tasks_failed, avg_duration_ms, last_run_at) VALUES (?, 1, ?, ?, ?, ?)`,
      [goalId, taskSucceeded ? 1 : 0, taskSucceeded ? 0 : 1, durationMs, now]
    );
  } else {
    const newTotal = existing.total_runs + 1;
    const newCompleted = existing.tasks_completed + (taskSucceeded ? 1 : 0);
    const newFailed = existing.tasks_failed + (taskSucceeded ? 0 : 1);
    const newAvg = (existing.avg_duration_ms * existing.total_runs + durationMs) / newTotal;
    runQuery(
      `UPDATE goal_stats SET total_runs = ?, tasks_completed = ?, tasks_failed = ?, avg_duration_ms = ?, last_run_at = ? WHERE goal_id = ?`,
      [newTotal, newCompleted, newFailed, newAvg, now, goalId]
    );
  }
}

/**
 * Check if the agent should rotate to a different goal, or if the current
 * goal is fully complete. Implements smart rotation:
 *
 * 1. If ALL tasks on the current goal are done → mark goal completed, cycle.
 * 2. If the agent has done TASKS_BEFORE_ROTATION tasks on this goal and
 *    other active goals exist → rotate to the next goal (round-robin).
 * 3. Otherwise → stay on the current goal.
 *
 * Returns true if goal was cycled/rotated, false if staying.
 */
export async function checkAndCycleGoal(agentId: string, goalId: string): Promise<boolean> {
  const broadcast = getBroadcast();

  // Check remaining tasks for this goal
  const remaining = getOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress')",
    [goalId]
  );
  const remainingCount = remaining?.count ?? 0;

  const goalCompleted = remainingCount === 0;

  if (goalCompleted) {
    // All tasks done — mark goal completed
    const now = new Date().toISOString();
    runQuery(
      `UPDATE goals SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, goalId]
    );

    const completedGoal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [goalId]);
    if (completedGoal) {
      broadcast({ type: 'goal:completed', goalId, agentId, goal: completedGoal });
      broadcast({ type: 'goal:updated', goal: completedGoal });
    }

    console.log(`[autopilot] Goal ${goalId} completed — all tasks done. Looking for next goal...`);
    sendGoalCompletedNotification(completedGoal?.name ?? goalId).catch(() => {});
  }

  // ── Momentum-based rotation ──
  // Instead of hardcoded rotation, adapt based on success rate and goal progress.
  const tasksDone = tasksOnCurrentGoal.get(agentId) ?? 0;
  let shouldRotate = false;

  if (!goalCompleted && tasksDone > 0) {
    // Get goal stats to calculate success rate
    const stats = getOne<{ total_runs: number; tasks_completed: number; tasks_failed: number }>(
      'SELECT total_runs, tasks_completed, tasks_failed FROM goal_stats WHERE goal_id = ?',
      [goalId]
    );

    const totalTasks = getOne<{ c: number }>(
      "SELECT COUNT(*) as c FROM tasks WHERE goal_id = ?", [goalId]
    )?.c ?? 1;
    const doneTasks = getOne<{ c: number }>(
      "SELECT COUNT(*) as c FROM tasks WHERE goal_id = ? AND status = 'done'", [goalId]
    )?.c ?? 0;
    const completionRatio = doneTasks / Math.max(totalTasks, 1);

    const successRate = stats && stats.total_runs > 0
      ? stats.tasks_completed / stats.total_runs
      : 0.5; // assume 50% if no history

    // Determine dynamic rotation threshold
    let rotationThreshold = BASE_TASKS_BEFORE_ROTATION;

    if (completionRatio >= 0.8) {
      // Goal is 80%+ done — push to finish, don't rotate
      rotationThreshold = Math.max(totalTasks - doneTasks + 1, BASE_TASKS_BEFORE_ROTATION + 2);
    } else if (successRate >= 0.7) {
      // Agent is succeeding — build momentum, stay longer
      rotationThreshold = BASE_TASKS_BEFORE_ROTATION + 2;
    } else if (successRate < 0.3 && tasksDone >= 2) {
      // Agent is failing badly — rotate immediately
      rotationThreshold = 2;
    }
    // Simple goals (1-3 tasks): finish before rotating
    if (totalTasks <= 3) {
      rotationThreshold = totalTasks + 1; // effectively "never rotate"
    }

    shouldRotate = tasksDone >= rotationThreshold;

    if (shouldRotate) {
      console.log(`[autopilot] Rotating goal: ${tasksDone} tasks done, threshold was ${rotationThreshold} (success rate ${Math.round(successRate * 100)}%, completion ${Math.round(completionRatio * 100)}%)`);
    }
  }

  if (!goalCompleted && !shouldRotate) {
    return false; // Stay on this goal
  }

  // Reset the counter since we're rotating away
  tasksOnCurrentGoal.delete(agentId);

  // ── Overnight safeguard: enforce per-hour cycle rate limit ──
  if (checkCycleRateLimit(agentId)) {
    console.log(`[autopilot] Agent ${agentId.slice(0, 6)} exceeded ${MAX_CYCLES_PER_HOUR} cycles/hour rate limit. Pausing.`);
    broadcast({
      type: 'agent:output',
      agentId,
      chunk: `\n[autopilot] Rate limit: exceeded ${MAX_CYCLES_PER_HOUR} goal cycles per hour. Pausing to prevent runaway loops.\n`,
    });
    runQuery('UPDATE agents SET autopilot = 0, autopilot_goal_id = NULL WHERE id = ?', [agentId]);
    return true;
  }

  // ── Overnight safeguard: enforce per-session goal cap ──
  const cycled = (goalsCycledThisSession.get(agentId) ?? 0) + 1;
  goalsCycledThisSession.set(agentId, cycled);

  if (cycled >= MAX_GOALS_PER_SESSION) {
    console.log(`[autopilot] Agent ${agentId.slice(0, 6)} reached max goals per session (${MAX_GOALS_PER_SESSION}). Pausing autopilot.`);
    broadcast({
      type: 'agent:output',
      agentId,
      chunk: `\n[autopilot] Reached max goals per session (${MAX_GOALS_PER_SESSION}). Pausing to avoid runaway loops. Restart autopilot to continue.\n`,
    });
    runQuery('UPDATE agents SET autopilot = 0, autopilot_goal_id = NULL WHERE id = ?', [agentId]);
    goalsCycledThisSession.delete(agentId);
    agentIdleSince.delete(agentId);
    return true;
  }

  // Find next active goal (round-robin: pick the next one after current, wrapping around)
  const allActiveGoals = getAll<Goal>(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY priority DESC, created_at ASC",
    []
  );

  // Filter out the current goal (only if it's completed; if rotating, include it for round-robin)
  const candidates = goalCompleted
    ? allActiveGoals.filter(g => g.id !== goalId)
    : allActiveGoals;

  if (candidates.length === 0) {
    // No other goals — if current is completed, we're done
    if (goalCompleted) {
      console.log(`[autopilot] No active goals remaining. Proposing new goals...`);
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        const agentCwd = getAgentCwd(agent);
        const proposedGoals = await proposeGoals(agentId, agentCwd);
        if (proposedGoals.length > 0) {
          broadcast({ type: 'goal:proposed-auto', agentId, goals: proposedGoals });
          console.log(`[autopilot] Proposed ${proposedGoals.length} new goals for agent ${agentId.slice(0, 6)}`);
        }
      }
      runQuery('UPDATE agents SET autopilot_goal_id = NULL WHERE id = ?', [agentId]);
      agentIdleSince.set(agentId, Date.now());
    }
    return goalCompleted;
  }

  // Round-robin: find the current goal's position in the list and pick the next one
  let nextGoal: Goal;
  if (shouldRotate && !goalCompleted) {
    const currentIdx = candidates.findIndex(g => g.id === goalId);
    const nextIdx = (currentIdx + 1) % candidates.length;
    nextGoal = candidates[nextIdx];
    // If we'd rotate back to the same goal (only 1 candidate), stay
    if (nextGoal.id === goalId) {
      return false;
    }
    console.log(`[autopilot] Rotating from "${allActiveGoals.find(g => g.id === goalId)?.name}" to "${nextGoal.name}" after ${tasksDone} tasks`);
    broadcast({
      type: 'agent:output',
      agentId,
      chunk: `\n[autopilot] Rotating to next goal: "${nextGoal.name}" (done ${tasksDone} tasks on current)\n`,
    });
  } else {
    // Goal completed — pick highest priority
    nextGoal = candidates[0];
    sendGoalCompletedNotification(goalId, nextGoal.name).catch(() => {});
  }

  runQuery('UPDATE agents SET autopilot_goal_id = ? WHERE id = ?', [nextGoal.id, agentId]);
  broadcast({ type: 'goal:switched', agentId, previousGoalId: goalId, newGoalId: nextGoal.id, goal: nextGoal });
  console.log(`[autopilot] Switched agent ${agentId.slice(0, 6)} to goal "${nextGoal.name}" (priority ${nextGoal.priority})`);
  return true;
}

// ── Main Autopilot Run ──────────────────────────────────────────────────

export async function triggerAutopilotRun(agentId: string): Promise<void> {
  if (runningAutopilots.has(agentId)) {
    console.log(`[autopilot] Agent ${agentId.slice(0, 6)} already running, skipping`);
    return;
  }

  const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent) return;

  const goalId = agent.autopilot_goal_id;
  if (!goalId) {
    console.log(`[autopilot] Agent ${agentId.slice(0, 6)} has no goal, skipping`);
    return;
  }

  const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [goalId]);
  if (!goal || goal.status !== 'active') {
    console.log(`[autopilot] Goal ${goalId} not active, skipping`);
    return;
  }

  const broadcast = getBroadcast();
  const startTime = Date.now();
  const goalSlug = slugify(goal.name);
  let lastMatchedSkillIds: string[] = [];

  // Performance tracking
  const perf = {
    planningMs: 0,
    implementationMs: 0,
    buildMs: 0,
  };

  runningAutopilots.add(agentId);

  // Update last run time
  const now = new Date().toISOString();
  runQuery('UPDATE agents SET autopilot_last_run = ?, status = ? WHERE id = ?', [now, 'running', agentId]);
  broadcast({ type: 'agent:status', agentId, status: 'running' });

  const updatedAgent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (updatedAgent) {
    broadcast({ type: 'agent:updated', agent: updatedAgent });
  }

  // Retroactively create worktree for pre-existing agents that lack one
  if (!agent.worktree_path) {
    try {
      const safeName = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
      const wtPath = path.join(agent.working_directory + '-agents', `${safeName}-${agent.id.slice(0, 8)}`);
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      const defaultBranch = getDefaultBranch(agent.working_directory);
      execSync(`git worktree add --detach "${wtPath}" ${defaultBranch}`, { cwd: agent.working_directory, timeout: 30_000 });
      const srcModules = path.join(agent.working_directory, 'node_modules');
      const dstModules = path.join(wtPath, 'node_modules');
      if (fs.existsSync(srcModules) && !fs.existsSync(dstModules)) {
        if (process.platform === 'win32') {
          execSync(`cmd /c mklink /J "${dstModules}" "${srcModules}"`, { timeout: 10_000 });
        } else {
          fs.symlinkSync(srcModules, dstModules, 'dir');
        }
      }
      runQuery('UPDATE agents SET worktree_path = ? WHERE id = ?', [wtPath, agent.id]);
      agent.worktree_path = wtPath;
      console.log(`[autopilot] Retroactively created worktree for agent ${agentId.slice(0, 6)} at ${wtPath}`);
      broadcast({ type: 'agent:updated', agent: { ...agent, worktree_path: wtPath } as Agent });
    } catch (wtErr: any) {
      console.error(`[autopilot] Failed to create retroactive worktree:`, wtErr.message || wtErr);
    }
  }

  // Initialize memory directory (in the worktree if available)
  const agentCwd = getAgentCwd(agent);
  initBoofDir(agentCwd);
  const memoryContext = getMemoryContext(agentCwd);

  let agentBranch = '';

  try {
    // ── Always create a feature branch from main ──
    // The autopilot NEVER works directly on main. Every run gets its own branch.
    // With worktrees, this happens in the agent's isolated directory.
    agentBranch = await createAgentBranch(agentCwd, agent.name, goalSlug);
    broadcast({
      type: 'agent:output',
      agentId,
      chunk: `\n[autopilot] Working on branch: ${agentBranch}\n`,
    });

    // ── Pre-flight: check for test failures before doing any new work ──
    let preflightTestsFailed = false;
    try {
      broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] Pre-flight test check...\n' });
      const preflightResult = await runTestCheck(agentCwd);
      if (!preflightResult.success && preflightResult.failures.length > 0) {
        preflightTestsFailed = true;
        const failureList = preflightResult.failures.slice(0, 5).join('\n');
        broadcast({
          type: 'agent:output',
          agentId,
          chunk: `\n[autopilot] ${preflightResult.failures.length} test(s) failing — fixing tests before new work\n`,
        });
        logToGoal(goalId, agentId, 'preflight_tests', `${preflightResult.failures.length} test(s) failing`, '', 0, false);
      } else {
        broadcast({ type: 'agent:output', agentId, chunk: '[autopilot] Tests passing, proceeding.\n' });
      }
    } catch (preflightErr) {
      console.error('[autopilot] Pre-flight test error:', preflightErr);
      // Don't block on test runner errors — proceed with normal work
    }

    // ── Task Decomposition: Plan if no pending tasks ──
    const pendingTasks = getAll<{ id: string; title: string; description: string }>(
      "SELECT id, title, description FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress') LIMIT 10",
      [goalId]
    );

    if (pendingTasks.length === 0) {
      // Planning phase: ask agent to create tasks
      const planPhaseStart = Date.now();
      broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] Planning phase — decomposing goal into tasks...\n' });

      const promptBuildStart = Date.now();
      const existingTasks = getAll<{ title: string }>('SELECT title FROM tasks WHERE goal_id = ?', [goalId]);
      const planPrompt = buildPlanningPrompt(goal, memoryContext, agent.working_directory, existingTasks);
      const promptBuildMs = Date.now() - promptBuildStart;
      console.log(`[perf:planning] Prompt build: ${promptBuildMs}ms`);

      const agentStepStart = Date.now();
      const planResult = await runAgentStep(agentId, agent, planPrompt, broadcast, { skipWrap: true, modelOverride: getModelForRole(agent, AgentRole.PLANNING) });
      const agentStepMs = Date.now() - agentStepStart;
      console.log(`[perf:planning] Agent execution: ${agentStepMs}ms`);

      // Track token usage for planning phase
      const planPromptTokens = estimateTokens(planPrompt);
      const planCompletionTokens = estimateTokens(planResult.output);
      const planTotalTokens = planPromptTokens + planCompletionTokens;
      console.log(`[tokens:planning] Prompt: ${planPromptTokens}, Completion: ${planCompletionTokens}, Total: ${planTotalTokens}`);

      if (planResult.code === 0) {
        console.log(`[autopilot] Planning output (${planResult.output.length} chars):\n${planResult.output.slice(0, 2000)}`);
        const parseStart = Date.now();
        const taskCount = parseTasksFromOutput(planResult.output, goalId, agentId);
        const parseMs = Date.now() - parseStart;
        console.log(`[perf:planning] Task parsing: ${parseMs}ms (${taskCount} tasks)`);

        const planPhaseMs = Date.now() - planPhaseStart;
        perf.planningMs = planPhaseMs;
        console.log(`[perf:planning] TOTAL: ${planPhaseMs}ms (prompt:${promptBuildMs}ms, agent:${agentStepMs}ms, parse:${parseMs}ms)`);
        logToGoal(
          goalId,
          agentId,
          'planning',
          `Decomposed goal into ${taskCount} tasks`,
          '',
          Date.now() - startTime,
          true,
          { prompt: planPromptTokens, completion: planCompletionTokens, total: planTotalTokens }
        );
      } else {
        const planPhaseMs = Date.now() - planPhaseStart;
        perf.planningMs = planPhaseMs;
        console.log(`[perf:planning] TOTAL: ${planPhaseMs}ms (FAILED)`);
        logToGoal(
          goalId,
          agentId,
          'planning',
          'Planning failed',
          '',
          Date.now() - startTime,
          false,
          { prompt: planPromptTokens, completion: planCompletionTokens, total: planTotalTokens }
        );
      }

      // Planning doesn't produce code changes — abandon the branch
      if (agentBranch) {
        abandonBranch(agentBranch, 'planning-only run, no code changes');
        agentBranch = '';
      }

      // Done for this run — next run will pick up the tasks
      return;
    }

    // ── Implementation Phase ──
    // If pre-flight tests failed, override with a test-fix task
    let currentTask: { id: string; title: string; description: string };
    let isTestFixOverride = false;

    if (preflightTestsFailed) {
      // Don't pick a normal task — fix the tests first
      isTestFixOverride = true;
      currentTask = {
        id: '__test_fix__',
        title: 'Fix failing tests',
        description: 'Run "node --import tsx --test src/server/__tests__/*.test.ts" to see failures, then fix them. Do NOT add new features — only fix existing test failures. Make the tests pass.',
      };
      broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] PRIORITY: Fixing failing tests before new work\n' });
    } else {
      // Adaptive task selection: rank tasks by skill match, failure history, priority
      const rankedTasks = rankTasks(agentId, pendingTasks);
      currentTask = rankedTasks[0];
      runQuery("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?", [now, currentTask.id]);
    }

    // Rebuild memory context filtered by current task relevance
    const taskDesc2 = currentTask.title + ' ' + (currentTask.description || '');
    const fileMemory = getMemoryContext(agentCwd, taskDesc2);
    const dbMemory = getStructuredMemoryContext(agentId, agent.working_directory, taskDesc2);
    const taskMemoryContext = dbMemory + fileMemory;

    // Check if agent has a workflow assigned
    let workflowObj: Workflow | null = null;
    if (agent.workflow_id) {
      const row = getOne<any>('SELECT * FROM workflows WHERE id = ?', [agent.workflow_id]);
      if (row) {
        workflowObj = { ...row, steps: JSON.parse(row.steps) };
      }
    }

    let success: boolean;
    let summary: string;
    let diffStats = '';
    let implPromptTokens = 0;
    let implCompletionTokens = 0;
    let implTotalTokens = 0;
    let testFailureCount = 0;

    if (workflowObj && workflowObj.steps.length > 0) {
      // Workflow mode
      const result = await executeWorkflow(
        agentId, agent, workflowObj, goal, broadcast, agentBranch
      );
      success = result.success;
      summary = result.summary;

      {
        const buildPhaseStart = Date.now();
        console.log(`[perf:build] Starting build validation phase (workflow mode)`);

        const buildCheckStart = Date.now();
        const buildResult = await runBuildCheck(agentCwd);
        const buildCheckMs = Date.now() - buildCheckStart;
        console.log(`[perf:build] Build check: ${buildCheckMs}ms (success: ${buildResult.success})`);

        if (!buildResult.success) {
          console.log(`[autopilot] Build failed after workflow, discarding branch`);
          const errSnippet = buildResult.output.slice(-500).trim();
          const tsError = errSnippet.match(/(TS\d+:[^\n]+)/)?.[1] || '';

          const recordMistakeStart = Date.now();
          recordMistake(
            agentCwd,
            `Build failed after workflow "${workflowObj.name}" for goal "${goal.name}"${tsError ? `: ${tsError}` : ''}: ${errSnippet.slice(0, 150)}`,
            tsError ? 'Check types and imports before committing' : ''
          );
          // SCOPE-style guideline for workflow build failures
          const wfErrorCodes = errSnippet.match(/TS\d+/g) || [];
          for (const errorCode of [...new Set(wfErrorCodes)].slice(0, 3)) {
            recordGuideline(agentCwd, errorCode, errSnippet.slice(0, 200), goal.name);
          }
          console.log(`[perf:build] Record mistake: ${Date.now() - recordMistakeStart}ms`);

          if (agentBranch) {
            abandonBranch(agentBranch, `build failed after workflow: ${errSnippet.slice(0, 100)}`);
            agentBranch = '';
          }
          success = false;
          summary = `Build failed after workflow — branch abandoned.\nBuild error:\n${errSnippet}`;

          const buildPhaseMs = Date.now() - buildPhaseStart;
          perf.buildMs = buildPhaseMs;
          console.log(`[perf:build] TOTAL: ${buildPhaseMs}ms (FAILED)`);
        } else if (success) {
          const commitStart = Date.now();
          diffStats = await autoCommit(agentCwd, goalSlug, summary);
          const commitMs = Date.now() - commitStart;
          console.log(`[perf:build] Auto-commit: ${commitMs}ms`);

          summary += ' (committed on branch)';
          const wfFiles = diffStats.split('\n').filter(l => l.includes('|')).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

          const recordPatternStart = Date.now();
          recordPattern(
            agentCwd,
            `Workflow "${workflowObj.name}" succeeded for goal "${goal.name}"${wfFiles.length ? ` — modified ${wfFiles.join(', ')}` : ''}`,
            'autopilot'
          );
          console.log(`[perf:build] Record pattern: ${Date.now() - recordPatternStart}ms`);

          const buildPhaseMs = Date.now() - buildPhaseStart;
          perf.buildMs = buildPhaseMs;
          console.log(`[perf:build] TOTAL: ${buildPhaseMs}ms (check:${buildCheckMs}ms, commit:${commitMs}ms)`);
        }
      }
    } else {
      // Simple mode: single prompt
      const implPhaseStart = Date.now();
      console.log(`[perf:implementation] Starting implementation phase for: ${currentTask.title}`);

      // Budget check: stop if goal has exceeded its cost cap
      const budgetCheck = checkGoalBudget(goalId);
      if (budgetCheck?.exceeded) {
        console.log(`[autopilot] Budget exceeded for goal ${goalId}: $${budgetCheck.spent.toFixed(2)} / $${budgetCheck.cap.toFixed(2)}`);
        broadcast({ type: 'notify', agentId, title: 'Budget exceeded', body: `Goal "${goal.name}" spent $${budgetCheck.spent.toFixed(2)} (cap: $${budgetCheck.cap.toFixed(2)}). Pausing.` });
        runQuery("UPDATE goals SET status = 'paused', updated_at = ? WHERE id = ?", [new Date().toISOString(), goalId]);
        const pausedGoal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [goalId]);
        if (pausedGoal) broadcast({ type: 'goal:updated', goal: pausedGoal });
        return;
      }

      const dbQueryStart = Date.now();
      const recentLogs = getGoalLogCached(goalId, 5);
      const dbQueryMs = Date.now() - dbQueryStart;
      console.log(`[perf:implementation] DB query (cached): ${dbQueryMs}ms`);

      // Research phase: if task warrants it, run research agent first
      let researchContext = '';
      const priorFailCount = (getOne<{ c: number }>("SELECT COUNT(*) as c FROM goal_log WHERE goal_id = ? AND success = 0 AND summary LIKE ?", [goalId, `%${currentTask.title.slice(0, 30)}%`])?.c) ?? 0;
      if (shouldResearchFn(currentTask.title, currentTask.description || '', priorFailCount)) {
        const research = await researchForTaskFn(currentTask.id, currentTask.title, currentTask.description || '', taskMemoryContext.slice(0, 1000), agent, broadcast);
        if (research) {
          researchContext = formatResearchForPromptFn(research);
        }
      }

      // Build prompt with the forced task first in the list
      const promptBuildStart = Date.now();
      const taskDesc = `${currentTask.title} ${currentTask.description || ''}`;
      // Put the current task first so buildAutopilotPrompt forces it
      const taskWithDoneWhen = { ...currentTask, done_when: (currentTask as any).done_when || '' };
      const tasksForPrompt = [taskWithDoneWhen, ...pendingTasks.filter(t => (t as any).id !== currentTask.id)];
      let prompt = buildAutopilotPrompt(goal, recentLogs, tasksForPrompt, researchContext + taskMemoryContext, agentId, taskDesc);
      // Track which skills were matched for this run (from prompt-builder)
      lastMatchedSkillIds = getLastMatchedSkills().map((s: Skill) => s.id);
      prompt += `\n\nIMPORTANT: Implement the changes directly. Do NOT enter plan mode, do NOT just describe what to do, do NOT ask for confirmation. Read the relevant files, make the code changes using Edit/Write tools, and verify the result. Act autonomously and complete the task fully.`;
      const promptBuildMs = Date.now() - promptBuildStart;
      console.log(`[perf:implementation] Prompt build: ${promptBuildMs}ms (${prompt.length} chars)`);

      const agentStepStart = Date.now();
      const runResult = await runAgentStep(agentId, agent, prompt, broadcast, { modelOverride: getModelForRole(agent, AgentRole.IMPLEMENTATION) });
      const agentStepMs = Date.now() - agentStepStart;
      console.log(`[perf:implementation] Agent execution: ${agentStepMs}ms (exit code: ${runResult.code})`);

      // Track token usage for implementation phase
      implPromptTokens = estimateTokens(prompt);
      implCompletionTokens = estimateTokens(runResult.output);
      implTotalTokens = implPromptTokens + implCompletionTokens;
      console.log(`[tokens:implementation] Prompt: ${implPromptTokens}, Completion: ${implCompletionTokens}, Total: ${implTotalTokens}`);

      success = runResult.code === 0;
      summary = success ? `Completed task: ${currentTask.title}` : `Failed task: ${currentTask.title} (exit code ${runResult.code})`;

      const implPhaseMs = Date.now() - implPhaseStart;
      perf.implementationMs = implPhaseMs;
      console.log(`[perf:implementation] TOTAL: ${implPhaseMs}ms (db:${dbQueryMs}ms, prompt:${promptBuildMs}ms, agent:${agentStepMs}ms)`)

      // Safety gate: build check + commit on agent branch
      if (success) {
        const buildPhaseStart = Date.now();
        console.log(`[perf:build] Starting build validation phase`);

        const buildCheckStart = Date.now();
        const buildResult = await runBuildCheck(agentCwd);
        const buildCheckMs = Date.now() - buildCheckStart;
        console.log(`[perf:build] Build check: ${buildCheckMs}ms (success: ${buildResult.success})`);

        if (!buildResult.success) {
          console.log(`[autopilot] Build failed, discarding branch`);
          const errSnippet = buildResult.output.slice(-500).trim();
          const tsErr = errSnippet.match(/(TS\d+:[^\n]+)/)?.[1] || '';

          const recordMistakeStart = Date.now();
          recordMistake(
            agentCwd,
            `Build failed while working on "${currentTask.title}"${tsErr ? `: ${tsErr}` : ''}: ${errSnippet.slice(0, 150)}`,
            tsErr ? 'Validate types before committing' : ''
          );
          // SCOPE-style guideline: extract error code and record structured guideline
          const errorCodes = errSnippet.match(/TS\d+/g) || [];
          for (const errorCode of [...new Set(errorCodes)].slice(0, 3)) {
            recordGuideline(agentCwd, errorCode, errSnippet.slice(0, 200), currentTask?.title);
          }
          console.log(`[perf:build] Record mistake: ${Date.now() - recordMistakeStart}ms`);

          if (agentBranch) {
            abandonBranch(agentBranch, `build failed: ${errSnippet.slice(0, 100)}`);
            agentBranch = '';
          }
          success = false;
          summary = `Build failed — branch abandoned.\nBuild error:\n${errSnippet}`;

          const buildPhaseMs = Date.now() - buildPhaseStart;
          perf.buildMs = buildPhaseMs;
          console.log(`[perf:build] TOTAL: ${buildPhaseMs}ms (FAILED)`);
        } else {
          // Run tests after build passes (quality signal, not hard gate)
          let testResult: { success: boolean; output: string; failures: string[] } | null = null;
          try {
            console.log(`[perf:build] Running test check...`);
            testResult = await runTestCheck(agentCwd);
            console.log(`[perf:build] Test check: success=${testResult.success}, failures=${testResult.failures.length}`);
            if (!testResult.success) {
              testFailureCount = testResult.failures.length;
              logToGoal(goalId, agentId, 'test_check', `Tests failed: ${testResult.failures.length} failure(s)`, '', 0, false);
              recordMistake(agentCwd, `Tests failed for "${currentTask.title}": ${testResult.failures.slice(0, 3).join('; ')}`, 'Run tests before committing');
            }
          } catch (testErr) {
            console.error('[autopilot] Test check error:', testErr);
          }

          const commitStart = Date.now();
          diffStats = await autoCommit(agentCwd, goalSlug, summary);
          const commitMs = Date.now() - commitStart;
          console.log(`[perf:build] Auto-commit: ${commitMs}ms`);

          summary += ' (committed on branch)';
          const taskFiles = diffStats.split('\n').filter(l => l.includes('|')).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

          const recordPatternStart = Date.now();
          recordPattern(
            agentCwd,
            `Completed: "${currentTask.title}"${taskFiles.length ? ` — modified ${taskFiles.join(', ')}` : ''}`,
            'autopilot'
          );
          console.log(`[perf:build] Record pattern: ${Date.now() - recordPatternStart}ms`);

          const buildPhaseMs = Date.now() - buildPhaseStart;
          perf.buildMs = buildPhaseMs;
          console.log(`[perf:build] TOTAL: ${buildPhaseMs}ms (check:${buildCheckMs}ms, commit:${commitMs}ms)`);
        }
      }
    }

    // Update task status with failure classification
    if (!isTestFixOverride) {
      const now = new Date().toISOString();

      if (success) {
        runQuery("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?", [now, currentTask.id]);
        recordSuccess(agentId, goalId);
        const count = (tasksOnCurrentGoal.get(agentId) ?? 0) + 1;
        tasksOnCurrentGoal.set(agentId, count);
      } else {
        // Classify the failure and decide what to do
        const classification = classifyTaskFailure(
          summary || '', currentTask.title, currentTask.description || '', 1
        );
        const consecutiveFails = recordFailure(agentId, goalId);
        const taskFailCount = getOne<{ c: number }>(
          "SELECT COUNT(*) as c FROM goal_log WHERE goal_id = ? AND success = 0 AND summary LIKE ?",
          [goalId, `%${currentTask.title.slice(0, 30)}%`]
        )?.c ?? 0;

        const decision = decideEscalation(classification, taskFailCount, consecutiveFails);
        console.log(`[autopilot] Failure classification: ${classification.category} (${classification.confidence}) → ${decision.action}: ${decision.reason}`);

        switch (decision.action) {
          case 'retry':
            // Set back to todo — will be picked up next cycle
            runQuery("UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?", [now, currentTask.id]);
            break;

          case 'skip':
            // Environment error — mark archived, don't block the goal
            runQuery("UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?", [now, currentTask.id]);
            logToGoal(goalId, agentId, 'task_skipped', `Skipped: ${decision.reason}`, '', 0, false);
            broadcast({ type: 'notify', agentId, title: 'Task skipped', body: `${currentTask.title}: ${decision.reason}` });
            break;

          case 'pause_task':
            // Ambiguous requirement — mark archived, notify human
            runQuery("UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?", [now, currentTask.id]);
            logToGoal(goalId, agentId, 'task_paused', `Needs clarification: ${decision.reason}`, '', 0, false);
            broadcast({ type: 'notify', agentId, title: 'Task needs review', body: `${currentTask.title}: ${decision.reason}` });
            break;

          case 'pause_goal':
            // Too many consecutive failures — pause the entire goal
            runQuery("UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?", [now, currentTask.id]);
            runQuery("UPDATE goals SET status = 'paused', updated_at = ? WHERE id = ?", [now, goalId]);
            const pausedGoal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [goalId]);
            if (pausedGoal) broadcast({ type: 'goal:updated', goal: pausedGoal });
            logToGoal(goalId, agentId, 'goal_paused', `${consecutiveFails} consecutive failures — paused for human review`, '', 0, false);
            broadcast({ type: 'notify', agentId, title: 'Goal paused', body: `${pausedGoal?.name}: ${consecutiveFails} consecutive failures. Review needed.` });
            console.log(`[autopilot] Goal ${goalId} paused after ${consecutiveFails} consecutive failures`);
            break;

          case 'split_task':
            // Too many retries — mark this task archived, log suggestion
            runQuery("UPDATE tasks SET status = 'archived', updated_at = ? WHERE id = ?", [now, currentTask.id]);
            logToGoal(goalId, agentId, 'task_split', `Task too complex after ${taskFailCount} attempts: ${decision.reason}`, '', 0, false);
            broadcast({ type: 'notify', agentId, title: 'Task needs splitting', body: `${currentTask.title}: failed ${taskFailCount} times. Consider breaking into smaller tasks.` });
            break;
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Update goal stats (non-blocking)
    updateGoalStats(goalId, durationMs, success);

    // Log with branch info and token usage
    const branchInfo = agentBranch ? ` [branch: ${agentBranch}]` : '';
    const tokenData = workflowObj
      ? undefined // Workflow mode doesn't track single prompt/completion
      : { prompt: implPromptTokens, completion: implCompletionTokens, total: implTotalTokens };
    logToGoal(goalId, agentId, 'autopilot_run', summary + branchInfo, diffStats, durationMs, success, tokenData);

    // Self-improve: assess performance, persist metrics, reflect, extract skills
    let assessmentScore = 0;
    try {
      const filesTouched = diffStats ? diffStats.split('\n').filter(l => l.includes('|')).length : 0;
      const assessment = assessPerformance(agentId, goalId, {
        retries: 0,
        buildFailures: success ? 0 : 1,
        reviewIssues: 0,
        filesTouched,
        durationMs,
        completedFully: success,
        testFailures: testFailureCount,
      });
      assessmentScore = assessment.score;

      // Persist run metrics to DB
      const activeVersion = getActivePromptVersion(agentId);
      // Calculate cost from token usage
      const provider = getProvider(getModelForRole(agent, AgentRole.IMPLEMENTATION));
      const costUsd = calculateCost(provider, implPromptTokens, implCompletionTokens);

      persistRunMetrics({
        agentId,
        commandId: goalId,
        goalId,
        taskId: currentTask.id,
        durationMs,
        retries: 0,
        buildFailures: success ? 0 : 1,
        filesTouched,
        promptTokens: implPromptTokens,
        completionTokens: implCompletionTokens,
        success,
        errorType: success ? undefined : 'build_failure',
        promptVersionId: activeVersion?.id,
        costUsd,
      });

      // Update prompt version stats
      if (activeVersion) {
        updatePromptVersionStats(activeVersion.id, assessment.score);
      }

      // Update skill usage tracking
      for (const skillId of lastMatchedSkillIds) {
        updateSkillUsage(skillId, success, assessment.score);
      }
      clearLastMatchedSkills();

      // Record experiment results — multi-metric for closed-loop system
      const expPick = getCurrentExperimentPick();
      if (expPick) {
        const expVariant = expPick.variant === 'a' ? 'control' : 'treatment';
        recordRunResult(
          expPick.experimentId,
          expVariant as 'control' | 'treatment',
          { score: assessment.score, costUsd, durationMs, mergeSuccess: null, buildFailures: success ? 0 : 1, testFailures: testFailureCount, filesChanged: filesTouched },
          { goalId, taskId: currentTask?.id }
        );
        // Also record in old experiment system for backward compat
        recordExperimentResult(expPick.experimentId, expPick.variant, assessment.score);
        clearCurrentExperimentPick();
      }

      if (success) {
        const xpAmount = assessment.score >= 90 ? 3 : 1;
        const reason = `Autopilot: ${currentTask?.title || goalSlug} (score ${assessment.score})`;
        const { newXp, event } = awardXp(agentId, xpAmount, reason, 'autopilot');
        broadcast({ type: 'agent:xp', agentId, xp: newXp, event });
      } else {
        identifyImprovements(agentId, assessment.id, summary, goalSlug, assessment.score, 0);
      }

      // Post-run reflection (async, doesn't block the flow)
      try {
        broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] Reflecting on run...\n' });
        // Extract errors from build output for reflection context
        const buildCheckOutput = success ? '' : summary;
        const extractedErrors = buildCheckOutput.match(/(?:error TS\d+:[^\n]+|Error:[^\n]+)/g) || [];
        const reflectionResult = await runAgentStep(agentId, agent, buildReflectionPrompt({
          taskTitle: currentTask?.title || goalSlug,
          score: assessmentScore,
          buildOutput: buildCheckOutput.slice(-500),
          diffStats,
          errors: extractedErrors,
        }), broadcast, { skipWrap: true, modelOverride: getModelForRole(agent, AgentRole.REFLECTION) });
        const parsed = parseReflectionResponse(reflectionResult.output);
        if (parsed) {
          storeReflection(agentId, goalId, parsed.went_well, parsed.improve, parsed.pattern);
          console.log(`[autopilot] Reflection stored: ${JSON.stringify(parsed)}`);
          // Hook 3: Feed reflection into experiment hypothesis generator
          experimentOnReflection(agentId, { reflection: parsed, score: assessmentScore, success });
        }
      } catch (reflErr) {
        console.error('[autopilot] Reflection error:', reflErr);
      }

      // Skill extraction for successful runs with score >= 70
      if (success && assessment.score >= 70) {
        try {
          broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] Extracting skills...\n' });
          const skillResult = await runAgentStep(agentId, agent, buildSkillExtractionPrompt(), broadcast, { skipWrap: true, modelOverride: getModelForRole(agent, AgentRole.REFLECTION) });
          const skills = extractSkillsFromOutput(skillResult.output);
          for (const skill of skills) {
            saveSkill(agentId, skill.name, skill.description, skill.code_snippet, skill.tags);
            console.log(`[autopilot] Skill saved: ${skill.name}`);
          }
        } catch (skillErr) {
          console.error('[autopilot] Skill extraction error:', skillErr);
        }
      }

      // Auto-optimize prompt every 10 runs
      if (shouldOptimizePrompt(agentId)) {
        try {
          const reflections = getRecentReflections(agentId, 10);
          const currentVersion = getActivePromptVersion(agentId);
          if (currentVersion && reflections.length >= 5) {
            broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] Optimizing prompt template...\n' });
            const metaPrompt = buildPromptOptimizationMeta(reflections, currentVersion.template);
            const optResult = await runAgentStep(agentId, agent, metaPrompt, broadcast, { skipWrap: true, modelOverride: getModelForRole(agent, AgentRole.REFLECTION) });
            if (optResult.code === 0 && optResult.output.length > 100) {
              // Strip ANSI from output for clean template
              const cleanTemplate = optResult.output
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
                .replace(/\x1b./g, '')
                .trim();
              const newVersion = createPromptVersion(agentId, cleanTemplate, true);
              console.log(`[autopilot] New prompt version created and activated`);
              // Auto-create A/B experiment: old template vs new template
              try {
                createExperiment(
                  agentId,
                  `Prompt v${newVersion.version - 1} vs v${newVersion.version}`,
                  'New prompt template improves score',
                  currentVersion.template,
                  cleanTemplate,
                  'score'
                );
                console.log(`[autopilot] A/B experiment created for prompt versions`);
              } catch (expErr) {
                console.error('[autopilot] Failed to create experiment:', expErr);
              }
            }
          }
        } catch (optErr) {
          console.error('[autopilot] Prompt optimization error:', optErr);
        }
      }
    } catch (err) {
      console.error('[autopilot] Self-improve error:', err);
    }

    // Merge successful branches into goal branch (not main — consolidation layer handles final merge)
    if (agentBranch) {
      if (success && diffStats) {
        // Build passed, code committed — merge into goal branch
        const goalSlugForBranch = slugify(goal.name);
        const targetBranch = getDefaultBranch(agent.working_directory);
        const goalBranch = await createGoalBranch(agent.working_directory, goalSlugForBranch, targetBranch);
        const mergeResult = await mergeToGoalBranch(agent.working_directory, agentBranch, goalBranch);
        if (mergeResult.success) {
          console.log(`[autopilot] Merged ${agentBranch} into goal branch ${goalBranch}`);
          logToGoal(goalId, agentId, 'branch_merged', `Merged ${agentBranch} → ${goalBranch}`, '', 0, true);
          updateRunMetricMerge(agentId, goalId, currentTask.id, true);
          agentBranch = '';

          // Check if goal is ready for consolidation (all tasks done)
          if (isGoalReadyForConsolidation(goalId)) {
            console.log(`[autopilot] Goal ${goalId} ready for consolidation — triggering merge gate`);
            logToGoal(goalId, agentId, 'consolidation_triggered', `All tasks done, initiating review & merge`, '', 0, true);
            // Fire-and-forget — consolidation runs asynchronously
            initiateConsolidation(goalId, agent.working_directory, (gate) => {
              broadcast({ type: 'merge-gate:updated' as any, gate });
            }).catch(err => {
              console.error(`[autopilot] Consolidation error for goal ${goalId}:`, err);
            });
          }
        } else {
          console.log(`[autopilot] Merge to goal branch failed for ${agentBranch}: ${mergeResult.output.slice(0, 200)}`);
          logToGoal(goalId, agentId, 'merge_failed', `Merge conflict: ${mergeResult.output.slice(0, 150)}`, '', 0, false);
          updateRunMetricMerge(agentId, goalId, currentTask.id, false);
          // Stay on agent branch — don't lose work
        }
      } else {
        // Failed or no changes — abandon (don't delete, don't checkout main)
        abandonBranch(agentBranch, success ? 'no changes to merge' : 'implementation failed');
        updateRunMetricMerge(agentId, goalId, currentTask.id, false);
        agentBranch = '';
      }
    }

    // Check if goal is complete and cycle to next goal if needed
    await checkAndCycleGoal(agentId, goalId);

  } catch (err: any) {
    console.error(`[autopilot] Error during run for agent ${agentId}:`, err);
    logToGoal(goalId, agentId, 'autopilot_run', `Error: ${err.message || err}`, '', Date.now() - startTime, false);

    // On error, stay on agent branch — don't touch main
    if (agentBranch) {
      abandonBranch(agentBranch, `error: ${err.message || err}`);
    }
  } finally {
    const totalMs = Date.now() - startTime;
    const otherMs = totalMs - (perf.planningMs + perf.implementationMs + perf.buildMs);
    console.log(`[perf:summary] Total autopilot run: ${totalMs}ms | Planning: ${perf.planningMs}ms (${Math.round(perf.planningMs/totalMs*100)}%) | Implementation: ${perf.implementationMs}ms (${Math.round(perf.implementationMs/totalMs*100)}%) | Build: ${perf.buildMs}ms (${Math.round(perf.buildMs/totalMs*100)}%) | Other: ${otherMs}ms (${Math.round(otherMs/totalMs*100)}%)`);

    const finishedAt = new Date().toISOString();
    runQuery("UPDATE agents SET status = 'idle', last_activity = ? WHERE id = ?", [finishedAt, agentId]);
    broadcast({ type: 'agent:status', agentId, status: 'idle' });
    runningAutopilots.delete(agentId);
  }
}

// ── Autopilot Loop ──────────────────────────────────────────────────────

function checkAutopilotAgents(): void {
  const agents = getAll<Agent>(
    "SELECT * FROM agents WHERE autopilot = 1 AND status = 'idle' AND autopilot_goal_id IS NOT NULL",
    []
  );

  const now = Date.now();

  for (const agent of agents) {
    // ── Idle backoff: if agent recently ran out of goals, slow down checks ──
    const idleSince = agentIdleSince.get(agent.id);
    if (idleSince !== undefined && now - idleSince < IDLE_BACKOFF_MS) {
      const remainingSecs = Math.ceil((IDLE_BACKOFF_MS - (now - idleSince)) / 1000);
      console.log(`[autopilot] Agent ${agent.id.slice(0, 6)} idle backoff — ${remainingSecs}s remaining`);
      continue;
    }
    // Clear backoff once it's elapsed
    if (idleSince !== undefined) {
      agentIdleSince.delete(agent.id);
    }

    const intervalMs = (agent.autopilot_interval || 600) * 1000;
    const lastRun = agent.autopilot_last_run ? new Date(agent.autopilot_last_run).getTime() : 0;

    if (now - lastRun >= intervalMs) {
      console.log(`[autopilot] Triggering agent ${agent.id.slice(0, 6)} (${agent.name})`);
      triggerAutopilotRun(agent.id).catch((err) => {
        console.error(`[autopilot] Error triggering agent ${agent.id}:`, err);
        runningAutopilots.delete(agent.id);
      });
    }
  }
}

export function startAutopilotLoop(): void {
  if (loopInterval) return;
  console.log('[autopilot] Starting autopilot loop (30s check interval)');
  loopInterval = setInterval(checkAutopilotAgents, LOOP_INTERVAL_MS);
}

export function stopAutopilotLoop(): void {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
    console.log('[autopilot] Stopped autopilot loop');
  }
}
