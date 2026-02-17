import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import {
  runQuery, getOne, getAll, generateId, getNow,
  createTask, updateTask, deleteTask, reorderTask,
  createFolder, updateFolder, deleteFolder,
  createAgent as dbCreateAgent, updateAgent, deleteAgent, updateAgentStatus,
  createGoal, updateGoal, deleteGoal,
  createWorkflow, updateWorkflow, deleteWorkflow,
  createCommand, updateCommand,
  listTasks, listFolders, listAgents, listGoals, listWorkflows, listCommands,
  listGoalLog, listAgentCommands, listAgentActivity,
} from './db-helpers.js';
import type { Folder, Task, Agent, Command, Goal, GoalLogEntry, GoalStats, Workflow, Assessment, WSClientMessage, WSServerMessage, RepoInfo, TimelineRun } from '../client/lib/types.js';
import {
  assessPerformance, identifyImprovements, awardXp,
  getAgentImprovements, getAgentAssessments, getAgentXpEvents,
  skipImprovement, markImprovementRunning, completeImprovement, failImprovement,
  getDashboardData, getAgentSkills, getAllExperiments, createExperiment,
} from './self-improve.js';

// Track running improvements: agentId → improvementId
const runningImprovements: Map<string, string> = new Map();
import { createAgent as ptyCreateAgent, sendToAgent, interruptAgent, killAgent, restartAgent, hasAgent } from './pty-manager.js';
import { triggerAutopilotRun, listAgentBranches, mergeAgentBranch, getAgentCwd, resetAgentSessionCounters } from './autopilot.js';
import { commitAgentChanges, stripAnsi, extractEditedFiles, generateSummary, getRecentCommits } from './git-utils.js';

const REPOS_DIR = process.env.REPOS_DIR || 'D:\\Repos';
const MAX_OUTPUT_BUFFER = 200; // lines per agent

/** Parse files_changed from JSON string (SQLite stores it as TEXT) */
function parseCommand(cmd: Command): Command {
  if (typeof cmd.files_changed === 'string') {
    try { cmd.files_changed = JSON.parse(cmd.files_changed as string); } catch { cmd.files_changed = []; }
  }
  return cmd;
}
function parseCommands(cmds: Command[]): Command[] {
  return cmds.map(parseCommand);
}

interface ConnectedClient {
  ws: WebSocket;
}

const clients: ConnectedClient[] = [];

// Server-side output buffer so reconnecting clients can see recent output
const agentOutputBuffers: Map<string, string[]> = new Map();

// Track current running command per agent (agentId → commandId)
const currentCommandIds: Map<string, string> = new Map();

// Track retry attempts per agent to avoid infinite loops (agentId → { count, originalPrompt })
const retryState: Map<string, { count: number; maxRetries: number; originalPrompt: string }> = new Map();
// Track whether a self-review pass is pending (agentId → true)
const reviewPending: Map<string, boolean> = new Map();

function appendAgentOutput(agentId: string, chunk: string): void {
  let buf = agentOutputBuffers.get(agentId);
  if (!buf) {
    buf = [];
    agentOutputBuffers.set(agentId, buf);
  }
  const lines = chunk.split('\n');
  buf.push(...lines);
  if (buf.length > MAX_OUTPUT_BUFFER) {
    buf.splice(0, buf.length - MAX_OUTPUT_BUFFER);
  }
}

function clearAgentOutput(agentId: string): void {
  agentOutputBuffers.delete(agentId);
}

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log('Client connected');
    clients.push({ ws });

    ws.on('message', (data) => {
      handleWsMessage(ws, data.toString());
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      const index = clients.findIndex((c) => c.ws === ws);
      if (index !== -1) {
        clients.splice(index, 1);
      }
    });
  });
}

function broadcast(message: WSServerMessage): void {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  });
}

function send(ws: WebSocket, message: WSServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// generateId is imported from db-helpers

function handleMessage(ws: WebSocket, message: WSClientMessage): void {
  switch (message.type) {
    case 'task:create': {
      createTask(
        { folderId: message.folderId, title: message.title, description: message.description, parentTaskId: message.parentTaskId, goalId: message.goalId },
        (task) => broadcast({ type: 'task:updated', task })
      );
      break;
    }

    case 'task:update': {
      updateTask(
        message.taskId,
        { ...message.fields, goal_id: (message.fields as any).goal_id },
        (task) => broadcast({ type: 'task:updated', task })
      );
      break;
    }

    case 'task:delete': {
      deleteTask(message.taskId, () => broadcast({ type: 'task:deleted', taskId: message.taskId }));
      break;
    }

    case 'task:reorder': {
      reorderTask(message.taskId, message.sortOrder, (task) => broadcast({ type: 'task:updated', task }));
      break;
    }

    case 'folder:create': {
      createFolder(
        { name: message.name, icon: message.icon },
        (folder) => broadcast({ type: 'folder:updated', folder })
      );
      break;
    }

    case 'folder:update': {
      updateFolder(
        message.folderId,
        message.fields,
        (folder) => broadcast({ type: 'folder:updated', folder })
      );
      break;
    }

    case 'folder:delete': {
      deleteFolder(message.folderId, () => broadcast({ type: 'folder:deleted', folderId: message.folderId }));
      break;
    }

    case 'agent:create': {
      const workDir = message.workingDirectory;
      const createdAgent = dbCreateAgent(
        { workingDirectory: workDir, name: message.name, profileId: message.profileId },
        (agent) => broadcast({ type: 'agent:updated', agent })
      );

      // Create a git worktree for this agent so it has an isolated working directory
      if (createdAgent) {
        try {
          const safeName = (createdAgent.name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
          const worktreePath = path.join(workDir + '-agents', `${safeName}-${createdAgent.id.slice(0, 8)}`);
          fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
          execSync(`git worktree add --detach "${worktreePath}" main`, { cwd: workDir, timeout: 30_000 });
          const srcModules = path.join(workDir, 'node_modules');
          const dstModules = path.join(worktreePath, 'node_modules');
          if (fs.existsSync(srcModules) && !fs.existsSync(dstModules)) {
            execSync(`cmd /c mklink /J "${dstModules}" "${srcModules}"`, { timeout: 10_000 });
          }
          runQuery('UPDATE agents SET worktree_path = ? WHERE id = ?', [worktreePath, createdAgent.id]);
          console.log(`[agent:create] Worktree created at ${worktreePath}`);
          // Re-broadcast with worktree_path set
          const updated = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [createdAgent.id]);
          if (updated) broadcast({ type: 'agent:updated', agent: updated });
        } catch (wtErr: any) {
          console.error(`[agent:create] Failed to create worktree:`, wtErr.message || wtErr);
        }
      }
      break;
    }

    case 'agent:kill': {
      const { agentId } = message;
      killAgent(agentId);
      runQuery(`UPDATE agents SET status = 'dead' WHERE id = ?`, [agentId]);
      broadcast({ type: 'agent:status', agentId, status: 'dead' });
      break;
    }

    case 'agent:restart': {
      const { agentId } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        const now = getNow();
        runQuery(`UPDATE agents SET status = 'running', last_activity = ? WHERE id = ?`, [now, agentId]);
        clearAgentOutput(agentId);

        const handleOutput = (id: string, chunk: string) => {
          appendAgentOutput(id, chunk);
          broadcast({ type: 'agent:output', agentId: id, chunk });
        };

        const handleExit = (id: string, code: number) => {
          const exitStatus = code === 0 ? 'idle' : 'dead';
          const finishedAt = getNow();

          const cmdId = currentCommandIds.get(id);
          if (cmdId) {
            const buf = agentOutputBuffers.get(id);
            const rawOutput = buf ? stripAnsi(buf.join('\n')) : '';
            const cmdStatus = code === 0 ? 'done' : 'error';
            const summary = rawOutput ? generateSummary(rawOutput, '') : '';
            const filesChanged = extractEditedFiles(rawOutput);
            runQuery(
              `UPDATE commands SET status = ?, completed_at = ?, raw_output = ?, summary = ?, files_changed = ? WHERE id = ?`,
              [cmdStatus, finishedAt, rawOutput, summary, JSON.stringify(filesChanged), cmdId]
            );
            const updatedCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [cmdId]);
            if (updatedCmd) {
              broadcast({ type: 'command:updated', command: parseCommand(updatedCmd) });
            }
            currentCommandIds.delete(id);
            if (summary) {
              const summaryLine = `\n--- Summary: ${summary} ---\n`;
              appendAgentOutput(id, summaryLine);
              broadcast({ type: 'agent:output', agentId: id, chunk: summaryLine });
            }
          }

          runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, finishedAt, id]);
          broadcast({ type: 'agent:status', agentId: id, status: exitStatus });
        };

        restartAgent(agentId, getAgentCwd(agent), agent.name, handleOutput, handleExit, agent.agent_type);
        broadcast({ type: 'agent:status', agentId, status: 'running' });
      }
      break;
    }

    case 'agent:send': {
      const { agentId, prompt, taskId } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);

      if (agent) {
        const commandId = generateId();
        const now = getNow();

        runQuery(
          `INSERT INTO commands (id, agent_id, task_id, prompt, status, started_at)
           VALUES (?, ?, ?, ?, 'running', ?)`,
          [commandId, agentId, taskId || null, prompt, now]
        );
        currentCommandIds.set(agentId, commandId);

        const existingPty = hasAgent(agentId);
        if (!existingPty) {
          clearAgentOutput(agentId);
          const handleOutput = (id: string, chunk: string) => {
            appendAgentOutput(id, chunk);
            broadcast({ type: 'agent:output', agentId: id, chunk });
          };

          const handleExit = (id: string, code: number) => {
            const finishedAt = getNow();
            let summary = '';

            const cmdId = currentCommandIds.get(id);
            if (cmdId) {
              const buf = agentOutputBuffers.get(id);
              const rawOutput = buf ? stripAnsi(buf.join('\n')) : '';
              const cmdStatus = code === 0 ? 'done' : 'error';
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
              currentCommandIds.delete(id);
              if (summary) {
                const summaryLine = `\n--- Summary: ${summary} ---\n`;
                appendAgentOutput(id, summaryLine);
                broadcast({ type: 'agent:output', agentId: id, chunk: summaryLine });
              }
            }

            // Auto-retry on failure: if the task failed, try to fix it
            const retry = retryState.get(id);
            const retryCount = retry?.count || 0;
            const maxRetries = retry?.maxRetries || 2;

            // Check if the output contains test failures even on exit code 0
            const buf2 = agentOutputBuffers.get(id);
            const rawTail = buf2 ? stripAnsi(buf2.slice(-50).join('\n')) : '';
            const hasTestFailure = rawTail.includes('[FAIL]') || rawTail.includes('TSC_ERROR_START');
            const effectiveFailure = code !== 0 || hasTestFailure;

            if (effectiveFailure && retryCount < maxRetries) {
              const nextRetry = retryCount + 1;
              retryState.set(id, { count: nextRetry, maxRetries, originalPrompt: retry?.originalPrompt || prompt });

              const retryMsg = `\n=== Auto-retry ${nextRetry}/${maxRetries} — fixing errors ===\n`;
              appendAgentOutput(id, retryMsg);
              broadcast({ type: 'agent:output', agentId: id, chunk: retryMsg });

              // Extract specific error lines for a targeted fix prompt
              const tscErrors = rawTail.match(/src\/[^\n]+error TS\d+:[^\n]+/g) || [];
              const buildErrors = rawTail.includes('BUILD_ERROR_START') ?
                rawTail.split('BUILD_ERROR_START')[1]?.split('BUILD_ERROR_END')[0]?.trim() || '' : '';

              let fixPrompt: string;
              if (tscErrors.length > 0) {
                const errorList = tscErrors.slice(0, 10).join('\n');
                fixPrompt = `TypeScript type errors found after your changes. Fix these specific errors:\n\n${errorList}\n\nIMPORTANT: If errors mention types not existing on an interface, check src/client/lib/types.ts and add the missing properties. If errors mention WSClientMessage or WSServerMessage, you need to add the missing message type to the union in types.ts.`;
              } else if (buildErrors) {
                fixPrompt = `Build failed with these errors:\n\n${buildErrors}\n\nFix the build errors.`;
              } else {
                const errorTail = rawTail.slice(-1000);
                fixPrompt = `The previous task failed (exit code ${code}). Error output:\n\n${errorTail}\n\nFix the issues. Original task: ${retry?.originalPrompt || prompt}`;
              }

              // Create a new command for the retry
              const retryCmdId = generateId();
              const retryNow = getNow();
              runQuery(
                `INSERT INTO commands (id, agent_id, task_id, prompt, status, started_at)
                 VALUES (?, ?, ?, ?, 'running', ?)`,
                [retryCmdId, agentId, taskId || null, `[Retry ${nextRetry}] Fix errors`, retryNow]
              );
              currentCommandIds.set(id, retryCmdId);
              const retryCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [retryCmdId]);
              if (retryCmd) broadcast({ type: 'command:updated', command: parseCommand(retryCmd) });

              sendToAgent(id, fixPrompt);
              return; // Don't mark agent as idle yet
            }

            // Done (success or exhausted retries)
            retryState.delete(id);
            let succeeded = code === 0 && !hasTestFailure;

            // No-op detection: check both uncommitted diff AND recent commits
            // Claude Code may auto-commit, so we check git log too
            if (succeeded && agent) {
              try {
                const agentDir = getAgentCwd(agent);
                const noopDiff = execSync('git diff --stat', { cwd: agentDir, encoding: 'utf-8', timeout: 5000 }).trim();
                const stagedDiff = execSync('git diff --cached --stat', { cwd: agentDir, encoding: 'utf-8', timeout: 5000 }).trim();
                // Check if any commits were made in the last 10 minutes (agent's work)
                const recentCommits = getRecentCommits(agentDir, '10 minutes ago', 5);
                if (!noopDiff && !stagedDiff && !recentCommits) {
                  succeeded = false;
                  const noopMsg = '\n--- No changes made — agent did not edit any files ---\n';
                  appendAgentOutput(id, noopMsg);
                  broadcast({ type: 'agent:output', agentId: id, chunk: noopMsg });
                }
              } catch {}
            }

            // Self-review pass: check uncommitted changes OR recent commits
            const reviewState = reviewPending.get(id);
            if (succeeded && agent && !reviewState) {
              try {
                const reviewDir = getAgentCwd(agent);
                let diffStat = execSync('git diff --stat', { cwd: reviewDir, encoding: 'utf-8', timeout: 5000 }).trim();
                let diffContent = '';

                if (diffStat) {
                  // Uncommitted changes — diff them
                  diffContent = execSync('git diff', { cwd: reviewDir, encoding: 'utf-8', timeout: 10000 }).trim();
                } else {
                  // Maybe agent auto-committed — check last commit's diff
                  const recentCommits = getRecentCommits(reviewDir, '10 minutes ago', 1);
                  if (recentCommits) {
                    diffStat = execSync('git diff HEAD~1 --stat', { cwd: reviewDir, encoding: 'utf-8', timeout: 5000 }).trim();
                    diffContent = execSync('git diff HEAD~1', { cwd: reviewDir, encoding: 'utf-8', timeout: 10000 }).trim();
                  }
                }

                if (diffStat && diffContent) {
                  if (diffContent.length > 3000) {
                    diffContent = diffContent.slice(0, 3000) + '\n...(truncated)';
                  }
                  reviewPending.set(id, true);

                  // Create a new command for the review so it's tracked properly
                  const reviewCmdId = generateId();
                  const reviewNow = getNow();
                  runQuery(
                    `INSERT INTO commands (id, agent_id, task_id, prompt, status, started_at)
                     VALUES (?, ?, ?, ?, 'running', ?)`,
                    [reviewCmdId, agentId, taskId || null, '[Self-review] Checking for bugs', reviewNow]
                  );
                  currentCommandIds.set(id, reviewCmdId);
                  const reviewCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [reviewCmdId]);
                  if (reviewCmd) broadcast({ type: 'command:updated', command: parseCommand(reviewCmd) });

                  const reviewMsg = '\n\n─── Self-review ───\n';
                  appendAgentOutput(id, reviewMsg);
                  broadcast({ type: 'agent:output', agentId: id, chunk: reviewMsg });

                  const reviewPrompt = `Review these changes for the task: "${prompt.slice(0, 100)}"\n\nFiles changed:\n${diffStat}\n\nDiff:\n${diffContent}\n\nOnly review the files relevant to the task (src/client/, public/, etc). Ignore any server infrastructure files (src/server/). Check for: logic bugs, missing imports, wrong file edited, broken types, accidentally created files. If you find issues, fix them. If everything looks correct, just say "Changes look good." Be brief.`;
                  sendToAgent(id, reviewPrompt);
                  return; // Don't finalize yet, wait for review to complete
                }
              } catch {
                // Diff failed, skip review
              }
            }
            reviewPending.delete(id);

            // Commit changes if successful (auto-commits is off, orchestrator handles it)
            if (succeeded && agent) {
              const buf3 = agentOutputBuffers.get(id);
              const fullOutput = buf3 ? buf3.join('\n') : '';
              const committed = commitAgentChanges(getAgentCwd(agent), prompt, fullOutput);
              if (committed) {
                const commitMsg = '\n─── Changes committed ───\n';
                appendAgentOutput(id, commitMsg);
                broadcast({ type: 'agent:output', agentId: id, chunk: commitMsg });
              }

              // Auto-verify UI if the change touched client files
              const changedFiles = extractEditedFiles(rawTail);
              const touchedUI = changedFiles.some(f => f.includes('src/client') || f.endsWith('.tsx') || f.endsWith('.css'));
              if (touchedUI) {
                try {
                  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: (process.env.LOCALAPPDATA || '') + '\\ms-playwright' };
                  const verifyOutput = execSync(
                    'powershell -ExecutionPolicy Bypass -File verify-ui.ps1',
                    { cwd: getAgentCwd(agent), encoding: 'utf-8', timeout: 30000, env }
                  );
                  appendAgentOutput(id, `\n${verifyOutput}\n`);
                  broadcast({ type: 'agent:output', agentId: id, chunk: `\n${verifyOutput}\n` });
                } catch {
                  // UI verification is best-effort, don't fail the task
                }
              }
            }

            // ── Performance Assessment ──
            const origCmdId = cmdId || currentCommandIds.get(id);
            if (origCmdId) {
              const startedCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [origCmdId]);
              const durationMs = startedCmd?.started_at
                ? new Date(finishedAt).getTime() - new Date(startedCmd.started_at).getTime()
                : 0;
              const retryInfo = retryState.get(id);
              const retryCount = retryInfo?.count || 0;
              const filesChanged = extractEditedFiles(rawTail);

              const assessment = assessPerformance(id, origCmdId, {
                retries: retryCount,
                buildFailures: 0,
                reviewIssues: 0,
                filesTouched: filesChanged.length,
                durationMs,
                completedFully: succeeded,
              });
              broadcast({ type: 'agent:assessments', agentId: id, assessments: getAgentAssessments(id) });

              // Award XP: 1 for completion, bonus for perfect scores
              if (succeeded) {
                const xpGain = assessment.score >= 90 ? 2 : 1;
                const reason = `Command completed (score ${assessment.score})`;
                const { newXp, event } = awardXp(id, xpGain, reason, 'command');
                broadcast({ type: 'agent:xp', agentId: id, xp: newXp, event });
              }

              // Async: identify improvements after agent goes idle
              const assessId = assessment.id;
              const assessScore = assessment.score;
              setTimeout(() => {
                const buf4 = agentOutputBuffers.get(id);
                const fullRaw = buf4 ? buf4.join('\n') : '';
                const improvements = identifyImprovements(id, assessId, fullRaw, prompt, assessScore, retryCount);
                if (improvements.length > 0) {
                  broadcast({ type: 'agent:improvements', agentId: id, improvements: getAgentImprovements(id) });
                }
              }, 500);
            }

            // Complete/fail running improvement if this agent had one
            const runningImpId = runningImprovements.get(id);
            if (runningImpId) {
              if (succeeded) {
                const xpGain = 2;
                const completedImp = completeImprovement(runningImpId, xpGain);
                if (completedImp) {
                  awardXp(id, xpGain, `Improvement completed: ${completedImp.description}`, 'improvement');
                  broadcast({ type: 'improvement:updated', improvement: completedImp });
                }
              } else {
                const failedImp = failImprovement(runningImpId);
                if (failedImp) {
                  broadcast({ type: 'improvement:updated', improvement: failedImp });
                }
              }
              runningImprovements.delete(id);
              broadcast({ type: 'agent:improvements', agentId: id, improvements: getAgentImprovements(id) });
            }

            const exitStatus = succeeded ? 'idle' : 'dead';
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

          ptyCreateAgent(agentId, getAgentCwd(agent), agent.name, handleOutput, handleExit, agent.agent_type);
        }

        runQuery(`UPDATE agents SET status = 'running', last_activity = ? WHERE id = ?`, [now, agentId]);
        sendToAgent(agentId, prompt);
        broadcast({ type: 'agent:status', agentId, status: 'running' });

        // Broadcast the new running command so client chat shows it immediately
        const newCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [commandId]);
        if (newCmd) {
          broadcast({ type: 'command:updated', command: parseCommand(newCmd) });
        }
      }
      break;
    }

    case 'agent:interrupt': {
      const { agentId } = message;
      interruptAgent(agentId);
      break;
    }

    case 'agent:verify-ui': {
      const { agentId, url, navigate } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        const verifyUrl = url || 'http://localhost:3456';
        const args = ['-ExecutionPolicy', 'Bypass', '-File', 'verify-ui.ps1', '-Url', verifyUrl];
        if (navigate) args.push('-Navigate', navigate);

        try {
          const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.LOCALAPPDATA + '\\ms-playwright' };
          const output = execSync(`powershell ${args.join(' ')}`, {
            cwd: getAgentCwd(agent),
            encoding: 'utf-8',
            timeout: 30000,
            env,
          });
          appendAgentOutput(agentId, `\n--- UI Verification ---\n${output}\n`);
          broadcast({ type: 'agent:output', agentId, chunk: `\n--- UI Verification ---\n${output}\n` });
        } catch (e: any) {
          const errOutput = e.stdout || e.message || 'Verification failed';
          appendAgentOutput(agentId, `\n--- UI Verification FAILED ---\n${errOutput}\n`);
          broadcast({ type: 'agent:output', agentId, chunk: `\n--- UI Verification FAILED ---\n${errOutput}\n` });
        }
      }
      break;
    }

    case 'agent:delete': {
      const { agentId } = message;
      if (hasAgent(agentId)) {
        killAgent(agentId);
      }
      // Remove git worktree if this agent had one
      const delAgent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (delAgent?.worktree_path) {
        try {
          // Remove node_modules junction first — git worktree remove can't delete junctions on Windows
          const junctionPath = path.join(delAgent.worktree_path, 'node_modules');
          try {
            const stat = fs.lstatSync(junctionPath);
            if (stat.isSymbolicLink() || stat.isDirectory()) {
              // On Windows, junctions appear as directories but must be removed with rmdir (not recursive)
              execSync(`cmd /c rmdir "${junctionPath}"`, { timeout: 5_000 });
            }
          } catch { /* junction doesn't exist, fine */ }
          execSync(`git worktree remove "${delAgent.worktree_path}" --force`, {
            cwd: delAgent.working_directory,
            timeout: 30_000,
          });
          console.log(`[agent:delete] Worktree removed: ${delAgent.worktree_path}`);
        } catch (wtErr: any) {
          console.error(`[agent:delete] Failed to remove worktree:`, wtErr.message || wtErr);
        }
      }
      clearAgentOutput(agentId);
      currentCommandIds.delete(agentId);
      runQuery('DELETE FROM commands WHERE agent_id = ?', [agentId]);
      runQuery('DELETE FROM agents WHERE id = ?', [agentId]);
      broadcast({ type: 'agent:deleted', agentId });
      break;
    }

    case 'agent:update': {
      updateAgent(
        message.agentId,
        message.fields,
        (agent) => broadcast({ type: 'agent:updated', agent })
      );
      break;
    }

    case 'agent:schedule': {
      const { agentId, schedule, enabled, prompt } = message;
      runQuery(
        `UPDATE agents SET schedule = ?, schedule_enabled = ?, schedule_prompt = ?, last_activity = ? WHERE id = ?`,
        [schedule, enabled ? 1 : 0, prompt, getNow(), agentId]
      );
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        broadcast({ type: 'agent:updated', agent });
      }
      break;
    }

    case 'agent:history': {
      send(ws, { type: 'agent:history', agentId: message.agentId, commands: parseCommands(listAgentCommands(message.agentId, message.limit || 50)) });
      break;
    }

    case 'agent:activity': {
      send(ws, { type: 'agent:activity', agentId: message.agentId, entries: listAgentActivity(message.agentId, message.limit || 50) });
      break;
    }

    case 'repos:list': {
      try {
        const entries = fs.readdirSync(REPOS_DIR, { withFileTypes: true });
        const repos: RepoInfo[] = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
          .map((e) => {
            const fullPath = path.join(REPOS_DIR, e.name);
            const hasGit = fs.existsSync(path.join(fullPath, '.git'));
            return { name: e.name, path: fullPath, hasGit };
          })
          .sort((a, b) => {
            if (a.hasGit !== b.hasGit) return a.hasGit ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        send(ws, { type: 'repos:list', repos });
      } catch (error) {
        console.error('Failed to list repos:', error);
        send(ws, { type: 'repos:list', repos: [] });
      }
      break;
    }

    case 'goal:create': {
      createGoal(
        { name: message.name, description: message.description, repoId: message.repoId },
        (goal) => broadcast({ type: 'goal:updated', goal })
      );
      break;
    }

    case 'goal:propose': {
      const goal = createGoal(
        { name: message.name, description: message.description, repoId: message.repoId, proposedBy: message.agentId, proposalStatus: 'pending' },
        (g) => {
          broadcast({ type: 'goal:proposed', goal: g, agentId: message.agentId });
          broadcast({ type: 'goal:updated', goal: g });
        }
      );
      break;
    }

    case 'goal:update': {
      updateGoal(
        message.goalId,
        { ...message.fields, proposal_status: (message.fields as any).proposal_status },
        (goal) => broadcast({ type: 'goal:updated', goal })
      );
      break;
    }

    case 'goal:delete': {
      deleteGoal(message.goalId, () => broadcast({ type: 'goal:deleted', goalId: message.goalId }));
      break;
    }

    case 'goal:set-priority': {
      const clampedPriority = message.priority === 0 ? 0 : Math.max(1, Math.min(5, message.priority));
      updateGoal(
        message.goalId,
        { priority: clampedPriority },
        (goal) => broadcast({ type: 'goal:updated', goal })
      );
      break;
    }

    case 'goal:list': {
      send(ws, { type: 'goal:list', goals: listGoals() });
      break;
    }

    case 'goal:log': {
      const entries = listGoalLog(message.goalId, message.limit || 50);
      send(ws, { type: 'goal:log', goalId: message.goalId, entries });
      break;
    }

    case 'goal:get-stats': {
      const stats = getOne<GoalStats>('SELECT * FROM goal_stats WHERE goal_id = ?', [message.goalId]);
      send(ws, { type: 'goal:stats', goalId: message.goalId, stats: stats ?? null });
      break;
    }

    case 'agent:autopilot': {
      const { agentId, autopilot, interval, goalId } = message;
      runQuery(
        'UPDATE agents SET autopilot = ?, autopilot_interval = ?, autopilot_goal_id = ?, last_activity = ? WHERE id = ?',
        [autopilot ? 1 : 0, interval, goalId, getNow(), agentId]
      );
      if (autopilot) {
        resetAgentSessionCounters(agentId);
      }
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        broadcast({ type: 'agent:updated', agent });
      }
      break;
    }

    case 'agent:autopilot:trigger': {
      triggerAutopilotRun(message.agentId);
      break;
    }

    case 'workflow:create': {
      createWorkflow(
        { name: message.name, description: message.description, steps: message.steps },
        (workflow) => broadcast({ type: 'workflow:updated', workflow })
      );
      break;
    }

    case 'workflow:update': {
      updateWorkflow(
        message.workflowId,
        message.fields,
        (workflow) => broadcast({ type: 'workflow:updated', workflow })
      );
      break;
    }

    case 'workflow:delete': {
      deleteWorkflow(message.workflowId, () => broadcast({ type: 'workflow:deleted', workflowId: message.workflowId }));
      break;
    }

    case 'workflow:list': {
      send(ws, { type: 'workflow:list', workflows: listWorkflows() });
      break;
    }

    case 'agent:self-improve': {
      const { agentId, enabled } = message;
      runQuery('UPDATE agents SET self_improve = ?, last_activity = ? WHERE id = ?', [enabled ? 1 : 0, getNow(), agentId]);
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        broadcast({ type: 'agent:updated', agent });
      }
      break;
    }

    case 'agent:improvements': {
      const improvements = getAgentImprovements(message.agentId);
      send(ws, { type: 'agent:improvements', agentId: message.agentId, improvements });
      break;
    }

    case 'agent:assessments': {
      const assessments = getAgentAssessments(message.agentId);
      send(ws, { type: 'agent:assessments', agentId: message.agentId, assessments });
      break;
    }

    case 'agent:xp-events': {
      const events = getAgentXpEvents(message.agentId);
      send(ws, { type: 'agent:xp-events', agentId: message.agentId, events });
      break;
    }

    case 'improvement:skip': {
      const imp = skipImprovement(message.improvementId);
      if (imp) {
        broadcast({ type: 'improvement:updated', improvement: imp });
      }
      break;
    }

    case 'improvement:execute': {
      const { improvementId, agentId } = message;
      const imp = markImprovementRunning(improvementId);
      if (imp) {
        broadcast({ type: 'improvement:updated', improvement: imp });
        runningImprovements.set(agentId, improvementId);
        // Execute the improvement as a task sent to the agent
        const agentData = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
        if (agentData && agentData.status === 'idle') {
          // Send as a normal agent command - the improvement prompt
          const prompt = `Self-improvement task: ${imp.description}\n\nMake minimal, focused changes. Run the build to verify.`;
          handleMessage(ws, { type: 'agent:send', agentId, prompt });
        }
      }
      break;
    }

    case 'agent:dashboard': {
      const data = getDashboardData(message.agentId);
      send(ws, { type: 'agent:dashboard', agentId: message.agentId, data });
      break;
    }

    case 'agent:skills': {
      const skills = getAgentSkills(message.agentId);
      send(ws, { type: 'agent:skills', agentId: message.agentId, skills });
      break;
    }

    case 'agent:experiments': {
      const experiments = getAllExperiments(message.agentId);
      send(ws, { type: 'agent:experiments', agentId: message.agentId, experiments });
      break;
    }

    case 'agent:create-experiment': {
      const { agentId, name, hypothesis, variantA, variantB } = message;
      const experiment = createExperiment(agentId, name, hypothesis, variantA, variantB);
      broadcast({ type: 'agent:experiments', agentId, experiments: getAllExperiments(agentId) });
      break;
    }

    case 'agent:timeline': {
      const { agentId } = message;
      const entries = getAll<GoalLogEntry>(
        'SELECT * FROM goal_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100',
        [agentId]
      );
      // Group entries into runs by branch name or 15-min time windows
      const runs: TimelineRun[] = [];
      let currentRun: TimelineRun | null = null;
      // Process in chronological order
      const sorted = [...entries].reverse();
      for (const entry of sorted) {
        // Extract branch from summary
        const branchMatch = entry.summary.match(/\[branch: ([^\]]+)\]/);
        const branch = branchMatch ? branchMatch[1] : '';
        const entryTime = new Date(entry.created_at).getTime();

        // Start new run if: different branch, or >15 min gap, or planning action
        const shouldStartNew = !currentRun
          || (branch && currentRun.branch && branch !== currentRun.branch)
          || (entryTime - new Date(currentRun.endedAt).getTime() > 15 * 60 * 1000)
          || entry.action === 'planning';

        if (shouldStartNew) {
          currentRun = {
            id: entry.id,
            branch: branch || 'unknown',
            startedAt: entry.created_at,
            endedAt: entry.created_at,
            stages: [entry],
            success: entry.success === 1,
            totalDurationMs: entry.duration_ms,
            totalTokens: entry.total_tokens || 0,
          };
          runs.push(currentRun);
        } else {
          currentRun!.stages.push(entry);
          currentRun!.endedAt = entry.created_at;
          currentRun!.totalDurationMs += entry.duration_ms;
          currentRun!.totalTokens += entry.total_tokens || 0;
          // Run is successful only if ALL stages succeeded
          if (entry.success !== 1) currentRun!.success = false;
        }
      }
      // Return most recent runs first
      send(ws, { type: 'agent:timeline', agentId, runs: runs.reverse().slice(0, 20) });
      break;
    }

    case 'agent:branches': {
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [message.agentId]);
      if (agent) {
        listAgentBranches(agent.working_directory).then(branches => {
          send(ws, { type: 'agent:branches', agentId: message.agentId, branches });
        });
      }
      break;
    }

    case 'agent:merge-branch': {
      const { agentId, branchName } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        mergeAgentBranch(agent.working_directory, getAgentCwd(agent), branchName).then(result => {
          broadcast({ type: 'agent:branch-merged', agentId, branchName, success: result.success, output: result.output });
        });
      }
      break;
    }

    case 'agent:discard-branch': {
      const { agentId, branchName } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        execAsync(`git branch -D "${branchName}"`, { cwd: getAgentCwd(agent), timeout: 30_000 })
          .then(() => {
            broadcast({ type: 'agent:branch-discarded', agentId, branchName });
          })
          .catch(() => {});
      }
      break;
    }

    case 'sync:request': {
      const folders = listFolders();
      const tasks = listTasks();
      const agents = listAgents();
      const goals = listGoals();
      const workflows = listWorkflows();
      const recentCommands = listCommands(100);
      send(ws, { type: 'sync:state', folders, tasks, agents, goals, workflows, commands: parseCommands(recentCommands) });

      // Replay buffered output for all agents (last 100 lines max)
      for (const agent of agents) {
        const buf = agentOutputBuffers.get(agent.id);
        if (buf && buf.length > 0) {
          const tail = buf.slice(-100);
          send(ws, { type: 'agent:output', agentId: agent.id, chunk: tail.join('\n') });
        }
      }
      break;
    }
  }
}

export function getBroadcast(): (message: WSServerMessage) => void {
  return broadcast;
}

/** For testing only: register a mock WebSocket client to receive broadcasts. */
export function addClientForTest(ws: WebSocket): () => void {
  clients.push({ ws });
  return () => {
    const idx = clients.findIndex((c) => c.ws === ws);
    if (idx !== -1) clients.splice(idx, 1);
  };
}

export function handleWsMessage(ws: WebSocket, data: string): void {
  try {
    const message = JSON.parse(data) as WSClientMessage;
    handleMessage(ws, message);
  } catch (error) {
    console.error('Failed to parse WebSocket message:', error);
  }
}
