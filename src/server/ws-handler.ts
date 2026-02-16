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
import type { Folder, Task, Agent, Command, Goal, GoalLogEntry, Workflow, Assessment, WSClientMessage, WSServerMessage, RepoInfo } from '../client/lib/types.js';
import {
  assessPerformance, identifyImprovements, awardXp,
  getAgentImprovements, getAgentAssessments, getAgentXpEvents,
  skipImprovement, markImprovementRunning,
  getDashboardData, getAgentSkills, getAllExperiments,
} from './self-improve.js';
import { createAgent as ptyCreateAgent, sendToAgent, interruptAgent, killAgent, restartAgent, hasAgent } from './pty-manager.js';
import { triggerAutopilotRun, listAgentBranches, mergeAgentBranch, getAgentCwd } from './autopilot.js';
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
      const id = generateId();
      const now = new Date().toISOString();
      runQuery(
        `INSERT INTO tasks (id, folder_id, parent_task_id, title, description, status, goal_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
        [id, message.folderId, message.parentTaskId || null, message.title, message.description || '', message.goalId || null, now, now]
      );
      const task = getOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (task) {
        broadcast({ type: 'task:updated', task });
      }
      break;
    }

    case 'task:update': {
      const { taskId, fields } = message;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (fields.title !== undefined) {
        updates.push('title = ?');
        values.push(fields.title);
      }
      if (fields.description !== undefined) {
        updates.push('description = ?');
        values.push(fields.description);
      }
      if (fields.status !== undefined) {
        updates.push('status = ?');
        values.push(fields.status);
      }
      if (fields.sort_order !== undefined) {
        updates.push('sort_order = ?');
        values.push(fields.sort_order);
      }
      if (fields.folder_id !== undefined) {
        updates.push('folder_id = ?');
        values.push(fields.folder_id);
      }
      if ((fields as any).goal_id !== undefined) {
        updates.push('goal_id = ?');
        values.push((fields as any).goal_id);
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(taskId);
        runQuery(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);
        const task = getOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
        if (task) {
          broadcast({ type: 'task:updated', task });
        }
      }
      break;
    }

    case 'task:delete': {
      runQuery('DELETE FROM tasks WHERE id = ?', [message.taskId]);
      broadcast({ type: 'task:deleted', taskId: message.taskId });
      break;
    }

    case 'task:reorder': {
      runQuery('UPDATE tasks SET sort_order = ? WHERE id = ?', [message.sortOrder, message.taskId]);
      const task = getOne<Task>('SELECT * FROM tasks WHERE id = ?', [message.taskId]);
      if (task) {
        broadcast({ type: 'task:updated', task });
      }
      break;
    }

    case 'folder:create': {
      const id = generateId();
      const now = new Date().toISOString();
      runQuery(
        `INSERT INTO folders (id, name, icon, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, message.name, message.icon || '📁', now, now]
      );
      const folder = getOne<Folder>('SELECT * FROM folders WHERE id = ?', [id]);
      if (folder) {
        broadcast({ type: 'folder:updated', folder });
      }
      break;
    }

    case 'folder:update': {
      const { folderId, fields } = message;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (fields.name !== undefined) {
        updates.push('name = ?');
        values.push(fields.name);
      }
      if (fields.icon !== undefined) {
        updates.push('icon = ?');
        values.push(fields.icon);
      }
      if (fields.sort_order !== undefined) {
        updates.push('sort_order = ?');
        values.push(fields.sort_order);
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(folderId);
        runQuery(`UPDATE folders SET ${updates.join(', ')} WHERE id = ?`, values);
        const folder = getOne<Folder>('SELECT * FROM folders WHERE id = ?', [folderId]);
        if (folder) {
          broadcast({ type: 'folder:updated', folder });
        }
      }
      break;
    }

    case 'folder:delete': {
      runQuery('DELETE FROM tasks WHERE folder_id = ?', [message.folderId]);
      runQuery('DELETE FROM folders WHERE id = ?', [message.folderId]);
      broadcast({ type: 'folder:deleted', folderId: message.folderId });
      break;
    }

    case 'agent:create': {
      const id = generateId();
      const now = new Date().toISOString();
      const name = message.name || 'Agent';
      const profileId = message.profileId || 'robot';
      const agentType = 'minimax';
      const workDir = message.workingDirectory;

      runQuery(
        `INSERT INTO agents (id, name, working_directory, profile_id, agent_type, status, created_at, last_activity)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
        [id, name, workDir, profileId, agentType, now, now]
      );

      // Create a git worktree for this agent so it has an isolated working directory
      try {
        const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
        const worktreePath = path.join(workDir + '-agents', `${safeName}-${id.slice(0, 8)}`);
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        execSync(`git worktree add --detach "${worktreePath}" main`, { cwd: workDir, timeout: 30_000 });
        // Create node_modules junction so the agent can build
        const srcModules = path.join(workDir, 'node_modules');
        const dstModules = path.join(worktreePath, 'node_modules');
        if (fs.existsSync(srcModules) && !fs.existsSync(dstModules)) {
          execSync(`cmd /c mklink /J "${dstModules}" "${srcModules}"`, { timeout: 10_000 });
        }
        runQuery('UPDATE agents SET worktree_path = ? WHERE id = ?', [worktreePath, id]);
        console.log(`[agent:create] Worktree created at ${worktreePath}`);
      } catch (wtErr: any) {
        console.error(`[agent:create] Failed to create worktree:`, wtErr.message || wtErr);
        // Agent still works, just without isolation (falls back to working_directory)
      }

      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
      if (agent) {
        broadcast({ type: 'agent:updated', agent });
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
        const now = new Date().toISOString();
        runQuery(`UPDATE agents SET status = 'running', last_activity = ? WHERE id = ?`, [now, agentId]);
        clearAgentOutput(agentId);

        const handleOutput = (id: string, chunk: string) => {
          appendAgentOutput(id, chunk);
          broadcast({ type: 'agent:output', agentId: id, chunk });
        };

        const handleExit = (id: string, code: number) => {
          const exitStatus = code === 0 ? 'idle' : 'dead';
          const finishedAt = new Date().toISOString();

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
        const now = new Date().toISOString();

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
            const finishedAt = new Date().toISOString();
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
              const retryNow = new Date().toISOString();
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
                  const reviewNow = new Date().toISOString();
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
      const { agentId, fields } = message;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (fields.name !== undefined) {
        updates.push('name = ?');
        values.push(fields.name);
      }
      if (fields.instructions !== undefined) {
        updates.push('instructions = ?');
        values.push(fields.instructions);
      }
      if (fields.skills !== undefined) {
        updates.push('skills = ?');
        values.push(fields.skills);
      }
      if (fields.profile_id !== undefined) {
        updates.push('profile_id = ?');
        values.push(fields.profile_id);
      }
      if (fields.workflow_id !== undefined) {
        updates.push('workflow_id = ?');
        values.push(fields.workflow_id);
      }

      if (updates.length > 0) {
        updates.push('last_activity = ?');
        values.push(new Date().toISOString());
        values.push(agentId);
        runQuery(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, values);
        const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
        if (agent) {
          broadcast({ type: 'agent:updated', agent });
        }
      }
      break;
    }

    case 'agent:schedule': {
      const { agentId, schedule, enabled, prompt } = message;
      runQuery(
        `UPDATE agents SET schedule = ?, schedule_enabled = ?, schedule_prompt = ?, last_activity = ? WHERE id = ?`,
        [schedule, enabled ? 1 : 0, prompt, new Date().toISOString(), agentId]
      );
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        broadcast({ type: 'agent:updated', agent });
      }
      break;
    }

    case 'agent:history': {
      const { agentId, limit = 50 } = message;
      const commands = getAll<Command>(
        'SELECT * FROM commands WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?',
        [agentId, limit]
      );
      send(ws, { type: 'agent:history', agentId, commands: parseCommands(commands) });
      break;
    }

    case 'agent:activity': {
      const { agentId, limit = 50 } = message;
      const entries = getAll<GoalLogEntry>(
        'SELECT * FROM goal_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
        [agentId, limit]
      );
      send(ws, { type: 'agent:activity', agentId, entries });
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
      const id = generateId();
      const now = new Date().toISOString();
      runQuery(
        `INSERT INTO goals (id, name, description, status, priority, repo_id, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?, ?)`,
        [id, message.name, message.description || '', message.repoId || null, now, now]
      );
      const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [id]);
      if (goal) {
        broadcast({ type: 'goal:updated', goal });
      }
      break;
    }

    case 'goal:propose': {
      const id = generateId();
      const now = new Date().toISOString();
      runQuery(
        `INSERT INTO goals (id, name, description, status, priority, repo_id, proposed_by, proposal_status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?, 'pending', ?, ?)`,
        [id, message.name, message.description || '', message.repoId || null, message.agentId, now, now]
      );
      const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [id]);
      if (goal) {
        broadcast({ type: 'goal:proposed', goal, agentId: message.agentId });
        broadcast({ type: 'goal:updated', goal });
      }
      break;
    }

    case 'goal:update': {
      const { goalId, fields } = message;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (fields.name !== undefined) {
        updates.push('name = ?');
        values.push(fields.name);
      }
      if (fields.description !== undefined) {
        updates.push('description = ?');
        values.push(fields.description);
      }
      if (fields.status !== undefined) {
        updates.push('status = ?');
        values.push(fields.status);
      }
      if (fields.priority !== undefined) {
        updates.push('priority = ?');
        values.push(fields.priority);
      }
      if (fields.repo_id !== undefined) {
        updates.push('repo_id = ?');
        values.push(fields.repo_id);
      }
      if ((fields as any).proposal_status !== undefined) {
        updates.push('proposal_status = ?');
        values.push((fields as any).proposal_status);
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(goalId);
        runQuery(`UPDATE goals SET ${updates.join(', ')} WHERE id = ?`, values);
        const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [goalId]);
        if (goal) {
          broadcast({ type: 'goal:updated', goal });
        }
      }
      break;
    }

    case 'goal:delete': {
      runQuery('DELETE FROM goal_log WHERE goal_id = ?', [message.goalId]);
      runQuery('DELETE FROM goals WHERE id = ?', [message.goalId]);
      broadcast({ type: 'goal:deleted', goalId: message.goalId });
      break;
    }

    case 'goal:list': {
      const goals = getAll<Goal>('SELECT * FROM goals ORDER BY priority DESC, created_at');
      send(ws, { type: 'goal:list', goals });
      break;
    }

    case 'goal:log': {
      const { goalId, limit = 50 } = message;
      const entries = getAll<GoalLogEntry>(
        'SELECT * FROM goal_log WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?',
        [goalId, limit]
      );
      send(ws, { type: 'goal:log', goalId, entries });
      break;
    }

    case 'agent:autopilot': {
      const { agentId, autopilot, interval, goalId } = message;
      runQuery(
        'UPDATE agents SET autopilot = ?, autopilot_interval = ?, autopilot_goal_id = ?, last_activity = ? WHERE id = ?',
        [autopilot ? 1 : 0, interval, goalId, new Date().toISOString(), agentId]
      );
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
      const id = generateId();
      const now = new Date().toISOString();
      runQuery(
        `INSERT INTO workflows (id, name, description, steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, message.name, message.description || '', JSON.stringify(message.steps), now, now]
      );
      const row = getOne<any>('SELECT * FROM workflows WHERE id = ?', [id]);
      if (row) {
        const workflow: Workflow = { ...row, steps: JSON.parse(row.steps) };
        broadcast({ type: 'workflow:updated', workflow });
      }
      break;
    }

    case 'workflow:update': {
      const { workflowId, fields } = message;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (fields.name !== undefined) {
        updates.push('name = ?');
        values.push(fields.name);
      }
      if (fields.description !== undefined) {
        updates.push('description = ?');
        values.push(fields.description);
      }
      if (fields.steps !== undefined) {
        updates.push('steps = ?');
        values.push(JSON.stringify(fields.steps));
      }

      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(new Date().toISOString());
        values.push(workflowId);
        runQuery(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ?`, values);
        const row = getOne<any>('SELECT * FROM workflows WHERE id = ?', [workflowId]);
        if (row) {
          const workflow: Workflow = { ...row, steps: JSON.parse(row.steps) };
          broadcast({ type: 'workflow:updated', workflow });
        }
      }
      break;
    }

    case 'workflow:delete': {
      runQuery('DELETE FROM workflows WHERE id = ?', [message.workflowId]);
      broadcast({ type: 'workflow:deleted', workflowId: message.workflowId });
      break;
    }

    case 'workflow:list': {
      const rows = getAll<any>('SELECT * FROM workflows ORDER BY created_at');
      const workflows: Workflow[] = rows.map((r) => ({ ...r, steps: JSON.parse(r.steps) }));
      send(ws, { type: 'workflow:list', workflows });
      break;
    }

    case 'agent:self-improve': {
      const { agentId, enabled } = message;
      runQuery('UPDATE agents SET self_improve = ?, last_activity = ? WHERE id = ?', [enabled ? 1 : 0, new Date().toISOString(), agentId]);
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
      const folders = getAll<Folder>('SELECT * FROM folders ORDER BY sort_order');
      const tasks = getAll<Task>('SELECT * FROM tasks ORDER BY sort_order');
      const agents = getAll<Agent>('SELECT * FROM agents ORDER BY created_at');
      const goals = getAll<Goal>('SELECT * FROM goals ORDER BY priority DESC, created_at');
      const workflowRows = getAll<any>('SELECT * FROM workflows ORDER BY created_at');
      const workflows: Workflow[] = workflowRows.map((r) => ({ ...r, steps: JSON.parse(r.steps) }));
      const recentCommands = getAll<Command>(
        'SELECT * FROM commands ORDER BY started_at DESC LIMIT 100'
      );
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

export function handleWsMessage(ws: WebSocket, data: string): void {
  try {
    const message = JSON.parse(data) as WSClientMessage;
    handleMessage(ws, message);
  } catch (error) {
    console.error('Failed to parse WebSocket message:', error);
  }
}
