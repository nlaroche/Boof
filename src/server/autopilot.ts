import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { runQuery, getOne, getAll } from './db.js';
import { createAgent, sendToAgent, hasAgent, killAgent } from './pty-manager.js';
import { getBroadcast } from './ws-handler.js';
import { initBoofDir, getMemoryContext, recordMistake, recordPattern, recordGuideline, getGoalLogCached, invalidateGoalLogCache, proposeGoals } from './agent-memory.js';
import { isProtectedBranch, assertNotProtected } from './branch-guard.js';
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

/** Max tasks to run on one goal before rotating to the next. */
export const TASKS_BEFORE_ROTATION = 2;

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

function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ── Branch-based isolation ──────────────────────────────────────────────

async function hasUncommittedChanges(workingDirectory: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: workingDirectory,
      timeout: 10_000,
    });
    // Filter out untracked files in .boof/ — those are ours and safe to ignore
    const significant = stdout
      .split('\n')
      .filter((line) => line.trim() && !line.includes('.boof/'))
      .filter((line) => line.trim() && !line.includes('boof.db'));
    return significant.length > 0;
  } catch {
    return false;
  }
}

async function getCurrentBranch(workingDirectory: string): Promise<string> {
  const { stdout } = await execAsync('git branch --show-current', {
    cwd: workingDirectory,
    timeout: 10_000,
  });
  const branch = stdout.trim();
  if (!branch) {
    throw new Error('Could not determine current branch (detached HEAD or git failure)');
  }
  return branch;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function createAgentBranch(
  worktreePath: string,
  agentName: string,
  goalSlug: string
): Promise<string> {
  const timestamp = Date.now();
  const branchName = `agent/${slugify(agentName)}/${goalSlug}-${timestamp}`;
  // In the worktree, create a new branch from main — no stash needed, it's the agent's private space
  await execAsync(`git checkout -b "${branchName}" main`, {
    cwd: worktreePath,
    timeout: 30_000,
  });
  // Verify we're actually on the new branch
  const { stdout } = await execAsync('git branch --show-current', {
    cwd: worktreePath,
    timeout: 10_000,
  });
  const actual = stdout.trim();
  if (actual !== branchName) {
    throw new Error(`Branch creation failed: expected "${branchName}", got "${actual}"`);
  }
  console.log(`[autopilot] Created branch: ${branchName} (from main) in worktree ${worktreePath}`);
  return branchName;
}

/** Abandon a failed branch — just log it, don't checkout or delete anything. */
function abandonBranch(branchName: string, reason: string): void {
  console.log(`[autopilot] Abandoning branch ${branchName}: ${reason}`);
  // Branch stays in the repo. Can be cleaned up later via UI or gc sweep.
}

/**
 * Merge an agent branch into main.
 * Commits in the worktree, merges from the main repo dir.
 * The worktree returns to main after merge.
 */
async function mergeToMain(
  mainRepoDir: string,
  worktreePath: string,
  branchName: string
): Promise<{ success: boolean; output: string }> {
  try {
    // Commit any uncommitted agent work in the worktree
    await execAsync('git add -A && git diff --cached --quiet || git commit -m "WIP: uncommitted agent work"', {
      cwd: worktreePath,
      timeout: 30_000,
    }).catch(() => {}); // ignore if nothing to commit

    // Merge from the main repo dir (main stays checked out there)
    const { stdout, stderr } = await execAsync(
      `git merge --no-ff "${branchName}" -m "Merge ${branchName}"`,
      { cwd: mainRepoDir, timeout: 60_000 }
    );

    // Delete the merged branch
    await execAsync(`git branch -d "${branchName}"`, {
      cwd: mainRepoDir,
      timeout: 10_000,
    }).catch(() => {});

    // Return worktree to detached HEAD at main (can't checkout main — it's checked out in the main repo)
    await execAsync('git checkout --detach main', {
      cwd: worktreePath,
      timeout: 30_000,
    }).catch(() => {});

    return { success: true, output: stdout + stderr };
  } catch (err: any) {
    // Abort failed merge in the main repo
    await execAsync('git merge --abort', { cwd: mainRepoDir, timeout: 10_000 }).catch(() => {});
    return { success: false, output: err.stderr || err.stdout || String(err) };
  }
}

/** List all agent branches for a given working directory */
export async function listAgentBranches(workingDirectory: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git branch --list "agent/*"', {
      cwd: workingDirectory,
      timeout: 10_000,
    });
    return stdout
      .split('\n')
      .map(b => b.trim().replace(/^\*\s*/, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Merge an agent branch into main (called from UI) */
export async function mergeAgentBranch(
  mainRepoDir: string,
  worktreePath: string,
  branchName: string
): Promise<{ success: boolean; output: string }> {
  return mergeToMain(mainRepoDir, worktreePath, branchName);
}

// ── Prompts & Build ─────────────────────────────────────────────────────

function buildAutopilotPrompt(
  goal: Goal,
  recentLogs: GoalLogEntry[],
  pendingTasks: { title: string; description: string }[],
  memoryContext: string,
  agentId: string,
  currentTaskDescription?: string
): string {
  // Check for active prompt version — if one exists, use its template as the base
  const activeVersion = getActivePromptVersion(agentId);

  // If there's an active prompt experiment, pick a variant
  currentExperimentPick = null;
  const activeExperiments = getActiveExperiments(agentId);
  const promptExperiment = activeExperiments.find(e => e.metric === 'score' && e.variant_a && e.variant_b);
  if (promptExperiment) {
    const variant = pickExperimentVariant(promptExperiment);
    currentExperimentPick = { experimentId: promptExperiment.id, variant };
  }

  let prompt = '';

  // Memory context first
  if (memoryContext) {
    prompt += memoryContext;
  }

  // Pending improvements from self-improve system
  const pendingImprovements = getAll<Improvement>(
    "SELECT * FROM improvements WHERE agent_id = ? AND status = 'pending' LIMIT 3",
    [agentId]
  );
  if (pendingImprovements.length > 0) {
    prompt += 'AREAS TO IMPROVE:\n';
    for (const imp of pendingImprovements) {
      prompt += `- [${imp.category}] ${imp.description}\n`;
    }
    prompt += '\n';
  }

  // Reflections from recent runs
  const reflections = getRecentReflections(agentId, 5);
  if (reflections.length > 0) {
    prompt += 'LESSONS FROM RECENT RUNS:\n';
    for (const r of reflections) {
      if (r.went_well) prompt += `- Worked well: ${r.went_well}\n`;
      if (r.improve) prompt += `- To improve: ${r.improve}\n`;
      if (r.pattern) prompt += `- Pattern: ${r.pattern}\n`;
    }
    prompt += '\n';
  }

  // Matching skills for this task
  if (currentTaskDescription) {
    const matchedSkills = getMatchingSkills(agentId, currentTaskDescription, 3);
    if (matchedSkills.length > 0) {
      prompt += 'AVAILABLE SKILLS:\n';
      for (const skill of matchedSkills) {
        prompt += `- ${skill.name}: ${skill.description}\n`;
        if (skill.code_snippet) {
          prompt += `  Snippet: ${skill.code_snippet.slice(0, 200)}\n`;
        }
      }
      prompt += '\n';
      // Store skill IDs so we can track usage after the run
      (buildAutopilotPrompt as any)._lastMatchedSkills = matchedSkills;
    }
  }

  prompt += `You are working autonomously on this goal: "${goal.name}"\n`;
  prompt += `Description: ${goal.description || 'No description provided.'}\n`;
  prompt += `IMPORTANT: Stay focused on this specific goal. Do not work on unrelated improvements.\n\n`;

  if (recentLogs.length > 0) {
    prompt += `Recent progress:\n`;
    for (const log of recentLogs) {
      const status = log.success ? 'OK' : 'FAILED';
      prompt += `- [${status}] ${log.action}: ${log.summary}\n`;
    }
    prompt += '\n';
  }

  if (pendingTasks.length > 0) {
    prompt += `Pending tasks:\n`;
    for (const task of pendingTasks) {
      prompt += `- ${task.title}${task.description ? `: ${task.description}` : ''}\n`;
    }
    prompt += '\n';
  }

  prompt += `RULES:\n`;
  prompt += `1. Make SMALL, focused changes — edit 1-2 files max per run.\n`;
  prompt += `2. After making changes, ALWAYS run the build: node node_modules/vite/bin/vite.js build\n`;
  prompt += `   Do NOT use "npm run build" — vite is not in cmd.exe PATH on this Windows system.\n`;
  prompt += `3. If the build fails, fix the errors before finishing.\n`;
  prompt += `4. Keep your changes focused and testable.\n\n`;

  if (pendingTasks.length === 0) {
    prompt += `There are no pending tasks. Research the codebase and pick ONE small improvement related to the goal.\n`;
    prompt += `Implement it, verify the build passes, and you're done.\n`;
  } else {
    prompt += `Pick the most impactful pending task, implement it, and verify the build passes.\n`;
  }

  // Seed prompt version if this is the first run
  if (!activeVersion) {
    seedPromptVersion(agentId, prompt);
  }

  return prompt;
}

// Track matched skills for the current run (used after run for skill usage tracking)
let lastMatchedSkillIds: string[] = [];
// Track experiment variant pick for the current run
let currentExperimentPick: { experimentId: string; variant: 'a' | 'b' } | null = null;

function buildPlanningPrompt(goal: Goal, memoryContext: string): string {
  let prompt = '';
  if (memoryContext) {
    prompt += memoryContext;
  }
  prompt += `Planning tasks for goal: "${goal.name}"\n${goal.description || 'No description.'}\n\n`;
  prompt += `Use Glob on src/server/, then output 3-5 tasks. Max 1-2 tool calls. Do NOT read files.\n\n`;
  prompt += `FORMAT (one per line):\nTASK: <title> | <description with file names>\n\n`;
  prompt += `Examples:\n`;
  prompt += `TASK: Add scheduler tests | Create src/server/__tests__/scheduler.test.ts testing matchesCron\n`;
  prompt += `TASK: Test agent-memory | Create src/server/__tests__/agent-memory.test.ts testing recordMistake\n\n`;
  prompt += `Each task = 1 run (1-2 file edits). Name exact files. Plan only, don't implement.\n`;
  return prompt;
}

async function runBuildCheck(workingDirectory: string): Promise<{ success: boolean; output: string }> {
  try {
    const buildCmd = 'node node_modules/vite/bin/vite.js build';
    const { stdout, stderr } = await execAsync(buildCmd, {
      cwd: workingDirectory,
      timeout: 120_000,
      env: { ...process.env },
    });
    return { success: true, output: stdout + stderr };
  } catch (err: any) {
    return { success: false, output: err.stderr || err.stdout || String(err) };
  }
}

async function runTestCheck(workingDirectory: string): Promise<{ success: boolean; output: string; failures: string[] }> {
  try {
    const testCmd = 'node --import tsx --test src/server/__tests__/*.test.ts';
    const { stdout, stderr } = await execAsync(testCmd, {
      cwd: workingDirectory,
      timeout: 180_000,
      env: { ...process.env },
    });
    const output = stdout + stderr;
    // Parse "not ok" lines for failures
    const failures = output.match(/not ok \d+ - .*/g) || [];
    return { success: failures.length === 0, output, failures };
  } catch (err: any) {
    const output = err.stderr || err.stdout || String(err);
    const failures = output.match(/not ok \d+ - .*/g) || [];
    return { success: false, output, failures };
  }
}

async function autoCommit(workingDirectory: string, goalSlug: string, summary: string): Promise<string> {
  try {
    // Guard: refuse to commit on protected or non-agent branches
    const { stdout: branchOut } = await execAsync('git branch --show-current', {
      cwd: workingDirectory,
      timeout: 10_000,
    });
    const currentBranch = branchOut.trim();
    if (isProtectedBranch(currentBranch)) {
      console.error(`[autopilot] Refusing to commit on protected branch: ${currentBranch}`);
      return '';
    }
    if (!currentBranch.startsWith('agent/')) {
      console.error(`[autopilot] Refusing to commit on non-agent branch: ${currentBranch}`);
      return '';
    }
    await execAsync('git add -A', { cwd: workingDirectory, timeout: 30_000 });
    const msg = `agent(${goalSlug}): ${summary.slice(0, 150)}`.replace(/"/g, '\\"');
    await execAsync(`git commit -m "${msg}"`, {
      cwd: workingDirectory,
      timeout: 30_000,
    });
    const { stdout } = await execAsync('git diff --stat HEAD~1', {
      cwd: workingDirectory,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err: any) {
    return err.stdout || '';
  }
}

// Simple token estimator (4 chars ≈ 1 token for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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

  // Invalidate cache for this goal since we just added a new entry
  invalidateGoalLogCache(goalId);

  const entry = getOne<GoalLogEntry>('SELECT * FROM goal_log WHERE id = ?', [logId]);
  if (entry) {
    broadcast({ type: 'goal:log:entry', entry });
  }
}

// ── Parallel Task Execution ────────────────────────────────────────────

/**
 * Run multiple agent steps in parallel.
 * Returns when all agents complete.
 */
async function runParallelAgentSteps(
  tasks: Array<{
    agentId: string;
    agent: Agent;
    prompt: string;
    broadcast: (msg: WSServerMessage) => void;
    options?: { skipWrap?: boolean };
  }>
): Promise<Array<{ code: number; output: string }>> {
  return Promise.all(
    tasks.map(({ agentId, agent, prompt, broadcast, options }) =>
      runAgentStep(agentId, agent, prompt, broadcast, options)
    )
  );
}

// ── Agent Step ──────────────────────────────────────────────────────────

function runAgentStep(
  agentId: string,
  agent: Agent,
  prompt: string,
  broadcast: (msg: WSServerMessage) => void,
  options?: { skipWrap?: boolean }
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

    createAgent(agentId, getAgentCwd(agent), agent.name, handleOutput, handleExit, agent.agent_type);
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
      // Step prompt already has context from workflow definition
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
        // With branch isolation, "revert" just means abandon the branch
        abandonBranch(branchName, `workflow step "${step.name}" failed`);
        return { success: false, summary: `Step "${step.name}" failed — branch abandoned` };
      }
      // 'skip' — continue to next step
    }
  }

  return { success: true, summary: `Workflow "${workflow.name}" completed: ${results.join(', ')}` };
}

// ── Task Management ─────────────────────────────────────────────────────

/**
 * Detect independent tasks by checking if they mention different files.
 * Tasks are considered independent if their descriptions reference non-overlapping file sets.
 */
function detectIndependentTasks(tasks: { id: string; title: string; description: string }[]): typeof tasks {
  if (tasks.length <= 1) return tasks;

  // Extract file mentions from task descriptions
  const filePattern = /\b(?:src\/[a-z0-9_/-]+\.(?:ts|tsx|js|jsx|json))\b/gi;
  const taskFiles = tasks.map(task => {
    const matches = (task.description || '').match(filePattern) || [];
    return { task, files: new Set(matches.map(f => f.toLowerCase())) };
  });

  // Find tasks that don't share files
  const independent: typeof tasks = [];
  const usedFiles = new Set<string>();

  for (const { task, files } of taskFiles) {
    // Check if this task overlaps with already selected tasks
    const hasOverlap = Array.from(files).some(f => usedFiles.has(f));
    if (!hasOverlap || files.size === 0) {
      independent.push(task);
      files.forEach(f => usedFiles.add(f));
    }
  }

  return independent.length > 0 ? independent : [tasks[0]];
}

function getOrCreateGoalTasksFolder(): string {
  const broadcast = getBroadcast();
  const existing = getOne<any>("SELECT * FROM folders WHERE name = 'Goal Tasks'", []);
  if (existing) return existing.id;

  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    `INSERT INTO folders (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, 'Goal Tasks', '\uD83C\uDFAF', now, now]
  );
  const folder = getOne<any>('SELECT * FROM folders WHERE id = ?', [id]);
  if (folder) {
    broadcast({ type: 'folder:updated', folder });
  }
  return id;
}

function createTaskForGoal(goalId: string, agentId: string, title: string, description: string): void {
  const broadcast = getBroadcast();
  const folderId = getOrCreateGoalTasksFolder();
  const id = generateId();
  const now = new Date().toISOString();

  runQuery(
    `INSERT INTO tasks (id, folder_id, title, description, status, goal_id, agent_generated, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'todo', ?, 1, ?, ?)`,
    [id, folderId, title, description, goalId, now, now]
  );

  const task = getOne<any>('SELECT * FROM tasks WHERE id = ?', [id]);
  if (task) {
    broadcast({ type: 'task:updated', task });
  }

  logToGoal(goalId, agentId, 'task_created', `Created task: ${title}`, '', 0, true);
}

function parseTasksFromOutput(output: string, goalId: string, agentId: string): number {
  // Strip ANSI escape codes that ConPTY injects
  const clean = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const lines = clean.split('\n');
  let count = 0;
  for (const line of lines) {
    const match = line.match(/TASK:\s*([^|]+)\|(.+)/);
    if (match) {
      const title = match[1].trim();
      const description = match[2].trim();
      if (title) {
        createTaskForGoal(goalId, agentId, title, description);
        count++;
      }
    }
  }
  return count;
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

  // ── Smart rotation: even if goal isn't complete, rotate after N tasks ──
  const tasksDone = tasksOnCurrentGoal.get(agentId) ?? 0;
  const shouldRotate = !goalCompleted && tasksDone >= TASKS_BEFORE_ROTATION;

  if (!goalCompleted && !shouldRotate) {
    return false; // Stay on this goal — still have tasks and haven't hit rotation threshold
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
      execSync(`git worktree add --detach "${wtPath}" main`, { cwd: agent.working_directory, timeout: 30_000 });
      const srcModules = path.join(agent.working_directory, 'node_modules');
      const dstModules = path.join(wtPath, 'node_modules');
      if (fs.existsSync(srcModules) && !fs.existsSync(dstModules)) {
        execSync(`cmd /c mklink /J "${dstModules}" "${srcModules}"`, { timeout: 10_000 });
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
      const planPrompt = buildPlanningPrompt(goal, memoryContext);
      const promptBuildMs = Date.now() - promptBuildStart;
      console.log(`[perf:planning] Prompt build: ${promptBuildMs}ms`);

      const agentStepStart = Date.now();
      const planResult = await runAgentStep(agentId, agent, planPrompt, broadcast, { skipWrap: true });
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
    const taskMemoryContext = getMemoryContext(agentCwd, currentTask.title + ' ' + (currentTask.description || ''));

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

      const dbQueryStart = Date.now();
      const recentLogs = getGoalLogCached(goalId, 5);
      const dbQueryMs = Date.now() - dbQueryStart;
      console.log(`[perf:implementation] DB query (cached): ${dbQueryMs}ms`);

      // Build a task-focused prompt (task details included in pendingTasks list, no duplication needed)
      const promptBuildStart = Date.now();
      const taskDesc = `${currentTask.title} ${currentTask.description || ''}`;
      let prompt = buildAutopilotPrompt(goal, recentLogs, pendingTasks, taskMemoryContext, agentId, taskDesc);
      // Track which skills were matched for this run
      lastMatchedSkillIds = ((buildAutopilotPrompt as any)._lastMatchedSkills || []).map((s: Skill) => s.id);
      // Task already listed in pendingTasks — direct agent to pick it
      prompt += `\n\nIMPORTANT: Implement the changes directly. Do NOT enter plan mode, do NOT just describe what to do, do NOT ask for confirmation. Read the relevant files, make the code changes using Edit/Write tools, and verify the result. Act autonomously and complete the task fully.`;
      const promptBuildMs = Date.now() - promptBuildStart;
      console.log(`[perf:implementation] Prompt build: ${promptBuildMs}ms (${prompt.length} chars)`);

      const agentStepStart = Date.now();
      const runResult = await runAgentStep(agentId, agent, prompt, broadcast);
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

    // Update task status (skip for test-fix overrides which aren't real DB tasks)
    if (!isTestFixOverride) {
      const taskStatus = success ? 'done' : 'todo';
      runQuery("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [taskStatus, new Date().toISOString(), currentTask.id]);

      // Increment task counter for goal rotation
      if (success) {
        const count = (tasksOnCurrentGoal.get(agentId) ?? 0) + 1;
        tasksOnCurrentGoal.set(agentId, count);
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
      });

      // Update prompt version stats
      if (activeVersion) {
        updatePromptVersionStats(activeVersion.id, assessment.score);
      }

      // Update skill usage tracking
      for (const skillId of lastMatchedSkillIds) {
        updateSkillUsage(skillId, success, assessment.score);
      }
      lastMatchedSkillIds = [];

      // Record experiment results using the stored variant pick
      if (currentExperimentPick) {
        recordExperimentResult(currentExperimentPick.experimentId, currentExperimentPick.variant, assessment.score);
        currentExperimentPick = null;
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
        }), broadcast, { skipWrap: true });
        const parsed = parseReflectionResponse(reflectionResult.output);
        if (parsed) {
          storeReflection(agentId, goalId, parsed.went_well, parsed.improve, parsed.pattern);
          console.log(`[autopilot] Reflection stored: ${JSON.stringify(parsed)}`);
        }
      } catch (reflErr) {
        console.error('[autopilot] Reflection error:', reflErr);
      }

      // Skill extraction for successful runs with score >= 70
      if (success && assessment.score >= 70) {
        try {
          broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] Extracting skills...\n' });
          const skillResult = await runAgentStep(agentId, agent, buildSkillExtractionPrompt(), broadcast, { skipWrap: true });
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
            const optResult = await runAgentStep(agentId, agent, metaPrompt, broadcast, { skipWrap: true });
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

    // Auto-merge successful branches into main
    if (agentBranch) {
      if (success && diffStats) {
        // Build passed, code committed — merge into main
        const mergeResult = await mergeToMain(agent.working_directory, agentCwd, agentBranch);
        if (mergeResult.success) {
          console.log(`[autopilot] Auto-merged ${agentBranch} into main`);
          logToGoal(goalId, agentId, 'branch_merged', `Merged ${agentBranch}`, '', 0, true);
          updateRunMetricMerge(agentId, goalId, currentTask.id, true);
          agentBranch = '';
        } else {
          console.log(`[autopilot] Merge failed for ${agentBranch}: ${mergeResult.output.slice(0, 200)}`);
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
