/**
 * Command lifecycle — handles the full lifecycle of an agent command:
 * output tracking, exit handling, retry logic, self-review, commit, assessment.
 *
 * Extracted from ws-handler.ts to keep the WebSocket handler thin.
 */
import { execSync } from 'child_process';
import {
  runQuery, getOne, generateId, getNow,
} from '../db-helpers.js';
import type { Agent, Command } from '../../client/lib/types.js';
import {
  assessPerformance, identifyImprovements, awardXp,
  getAgentImprovements, getAgentAssessments,
  completeImprovement, failImprovement,
} from '../self-improve.js';
import { commitAgentChanges, stripAnsi, extractEditedFiles, generateSummary, getRecentCommits } from '../git-utils.js';
import { sendToAgent } from '../pty-manager.js';
import { getAgentCwd } from '../autopilot.js';
import { Limits, Timeouts, XP, AgentStatus, CommandStatus } from '../engine/constants.js';
import { StateMachine } from '../engine/state-machine.js';
import { createCommandMachineDef, type CommandState, type CommandEvent, type CommandContext } from '../machines/command-machine.js';
import { wireTransitionLogging } from '../engine/machine-logger.js';

// ── Types ──

export type BroadcastFn = (message: any) => void;

// ── Command State Machines ──

/** Active command machines keyed by agentId */
const commandMachines: Map<string, StateMachine<CommandState, CommandEvent, CommandContext>> = new Map();

export function getCommandMachine(agentId: string): StateMachine<CommandState, CommandEvent, CommandContext> | undefined {
  return commandMachines.get(agentId);
}

/** Parse files_changed from JSON string (SQLite stores it as TEXT) */
export function parseCommand(cmd: Command): Command {
  if (typeof cmd.files_changed === 'string') {
    try { cmd.files_changed = JSON.parse(cmd.files_changed as string); } catch { cmd.files_changed = []; }
  }
  return cmd;
}

export function parseCommands(cmds: Command[]): Command[] {
  return cmds.map(parseCommand);
}

// ── Output Buffer Management ──

const agentOutputBuffers: Map<string, string[]> = new Map();

export function appendAgentOutput(agentId: string, chunk: string): void {
  let buf = agentOutputBuffers.get(agentId);
  if (!buf) {
    buf = [];
    agentOutputBuffers.set(agentId, buf);
  }
  const lines = chunk.split('\n');
  buf.push(...lines);
  if (buf.length > Limits.MAX_OUTPUT_BUFFER_LINES) {
    buf.splice(0, buf.length - Limits.MAX_OUTPUT_BUFFER_LINES);
  }
}

export function clearAgentOutput(agentId: string): void {
  agentOutputBuffers.delete(agentId);
}

export function getAgentOutputBuffer(agentId: string): string[] | undefined {
  return agentOutputBuffers.get(agentId);
}

// ── Command Tracking ──

/** Track current running command per agent (agentId → commandId) */
const currentCommandIds: Map<string, string> = new Map();

export function setCurrentCommandId(agentId: string, commandId: string): void {
  currentCommandIds.set(agentId, commandId);
}

export function getCurrentCommandId(agentId: string): string | undefined {
  return currentCommandIds.get(agentId);
}

export function clearCurrentCommandId(agentId: string): void {
  currentCommandIds.delete(agentId);
}

// retryState and reviewPending replaced by commandMachines — see CommandMachine

/** Track running improvements: agentId → improvementId */
const runningImprovements: Map<string, string> = new Map();

export function setRunningImprovement(agentId: string, improvementId: string): void {
  runningImprovements.set(agentId, improvementId);
}

// ── Output & Exit Handlers ──

export function createOutputHandler(broadcast: BroadcastFn) {
  return (agentId: string, chunk: string) => {
    appendAgentOutput(agentId, chunk);
    broadcast({ type: 'agent:output', agentId, chunk });
  };
}

/**
 * Finalize a command: update its DB record, broadcast to clients, generate summary.
 * Returns the summary string.
 */
function finalizeCommand(
  agentId: string,
  code: number,
  prompt: string,
  broadcast: BroadcastFn,
): string {
  const finishedAt = getNow();
  const cmdId = currentCommandIds.get(agentId);
  let summary = '';

  if (cmdId) {
    const buf = agentOutputBuffers.get(agentId);
    const rawOutput = buf ? stripAnsi(buf.join('\n')) : '';
    const cmdStatus = code === 0 ? CommandStatus.DONE : CommandStatus.ERROR;
    summary = rawOutput ? generateSummary(rawOutput, prompt) : '';
    const filesChanged = extractEditedFiles(rawOutput);
    runQuery(
      `UPDATE commands SET status = ?, completed_at = ?, raw_output = ?, summary = ?, files_changed = ? WHERE id = ?`,
      [cmdStatus, finishedAt, rawOutput, summary, JSON.stringify(filesChanged), cmdId]
    );
    const updatedCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [cmdId]);
    if (updatedCmd) {
      broadcast({ type: 'command:updated', command: parseCommand(updatedCmd) });
    }
    currentCommandIds.delete(agentId);
    if (summary) {
      const summaryLine = `\n--- Summary: ${summary} ---\n`;
      appendAgentOutput(agentId, summaryLine);
      broadcast({ type: 'agent:output', agentId, chunk: summaryLine });
    }
  }

  return summary;
}

/**
 * Check if the agent output indicates a failure (even if exit code was 0).
 */
function detectEffectiveFailure(agentId: string, code: number): { failed: boolean; rawTail: string } {
  const buf = agentOutputBuffers.get(agentId);
  const rawTail = buf ? stripAnsi(buf.slice(-50).join('\n')) : '';
  const hasTestFailure = rawTail.includes('[FAIL]') || rawTail.includes('TSC_ERROR_START');
  return { failed: code !== 0 || hasTestFailure, rawTail };
}

/**
 * Try to auto-retry a failed command. Returns true if a retry was initiated.
 */
function tryRetry(
  agentId: string,
  code: number,
  prompt: string,
  taskId: string | null,
  rawTail: string,
  broadcast: BroadcastFn,
): boolean {
  const machine = commandMachines.get(agentId);
  if (!machine) return false;

  // Ask the machine if retry is allowed (guard checks retryCount < maxRetries)
  const canRetry = machine.send('needs_retry');
  if (!canRetry) return false;

  const retryCount = machine.context.retryCount;
  const maxRetries = machine.context.maxRetries;
  const nextRetry = retryCount; // already incremented by machine reduce

  const retryMsg = `\n=== Auto-retry ${nextRetry}/${maxRetries} — fixing errors ===\n`;
  appendAgentOutput(agentId, retryMsg);
  broadcast({ type: 'agent:output', agentId, chunk: retryMsg });

  // Build a targeted fix prompt from the error output
  const tscErrors = rawTail.match(/src\/[^\n]+error TS\d+:[^\n]+/g) || [];
  const buildErrors = rawTail.includes('BUILD_ERROR_START') ?
    rawTail.split('BUILD_ERROR_START')[1]?.split('BUILD_ERROR_END')[0]?.trim() || '' : '';

  let fixPrompt: string;
  if (tscErrors.length > 0) {
    const errorList = tscErrors.slice(0, Limits.MAX_TSC_ERRORS_SHOWN).join('\n');
    fixPrompt = `TypeScript type errors found after your changes. Fix these specific errors:\n\n${errorList}\n\nIMPORTANT: If errors mention types not existing on an interface, check src/client/lib/types.ts and add the missing properties. If errors mention WSClientMessage or WSServerMessage, you need to add the missing message type to the union in types.ts.`;
  } else if (buildErrors) {
    fixPrompt = `Build failed with these errors:\n\n${buildErrors}\n\nFix the build errors.`;
  } else {
    const errorTail = rawTail.slice(-Limits.MAX_ERROR_TAIL_LENGTH);
    fixPrompt = `The previous task failed (exit code ${code}). Error output:\n\n${errorTail}\n\nFix the issues. Original task: ${machine.context.prompt || prompt}`;
  }

  // Create a new command for the retry
  const retryCmdId = generateId();
  const retryNow = getNow();
  runQuery(
    `INSERT INTO commands (id, agent_id, task_id, prompt, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
    [retryCmdId, agentId, taskId || null, `[Retry ${nextRetry}] Fix errors`, retryNow]
  );
  currentCommandIds.set(agentId, retryCmdId);
  const retryCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [retryCmdId]);
  if (retryCmd) broadcast({ type: 'command:updated', command: parseCommand(retryCmd) });

  sendToAgent(agentId, fixPrompt);
  machine.send('retry_sent'); // back to 'running'
  return true;
}

/**
 * Check if the agent actually made changes (no-op detection).
 */
function detectNoOp(agent: Agent): boolean {
  try {
    const agentDir = getAgentCwd(agent);
    const noopDiff = execSync('git diff --stat', { cwd: agentDir, encoding: 'utf-8', timeout: Timeouts.GIT_QUICK }).trim();
    const stagedDiff = execSync('git diff --cached --stat', { cwd: agentDir, encoding: 'utf-8', timeout: Timeouts.GIT_QUICK }).trim();
    const recentCommits = getRecentCommits(agentDir, '10 minutes ago', 5);
    return !noopDiff && !stagedDiff && !recentCommits;
  } catch {
    return false;
  }
}

/**
 * Trigger a self-review of the agent's changes. Returns true if review was initiated.
 */
function trySelfReview(
  agentId: string,
  agent: Agent,
  prompt: string,
  taskId: string | null,
  broadcast: BroadcastFn,
): boolean {
  const machine = commandMachines.get(agentId);
  if (!machine) return false;

  // Check if review already happened (machine context tracks reviewed flag)
  if (machine.context.reviewed) return false;

  try {
    const reviewDir = getAgentCwd(agent);
    let diffStat = execSync('git diff --stat', { cwd: reviewDir, encoding: 'utf-8', timeout: Timeouts.GIT_QUICK }).trim();
    let diffContent = '';

    if (diffStat) {
      diffContent = execSync('git diff', { cwd: reviewDir, encoding: 'utf-8', timeout: Timeouts.GIT_STANDARD }).trim();
    } else {
      const recentCommits = getRecentCommits(reviewDir, '10 minutes ago', 1);
      if (recentCommits) {
        diffStat = execSync('git diff HEAD~1 --stat', { cwd: reviewDir, encoding: 'utf-8', timeout: Timeouts.GIT_QUICK }).trim();
        diffContent = execSync('git diff HEAD~1', { cwd: reviewDir, encoding: 'utf-8', timeout: Timeouts.GIT_STANDARD }).trim();
      }
    }

    if (!diffStat || !diffContent) return false;

    if (diffContent.length > Limits.MAX_DIFF_PREVIEW_LENGTH) {
      diffContent = diffContent.slice(0, Limits.MAX_DIFF_PREVIEW_LENGTH) + '\n...(truncated)';
    }
    machine.send('needs_review', { diffStats: diffStat });

    // Create a new command for the review
    const reviewCmdId = generateId();
    const reviewNow = getNow();
    runQuery(
      `INSERT INTO commands (id, agent_id, task_id, prompt, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
      [reviewCmdId, agentId, taskId || null, '[Self-review] Checking for bugs', reviewNow]
    );
    currentCommandIds.set(agentId, reviewCmdId);
    const reviewCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [reviewCmdId]);
    if (reviewCmd) broadcast({ type: 'command:updated', command: parseCommand(reviewCmd) });

    const reviewMsg = '\n\n─── Self-review ───\n';
    appendAgentOutput(agentId, reviewMsg);
    broadcast({ type: 'agent:output', agentId, chunk: reviewMsg });

    const reviewPrompt = `Review these changes for the task: "${prompt.slice(0, 100)}"\n\nFiles changed:\n${diffStat}\n\nDiff:\n${diffContent}\n\nOnly review the files relevant to the task (src/client/, public/, etc). Ignore any server infrastructure files (src/server/). Check for: logic bugs, missing imports, wrong file edited, broken types, accidentally created files. If you find issues, fix them. If everything looks correct, just say "Changes look good." Be brief.`;
    sendToAgent(agentId, reviewPrompt);
    machine.send('review_sent'); // back to 'running', sets reviewed=true
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit changes if successful, run UI verification if needed.
 */
function commitAndVerify(
  agentId: string,
  agent: Agent,
  prompt: string,
  broadcast: BroadcastFn,
): void {
  const buf = agentOutputBuffers.get(agentId);
  const fullOutput = buf ? buf.join('\n') : '';
  const committed = commitAgentChanges(getAgentCwd(agent), prompt, fullOutput);
  if (committed) {
    const commitMsg = '\n─── Changes committed ───\n';
    appendAgentOutput(agentId, commitMsg);
    broadcast({ type: 'agent:output', agentId, chunk: commitMsg });
  }

  // Auto-verify UI if the change touched client files
  const rawTail = buf ? stripAnsi(buf.slice(-50).join('\n')) : '';
  const changedFiles = extractEditedFiles(rawTail);
  const touchedUI = changedFiles.some(f => f.includes('src/client') || f.endsWith('.tsx') || f.endsWith('.css'));
  if (touchedUI && process.platform === 'win32') {
    try {
      const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: (process.env.LOCALAPPDATA || '') + '\\ms-playwright' };
      const verifyOutput = execSync(
        'powershell -ExecutionPolicy Bypass -File verify-ui.ps1',
        { cwd: getAgentCwd(agent), encoding: 'utf-8', timeout: Timeouts.UI_VERIFY, env }
      );
      appendAgentOutput(agentId, `\n${verifyOutput}\n`);
      broadcast({ type: 'agent:output', agentId, chunk: `\n${verifyOutput}\n` });
    } catch {
      // UI verification is best-effort
    }
  }
}

/**
 * Run performance assessment and award XP after command completion.
 */
function assessAndAwardXp(
  agentId: string,
  agent: Agent,
  prompt: string,
  succeeded: boolean,
  broadcast: BroadcastFn,
): void {
  const finishedAt = getNow();
  const cmdId = currentCommandIds.get(agentId);
  // Use the command that was just finalized — check the most recent command
  const origCmdId = cmdId || (() => {
    // The command was already cleared by finalizeCommand, look it up
    const recent = getOne<Command>(
      'SELECT * FROM commands WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1',
      [agentId]
    );
    return recent?.id;
  })();

  if (!origCmdId) return;

  const startedCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [origCmdId]);
  const durationMs = startedCmd?.started_at
    ? new Date(finishedAt).getTime() - new Date(startedCmd.started_at).getTime()
    : 0;
  const machine = commandMachines.get(agentId);
  const retryCount = machine?.context.retryCount || 0;
  const buf = agentOutputBuffers.get(agentId);
  const rawTail = buf ? stripAnsi(buf.slice(-50).join('\n')) : '';
  const filesChanged = extractEditedFiles(rawTail);

  const assessment = assessPerformance(agentId, origCmdId, {
    retries: retryCount,
    buildFailures: 0,
    reviewIssues: 0,
    filesTouched: filesChanged.length,
    durationMs,
    completedFully: succeeded,
  });
  broadcast({ type: 'agent:assessments', agentId, assessments: getAgentAssessments(agentId) });

  // Award XP
  if (succeeded) {
    const xpGain = assessment.score >= 90 ? XP.PERFECT_SCORE_BONUS : XP.COMMAND_COMPLETE;
    const reason = `Command completed (score ${assessment.score})`;
    const { newXp, event } = awardXp(agentId, xpGain, reason, 'command');
    broadcast({ type: 'agent:xp', agentId, xp: newXp, event });
  }

  // Async: identify improvements after agent goes idle
  const assessId = assessment.id;
  const assessScore = assessment.score;
  setTimeout(() => {
    const buf2 = agentOutputBuffers.get(agentId);
    const fullRaw = buf2 ? buf2.join('\n') : '';
    const improvements = identifyImprovements(agentId, assessId, fullRaw, prompt, assessScore, retryCount);
    if (improvements.length > 0) {
      broadcast({ type: 'agent:improvements', agentId, improvements: getAgentImprovements(agentId) });
    }
  }, 500);
}

/**
 * Handle completion/failure of a running improvement task.
 */
function handleImprovementCompletion(
  agentId: string,
  succeeded: boolean,
  broadcast: BroadcastFn,
): void {
  const runningImpId = runningImprovements.get(agentId);
  if (!runningImpId) return;

  if (succeeded) {
    const completedImp = completeImprovement(runningImpId, XP.IMPROVEMENT_COMPLETE);
    if (completedImp) {
      awardXp(agentId, XP.IMPROVEMENT_COMPLETE, `Improvement completed: ${completedImp.description}`, 'improvement');
      broadcast({ type: 'improvement:updated', improvement: completedImp });
    }
  } else {
    const failedImp = failImprovement(runningImpId);
    if (failedImp) {
      broadcast({ type: 'improvement:updated', improvement: failedImp });
    }
  }
  runningImprovements.delete(agentId);
  broadcast({ type: 'agent:improvements', agentId, improvements: getAgentImprovements(agentId) });
}

/**
 * Initialize a CommandMachine for an agent's command execution.
 * Call this when a command starts (before createExitHandler).
 */
export function initCommandMachine(agentId: string, commandId: string, prompt: string, taskId: string | null): void {
  const def = createCommandMachineDef({
    commandId,
    agentId,
    prompt,
    taskId,
    startedAt: getNow(),
  });
  const machine = new StateMachine<CommandState, CommandEvent, CommandContext>(def);
  wireTransitionLogging(machine, agentId);
  commandMachines.set(agentId, machine);
}

/**
 * Create the full exit handler for an agent command.
 * This is the main entry point — it orchestrates the entire post-execution lifecycle.
 */
export function createExitHandler(
  agentId: string,
  prompt: string,
  taskId: string | null,
  agent: Agent,
  broadcast: BroadcastFn,
) {
  return (id: string, code: number) => {
    const machine = commandMachines.get(id);

    // Transition machine: running → checking
    machine?.send('exit', { exitCode: code, rawOutput: '' });

    const summary = finalizeCommand(id, code, prompt, broadcast);
    const { failed, rawTail } = detectEffectiveFailure(id, code);

    // Auto-retry on failure
    if (failed && tryRetry(id, code, prompt, taskId, rawTail, broadcast)) {
      return; // Retry initiated, don't finalize yet
    }

    let succeeded = !failed;

    // No-op detection
    if (succeeded) {
      const isNoOp = detectNoOp(agent);
      if (isNoOp) {
        succeeded = false;
        machine?.send('no_changes');
        const noopMsg = '\n--- No changes made — agent did not edit any files ---\n';
        appendAgentOutput(id, noopMsg);
        broadcast({ type: 'agent:output', agentId: id, chunk: noopMsg });
      }
    }

    // Self-review pass
    if (succeeded && trySelfReview(id, agent, prompt, taskId, broadcast)) {
      return; // Review initiated, don't finalize yet
    }

    // Commit and verify
    if (succeeded) {
      const buf = agentOutputBuffers.get(id);
      const rawOut = buf ? stripAnsi(buf.slice(-50).join('\n')) : '';
      const filesChanged = extractEditedFiles(rawOut);
      machine?.send('commit', { diffStats: '', filesChanged });
      commitAndVerify(id, agent, prompt, broadcast);
      machine?.send('committed');
    } else if (machine?.state === 'checking') {
      // Failed and no retry possible
      machine.send('exhausted');
    }

    // Performance assessment
    assessAndAwardXp(id, agent, prompt, succeeded, broadcast);

    // Complete/fail running improvement
    handleImprovementCompletion(id, succeeded, broadcast);

    // Clean up machine
    commandMachines.delete(id);

    // Final status update
    const finishedAt = getNow();
    const exitStatus = succeeded ? AgentStatus.IDLE : AgentStatus.DEAD;
    runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, finishedAt, id]);
    broadcast({ type: 'agent:status', agentId: id, status: exitStatus });

    const agentName = agent?.name || 'Agent';
    broadcast({
      type: 'notify',
      agentId: id,
      title: succeeded ? `${agentName} finished` : `${agentName} failed`,
      body: summary || (succeeded ? 'Task completed successfully' : `Exited with code ${code}`),
    });
  };
}

/**
 * Create a simpler exit handler for agent:restart (no retry/review logic).
 */
export function createSimpleExitHandler(broadcast: BroadcastFn) {
  return (id: string, code: number) => {
    finalizeCommand(id, code, '', broadcast);
    const finishedAt = getNow();
    const exitStatus = code === 0 ? AgentStatus.IDLE : AgentStatus.DEAD;
    runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, finishedAt, id]);
    broadcast({ type: 'agent:status', agentId: id, status: exitStatus });
  };
}
