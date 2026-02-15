import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import { runQuery, getOne, getAll } from './db.js';
import type { Folder, Task, Agent, Command, WSClientMessage, WSServerMessage } from '../client/lib/types.js';
import { createAgent, sendToAgent, interruptAgent, killAgent, restartAgent, hasAgent } from './pty-manager.js';

interface ConnectedClient {
  ws: WebSocket;
}

const clients: ConnectedClient[] = [];

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

      runQuery(
        `INSERT INTO agents (id, name, working_directory, status, created_at, last_activity)
         VALUES (?, ?, ?, 'idle', ?, ?)`,
        [id, name, message.workingDirectory, now, now]
      );

      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
      if (agent) {
        broadcast({ type: 'agent:status', agentId: id, status: 'idle' });
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

        const handleOutput = (id: string, chunk: string) => {
          broadcast({ type: 'agent:output', agentId: id, chunk });
        };

        const handleExit = (id: string, code: number) => {
          const exitStatus = code === 0 ? 'idle' : 'dead';
          runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, new Date().toISOString(), id]);
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

        const existingPty = hasAgent(agentId);
        if (!existingPty) {
          const handleOutput = (id: string, chunk: string) => {
            broadcast({ type: 'agent:output', agentId: id, chunk });
          };

          const handleExit = (id: string, code: number) => {
            const exitStatus = code === 0 ? 'idle' : 'dead';
            runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, new Date().toISOString(), id]);
            broadcast({ type: 'agent:status', agentId: id, status: exitStatus });
          };

          createAgent(agentId, agent.working_directory, agent.name, handleOutput, handleExit);
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

    case 'agent:history': {
      const { agentId, limit = 50 } = message;
      const commands = getAll<Command>(
        'SELECT * FROM commands WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?',
        [agentId, limit]
      );
      console.log('agent:history - stubbed', agentId, commands.length);
      break;
    }

    case 'sync:request': {
      const folders = getAll<Folder>('SELECT * FROM folders ORDER BY sort_order');
      const tasks = getAll<Task>('SELECT * FROM tasks ORDER BY sort_order');
      const agents = getAll<Agent>('SELECT * FROM agents ORDER BY created_at');
      send(ws, { type: 'sync:state', folders, tasks, agents });
      break;
    }
  }
}

export function handleWsMessage(ws: WebSocket, data: string): void {
  try {
    const message = JSON.parse(data) as WSClientMessage;
    handleMessage(ws, message);
  } catch (error) {
    console.error('Failed to parse WebSocket message:', error);
  }
}
