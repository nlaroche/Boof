/**
 * Goal state machine — lifecycle of a goal from active to completed.
 *
 * States: active ↔ paused, active → completed
 * Goals carry completion tracking context for scoring decisions.
 */
import type { MachineDefinition } from '../engine/state-machine.js';
import { GoalStatus } from '../engine/constants.js';

// ── Context ──

export interface GoalContext {
  goalId: string;
  name: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalRuns: number;
  lastRunAt: string | null;
}

// ── States & Events ──

export type GoalState = typeof GoalStatus[keyof typeof GoalStatus];
export type GoalEvent = 'pause' | 'resume' | 'complete' | 'reactivate' | 'task_completed' | 'task_failed' | 'run_finished';

// ── Machine Definition ──

export function createGoalMachineDef(ctx: Partial<GoalContext> = {}): MachineDefinition<GoalState, GoalEvent, GoalContext> {
  return {
    id: 'goal',
    initial: GoalStatus.ACTIVE,
    context: {
      goalId: '',
      name: '',
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      totalRuns: 0,
      lastRunAt: null,
      ...ctx,
    },
    states: {
      [GoalStatus.ACTIVE]: {
        description: 'Goal is being actively worked on',
        invariant: (c) => c.goalId !== '',
        meta: {
          skills: ['task-decomposition', 'code-analysis'],
          toolAccess: ['pty', 'filesystem', 'git'],
          contextNeeded: ['goal-description', 'repo-context', 'task-list'],
          usesScoring: true,
        },
      },
      [GoalStatus.PAUSED]: {
        description: 'Goal is paused by user, no work will be scheduled',
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
      [GoalStatus.COMPLETED]: {
        description: 'All tasks for this goal are done',
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
    },
    transitions: [
      {
        from: GoalStatus.ACTIVE,
        event: 'pause',
        to: GoalStatus.PAUSED,
        description: 'User pauses goal',
      },
      {
        from: GoalStatus.PAUSED,
        event: 'resume',
        to: GoalStatus.ACTIVE,
        description: 'User resumes goal',
      },
      {
        from: GoalStatus.ACTIVE,
        event: 'complete',
        to: GoalStatus.COMPLETED,
        description: 'All tasks done, goal achieved',
      },
      {
        from: GoalStatus.COMPLETED,
        event: 'reactivate',
        to: GoalStatus.ACTIVE,
        description: 'Reopen a completed goal (new tasks added or rework needed)',
      },
      // Context-only transitions (stay in same state but update context)
      {
        from: GoalStatus.ACTIVE,
        event: 'task_completed',
        to: GoalStatus.ACTIVE,
        reduce: (c) => ({ ...c, completedTasks: c.completedTasks + 1 }),
        description: 'A task within this goal was completed',
      },
      {
        from: GoalStatus.ACTIVE,
        event: 'task_failed',
        to: GoalStatus.ACTIVE,
        reduce: (c) => ({ ...c, failedTasks: c.failedTasks + 1 }),
        description: 'A task within this goal failed',
      },
      {
        from: GoalStatus.ACTIVE,
        event: 'run_finished',
        to: GoalStatus.ACTIVE,
        reduce: (c, p) => ({ ...c, totalRuns: c.totalRuns + 1, lastRunAt: p?.timestamp ?? null }),
        description: 'An autopilot run targeting this goal finished',
      },
    ],
  };
}
