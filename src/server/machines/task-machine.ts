/**
 * Task state machine — lifecycle of a task from creation to archival.
 *
 * States: todo → in_progress → done → archived
 * Also: in_progress can fail back to todo, done/archived can reopen to todo.
 */
import type { MachineDefinition } from '../engine/state-machine.js';
import { TaskStatus } from '../engine/constants.js';

// ── Context ──

export interface TaskContext {
  taskId: string;
  goalId: string | null;
  title: string;
  description: string;
  failureCount: number;
  assignedAgentId: string | null;
}

// ── States & Events ──

export type TaskState = typeof TaskStatus[keyof typeof TaskStatus];
export type TaskEvent = 'start' | 'complete' | 'fail' | 'archive' | 'reopen';

// ── Machine Definition ──

export function createTaskMachineDef(ctx: Partial<TaskContext> = {}): MachineDefinition<TaskState, TaskEvent, TaskContext> {
  return {
    id: 'task',
    initial: TaskStatus.TODO,
    context: {
      taskId: '',
      goalId: null,
      title: '',
      description: '',
      failureCount: 0,
      assignedAgentId: null,
      ...ctx,
    },
    states: {
      [TaskStatus.TODO]: {
        description: 'Task not yet started, available for assignment',
        invariant: (c) => c.assignedAgentId === null,
        onEnter: (c) => ({ ...c, assignedAgentId: null }),
        meta: { skills: [], toolAccess: [], contextNeeded: ['goal-context'] },
      },
      [TaskStatus.IN_PROGRESS]: {
        description: 'Task is being worked on by an agent',
        invariant: (c) => c.assignedAgentId !== null,
        meta: {
          skills: ['code-editing'],
          toolAccess: ['pty', 'filesystem'],
          contextNeeded: ['task-description', 'goal-context', 'repo-context'],
        },
      },
      [TaskStatus.DONE]: {
        description: 'Task completed successfully',
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
      [TaskStatus.ARCHIVED]: {
        description: 'Task archived (no longer relevant)',
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
    },
    transitions: [
      {
        from: TaskStatus.TODO,
        event: 'start',
        to: TaskStatus.IN_PROGRESS,
        reduce: (c, p) => ({ ...c, assignedAgentId: p?.agentId ?? c.assignedAgentId }),
        description: 'Agent begins working on this task',
      },
      {
        from: TaskStatus.IN_PROGRESS,
        event: 'complete',
        to: TaskStatus.DONE,
        description: 'Task completed successfully',
      },
      {
        from: TaskStatus.IN_PROGRESS,
        event: 'fail',
        to: TaskStatus.TODO,
        reduce: (c) => ({ ...c, failureCount: c.failureCount + 1, assignedAgentId: null }),
        description: 'Task failed, return to backlog with incremented failure count',
      },
      {
        from: TaskStatus.DONE,
        event: 'archive',
        to: TaskStatus.ARCHIVED,
        description: 'Archive completed task',
      },
      {
        from: [TaskStatus.DONE, TaskStatus.ARCHIVED],
        event: 'reopen',
        to: TaskStatus.TODO,
        reduce: (c) => ({ ...c, assignedAgentId: null }),
        description: 'Reopen task for rework',
      },
    ],
  };
}
