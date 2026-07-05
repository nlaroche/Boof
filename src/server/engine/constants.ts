/**
 * Engine constants — all magic strings and numbers live here.
 * Import from this file instead of using string literals.
 */

// ============================================================================
// Status Enums (as const for type narrowing)
// ============================================================================

export const AgentStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  ERROR: 'error',
  DEAD: 'dead',
} as const;

export const TaskStatus = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  ARCHIVED: 'archived',
} as const;

export const GoalStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
} as const;

export const ProjectStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
} as const;

export const CommandStatus = {
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
} as const;

export const ImprovementStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
} as const;

export const ExperimentStatus = {
  RUNNING: 'running',
  COMPLETED: 'completed',
} as const;

export const MergeGateStatus = {
  PENDING: 'pending',
  CONSOLIDATING: 'consolidating',
  REVIEWING: 'reviewing',
  REVISING: 'revising',
  TESTING: 'testing',
  HEALING: 'healing',
  APPROVED: 'approved',
  MERGING: 'merging',
  MERGED: 'merged',
  FAILED: 'failed',
} as const;

export const ReviewSeverity = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
  SUGGESTION: 'suggestion',
} as const;

export const ReviewCategory = {
  BUG: 'bug',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  STYLE: 'style',
  ARCHITECTURE: 'architecture',
  TEST_COVERAGE: 'test-coverage',
} as const;

export const AuditActionType = {
  CONSOLIDATE: 'consolidate',
  REVIEW: 'review',
  TEST: 'test',
  HEAL: 'heal',
  MERGE: 'merge',
  DECISION: 'decision',
  ERROR: 'error',
  EXPERIMENT_STARTED: 'experiment_started',
  EXPERIMENT_PROMOTED: 'experiment_promoted',
  EXPERIMENT_ROLLED_BACK: 'experiment_rolled_back',
  EXPERIMENT_INCONCLUSIVE: 'experiment_inconclusive',
} as const;

export const AuditOutcome = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  TIMEOUT: 'timeout',
  ESCALATED: 'escalated',
} as const;

export const ExperimentRecordStatus = {
  PROPOSED: 'proposed',
  QUEUED: 'queued',
  RUNNING: 'running',
  ANALYZING: 'analyzing',
  PROMOTED: 'promoted',
  ROLLED_BACK: 'rolled_back',
  INCONCLUSIVE: 'inconclusive',
  ARCHIVED: 'archived',
} as const;

export const ExperimentTypeEnum = {
  PROMPT: 'prompt',
  MODEL: 'model',
  PATTERN: 'pattern',
  WORKFLOW: 'workflow',
  FIX: 'fix',
} as const;

export const AgentRole = {
  IMPLEMENTATION: 'implementation',
  REVIEW: 'review',
  PLANNING: 'planning',
  RESEARCH: 'research',
  REFLECTION: 'reflection',
} as const;

export const ProposalStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export const WorkflowOnFail = {
  STOP: 'stop',
  REVERT: 'revert',
  RETRY: 'retry',
  SKIP: 'skip',
} as const;

// ============================================================================
// Derived Types
// ============================================================================

export type AgentStatusType = typeof AgentStatus[keyof typeof AgentStatus];
export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];
export type GoalStatusType = typeof GoalStatus[keyof typeof GoalStatus];
export type ProjectStatusType = typeof ProjectStatus[keyof typeof ProjectStatus];
export type CommandStatusType = typeof CommandStatus[keyof typeof CommandStatus];
export type ImprovementStatusType = typeof ImprovementStatus[keyof typeof ImprovementStatus];
export type ExperimentStatusType = typeof ExperimentStatus[keyof typeof ExperimentStatus];
export type MergeGateStatusType = typeof MergeGateStatus[keyof typeof MergeGateStatus];
export type ReviewSeverityType = typeof ReviewSeverity[keyof typeof ReviewSeverity];
export type ReviewCategoryType = typeof ReviewCategory[keyof typeof ReviewCategory];
export type AuditActionTypeType = typeof AuditActionType[keyof typeof AuditActionType];
export type AuditOutcomeType = typeof AuditOutcome[keyof typeof AuditOutcome];
export type AgentRoleType = typeof AgentRole[keyof typeof AgentRole];
export type ExperimentRecordStatusType = typeof ExperimentRecordStatus[keyof typeof ExperimentRecordStatus];
export type ExperimentTypeEnumType = typeof ExperimentTypeEnum[keyof typeof ExperimentTypeEnum];
export type ProposalStatusType = typeof ProposalStatus[keyof typeof ProposalStatus];
export type WorkflowOnFailType = typeof WorkflowOnFail[keyof typeof WorkflowOnFail];

// ============================================================================
// Timeouts (milliseconds)
// ============================================================================

export const Timeouts = {
  /** Quick git commands: status, branch, diff */
  GIT_QUICK: 5_000,
  /** Standard git commands: add, commit, log */
  GIT_STANDARD: 10_000,
  /** Longer git commands: checkout, worktree, merge */
  GIT_CHECKOUT: 30_000,
  /** Git merge (can be slow for large repos) */
  GIT_MERGE: 60_000,
  /** Vite build */
  BUILD: 120_000,
  /** Test suite */
  TEST: 180_000,
  /** Generic shell exec */
  EXEC_DEFAULT: 30_000,
  /** Mklink/junction creation */
  JUNCTION: 10_000,
  /** UI verification (Playwright) */
  UI_VERIFY: 30_000,
  /** E2E test suite (repo-specific) */
  E2E_TEST: 300_000,
  /** Review agent analysis */
  REVIEW: 120_000,
  /** Consolidation (merging multiple branches) */
  CONSOLIDATION: 180_000,
  /** Scheduler check interval */
  SCHEDULER_INTERVAL: 60_000,
  /** Hard cap on a single agent run before the watchdog kills it (60 min) */
  AGENT_RUN_HARD_CAP: 60 * 60 * 1000,
} as const;

// ============================================================================
// Limits
// ============================================================================

export const Limits = {
  /** Max lines in per-agent output buffer */
  MAX_OUTPUT_BUFFER_LINES: 200,
  /** Max chars for commit message summary */
  MAX_COMMIT_MSG_LENGTH: 150,
  /** Max chars for diff preview in self-review */
  MAX_DIFF_PREVIEW_LENGTH: 3000,
  /** Max retries for command execution */
  MAX_RETRIES: 2,
  /** Max goals an agent can cycle through per session */
  MAX_GOALS_PER_SESSION: 10,
  /** Max goal cycles per hour (rate limit) */
  MAX_CYCLES_PER_HOUR: 6,
  /** Min runs per variant before concluding experiment */
  EXPERIMENT_MIN_RUNS: 5,
  /** Autopilot loop interval */
  LOOP_INTERVAL_MS: 30_000,
  /** Backoff when no goals remain */
  IDLE_BACKOFF_MS: 300_000,
  /** Cache TTL for git operations and goal log */
  CACHE_TTL_MS: 30_000,
  /** One hour in milliseconds */
  ONE_HOUR_MS: 3_600_000,
  /** Max skill snippet preview length */
  MAX_SKILL_SNIPPET_LENGTH: 200,
  /** Max TSC errors to show in retry prompt */
  MAX_TSC_ERRORS_SHOWN: 10,
  /** Max error tail chars for retry prompt */
  MAX_ERROR_TAIL_LENGTH: 1000,
  /** Max recent reflections to include in prompt */
  MAX_REFLECTIONS_IN_PROMPT: 5,
  /** Max pending improvements to include in prompt */
  MAX_IMPROVEMENTS_IN_PROMPT: 3,
  /** Max review cycles (review → revise → re-review) */
  MAX_REVIEW_CYCLES: 3,
  /** Max self-heal attempts per merge gate */
  MAX_HEAL_ATTEMPTS: 2,
  /** Min review score to pass (0-100) */
  MIN_REVIEW_SCORE: 70,
  /** Consolidation cooldown before auto-trigger (ms) */
  CONSOLIDATION_COOLDOWN_MS: 300_000,
  /** Min runs per experiment variant before analysis */
  EXPERIMENT_MIN_RUNS_PER_VARIANT: 8,
  /** Max runs per experiment variant (stop even if inconclusive) */
  EXPERIMENT_MAX_RUNS_PER_VARIANT: 20,
  /** Significance threshold for experiment decisions */
  EXPERIMENT_P_THRESHOLD: 0.05,
  /** Minimum effect size (Cohen's d) to promote */
  EXPERIMENT_MIN_EFFECT_SIZE: 0.3,
  /** Runs between hypothesis generation checks */
  HYPOTHESIS_CHECK_INTERVAL: 5,
  /** Max matching skills to include in prompt */
  MAX_SKILLS_IN_PROMPT: 3,
  /** Agent name slug max length */
  MAX_SLUG_LENGTH: 40,
  /** Agent safe name max length (for worktree dirs) */
  MAX_SAFE_NAME_LENGTH: 30,
} as const;

// ============================================================================
// Paths
// ============================================================================

export const Paths = {
  /** Default repos directory */
  DEFAULT_REPOS_DIR: process.env.REPOS_DIR || (process.platform === 'win32' ? 'D:\\Repos' : `${process.env.HOME}/projects`),
  /** Boof memory directory name */
  BOOF_DIR: '.boof',
  /** Memory file name */
  MEMORY_FILE: 'memory.json',
} as const;

// ============================================================================
// Scoring Weights (for utility scoring system)
// ============================================================================

export const ScoringWeights = {
  /** Task scoring */
  TASK_PRIORITY: 1.5,
  TASK_SKILL_MATCH: 1.2,
  TASK_FRESHNESS: 1.0,
  TASK_FAILURE_PENALTY: 1.0,
  TASK_COMPLEXITY_FIT: 0.8,
  TASK_GOAL_URGENCY: 1.3,
  TASK_DEPENDENCY: 2.0,

  /** Goal scoring */
  GOAL_PRIORITY: 1.5,
  GOAL_MOMENTUM: 1.2,
  GOAL_STALENESS: 1.0,
  GOAL_COMPLETION_URGENCY: 1.3,
  GOAL_TASK_AVAILABILITY: 1.0,
  GOAL_FAILURE_RATE: 0.8,

  /** Threshold: switch goals if another scores this much higher */
  GOAL_SWITCH_THRESHOLD: 0.2,
} as const;

// ============================================================================
// XP & Assessment
// ============================================================================

export const XP = {
  /** XP for completing a command */
  COMMAND_COMPLETE: 1,
  /** Bonus XP for perfect score (>=90) */
  PERFECT_SCORE_BONUS: 2,
  /** XP for completing an improvement */
  IMPROVEMENT_COMPLETE: 2,

  /** Assessment score penalties */
  PENALTY_PER_RETRY: 15,
  PENALTY_PER_BUILD_FAILURE: 20,
  PENALTY_PER_REVIEW_ISSUE: 10,
  PENALTY_PER_TEST_FAILURE: 10,
  PENALTY_PER_EXTRA_FILE: 2,
  /** Files touched threshold before penalty kicks in */
  FILES_TOUCHED_THRESHOLD: 5,
  /** Max failure penalty in task scoring */
  MAX_FAILURE_PENALTY: 20,
} as const;
