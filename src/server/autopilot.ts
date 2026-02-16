import { exec } from 'child_process';
import { promisify } from 'util';
import { runQuery, getOne, getAll } from './db.js';
import { createAgent, sendToAgent, hasAgent, killAgent } from './pty-manager.js';
import { getBroadcast } from './ws-handler.js';
import { initBoofDir, getMemoryContext, recordMistake, recordPattern } from './agent-memory.js';
import { isProtectedBranch, assertNotProtected } from './branch-guard.js';
import { assessPerformance, identifyImprovements, awardXp } from './self-improve.js';
import type { Agent, Goal, GoalLogEntry, Workflow, WSServerMessage, Improvement } from '../client/lib/types.js';

const execAsync = promisify(exec);

let loopInterval: ReturnType<typeof setInterval> | null = null;
const LOOP_INTERVAL_MS = 30_000;

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
  workingDirectory: string,
  agentName: string,
  goalSlug: string
): Promise<string> {
  const timestamp = Date.now();
  const branchName = `agent/${slugify(agentName)}/${goalSlug}-${timestamp}`;
  await execAsync(`git checkout -b "${branchName}"`, {
    cwd: workingDirectory,
    timeout: 30_000,
  });
  // Verify we're actually on the new branch
  const { stdout } = await execAsync('git branch --show-current', {
    cwd: workingDirectory,
    timeout: 10_000,
  });
  const actual = stdout.trim();
  if (actual !== branchName) {
    throw new Error(`Branch creation failed: expected "${branchName}", got "${actual}"`);
  }
  console.log(`[autopilot] Created branch: ${branchName}`);
  return branchName;
}

async function switchBack(workingDirectory: string, originalBranch: string): Promise<void> {
  try {
    await execAsync(`git checkout "${originalBranch}"`, {
      cwd: workingDirectory,
      timeout: 30_000,
    });
    console.log(`[autopilot] Switched back to: ${originalBranch}`);
  } catch (err) {
    console.error('[autopilot] Failed to switch back:', err);
  }
}

async function discardAgentBranch(
  workingDirectory: string,
  branchName: string,
  originalBranch: string
): Promise<void> {
  try {
    // Make sure we're on the original branch before deleting
    await execAsync(`git checkout "${originalBranch}"`, {
      cwd: workingDirectory,
      timeout: 30_000,
    });
    await execAsync(`git branch -D "${branchName}"`, {
      cwd: workingDirectory,
      timeout: 30_000,
    });
    console.log(`[autopilot] Discarded branch: ${branchName}`);
  } catch (err) {
    console.error('[autopilot] Failed to discard branch:', err);
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

/** Merge an agent branch into the current branch */
export async function mergeAgentBranch(
  workingDirectory: string,
  branchName: string
): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      `git merge --no-ff "${branchName}" -m "Merge ${branchName}"`,
      { cwd: workingDirectory, timeout: 60_000 }
    );
    // Delete the branch after successful merge
    await execAsync(`git branch -d "${branchName}"`, {
      cwd: workingDirectory,
      timeout: 10_000,
    }).catch(() => {});
    return { success: true, output: stdout + stderr };
  } catch (err: any) {
    // Abort the failed merge
    await execAsync('git merge --abort', { cwd: workingDirectory, timeout: 10_000 }).catch(() => {});
    return { success: false, output: err.stderr || err.stdout || String(err) };
  }
}

// ── Prompts & Build ─────────────────────────────────────────────────────

function buildAutopilotPrompt(
  goal: Goal,
  recentLogs: GoalLogEntry[],
  pendingTasks: { title: string; description: string }[],
  memoryContext: string,
  agentId: string
): string {
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

  return prompt;
}

function buildPlanningPrompt(goal: Goal, memoryContext: string): string {
  let prompt = '';
  if (memoryContext) {
    prompt += memoryContext;
  }
  prompt += `Analyze the codebase for goal: "${goal.name}"\n`;
  prompt += `Description: ${goal.description || 'No description provided.'}\n\n`;
  prompt += `Output exactly 3-5 concrete tasks as TASK: lines.\n`;
  prompt += `Format: TASK: <title> | <description>\n`;
  prompt += `Each task should be completable in one agent run (1-2 file changes).\n`;
  prompt += `Be specific — name exact files and what to change.\n`;
  prompt += `Do NOT implement anything — just plan.\n`;
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

function isSelfImprovement(workingDirectory: string): boolean {
  const projectRoot = process.cwd();
  const normalized = workingDirectory.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/');
}

function logToGoal(
  goalId: string,
  agentId: string,
  action: string,
  summary: string,
  diffStats: string,
  durationMs: number,
  success: boolean
): void {
  const broadcast = getBroadcast();
  const logId = generateId();
  const now = new Date().toISOString();
  runQuery(
    `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, diff_stats, cost_usd, duration_ms, success, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [logId, goalId, agentId, action, summary, diffStats, 0, durationMs, success ? 1 : 0, now]
  );
  const entry = getOne<GoalLogEntry>('SELECT * FROM goal_log WHERE id = ?', [logId]);
  if (entry) {
    broadcast({ type: 'goal:log:entry', entry });
  }
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

    createAgent(agentId, agent.working_directory, agent.name, handleOutput, handleExit, agent.agent_type);
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
  branchName: string,
  originalBranch: string
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
      const fullPrompt = `${step.prompt}\n\nContext — Goal: "${goal.name}": ${goal.description || ''}`;
      const stepResult = await runAgentStep(agentId, agent, fullPrompt, broadcast);
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
        // With branch isolation, "revert" just means discard the branch
        await discardAgentBranch(agent.working_directory, branchName, originalBranch);
        return { success: false, summary: `Step "${step.name}" failed — branch discarded` };
      }
      // 'skip' — continue to next step
    }
  }

  return { success: true, summary: `Workflow "${workflow.name}" completed: ${results.join(', ')}` };
}

// ── Task Management ─────────────────────────────────────────────────────

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
  const selfImprovement = isSelfImprovement(agent.working_directory);
  const startTime = Date.now();
  const goalSlug = slugify(goal.name);

  runningAutopilots.add(agentId);

  // Update last run time
  const now = new Date().toISOString();
  runQuery('UPDATE agents SET autopilot_last_run = ?, status = ? WHERE id = ?', [now, 'running', agentId]);
  broadcast({ type: 'agent:status', agentId, status: 'running' });

  const updatedAgent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (updatedAgent) {
    broadcast({ type: 'agent:updated', agent: updatedAgent });
  }

  // Initialize memory directory
  initBoofDir(agent.working_directory);
  const memoryContext = getMemoryContext(agent.working_directory);

  // Record current branch before creating agent branch
  let originalBranch = '';
  let agentBranch = '';

  try {
    // ── Branch Isolation ──
    // Always isolate on protected branches, even for non-self-improvement
    originalBranch = await getCurrentBranch(agent.working_directory);
    const needsBranchIsolation = selfImprovement || isProtectedBranch(originalBranch);
    if (needsBranchIsolation) {
      agentBranch = await createAgentBranch(agent.working_directory, agent.name, goalSlug);
      broadcast({
        type: 'agent:output',
        agentId,
        chunk: `\n[autopilot] Working on branch: ${agentBranch}\n`,
      });
    }

    // ── Task Decomposition: Plan if no pending tasks ──
    const pendingTasks = getAll<{ id: string; title: string; description: string }>(
      "SELECT id, title, description FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress') LIMIT 10",
      [goalId]
    );

    if (pendingTasks.length === 0) {
      // Planning phase: ask agent to create tasks
      broadcast({ type: 'agent:output', agentId, chunk: '\n[autopilot] Planning phase — decomposing goal into tasks...\n' });
      const planPrompt = buildPlanningPrompt(goal, memoryContext);
      const planResult = await runAgentStep(agentId, agent, planPrompt, broadcast, { skipWrap: true });

      if (planResult.code === 0) {
        const taskCount = parseTasksFromOutput(planResult.output, goalId, agentId);
        logToGoal(goalId, agentId, 'planning', `Decomposed goal into ${taskCount} tasks`, '', Date.now() - startTime, true);
      } else {
        logToGoal(goalId, agentId, 'planning', 'Planning failed', '', Date.now() - startTime, false);
      }

      // Clean up branch (planning doesn't produce code changes)
      if (needsBranchIsolation && agentBranch) {
        await discardAgentBranch(agent.working_directory, agentBranch, originalBranch);
        agentBranch = '';
      }

      // Done for this run — next run will pick up the tasks
      return;
    }

    // ── Implementation Phase ──
    // Pick first pending task and mark it in_progress
    const currentTask = pendingTasks[0];
    runQuery("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?", [now, currentTask.id]);

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

    if (workflowObj && workflowObj.steps.length > 0) {
      // Workflow mode
      const result = await executeWorkflow(
        agentId, agent, workflowObj, goal, broadcast, agentBranch, originalBranch
      );
      success = result.success;
      summary = result.summary;

      if (needsBranchIsolation) {
        const buildResult = await runBuildCheck(agent.working_directory);
        if (!buildResult.success) {
          console.log(`[autopilot] Build failed after workflow, discarding branch`);
          const errSnippet = buildResult.output.slice(-500).trim();
          const tsError = errSnippet.match(/(TS\d+:[^\n]+)/)?.[1] || '';
          recordMistake(
            agent.working_directory,
            `Build failed after workflow "${workflowObj.name}" for goal "${goal.name}"${tsError ? `: ${tsError}` : ''}: ${errSnippet.slice(0, 150)}`,
            tsError ? 'Check types and imports before committing' : ''
          );
          if (agentBranch) {
            await discardAgentBranch(agent.working_directory, agentBranch, originalBranch);
            agentBranch = '';
          }
          success = false;
          summary = `Build failed after workflow — branch discarded.\nBuild error:\n${errSnippet}`;
        } else if (success) {
          diffStats = await autoCommit(agent.working_directory, goalSlug, summary);
          summary += ' (committed on branch)';
          const wfFiles = diffStats.split('\n').filter(l => l.includes('|')).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
          recordPattern(
            agent.working_directory,
            `Workflow "${workflowObj.name}" succeeded for goal "${goal.name}"${wfFiles.length ? ` — modified ${wfFiles.join(', ')}` : ''}`,
            'autopilot'
          );
        }
      }
    } else {
      // Simple mode: single prompt
      const recentLogs = getAll<GoalLogEntry>(
        'SELECT * FROM goal_log WHERE goal_id = ? ORDER BY created_at DESC LIMIT 5',
        [goalId]
      );

      // Build a task-focused prompt
      let prompt = buildAutopilotPrompt(goal, recentLogs, pendingTasks, memoryContext, agentId);
      prompt += `\n\nFOCUS ON THIS TASK: ${currentTask.title}`;
      if (currentTask.description) prompt += `\nDetails: ${currentTask.description}`;

      const runResult = await runAgentStep(agentId, agent, prompt, broadcast);
      success = runResult.code === 0;
      summary = success ? `Completed task: ${currentTask.title}` : `Failed task: ${currentTask.title} (exit code ${runResult.code})`;

      // Safety gate: build check + commit on agent branches
      if (needsBranchIsolation && success) {
        const buildResult = await runBuildCheck(agent.working_directory);
        if (!buildResult.success) {
          console.log(`[autopilot] Build failed, discarding branch`);
          const errSnippet = buildResult.output.slice(-500).trim();
          const tsErr = errSnippet.match(/(TS\d+:[^\n]+)/)?.[1] || '';
          recordMistake(
            agent.working_directory,
            `Build failed while working on "${currentTask.title}"${tsErr ? `: ${tsErr}` : ''}: ${errSnippet.slice(0, 150)}`,
            tsErr ? 'Validate types before committing' : ''
          );
          if (agentBranch) {
            await discardAgentBranch(agent.working_directory, agentBranch, originalBranch);
            agentBranch = '';
          }
          success = false;
          summary = `Build failed — branch discarded.\nBuild error:\n${errSnippet}`;
        } else {
          diffStats = await autoCommit(agent.working_directory, goalSlug, summary);
          summary += ' (committed on branch)';
          const taskFiles = diffStats.split('\n').filter(l => l.includes('|')).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
          recordPattern(
            agent.working_directory,
            `Completed: "${currentTask.title}"${taskFiles.length ? ` — modified ${taskFiles.join(', ')}` : ''}`,
            'autopilot'
          );
        }
      }
    }

    // Update task status
    const taskStatus = success ? 'done' : 'todo';
    runQuery("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?", [taskStatus, new Date().toISOString(), currentTask.id]);

    const durationMs = Date.now() - startTime;

    // Log with branch info
    const branchInfo = agentBranch ? ` [branch: ${agentBranch}]` : '';
    logToGoal(goalId, agentId, 'autopilot_run', summary + branchInfo, diffStats, durationMs, success);

    // Self-improve: assess performance and award XP / identify improvements
    try {
      const filesTouched = diffStats ? diffStats.split('\n').filter(l => l.includes('|')).length : 0;
      const assessment = assessPerformance(agentId, goalId, {
        retries: 0,
        buildFailures: success ? 0 : 1,
        reviewIssues: 0,
        filesTouched,
        durationMs,
        completedFully: success,
      });
      if (success) {
        const newXp = awardXp(agentId, assessment.score >= 90 ? 3 : 1);
        broadcast({ type: 'agent:xp', agentId, xp: newXp });
      } else {
        identifyImprovements(agentId, assessment.id, summary, goalSlug, assessment.score, 0);
      }
    } catch (err) {
      console.error('[autopilot] Self-improve error:', err);
    }

    // Switch back to original branch (leave agent branch for merge/discard via UI)
    if (needsBranchIsolation && agentBranch && originalBranch) {
      await switchBack(agent.working_directory, originalBranch);
    }

  } catch (err: any) {
    console.error(`[autopilot] Error during run for agent ${agentId}:`, err);
    logToGoal(goalId, agentId, 'autopilot_run', `Error: ${err.message || err}`, '', Date.now() - startTime, false);

    // Clean up: switch back to original branch on error
    if (agentBranch && originalBranch) {
      await switchBack(agent.working_directory, originalBranch).catch(() => {});
    }
  } finally {
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
