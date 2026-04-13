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
  getReviewConfig, getAll, getOne, generateId, getNow,
  getUnresolvedFindings,
} from '../db-helpers.js';
import {
  createGoalBranch, mergeToGoalBranch, mergeGoalToTarget,
  getConsolidatedDiff, getGoalBranchFiles, listAgentBranches, getDefaultBranch,
} from './git-ops.js';
import {
  getOrDiscoverReviewConfig, buildReviewPrompt, parseReviewOutput,
  storeReviewFindings, buildRevisionPrompt,
} from './review-agent.js';
import { appendAuditRecord, verifyAuditChain } from './audit-trail.js';
import { healMergeConflict, buildTestFixPrompt, classifyFailure, shouldEscalate } from './self-heal.js';
import { AuditActionType, AuditOutcome } from '../engine/constants.js';
import { createAgent, sendToAgent, hasAgent, killAgent } from '../pty-manager.js';
import { getProvider, getModelForRole } from '../agent-providers.js';
import { AgentRole } from '../engine/constants.js';
import type { Goal, Task, MergeGate } from '../../client/lib/types.js';

// Active merge gate state machines
const activeMergeGates = new Map<string, StateMachine<MergeGateState, MergeGateEvent, MergeGateContext>>();

/**
 * Get or create the merge gate state machine for a given merge gate.
 */
function getMergeGateMachine(mergeGateId: string, ctx?: Partial<MergeGateContext>) {
  let machine = activeMergeGates.get(mergeGateId);
  if (!machine) {
    const def = createMergeGateMachineDef(ctx);
    machine = new StateMachine<MergeGateState, MergeGateEvent, MergeGateContext>(def);
    activeMergeGates.set(mergeGateId, machine);
  }
  return machine;
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

  // Merge each task branch into goal branch
  let consolidationSuccess = true;
  let consolidationOutput = '';

  for (const branch of taskBranches) {
    const result = await mergeToGoalBranch(repoPath, branch, goalBranch);
    consolidationOutput += `${branch}: ${result.success ? 'OK' : 'FAILED'}\n${result.output}\n`;

    if (!result.success) {
      // Attempt auto-heal for merge conflicts
      const healResult = await healMergeConflict(repoPath, result.output);
      if (!healResult.success) {
        consolidationSuccess = false;
        machine.send('conflict', { reason: `Merge conflict in ${branch}: ${result.output}` });
        break;
      }
      consolidationOutput += `  → Auto-healed: ${healResult.description}\n`;
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
    appendAuditRecord({
      agentId: 'system',
      mergeGateId: gate.id,
      goalId,
      actionType: AuditActionType.CONSOLIDATE,
      actionDetail: {
        taskBranches,
        goalBranch,
        output: consolidationOutput,
      },
      outcome: AuditOutcome.FAILURE,
      durationMs,
    });

    updateMergeGate(gate.id, { status: 'healing' }, broadcast);
  }

  return getMergeGate(gate.id);
}

/**
 * Process review results for a merge gate.
 * Called after the review agent completes its analysis.
 */
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

  const reviewOutput = await new Promise<string>((resolve) => {
    let output = '';

    if (hasAgent(reviewAgentId)) killAgent(reviewAgentId);

    const handleOutput = (_id: string, chunk: string) => { output += chunk; };
    const handleExit = (_id: string, _code: number) => { resolve(output); };

    // Use the review model from the agent's model_config, or fall back to claude-sonnet
    const agentRecord = getOne<{ model_config: string | null; agent_type: string }>('SELECT model_config, agent_type FROM agents WHERE autopilot_goal_id = ? OR id IN (SELECT agent_id FROM goal_log WHERE goal_id = ? LIMIT 1)', [goalId, goalId]);
    const reviewModel = getModelForRole(agentRecord || { agent_type: 'claude-sonnet' }, AgentRole.REVIEW);
    createAgent(reviewAgentId, repoPath, 'QA Reviewer', handleOutput, handleExit, reviewModel);
    sendToAgent(reviewAgentId, reviewPrompt, { skipWrap: true });
  });

  // Clean up the temporary agent
  if (hasAgent(reviewAgentId)) killAgent(reviewAgentId);

  // Update the merge gate with the review agent ID
  updateMergeGate(mergeGateId, { review_agent_id: reviewAgentId }, broadcast);

  // Process the review results
  const result = processReviewResults(mergeGateId, reviewOutput, broadcast);
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

  // Transition state machine
  if (parsed.verdict === 'approve') {
    machine.send('approved', { verdict: { score: parsed.score, verdict: parsed.verdict, summary: parsed.summary } });
    updateMergeGate(mergeGateId, {
      status: 'testing',
      review_verdict: verdictJson,
      review_cycles: gate.review_cycles + 1,
    }, broadcast);
  } else if (parsed.verdict === 'changes_requested') {
    machine.send('changes_requested', { verdict: { score: parsed.score, verdict: parsed.verdict, summary: parsed.summary } });
    const newStatus = machine.state === 'failed' ? 'failed' : 'revising';
    updateMergeGate(mergeGateId, {
      status: newStatus,
      review_verdict: verdictJson,
      review_cycles: gate.review_cycles + 1,
    }, broadcast);
  } else {
    machine.send('rejected', { verdict: { score: parsed.score, verdict: parsed.verdict, summary: parsed.summary } });
    updateMergeGate(mergeGateId, {
      status: 'failed',
      review_verdict: verdictJson,
      review_cycles: gate.review_cycles + 1,
    }, broadcast);
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
    machine.send('tests_passed', { results });
    updateMergeGate(mergeGateId, {
      status: 'approved',
      test_results: JSON.stringify(results),
    }, broadcast);
  } else {
    machine.send('tests_failed', { results });
    const newStatus = machine.state === 'failed' ? 'failed' : 'healing';
    updateMergeGate(mergeGateId, {
      status: newStatus,
      test_results: JSON.stringify(results),
      heal_attempts: gate.heal_attempts + (newStatus === 'healing' ? 0 : 0),
    }, broadcast);
  }
}

/**
 * Record a successful heal attempt and transition back to testing.
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
  machine.send('merge');
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
    machine.send('merge_conflict', { error: result.output });
    const newStatus = machine.state === 'failed' ? 'failed' : 'healing';
    updateMergeGate(mergeGateId, { status: newStatus }, broadcast);

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
