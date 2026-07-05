/**
 * Closed-loop experiment system — makes agents actually get better over time.
 *
 * Architecture:
 * - Strategy pattern: each experiment type (prompt, model, pattern, workflow, fix)
 *   implements ExperimentStrategy with applyVariant/promote/rollback
 * - Statistical rigor: Welch's t-test + Cohen's d, not raw average comparison
 * - Multi-metric: composite score from score + cost + speed + merge success
 * - Auto-hypothesis: generates testable experiments from reflections and failures
 * - Plugs into autopilot via 3 hooks (no structural changes to main loop)
 */
import {
  generateId, getNow, getAll, getOne, runQuery,
  createExperimentRecord, getExperimentRecord, updateExperimentRecord,
  getActiveExperimentByType, getRunningExperiments, getQueuedExperiments,
  insertExperimentRun, getExperimentRuns, getExperimentRunCounts,
  markPatternVerified, markFixSucceeded,
} from '../db-helpers.js';
import { appendAuditRecord } from './audit-trail.js';
import { getActivePromptVersion, createPromptVersion, getRecentReflections } from '../self-improve.js';
import { getProvider, listProviders } from '../agent-providers.js';
import { AuditActionType, AuditOutcome, Limits } from '../engine/constants.js';
import { bus } from '../engine/event-bus.js';
import type { ExperimentRecord, ExperimentRun, Reflection } from '../../client/lib/types.js';

// ============================================================================
// Statistical Functions (zero external deps, ~60 lines)
// ============================================================================

export function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
}

export function stddev(arr: number[]): number {
  return Math.sqrt(variance(arr));
}

/**
 * Welch's t-test for unequal variances and sample sizes.
 * Returns t-statistic, approximate p-value, and degrees of freedom.
 */
export function welchTTest(a: number[], b: number[]): { tStat: number; pValue: number; df: number } {
  const nA = a.length, nB = b.length;
  if (nA < 2 || nB < 2) return { tStat: 0, pValue: 1, df: 0 };

  const mA = mean(a), mB = mean(b);
  const vA = variance(a), vB = variance(b);
  const se = Math.sqrt(vA / nA + vB / nB);
  if (se === 0) return { tStat: 0, pValue: 1, df: nA + nB - 2 };

  const t = (mA - mB) / se;

  // Welch-Satterthwaite degrees of freedom
  const df = (vA / nA + vB / nB) ** 2 /
    ((vA / nA) ** 2 / (nA - 1) + (vB / nB) ** 2 / (nB - 1));

  // Approximate two-tailed p-value using regularized incomplete beta function
  const pValue = tDistPValue(Math.abs(t), Math.max(df, 1));

  return { tStat: t, pValue, df };
}

/**
 * Cohen's d effect size (positive means a > b).
 */
export function cohensD(a: number[], b: number[]): number {
  const nA = a.length, nB = b.length;
  if (nA < 2 || nB < 2) return 0;
  const pooledStd = Math.sqrt(((nA - 1) * variance(a) + (nB - 1) * variance(b)) / (nA + nB - 2));
  if (pooledStd === 0) return 0;
  return (mean(a) - mean(b)) / pooledStd;
}

/**
 * Approximate two-tailed p-value from t-distribution.
 * Uses the Gaussian approximation with Cornish-Fisher correction for df > 4,
 * and direct lookup-style approximation for small df.
 */
function tDistPValue(absT: number, df: number): number {
  if (df <= 0) return 1;

  // For large df, t-distribution → normal
  if (df > 100) {
    return 2 * normalCdf(-absT);
  }

  // Cornish-Fisher expansion: transform t to approximately normal z
  // z ≈ t * (1 - 1/(4*df)) / sqrt(1 + t^2/(2*df))
  // This is accurate to O(1/df^2) for df > 3
  const z = absT * (1 - 1 / (4 * df)) / Math.sqrt(1 + absT * absT / (2 * df));
  return 2 * normalCdf(-z);
}

function normalCdf(x: number): number {
  // Approximation of standard normal CDF (Abramowitz & Stegun 26.2.17)
  const a = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804 * Math.exp(-x * x / 2);
  const p = d * a * (0.3193815 + a * (-0.3565638 + a * (1.781478 + a * (-1.8212560 + a * 1.3302744))));
  return x > 0 ? 1 - p : p;
}

// ============================================================================
// Composite Metric Scoring
// ============================================================================

export interface MetricWeights {
  score: number;
  cost: number;
  speed: number;
  mergeSuccess: number;
  quality: number;
}

export const DEFAULT_METRIC_WEIGHTS: MetricWeights = {
  score: 0.4,
  cost: 0.2,
  speed: 0.15,
  mergeSuccess: 0.15,
  quality: 0.1,
};

export interface RunMetrics {
  score: number;
  costUsd: number;
  durationMs: number;
  mergeSuccess: boolean | null;
  buildFailures: number;
  testFailures: number;
  filesChanged: number;
}

/**
 * Compute a composite utility score from a metrics vector.
 * All components normalized to 0-1, weighted, then combined.
 */
export function compositeScore(metrics: RunMetrics, weights: MetricWeights = DEFAULT_METRIC_WEIGHTS): number {
  const normalized = {
    score: metrics.score / 100,
    cost: 1 - Math.min(metrics.costUsd / 1.0, 1),        // lower cost = higher
    speed: 1 - Math.min(metrics.durationMs / 300_000, 1), // faster = higher
    mergeSuccess: metrics.mergeSuccess === null ? 0.5 : (metrics.mergeSuccess ? 1 : 0),
    quality: Math.max(0, 1 - metrics.buildFailures * 0.3 - metrics.testFailures * 0.2),
  };

  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0);
  if (totalWeight === 0) return 0;

  return (
    normalized.score * weights.score +
    normalized.cost * weights.cost +
    normalized.speed * weights.speed +
    normalized.mergeSuccess * weights.mergeSuccess +
    normalized.quality * weights.quality
  ) / totalWeight;
}

// ============================================================================
// Experiment Strategy Interface
// ============================================================================

export interface ExperimentStrategy {
  type: string;

  /** Apply a variant to the current run context. Returns modified context. */
  applyVariant(variant: 'control' | 'treatment', config: string, agentId: string): VariantApplication;

  /** Permanently apply the winning variant */
  promote(experiment: ExperimentRecord): { success: boolean; description: string };

  /** Revert a treatment that lost or caused harm */
  rollback(experiment: ExperimentRecord): { success: boolean; description: string };
}

export interface VariantApplication {
  /** Modified prompt text to inject (null = no change) */
  promptModification?: string;
  /** Modified agent_type (null = no change) */
  agentType?: string;
  /** Description of what this variant changes */
  description: string;
}

// ── Strategy Registry ──

const strategies = new Map<string, ExperimentStrategy>();

export function registerStrategy(type: string, strategy: ExperimentStrategy): void {
  strategies.set(type, strategy);
}

function getStrategy(type: string): ExperimentStrategy | undefined {
  return strategies.get(type);
}

// ============================================================================
// Built-in Strategies
// ============================================================================

// ── Prompt Strategy ──

const promptStrategy: ExperimentStrategy = {
  type: 'prompt',

  applyVariant(variant, config, agentId) {
    if (variant === 'control') {
      return { description: 'Using current prompt template (control)' };
    }
    // Treatment: inject the modified prompt instruction
    const parsed = JSON.parse(config);
    return {
      promptModification: parsed.instruction || '',
      description: `Testing prompt change: ${parsed.description || 'modified template'}`,
    };
  },

  promote(experiment) {
    try {
      const treatment = JSON.parse(experiment.treatment_config);
      if (treatment.promptTemplate) {
        createPromptVersion(experiment.agent_id, treatment.promptTemplate, true);
        return { success: true, description: `Promoted prompt template v${treatment.version || 'new'}` };
      }
      return { success: true, description: 'Prompt instruction promoted to permanent guidelines' };
    } catch (e: any) {
      return { success: false, description: `Promotion failed: ${e.message}` };
    }
  },

  rollback(experiment) {
    try {
      const control = JSON.parse(experiment.control_config);
      if (control.promptVersionId) {
        // Reactivate the control prompt version
        runQuery('UPDATE prompt_versions SET is_active = 0 WHERE agent_id = ?', [experiment.agent_id]);
        runQuery('UPDATE prompt_versions SET is_active = 1 WHERE id = ?', [control.promptVersionId]);
        return { success: true, description: 'Reverted to previous prompt template' };
      }
      return { success: true, description: 'No rollback needed — control was default' };
    } catch (e: any) {
      return { success: false, description: `Rollback failed: ${e.message}` };
    }
  },
};

// ── Model Strategy ──

const modelStrategy: ExperimentStrategy = {
  type: 'model',

  applyVariant(variant, config, agentId) {
    if (variant === 'control') {
      return { description: 'Using current model (control)' };
    }
    const parsed = JSON.parse(config);
    return {
      agentType: parsed.modelId,
      description: `Testing model: ${parsed.modelName || parsed.modelId}`,
    };
  },

  promote(experiment) {
    const treatment = JSON.parse(experiment.treatment_config);
    runQuery('UPDATE agents SET agent_type = ? WHERE id = ?', [treatment.modelId, experiment.agent_id]);
    return { success: true, description: `Switched agent to ${treatment.modelName || treatment.modelId}` };
  },

  rollback(experiment) {
    const control = JSON.parse(experiment.control_config);
    runQuery('UPDATE agents SET agent_type = ? WHERE id = ?', [control.modelId, experiment.agent_id]);
    return { success: true, description: `Reverted agent to ${control.modelName || control.modelId}` };
  },
};

// ── Pattern Strategy ──

const patternStrategy: ExperimentStrategy = {
  type: 'pattern',

  applyVariant(variant, config) {
    if (variant === 'control') {
      return { description: 'Pattern excluded from context (control)' };
    }
    const parsed = JSON.parse(config);
    return {
      promptModification: `\nAPPLY THIS PATTERN: ${parsed.name}\n${parsed.trigger_condition || ''}\n${parsed.code_example || ''}\n`,
      description: `Testing pattern: ${parsed.name}`,
    };
  },

  promote(experiment) {
    const treatment = JSON.parse(experiment.treatment_config);
    if (treatment.patternId) {
      markPatternVerified(treatment.patternId);
      return { success: true, description: `Pattern "${treatment.name}" verified and promoted` };
    }
    return { success: false, description: 'No pattern ID to verify' };
  },

  rollback(experiment) {
    // Pattern was never verified, so just leave it unverified
    return { success: true, description: 'Pattern left unverified — will not be prioritized' };
  },
};

// ── Workflow Strategy ──

const workflowStrategy: ExperimentStrategy = {
  type: 'workflow',

  applyVariant(variant, config) {
    if (variant === 'control') {
      return { description: 'Using current workflow (control)' };
    }
    // Workflow changes are applied at the autopilot level, not in prompt
    return { description: 'Testing workflow modification' };
  },

  promote(experiment) {
    const treatment = JSON.parse(experiment.treatment_config);
    if (treatment.workflowId && treatment.steps) {
      runQuery('UPDATE workflows SET steps = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(treatment.steps), getNow(), treatment.workflowId]);
      return { success: true, description: 'Workflow steps updated' };
    }
    return { success: false, description: 'No workflow changes to promote' };
  },

  rollback(experiment) {
    const control = JSON.parse(experiment.control_config);
    if (control.workflowId && control.steps) {
      runQuery('UPDATE workflows SET steps = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(control.steps), getNow(), control.workflowId]);
      return { success: true, description: 'Workflow reverted to original steps' };
    }
    return { success: true, description: 'No workflow rollback needed' };
  },
};

// ── Fix Strategy ──

const fixStrategy: ExperimentStrategy = {
  type: 'fix',

  applyVariant(variant, config) {
    if (variant === 'control') {
      return { description: 'Fix excluded from context (control)' };
    }
    const parsed = JSON.parse(config);
    return {
      promptModification: `\nKNOWN FIX: If you encounter "${parsed.error_signature}", the cause is "${parsed.root_cause}". Fix: ${parsed.fix_action}\n`,
      description: `Testing fix: ${parsed.error_signature}`,
    };
  },

  promote(experiment) {
    const treatment = JSON.parse(experiment.treatment_config);
    if (treatment.fixId) {
      markFixSucceeded(treatment.fixId);
      return { success: true, description: `Fix for "${treatment.error_signature}" verified` };
    }
    return { success: false, description: 'No fix ID to verify' };
  },

  rollback(experiment) {
    return { success: true, description: 'Fix left unverified' };
  },
};

// Register all built-in strategies
registerStrategy('prompt', promptStrategy);
registerStrategy('model', modelStrategy);
registerStrategy('pattern', patternStrategy);
registerStrategy('workflow', workflowStrategy);
registerStrategy('fix', fixStrategy);

// ============================================================================
// Experiment State Management
// ============================================================================

/**
 * Attempt to start the next queued experiment for an agent.
 * Only starts if there's no running experiment of the same type.
 */
export function startNextQueuedExperiment(agentId: string): ExperimentRecord | null {
  const queued = getQueuedExperiments(agentId);
  for (const exp of queued) {
    // Check no running experiment of same type
    const running = getActiveExperimentByType(agentId, exp.experiment_type);
    if (!running) {
      const now = getNow();
      updateExperimentRecord(exp.id, { status: 'running', started_at: now });
      appendAuditRecord({
        agentId,
        actionType: AuditActionType.EXPERIMENT_STARTED,
        actionDetail: { experimentId: exp.id, type: exp.experiment_type, name: exp.name },
        outcome: AuditOutcome.SUCCESS,
      });
      console.log(`[experiment] Started: ${exp.name} (${exp.experiment_type})`);
      return getExperimentRecord(exp.id);
    }
  }
  return null;
}

/**
 * Queue a proposed experiment (auto-approve).
 */
export function queueExperiment(experimentId: string): ExperimentRecord | null {
  return updateExperimentRecord(experimentId, { status: 'queued', queued_at: getNow() });
}

// ============================================================================
// Variant Assignment (Block Randomization)
// ============================================================================

/**
 * Pick which variant to run next using block randomization (ABBA pattern).
 * More balanced than pure alternation, reduces ordering effects.
 */
export function pickVariant(experimentId: string): 'control' | 'treatment' {
  const counts = getExperimentRunCounts(experimentId);
  const total = counts.control + counts.treatment;

  // ABBA block pattern within blocks of 4
  const blockPos = total % 4;
  if (blockPos === 0 || blockPos === 3) return 'control';
  return 'treatment';
}

// ============================================================================
// Hook 1: Get and Apply Variant for Current Run
// ============================================================================

export interface RunContext {
  agentId: string;
  goalId: string;
  taskId?: string;
  goalType?: string;
  taskType?: string;
}

/**
 * Called before each autopilot run. Finds any active experiment and applies the variant.
 * Returns the application result (prompt modification, model change, etc.) or null.
 */
export function getAndApplyVariant(agentId: string, context: RunContext): {
  experimentId: string;
  variant: 'control' | 'treatment';
  application: VariantApplication;
} | null {
  const running = getRunningExperiments(agentId);
  if (running.length === 0) {
    // Try to start a queued experiment
    startNextQueuedExperiment(agentId);
    const newRunning = getRunningExperiments(agentId);
    if (newRunning.length === 0) return null;
    running.push(...newRunning);
  }

  // Pick the highest-priority running experiment
  const experiment = running[0];

  // Check environment constraints
  const env = JSON.parse(experiment.environment || '{}');
  if (env.goalTypes && context.goalType && !env.goalTypes.includes(context.goalType)) return null;
  if (env.taskTypes && context.taskType && !env.taskTypes.includes(context.taskType)) return null;

  // Check budget
  if (experiment.budget_cap_usd && experiment.cost_spent_usd >= experiment.budget_cap_usd) {
    concludeExperiment(experiment.id, 'inconclusive', 'Budget cap exceeded');
    return null;
  }

  const strategy = getStrategy(experiment.experiment_type);
  if (!strategy) return null;

  const variant = pickVariant(experiment.id);
  const config = variant === 'control' ? experiment.control_config : experiment.treatment_config;
  const application = strategy.applyVariant(variant, config, agentId);

  return { experimentId: experiment.id, variant, application };
}

// ============================================================================
// Hook 2: Record Run Metrics
// ============================================================================

/**
 * Called after each autopilot run. Records metrics for the active experiment.
 */
export function recordRunResult(
  experimentId: string,
  variant: 'control' | 'treatment',
  metrics: RunMetrics,
  context: { goalId?: string; taskId?: string; goalType?: string; taskType?: string; runMetricId?: string },
): void {
  const experiment = getExperimentRecord(experimentId);
  if (!experiment || experiment.status !== 'running') return;

  const weights: MetricWeights = JSON.parse(experiment.metric_weights || '{}');
  const mergedWeights = { ...DEFAULT_METRIC_WEIGHTS, ...weights };
  const composite = compositeScore(metrics, mergedWeights);

  insertExperimentRun({
    id: generateId(),
    experiment_id: experimentId,
    variant,
    run_metric_id: context.runMetricId || null,
    score: metrics.score,
    cost_usd: metrics.costUsd,
    duration_ms: metrics.durationMs,
    merge_success: metrics.mergeSuccess === null ? null : (metrics.mergeSuccess ? 1 : 0),
    build_failures: metrics.buildFailures,
    test_failures: metrics.testFailures,
    files_changed: metrics.filesChanged,
    composite_score: composite,
    goal_id: context.goalId || null,
    task_id: context.taskId || null,
    goal_type: context.goalType || null,
    task_type: context.taskType || null,
  });

  // Accumulate cost
  updateExperimentRecord(experimentId, {
    cost_spent_usd: experiment.cost_spent_usd + metrics.costUsd,
  });

  // Check if we should analyze
  checkAndConclude(experimentId);
}

// ============================================================================
// Statistical Analysis + Conclusion
// ============================================================================

export interface AnalysisResult {
  verdict: 'promote' | 'rollback' | 'inconclusive' | 'continue';
  pValue: number;
  effectSize: number;
  controlMean: number;
  treatmentMean: number;
  controlN: number;
  treatmentN: number;
  reason: string;
}

/**
 * Analyze an experiment's runs and decide whether to conclude it.
 */
export function analyzeExperiment(experimentId: string): AnalysisResult {
  const controlRuns = getExperimentRuns(experimentId, 'control');
  const treatmentRuns = getExperimentRuns(experimentId, 'treatment');

  const controlScores = controlRuns.map(r => r.composite_score);
  const treatmentScores = treatmentRuns.map(r => r.composite_score);

  const minRuns = Limits.EXPERIMENT_MIN_RUNS_PER_VARIANT;
  const maxRuns = Limits.EXPERIMENT_MAX_RUNS_PER_VARIANT;
  const pThreshold = Limits.EXPERIMENT_P_THRESHOLD;
  const minEffectSize = Limits.EXPERIMENT_MIN_EFFECT_SIZE;

  // Not enough data yet
  if (controlScores.length < minRuns || treatmentScores.length < minRuns) {
    // Early stopping guardrail: if treatment is clearly worse after 5+ runs
    if (controlScores.length >= 5 && treatmentScores.length >= 5) {
      const { pValue } = welchTTest(controlScores, treatmentScores);
      const d = cohensD(controlScores, treatmentScores);
      if (pValue < 0.01 && d > 0.5 && mean(controlScores) > mean(treatmentScores)) {
        return {
          verdict: 'rollback',
          pValue, effectSize: d,
          controlMean: mean(controlScores), treatmentMean: mean(treatmentScores),
          controlN: controlScores.length, treatmentN: treatmentScores.length,
          reason: `Early stop: treatment significantly worse (p=${pValue.toFixed(4)}, d=${d.toFixed(2)})`,
        };
      }
    }
    return {
      verdict: 'continue',
      pValue: 1, effectSize: 0,
      controlMean: mean(controlScores), treatmentMean: mean(treatmentScores),
      controlN: controlScores.length, treatmentN: treatmentScores.length,
      reason: `Need more data: ${controlScores.length}/${minRuns} control, ${treatmentScores.length}/${minRuns} treatment`,
    };
  }

  // Run statistical tests
  const { pValue } = welchTTest(treatmentScores, controlScores);
  const d = cohensD(treatmentScores, controlScores);
  const tMean = mean(treatmentScores);
  const cMean = mean(controlScores);

  // Treatment wins: significantly better with meaningful effect size
  if (pValue < pThreshold && d >= minEffectSize && tMean > cMean) {
    return {
      verdict: 'promote',
      pValue, effectSize: d,
      controlMean: cMean, treatmentMean: tMean,
      controlN: controlScores.length, treatmentN: treatmentScores.length,
      reason: `Treatment wins: +${((tMean - cMean) * 100).toFixed(1)}% composite (p=${pValue.toFixed(4)}, d=${d.toFixed(2)})`,
    };
  }

  // Treatment loses: significantly worse
  if (pValue < pThreshold && Math.abs(d) >= minEffectSize && tMean < cMean) {
    return {
      verdict: 'rollback',
      pValue, effectSize: d,
      controlMean: cMean, treatmentMean: tMean,
      controlN: controlScores.length, treatmentN: treatmentScores.length,
      reason: `Treatment loses: ${((cMean - tMean) * 100).toFixed(1)}% worse (p=${pValue.toFixed(4)}, d=${d.toFixed(2)})`,
    };
  }

  // Max runs reached — inconclusive
  if (controlScores.length >= maxRuns || treatmentScores.length >= maxRuns) {
    return {
      verdict: 'inconclusive',
      pValue, effectSize: d,
      controlMean: cMean, treatmentMean: tMean,
      controlN: controlScores.length, treatmentN: treatmentScores.length,
      reason: `Max runs reached, no significant difference (p=${pValue.toFixed(4)}, d=${d.toFixed(2)})`,
    };
  }

  return {
    verdict: 'continue',
    pValue, effectSize: d,
    controlMean: cMean, treatmentMean: tMean,
    controlN: controlScores.length, treatmentN: treatmentScores.length,
    reason: `Not yet conclusive (p=${pValue.toFixed(4)}, need p<${pThreshold})`,
  };
}

/**
 * Check if an experiment should be concluded and act on the result.
 */
export function checkAndConclude(experimentId: string): void {
  const result = analyzeExperiment(experimentId);
  if (result.verdict === 'continue') return;

  concludeExperiment(experimentId, result.verdict, result.reason, result);
}

function concludeExperiment(
  experimentId: string,
  verdict: 'promote' | 'rollback' | 'inconclusive',
  reason: string,
  analysis?: AnalysisResult,
): void {
  const experiment = getExperimentRecord(experimentId);
  if (!experiment) return;

  const strategy = getStrategy(experiment.experiment_type);
  const now = getNow();

  // Map the analysis verdict onto a persisted status. A promote/rollback verdict
  // with no registered strategy must not leak the verdict word into the status column.
  let finalStatus: 'promoted' | 'rolled_back' | 'inconclusive' = 'inconclusive';
  let actionResult = { success: true, description: '' };

  if (verdict === 'promote' && strategy) {
    actionResult = strategy.promote(experiment);
    finalStatus = actionResult.success ? 'promoted' : 'inconclusive';
  } else if (verdict === 'rollback' && strategy) {
    actionResult = strategy.rollback(experiment);
    finalStatus = 'rolled_back';
  }

  updateExperimentRecord(experimentId, {
    status: finalStatus,
    concluded_at: now,
    decision_reason: `${reason}. ${actionResult.description}`,
    p_value: analysis?.pValue ?? null,
    effect_size: analysis?.effectSize ?? null,
    control_mean: analysis?.controlMean ?? null,
    treatment_mean: analysis?.treatmentMean ?? null,
  });

  const auditType = verdict === 'promote'
    ? AuditActionType.EXPERIMENT_PROMOTED
    : verdict === 'rollback'
      ? AuditActionType.EXPERIMENT_ROLLED_BACK
      : AuditActionType.EXPERIMENT_INCONCLUSIVE;

  appendAuditRecord({
    agentId: experiment.agent_id,
    actionType: auditType,
    actionDetail: {
      experimentId,
      type: experiment.experiment_type,
      name: experiment.name,
      verdict,
      reason,
      pValue: analysis?.pValue,
      effectSize: analysis?.effectSize,
      controlMean: analysis?.controlMean,
      treatmentMean: analysis?.treatmentMean,
    },
    outcome: verdict === 'promote' ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
  });

  bus.emit('experiment:concluded', {
    experimentId,
    agentId: experiment.agent_id,
    status: finalStatus,
    winner: verdict === 'promote' ? 'treatment' : verdict === 'rollback' ? 'control' : undefined,
  });

  console.log(`[experiment] Concluded "${experiment.name}": ${finalStatus} — ${reason}`);

  // Try to start next queued experiment
  startNextQueuedExperiment(experiment.agent_id);
}

// ============================================================================
// Hook 3: Hypothesis Generation
// ============================================================================

/** Track run count per agent for hypothesis generation interval */
const runCountSinceLastHypothesis = new Map<string, number>();

/**
 * Called after each reflection. Checks if it's time to generate hypotheses.
 */
export function onReflection(
  agentId: string,
  context: { reflection: { went_well: string; improve: string; pattern: string }; score: number; success: boolean },
): void {
  const count = (runCountSinceLastHypothesis.get(agentId) ?? 0) + 1;
  runCountSinceLastHypothesis.set(agentId, count);

  if (count >= Limits.HYPOTHESIS_CHECK_INTERVAL) {
    runCountSinceLastHypothesis.set(agentId, 0);
    generateHypotheses(agentId);
  }
}

/**
 * Generate experiment hypotheses from reflections, failures, and cost analysis.
 */
export function generateHypotheses(agentId: string): ExperimentRecord[] {
  const created: ExperimentRecord[] = [];

  // Source 1: Reflections → prompt experiments
  const reflections = getRecentReflections(agentId, 10);
  for (const r of reflections) {
    if (r.improve && r.improve.length > 20) {
      // Check if we already have an experiment from this reflection
      const exists = getOne<{ id: string }>(
        `SELECT id FROM experiment_records WHERE agent_id = ? AND source = 'reflection' AND hypothesis LIKE ? AND status NOT IN ('archived')`,
        [agentId, `%${r.improve.slice(0, 40)}%`]
      );
      if (exists) continue;

      const exp = createExperimentRecord({
        id: generateId(),
        agent_id: agentId,
        experiment_type: 'prompt',
        name: `Test: ${r.improve.slice(0, 50)}`,
        hypothesis: r.improve,
        source: 'reflection',
        source_id: (r as any).id || null,
        control_config: JSON.stringify({ description: 'Current prompt (no change)' }),
        treatment_config: JSON.stringify({ instruction: r.improve, description: r.improve.slice(0, 80) }),
        environment: '{}',
        metric_weights: JSON.stringify(DEFAULT_METRIC_WEIGHTS),
        status: 'queued',
        priority: 3,
        p_value: null,
        effect_size: null,
        control_mean: null,
        treatment_mean: null,
        decision_reason: null,
        cost_spent_usd: 0,
        budget_cap_usd: null,
      });
      if (exp) {
        created.push(exp);
        console.log(`[hypothesis] Created from reflection: "${exp.name}"`);
      }
    }
  }

  // Source 2: Cost analysis → model experiments
  const recentRuns = getAll<{ cost_usd: number; agent_type: string }>(
    `SELECT rm.cost_usd, a.agent_type FROM run_metrics rm JOIN agents a ON rm.agent_id = a.id WHERE rm.agent_id = ? AND rm.cost_usd > 0 ORDER BY rm.created_at DESC LIMIT 10`,
    [agentId]
  );
  if (recentRuns.length >= 5) {
    const avgCost = recentRuns.reduce((s, r) => s + r.cost_usd, 0) / recentRuns.length;
    const currentModel = recentRuns[0]?.agent_type || 'claude-sonnet';

    // If avg cost > $0.50 per run and using an expensive model, suggest downgrade
    if (avgCost > 0.50 && (currentModel === 'claude-opus' || currentModel === 'claude-sonnet')) {
      const cheaperModel = currentModel === 'claude-opus' ? 'claude-sonnet' : 'claude-haiku';
      const existsModel = getOne<{ id: string }>(
        `SELECT id FROM experiment_records WHERE agent_id = ? AND experiment_type = 'model' AND status NOT IN ('archived', 'rolled_back')`,
        [agentId]
      );
      if (!existsModel) {
        const provider = getProvider(cheaperModel);
        const exp = createExperimentRecord({
          id: generateId(),
          agent_id: agentId,
          experiment_type: 'model',
          name: `Cost test: ${currentModel} vs ${cheaperModel}`,
          hypothesis: `Avg cost $${avgCost.toFixed(2)}/run. ${cheaperModel} may produce similar quality at lower cost.`,
          source: 'cost_analysis',
          source_id: null,
          control_config: JSON.stringify({ modelId: currentModel, modelName: getProvider(currentModel).name }),
          treatment_config: JSON.stringify({ modelId: cheaperModel, modelName: provider.name }),
          environment: '{}',
          metric_weights: JSON.stringify({ ...DEFAULT_METRIC_WEIGHTS, cost: 0.35, score: 0.35 }),
          status: 'queued',
          priority: 2,
          p_value: null, effect_size: null, control_mean: null, treatment_mean: null,
          decision_reason: null, cost_spent_usd: 0, budget_cap_usd: 5.0,
        });
        if (exp) {
          created.push(exp);
          console.log(`[hypothesis] Created cost experiment: ${currentModel} vs ${cheaperModel}`);
        }
      }
    }
  }

  // Source 3: Unverified patterns → pattern experiments
  const unverifiedPatterns = getAll<{ id: string; name: string; trigger_condition: string; code_example: string }>(
    `SELECT id, name, trigger_condition, code_example FROM agent_patterns WHERE agent_id = ? AND verified = 0 AND use_count >= 2 ORDER BY use_count DESC LIMIT 2`,
    [agentId]
  );
  for (const p of unverifiedPatterns) {
    const existsPattern = getOne<{ id: string }>(
      `SELECT id FROM experiment_records WHERE agent_id = ? AND experiment_type = 'pattern' AND source_id = ? AND status NOT IN ('archived')`,
      [agentId, p.id]
    );
    if (existsPattern) continue;

    const exp = createExperimentRecord({
      id: generateId(),
      agent_id: agentId,
      experiment_type: 'pattern',
      name: `Verify pattern: ${p.name}`,
      hypothesis: `Pattern "${p.name}" has been used ${2}+ times but never verified. Testing if it improves outcomes.`,
      source: 'improvement',
      source_id: p.id,
      control_config: JSON.stringify({ description: 'Pattern excluded from context' }),
      treatment_config: JSON.stringify({ patternId: p.id, name: p.name, trigger_condition: p.trigger_condition, code_example: p.code_example }),
      environment: '{}',
      metric_weights: JSON.stringify(DEFAULT_METRIC_WEIGHTS),
      status: 'queued',
      priority: 1,
      p_value: null, effect_size: null, control_mean: null, treatment_mean: null,
      decision_reason: null, cost_spent_usd: 0, budget_cap_usd: null,
    });
    if (exp) {
      created.push(exp);
      console.log(`[hypothesis] Created pattern experiment: "${p.name}"`);
    }
  }

  if (created.length > 0) {
    bus.emit('experiment:hypothesis-generated', { agentId, hypothesisCount: created.length });
  }

  return created;
}

// ============================================================================
// Manual Experiment Creation
// ============================================================================

/**
 * Create an experiment manually (from UI or API).
 */
export function proposeExperiment(
  agentId: string,
  type: 'prompt' | 'model' | 'pattern' | 'workflow' | 'fix',
  name: string,
  hypothesis: string,
  controlConfig: Record<string, unknown>,
  treatmentConfig: Record<string, unknown>,
  options?: { environment?: Record<string, unknown>; metricWeights?: Partial<MetricWeights>; budgetCap?: number; autoQueue?: boolean },
): ExperimentRecord | null {
  const exp = createExperimentRecord({
    id: generateId(),
    agent_id: agentId,
    experiment_type: type,
    name,
    hypothesis,
    source: 'manual',
    source_id: null,
    control_config: JSON.stringify(controlConfig),
    treatment_config: JSON.stringify(treatmentConfig),
    environment: JSON.stringify(options?.environment || {}),
    metric_weights: JSON.stringify({ ...DEFAULT_METRIC_WEIGHTS, ...options?.metricWeights }),
    status: options?.autoQueue ? 'queued' : 'proposed',
    priority: 5,
    p_value: null, effect_size: null, control_mean: null, treatment_mean: null,
    decision_reason: null, cost_spent_usd: 0, budget_cap_usd: options?.budgetCap ?? null,
  });

  if (exp && options?.autoQueue) {
    updateExperimentRecord(exp.id, { queued_at: getNow() });
  }

  return exp;
}

/**
 * Cancel a running experiment.
 */
export function cancelExperiment(experimentId: string): void {
  concludeExperiment(experimentId, 'inconclusive', 'Cancelled by user');
}

// ============================================================================
// Dashboard
// ============================================================================

export function getExperimentDashboard(agentId: string): {
  running: ExperimentRecord[];
  queued: ExperimentRecord[];
  recent: ExperimentRecord[];
  stats: { total: number; promoted: number; rolledBack: number; inconclusive: number };
} {
  const running = getRunningExperiments(agentId);
  const queued = getQueuedExperiments(agentId);
  const recent = getAll<ExperimentRecord>(
    `SELECT * FROM experiment_records WHERE agent_id = ? AND status IN ('promoted', 'rolled_back', 'inconclusive') ORDER BY concluded_at DESC LIMIT 10`,
    [agentId]
  );

  const stats = getOne<{ total: number; promoted: number; rolled_back: number; inconclusive: number }>(
    `SELECT COUNT(*) as total,
     SUM(CASE WHEN status = 'promoted' THEN 1 ELSE 0 END) as promoted,
     SUM(CASE WHEN status = 'rolled_back' THEN 1 ELSE 0 END) as rolled_back,
     SUM(CASE WHEN status = 'inconclusive' THEN 1 ELSE 0 END) as inconclusive
     FROM experiment_records WHERE agent_id = ?`,
    [agentId]
  );

  return {
    running, queued, recent,
    stats: {
      total: stats?.total ?? 0,
      promoted: stats?.promoted ?? 0,
      rolledBack: stats?.rolled_back ?? 0,
      inconclusive: stats?.inconclusive ?? 0,
    },
  };
}
