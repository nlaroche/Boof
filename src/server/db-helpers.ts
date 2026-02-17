/**
 * Database helper utilities for common CRUD operations.
 * Extracts reusable patterns from ws-handler.ts to reduce duplication.
 */
import { runQuery, getOne, getAll } from './db.js';
import type { Folder, Task, Agent, Goal, Workflow, Command, GoalLogEntry, GoalStats } from '../client/lib/types.js';

export { runQuery, getOne, getAll };

// ============================================================================
// ID Generation
// ============================================================================

/** Generate a unique ID (16 hex chars) */
export function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function getNow(): string {
  return new Date().toISOString();
}

/** Simple token estimator (4 chars ≈ 1 token for English text) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Generic CRUD Helpers
// ============================================================================

/**
 * Common pattern: insert → get → broadcast
 * Returns the created record or null on failure.
 */
export function createAndFetch<T>(
  table: string,
  id: string,
  sql: string,
  params: unknown[],
  broadcast: (item: T) => void
): T | null {
  runQuery(sql, params);
  const item = getOne<T>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (item) {
    broadcast(item);
  }
  return item;
}

/**
 * Common pattern: update → get → broadcast
 * Returns the updated record or null if not found.
 */
export function updateAndFetch<T>(
  table: string,
  id: string,
  updates: string[],
  values: unknown[],
  broadcast: (item: T) => void
): T | null {
  if (updates.length === 0) return null;

  updates.push('updated_at = ?');
  values.push(getNow());
  values.push(id);

  runQuery(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`, values);
  const item = getOne<T>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (item) {
    broadcast(item);
  }
  return item;
}

/**
 * Common pattern: delete → broadcast
 */
export function deleteAndBroadcast(
  table: string,
  id: string,
  broadcast: (id: string) => void
): void {
  runQuery(`DELETE FROM ${table} WHERE id = ?`, [id]);
  broadcast(id);
}

// ============================================================================
// Task Helpers
// ============================================================================

export interface TaskCreateInput {
  folderId: string;
  title: string;
  description?: string;
  parentTaskId?: string;
  goalId?: string;
}

export function createTask(input: TaskCreateInput, broadcast: (task: Task) => void): Task | null {
  const id = generateId();
  const now = getNow();
  return createAndFetch<Task>(
    'tasks', id,
    `INSERT INTO tasks (id, folder_id, parent_task_id, title, description, status, goal_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
    [id, input.folderId, input.parentTaskId || null, input.title, input.description || '', input.goalId || null, now, now],
    broadcast
  );
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: string;
  sort_order?: number;
  folder_id?: string;
  goal_id?: string | null;
}

export function updateTask(taskId: string, fields: TaskUpdateInput, broadcast: (task: Task) => void): Task | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.title !== undefined) { updates.push('title = ?'); values.push(fields.title); }
  if (fields.description !== undefined) { updates.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status); }
  if (fields.sort_order !== undefined) { updates.push('sort_order = ?'); values.push(fields.sort_order); }
  if (fields.folder_id !== undefined) { updates.push('folder_id = ?'); values.push(fields.folder_id); }
  if (fields.goal_id !== undefined) { updates.push('goal_id = ?'); values.push(fields.goal_id); }

  return updateAndFetch<Task>('tasks', taskId, updates, values, broadcast);
}

export function deleteTask(taskId: string, broadcast: (id: string) => void): void {
  deleteAndBroadcast('tasks', taskId, broadcast);
}

export function reorderTask(taskId: string, sortOrder: number, broadcast: (task: Task) => void): void {
  runQuery('UPDATE tasks SET sort_order = ? WHERE id = ?', [sortOrder, taskId]);
  const task = getOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (task) broadcast(task);
}

// ============================================================================
// Folder Helpers
// ============================================================================

export interface FolderCreateInput {
  name: string;
  icon?: string;
}

export function createFolder(input: FolderCreateInput, broadcast: (folder: Folder) => void): Folder | null {
  const id = generateId();
  const now = getNow();
  return createAndFetch<Folder>(
    'folders', id,
    `INSERT INTO folders (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, input.name, input.icon || '📁', now, now],
    broadcast
  );
}

export interface FolderUpdateInput {
  name?: string;
  icon?: string;
  sort_order?: number;
}

export function updateFolder(folderId: string, fields: FolderUpdateInput, broadcast: (folder: Folder) => void): Folder | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
  if (fields.icon !== undefined) { updates.push('icon = ?'); values.push(fields.icon); }
  if (fields.sort_order !== undefined) { updates.push('sort_order = ?'); values.push(fields.sort_order); }

  return updateAndFetch<Folder>('folders', folderId, updates, values, broadcast);
}

export function deleteFolder(folderId: string, broadcast: (id: string) => void): void {
  // Also delete tasks in the folder
  runQuery('DELETE FROM tasks WHERE folder_id = ?', [folderId]);
  deleteAndBroadcast('folders', folderId, broadcast);
}

// ============================================================================
// Agent Helpers
// ============================================================================

export interface AgentCreateInput {
  workingDirectory: string;
  name?: string;
  profileId?: string;
  agentType?: string;
}

export function createAgent(input: AgentCreateInput, broadcast: (agent: Agent) => void): Agent | null {
  const id = generateId();
  const now = getNow();
  const name = input.name || 'Agent';
  const profileId = input.profileId || 'robot';
  const agentType = input.agentType || 'minimax';

  return createAndFetch<Agent>(
    'agents', id,
    `INSERT INTO agents (id, name, working_directory, profile_id, agent_type, status, created_at, last_activity)
     VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)`,
    [id, name, input.workingDirectory, profileId, agentType, now, now],
    broadcast
  );
}

export interface AgentUpdateInput {
  name?: string;
  instructions?: string;
  skills?: string;
  profile_id?: string;
  workflow_id?: string | null;
}

export function updateAgent(agentId: string, fields: AgentUpdateInput, broadcast: (agent: Agent) => void): Agent | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
  if (fields.instructions !== undefined) { updates.push('instructions = ?'); values.push(fields.instructions); }
  if (fields.skills !== undefined) { updates.push('skills = ?'); values.push(fields.skills); }
  if (fields.profile_id !== undefined) { updates.push('profile_id = ?'); values.push(fields.profile_id); }
  if (fields.workflow_id !== undefined) { updates.push('workflow_id = ?'); values.push(fields.workflow_id); }

  if (updates.length === 0) return null;

  // Agents use last_activity instead of updated_at
  updates.push('last_activity = ?');
  values.push(getNow());
  values.push(agentId);

  runQuery(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, values);
  const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (agent) {
    broadcast(agent);
  }
  return agent;
}

export function updateAgentStatus(agentId: string, status: string, broadcast: (agent: Agent) => void): void {
  const now = getNow();
  runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [status, now, agentId]);
  const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (agent) broadcast(agent);
}

export function deleteAgent(agentId: string, broadcast: (id: string) => void): void {
  runQuery('DELETE FROM commands WHERE agent_id = ?', [agentId]);
  deleteAndBroadcast('agents', agentId, broadcast);
}

// ============================================================================
// Goal Helpers
// ============================================================================

export interface GoalCreateInput {
  name: string;
  description?: string;
  repoId?: string;
  proposedBy?: string;
  proposalStatus?: string;
}

export function createGoal(input: GoalCreateInput, broadcast: (goal: Goal) => void): Goal | null {
  const id = generateId();
  const now = getNow();

  const sql = input.proposedBy
    ? `INSERT INTO goals (id, name, description, status, priority, repo_id, proposed_by, proposal_status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`
    : `INSERT INTO goals (id, name, description, status, priority, repo_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?)`;

  const params = input.proposedBy
    ? [id, input.name, input.description || '', input.repoId || null, input.proposedBy, input.proposalStatus || 'pending', now, now]
    : [id, input.name, input.description || '', input.repoId || null, now, now];

  runQuery(sql, params);
  const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [id]);
  if (goal) broadcast(goal);
  return goal;
}

export interface GoalUpdateInput {
  name?: string;
  description?: string;
  status?: string;
  priority?: number;
  repo_id?: string | null;
  proposal_status?: string | null;
}

export function updateGoal(goalId: string, fields: GoalUpdateInput, broadcast: (goal: Goal) => void): Goal | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { updates.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status); }
  if (fields.priority !== undefined) { updates.push('priority = ?'); values.push(fields.priority); }
  if (fields.repo_id !== undefined) { updates.push('repo_id = ?'); values.push(fields.repo_id); }
  if (fields.proposal_status !== undefined) { updates.push('proposal_status = ?'); values.push(fields.proposal_status); }

  return updateAndFetch<Goal>('goals', goalId, updates, values, broadcast);
}

export function deleteGoal(goalId: string, broadcast: (id: string) => void): void {
  runQuery('DELETE FROM goal_log WHERE goal_id = ?', [goalId]);
  deleteAndBroadcast('goals', goalId, broadcast);
}

/** Get goal stats (completion tracking) for a specific goal. */
export function getGoalStats(goalId: string): GoalStats | null {
  return getOne<GoalStats>('SELECT * FROM goal_stats WHERE goal_id = ?', [goalId]);
}

/**
 * Get the next highest-priority active goal.
 * Ordered by priority DESC then created_at ASC.
 * Optionally excludes a specific goal (e.g. the just-completed one).
 */
export function getNextActiveGoal(excludeGoalId?: string): Goal | null {
  if (excludeGoalId) {
    return getOne<Goal>(
      "SELECT * FROM goals WHERE status = 'active' AND id != ? ORDER BY priority DESC, created_at ASC LIMIT 1",
      [excludeGoalId]
    );
  }
  return getOne<Goal>(
    "SELECT * FROM goals WHERE status = 'active' ORDER BY priority DESC, created_at ASC LIMIT 1",
    []
  );
}

// ============================================================================
// Workflow Helpers
// ============================================================================

export interface WorkflowCreateInput {
  name: string;
  description?: string;
  steps: unknown[];
}

export function createWorkflow(input: WorkflowCreateInput, broadcast: (workflow: Workflow) => void): Workflow | null {
  const id = generateId();
  const now = getNow();

  runQuery(
    `INSERT INTO workflows (id, name, description, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.description || '', JSON.stringify(input.steps), now, now]
  );

  const row = getOne<any>('SELECT * FROM workflows WHERE id = ?', [id]);
  if (row) {
    const workflow: Workflow = { ...row, steps: JSON.parse(row.steps) };
    broadcast(workflow);
    return workflow;
  }
  return null;
}

export interface WorkflowUpdateInput {
  name?: string;
  description?: string;
  steps?: unknown[];
}

export function updateWorkflow(workflowId: string, fields: WorkflowUpdateInput, broadcast: (workflow: Workflow) => void): Workflow | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { updates.push('description = ?'); values.push(fields.description); }
  if (fields.steps !== undefined) { updates.push('steps = ?'); values.push(JSON.stringify(fields.steps)); }

  if (updates.length === 0) return null;

  updates.push('updated_at = ?');
  values.push(getNow());
  values.push(workflowId);

  runQuery(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ?`, values);
  const row = getOne<any>('SELECT * FROM workflows WHERE id = ?', [workflowId]);
  if (row) {
    const workflow: Workflow = { ...row, steps: JSON.parse(row.steps) };
    broadcast(workflow);
    return workflow;
  }
  return null;
}

export function deleteWorkflow(workflowId: string, broadcast: (id: string) => void): void {
  deleteAndBroadcast('workflows', workflowId, broadcast);
}

// ============================================================================
// Command Helpers
// ============================================================================

export interface CommandCreateInput {
  agentId: string;
  prompt: string;
  taskId?: string;
}

export function createCommand(input: CommandCreateInput): string {
  const id = generateId();
  const now = getNow();
  runQuery(
    `INSERT INTO commands (id, agent_id, task_id, prompt, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
    [id, input.agentId, input.taskId || null, input.prompt, now]
  );
  return id;
}

export function updateCommand(
  commandId: string,
  fields: { status?: string; completed_at?: string; raw_output?: string; summary?: string; files_changed?: string }
): Command | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status); }
  if (fields.completed_at !== undefined) { updates.push('completed_at = ?'); values.push(fields.completed_at); }
  if (fields.raw_output !== undefined) { updates.push('raw_output = ?'); values.push(fields.raw_output); }
  if (fields.summary !== undefined) { updates.push('summary = ?'); values.push(fields.summary); }
  if (fields.files_changed !== undefined) { updates.push('files_changed = ?'); values.push(fields.files_changed); }

  if (updates.length === 0) return null;

  values.push(commandId);
  runQuery(`UPDATE commands SET ${updates.join(', ')} WHERE id = ?`, values);
  return getOne<Command>('SELECT * FROM commands WHERE id = ?', [commandId]);
}

// ============================================================================
// List Helpers
// ============================================================================

export function listTasks(): Task[] {
  return getAll<Task>('SELECT * FROM tasks ORDER BY sort_order');
}

export function listFolders(): Folder[] {
  return getAll<Folder>('SELECT * FROM folders ORDER BY sort_order');
}

export function listAgents(): Agent[] {
  return getAll<Agent>('SELECT * FROM agents ORDER BY created_at');
}

export function listGoals(): Goal[] {
  return getAll<Goal>('SELECT * FROM goals ORDER BY priority DESC, created_at');
}

export function listWorkflows(): Workflow[] {
  const rows = getAll<any>('SELECT * FROM workflows ORDER BY created_at');
  return rows.map(r => ({ ...r, steps: JSON.parse(r.steps) }));
}

export function listCommands(limit = 100): Command[] {
  return getAll<Command>('SELECT * FROM commands ORDER BY started_at DESC LIMIT ?', [limit]);
}

export function listGoalLog(goalId: string, limit = 50): GoalLogEntry[] {
  return getAll<GoalLogEntry>(
    'SELECT * FROM goal_log WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?',
    [goalId, limit]
  );
}

export function listAgentCommands(agentId: string, limit = 50): Command[] {
  return getAll<Command>(
    'SELECT * FROM commands WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?',
    [agentId, limit]
  );
}

export function listAgentActivity(agentId: string, limit = 50): GoalLogEntry[] {
  return getAll<GoalLogEntry>(
    'SELECT * FROM goal_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
    [agentId, limit]
  );
}

// ============================================================================
// Summarizer Context Helpers
// ============================================================================

export interface SummarizerContext {
  recentCompletions: Array<{ id: string; name: string; completed_at: string | null; priority: number }>;
  cyclingHistory: Array<{ action: string; summary: string | null; created_at: string }>;
}

/**
 * Returns context for the summarizer: recent goal completions and cycling history
 * from goal_log so the agent can learn from past runs.
 */
export function getSummarizerContext(limit = 5): SummarizerContext {
  const recentCompletions = getAll<{ id: string; name: string; completed_at: string | null; priority: number }>(
    `SELECT id, name, completed_at, priority FROM goals WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?`,
    [limit]
  );

  const cyclingHistory = getAll<{ action: string; summary: string | null; created_at: string }>(
    `SELECT action, summary, created_at FROM goal_log
     WHERE action IN ('goal_completed', 'goal_switched', 'goal_proposed')
     ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );

  return { recentCompletions, cyclingHistory };
}
