/**
 * Autopilot run state machine — lifecycle of a single autopilot execution.
 *
 * This replaces the 600-line triggerAutopilotRun() function with a
 * data-driven state machine. Each state carries context and a prompt
 * template for the current phase.
 *
 * Flow: init → preflight → planning → selecting → implementing →
 *       building → testing → committing → merging → reflecting → cycling → done
 */
import type { MachineDefinition } from '../engine/state-machine.js';
import type { ScoreBreakdown } from '../engine/scoring.js';

// ── Context ──

export interface AutopilotContext {
  agentId: string;
  goalId: string;
  goalName: string;
  goalSlug: string;
  branchName: string | null;
  worktreePath: string;
  mainRepoDir: string;

  /** Current task (selected by scoring) */
  currentTask: { id: string; title: string; description: string } | null;
  taskScoreBreakdown: ScoreBreakdown<any> | null;

  /** Run state */
  preflightPassed: boolean;
  planningOutput: string;
  implementationOutput: string;
  buildOutput: string;
  testOutput: string;
  diffStats: string;
  commitHash: string | null;

  /** Per-phase timing */
  phaseTimings: Record<string, number>;
  phaseStartedAt: number | null;

  /** Token tracking */
  tokens: { prompt: number; completion: number; total: number };

  /** Retry tracking */
  buildRetries: number;
  testRetries: number;

  /** Error info */
  error: string | null;
}

// ── States & Events ──

export type AutopilotState =
  | 'init' | 'preflight' | 'planning' | 'selecting'
  | 'implementing' | 'building' | 'testing'
  | 'committing' | 'merging' | 'reflecting' | 'cycling'
  | 'done' | 'failed';

export type AutopilotEvent =
  | 'start' | 'preflight_pass' | 'preflight_fail'
  | 'plan_done' | 'task_selected' | 'no_tasks'
  | 'impl_done' | 'build_pass' | 'build_fail'
  | 'test_pass' | 'test_fail'
  | 'committed' | 'merged' | 'merge_skip'
  | 'reflected' | 'cycle_done'
  | 'abort' | 'error';

// ── Helpers ──

function recordPhaseStart(c: AutopilotContext): AutopilotContext {
  return { ...c, phaseStartedAt: Date.now() };
}

function recordPhaseTiming(c: AutopilotContext, phase: string): AutopilotContext {
  if (c.phaseStartedAt === null) return c;
  return {
    ...c,
    phaseTimings: { ...c.phaseTimings, [phase]: Date.now() - c.phaseStartedAt },
    phaseStartedAt: null,
  };
}

// ── Machine Definition ──

export function createAutopilotMachineDef(ctx: Partial<AutopilotContext> = {}): MachineDefinition<AutopilotState, AutopilotEvent, AutopilotContext> {
  return {
    id: 'autopilot-run',
    initial: 'init',
    context: {
      agentId: '',
      goalId: '',
      goalName: '',
      goalSlug: '',
      branchName: null,
      worktreePath: '',
      mainRepoDir: '',
      currentTask: null,
      taskScoreBreakdown: null,
      preflightPassed: false,
      planningOutput: '',
      implementationOutput: '',
      buildOutput: '',
      testOutput: '',
      diffStats: '',
      commitHash: null,
      phaseTimings: {},
      phaseStartedAt: null,
      tokens: { prompt: 0, completion: 0, total: 0 },
      buildRetries: 0,
      testRetries: 0,
      error: null,
      ...ctx,
    },
    states: {
      init: {
        description: 'Initializing autopilot run — validating agent and goal',
        onEnter: recordPhaseStart,
        meta: { skills: [], toolAccess: [], contextNeeded: ['agent-config', 'goal-description'] },
      },
      preflight: {
        description: 'Running pre-flight test check to ensure clean baseline',
        invariant: (c) => c.goalId !== '',
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'init')),
        meta: { skills: ['build-tooling'], toolAccess: ['build'], contextNeeded: ['working-directory'] },
      },
      planning: {
        description: 'Generating or reviewing tasks for goal via LLM',
        invariant: (c) => c.preflightPassed === true,
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'preflight')),
        meta: {
          skills: ['task-decomposition', 'code-analysis'],
          toolAccess: ['pty'],
          contextNeeded: ['goal-description', 'repo-context', 'existing-tasks'],
        },
      },
      selecting: {
        description: 'Scoring and selecting the best task to work on',
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'planning')),
        meta: {
          usesScoring: true,
          skills: ['task-prioritization'],
          toolAccess: [],
          contextNeeded: ['task-list', 'agent-skills', 'goal-priority'],
        },
      },
      implementing: {
        description: 'Agent is implementing the selected task',
        invariant: (c) => c.currentTask !== null,
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'selecting')),
        meta: {
          skills: ['code-editing', 'build-tooling'],
          toolAccess: ['pty', 'filesystem', 'git'],
          contextNeeded: ['task-description', 'repo-context', 'working-directory'],
        },
      },
      building: {
        description: 'Running build check on implemented changes',
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'implementing')),
        meta: { skills: ['build-tooling'], toolAccess: ['build'], contextNeeded: ['working-directory'] },
      },
      testing: {
        description: 'Running test suite to verify changes',
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'building')),
        meta: { skills: ['build-tooling'], toolAccess: ['build'], contextNeeded: ['working-directory'] },
      },
      committing: {
        description: 'Auto-committing verified changes',
        invariant: (c) => c.branchName !== null,
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'testing')),
        meta: { skills: ['git-operations'], toolAccess: ['git'], contextNeeded: ['diff-stats', 'branch-name'] },
      },
      merging: {
        description: 'Merging branch to main',
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'committing')),
        meta: { skills: ['git-branch-strategy'], toolAccess: ['git'], contextNeeded: ['branch-name', 'main-repo-dir'] },
      },
      reflecting: {
        description: 'Post-run reflection — extracting lessons and skills',
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'merging')),
        meta: { skills: ['self-assessment'], toolAccess: ['pty'], contextNeeded: ['run-output', 'phase-timings'] },
      },
      cycling: {
        description: 'Deciding whether to rotate to a different goal',
        onEnter: (c) => recordPhaseStart(recordPhaseTiming(c, 'reflecting')),
        meta: { usesScoring: true, skills: ['task-prioritization'], toolAccess: [], contextNeeded: ['goal-list'] },
      },
      done: {
        description: 'Autopilot run completed successfully',
        onEnter: (c) => recordPhaseTiming(c, 'cycling'),
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
      failed: {
        description: 'Autopilot run failed',
        onEnter: (c) => {
          const phase = Object.keys(c.phaseTimings).length > 0
            ? Object.keys(c.phaseTimings).pop()!
            : 'init';
          return recordPhaseTiming(c, phase);
        },
        meta: { skills: [], toolAccess: [], contextNeeded: ['error'] },
      },
    },
    transitions: [
      // Init → Preflight
      { from: 'init', event: 'start', to: 'preflight',
        description: 'Begin autopilot run with pre-flight check' },

      // Preflight outcomes
      { from: 'preflight', event: 'preflight_pass', to: 'planning',
        reduce: (c) => ({ ...c, preflightPassed: true }),
        description: 'Pre-flight tests passed, proceed to planning' },
      { from: 'preflight', event: 'preflight_fail', to: 'failed',
        reduce: (c, p) => ({ ...c, preflightPassed: false, error: p?.error ?? 'Pre-flight failed' }),
        description: 'Pre-flight tests failed, abort run' },

      // Planning → Selecting
      { from: 'planning', event: 'plan_done', to: 'selecting',
        reduce: (c, p) => ({ ...c, planningOutput: p?.output ?? '' }),
        description: 'Planning complete, select task' },

      // Selecting outcomes
      { from: 'selecting', event: 'task_selected', to: 'implementing',
        reduce: (c, p) => ({ ...c, currentTask: p?.task ?? null, taskScoreBreakdown: p?.breakdown ?? null }),
        description: 'Task selected, begin implementation' },
      { from: 'selecting', event: 'no_tasks', to: 'done',
        description: 'No actionable tasks found, goal may be complete' },

      // Implementation → Build
      { from: 'implementing', event: 'impl_done', to: 'building',
        reduce: (c, p) => ({ ...c, implementationOutput: p?.output ?? '' }),
        description: 'Implementation complete, run build' },

      // Build outcomes
      { from: 'building', event: 'build_pass', to: 'testing',
        description: 'Build passed, run tests' },
      { from: 'building', event: 'build_fail', to: 'implementing',
        guard: (c) => c.buildRetries < 2,
        reduce: (c, p) => ({ ...c, buildRetries: c.buildRetries + 1, buildOutput: p?.output ?? '' }),
        description: 'Build failed, retry implementation with error context' },
      { from: 'building', event: 'build_fail', to: 'failed',
        guard: (c) => c.buildRetries >= 2,
        reduce: (c, p) => ({ ...c, error: p?.output ?? 'Build failed after retries' }),
        description: 'Build failed after max retries' },

      // Test outcomes
      { from: 'testing', event: 'test_pass', to: 'committing',
        description: 'Tests passed, commit changes' },
      { from: 'testing', event: 'test_fail', to: 'implementing',
        guard: (c) => c.testRetries < 2,
        reduce: (c, p) => ({ ...c, testRetries: c.testRetries + 1, testOutput: p?.output ?? '' }),
        description: 'Tests failed, retry implementation with error context' },
      { from: 'testing', event: 'test_fail', to: 'failed',
        guard: (c) => c.testRetries >= 2,
        reduce: (c, p) => ({ ...c, error: p?.output ?? 'Tests failed after retries' }),
        description: 'Tests failed after max retries' },

      // Commit → Merge → Reflect → Cycle → Done
      { from: 'committing', event: 'committed', to: 'merging',
        reduce: (c, p) => ({ ...c, commitHash: p?.hash ?? null }),
        description: 'Changes committed' },
      { from: 'merging', event: 'merged', to: 'reflecting',
        description: 'Branch merged to main' },
      { from: 'merging', event: 'merge_skip', to: 'reflecting',
        description: 'Merge skipped (no branch or already on main)' },
      { from: 'reflecting', event: 'reflected', to: 'cycling',
        description: 'Reflection complete' },
      { from: 'cycling', event: 'cycle_done', to: 'done',
        description: 'Goal cycling decision made, run complete' },

      // Global abort/error (from any active state)
      { from: ['init', 'preflight', 'planning', 'selecting', 'implementing', 'building', 'testing', 'committing', 'merging', 'reflecting', 'cycling'],
        event: 'abort', to: 'failed',
        reduce: (c, p) => ({ ...c, error: p?.error ?? 'Aborted' }),
        description: 'Run aborted (user cancel, timeout, etc.)' },
      { from: ['init', 'preflight', 'planning', 'selecting', 'implementing', 'building', 'testing', 'committing', 'merging', 'reflecting', 'cycling'],
        event: 'error', to: 'failed',
        reduce: (c, p) => ({ ...c, error: p?.error ?? 'Unknown error' }),
        description: 'Unexpected error during run' },
    ],
  };
}
