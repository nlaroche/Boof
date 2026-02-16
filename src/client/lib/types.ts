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
  goal_id: string | null;
  agent_generated: number;
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
  profile_id: string;
  instructions: string;
  skills: string;
  schedule: string | null;
  schedule_enabled: number;
  schedule_prompt: string;
  agent_type: string;
  xp: number;
  self_improve: number;
  autopilot: number;
  autopilot_interval: number;
  autopilot_goal_id: string | null;
  autopilot_last_run: string | null;
  workflow_id: string | null;
  created_at: string;
  last_activity: string;
}

export interface Goal {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'completed';
  priority: number;
  repo_id: string | null;
  proposed_by: string | null;
  proposal_status: 'approved' | 'pending' | 'rejected' | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  prompt: string;
  on_fail: 'stop' | 'revert' | 'retry' | 'skip';
  max_retries: number;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  created_at: string;
  updated_at: string;
}

export interface GoalLogEntry {
  id: string;
  goal_id: string;
  agent_id: string;
  action: string;
  summary: string;
  diff_stats: string;
  cost_usd: number;
  duration_ms: number;
  success: number;
  created_at: string;
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

export interface Assessment {
  id: string;
  agent_id: string;
  command_id: string;
  score: number;
  retries: number;
  build_failures: number;
  review_issues: number;
  files_touched: number;
  duration_ms: number;
  completed_fully: number;
  improvements: string;
  created_at: string;
}

export interface Improvement {
  id: string;
  agent_id: string;
  assessment_id: string | null;
  description: string;
  category: 'parser' | 'prompt' | 'build' | 'workflow' | 'general';
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  xp_awarded: number;
  created_at: string;
  completed_at: string | null;
}

export interface XpEvent {
  id: string;
  agent_id: string;
  amount: number;
  reason: string;
  source: string;
  created_at: string;
}

export type AgentStatus = Agent['status'];

// WebSocket message types
export type WSClientMessage =
  | { type: 'task:create'; folderId: string; title: string; description?: string; parentTaskId?: string; goalId?: string }
  | { type: 'task:update'; taskId: string; fields: Partial<Task> }
  | { type: 'task:delete'; taskId: string }
  | { type: 'task:reorder'; taskId: string; sortOrder: number }
  | { type: 'folder:create'; name: string; icon?: string }
  | { type: 'folder:update'; folderId: string; fields: Partial<Folder> }
  | { type: 'folder:delete'; folderId: string }
  | { type: 'agent:create'; workingDirectory: string; name?: string; profileId?: string }
  | { type: 'agent:update'; agentId: string; fields: { name?: string; instructions?: string; skills?: string; profile_id?: string; workflow_id?: string | null } }
  | { type: 'agent:delete'; agentId: string }
  | { type: 'agent:schedule'; agentId: string; schedule: string | null; enabled: boolean; prompt: string }
  | { type: 'agent:autopilot'; agentId: string; autopilot: boolean; interval: number; goalId: string | null }
  | { type: 'agent:autopilot:trigger'; agentId: string }
  | { type: 'repos:list' }
  | { type: 'agent:kill'; agentId: string }
  | { type: 'agent:restart'; agentId: string }
  | { type: 'agent:send'; agentId: string; prompt: string; taskId?: string }
  | { type: 'agent:interrupt'; agentId: string }
  | { type: 'agent:verify-ui'; agentId: string; url?: string; navigate?: string }
  | { type: 'agent:activity'; agentId: string; limit?: number }
  | { type: 'sync:request' }
  | { type: 'agent:history'; agentId: string; limit?: number }
  | { type: 'goal:create'; name: string; description?: string; repoId?: string }
  | { type: 'goal:propose'; agentId: string; name: string; description?: string; repoId?: string }
  | { type: 'goal:update'; goalId: string; fields: Partial<Goal> }
  | { type: 'goal:delete'; goalId: string }
  | { type: 'goal:list' }
  | { type: 'goal:log'; goalId: string; limit?: number }
  | { type: 'workflow:create'; name: string; description?: string; steps: WorkflowStep[] }
  | { type: 'workflow:update'; workflowId: string; fields: Partial<Workflow> }
  | { type: 'workflow:delete'; workflowId: string }
  | { type: 'workflow:list' }
  | { type: 'agent:self-improve'; agentId: string; enabled: boolean }
  | { type: 'agent:improvements'; agentId: string }
  | { type: 'agent:assessments'; agentId: string }
  | { type: 'improvement:skip'; improvementId: string }
  | { type: 'improvement:execute'; improvementId: string; agentId: string }
  | { type: 'agent:branches'; agentId: string }
  | { type: 'agent:merge-branch'; agentId: string; branchName: string }
  | { type: 'agent:discard-branch'; agentId: string; branchName: string }
  | { type: 'agent:xp-events'; agentId: string };

export type WSServerMessage =
  | { type: 'sync:state'; folders: Folder[]; tasks: Task[]; agents: Agent[]; goals: Goal[]; workflows: Workflow[]; commands?: Command[] }
  | { type: 'agent:output'; agentId: string; chunk: string }
  | { type: 'agent:updated'; agent: Agent }
  | { type: 'agent:deleted'; agentId: string }
  | { type: 'agent:status'; agentId: string; status: AgentStatus }
  | { type: 'agent:summary'; agentId: string; commandId: string; summary: string; filesChanged: string[] }
  | { type: 'command:updated'; command: Command }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:deleted'; taskId: string }
  | { type: 'folder:updated'; folder: Folder }
  | { type: 'folder:deleted'; folderId: string }
  | { type: 'repos:list'; repos: RepoInfo[] }
  | { type: 'notify'; agentId: string; title: string; body: string }
  | { type: 'agent:history'; agentId: string; commands: Command[] }
  | { type: 'agent:activity'; agentId: string; entries: GoalLogEntry[] }
  | { type: 'goal:updated'; goal: Goal }
  | { type: 'goal:proposed'; goal: Goal; agentId: string; reason?: string }
  | { type: 'goal:deleted'; goalId: string }
  | { type: 'goal:list'; goals: Goal[] }
  | { type: 'goal:log'; goalId: string; entries: GoalLogEntry[] }
  | { type: 'goal:log:entry'; entry: GoalLogEntry }
  | { type: 'workflow:updated'; workflow: Workflow }
  | { type: 'workflow:deleted'; workflowId: string }
  | { type: 'workflow:list'; workflows: Workflow[] }
  | { type: 'agent:improvements'; agentId: string; improvements: Improvement[] }
  | { type: 'agent:assessments'; agentId: string; assessments: Assessment[] }
  | { type: 'improvement:updated'; improvement: Improvement }
  | { type: 'agent:xp'; agentId: string; xp: number; event?: XpEvent }
  | { type: 'agent:xp-events'; agentId: string; events: XpEvent[] }
  | { type: 'agent:branches'; agentId: string; branches: string[] }
  | { type: 'agent:branch-merged'; agentId: string; branchName: string; success: boolean; output: string }
  | { type: 'agent:branch-discarded'; agentId: string; branchName: string };

export interface RepoInfo {
  name: string;
  path: string;
  hasGit: boolean;
}
