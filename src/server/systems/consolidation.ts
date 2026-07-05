/**
 * Consolidation system — orchestrates the merge gate lifecycle.
 *
 * This is the main entry point for the review & merge layer.
 * It coordinates: consolidation → review → revision → testing → healing → merge.
 *
 * Triggers:
 * 1. Automatic: when all tasks for a goal reach 'done' status
 * 2. Time-based: after N hours of active work (configurable)
 * 3. Manual: user triggers from the UI
 */
import { StateMachine } from '../engine/state-machine.js';
import { createMergeGateMachineDef } from '../machines/merge-gate-machine.js';
import type { MergeGateState, MergeGateEvent, MergeGateContext } from '../machines/merge-gate-machine.js';
import {
  createMergeGate, getMergeGate, getMergeGateForGoal, updateMergeGate,
  getAll, getOne, getNow,
} from '../db-helpers.js';
import {
  createGoalBranch, mergeToGoalBranch, mergeGoalToTarget,
  getConsolidatedDiff, getGoalBranchFiles, listAgentBranches, getDefaultBranch,
  createWorktree, removeWorktree,
} from './git-ops.js';
import { execFileSync } from 'child_process';
import { Timeouts } from '../engine/constants.js';
import {
  getOrDiscoverReviewConfig, buildReviewPrompt, parseReviewOutput,
  storeReviewFindings,
} from './review-agent.js';
import { appendAuditRecord } from './audit-trail.js';
import { AuditActionType, AuditOutcome } from '../engine/constants.js';
import { createAgent, sendToAgent, hasAgent, killAgent } from '../pty-manager.js';
import { getModelForRole } from '../agent-providers.js';
import { AgentRole } from '../engine/constants.js';
import { getBroadcast } from '../ws-handler.js';
import type { Goal, Task, MergeGate } from '../../client/lib/types.js';

/**
 * Fire a user-facing notification (budget/failure alerts). Uses the global
 * broadcast (same pattern as maintenance.ts) rather than the gate-typed
 * broadcast callback, so it works from any code path.
 */
function notifyFailure(title: string, body: string): void {
  try {
    const broadcast = getBroadcast();
    if (broadcast) broadcast({ type: 'notify', agentId: 'system', title, body } as any);
  } catch (e: any) {
    console.error(`[consolidation] notify failed: ${e.message || e}`);
  }
}

// Active merge gate state machines
const activeMergeGates = new Map<string, StateMachine<MergeGateState, MergeGateEvent, MergeGateContext>>();

/**
 * Get or create the merge gate state machine for a given merge gate.
 *
 * C2-persistence: machines are in-memory only. After a restart (or first access
 * from a non-initiating code path) we rebuild the machine from the gate's
 * persisted DB status so FSM guards (max review cycles / heal attempts) keep
 * applying instead of silently resetting to `pending`.
 */
function getMergeGateMachine(mergeGateId: string, ctx?: Partial<MergeGateContext>) {
  let machine = activeMergeGates.get(mergeGateId);
  if (!machine) {
    const def = createMergeGateMachineDef(ctx);
    machine = new StateMachine<MergeGateState, MergeGateEvent, MergeGateContext>(def);

    // Restore persisted state so guards survive restarts. MergeGate.status and
    // MergeGateState share the same string values, so the mapping is identity.
    const gate = getMergeGate(mergeGateId);
    if (gate && gate.status && gate.status !== 'pending') {
      machine.restore({
        machineId: def.id,
        state: gate.status as MergeGateState,
        context: {
          ...machine.context,
          ...ctx,
          mergeGateId,
          goalId: gate.goal_id,
          goalBranchName: gate.goal_branch,
          targetBranch: gate.target_branch,
          repoPath: gate.repo_path,
          reviewCycles: gate.review_cycles,
          healAttempts: gate.heal_attempts,
          reviewAgentId: gate.review_agent_id,
        },
        timestamp: new Date().toISOString(),
      });
    }

    activeMergeGates.set(mergeGateId, machine);
  }
  return machine;
}

/**
 * Fail a merge gate loudly: drive the FSM to `failed`, audit, persist status,
 * and notify. Used everywhere a safety check fails so gates never wedge or
 * silently pass (C2/C3). The failure reason is persisted in `test_results`
 * (no dedicated failure_reason column exists in the schema).
 */
function failGate(
  mergeGateId: string,
  reason: string,
  broadcast: (gate: MergeGate) => void,
  actionType: string = AuditActionType.ERROR,
): void {
  const gate = getMergeGate(mergeGateId);
  if (!gate) return;

  const machine = getMergeGateMachine(mergeGateId);
  if (machine.state !== 'failed' && machine.state !== 'merged') {
    const moved = machine.send('abort', { error: reason });
    if (!moved) {
      console.error(`[consolidation] failGate: FSM rejected 'abort' from state '${machine.state}' for gate ${mergeGateId}`);
    }
  }

  appendAuditRecord({
    agentId: 'system',
    mergeGateId,
    goalId: gate.goal_id,
    actionType: actionType as any,
    actionDetail: { reason },
    outcome: AuditOutcome.FAILURE,
  });

  updateMergeGate(mergeGateId, { status: 'failed', test_results: JSON.stringify({ failureReason: reason }) }, broadcast);
  notifyFailure('Merge gate failed', reason);
}

/**
 * Initiate consolidation for a goal.
 * Called when all tasks are done or triggered manually.
 */
export async function initiateConsolidation(
  goalId: string,
  repoPath: string,
  broadcast: (gate: MergeGate) => void,
): Promise<MergeGate | null> {
  const startTime = Date.now();

  // Check if there's already an active merge gate for this goal
  const existing = getMergeGateForGoal(goalId);
  if (existing && !['merged', 'failed'].includes(existing.status)) {
    console.log(`[consolidation] Merge gate already active for goal ${goalId}: ${existing.id} (${existing.status})`);
    return existing;
  }

  // Get the goal
  const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [goalId]);
  if (!goal) {
    console.error(`[consolidation] Goal not found: ${goalId}`);
    return null;
  }

  // Get or discover review config
  const config = getOrDiscoverReviewConfig(repoPath);
  const targetBranch = goal.merge_target || config?.target_branch || getDefaultBranch(repoPath);

  // Find completed task branches
  const goalSlug = goal.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const allBranches = await listAgentBranches(repoPath);
  const taskBranches = allBranches.filter(b => b.includes(goalSlug));

  if (taskBranches.length === 0) {
    console.log(`[consolidation] No task branches found for goal ${goalId} (slug: ${goalSlug})`);
    return null;
  }

  // Create goal branch
  const goalBranch = await createGoalBranch(repoPath, goalSlug, targetBranch);

  // Create merge gate record
  const gate = createMergeGate({
    goalId,
    repoPath,
    goalBranch,
    targetBranch,
    mergeStrategy: config?.merge_strategy || 'squash',
  }, broadcast);

  if (!gate) {
    console.error(`[consolidation] Failed to create merge gate for goal ${goalId}`);
    return null;
  }

  // Initialize state machine
  const machine = getMergeGateMachine(gate.id, {
    mergeGateId: gate.id,
    goalId,
    goalBranchName: goalBranch,
    targetBranch,
    repoPath,
    taskBranches,
    mergeStrategy: (config?.merge_strategy || 'squash') as 'squash' | 'no-ff',
    maxReviewCycles: config?.max_review_cycles ?? 3,
    maxHealAttempts: config?.max_heal_attempts ?? 2,
    minReviewScore: config?.min_review_score ?? 70,
  });

  // Start consolidation
  machine.send('consolidate', { branches: taskBranches });
  updateMergeGate(gate.id, { status: 'consolidating' }, broadcast);

  // Merge each task branch into goal branch.
  // mergeToGoalBranch attempts self-heal on conflict internally (C4); a false
  // result means the branch could NOT be consolidated (heal failed and the merge
  // was aborted). We must fail the gate loudly rather than proceed without the
  // branch's commits.
  let consolidationSuccess = true;
  let consolidationOutput = '';
  let failedBranch: string | null = null;

  for (const branch of taskBranches) {
    const result = await mergeToGoalBranch(repoPath, branch, goalBranch);
    consolidationOutput += `${branch}: ${result.success ? 'OK' : 'FAILED'}\n${result.output}\n`;

    if (!result.success) {
      consolidationSuccess = false;
      failedBranch = branch;
      break;
    }
  }

  const durationMs = Date.now() - startTime;

  if (consolidationSuccess) {
    // Get consolidated diff
    const diff = await getConsolidatedDiff(repoPath, goalBranch, targetBranch);
    machine.send('consolidated', { goalBranch, diff });
    updateMergeGate(gate.id, {
      status: 'reviewing',
      consolidated_diff: diff,
    }, broadcast);

    appendAuditRecord({
      agentId: 'system',
      mergeGateId: gate.id,
      goalId,
      actionType: AuditActionType.CONSOLIDATE,
      actionDetail: {
        taskBranches,
        goalBranch,
        branchCount: taskBranches.length,
      },
      outcome: AuditOutcome.SUCCESS,
      durationMs,
    });

    // Kick off the review agent asynchronously
    executeReviewAgent(gate.id, goalId, repoPath, goalBranch, targetBranch, diff, broadcast)
      .catch(err => console.error(`[consolidation] Review execution error:`, err));
  } else {
    // Consolidation failed and could not be auto-healed. Fail the gate loudly —
    // never park it in `healing` (nothing drives that state → permanent wedge).
    const failureReason = `Consolidation failed: could not merge task branch "${failedBranch}" into ${goalBranch} (merge conflict not auto-resolvable). Resolve manually or retry.`;
    console.error(`[consolidation] ${failureReason}`);

    machine.send('conflict', { reason: failureReason });
    // `conflict` lands in `healing`, which has no runtime driver — force to failed.
    if (machine.state === 'healing') {
      machine.send('unrecoverable', { error: failureReason });
    }

    appendAuditRecord({
      agentId: 'system',
      mergeGateId: gate.id,
      goalId,
      actionType: AuditActionType.CONSOLIDATE,
      actionDetail: {
        taskBranches,
        goalBranch,
        failedBranch,
        output: consolidationOutput,
      },
      outcome: AuditOutcome.FAILURE,
      durationMs,
    });

    updateMergeGate(gate.id, { status: 'failed', test_results: JSON.stringify({ failureReason }) }, broadcast);
    notifyFailure('Merge gate failed', failureReason);
  }

  return getMergeGate(gate.id);
}

/**
 * Process review results for a merge gate.
 * Called after the review agent completes its analysis.
 */
/**
 * Prepare an isolated, disposable worktree for the review agent, checked out
 * (detached) at the goal branch's tip. The review agent runs with
 * `--dangerously-skip-permissions`, so it must NOT run in the user's shared
 * working tree (Task 3). Returns the worktree path, or null to signal the
 * caller should fall back to the shared repo (review still runs, just not
 * isolated) rather than skip review entirely.
 */
function prepareReviewerWorktree(repoPath: string, goalBranch: string, mergeGateId: string): string | null {
  try {
    const worktreePath = createWorktree(repoPath, 'reviewer', mergeGateId);
    if (!worktreePath) return null;
    // Point the detached worktree at the goal branch's state to be reviewed.
    execFileSync('git', ['-C', worktreePath, 'checkout', '--detach', goalBranch], {
      timeout: Timeouts.GIT_CHECKOUT,
    });
    return worktreePath;
  } catch (err: any) {
    console.error(`[consolidation] Failed to prepare reviewer worktree: ${err.message || err}`);
    return null;
  }
}

/**
 * Spawn a review agent to analyze the consolidated diff.
 * Uses a temporary agent with the review prompt built from
 * approved guidelines. Parses the output and calls processReviewResults.
 */
async function executeReviewAgent(
  mergeGateId: string,
  goalId: string,
  repoPath: string,
  goalBranch: string,
  targetBranch: string,
  diff: string,
  broadcast: (gate: MergeGate) => void,
): Promise<void> {
  const gate = getMergeGate(mergeGateId);
  if (!gate) return;

  const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [goalId]);
  if (!goal) return;

  const config = getOrDiscoverReviewConfig(repoPath);
  if (!config) return;

  // Get files changed and completed tasks for context
  const filesChanged = await getGoalBranchFiles(repoPath, goalBranch, targetBranch);
  const tasks = getAll<{ title: string; description: string }>(
    "SELECT title, description FROM tasks WHERE goal_id = ? AND status = 'done'",
    [goalId]
  );

  // Build the review prompt with approved guidelines
  const reviewPrompt = buildReviewPrompt({
    goalName: goal.name,
    goalDescription: goal.description || '',
    targetBranch,
    filesChanged,
    consolidatedDiff: diff.slice(0, 50_000), // cap diff size for context window
    config,
    tasks,
    repoPath,
  });

  console.log(`[consolidation] Spawning review agent for gate ${mergeGateId} (${filesChanged.length} files, ${diff.length} chars diff)`);

  // Use a temporary agent ID for the review
  const reviewAgentId = `review-${mergeGateId.slice(0, 8)}`;

  // Task 3: run the review agent in a dedicated worktree checked out at the
  // goal branch, never in the user's shared tree. Fall back to the shared repo
  // only if the worktree can't be prepared (review must still run).
  const reviewWorktree = prepareReviewerWorktree(repoPath, goalBranch, mergeGateId);
  const reviewCwd = reviewWorktree || repoPath;
  if (!reviewWorktree) {
    console.warn(`[consolidation] Reviewer worktree unavailable — running review in shared repo ${repoPath}`);
  }

  let review: { output: string; code: number };
  try {
    review = await new Promise<{ output: string; code: number }>((resolve) => {
      let output = '';

      if (hasAgent(reviewAgentId)) killAgent(reviewAgentId);

      const handleOutput = (_id: string, chunk: string) => { output += chunk; };
      const handleExit = (_id: string, code: number) => { resolve({ output, code }); };

      // Use the review model from the agent's model_config, or fall back to claude-sonnet
      const agentRecord = getOne<{ model_config: string | null; agent_type: string }>('SELECT model_config, agent_type FROM agents WHERE autopilot_goal_id = ? OR id IN (SELECT agent_id FROM goal_log WHERE goal_id = ? LIMIT 1)', [goalId, goalId]);
      const reviewModel = getModelForRole(agentRecord || { agent_type: 'claude-sonnet' }, AgentRole.REVIEW);
      createAgent(reviewAgentId, reviewCwd, 'QA Reviewer', handleOutput, handleExit, reviewModel);
      sendToAgent(reviewAgentId, reviewPrompt, { skipWrap: true });
    });
  } finally {
    // Clean up the temporary agent and its disposable worktree.
    if (hasAgent(reviewAgentId)) killAgent(reviewAgentId);
    if (reviewWorktree) removeWorktree(repoPath, reviewWorktree);
  }

  // Update the merge gate with the review agent ID
  updateMergeGate(mergeGateId, { review_agent_id: reviewAgentId }, broadcast);

  // Fail closed (C3): a crashed/unauthenticated review (non-zero exit) or empty
  // output must NOT be treated as approval. Fail the gate loudly.
  if (review.code !== 0 || review.output.trim().length === 0) {
    const failureReason = `Review agent produced no usable result (exit code ${review.code}, ${review.output.trim().length} chars). Not auto-approving — re-run the review or check the review agent is authenticated.`;
    console.error(`[consolidation] ${failureReason}`);
    failGate(mergeGateId, failureReason, broadcast, AuditActionType.REVIEW);
    return;
  }

  // Process the review results
  const result = processReviewResults(mergeGateId, review.output, broadcast);
  console.log(`[consolidation] Review verdict: ${result.verdict} (score: ${result.score}, findings: ${result.findingCount})`);

  // If approved → run tests → auto-merge
  if (result.verdict === 'approve') {
    // Run tests on the goal branch
    const { runTestCheck } = await import('./build-runner.js');
    const testResult = await runTestCheck(repoPath);
    processTestResults(mergeGateId, testResult.success, testResult.output, testResult.failures || [], broadcast);

    // If tests passed, the gate should now be 'approved' — execute final merge
    const updatedGate = getMergeGate(mergeGateId);
    if (updatedGate?.status === 'approved') {
      const merged = await executeFinalMerge(mergeGateId, broadcast);
      if (merged) {
        console.log(`[consolidation] Goal ${goalId} merged to ${targetBranch}`);
        // Mark goal completed
        const now = getNow();
        getOne<any>('SELECT 1', []); // force db sync
        appendAuditRecord({
          agentId: 'system',
          mergeGateId,
          goalId,
          actionType: AuditActionType.MERGE,
          actionDetail: { goalBranch, targetBranch, verdict: result.verdict, score: result.score },
          outcome: AuditOutcome.SUCCESS,
        });
      }
    }
  }
}

export function processReviewResults(
  mergeGateId: string,
  reviewOutput: string,
  broadcast: (gate: MergeGate) => void,
): { verdict: string; score: number; findingCount: number } {
  const gate = getMergeGate(mergeGateId);
  if (!gate) throw new Error(`Merge gate not found: ${mergeGateId}`);

  const machine = getMergeGateMachine(mergeGateId);
  const parsed = parseReviewOutput(reviewOutput);

  // Store findings
  storeReviewFindings(mergeGateId, gate.review_cycles + 1, parsed.findings);

  // Store verdict
  const verdictJson = JSON.stringify({
    score: parsed.score,
    verdict: parsed.verdict,
    summary: parsed.summary,
    findingCount: parsed.findings.length,
  });

  appendAuditRecord({
    agentId: gate.review_agent_id || 'system',
    mergeGateId,
    goalId: gate.goal_id,
    actionType: AuditActionType.REVIEW,
    actionDetail: {
      verdict: parsed.verdict,
      score: parsed.score,
      findingCount: parsed.findings.length,
      criticalCount: parsed.findings.filter(f => f.severity === 'critical').length,
      warningCount: parsed.findings.filter(f => f.severity === 'warning').length,
      summary: parsed.summary,
    },
    outcome: parsed.verdict === 'approve' ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
    confidence: parsed.score / 100,
  });

  // Transition state machine. We CHECK send() return values (C2-persistence):
  // if a transition is rejected we log and do not write a contradictory status.
  const verdictPayload = { verdict: { score: parsed.score, verdict: parsed.verdict, summary: parsed.summary } };
  if (parsed.verdict === 'approve') {
    const moved = machine.send('approved', verdictPayload);
    if (!moved) {
      console.error(`[consolidation] FSM rejected 'approved' from state '${machine.state}' for gate ${mergeGateId} — not writing 'testing'`);
    } else {
      updateMergeGate(mergeGateId, {
        status: 'testing',
        review_verdict: verdictJson,
        review_cycles: gate.review_cycles + 1,
      }, broadcast);
    }
  } else if (parsed.verdict === 'changes_requested') {
    // There is no automated revision loop wired up (completeRevision has no
    // runtime driver), so parking in `revising` would wedge the gate forever.
    // Fail closed (C2): drive to `failed` with an actionable reason.
    machine.send('changes_requested', verdictPayload);
    if (machine.state === 'revising') {
      machine.send('abort', { error: 'changes requested (no automated revision loop)' });
    }
    const reason = `Review requested changes (score ${parsed.score}): ${parsed.summary || 'see findings'} — no automated revision loop; fix manually or retry.`;
    console.error(`[consolidation] ${reason}`);
    updateMergeGate(mergeGateId, {
      status: 'failed',
      review_verdict: verdictJson,
      review_cycles: gate.review_cycles + 1,
      test_results: JSON.stringify({ failureReason: reason }),
    }, broadcast);
    notifyFailure('Merge gate failed', reason);
  } else {
    machine.send('rejected', verdictPayload);
    const reason = `Review rejected (score ${parsed.score}): ${parsed.summary || 'see findings'} — escalated to human.`;
    console.error(`[consolidation] ${reason}`);
    updateMergeGate(mergeGateId, {
      status: 'failed',
      review_verdict: verdictJson,
      review_cycles: gate.review_cycles + 1,
    }, broadcast);
    notifyFailure('Merge gate failed', reason);
  }

  return {
    verdict: parsed.verdict,
    score: parsed.score,
    findingCount: parsed.findings.length,
  };
}

/**
 * Process test results for a merge gate.
 */
export function processTestResults(
  mergeGateId: string,
  success: boolean,
  output: string,
  failures: string[],
  broadcast: (gate: MergeGate) => void,
): void {
  const gate = getMergeGate(mergeGateId);
  if (!gate) throw new Error(`Merge gate not found: ${mergeGateId}`);

  const machine = getMergeGateMachine(mergeGateId);
  const results = { success, output, failures };

  appendAuditRecord({
    agentId: 'system',
    mergeGateId,
    goalId: gate.goal_id,
    actionType: AuditActionType.TEST,
    actionDetail: {
      success,
      failureCount: failures.length,
      failures: failures.slice(0, 10),
    },
    outcome: success ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
  });

  if (success) {
    const moved = machine.send('tests_passed', { results });
    if (!moved) {
      console.error(`[consolidation] FSM rejected 'tests_passed' from state '${machine.state}' for gate ${mergeGateId} — not writing 'approved'`);
      return;
    }
    updateMergeGate(mergeGateId, {
      status: 'approved',
      test_results: JSON.stringify(results),
    }, broadcast);
  } else {
    // No automated test-heal loop is wired (recordHealSuccess has no runtime
    // driver), so parking in `healing` would wedge the gate forever. Fail closed
    // (C2): drive to `failed` with an actionable reason.
    machine.send('tests_failed', { results });
    if (machine.state === 'healing') {
      machine.send('unrecoverable', { error: 'tests failed (no automated heal loop)' });
    }
    const summary = failures.slice(0, 3).join('; ') || output.slice(-300);
    const reason = `Tests failed: ${summary} — no automated heal loop; fix manually or retry.`;
    console.error(`[consolidation] ${reason}`);
    updateMergeGate(mergeGateId, {
      status: 'failed',
      test_results: JSON.stringify({ ...results, failureReason: reason }),
    }, broadcast);
    notifyFailure('Merge gate failed', reason);
  }
}

// ── Future revision/heal-loop hooks ────────────────────────────────────────
//
// recordHealSuccess / recordHealFailure / completeRevision are the intended
// drivers for the `healing` and `revising` FSM states. They are NOT wired into
// any runtime path yet (an automated heal/revision loop requires spawning a
// fix-up agent, which is future work). Until then, the runtime fails closed to
// `failed` instead of parking a gate in a state nothing drives (C2). These
// functions are kept intact so the loop can be enabled later without redesign.

/**
 * Record a successful heal attempt and transition back to testing.
 * (Future revision-loop hook — see note above; no runtime caller yet.)
 */
export function recordHealSuccess(
  mergeGateId: string,
  description: string,
  broadcast: (gate: MergeGate) => void,
): void {
  const gate = getMergeGate(mergeGateId);
  if (!gate) throw new Error(`Merge gate not found: ${mergeGateId}`);

  const machine = getMergeGateMachine(mergeGateId);
  machine.send('healed');

  appendAuditRecord({
    agentId: 'system',
    mergeGateId,
    goalId: gate.goal_id,
    actionType: AuditActionType.HEAL,
    actionDetail: { description },
    outcome: AuditOutcome.SUCCESS,
  });

  updateMergeGate(mergeGateId, {
    status: 'testing',
    heal_attempts: gate.heal_attempts + 1,
  }, broadcast);
}

/**
 * Record a failed heal attempt.
 */
export function recordHealFailure(
  mergeGateId: string,
  error: string,
  broadcast: (gate: MergeGate) => void,
): void {
  const gate = getMergeGate(mergeGateId);
  if (!gate) throw new Error(`Merge gate not found: ${mergeGateId}`);

  const machine = getMergeGateMachine(mergeGateId);
  machine.send('unrecoverable', { error });

  appendAuditRecord({
    agentId: 'system',
    mergeGateId,
    goalId: gate.goal_id,
    actionType: AuditActionType.HEAL,
    actionDetail: { error },
    outcome: AuditOutcome.FAILURE,
  });

  updateMergeGate(mergeGateId, {
    status: 'failed',
    heal_attempts: gate.heal_attempts + 1,
  }, broadcast);
}

/**
 * Execute the final merge of goal branch to target branch.
 */
export async function executeFinalMerge(
  mergeGateId: string,
  broadcast: (gate: MergeGate) => void,
): Promise<boolean> {
  const gate = getMergeGate(mergeGateId);
  if (!gate) throw new Error(`Merge gate not found: ${mergeGateId}`);

  const machine = getMergeGateMachine(mergeGateId);
  const started = machine.send('merge');
  if (!started) {
    console.error(`[consolidation] FSM rejected 'merge' from state '${machine.state}' for gate ${mergeGateId} — refusing final merge`);
    return false;
  }
  updateMergeGate(mergeGateId, { status: 'merging' }, broadcast);

  const startTime = Date.now();
  const strategy = (gate.merge_strategy || 'squash') as 'squash' | 'no-ff';
  const result = await mergeGoalToTarget(gate.repo_path, gate.goal_branch, gate.target_branch, strategy);
  const durationMs = Date.now() - startTime;

  if (result.success) {
    machine.send('merged');
    const now = getNow();
    updateMergeGate(mergeGateId, { status: 'merged', merged_at: now }, broadcast);

    appendAuditRecord({
      agentId: 'system',
      mergeGateId,
      goalId: gate.goal_id,
      actionType: AuditActionType.MERGE,
      actionDetail: {
        goalBranch: gate.goal_branch,
        targetBranch: gate.target_branch,
        strategy,
      },
      outcome: AuditOutcome.SUCCESS,
      durationMs,
    });

    // Clean up state machine
    activeMergeGates.delete(mergeGateId);
    return true;
  } else {
    // Final merge to the target branch conflicted. No automated heal loop drives
    // `healing`, so fail closed (C2) with an actionable reason.
    machine.send('merge_conflict', { error: result.output });
    if (machine.state === 'healing') {
      machine.send('unrecoverable', { error: 'final merge conflict (no automated heal loop)' });
    }
    const reason = `Final merge of ${gate.goal_branch} → ${gate.target_branch} conflicted — resolve manually or retry. ${result.output.slice(0, 300)}`;
    console.error(`[consolidation] ${reason}`);
    updateMergeGate(mergeGateId, {
      status: 'failed',
      test_results: JSON.stringify({ failureReason: reason }),
    }, broadcast);

    appendAuditRecord({
      agentId: 'system',
      mergeGateId,
      goalId: gate.goal_id,
      actionType: AuditActionType.MERGE,
      actionDetail: {
        goalBranch: gate.goal_branch,
        targetBranch: gate.target_branch,
        strategy,
        error: result.output,
      },
      outcome: AuditOutcome.FAILURE,
      durationMs,
    });

    notifyFailure('Merge gate failed', reason);
    return false;
  }
}

/**
 * Mark a revision as complete and transition back to reviewing.
 */
export function completeRevision(
  mergeGateId: string,
  broadcast: (gate: MergeGate) => void,
): void {
  const gate = getMergeGate(mergeGateId);
  if (!gate) throw new Error(`Merge gate not found: ${mergeGateId}`);

  const machine = getMergeGateMachine(mergeGateId);
  machine.send('revised');

  updateMergeGate(mergeGateId, { status: 'reviewing' }, broadcast);
}

/**
 * Abort a merge gate (user-triggered or system escalation).
 */
export function abortMergeGate(
  mergeGateId: string,
  reason: string,
  broadcast: (gate: MergeGate) => void,
): void {
  const gate = getMergeGate(mergeGateId);
  if (!gate) return;

  const machine = getMergeGateMachine(mergeGateId);
  machine.send('abort', { error: reason });

  appendAuditRecord({
    agentId: 'system',
    mergeGateId,
    goalId: gate.goal_id,
    actionType: AuditActionType.ERROR,
    actionDetail: { reason },
    outcome: AuditOutcome.ESCALATED,
  });

  updateMergeGate(mergeGateId, { status: 'failed' }, broadcast);
  activeMergeGates.delete(mergeGateId);
}

/**
 * Post-merge reflection — analyze the merge gate's history for patterns.
 */
export function generateReflectionPrompt(mergeGateId: string): string {
  const gate = getMergeGate(mergeGateId);
  if (!gate) return '';

  const goal = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [gate.goal_id]);
  const findings = getAll<{ severity: string; category: string; description: string }>(
    'SELECT severity, category, description FROM review_findings WHERE merge_gate_id = ?',
    [mergeGateId]
  );

  let prompt = `Reflect on the merge gate process for goal: "${goal?.name || 'unknown'}"\n\n`;

  prompt += `## Stats\n`;
  prompt += `- Review cycles: ${gate.review_cycles}\n`;
  prompt += `- Heal attempts: ${gate.heal_attempts}\n`;
  prompt += `- Total findings: ${findings.length}\n`;
  prompt += `- Final status: ${gate.status}\n\n`;

  if (findings.length > 0) {
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }
    prompt += `## Finding Patterns\n`;
    prompt += `By severity: ${JSON.stringify(bySeverity)}\n`;
    prompt += `By category: ${JSON.stringify(byCategory)}\n\n`;

    prompt += `## Sample Findings\n`;
    for (const f of findings.slice(0, 5)) {
      prompt += `- [${f.severity}/${f.category}] ${f.description}\n`;
    }
    prompt += `\n`;
  }

  prompt += `Reflect on:\n`;
  prompt += `1. What patterns of issues were found?\n`;
  prompt += `2. What should the implementation agent do differently next time?\n`;
  prompt += `3. Rate the overall quality (1-10) with explanation.\n`;

  return prompt;
}

/**
 * Check if a goal is ready for consolidation.
 * Returns true if all tasks are done or archived.
 */
export function isGoalReadyForConsolidation(goalId: string): boolean {
  const pendingTasks = getAll<Task>(
    `SELECT id FROM tasks WHERE goal_id = ? AND status IN ('todo', 'in_progress')`,
    [goalId]
  );
  return pendingTasks.length === 0;
}
