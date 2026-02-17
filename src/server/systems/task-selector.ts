/**
 * Task and goal selection via utility scoring.
 *
 * Replaces the ad-hoc scoreTask()/rankTasks() in self-improve.ts and
 * the simple priority-based getNextActiveGoal() in db-helpers.ts with
 * proper multi-factor utility scoring.
 *
 * Each factor returns 0-1, combined multiplicatively by the scoring engine.
 * A zero on any factor = hard veto (e.g., task is blocked or goal has no tasks).
 */
import { getAll, getOne } from '../db-helpers.js';
import {
  type Consideration,
  scoreItem,
  rankItems,
  selectBest,
  selectWeighted,
  normalize,
  diminishingReturns,
  decayCurve,
  type ScoreBreakdown,
} from '../engine/scoring.js';
import { ScoringWeights } from '../engine/constants.js';

// ============================================================================
// Task Scoring
// ============================================================================

/** Minimal task shape needed for scoring */
export interface ScoringTask {
  id: string;
  title: string;
  description: string;
  status: string;
  goal_id: string | null;
  created_at: string;
  sort_order: number;
}

/** Context for task scoring — agent-specific and goal-specific data */
export interface TaskScoringContext {
  agentId: string;
  /** Agent's skills for skill-match scoring */
  agentSkills: Array<{ name: string; description: string; tags: string; avg_score: number }>;
  /** Number of times each task has failed (taskId → count) */
  failureCounts: Map<string, number>;
  /** Parent goal's priority (0-5) */
  goalPriority: number;
  /** Max priority across all goals (for normalization) */
  maxPriority: number;
  /** Current timestamp */
  now: number;
}

/** Priority factor: higher priority goals propagate to their tasks */
const taskPriority: Consideration<ScoringTask, TaskScoringContext> = {
  name: 'priority',
  description: 'Higher priority goals push their tasks higher',
  weight: ScoringWeights.TASK_PRIORITY,
  evaluate: (_item, ctx) => {
    if (ctx.maxPriority === 0) return 0.5; // No priorities set, neutral
    return normalize(ctx.goalPriority, 0, ctx.maxPriority);
  },
};

/** Skill match: how well agent's skills match task keywords */
const taskSkillMatch: Consideration<ScoringTask, TaskScoringContext> = {
  name: 'skill_match',
  description: 'Tasks matching agent skills score higher',
  weight: ScoringWeights.TASK_SKILL_MATCH,
  evaluate: (item, ctx) => {
    if (ctx.agentSkills.length === 0) return 0.5; // No skills data, neutral

    const taskText = `${item.title} ${item.description}`.toLowerCase();
    const taskWords = taskText.split(/\W+/).filter(w => w.length > 3);
    if (taskWords.length === 0) return 0.5;

    let totalMatch = 0;
    for (const skill of ctx.agentSkills) {
      const skillText = `${skill.name} ${skill.description} ${skill.tags}`.toLowerCase();
      const matches = taskWords.filter(w => skillText.includes(w)).length;
      if (matches > 0) {
        // Weight by skill quality (avg_score is 0-100)
        totalMatch += (matches / taskWords.length) * (skill.avg_score / 100 || 0.5);
      }
    }

    // Clamp to 0-1 range, with 0.3 baseline (don't hard-veto unmatched tasks)
    return Math.min(1, 0.3 + totalMatch * 0.7);
  },
};

/** Freshness: recently created tasks score higher (decay over 7 days) */
const taskFreshness: Consideration<ScoringTask, TaskScoringContext> = {
  name: 'freshness',
  description: 'Recently created tasks score higher',
  weight: ScoringWeights.TASK_FRESHNESS,
  evaluate: (item, ctx) => {
    const ageMs = ctx.now - new Date(item.created_at).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return decayCurve(ageMs, sevenDaysMs);
  },
};

/** Failure penalty: tasks that have failed multiple times score lower */
const taskFailurePenalty: Consideration<ScoringTask, TaskScoringContext> = {
  name: 'failure_penalty',
  description: 'More failures = lower score (diminishing returns)',
  weight: ScoringWeights.TASK_FAILURE_PENALTY,
  evaluate: (item, ctx) => {
    const failures = ctx.failureCounts.get(item.id) || 0;
    return diminishingReturns(failures);
  },
};

/** All task considerations */
export const taskConsiderations: Consideration<ScoringTask, TaskScoringContext>[] = [
  taskPriority,
  taskSkillMatch,
  taskFreshness,
  taskFailurePenalty,
];

// ============================================================================
// Goal Scoring
// ============================================================================

/** Minimal goal shape needed for scoring */
export interface ScoringGoal {
  id: string;
  name: string;
  description: string;
  status: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

/** Context for goal scoring */
export interface GoalScoringContext {
  /** Max priority across all goals */
  maxPriority: number;
  /** Number of actionable (todo) tasks per goal (goalId → count) */
  actionableTaskCounts: Map<string, number>;
  /** Total tasks per goal (goalId → count) */
  totalTaskCounts: Map<string, number>;
  /** Completed tasks per goal (goalId → count) */
  completedTaskCounts: Map<string, number>;
  /** Failed task count per goal (goalId → count) */
  failedTaskCounts: Map<string, number>;
  /** Last run timestamp per goal (goalId → timestamp) */
  lastRunTimestamps: Map<string, number>;
  /** Current goal being worked on (gets momentum bonus) */
  currentGoalId: string | null;
  /** Current timestamp */
  now: number;
}

/** Priority: explicit user-set priority */
const goalPriority: Consideration<ScoringGoal, GoalScoringContext> = {
  name: 'priority',
  description: 'Higher priority goals score higher',
  weight: ScoringWeights.GOAL_PRIORITY,
  evaluate: (item, ctx) => {
    if (ctx.maxPriority === 0) return 0.5;
    return normalize(item.priority, 0, ctx.maxPriority);
  },
};

/** Momentum: current goal gets a bonus to prevent thrashing */
const goalMomentum: Consideration<ScoringGoal, GoalScoringContext> = {
  name: 'momentum',
  description: 'Current goal gets momentum bonus to prevent thrashing',
  weight: ScoringWeights.GOAL_MOMENTUM,
  evaluate: (item, ctx) => {
    return item.id === ctx.currentGoalId ? 1.0 : 0.5;
  },
};

/** Staleness: goals not worked on recently get a boost */
const goalStaleness: Consideration<ScoringGoal, GoalScoringContext> = {
  name: 'staleness',
  description: 'Goals not worked on recently get a boost (prevent neglect)',
  weight: ScoringWeights.GOAL_STALENESS,
  evaluate: (item, ctx) => {
    const lastRun = ctx.lastRunTimestamps.get(item.id);
    if (!lastRun) return 1.0; // Never worked on = max staleness bonus
    const ageMs = ctx.now - lastRun;
    const oneDayMs = 24 * 60 * 60 * 1000;
    // Older = higher score (inverse decay: grows toward 1 as time passes)
    return 1 - decayCurve(ageMs, oneDayMs);
  },
};

/** Completion urgency: goals close to done get an urgency boost */
const goalCompletionUrgency: Consideration<ScoringGoal, GoalScoringContext> = {
  name: 'completion_urgency',
  description: 'Goals close to completion get urgency boost (finish what you started)',
  weight: ScoringWeights.GOAL_COMPLETION_URGENCY,
  evaluate: (item, ctx) => {
    const total = ctx.totalTaskCounts.get(item.id) || 0;
    const completed = ctx.completedTaskCounts.get(item.id) || 0;
    if (total === 0) return 0.5; // No tasks = neutral
    const ratio = completed / total;
    // Exponential boost as completion approaches 100%
    return 0.3 + 0.7 * (ratio * ratio);
  },
};

/** Task availability: goals with actionable todo tasks score higher */
const goalTaskAvailability: Consideration<ScoringGoal, GoalScoringContext> = {
  name: 'task_availability',
  description: 'Goals with actionable todo tasks score higher',
  weight: ScoringWeights.GOAL_TASK_AVAILABILITY,
  evaluate: (item, ctx) => {
    const actionable = ctx.actionableTaskCounts.get(item.id) || 0;
    if (actionable === 0) return 0.1; // Almost zero but not quite (planning might create tasks)
    return Math.min(1, 0.5 + actionable * 0.1); // More tasks = higher, capped at 1
  },
};

/** Failure rate: goals with high failure rate get deprioritized */
const goalFailureRate: Consideration<ScoringGoal, GoalScoringContext> = {
  name: 'failure_rate',
  description: 'Goals with high failure rate get deprioritized (maybe blocked)',
  weight: ScoringWeights.GOAL_FAILURE_RATE,
  evaluate: (item, ctx) => {
    const total = ctx.totalTaskCounts.get(item.id) || 0;
    const failed = ctx.failedTaskCounts.get(item.id) || 0;
    if (total === 0) return 0.5;
    const failRate = failed / total;
    return 1 - failRate * 0.8; // Max 80% penalty for 100% failure rate
  },
};

/** All goal considerations */
export const goalConsiderations: Consideration<ScoringGoal, GoalScoringContext>[] = [
  goalPriority,
  goalMomentum,
  goalStaleness,
  goalCompletionUrgency,
  goalTaskAvailability,
  goalFailureRate,
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Select the best task for an agent to work on.
 * Returns the task with its full score breakdown, or null if no tasks.
 */
export function selectBestTask(
  tasks: ScoringTask[],
  ctx: TaskScoringContext
): { item: ScoringTask; breakdown: ScoreBreakdown<ScoringTask> } | null {
  return selectBest(tasks, taskConsiderations, ctx);
}

/**
 * Select the best goal to work on.
 * Uses weighted randomization among top 3 to add variety.
 */
export function selectBestGoal(
  goals: ScoringGoal[],
  ctx: GoalScoringContext
): { item: ScoringGoal; breakdown: ScoreBreakdown<ScoringGoal> } | null {
  return selectWeighted(goals, goalConsiderations, ctx, 3);
}

/**
 * Rank all tasks with full breakdowns (for UI display and debugging).
 */
export function rankScoredTasks(
  tasks: ScoringTask[],
  ctx: TaskScoringContext
): ScoreBreakdown<ScoringTask>[] {
  return rankItems(tasks, taskConsiderations, ctx);
}

/**
 * Rank all goals with full breakdowns (for UI display and debugging).
 */
export function rankScoredGoals(
  goals: ScoringGoal[],
  ctx: GoalScoringContext
): ScoreBreakdown<ScoringGoal>[] {
  return rankItems(goals, goalConsiderations, ctx);
}

// ============================================================================
// Context Builders — query DB to build scoring context
// ============================================================================

/**
 * Build task scoring context from database state.
 */
export function buildTaskScoringContext(agentId: string, goalPriority: number): TaskScoringContext {
  // Get agent skills
  const skills = getAll<{ name: string; description: string; tags: string; avg_score: number }>(
    'SELECT name, description, tags, avg_score FROM skills WHERE agent_id = ?',
    [agentId]
  );

  // Get failure counts per task
  const failures = getAll<{ task_id: string; fail_count: number }>(
    `SELECT task_id, COUNT(*) as fail_count FROM run_metrics
     WHERE agent_id = ? AND success = 0 AND task_id IS NOT NULL
     GROUP BY task_id`,
    [agentId]
  );
  const failureCounts = new Map(failures.map(f => [f.task_id, f.fail_count]));

  // Get max goal priority
  const maxRow = getOne<{ max_p: number }>('SELECT MAX(priority) as max_p FROM goals', []);
  const maxPriority = maxRow?.max_p || 5;

  return {
    agentId,
    agentSkills: skills,
    failureCounts,
    goalPriority,
    maxPriority,
    now: Date.now(),
  };
}

/**
 * Build goal scoring context from database state.
 */
export function buildGoalScoringContext(currentGoalId: string | null): GoalScoringContext {
  // Get max priority
  const maxRow = getOne<{ max_p: number }>('SELECT MAX(priority) as max_p FROM goals', []);
  const maxPriority = maxRow?.max_p || 5;

  // Get task counts per goal
  const taskCounts = getAll<{ goal_id: string; total: number; todo: number; done: number }>(
    `SELECT goal_id,
       COUNT(*) as total,
       SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
     FROM tasks WHERE goal_id IS NOT NULL GROUP BY goal_id`,
    []
  );

  const actionableTaskCounts = new Map<string, number>();
  const totalTaskCounts = new Map<string, number>();
  const completedTaskCounts = new Map<string, number>();
  for (const tc of taskCounts) {
    actionableTaskCounts.set(tc.goal_id, tc.todo);
    totalTaskCounts.set(tc.goal_id, tc.total);
    completedTaskCounts.set(tc.goal_id, tc.done);
  }

  // Get failed task counts per goal
  const failedCounts = getAll<{ goal_id: string; failed: number }>(
    `SELECT t.goal_id, COUNT(*) as failed FROM run_metrics rm
     JOIN tasks t ON rm.task_id = t.id
     WHERE rm.success = 0 AND t.goal_id IS NOT NULL
     GROUP BY t.goal_id`,
    []
  );
  const failedTaskCounts = new Map(failedCounts.map(f => [f.goal_id, f.failed]));

  // Get last run timestamp per goal
  const lastRuns = getAll<{ goal_id: string; last_run: string }>(
    `SELECT goal_id, MAX(created_at) as last_run FROM goal_log
     WHERE goal_id IS NOT NULL GROUP BY goal_id`,
    []
  );
  const lastRunTimestamps = new Map(
    lastRuns.map(r => [r.goal_id, new Date(r.last_run).getTime()])
  );

  return {
    maxPriority,
    actionableTaskCounts,
    totalTaskCounts,
    completedTaskCounts,
    failedTaskCounts,
    lastRunTimestamps,
    currentGoalId,
    now: Date.now(),
  };
}
