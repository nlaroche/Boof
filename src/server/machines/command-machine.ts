/**
 * Command state machine — lifecycle of a single command execution.
 *
 * Tracks the retry → review → commit flow that currently lives
 * as nested callbacks in ws-handler.ts handleExit.
 */
import type { MachineDefinition } from '../engine/state-machine.js';
import { CommandStatus, Limits } from '../engine/constants.js';

// ── Context ──

export interface CommandContext {
  commandId: string;
  agentId: string;
  prompt: string;
  taskId: string | null;
  retryCount: number;
  maxRetries: number;
  rawOutput: string;
  diffStats: string;
  hasDiff: boolean;
  reviewed: boolean;
  succeeded: boolean;
  startedAt: string;
  finishedAt: string | null;
  filesChanged: string[];
  exitCode: number | null;
}

// ── States & Events ──

export type CommandState = 'running' | 'checking' | 'retrying' | 'reviewing' | 'committing' | 'done' | 'failed';
export type CommandEvent = 'exit' | 'needs_retry' | 'retry_sent' | 'needs_review' | 'review_sent' | 'commit' | 'committed' | 'no_changes' | 'exhausted';

// ── Machine Definition ──

export function createCommandMachineDef(ctx: Partial<CommandContext> = {}): MachineDefinition<CommandState, CommandEvent, CommandContext> {
  return {
    id: 'command',
    initial: 'running',
    context: {
      commandId: '',
      agentId: '',
      prompt: '',
      taskId: null,
      retryCount: 0,
      maxRetries: Limits.MAX_RETRIES,
      rawOutput: '',
      diffStats: '',
      hasDiff: false,
      reviewed: false,
      succeeded: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      filesChanged: [],
      exitCode: null,
      ...ctx,
    },
    states: {
      running: {
        description: 'Command is executing in PTY',
        invariant: (c) => c.commandId !== '' && c.startedAt !== '',
        meta: {
          skills: ['code-editing', 'build-tooling'],
          toolAccess: ['pty', 'filesystem', 'git'],
          contextNeeded: ['task-description', 'repo-context'],
        },
      },
      checking: {
        description: 'Checking output for errors, no-op, or test failures',
        prompt: 'Analyzing command output for success indicators',
        meta: {
          skills: ['error-diagnosis', 'output-analysis'],
          toolAccess: ['git'],
          contextNeeded: ['raw-output', 'exit-code'],
        },
      },
      retrying: {
        description: 'Retrying after failure — sending fix prompt to agent',
        invariant: (c) => c.retryCount <= c.maxRetries,
        prompt: (c) => `Retry ${c.retryCount}/${c.maxRetries}: fixing errors from previous attempt`,
        meta: {
          retryable: true,
          skills: ['error-diagnosis', 'code-editing'],
          toolAccess: ['pty', 'filesystem'],
          contextNeeded: ['error-output', 'original-prompt'],
        },
      },
      reviewing: {
        description: 'Self-reviewing changes for quality before commit',
        invariant: (c) => c.hasDiff === true,
        prompt: (c) => `Review changes for task: "${c.prompt.slice(0, 100)}"`,
        meta: {
          skills: ['code-review'],
          toolAccess: ['git'],
          contextNeeded: ['diff-stats', 'diff-content', 'task-description'],
        },
      },
      committing: {
        description: 'Auto-committing successful changes',
        invariant: (c) => c.succeeded === true,
        meta: {
          skills: ['git-operations'],
          toolAccess: ['git', 'filesystem'],
          contextNeeded: ['diff-stats', 'prompt'],
        },
      },
      done: {
        description: 'Command completed (success)',
        onEnter: (c) => ({ ...c, finishedAt: c.finishedAt || new Date().toISOString() }),
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
      failed: {
        description: 'Command failed after all retries or no changes made',
        onEnter: (c) => ({ ...c, finishedAt: c.finishedAt || new Date().toISOString(), succeeded: false }),
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
    },
    transitions: [
      {
        from: 'running',
        event: 'exit',
        to: 'checking',
        reduce: (c, p) => ({ ...c, exitCode: p?.exitCode ?? null, rawOutput: p?.rawOutput ?? c.rawOutput }),
        description: 'PTY process exited, check output',
      },
      {
        from: 'checking',
        event: 'needs_retry',
        to: 'retrying',
        guard: (c) => c.retryCount < c.maxRetries,
        reduce: (c) => ({ ...c, retryCount: c.retryCount + 1 }),
        description: 'Output indicates failure, retry if attempts remain',
      },
      {
        from: 'retrying',
        event: 'retry_sent',
        to: 'running',
        description: 'Fix prompt sent to agent, back to running state',
      },
      {
        from: 'checking',
        event: 'needs_review',
        to: 'reviewing',
        reduce: (c, p) => ({ ...c, hasDiff: true, diffStats: p?.diffStats ?? '', succeeded: true }),
        description: 'Changes detected, initiate self-review',
      },
      {
        from: 'reviewing',
        event: 'review_sent',
        to: 'running',
        reduce: (c) => ({ ...c, reviewed: true }),
        description: 'Review prompt sent to agent',
      },
      {
        from: 'checking',
        event: 'commit',
        to: 'committing',
        reduce: (c, p) => ({ ...c, succeeded: true, diffStats: p?.diffStats ?? '', filesChanged: p?.filesChanged ?? [] }),
        description: 'Changes look good (or review complete), proceed to commit',
      },
      {
        from: 'committing',
        event: 'committed',
        to: 'done',
        description: 'Changes committed successfully',
      },
      {
        from: 'checking',
        event: 'no_changes',
        to: 'failed',
        reduce: (c) => ({ ...c, succeeded: false }),
        description: 'No changes made — agent did not edit any files',
      },
      {
        from: 'checking',
        event: 'exhausted',
        to: 'failed',
        guard: (c) => c.retryCount >= c.maxRetries,
        reduce: (c) => ({ ...c, succeeded: false }),
        description: 'All retries exhausted, command failed',
      },
      // Direct success path (no diff, no review needed)
      {
        from: 'committing',
        event: 'no_changes',
        to: 'done',
        description: 'Commit step found nothing to commit but task succeeded',
      },
    ],
  };
}
