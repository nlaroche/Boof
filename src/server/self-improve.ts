import { runQuery, getOne, getAll, generateId, getNow } from './db-helpers.js';
import type { Assessment, Improvement, Agent, Command, XpEvent, RunMetric, Reflection, Skill, PromptVersion, Experiment, DashboardData } from '../client/lib/types.js';

// ── XP & Leveling ──

export function getLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 5)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) * (level - 1) * 5;
}

// ── Performance Assessment ──

interface AssessContext {
  retries: number;
  buildFailures: number;
  reviewIssues: number;
  filesTouched: number;
  durationMs: number;
  completedFully: boolean;
  testFailures?: number;
}

export function assessPerformance(
  agentId: string,
  commandId: string,
  context: AssessContext
): Assessment {
  const score = Math.max(0, Math.min(100,
    100
    - (context.retries * 15)
    - (context.buildFailures * 20)
    - (context.reviewIssues * 10)
    - Math.max(0, context.filesTouched - 5) * 2
    - (context.testFailures || 0) * 10
  ));

  const id = generateId();
  const now = new Date().toISOString();

  runQuery(
    `INSERT INTO assessments (id, agent_id, command_id, score, retries, build_failures, review_issues, files_touched, duration_ms, completed_fully, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, agentId, commandId, score, context.retries, context.buildFailures, context.reviewIssues, context.filesTouched, context.durationMs, context.completedFully ? 1 : 0, now]
  );

  const assessment = getOne<Assessment>('SELECT * FROM assessments WHERE id = ?', [id]);
  return assessment!;
}

// ── Run Metrics ──

interface RunMetricInput {
  agentId: string;
  commandId?: string;
  goalId?: string;
  taskId?: string;
  durationMs: number;
  retries: number;
  buildFailures: number;
  filesTouched: number;
  promptTokens: number;
  completionTokens: number;
  success: boolean;
  errorType?: string;
  promptVersionId?: string;
  mergeSuccess?: boolean;
}

export function persistRunMetrics(input: RunMetricInput): RunMetric {
  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    `INSERT INTO run_metrics (id, agent_id, command_id, goal_id, task_id, duration_ms, retries, build_failures, files_touched, prompt_tokens, completion_tokens, success, error_type, prompt_version_id, merge_success, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.agentId, input.commandId || null, input.goalId || null, input.taskId || null,
     input.durationMs, input.retries, input.buildFailures, input.filesTouched,
     input.promptTokens, input.completionTokens, input.success ? 1 : 0,
     input.errorType || null, input.promptVersionId || null,
     input.mergeSuccess !== undefined ? (input.mergeSuccess ? 1 : 0) : null, now]
  );
  return getOne<RunMetric>('SELECT * FROM run_metrics WHERE id = ?', [id])!;
}

export function updateRunMetricMerge(agentId: string, goalId: string, taskId: string, mergeSuccess: boolean): void {
  // Update the most recent run_metric for this agent/task with merge outcome
  const metric = getOne<RunMetric>(
    'SELECT * FROM run_metrics WHERE agent_id = ? AND goal_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1',
    [agentId, goalId, taskId]
  );
  if (metric) {
    runQuery('UPDATE run_metrics SET merge_success = ? WHERE id = ?', [mergeSuccess ? 1 : 0, metric.id]);
  }
}

// ── Reflections ──

export function storeReflection(agentId: string, commandId: string | null, went_well: string, improve: string, pattern: string): Reflection {
  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    `INSERT INTO reflections (id, agent_id, command_id, went_well, improve, pattern, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, agentId, commandId || null, went_well, improve, pattern, now]
  );
  return getOne<Reflection>('SELECT * FROM reflections WHERE id = ?', [id])!;
}

export function getRecentReflections(agentId: string, limit: number = 5): Reflection[] {
  return getAll<Reflection>(
    'SELECT * FROM reflections WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
    [agentId, limit]
  );
}

interface ReflectionContext {
  taskTitle: string;
  score: number;
  buildOutput: string;
  diffStats: string;
  errors: string[];
}

export function buildReflectionPrompt(context?: ReflectionContext): string {
  let prompt = '';
  if (context) {
    prompt += `You just completed task: "${context.taskTitle}" (score: ${context.score}/100)\n`;
    if (context.errors.length > 0) {
      prompt += `Errors encountered:\n${context.errors.slice(0, 5).map(e => `- ${e}`).join('\n')}\n`;
    }
    if (context.diffStats) {
      prompt += `Changes made:\n${context.diffStats}\n`;
    }
    if (context.buildOutput) {
      prompt += `Build output (last 500 chars):\n${context.buildOutput.slice(-500)}\n`;
    }
    prompt += '\n';
  }
  prompt += `Reflect on what you just did. In 2-3 sentences:
1. What went well?
2. What could be improved?
3. Any reusable pattern worth remembering?
Output as JSON only (no markdown, no code fences): { "went_well": "...", "improve": "...", "pattern": "..." }`;
  return prompt;
}

export function parseReflectionResponse(output: string): { went_well: string; improve: string; pattern: string } | null {
  // Strip ANSI and find JSON
  const clean = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // Try to extract JSON from the output
  const jsonMatch = clean.match(/\{[^{}]*"went_well"[^{}]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      went_well: String(parsed.went_well || ''),
      improve: String(parsed.improve || ''),
      pattern: String(parsed.pattern || ''),
    };
  } catch {
    return null;
  }
}

// ── Skill Library ──

export function extractSkillsFromOutput(output: string): { name: string; description: string; code_snippet: string; tags: string[] }[] {
  const clean = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  // Try to find JSON array in the output
  const arrayMatch = clean.match(/\[[\s\S]*?\]/);
  if (!arrayMatch) return [];

  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s: any) => s && s.name)
      .slice(0, 2)
      .map((s: any) => ({
        name: String(s.name || ''),
        description: String(s.description || ''),
        code_snippet: String(s.code_snippet || ''),
        tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
      }));
  } catch {
    return [];
  }
}

export function saveSkill(agentId: string, name: string, description: string, codeSnippet: string, tags: string[]): Skill {
  // Check for existing skill with same name
  const existing = getOne<Skill>(
    'SELECT * FROM skills WHERE agent_id = ? AND name = ?',
    [agentId, name]
  );

  const now = new Date().toISOString();
  if (existing) {
    // Update existing
    runQuery(
      'UPDATE skills SET description = ?, code_snippet = ?, tags = ?, updated_at = ? WHERE id = ?',
      [description, codeSnippet, JSON.stringify(tags), now, existing.id]
    );
    return getOne<Skill>('SELECT * FROM skills WHERE id = ?', [existing.id])!;
  }

  const id = generateId();
  runQuery(
    `INSERT INTO skills (id, agent_id, name, description, code_snippet, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, agentId, name, description, codeSnippet, JSON.stringify(tags), now, now]
  );
  return getOne<Skill>('SELECT * FROM skills WHERE id = ?', [id])!;
}

export function getMatchingSkills(agentId: string, taskDescription: string, limit: number = 3): Skill[] {
  // Simple keyword matching — extract words from task, match against skill tags/description
  const words = taskDescription.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  if (words.length === 0) return [];

  const allSkills = getAll<Skill>(
    'SELECT * FROM skills WHERE agent_id = ? ORDER BY times_succeeded DESC, avg_score DESC',
    [agentId]
  );

  // Score each skill by keyword overlap
  const scored = allSkills.map(skill => {
    const skillText = `${skill.name} ${skill.description} ${skill.tags}`.toLowerCase();
    const matches = words.filter(w => skillText.includes(w)).length;
    return { skill, matches };
  });

  return scored
    .filter(s => s.matches > 0)
    .sort((a, b) => b.matches - a.matches)
    .slice(0, limit)
    .map(s => s.skill);
}

export function updateSkillUsage(skillId: string, succeeded: boolean, score: number): void {
  const skill = getOne<Skill>('SELECT * FROM skills WHERE id = ?', [skillId]);
  if (!skill) return;

  const timesUsed = skill.times_used + 1;
  const timesSucceeded = skill.times_succeeded + (succeeded ? 1 : 0);
  // Exponential moving average for score
  const alpha = 0.3;
  const avgScore = skill.avg_score > 0 ? skill.avg_score * (1 - alpha) + score * alpha : score;
  const now = new Date().toISOString();

  runQuery(
    'UPDATE skills SET times_used = ?, times_succeeded = ?, avg_score = ?, updated_at = ? WHERE id = ?',
    [timesUsed, timesSucceeded, avgScore, now, skillId]
  );
}

export function getAgentSkills(agentId: string): Skill[] {
  return getAll<Skill>(
    'SELECT * FROM skills WHERE agent_id = ? ORDER BY times_succeeded DESC, avg_score DESC',
    [agentId]
  );
}

export function buildSkillExtractionPrompt(): string {
  return `Based on what you just did, extract 0-2 reusable skills.
A skill is a specific technique, pattern, or code snippet that could help in future tasks.
Output as JSON array only (no markdown, no code fences): [{ "name": "...", "description": "...", "code_snippet": "...", "tags": ["..."] }]
Return [] if nothing is worth saving.`;
}

// ── Prompt Versioning ──

export function getActivePromptVersion(agentId: string): PromptVersion | null {
  return getOne<PromptVersion>(
    'SELECT * FROM prompt_versions WHERE agent_id = ? AND is_active = 1 ORDER BY version DESC LIMIT 1',
    [agentId]
  );
}

export function seedPromptVersion(agentId: string, template: string): PromptVersion {
  const existing = getOne<PromptVersion>(
    'SELECT * FROM prompt_versions WHERE agent_id = ? LIMIT 1',
    [agentId]
  );
  if (existing) return existing;

  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    'INSERT INTO prompt_versions (id, agent_id, version, template, is_active, created_at) VALUES (?, ?, 1, ?, 1, ?)',
    [id, agentId, template, now]
  );
  return getOne<PromptVersion>('SELECT * FROM prompt_versions WHERE id = ?', [id])!;
}

export function createPromptVersion(agentId: string, template: string, activate: boolean = false): PromptVersion {
  const latest = getOne<{ max_v: number }>('SELECT MAX(version) as max_v FROM prompt_versions WHERE agent_id = ?', [agentId]);
  const nextVersion = (latest?.max_v || 0) + 1;

  if (activate) {
    runQuery('UPDATE prompt_versions SET is_active = 0 WHERE agent_id = ?', [agentId]);
  }

  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    'INSERT INTO prompt_versions (id, agent_id, version, template, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, agentId, nextVersion, template, activate ? 1 : 0, now]
  );
  return getOne<PromptVersion>('SELECT * FROM prompt_versions WHERE id = ?', [id])!;
}

export function updatePromptVersionStats(versionId: string, score: number): void {
  const pv = getOne<PromptVersion>('SELECT * FROM prompt_versions WHERE id = ?', [versionId]);
  if (!pv) return;

  const totalRuns = pv.total_runs + 1;
  const avgScore = (pv.avg_score * pv.total_runs + score) / totalRuns;
  runQuery(
    'UPDATE prompt_versions SET total_runs = ?, avg_score = ? WHERE id = ?',
    [totalRuns, avgScore, versionId]
  );
}

export function shouldOptimizePrompt(agentId: string): boolean {
  // Check if we've done 10+ runs since last prompt version
  const activeVersion = getActivePromptVersion(agentId);
  if (!activeVersion) return false;
  return activeVersion.total_runs >= 10 && activeVersion.total_runs % 10 === 0;
}

export function buildPromptOptimizationMeta(reflections: Reflection[], currentTemplate: string): string {
  const reflectionSummary = reflections.map(r =>
    `- Well: ${r.went_well} | Improve: ${r.improve} | Pattern: ${r.pattern}`
  ).join('\n');

  return `You are optimizing an agent's autopilot prompt template.

Current template:
---
${currentTemplate}
---

Recent reflections from runs using this template:
${reflectionSummary}

Suggest an improved version of the template that addresses the improvement areas while keeping what works well.
Output the improved template ONLY, no explanation, no markdown fences. Keep RULES section intact. Keep it concise.`;
}

// ── Experiments ──

export function getActiveExperiments(agentId: string): Experiment[] {
  return getAll<Experiment>(
    "SELECT * FROM experiments WHERE agent_id = ? AND status = 'running'",
    [agentId]
  );
}

export function getAllExperiments(agentId: string): Experiment[] {
  return getAll<Experiment>(
    'SELECT * FROM experiments WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20',
    [agentId]
  );
}

export function createExperiment(agentId: string, name: string, hypothesis: string, variantA: string, variantB: string, metric: string = 'score'): Experiment {
  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    `INSERT INTO experiments (id, agent_id, name, hypothesis, variant_a, variant_b, metric, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, agentId, name, hypothesis, variantA, variantB, metric, now]
  );
  return getOne<Experiment>('SELECT * FROM experiments WHERE id = ?', [id])!;
}

export function pickExperimentVariant(experiment: Experiment): 'a' | 'b' {
  // Alternate between A and B
  return experiment.runs_a <= experiment.runs_b ? 'a' : 'b';
}

export function recordExperimentResult(experimentId: string, variant: 'a' | 'b', metricValue: number): void {
  const exp = getOne<Experiment>('SELECT * FROM experiments WHERE id = ?', [experimentId]);
  if (!exp) return;

  if (variant === 'a') {
    const newRuns = exp.runs_a + 1;
    const newAvg = (exp.avg_metric_a * exp.runs_a + metricValue) / newRuns;
    runQuery(
      'UPDATE experiments SET runs_a = ?, avg_metric_a = ? WHERE id = ?',
      [newRuns, newAvg, experimentId]
    );
  } else {
    const newRuns = exp.runs_b + 1;
    const newAvg = (exp.avg_metric_b * exp.runs_b + metricValue) / newRuns;
    runQuery(
      'UPDATE experiments SET runs_b = ?, avg_metric_b = ? WHERE id = ?',
      [newRuns, newAvg, experimentId]
    );
  }

  // Check if experiment should conclude (5 runs each)
  const updated = getOne<Experiment>('SELECT * FROM experiments WHERE id = ?', [experimentId])!;
  if (updated.runs_a >= 5 && updated.runs_b >= 5) {
    const winner = updated.avg_metric_a >= updated.avg_metric_b ? 'a' : 'b';
    const now = new Date().toISOString();
    runQuery(
      "UPDATE experiments SET status = 'completed', winner = ?, completed_at = ? WHERE id = ?",
      [winner, now, experimentId]
    );
  }
}

// ── Adaptive Task Selection ──

export function scoreTask(
  agentId: string,
  task: { title: string; description: string; id: string },
  priority: number = 0
): number {
  const taskText = `${task.title} ${task.description}`.toLowerCase();

  // Skill match bonus: check if agent has skills matching task keywords
  const skills = getAll<Skill>('SELECT * FROM skills WHERE agent_id = ?', [agentId]);
  let skillBonus = 0;
  for (const skill of skills) {
    const skillText = `${skill.name} ${skill.description} ${skill.tags}`.toLowerCase();
    const taskWords = taskText.split(/\W+/).filter(w => w.length > 3);
    const matches = taskWords.filter(w => skillText.includes(w)).length;
    if (matches > 0) {
      skillBonus += matches * 2 * (skill.avg_score / 100 || 0.5);
    }
  }

  // Failure penalty: check how many times this task was attempted and failed
  const failedAttempts = getAll<RunMetric>(
    'SELECT * FROM run_metrics WHERE agent_id = ? AND task_id = ? AND success = 0',
    [agentId, task.id]
  );
  const failurePenalty = Math.min(failedAttempts.length * 5, 20);

  // Complexity estimate: longer descriptions = more complex
  const complexityPenalty = Math.max(0, (task.description?.length || 0) / 500);

  return priority + skillBonus - failurePenalty - complexityPenalty;
}

export function rankTasks(
  agentId: string,
  tasks: { title: string; description: string; id: string }[]
): { title: string; description: string; id: string }[] {
  const scored = tasks.map(task => ({
    task,
    score: scoreTask(agentId, task),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.task);
}

// ── Dashboard ──

export function getDashboardData(agentId: string): DashboardData {
  // Success rates
  const all = getAll<RunMetric>('SELECT success FROM run_metrics WHERE agent_id = ? ORDER BY created_at DESC', [agentId]);
  const last10 = all.slice(0, 10);
  const last50 = all.slice(0, 50);

  const successRate = (items: RunMetric[]) =>
    items.length > 0 ? Math.round(items.filter(r => r.success).length / items.length * 100) : 0;

  // Score trend (last 10 assessments)
  const scores = getAll<{ score: number }>('SELECT score FROM assessments WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10', [agentId]);
  const avgScoreTrend = scores.map(s => s.score).reverse();

  // Duration trend (last 10 runs)
  const durations = getAll<{ duration_ms: number }>('SELECT duration_ms FROM run_metrics WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10', [agentId]);
  const avgDurationTrend = durations.map(d => d.duration_ms).reverse();

  // Total tokens
  const tokenSum = getOne<{ total: number }>('SELECT SUM(prompt_tokens + completion_tokens) as total FROM run_metrics WHERE agent_id = ?', [agentId]);

  // Skills count
  const skillCount = getOne<{ c: number }>('SELECT COUNT(*) as c FROM skills WHERE agent_id = ?', [agentId]);

  // Top error types
  const errors = getAll<{ error_type: string; cnt: number }>(
    'SELECT error_type, COUNT(*) as cnt FROM run_metrics WHERE agent_id = ? AND error_type IS NOT NULL GROUP BY error_type ORDER BY cnt DESC LIMIT 5',
    [agentId]
  );

  // XP per day (last 7 days)
  const xpDays = getAll<{ date: string; xp: number }>(
    `SELECT DATE(created_at) as date, SUM(amount) as xp FROM xp_events
     WHERE agent_id = ? AND created_at >= DATE('now', '-7 days')
     GROUP BY DATE(created_at) ORDER BY date`,
    [agentId]
  );

  // Recent reflections
  const reflections = getRecentReflections(agentId, 3);

  // Merge success rate
  const mergeAttempts = getAll<{ merge_success: number }>(
    'SELECT merge_success FROM run_metrics WHERE agent_id = ? AND merge_success IS NOT NULL',
    [agentId]
  );
  const mergeSuccessRate = mergeAttempts.length > 0
    ? Math.round(mergeAttempts.filter(r => r.merge_success).length / mergeAttempts.length * 100)
    : 0;

  return {
    success_rate_10: successRate(last10),
    success_rate_50: successRate(last50),
    success_rate_all: successRate(all),
    merge_success_rate: mergeSuccessRate,
    avg_duration_trend: avgDurationTrend,
    avg_score_trend: avgScoreTrend,
    total_tokens: tokenSum?.total || 0,
    skills_count: skillCount?.c || 0,
    top_errors: errors.map(e => ({ type: e.error_type, count: e.cnt })),
    xp_per_day: xpDays,
    recent_reflections: reflections,
  };
}

// ── Identify Improvements ──

export function identifyImprovements(
  agentId: string,
  assessmentId: string,
  rawOutput: string,
  prompt: string,
  score: number,
  retries: number
): Improvement[] {
  // Only generate improvements for imperfect runs
  if (score >= 90 && retries === 0) return [];

  const improvements: Improvement[] = [];
  const now = new Date().toISOString();

  // Analyze output for common patterns
  const patterns: { test: RegExp; description: string; category: Improvement['category'] }[] = [
    { test: /error TS\d+/i, description: 'Fix TypeScript type errors in generated code', category: 'build' },
    { test: /Cannot find module/i, description: 'Ensure imports resolve correctly', category: 'build' },
    { test: /ENOENT|no such file/i, description: 'Verify file paths before editing', category: 'workflow' },
    { test: /retry|retrying/i, description: 'Reduce build retries by validating changes incrementally', category: 'build' },
    { test: /parse error|JSON\.parse/i, description: 'Improve output parser robustness', category: 'parser' },
    { test: /timeout|timed out/i, description: 'Optimize task prompts for faster completion', category: 'prompt' },
  ];

  const cleanOutput = rawOutput.slice(-3000);
  for (const pattern of patterns) {
    if (pattern.test.test(cleanOutput) && improvements.length < 3) {
      const id = generateId();
      runQuery(
        `INSERT INTO improvements (id, agent_id, assessment_id, description, category, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [id, agentId, assessmentId, pattern.description, pattern.category, now]
      );
      const imp = getOne<Improvement>('SELECT * FROM improvements WHERE id = ?', [id]);
      if (imp) improvements.push(imp);
    }
  }

  // Generic improvement if retries happened but no specific pattern matched
  if (improvements.length === 0 && retries > 0) {
    const id = generateId();
    const desc = `Task required ${retries} retries — review error patterns for preventive fixes`;
    runQuery(
      `INSERT INTO improvements (id, agent_id, assessment_id, description, category, status, created_at)
       VALUES (?, ?, ?, ?, 'workflow', 'pending', ?)`,
      [id, agentId, assessmentId, desc, now]
    );
    const imp = getOne<Improvement>('SELECT * FROM improvements WHERE id = ?', [id]);
    if (imp) improvements.push(imp);
  }

  // Update assessment with improvements list
  if (improvements.length > 0) {
    const improvementIds = JSON.stringify(improvements.map(i => i.id));
    runQuery('UPDATE assessments SET improvements = ? WHERE id = ?', [improvementIds, assessmentId]);
  }

  return improvements;
}

// ── Award XP ──

export function awardXp(agentId: string, amount: number, reason: string = 'Task completed', source: string = 'manual'): { newXp: number; event: XpEvent } {
  const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  const oldXp = agent?.xp || 0;
  const newXp = oldXp + amount;
  runQuery('UPDATE agents SET xp = ? WHERE id = ?', [newXp, agentId]);

  const eventId = generateId();
  const now = new Date().toISOString();
  runQuery(
    'INSERT INTO xp_events (id, agent_id, amount, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [eventId, agentId, amount, reason, source, now]
  );

  const event: XpEvent = { id: eventId, agent_id: agentId, amount, reason, source, created_at: now };
  return { newXp, event };
}

export function getAgentXpEvents(agentId: string): XpEvent[] {
  return getAll<XpEvent>(
    'SELECT * FROM xp_events WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100',
    [agentId]
  );
}

// ── Skip / Complete Improvement ──

export function skipImprovement(improvementId: string): Improvement | null {
  const now = new Date().toISOString();
  runQuery('UPDATE improvements SET status = ?, completed_at = ? WHERE id = ?', ['skipped', now, improvementId]);
  return getOne<Improvement>('SELECT * FROM improvements WHERE id = ?', [improvementId]);
}

export function completeImprovement(improvementId: string, xpAmount: number): Improvement | null {
  const now = new Date().toISOString();
  runQuery('UPDATE improvements SET status = ?, xp_awarded = ?, completed_at = ? WHERE id = ?', ['completed', xpAmount, now, improvementId]);
  return getOne<Improvement>('SELECT * FROM improvements WHERE id = ?', [improvementId]);
}

export function failImprovement(improvementId: string): Improvement | null {
  const now = new Date().toISOString();
  runQuery('UPDATE improvements SET status = ?, completed_at = ? WHERE id = ?', ['failed', now, improvementId]);
  return getOne<Improvement>('SELECT * FROM improvements WHERE id = ?', [improvementId]);
}

export function markImprovementRunning(improvementId: string): Improvement | null {
  runQuery('UPDATE improvements SET status = ? WHERE id = ?', ['running', improvementId]);
  return getOne<Improvement>('SELECT * FROM improvements WHERE id = ?', [improvementId]);
}

// ── Fetch helpers ──

export function getAgentImprovements(agentId: string): Improvement[] {
  return getAll<Improvement>(
    'SELECT * FROM improvements WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50',
    [agentId]
  );
}

export function getAgentAssessments(agentId: string): Assessment[] {
  return getAll<Assessment>(
    'SELECT * FROM assessments WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50',
    [agentId]
  );
}
