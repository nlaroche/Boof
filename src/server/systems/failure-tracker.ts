/**
 * Failure classification and escalation system.
 *
 * Classifies task failures into categories and determines the right response:
 * - agent_error: typo, bad logic, wrong file → retry (max 2x), then split
 * - environment_error: broken dep, flaky test, infra issue → skip + notify
 * - ambiguous_requirement: task unclear, conflicting info → pause + flag
 *
 * Tracks consecutive failures per goal to detect "stuck" goals that need
 * human intervention.
 */
import { getAll, getOne, runQuery } from '../db-helpers.js';

// ── Types ──

export type FailureCategory = 'agent_error' | 'environment_error' | 'ambiguous_requirement';

export interface FailureClassification {
  category: FailureCategory;
  confidence: number;  // 0-1
  reason: string;
  suggestion: string;
}

export interface EscalationDecision {
  action: 'retry' | 'skip' | 'pause_task' | 'pause_goal' | 'split_task';
  reason: string;
  /** If split_task, suggested sub-tasks */
  splitSuggestions?: string[];
}

// ── Failure Classification ──

/** Patterns that indicate environment/infrastructure errors (not the agent's fault) */
const ENVIRONMENT_PATTERNS = [
  /ENOENT|EACCES|EPERM/i,                    // filesystem permission/access
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,       // network errors
  /Cannot find module '(?!\.)/,               // missing npm package (not relative import)
  /npm ERR!/i,                                // npm failure
  /ENOMEM|heap out of memory/i,              // OOM
  /segmentation fault/i,                      // crash
  /killed|SIGKILL|SIGTERM/i,                 // process killed externally
  /rate.?limit|429|quota exceeded/i,         // API rate limits
  /CERTIFICATE|SSL|TLS/i,                    // cert issues
  /disk.?full|no space left/i,              // disk issues
  /flaky|intermittent|timeout.*test/i,      // known flaky tests
];

/** Patterns that indicate the agent made a coding error */
const AGENT_ERROR_PATTERNS = [
  /TS\d{4}:/,                                 // TypeScript errors
  /SyntaxError/,                              // syntax errors
  /ReferenceError/,                           // undefined references
  /TypeError.*is not a function/,             // wrong types
  /Cannot find name/,                         // missing declaration
  /Property.*does not exist/,                 // wrong property access
  /Expected.*but got/i,                       // assertion failures
  /import.*from.*not found/i,                 // bad relative imports
  /Duplicate.*identifier/i,                   // naming conflicts
];

/** Patterns that suggest the task itself is unclear */
const AMBIGUOUS_PATTERNS = [
  /which.*file|where.*should|not sure/i,      // agent expressing confusion
  /conflicting.*requirements/i,
  /no such file|file not found.*(?=.*task)/i,  // referenced file doesn't exist
  /TODO|FIXME|HACK.*in task/i,               // task references incomplete work
];

/**
 * Classify a failure based on the error output and context.
 */
export function classifyFailure(
  errorOutput: string,
  taskTitle: string,
  taskDescription: string,
  exitCode: number,
): FailureClassification {
  const combined = `${errorOutput}\n${taskTitle}\n${taskDescription}`;

  // Check environment patterns first (highest priority — not agent's fault)
  for (const pattern of ENVIRONMENT_PATTERNS) {
    if (pattern.test(combined)) {
      return {
        category: 'environment_error',
        confidence: 0.85,
        reason: `Environment issue detected: ${pattern.source}`,
        suggestion: 'Skip this task and notify — not the agent\'s fault.',
      };
    }
  }

  // Check ambiguous requirement patterns
  for (const pattern of AMBIGUOUS_PATTERNS) {
    if (pattern.test(combined)) {
      return {
        category: 'ambiguous_requirement',
        confidence: 0.7,
        reason: `Task may be unclear: ${pattern.source}`,
        suggestion: 'Pause task and flag for human clarification.',
      };
    }
  }

  // Check agent error patterns
  for (const pattern of AGENT_ERROR_PATTERNS) {
    if (pattern.test(errorOutput)) {
      return {
        category: 'agent_error',
        confidence: 0.9,
        reason: `Coding error: ${pattern.source}`,
        suggestion: 'Retry with error context, or split into smaller task.',
      };
    }
  }

  // Default: if exit code != 0 and we can't classify, assume agent error
  if (exitCode !== 0) {
    return {
      category: 'agent_error',
      confidence: 0.5,
      reason: 'Unclassified failure (exit code non-zero)',
      suggestion: 'Retry once, then escalate.',
    };
  }

  return {
    category: 'agent_error',
    confidence: 0.3,
    reason: 'Unknown failure',
    suggestion: 'Retry once.',
  };
}

// ── Consecutive Failure Tracking ──

/** In-memory tracking of consecutive failures per goal per agent */
const consecutiveFailures = new Map<string, number>(); // key: `${agentId}:${goalId}`

function failureKey(agentId: string, goalId: string): string {
  return `${agentId}:${goalId}`;
}

/** Record a task success — resets consecutive failure counter */
export function recordSuccess(agentId: string, goalId: string): void {
  consecutiveFailures.set(failureKey(agentId, goalId), 0);
}

/** Record a task failure — increments counter, returns new count */
export function recordFailure(agentId: string, goalId: string): number {
  const key = failureKey(agentId, goalId);
  const count = (consecutiveFailures.get(key) ?? 0) + 1;
  consecutiveFailures.set(key, count);
  return count;
}

/** Get the current consecutive failure count */
export function getConsecutiveFailures(agentId: string, goalId: string): number {
  return consecutiveFailures.get(failureKey(agentId, goalId)) ?? 0;
}

/** Reset failure tracking for an agent */
export function resetFailureTracking(agentId: string): void {
  for (const key of consecutiveFailures.keys()) {
    if (key.startsWith(`${agentId}:`)) {
      consecutiveFailures.delete(key);
    }
  }
}

// ── Escalation Decision ──

/** Max retries for agent errors before escalating */
const MAX_AGENT_RETRIES = 2;
/** Consecutive failures before pausing a goal */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * Determine what to do about a failure based on classification and history.
 */
export function decideEscalation(
  classification: FailureClassification,
  taskFailureCount: number,
  consecutiveGoalFailures: number,
): EscalationDecision {
  // Goal-level escalation: too many consecutive failures → pause the whole goal
  if (consecutiveGoalFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    return {
      action: 'pause_goal',
      reason: `${consecutiveGoalFailures} consecutive failures on this goal. Pausing for human review.`,
    };
  }

  switch (classification.category) {
    case 'environment_error':
      return {
        action: 'skip',
        reason: `Environment error: ${classification.reason}. Skipping — not the agent's fault.`,
      };

    case 'ambiguous_requirement':
      return {
        action: 'pause_task',
        reason: `Task is unclear: ${classification.reason}. Pausing for human clarification.`,
      };

    case 'agent_error':
      if (taskFailureCount < MAX_AGENT_RETRIES) {
        return {
          action: 'retry',
          reason: `Agent error (attempt ${taskFailureCount + 1}/${MAX_AGENT_RETRIES}): ${classification.reason}`,
        };
      }
      // Exceeded retries — suggest splitting the task
      return {
        action: 'split_task',
        reason: `Agent failed ${taskFailureCount} times. Task may be too large — consider splitting.`,
        splitSuggestions: [
          'Break into a smaller first step (just the core change, no tests)',
          'Separate the test changes from the implementation',
        ],
      };

    default:
      return {
        action: 'retry',
        reason: 'Unknown failure, retrying.',
      };
  }
}

/**
 * Get task failure count from the database.
 */
export function getTaskFailureCount(taskId: string): number {
  const result = getOne<{ fail_count: number }>(
    `SELECT COUNT(*) as fail_count FROM goal_log WHERE action = 'autopilot_run' AND success = 0 AND summary LIKE ?`,
    [`%${taskId}%`]
  );
  return result?.fail_count ?? 0;
}
