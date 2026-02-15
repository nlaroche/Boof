import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { runQuery, getOne, getAll } from './db.js';
import type { Folder, Task, Agent, Command, WSClientMessage, WSServerMessage, RepoInfo } from '../client/lib/types.js';
import { createAgent, sendToAgent, interruptAgent, killAgent, restartAgent, hasAgent } from './pty-manager.js';

const REPOS_DIR = process.env.REPOS_DIR || 'D:\\Repos';
const MAX_OUTPUT_BUFFER = 200; // lines per agent

interface ConnectedClient {
  ws: WebSocket;
}

const clients: ConnectedClient[] = [];

// Server-side output buffer so reconnecting clients can see recent output
const agentOutputBuffers: Map<string, string[]> = new Map();

// Track current running command per agent (agentId → commandId)
const currentCommandIds: Map<string, string> = new Map();

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
      const agentType = message.agentType || 'claude';

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
            const rawOutput = buf ? buf.join('\n') : '';
            const cmdStatus = code === 0 ? 'done' : 'error';
            runQuery(
              `UPDATE commands SET status = ?, completed_at = ?, raw_output = ? WHERE id = ?`,
              [cmdStatus, finishedAt, rawOutput, cmdId]
            );
            currentCommandIds.delete(id);
          }

          runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, finishedAt, id]);
          broadcast({ type: 'agent:status', agentId: id, status: exitStatus });
        };

        restartAgent(agentId, agent.working_directory, agent.name, handleOutput, handleExit, agent.agent_type || 'claude');
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
            const exitStatus = code === 0 ? 'idle' : 'dead';
            const finishedAt = new Date().toISOString();

            const cmdId = currentCommandIds.get(id);
            if (cmdId) {
              const buf = agentOutputBuffers.get(id);
              const rawOutput = buf ? buf.join('\n') : '';
              const cmdStatus = code === 0 ? 'done' : 'error';
              runQuery(
                `UPDATE commands SET status = ?, completed_at = ?, raw_output = ? WHERE id = ?`,
                [cmdStatus, finishedAt, rawOutput, cmdId]
              );
              currentCommandIds.delete(id);
            }

            runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, finishedAt, id]);
            broadcast({ type: 'agent:status', agentId: id, status: exitStatus });
            const agentName = agent?.name || 'Agent';
            broadcast({
              type: 'notify',
              agentId: id,
              title: code === 0 ? `${agentName} finished` : `${agentName} failed`,
              body: code === 0 ? 'Task completed successfully' : `Exited with code ${code}`,
            });
          };

          createAgent(agentId, agent.working_directory, agent.name, handleOutput, handleExit, agent.agent_type || 'claude');
        }

        runQuery(`UPDATE agents SET status = 'running', last_activity = ? WHERE id = ?`, [now, agentId]);
        sendToAgent(agentId, prompt);
        broadcast({ type: 'agent:status', agentId, status: 'running' });
      }
      break;
    }

    case 'agent:interrupt': {
      const { agentId } = message;
      interruptAgent(agentId);
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
      if (fields.agent_type !== undefined) {
        updates.push('agent_type = ?');
        values.push(fields.agent_type);
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
      send(ws, { type: 'agent:history', agentId, commands });
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

    case 'sync:request': {
      const folders = getAll<Folder>('SELECT * FROM folders ORDER BY sort_order');
      const tasks = getAll<Task>('SELECT * FROM tasks ORDER BY sort_order');
      const agents = getAll<Agent>('SELECT * FROM agents ORDER BY created_at');
      send(ws, { type: 'sync:state', folders, tasks, agents });

      // Replay buffered output for all agents
      for (const agent of agents) {
        const buf = agentOutputBuffers.get(agent.id);
        if (buf && buf.length > 0) {
          send(ws, { type: 'agent:output', agentId: agent.id, chunk: buf.join('\n') });
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
