export interface Folder {
  id: string;
  name: string;
  icon: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  folder_id: string;
  parent_task_id: string | null;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'archived';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  task_id: string | null;
  name: string;
  working_directory: string;
  status: 'idle' | 'running' | 'error' | 'dead';
  pid: number | null;
  created_at: string;
  last_activity: string;
}

export interface Command {
  id: string;
  agent_id: string;
  task_id: string | null;
  prompt: string;
  raw_output: string;
  summary: string;
  status: 'running' | 'done' | 'error';
  started_at: string;
  completed_at: string | null;
  files_changed: string[];
}

export type AgentStatus = Agent['status'];

// WebSocket message types
export type WSClientMessage =
  | { type: 'task:create'; folderId: string; title: string; description?: string; parentTaskId?: string }
  | { type: 'task:update'; taskId: string; fields: Partial<Task> }
  | { type: 'task:delete'; taskId: string }
  | { type: 'task:reorder'; taskId: string; sortOrder: number }
  | { type: 'folder:create'; name: string; icon?: string }
  | { type: 'folder:update'; folderId: string; fields: Partial<Folder> }
  | { type: 'folder:delete'; folderId: string }
  | { type: 'agent:create'; workingDirectory: string; name?: string }
  | { type: 'agent:kill'; agentId: string }
  | { type: 'agent:restart'; agentId: string }
  | { type: 'agent:send'; agentId: string; prompt: string; taskId?: string }
  | { type: 'agent:interrupt'; agentId: string }
  | { type: 'sync:request' }
  | { type: 'agent:history'; agentId: string; limit?: number };

export type WSServerMessage =
  | { type: 'sync:state'; folders: Folder[]; tasks: Task[]; agents: Agent[] }
  | { type: 'agent:output'; agentId: string; chunk: string }
  | { type: 'agent:status'; agentId: string; status: AgentStatus }
  | { type: 'agent:summary'; agentId: string; commandId: string; summary: string; filesChanged: string[] }
  | { type: 'task:updated'; task: Task }
  | { type: 'folder:updated'; folder: Folder }
  | { type: 'notify'; agentId: string; title: string; body: string };
