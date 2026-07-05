/**
 * Database helper utilities for common CRUD operations.
 * Extracts reusable patterns from ws-handler.ts to reduce duplication.
 */
import { runQuery, getOne, getAll } from './db.js';
import type { Folder, Task, Agent, Goal, Workflow, Command, GoalLogEntry, GoalStats, Project, MergeGate, AuditRecord, ReviewFinding, ReviewConfig, ReviewGuideline, AgentPattern, AgentFix, ExperimentRecord, ExperimentRun, TaskResearch } from '../client/lib/types.js';

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
  const agentType = input.agentType || 'qwen3-coder';

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
  projectId?: string;
  proposedBy?: string;
  proposalStatus?: string;
  mergeTarget?: string;
  autoMerge?: number;
}

export function createGoal(input: GoalCreateInput, broadcast: (goal: Goal) => void): Goal | null {
  const id = generateId();
  const now = getNow();

  const sql = input.proposedBy
    ? `INSERT INTO goals (id, name, description, status, priority, repo_id, project_id, proposed_by, proposal_status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO goals (id, name, description, status, priority, repo_id, project_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?, ?)`;

  const params = input.proposedBy
    ? [id, input.name, input.description || '', input.repoId || null, input.projectId || null, input.proposedBy, input.proposalStatus || 'pending', now, now]
    : [id, input.name, input.description || '', input.repoId || null, input.projectId || null, now, now];

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
  project_id?: string | null;
  proposal_status?: string | null;
  merge_target?: string | null;
  auto_merge?: number;
}

export function updateGoal(goalId: string, fields: GoalUpdateInput, broadcast: (goal: Goal) => void): Goal | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { updates.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status); }
  if (fields.priority !== undefined) { updates.push('priority = ?'); values.push(fields.priority); }
  if (fields.repo_id !== undefined) { updates.push('repo_id = ?'); values.push(fields.repo_id); }
  if (fields.project_id !== undefined) { updates.push('project_id = ?'); values.push(fields.project_id); }
  if (fields.proposal_status !== undefined) { updates.push('proposal_status = ?'); values.push(fields.proposal_status); }
  if (fields.merge_target !== undefined) { updates.push('merge_target = ?'); values.push(fields.merge_target); }
  if (fields.auto_merge !== undefined) { updates.push('auto_merge = ?'); values.push(fields.auto_merge); }

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
// Project Helpers
// ============================================================================

export interface ProjectCreateInput {
  name: string;
  description?: string;
  architecturePlan?: string;
}

export function createProject(input: ProjectCreateInput, broadcast: (project: Project) => void): Project | null {
  const id = generateId();
  const now = getNow();
  return createAndFetch<Project>(
    'projects', id,
    `INSERT INTO projects (id, name, description, architecture_plan, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [id, input.name, input.description || '', input.architecturePlan || '', now, now],
    broadcast
  );
}

export interface ProjectUpdateInput {
  name?: string;
  description?: string;
  architecture_plan?: string;
  status?: string;
}

export function updateProject(projectId: string, fields: ProjectUpdateInput, broadcast: (project: Project) => void): Project | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { updates.push('description = ?'); values.push(fields.description); }
  if (fields.architecture_plan !== undefined) { updates.push('architecture_plan = ?'); values.push(fields.architecture_plan); }
  if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status); }

  return updateAndFetch<Project>('projects', projectId, updates, values, broadcast);
}

export function deleteProject(projectId: string, broadcast: (id: string) => void): void {
  // Unlink goals from this project
  runQuery('UPDATE goals SET project_id = NULL WHERE project_id = ?', [projectId]);
  // Delete project repos
  runQuery('DELETE FROM project_repos WHERE project_id = ?', [projectId]);
  deleteAndBroadcast('projects', projectId, broadcast);
}

export function listProjects(): Project[] {
  return getAll<Project>('SELECT * FROM projects ORDER BY created_at DESC');
}

export function addProjectRepo(projectId: string, repoPath: string): void {
  const now = getNow();
  runQuery(
    `INSERT OR IGNORE INTO project_repos (project_id, repo_path, added_at) VALUES (?, ?, ?)`,
    [projectId, repoPath, now]
  );
}

export function removeProjectRepo(projectId: string, repoPath: string): void {
  runQuery('DELETE FROM project_repos WHERE project_id = ? AND repo_path = ?', [projectId, repoPath]);
}

export function listProjectRepos(projectId: string): string[] {
  const rows = getAll<{ repo_path: string }>('SELECT repo_path FROM project_repos WHERE project_id = ?', [projectId]);
  return rows.map(r => r.repo_path);
}

export function getProjectGoals(projectId: string): Goal[] {
  return getAll<Goal>('SELECT * FROM goals WHERE project_id = ? ORDER BY priority DESC, created_at', [projectId]);
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

// ============================================================================
// Merge Gate Helpers
// ============================================================================

export interface MergeGateCreateInput {
  goalId: string;
  repoPath: string;
  goalBranch: string;
  targetBranch: string;
  mergeStrategy?: string;
}

export function createMergeGate(input: MergeGateCreateInput, broadcast: (gate: MergeGate) => void): MergeGate | null {
  const id = generateId();
  const now = getNow();
  return createAndFetch<MergeGate>(
    'merge_gates', id,
    `INSERT INTO merge_gates (id, goal_id, repo_path, goal_branch, target_branch, status, merge_strategy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [id, input.goalId, input.repoPath, input.goalBranch, input.targetBranch, input.mergeStrategy || 'squash', now, now],
    broadcast
  );
}

export function getMergeGate(id: string): MergeGate | null {
  return getOne<MergeGate>('SELECT * FROM merge_gates WHERE id = ?', [id]);
}

export function getMergeGateForGoal(goalId: string): MergeGate | null {
  return getOne<MergeGate>('SELECT * FROM merge_gates WHERE goal_id = ? ORDER BY created_at DESC LIMIT 1', [goalId]);
}

export function updateMergeGate(id: string, fields: Partial<MergeGate>, broadcast: (gate: MergeGate) => void): MergeGate | null {
  const updates: string[] = [];
  const values: unknown[] = [];

  if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status); }
  if (fields.review_agent_id !== undefined) { updates.push('review_agent_id = ?'); values.push(fields.review_agent_id); }
  if (fields.review_cycles !== undefined) { updates.push('review_cycles = ?'); values.push(fields.review_cycles); }
  if (fields.heal_attempts !== undefined) { updates.push('heal_attempts = ?'); values.push(fields.heal_attempts); }
  if (fields.review_verdict !== undefined) { updates.push('review_verdict = ?'); values.push(fields.review_verdict); }
  if (fields.test_results !== undefined) { updates.push('test_results = ?'); values.push(fields.test_results); }
  if (fields.consolidated_diff !== undefined) { updates.push('consolidated_diff = ?'); values.push(fields.consolidated_diff); }
  if (fields.merged_at !== undefined) { updates.push('merged_at = ?'); values.push(fields.merged_at); }

  return updateAndFetch<MergeGate>('merge_gates', id, updates, values, broadcast);
}

export function listMergeGates(status?: string): MergeGate[] {
  if (status) {
    return getAll<MergeGate>('SELECT * FROM merge_gates WHERE status = ? ORDER BY created_at DESC', [status]);
  }
  return getAll<MergeGate>('SELECT * FROM merge_gates ORDER BY created_at DESC');
}

/**
 * Merge gates the client needs to hydrate on connect: all non-terminal gates
 * plus any gate updated in the last 24h. (WS contract: sync:state.mergeGates)
 */
export function listActiveMergeGates(): MergeGate[] {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return getAll<MergeGate>(
    "SELECT * FROM merge_gates WHERE status NOT IN ('merged', 'failed') OR updated_at >= ? ORDER BY created_at DESC",
    [cutoff]
  );
}

// ============================================================================
// Review Config Helpers
// ============================================================================

export function getReviewConfig(repoPath: string): ReviewConfig | null {
  return getOne<ReviewConfig>('SELECT * FROM review_configs WHERE repo_path = ?', [repoPath]);
}

export function upsertReviewConfig(config: Partial<ReviewConfig> & { repo_path: string }): ReviewConfig | null {
  const existing = getReviewConfig(config.repo_path);
  const now = getNow();

  if (existing) {
    const updates: string[] = [];
    const values: unknown[] = [];
    if (config.rules !== undefined) { updates.push('rules = ?'); values.push(config.rules); }
    if (config.architecture_doc !== undefined) { updates.push('architecture_doc = ?'); values.push(config.architecture_doc); }
    if (config.conventions !== undefined) { updates.push('conventions = ?'); values.push(config.conventions); }
    if (config.test_command !== undefined) { updates.push('test_command = ?'); values.push(config.test_command); }
    if (config.target_branch !== undefined) { updates.push('target_branch = ?'); values.push(config.target_branch); }
    if (config.merge_strategy !== undefined) { updates.push('merge_strategy = ?'); values.push(config.merge_strategy); }
    if (config.min_review_score !== undefined) { updates.push('min_review_score = ?'); values.push(config.min_review_score); }
    if (config.max_review_cycles !== undefined) { updates.push('max_review_cycles = ?'); values.push(config.max_review_cycles); }
    if (config.max_heal_attempts !== undefined) { updates.push('max_heal_attempts = ?'); values.push(config.max_heal_attempts); }
    if (updates.length > 0) {
      updates.push('updated_at = ?'); values.push(now); values.push(existing.id);
      runQuery(`UPDATE review_configs SET ${updates.join(', ')} WHERE id = ?`, values);
    }
    return getOne<ReviewConfig>('SELECT * FROM review_configs WHERE id = ?', [existing.id]);
  }

  const id = generateId();
  runQuery(
    `INSERT INTO review_configs (id, repo_path, rules, architecture_doc, conventions, test_command, target_branch, merge_strategy, min_review_score, max_review_cycles, max_heal_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, config.repo_path, config.rules || '{}', config.architecture_doc || '', config.conventions || '', config.test_command || '', config.target_branch || 'develop', config.merge_strategy || 'squash', config.min_review_score ?? 70, config.max_review_cycles ?? 3, config.max_heal_attempts ?? 2, now, now]
  );
  return getOne<ReviewConfig>('SELECT * FROM review_configs WHERE id = ?', [id]);
}

// ============================================================================
// Audit Record Helpers
// ============================================================================

export function insertAuditRecord(record: Omit<AuditRecord, 'created_at'>): void {
  const now = getNow();
  runQuery(
    `INSERT INTO audit_records (id, prev_hash, timestamp, agent_id, session_id, merge_gate_id, goal_id, action_type, action_detail, outcome, confidence, duration_ms, tokens_used, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.prev_hash, record.timestamp, record.agent_id, record.session_id, record.merge_gate_id, record.goal_id, record.action_type, record.action_detail, record.outcome, record.confidence, record.duration_ms, record.tokens_used, record.cost_usd, now]
  );
}

export function getAuditRecords(mergeGateId: string): AuditRecord[] {
  return getAll<AuditRecord>('SELECT * FROM audit_records WHERE merge_gate_id = ? ORDER BY timestamp ASC', [mergeGateId]);
}

export function getLastAuditRecord(mergeGateId: string): AuditRecord | null {
  return getOne<AuditRecord>('SELECT * FROM audit_records WHERE merge_gate_id = ? ORDER BY timestamp DESC LIMIT 1', [mergeGateId]);
}

export function getAuditRecordsByGoal(goalId: string): AuditRecord[] {
  return getAll<AuditRecord>('SELECT * FROM audit_records WHERE goal_id = ? ORDER BY timestamp ASC', [goalId]);
}

// ============================================================================
// Review Finding Helpers
// ============================================================================

export function insertReviewFinding(finding: Omit<ReviewFinding, 'created_at'>): void {
  const now = getNow();
  runQuery(
    `INSERT INTO review_findings (id, merge_gate_id, review_cycle, severity, file_path, line_start, line_end, category, description, suggestion, resolved, resolved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [finding.id, finding.merge_gate_id, finding.review_cycle, finding.severity, finding.file_path, finding.line_start, finding.line_end, finding.category, finding.description, finding.suggestion, finding.resolved, finding.resolved_by, now]
  );
}

export function getReviewFindings(mergeGateId: string, cycle?: number): ReviewFinding[] {
  if (cycle !== undefined) {
    return getAll<ReviewFinding>('SELECT * FROM review_findings WHERE merge_gate_id = ? AND review_cycle = ? ORDER BY severity, file_path', [mergeGateId, cycle]);
  }
  return getAll<ReviewFinding>('SELECT * FROM review_findings WHERE merge_gate_id = ? ORDER BY review_cycle, severity, file_path', [mergeGateId]);
}

export function getUnresolvedFindings(mergeGateId: string): ReviewFinding[] {
  return getAll<ReviewFinding>(
    `SELECT * FROM review_findings WHERE merge_gate_id = ? AND resolved = 0 AND severity IN ('critical', 'warning') ORDER BY severity, file_path`,
    [mergeGateId]
  );
}

export function resolveReviewFinding(findingId: string, resolvedBy: string): void {
  runQuery('UPDATE review_findings SET resolved = 1, resolved_by = ? WHERE id = ?', [resolvedBy, findingId]);
}

export function getReviewFinding(findingId: string): ReviewFinding | null {
  return getOne<ReviewFinding>('SELECT * FROM review_findings WHERE id = ?', [findingId]);
}

// ============================================================================
// Review Guideline Helpers
// ============================================================================

export interface GuidelineCreateInput {
  repoPath: string;
  name: string;
  description?: string;
  type: ReviewGuideline['type'];
  source: ReviewGuideline['source'];
  sourcePath?: string;
  content: string;
  scope?: string;
  status?: ReviewGuideline['status'];
  priority?: number;
}

export function createGuideline(input: GuidelineCreateInput, broadcast: (g: ReviewGuideline) => void): ReviewGuideline | null {
  const id = generateId();
  const now = getNow();
  return createAndFetch<ReviewGuideline>(
    'review_guidelines', id,
    `INSERT INTO review_guidelines (id, repo_path, name, description, type, source, source_path, content, scope, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.repoPath, input.name, input.description || '', input.type, input.source, input.sourcePath || null, input.content, input.scope || '*', input.status || 'proposed', input.priority ?? 0, now, now],
    broadcast
  );
}

export function getGuideline(id: string): ReviewGuideline | null {
  return getOne<ReviewGuideline>('SELECT * FROM review_guidelines WHERE id = ?', [id]);
}

export function listGuidelines(repoPath: string, status?: ReviewGuideline['status']): ReviewGuideline[] {
  if (status) {
    return getAll<ReviewGuideline>(
      'SELECT * FROM review_guidelines WHERE repo_path = ? AND status = ? ORDER BY priority DESC, type, name',
      [repoPath, status]
    );
  }
  return getAll<ReviewGuideline>(
    'SELECT * FROM review_guidelines WHERE repo_path = ? ORDER BY status, priority DESC, type, name',
    [repoPath]
  );
}

export function listApprovedGuidelines(repoPath: string): ReviewGuideline[] {
  return getAll<ReviewGuideline>(
    'SELECT * FROM review_guidelines WHERE repo_path = ? AND status = ? ORDER BY priority DESC, type, name',
    [repoPath, 'approved']
  );
}

export function updateGuidelineStatus(id: string, status: ReviewGuideline['status'], broadcast: (g: ReviewGuideline) => void): ReviewGuideline | null {
  return updateAndFetch<ReviewGuideline>(
    'review_guidelines', id,
    ['status = ?'], [status],
    broadcast
  );
}

export function updateGuideline(id: string, fields: { name?: string; content?: string; scope?: string; priority?: number; type?: ReviewGuideline['type'] }, broadcast: (g: ReviewGuideline) => void): ReviewGuideline | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  if (fields.name !== undefined) { updates.push('name = ?'); values.push(fields.name); }
  if (fields.content !== undefined) { updates.push('content = ?'); values.push(fields.content); }
  if (fields.scope !== undefined) { updates.push('scope = ?'); values.push(fields.scope); }
  if (fields.priority !== undefined) { updates.push('priority = ?'); values.push(fields.priority); }
  if (fields.type !== undefined) { updates.push('type = ?'); values.push(fields.type); }
  return updateAndFetch<ReviewGuideline>('review_guidelines', id, updates, values, broadcast);
}

export function deleteGuideline(id: string, broadcast: (id: string) => void): void {
  deleteAndBroadcast('review_guidelines', id, broadcast);
}

export function approveAllGuidelines(repoPath: string): ReviewGuideline[] {
  const now = getNow();
  runQuery(
    `UPDATE review_guidelines SET status = 'approved', updated_at = ? WHERE repo_path = ? AND status = 'proposed'`,
    [now, repoPath]
  );
  return listGuidelines(repoPath, 'approved');
}

/** Check if a guideline with this source_path already exists for this repo */
export function guidelineExistsForPath(repoPath: string, sourcePath: string): boolean {
  const existing = getOne<{ id: string }>(
    'SELECT id FROM review_guidelines WHERE repo_path = ? AND source_path = ?',
    [repoPath, sourcePath]
  );
  return existing !== null;
}

// ============================================================================
// Agent Pattern Helpers (Structured Memory)
// ============================================================================

export function upsertAgentPattern(
  agentId: string, repoPath: string, name: string,
  fields: { trigger_condition?: string; code_example?: string; anti_pattern?: string; domain_tags?: string[]; goal_type?: string }
): AgentPattern | null {
  const now = getNow();
  // Deduplicate by name + agent
  const existing = getOne<AgentPattern>(
    'SELECT * FROM agent_patterns WHERE agent_id = ? AND repo_path = ? AND name = ?',
    [agentId, repoPath, name]
  );
  if (existing) {
    const updates: string[] = ['use_count = use_count + 1', 'updated_at = ?'];
    const values: unknown[] = [now];
    if (fields.code_example) { updates.push('code_example = ?'); values.push(fields.code_example); }
    if (fields.trigger_condition) { updates.push('trigger_condition = ?'); values.push(fields.trigger_condition); }
    if (fields.anti_pattern) { updates.push('anti_pattern = ?'); values.push(fields.anti_pattern); }
    if (fields.domain_tags) { updates.push('domain_tags = ?'); values.push(JSON.stringify(fields.domain_tags)); }
    values.push(existing.id);
    runQuery(`UPDATE agent_patterns SET ${updates.join(', ')} WHERE id = ?`, values);
    return getOne<AgentPattern>('SELECT * FROM agent_patterns WHERE id = ?', [existing.id]);
  }

  const id = generateId();
  runQuery(
    `INSERT INTO agent_patterns (id, agent_id, repo_path, name, trigger_condition, code_example, anti_pattern, domain_tags, goal_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, agentId, repoPath, name, fields.trigger_condition || '', fields.code_example || '', fields.anti_pattern || '',
     JSON.stringify(fields.domain_tags || []), fields.goal_type || null, now, now]
  );
  return getOne<AgentPattern>('SELECT * FROM agent_patterns WHERE id = ?', [id]);
}

export function markPatternVerified(patternId: string): void {
  runQuery('UPDATE agent_patterns SET verified = 1, success_count = success_count + 1, updated_at = ? WHERE id = ?', [getNow(), patternId]);
}

export function markPatternFailed(patternId: string): void {
  runQuery('UPDATE agent_patterns SET updated_at = ? WHERE id = ?', [getNow(), patternId]);
}

export function getRelevantPatterns(agentId: string, repoPath: string, domainTags: string[], limit = 5): AgentPattern[] {
  // Get all patterns for this agent+repo, then filter by tag overlap
  const all = getAll<AgentPattern>(
    'SELECT * FROM agent_patterns WHERE agent_id = ? AND repo_path = ? ORDER BY verified DESC, success_count DESC, use_count DESC',
    [agentId, repoPath]
  );
  if (domainTags.length === 0) return all.slice(0, limit);

  // Score by tag overlap
  const scored = all.map(p => {
    const tags: string[] = JSON.parse(p.domain_tags || '[]');
    const overlap = domainTags.filter(t => tags.some(pt => pt.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(pt.toLowerCase()))).length;
    return { pattern: p, score: overlap + (p.verified ? 2 : 0) + (p.success_count > 0 ? 1 : 0) };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.pattern);
}

// ============================================================================
// Agent Fix Helpers (Error → Fix Memory)
// ============================================================================

export function upsertAgentFix(
  agentId: string, errorSignature: string,
  fields: { root_cause?: string; fix_action?: string; fix_code?: string }
): AgentFix | null {
  const now = getNow();
  const existing = getOne<AgentFix>(
    'SELECT * FROM agent_fixes WHERE agent_id = ? AND error_signature = ?',
    [agentId, errorSignature]
  );
  if (existing) {
    const updates: string[] = ['times_seen = times_seen + 1', 'last_seen = ?'];
    const values: unknown[] = [now];
    if (fields.root_cause) { updates.push('root_cause = ?'); values.push(fields.root_cause); }
    if (fields.fix_action) { updates.push('fix_action = ?'); values.push(fields.fix_action); }
    if (fields.fix_code) { updates.push('fix_code = ?'); values.push(fields.fix_code); }
    values.push(existing.id);
    runQuery(`UPDATE agent_fixes SET ${updates.join(', ')} WHERE id = ?`, values);
    return getOne<AgentFix>('SELECT * FROM agent_fixes WHERE id = ?', [existing.id]);
  }

  const id = generateId();
  runQuery(
    `INSERT INTO agent_fixes (id, agent_id, error_signature, root_cause, fix_action, fix_code, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, agentId, errorSignature, fields.root_cause || '', fields.fix_action || '', fields.fix_code || '', now]
  );
  return getOne<AgentFix>('SELECT * FROM agent_fixes WHERE id = ?', [id]);
}

export function markFixSucceeded(fixId: string): void {
  runQuery('UPDATE agent_fixes SET times_fixed = times_fixed + 1, last_seen = ? WHERE id = ?', [getNow(), fixId]);
}

export function getMatchingFixes(agentId: string, errorOutput: string, limit = 3): AgentFix[] {
  const all = getAll<AgentFix>(
    'SELECT * FROM agent_fixes WHERE agent_id = ? ORDER BY times_fixed DESC, times_seen DESC',
    [agentId]
  );
  // Match by substring in error output
  return all.filter(f => errorOutput.includes(f.error_signature)).slice(0, limit);
}

// ============================================================================
// Cost Tracking Helpers
// ============================================================================

/** Get cumulative cost for a goal */
export function getGoalCost(goalId: string): number {
  const result = getOne<{ total: number }>(
    'SELECT COALESCE(SUM(cost_usd), 0) as total FROM run_metrics WHERE goal_id = ?',
    [goalId]
  );
  return result?.total ?? 0;
}

/** Get cumulative cost for an agent */
export function getAgentCost(agentId: string): number {
  const result = getOne<{ total: number }>(
    'SELECT COALESCE(SUM(cost_usd), 0) as total FROM run_metrics WHERE agent_id = ?',
    [agentId]
  );
  return result?.total ?? 0;
}

/**
 * Check if a goal has exceeded its budget cap.
 * Returns null when there is NO cap. By UX convention both NULL/undefined AND a
 * numeric 0 mean "no cap" — but we test them explicitly (not via a falsy check)
 * so a legitimate non-zero cap is never mistaken for "unset". (M1)
 */
export function checkGoalBudget(goalId: string): { exceeded: boolean; spent: number; cap: number } | null {
  const goal = getOne<{ budget_cap_usd: number | null }>('SELECT budget_cap_usd FROM goals WHERE id = ?', [goalId]);
  if (goal == null || goal.budget_cap_usd == null) return null; // no cap set
  if (goal.budget_cap_usd === 0) return null;                    // 0 = no cap (UX convention)
  const spent = getGoalCost(goalId);
  return { exceeded: spent >= goal.budget_cap_usd, spent, cap: goal.budget_cap_usd };
}

/** Sum of run_metrics.cost_usd for runs created today (UTC). Used by global:stats. */
export function getCostTodayUsd(): number {
  const startOfDayUtc = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const result = getOne<{ total: number }>(
    'SELECT COALESCE(SUM(cost_usd), 0) as total FROM run_metrics WHERE created_at >= ?',
    [startOfDayUtc]
  );
  return result?.total ?? 0;
}

// ============================================================================
// Experiment Record Helpers (Closed-Loop System)
// ============================================================================

export function createExperimentRecord(fields: Omit<ExperimentRecord, 'created_at' | 'queued_at' | 'started_at' | 'concluded_at'>): ExperimentRecord | null {
  const now = getNow();
  runQuery(
    `INSERT INTO experiment_records (id, agent_id, experiment_type, name, hypothesis, source, source_id, control_config, treatment_config, environment, metric_weights, status, priority, budget_cap_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fields.id, fields.agent_id, fields.experiment_type, fields.name, fields.hypothesis, fields.source, fields.source_id,
     fields.control_config, fields.treatment_config, fields.environment, fields.metric_weights, fields.status, fields.priority,
     fields.budget_cap_usd, now]
  );
  return getOne<ExperimentRecord>('SELECT * FROM experiment_records WHERE id = ?', [fields.id]);
}

export function getExperimentRecord(id: string): ExperimentRecord | null {
  return getOne<ExperimentRecord>('SELECT * FROM experiment_records WHERE id = ?', [id]);
}

export function getActiveExperimentByType(agentId: string, experimentType: string): ExperimentRecord | null {
  return getOne<ExperimentRecord>(
    `SELECT * FROM experiment_records WHERE agent_id = ? AND experiment_type = ? AND status = 'running' LIMIT 1`,
    [agentId, experimentType]
  );
}

export function getRunningExperiments(agentId: string): ExperimentRecord[] {
  return getAll<ExperimentRecord>(
    `SELECT * FROM experiment_records WHERE agent_id = ? AND status = 'running' ORDER BY priority DESC`,
    [agentId]
  );
}

export function getQueuedExperiments(agentId: string): ExperimentRecord[] {
  return getAll<ExperimentRecord>(
    `SELECT * FROM experiment_records WHERE agent_id = ? AND status = 'queued' ORDER BY priority DESC, created_at ASC`,
    [agentId]
  );
}

export function updateExperimentRecord(id: string, fields: Partial<ExperimentRecord>): ExperimentRecord | null {
  const updates: string[] = [];
  const values: unknown[] = [];
  const stringFields: Array<keyof ExperimentRecord> = ['status', 'decision_reason', 'queued_at', 'started_at', 'concluded_at', 'control_config', 'treatment_config'];
  const numericFields: Array<keyof ExperimentRecord> = ['p_value', 'effect_size', 'control_mean', 'treatment_mean', 'cost_spent_usd', 'priority'];

  for (const key of stringFields) {
    if (fields[key] !== undefined) { updates.push(`${key} = ?`); values.push(fields[key]); }
  }
  for (const key of numericFields) {
    if (fields[key] !== undefined) { updates.push(`${key} = ?`); values.push(fields[key]); }
  }
  if (updates.length === 0) return getExperimentRecord(id);
  values.push(id);
  runQuery(`UPDATE experiment_records SET ${updates.join(', ')} WHERE id = ?`, values);
  return getExperimentRecord(id);
}

export function listExperimentRecords(agentId: string, status?: string): ExperimentRecord[] {
  if (status) {
    return getAll<ExperimentRecord>(
      'SELECT * FROM experiment_records WHERE agent_id = ? AND status = ? ORDER BY created_at DESC',
      [agentId, status]
    );
  }
  return getAll<ExperimentRecord>(
    'SELECT * FROM experiment_records WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50',
    [agentId]
  );
}

// ── Experiment Runs ──

export function insertExperimentRun(fields: Omit<ExperimentRun, 'created_at'>): void {
  const now = getNow();
  runQuery(
    `INSERT INTO experiment_runs (id, experiment_id, variant, run_metric_id, score, cost_usd, duration_ms, merge_success, build_failures, test_failures, files_changed, composite_score, goal_id, task_id, goal_type, task_type, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fields.id, fields.experiment_id, fields.variant, fields.run_metric_id, fields.score, fields.cost_usd, fields.duration_ms,
     fields.merge_success, fields.build_failures, fields.test_failures, fields.files_changed, fields.composite_score,
     fields.goal_id, fields.task_id, fields.goal_type, fields.task_type, now]
  );
}

export function getExperimentRuns(experimentId: string, variant?: string): ExperimentRun[] {
  if (variant) {
    return getAll<ExperimentRun>(
      'SELECT * FROM experiment_runs WHERE experiment_id = ? AND variant = ? ORDER BY created_at',
      [experimentId, variant]
    );
  }
  return getAll<ExperimentRun>(
    'SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY created_at',
    [experimentId]
  );
}

export function getExperimentRunCounts(experimentId: string): { control: number; treatment: number } {
  const control = getOne<{ c: number }>('SELECT COUNT(*) as c FROM experiment_runs WHERE experiment_id = ? AND variant = ?', [experimentId, 'control']);
  const treatment = getOne<{ c: number }>('SELECT COUNT(*) as c FROM experiment_runs WHERE experiment_id = ? AND variant = ?', [experimentId, 'treatment']);
  return { control: control?.c ?? 0, treatment: treatment?.c ?? 0 };
}

// ============================================================================
// UI Query Helpers (for WS handlers)
// ============================================================================

/** List all patterns for an agent (no filtering) */
export function listAgentPatterns(agentId: string): AgentPattern[] {
  return getAll<AgentPattern>(
    'SELECT * FROM agent_patterns WHERE agent_id = ? ORDER BY verified DESC, success_count DESC',
    [agentId]
  );
}

/** List all fixes for an agent (no filtering) */
export function listAgentFixes(agentId: string): AgentFix[] {
  return getAll<AgentFix>(
    'SELECT * FROM agent_fixes WHERE agent_id = ? ORDER BY times_fixed DESC, times_seen DESC',
    [agentId]
  );
}

/** List all task research records */
export function listAllTaskResearch(limit = 50): TaskResearch[] {
  return getAll<TaskResearch>(
    'SELECT * FROM task_research ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
}

/** List all audit records (optionally by gate or goal) */
export function listAuditRecords(opts: { mergeGateId?: string; goalId?: string; limit?: number } = {}): AuditRecord[] {
  if (opts.mergeGateId) return getAuditRecords(opts.mergeGateId);
  if (opts.goalId) return getAuditRecordsByGoal(opts.goalId);
  return getAll<AuditRecord>(
    'SELECT * FROM audit_records ORDER BY created_at DESC LIMIT ?',
    [opts.limit || 100]
  );
}
