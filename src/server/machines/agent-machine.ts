/**
 * Agent state machine — lifecycle of an agent process.
 *
 * States: idle → running → idle/error/dead
 * Error/dead can restart back to running (with retry guard).
 */
import type { MachineDefinition } from '../engine/state-machine.js';
import { AgentStatus, Limits } from '../engine/constants.js';

// ── Context ──

export interface AgentContext {
  agentId: string;
  name: string;
  workingDirectory: string;
  worktreePath: string | null;
  agentType: string;
  retries: number;
  lastError: string | null;
  startedAt: string | null;
  commandId: string | null;
  goalId: string | null;
}

// ── States & Events ──

export type AgentState = typeof AgentStatus[keyof typeof AgentStatus];
export type AgentEvent = 'start' | 'complete' | 'fail' | 'kill' | 'restart';

// ── Machine Definition ──

export function createAgentMachineDef(ctx: Partial<AgentContext> = {}): MachineDefinition<AgentState, AgentEvent, AgentContext> {
  return {
    id: 'agent',
    initial: AgentStatus.IDLE,
    context: {
      agentId: '',
      name: '',
      workingDirectory: '',
      worktreePath: null,
      agentType: 'minimax',
      retries: 0,
      lastError: null,
      startedAt: null,
      commandId: null,
      goalId: null,
      ...ctx,
    },
    states: {
      [AgentStatus.IDLE]: {
        description: 'Agent is idle, waiting for work',
        invariant: (c) => c.commandId === null,
        onEnter: (c) => ({ ...c, retries: 0, lastError: null, startedAt: null, commandId: null }),
      },
      [AgentStatus.RUNNING]: {
        description: 'Agent is executing a command',
        invariant: (c) => c.startedAt !== null && c.agentId !== '',
        onEnter: (c) => ({ ...c, startedAt: c.startedAt || new Date().toISOString() }),
      },
      [AgentStatus.ERROR]: {
        description: 'Agent hit an error, may retry',
        invariant: (c) => c.lastError !== null,
        meta: { retryable: true },
      },
      [AgentStatus.DEAD]: {
        description: 'Agent process was killed or crashed',
        meta: { retryable: true, requiresNewPty: true },
      },
    },
    transitions: [
      {
        from: AgentStatus.IDLE,
        event: 'start',
        to: AgentStatus.RUNNING,
        reduce: (c, p) => ({ ...c, commandId: p?.commandId ?? null }),
        description: 'Begin executing a command',
      },
      {
        from: AgentStatus.RUNNING,
        event: 'complete',
        to: AgentStatus.IDLE,
        description: 'Command finished successfully',
      },
      {
        from: AgentStatus.RUNNING,
        event: 'fail',
        to: AgentStatus.ERROR,
        reduce: (c, p) => ({ ...c, lastError: p?.error ?? 'Unknown error', retries: c.retries + 1 }),
        description: 'Command failed',
      },
      {
        from: AgentStatus.RUNNING,
        event: 'kill',
        to: AgentStatus.DEAD,
        description: 'Process forcibly killed',
      },
      {
        from: [AgentStatus.ERROR, AgentStatus.DEAD],
        event: 'restart',
        to: AgentStatus.RUNNING,
        guard: (c) => c.retries < Limits.MAX_RETRIES,
        reduce: (c, p) => ({ ...c, commandId: p?.commandId ?? null }),
        description: 'Restart agent (if retries remain)',
      },
    ],
  };
}
