import { exec } from 'child_process';
import { promisify } from 'util';
import { runQuery, getOne, getAll } from './db.js';
import { createAgent, sendToAgent, hasAgent, killAgent } from './pty-manager.js';
import { getBroadcast } from './ws-handler.js';
import type { Agent, Goal, GoalLogEntry, Workflow, WorkflowStep, WSServerMessage } from '../client/lib/types.js';

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

function buildAutopilotPrompt(goal: Goal, recentLogs: GoalLogEntry[], pendingTasks: { title: string; description: string }[]): string {
  let prompt = `You are working autonomously on this goal: "${goal.name}"\n`;
  prompt += `Description: ${goal.description || 'No description provided.'}\n\n`;

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

  prompt += `Research the codebase, pick the most impactful task, implement it, and test it.\n`;
  prompt += `If no tasks exist, research the code and create new tasks.\n`;
  prompt += `Keep your changes focused and testable.\n\n`;
  prompt += `SELF-IMPROVEMENT: If you learn something from a failure or discover a better approach, `;
  prompt += `update aider-conventions.md (or create it) with the lesson. This helps future runs avoid the same issues.\n`;
  prompt += `Examples: build quirks, import patterns, test setup, env requirements.`;

  return prompt;
}

async function runBuildCheck(workingDirectory: string): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync('npm run build', {
      cwd: workingDirectory,
      timeout: 120_000,
      env: { ...process.env },
    });
    return { success: true, output: stdout + stderr };
  } catch (err: any) {
    return { success: false, output: err.stderr || err.stdout || String(err) };
  }
}

async function revertToHead(workingDirectory: string, headBefore: string): Promise<void> {
  if (!headBefore) {
    console.error('[autopilot] No HEAD reference, cannot safely revert');
    return;
  }
  try {
    // Only revert to the state at headBefore, not a blanket checkout
    // This preserves any pre-existing uncommitted changes
    await execAsync(`git stash`, { cwd: workingDirectory, timeout: 30_000 });
    await execAsync(`git reset --hard ${headBefore}`, { cwd: workingDirectory, timeout: 30_000 });
    // Restore any stashed pre-existing changes
    await execAsync(`git stash pop`, { cwd: workingDirectory, timeout: 30_000 }).catch(() => {});
  } catch (err) {
    console.error('[autopilot] Failed to revert changes:', err);
  }
}

async function autoCommit(workingDirectory: string, summary: string): Promise<string> {
  try {
    await execAsync('git add -A', { cwd: workingDirectory, timeout: 30_000 });
    const msg = summary.slice(0, 200) || 'autopilot changes';
    await execAsync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, {
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

async function getGitHead(workingDirectory: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', {
      cwd: workingDirectory,
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

function isSelfImprovement(workingDirectory: string): boolean {
  const projectRoot = process.cwd();
  const normalized = workingDirectory.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/');
}

function logToGoal(goalId: string, agentId: string, action: string, summary: string, diffStats: string, durationMs: number, success: boolean): void {
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

/**
 * Run a single prompt through the agent PTY and wait for it to exit.
 * Returns the exit code.
 */
function runAgentStep(
  agentId: string,
  agent: Agent,
  prompt: string,
  broadcast: (msg: WSServerMessage) => void
): Promise<number> {
  return new Promise((resolve) => {
    // Kill existing pty to get a fresh process for this step
    if (hasAgent(agentId)) {
      killAgent(agentId);
    }

    const handleOutput = (id: string, chunk: string) => {
      broadcast({ type: 'agent:output', agentId: id, chunk });
    };

    const handleExit = (id: string, code: number) => {
      resolve(code);
    };

    createAgent(agentId, agent.working_directory, agent.name, handleOutput, handleExit);
    sendToAgent(agentId, prompt);
  });
}

/**
 * Execute a workflow: run each step in sequence with failure handling.
 */
async function executeWorkflow(
  agentId: string,
  agent: Agent,
  workflow: Workflow,
  goal: Goal,
  broadcast: (msg: WSServerMessage) => void,
  headBefore: string
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
      // Interpolate the step prompt with goal context
      const fullPrompt = `${step.prompt}\n\nContext — Goal: "${goal.name}": ${goal.description || ''}`;
      const code = await runAgentStep(agentId, agent, fullPrompt, broadcast);
      stepSuccess = code === 0;

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
        await revertToHead(agent.working_directory, headBefore);
        return { success: false, summary: `Step "${step.name}" failed — changes reverted` };
      }
      // 'skip' — continue to next step
    }
  }

  return { success: true, summary: `Workflow "${workflow.name}" completed: ${results.join(', ')}` };
}

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

  runningAutopilots.add(agentId);

  // Update last run time
  const now = new Date().toISOString();
  runQuery('UPDATE agents SET autopilot_last_run = ?, status = ? WHERE id = ?', [now, 'running', agentId]);
  broadcast({ type: 'agent:status', agentId, status: 'running' });

  const updatedAgent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (updatedAgent) {
    broadcast({ type: 'agent:updated', agent: updatedAgent });
  }

  try {
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
      // Workflow mode: run steps sequentially
      const headBefore = selfImprovement ? await getGitHead(agent.working_directory) : '';
      const result = await executeWorkflow(agentId, agent, workflowObj, goal, broadcast, headBefore);
      success = result.success;
      summary = result.summary;

      // Self-improvement safety gate after workflow
      if (selfImprovement) {
        const buildResult = await runBuildCheck(agent.working_directory);
        if (!buildResult.success) {
          console.log(`[autopilot] Build failed for self-improvement after workflow, reverting`);
          await revertToHead(agent.working_directory, headBefore);
          success = false;
          summary = 'Build failed after workflow — reverted';
        } else if (success) {
          diffStats = await autoCommit(agent.working_directory, summary);
          summary += ' (committed)';
        }
      }
    } else {
      // Simple mode: single prompt run
      const recentLogs = getAll<GoalLogEntry>(
        'SELECT * FROM goal_log WHERE goal_id = ? ORDER BY created_at DESC LIMIT 5',
        [goalId]
      );
      const pendingTasks = getAll<{ title: string; description: string }>(
        "SELECT title, description FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress') LIMIT 10",
        [goalId]
      );

      const prompt = buildAutopilotPrompt(goal, recentLogs, pendingTasks);
      const headBefore = selfImprovement ? await getGitHead(agent.working_directory) : '';

      const code = await runAgentStep(agentId, agent, prompt, broadcast);
      success = code === 0;
      summary = success ? 'Autopilot run completed' : `Autopilot run failed (exit code ${code})`;

      // Self-improvement safety gate
      if (selfImprovement && success) {
        const buildResult = await runBuildCheck(agent.working_directory);
        if (!buildResult.success) {
          console.log(`[autopilot] Build failed for self-improvement, reverting`);
          await revertToHead(agent.working_directory, headBefore);
          success = false;
          summary = 'Build failed after changes — reverted';
        } else {
          diffStats = await autoCommit(agent.working_directory, summary);
          summary = 'Self-improvement changes committed (build passed)';
        }
      }
    }

    const durationMs = Date.now() - startTime;
    logToGoal(goalId, agentId, 'autopilot_run', summary, diffStats, durationMs, success);

  } catch (err: any) {
    console.error(`[autopilot] Error during run for agent ${agentId}:`, err);
    logToGoal(goalId, agentId, 'autopilot_run', `Error: ${err.message || err}`, '', Date.now() - startTime, false);
  } finally {
    const finishedAt = new Date().toISOString();
    runQuery("UPDATE agents SET status = 'idle', last_activity = ? WHERE id = ?", [finishedAt, agentId]);
    broadcast({ type: 'agent:status', agentId, status: 'idle' });
    runningAutopilots.delete(agentId);
  }
}

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
