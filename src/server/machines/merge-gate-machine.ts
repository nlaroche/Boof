/**
 * Merge gate state machine — lifecycle of consolidation, review, and merge.
 *
 * Flow: pending → consolidating → reviewing → testing → approved → merging → merged
 *       With self-healing loops for failures and revision loops for review changes.
 */
import type { MachineDefinition } from '../engine/state-machine.js';

// ── Context ──

export interface MergeGateContext {
  mergeGateId: string;
  goalId: string;
  goalBranchName: string | null;
  targetBranch: string;
  repoPath: string;

  /** Task branches to consolidate */
  taskBranches: string[];

  /** Review state */
  reviewAgentId: string | null;
  reviewCycles: number;
  reviewVerdict: { score: number; verdict: 'approve' | 'changes_requested' | 'reject'; summary: string } | null;

  /** Healing state */
  healAttempts: number;
  healReason: string | null;

  /** Test results */
  testResults: { success: boolean; output: string; failures: string[] } | null;

  /** Consolidated diff for review */
  consolidatedDiff: string;

  /** Merge config */
  mergeStrategy: 'squash' | 'no-ff';
  maxReviewCycles: number;
  maxHealAttempts: number;
  minReviewScore: number;

  /** Audit */
  auditTrailId: string | null;

  /** Error info */
  error: string | null;
}

// ── States & Events ──

export type MergeGateState =
  | 'pending' | 'consolidating' | 'reviewing' | 'revising'
  | 'testing' | 'healing' | 'approved'
  | 'merging' | 'merged' | 'failed';

export type MergeGateEvent =
  | 'consolidate' | 'consolidated' | 'conflict'
  | 'approved' | 'changes_requested' | 'rejected'
  | 'revised'
  | 'tests_passed' | 'tests_failed'
  | 'healed' | 'unrecoverable'
  | 'merge' | 'merged' | 'merge_conflict'
  | 'abort' | 'error';

// ── Machine Definition ──

export function createMergeGateMachineDef(ctx: Partial<MergeGateContext> = {}): MachineDefinition<MergeGateState, MergeGateEvent, MergeGateContext> {
  return {
    id: 'merge-gate',
    initial: 'pending',
    context: {
      mergeGateId: '',
      goalId: '',
      goalBranchName: null,
      targetBranch: 'develop',
      repoPath: '',
      taskBranches: [],
      reviewAgentId: null,
      reviewCycles: 0,
      reviewVerdict: null,
      healAttempts: 0,
      healReason: null,
      testResults: null,
      consolidatedDiff: '',
      mergeStrategy: 'squash',
      maxReviewCycles: 3,
      maxHealAttempts: 2,
      minReviewScore: 70,
      auditTrailId: null,
      error: null,
      ...ctx,
    },
    states: {
      pending: {
        description: 'Goal has active tasks — not ready for review yet',
        meta: { skills: [], toolAccess: [], contextNeeded: ['goal-status'] },
      },
      consolidating: {
        description: 'Merging task branches into goal branch',
        invariant: (c) => c.taskBranches.length > 0,
        meta: { skills: ['git-operations'], toolAccess: ['git'], contextNeeded: ['task-branches'] },
      },
      reviewing: {
        description: 'Review agent analyzing consolidated diff',
        invariant: (c) => c.goalBranchName !== null,
        meta: { skills: ['code-review'], toolAccess: ['pty'], contextNeeded: ['consolidated-diff', 'review-config'] },
      },
      revising: {
        description: 'Implementation agent fixing review findings',
        invariant: (c) => c.reviewVerdict !== null && c.reviewVerdict.verdict === 'changes_requested',
        meta: { skills: ['code-editing'], toolAccess: ['pty', 'git'], contextNeeded: ['review-findings'] },
      },
      testing: {
        description: 'Running E2E / integration tests on goal branch',
        invariant: (c) => c.goalBranchName !== null,
        meta: { skills: ['build-tooling'], toolAccess: ['build'], contextNeeded: ['test-command'] },
      },
      healing: {
        description: 'Self-healing: fixing test failures or merge conflicts',
        meta: { skills: ['code-editing', 'git-operations'], toolAccess: ['pty', 'git'], contextNeeded: ['failure-context'] },
      },
      approved: {
        description: 'Review passed, tests passed — ready to merge',
        invariant: (c) => c.testResults !== null && c.testResults.success,
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
      merging: {
        description: 'Merging goal branch to target branch',
        invariant: (c) => c.goalBranchName !== null && c.targetBranch !== '',
        meta: { skills: ['git-branch-strategy'], toolAccess: ['git'], contextNeeded: ['merge-strategy'] },
      },
      merged: {
        description: 'Successfully merged to target branch',
        meta: { skills: [], toolAccess: [], contextNeeded: [] },
      },
      failed: {
        description: 'Unrecoverable failure — escalate to human',
        meta: { skills: [], toolAccess: [], contextNeeded: ['error'] },
      },
    },
    transitions: [
      // Pending → Consolidating
      { from: 'pending', event: 'consolidate', to: 'consolidating',
        reduce: (c, p) => ({ ...c, taskBranches: p?.branches ?? c.taskBranches }),
        description: 'Begin consolidation of task branches into goal branch' },

      // Consolidating outcomes
      { from: 'consolidating', event: 'consolidated', to: 'reviewing',
        reduce: (c, p) => ({ ...c, goalBranchName: p?.goalBranch ?? c.goalBranchName, consolidatedDiff: p?.diff ?? '' }),
        description: 'Consolidation complete, begin review' },
      { from: 'consolidating', event: 'conflict', to: 'healing',
        reduce: (c, p) => ({ ...c, healReason: p?.reason ?? 'merge conflict during consolidation' }),
        description: 'Merge conflict during consolidation, attempt self-heal' },

      // Review outcomes
      { from: 'reviewing', event: 'approved', to: 'testing',
        reduce: (c, p) => ({ ...c, reviewVerdict: p?.verdict ?? null, reviewCycles: c.reviewCycles + 1 }),
        description: 'Review approved, run E2E tests' },
      { from: 'reviewing', event: 'changes_requested', to: 'revising',
        guard: (c) => c.reviewCycles < c.maxReviewCycles,
        reduce: (c, p) => ({ ...c, reviewVerdict: p?.verdict ?? null, reviewCycles: c.reviewCycles + 1 }),
        description: 'Review requested changes, enter revision' },
      { from: 'reviewing', event: 'changes_requested', to: 'failed',
        guard: (c) => c.reviewCycles >= c.maxReviewCycles,
        reduce: (c) => ({ ...c, error: `Max review cycles (${c.maxReviewCycles}) exceeded` }),
        description: 'Review changes requested but max cycles exceeded' },
      { from: 'reviewing', event: 'rejected', to: 'failed',
        reduce: (c, p) => ({ ...c, reviewVerdict: p?.verdict ?? null, error: 'Review rejected' }),
        description: 'Review rejected — escalate to human' },

      // Revision → Re-review
      { from: 'revising', event: 'revised', to: 'reviewing',
        reduce: (c, p) => ({ ...c, consolidatedDiff: p?.diff ?? c.consolidatedDiff }),
        description: 'Revision complete, re-review' },

      // Test outcomes
      { from: 'testing', event: 'tests_passed', to: 'approved',
        reduce: (c, p) => ({ ...c, testResults: p?.results ?? { success: true, output: '', failures: [] } }),
        description: 'E2E tests passed, ready to merge' },
      { from: 'testing', event: 'tests_failed', to: 'healing',
        guard: (c) => c.healAttempts < c.maxHealAttempts,
        reduce: (c, p) => ({ ...c, testResults: p?.results ?? null, healReason: 'test failure' }),
        description: 'Tests failed, attempt self-heal' },
      { from: 'testing', event: 'tests_failed', to: 'failed',
        guard: (c) => c.healAttempts >= c.maxHealAttempts,
        reduce: (c, p) => ({ ...c, testResults: p?.results ?? null, error: 'Tests failed after max heal attempts' }),
        description: 'Tests failed after max heal attempts' },

      // Healing outcomes
      { from: 'healing', event: 'healed', to: 'testing',
        reduce: (c) => ({ ...c, healAttempts: c.healAttempts + 1, healReason: null }),
        description: 'Self-heal succeeded, re-run tests' },
      { from: 'healing', event: 'unrecoverable', to: 'failed',
        reduce: (c, p) => ({ ...c, error: p?.error ?? 'Unrecoverable failure during healing' }),
        description: 'Self-heal failed — escalate' },

      // Approved → Merging
      { from: 'approved', event: 'merge', to: 'merging',
        description: 'Begin merge to target branch' },

      // Merging outcomes
      { from: 'merging', event: 'merged', to: 'merged',
        description: 'Successfully merged to target branch' },
      { from: 'merging', event: 'merge_conflict', to: 'healing',
        guard: (c) => c.healAttempts < c.maxHealAttempts,
        reduce: (c) => ({ ...c, healReason: 'merge conflict with target branch' }),
        description: 'Merge conflict with target, attempt self-heal' },
      { from: 'merging', event: 'merge_conflict', to: 'failed',
        guard: (c) => c.healAttempts >= c.maxHealAttempts,
        reduce: (c) => ({ ...c, error: 'Merge conflict after max heal attempts' }),
        description: 'Merge conflict after max heal attempts' },

      // Global abort/error
      { from: ['pending', 'consolidating', 'reviewing', 'revising', 'testing', 'healing', 'approved', 'merging'],
        event: 'abort', to: 'failed',
        reduce: (c, p) => ({ ...c, error: p?.error ?? 'Aborted' }),
        description: 'Merge gate aborted' },
      { from: ['pending', 'consolidating', 'reviewing', 'revising', 'testing', 'healing', 'approved', 'merging'],
        event: 'error', to: 'failed',
        reduce: (c, p) => ({ ...c, error: p?.error ?? 'Unknown error' }),
        description: 'Unexpected error during merge gate' },
    ],
  };
}
