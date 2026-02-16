import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { runQuery, getOne, getAll } from './db.js';
import type { Folder, Task, Agent, Command, Goal, GoalLogEntry, Workflow, WSClientMessage, WSServerMessage, RepoInfo } from '../client/lib/types.js';
import { createAgent, sendToAgent, interruptAgent, killAgent, restartAgent, hasAgent } from './pty-manager.js';
import { execSync } from 'child_process';
import { triggerAutopilotRun } from './autopilot.js';

const REPOS_DIR = process.env.REPOS_DIR || 'D:\\Repos';

/** Commit any uncommitted changes in the agent's working directory */
function commitAgentChanges(workingDirectory: string, prompt: string): boolean {
  try {
    const diff = execSync('git diff --stat', { cwd: workingDirectory, encoding: 'utf-8', timeout: 5000 }).trim();
    const staged = execSync('git diff --cached --stat', { cwd: workingDirectory, encoding: 'utf-8', timeout: 5000 }).trim();
    if (!diff && !staged) return false; // nothing to commit

    execSync('git add -A', { cwd: workingDirectory, timeout: 5000 });
    const msg = prompt.slice(0, 72).replace(/"/g, "'");
    execSync(`git commit -m "aider: ${msg}"`, { cwd: workingDirectory, timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
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

/** Strip all ANSI escape codes from text */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Extract edited files from Aider output */
function extractEditedFiles(rawOutput: string): string[] {
  const clean = stripAnsi(rawOutput);
  const files: string[] = [];
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Applied edit to ')) {
      files.push(trimmed.replace('Applied edit to ', '').trim());
    }
  }
  return [...new Set(files)];
}

/** Generate a summary from Aider output */
function generateSummary(rawOutput: string, prompt: string): string {
  const clean = stripAnsi(rawOutput);
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tail = lines.slice(-40);

  // Extract structured info from Aider output
  const commitLines: string[] = [];
  const editedFiles: string[] = [];
  const descriptionLines: string[] = [];

  for (const line of tail) {
    if (line.startsWith('Commit ') || line.match(/^[a-f0-9]{7,} /)) {
      commitLines.push(line);
      continue;
    }
    if (line.startsWith('Applied edit to ')) {
      editedFiles.push(line.replace('Applied edit to ', '').trim());
      continue;
    }
    // Skip noise
    if (/^(Tokens|Cost|Model|Git repo|Repo-map|Use \/help)/i.test(line)) continue;
    if (/tokens? [\d,]+/i.test(line)) continue;
    if (/^[─━═\-]{3,}$/.test(line)) continue;
    if (line.startsWith('>')) continue;
    // Collect meaningful lines
    if (line.length > 10) {
      descriptionLines.push(line);
    }
  }

  const parts: string[] = [];

  // Description of what it did
  if (descriptionLines.length > 0) {
    parts.push(descriptionLines.slice(-3).join(' ').slice(0, 300));
  }

  // Files changed
  if (editedFiles.length > 0) {
    parts.push(`Changed: ${editedFiles.map(f => path.basename(f)).join(', ')}`);
  }

  // Commit info
  if (commitLines.length > 0) {
    parts.push(commitLines[commitLines.length - 1]);
  }

  if (parts.length > 0) return parts.join('\n').slice(0, 400);

  // Last resort
  const fallback = tail.slice(-5).join(' ').slice(0, 200);
  return fallback || `Ran: ${prompt.slice(0, 100)}`;
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

function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function handleMessage(ws: WebSocket, message: WSClientMessage): void {
  switch (message.type) {
    case 'task:create': {
      const id = generateId();
      const now = new Date().toISOString();
      runQuery(
        `INSERT INTO tasks (id, folder_id, parent_task_id, title, description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`,
        [id, message.folderId, message.parentTaskId || null, message.title, message.description || '', now, now]
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
      runQuery('DELETE FROM folders WHERE id = ?', [message.folderId]);
      break;
    }

    case 'agent:create': {
      const id = generateId();
      const now = new Date().toISOString();
      const name = message.name || 'Agent';
      const profileId = message.profileId || 'robot';
      const agentType = 'aider';

      runQuery(
        `INSERT INTO agents (id, name, working_directory, profile_id, agent_type, status, created_at, last_activity)
         VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
        [id, name, message.workingDirectory, profileId, agentType, now, now]
      );

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

        restartAgent(agentId, agent.working_directory, agent.name, handleOutput, handleExit);
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

            // No-op detection: if Aider exited 0 but made no changes, it failed to do the task
            if (succeeded && agent) {
              try {
                const noopDiff = execSync('git diff --stat', { cwd: agent.working_directory, encoding: 'utf-8', timeout: 5000 }).trim();
                if (!noopDiff) {
                  succeeded = false;
                  const noopMsg = '\n--- No changes made — agent did not edit any files ---\n';
                  appendAgentOutput(id, noopMsg);
                  broadcast({ type: 'agent:output', agentId: id, chunk: noopMsg });
                }
              } catch {}
            }

            // Self-review pass: re-use the SAME command, just send another Aider call
            const reviewState = reviewPending.get(id);
            if (succeeded && agent && !reviewState) {
              try {
                const diff = execSync('git diff --stat', { cwd: agent.working_directory, encoding: 'utf-8', timeout: 5000 }).trim();
                const diffContent = execSync('git diff', { cwd: agent.working_directory, encoding: 'utf-8', timeout: 10000 }).trim();
                if (diff && diffContent && diffContent.length < 8000) {
                  reviewPending.set(id, true);
                  const reviewMsg = '\n=== Self-review: checking changes for bugs ===\n';
                  appendAgentOutput(id, reviewMsg);
                  broadcast({ type: 'agent:output', agentId: id, chunk: reviewMsg });

                  // Re-use the same command ID — no new command row
                  const reviewPrompt = `Review the changes you just made for the task: "${prompt}"\n\nHere is the diff:\n\n${diffContent}\n\nCheck for:\n1. Logic bugs (wrong conditions, off-by-one, stale closures in React hooks)\n2. Missing imports or exports\n3. Does this actually accomplish what was asked? Did you edit the RIGHT file?\n4. Did you accidentally create a NEW file instead of editing an existing one?\n\nIf you find issues, fix them. If the changes look correct, do not edit any files.`;
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
              const committed = commitAgentChanges(agent.working_directory, prompt);
              if (committed) {
                const commitMsg = '\n--- Changes committed ---\n';
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
                    { cwd: agent.working_directory, encoding: 'utf-8', timeout: 30000, env }
                  );
                  appendAgentOutput(id, `\n${verifyOutput}\n`);
                  broadcast({ type: 'agent:output', agentId: id, chunk: `\n${verifyOutput}\n` });
                } catch {
                  // UI verification is best-effort, don't fail the task
                }
              }
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

          createAgent(agentId, agent.working_directory, agent.name, handleOutput, handleExit);
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
            cwd: agent.working_directory,
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
        `INSERT INTO goals (id, name, description, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?)`,
        [id, message.name, message.description || '', now, now]
      );
      const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [id]);
      if (goal) {
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
