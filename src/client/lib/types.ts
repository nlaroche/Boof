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
  done_when: string;
  task_type: 'feature' | 'fix' | 'refactor' | 'test' | 'docs' | 'chore';
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
  worktree_path: string | null;
  model_config: string | null;
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
  project_id: string | null;
  proposed_by: string | null;
  proposal_status: 'approved' | 'pending' | 'rejected' | null;
  completed_at: string | null;
  budget_cap_usd: number | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  architecture_plan: string;
  status: 'active' | 'paused' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface GoalStats {
  goal_id: string;
  total_runs: number;
  tasks_completed: number;
  tasks_failed: number;
  avg_duration_ms: number;
  last_run_at: string | null;
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
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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

export interface RunMetric {
  id: string;
  agent_id: string;
  command_id: string | null;
  goal_id: string | null;
  task_id: string | null;
  duration_ms: number;
  retries: number;
  build_failures: number;
  files_touched: number;
  prompt_tokens: number;
  completion_tokens: number;
  success: number;
  error_type: string | null;
  prompt_version_id: string | null;
  created_at: string;
}

export interface Reflection {
  id: string;
  agent_id: string;
  command_id: string | null;
  went_well: string;
  improve: string;
  pattern: string;
  created_at: string;
}

export interface Skill {
  id: string;
  agent_id: string;
  name: string;
  description: string;
  code_snippet: string;
  tags: string;
  times_used: number;
  times_succeeded: number;
  avg_score: number;
  created_at: string;
  updated_at: string;
}

export interface PromptVersion {
  id: string;
  agent_id: string;
  version: number;
  template: string;
  avg_score: number;
  total_runs: number;
  is_active: number;
  created_at: string;
}

export interface Experiment {
  id: string;
  agent_id: string;
  name: string;
  hypothesis: string;
  variant_a: string;
  variant_b: string;
  metric: string;
  runs_a: number;
  runs_b: number;
  avg_metric_a: number;
  avg_metric_b: number;
  status: string;
  winner: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DashboardData {
  success_rate_10: number;
  success_rate_50: number;
  success_rate_all: number;
  merge_success_rate: number;
  avg_duration_trend: number[];
  avg_score_trend: number[];
  total_tokens: number;
  skills_count: number;
  top_errors: { type: string; count: number }[];
  xp_per_day: { date: string; xp: number }[];
  recent_reflections: Reflection[];
}

export interface TimelineRun {
  id: string;
  branch: string;
  startedAt: string;
  endedAt: string;
  stages: GoalLogEntry[];
  success: boolean;
  totalDurationMs: number;
  totalTokens: number;
}

// ── Aggregated types for dashboard ──

export interface AggregatedSkill {
  name: string;
  category: string;
  avgProficiency: number;
  agentCount: number;
  agentNames: string[];
}

export interface GlobalStats {
  totalCommands: number;
  successRate: number;
  totalXp: number;
  totalTokensUsed: number;
  avgDurationMs: number;
}

export interface RecentLearning {
  id: string;
  agentId: string;
  agentName: string;
  type: 'improvement' | 'reflection';
  text: string;
  createdAt: string;
}

// ── Review & Merge Layer ──

export interface ReviewConfig {
  id: string;
  repo_path: string;
  rules: string;
  architecture_doc: string;
  conventions: string;
  test_command: string;
  target_branch: string;
  merge_strategy: 'squash' | 'no-ff';
  min_review_score: number;
  max_review_cycles: number;
  max_heal_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface MergeGate {
  id: string;
  goal_id: string;
  repo_path: string;
  goal_branch: string;
  target_branch: string;
  status: 'pending' | 'consolidating' | 'reviewing' | 'revising' | 'testing' | 'healing' | 'approved' | 'merging' | 'merged' | 'failed';
  review_agent_id: string | null;
  review_cycles: number;
  heal_attempts: number;
  review_verdict: string | null;
  test_results: string | null;
  consolidated_diff: string | null;
  merge_strategy: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditRecord {
  id: string;
  prev_hash: string | null;
  timestamp: string;
  agent_id: string;
  session_id: string | null;
  merge_gate_id: string | null;
  goal_id: string | null;
  action_type: 'consolidate' | 'review' | 'test' | 'heal' | 'merge' | 'decision' | 'error';
  action_detail: string;
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  confidence: number | null;
  duration_ms: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  created_at: string;
}

export interface ReviewFinding {
  id: string;
  merge_gate_id: string;
  review_cycle: number;
  severity: 'critical' | 'warning' | 'info' | 'suggestion';
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  category: 'bug' | 'security' | 'performance' | 'style' | 'architecture' | 'test-coverage';
  description: string;
  suggestion: string | null;
  resolved: number;
  resolved_by: string | null;
  created_at: string;
}

export interface ReviewGuideline {
  id: string;
  repo_path: string;
  name: string;
  description: string;
  /** architecture = structural docs, convention = style/rules, custom = user-added */
  type: 'architecture' | 'convention' | 'custom' | 'test' | 'security';
  /** How it got here: discovered = auto-scan, manual = user-added, folder = from assigned folder */
  source: 'discovered' | 'manual' | 'folder';
  /** File path this was discovered from (null for manual) */
  source_path: string | null;
  /** The actual guideline content (MD text) */
  content: string;
  /** Glob pattern for which files this guideline applies to ('*' = all) */
  scope: string;
  /** proposed = needs user approval, approved = active, rejected = user dismissed */
  status: 'proposed' | 'approved' | 'rejected';
  /** Higher priority guidelines are shown first in the review prompt */
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface AgentPattern {
  id: string;
  agent_id: string;
  repo_path: string;
  name: string;
  trigger_condition: string;
  code_example: string;
  anti_pattern: string;
  verified: number;
  use_count: number;
  success_count: number;
  domain_tags: string;
  goal_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentFix {
  id: string;
  agent_id: string;
  error_signature: string;
  root_cause: string;
  fix_action: string;
  fix_code: string;
  times_seen: number;
  times_fixed: number;
  last_seen: string;
}

export interface ExperimentRecord {
  id: string;
  agent_id: string;
  experiment_type: 'prompt' | 'model' | 'pattern' | 'workflow' | 'fix';
  name: string;
  hypothesis: string;
  source: 'reflection' | 'failure_cluster' | 'improvement' | 'cost_analysis' | 'manual';
  source_id: string | null;
  control_config: string;
  treatment_config: string;
  environment: string;
  metric_weights: string;
  status: 'proposed' | 'queued' | 'running' | 'analyzing' | 'promoted' | 'rolled_back' | 'inconclusive' | 'archived';
  priority: number;
  p_value: number | null;
  effect_size: number | null;
  control_mean: number | null;
  treatment_mean: number | null;
  decision_reason: string | null;
  cost_spent_usd: number;
  budget_cap_usd: number | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  concluded_at: string | null;
}

export interface ExperimentRun {
  id: string;
  experiment_id: string;
  variant: 'control' | 'treatment';
  run_metric_id: string | null;
  score: number;
  cost_usd: number;
  duration_ms: number;
  merge_success: number | null;
  build_failures: number;
  test_failures: number;
  files_changed: number;
  composite_score: number;
  goal_id: string | null;
  task_id: string | null;
  goal_type: string | null;
  task_type: string | null;
  created_at: string;
}

export interface ModelConfig {
  implementation?: string;
  review?: string;
  planning?: string;
  research?: string;
  reflection?: string;
}

export interface TaskResearch {
  id: string;
  task_id: string;
  agent_id: string;
  query: string;
  findings: string;
  sources: string;
  recommendations: string;
  duration_ms: number;
  tokens_used: number;
  model_used: string;
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
  | { type: 'goal:create'; name: string; description?: string; repoId?: string; projectId?: string }
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
  | { type: 'agent:xp-events'; agentId: string }
  | { type: 'agent:dashboard'; agentId: string }
  | { type: 'agent:skills'; agentId: string }
  | { type: 'agent:experiments'; agentId: string }
  | { type: 'agent:create-experiment'; agentId: string; name: string; hypothesis: string; variantA: string; variantB: string }
  | { type: 'agent:timeline'; agentId: string }
  | { type: 'goal:set-priority'; goalId: string; priority: number }
  | { type: 'goal:get-stats'; goalId: string }
  | { type: 'project:create'; name: string; description?: string; architecturePlan?: string }
  | { type: 'project:update'; projectId: string; fields: Partial<Project> }
  | { type: 'project:delete'; projectId: string }
  | { type: 'project:list' }
  | { type: 'project:add-repo'; projectId: string; repoPath: string }
  | { type: 'project:remove-repo'; projectId: string; repoPath: string }
  | { type: 'project:get-repos'; projectId: string }
  | { type: 'project:get-goals'; projectId: string }
  | { type: 'global:skills' }
  | { type: 'global:stats' }
  | { type: 'global:learnings'; limit?: number }
  | { type: 'project:skills'; projectId: string }
  | { type: 'guidelines:scan'; repoPath: string }
  | { type: 'guidelines:list'; repoPath: string }
  | { type: 'guidelines:approve'; guidelineId: string }
  | { type: 'guidelines:reject'; guidelineId: string }
  | { type: 'guidelines:approve-all'; repoPath: string }
  | { type: 'guidelines:update'; guidelineId: string; fields: { name?: string; content?: string; scope?: string; priority?: number; type?: ReviewGuideline['type'] } }
  | { type: 'guidelines:add'; repoPath: string; name: string; content: string; guidelineType?: ReviewGuideline['type']; scope?: string }
  | { type: 'guidelines:add-folder'; repoPath: string; folderPath: string; guidelineType?: ReviewGuideline['type'] }
  | { type: 'guidelines:delete'; guidelineId: string }
  | { type: 'guidelines:deep-scan'; repoPath: string }
  // Merge Gates
  | { type: 'mergeGate:list'; status?: string }
  | { type: 'mergeGate:get'; mergeGateId: string }
  | { type: 'mergeGate:consolidate'; goalId: string }
  | { type: 'mergeGate:merge'; mergeGateId: string }
  | { type: 'mergeGate:abort'; mergeGateId: string }
  // Review Findings
  | { type: 'reviewFindings:list'; mergeGateId: string; cycle?: number }
  | { type: 'reviewFindings:resolve'; findingId: string; resolvedBy: string }
  // Audit Trail
  | { type: 'audit:list'; mergeGateId?: string; goalId?: string; limit?: number }
  | { type: 'audit:summary'; mergeGateId: string }
  | { type: 'audit:verify'; mergeGateId: string }
  // Task Research
  | { type: 'research:list'; agentId?: string; limit?: number }
  | { type: 'research:get'; taskId: string }
  // Agent Memory
  | { type: 'agentMemory:patterns'; agentId: string }
  | { type: 'agentMemory:fixes'; agentId: string }
  // Experiment Records
  | { type: 'experimentRecords:list'; agentId?: string; status?: string }
  | { type: 'experimentRecords:runs'; experimentId: string }
  // Analytics
  | { type: 'analytics:cost'; agentId?: string; days?: number }
  | { type: 'analytics:performance'; agentId?: string; days?: number }
  | { type: 'maintenance:get-config' }
  | { type: 'maintenance:update-config'; config: Record<string, unknown> }
  | { type: 'maintenance:get-log'; limit?: number }
  | { type: 'maintenance:trigger'; dryRun?: boolean };

export type WSServerMessage =
  | { type: 'sync:state'; folders: Folder[]; tasks: Task[]; agents: Agent[]; goals: Goal[]; workflows: Workflow[]; projects: Project[]; commands?: Command[] }
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
  | { type: 'agent:branch-discarded'; agentId: string; branchName: string }
  | { type: 'agent:dashboard'; agentId: string; data: DashboardData }
  | { type: 'agent:skills'; agentId: string; skills: Skill[] }
  | { type: 'agent:experiments'; agentId: string; experiments: Experiment[] }
  | { type: 'agent:timeline'; agentId: string; runs: TimelineRun[] }
  | { type: 'goal:completed'; goalId: string; agentId: string; goal: Goal }
  | { type: 'goal:switched'; agentId: string; previousGoalId: string | null; newGoalId: string; goal: Goal }
  | { type: 'goal:proposed-auto'; agentId: string; goals: Goal[] }
  | { type: 'goal:stats'; goalId: string; stats: GoalStats | null }
  | { type: 'project:updated'; project: Project }
  | { type: 'project:deleted'; projectId: string }
  | { type: 'project:list'; projects: Project[] }
  | { type: 'project:repos'; projectId: string; repos: string[] }
  | { type: 'project:goals'; projectId: string; goals: Goal[] }
  | { type: 'global:skills:result'; skills: AggregatedSkill[] }
  | { type: 'global:stats:result'; stats: GlobalStats }
  | { type: 'global:learnings:result'; learnings: RecentLearning[] }
  | { type: 'project:skills:result'; projectId: string; skills: AggregatedSkill[] }
  | { type: 'guidelines:list'; repoPath: string; guidelines: ReviewGuideline[] }
  | { type: 'guidelines:scanned'; repoPath: string; proposed: ReviewGuideline[]; existingCount: number }
  | { type: 'guidelines:updated'; guideline: ReviewGuideline }
  | { type: 'guidelines:deleted'; guidelineId: string }
  | { type: 'guidelines:deep-scan:result'; repoPath: string; sourceMapSize: number; prompt: string; guidelines: ReviewGuideline[] }
  // Merge Gates
  | { type: 'mergeGate:list'; gates: MergeGate[] }
  | { type: 'mergeGate:get'; gate: MergeGate }
  | { type: 'mergeGate:updated'; gate: MergeGate }
  // Review Findings
  | { type: 'reviewFindings:list'; mergeGateId: string; findings: ReviewFinding[] }
  | { type: 'reviewFinding:updated'; finding: ReviewFinding }
  // Audit Trail
  | { type: 'audit:list'; records: AuditRecord[]; key: string }
  | { type: 'audit:summary'; mergeGateId: string; summary: AuditSummary }
  | { type: 'audit:verification'; mergeGateId: string; valid: boolean; brokenAt?: string; recordCount: number }
  // Task Research
  | { type: 'research:list'; research: TaskResearch[] }
  | { type: 'research:result'; taskId: string; research: TaskResearch }
  // Agent Memory
  | { type: 'agentMemory:patterns'; agentId: string; patterns: AgentPattern[] }
  | { type: 'agentMemory:fixes'; agentId: string; fixes: AgentFix[] }
  // Experiment Records
  | { type: 'experimentRecords:list'; experiments: ExperimentRecord[] }
  | { type: 'experimentRecords:runs'; experimentId: string; runs: ExperimentRun[] }
  | { type: 'experimentRecord:updated'; experiment: ExperimentRecord }
  // Analytics
  | { type: 'analytics:cost'; data: CostAnalytics }
  | { type: 'analytics:performance'; data: PerformanceAnalytics }
  | { type: 'maintenance:config'; config: Record<string, unknown> }
  | { type: 'maintenance:log'; entries: unknown[] }
  | { type: 'maintenance:triggered' };

export interface RepoInfo {
  name: string;
  path: string;
  hasGit: boolean;
}

// ── Analytics types ──

export interface AuditSummary {
  totalRecords: number;
  actionCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
  totalCostUsd: number;
  totalTokens: number;
}

export interface CostAnalytics {
  totalCostUsd: number;
  byAgent: { agentId: string; agentName: string; costUsd: number }[];
  byGoal: { goalId: string; goalName: string; costUsd: number }[];
  daily: { date: string; costUsd: number }[];
}

export interface PerformanceAnalytics {
  successRate: number;
  avgDurationMs: number;
  daily: { date: string; successRate: number; avgDurationMs: number; runs: number }[];
  failureCategories: { category: string; count: number }[];
  topErrors: { type: string; count: number }[];
}
