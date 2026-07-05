/**
 * Prompt builder — all agent-facing prompt templates.
 *
 * Two main prompts:
 * - buildAutopilotPrompt(): for implementation runs (task execution)
 * - buildPlanningPrompt(): for goal decomposition into tasks
 *
 * Extracted from autopilot.ts for modularity.
 */
import { getAll } from '../db-helpers.js';
import {
  getActivePromptVersion, seedPromptVersion, getRecentReflections,
  getMatchingSkills, getActiveExperiments, pickExperimentVariant,
} from '../self-improve.js';
import { getAndApplyVariant } from './experiment-loop.js';
import { buildRepoMap, formatRepoMap } from './repo-map.js';
import type { Goal, GoalLogEntry, Improvement, Skill } from '../../client/lib/types.js';

// ── Per-run State (set during prompt build, read after run) ──
// Keyed by agentId so concurrent agents don't clobber each other's attribution
// (M7 — module globals raced across agents and corrupted A/B + skill tracking).

/** Skills matched during the last prompt build — used for usage tracking */
const _lastMatchedSkills = new Map<string, Skill[]>();
export function getLastMatchedSkills(agentId: string): Skill[] { return _lastMatchedSkills.get(agentId) ?? []; }
export function clearLastMatchedSkills(agentId: string): void { _lastMatchedSkills.delete(agentId); }

/** Experiment variant picked during the last prompt build */
const _currentExperimentPick = new Map<string, { experimentId: string; variant: 'a' | 'b' }>();
export function getCurrentExperimentPick(agentId: string) { return _currentExperimentPick.get(agentId) ?? null; }
export function clearCurrentExperimentPick(agentId: string): void { _currentExperimentPick.delete(agentId); }

// ── Implementation Prompt ──

/**
 * Build the prompt for an implementation run (agent executes a specific task).
 */
export function buildAutopilotPrompt(
  goal: Goal,
  recentLogs: GoalLogEntry[],
  pendingTasks: { title: string; description: string }[],
  memoryContext: string,
  agentId: string,
  currentTaskDescription?: string,
): string {
  const activeVersion = getActivePromptVersion(agentId);

  // Closed-loop experiment system: check for active experiments
  _currentExperimentPick.delete(agentId);
  let experimentPromptInjection = '';
  const experimentResult = getAndApplyVariant(agentId, { agentId, goalId: goal.id });
  if (experimentResult) {
    _currentExperimentPick.set(agentId, {
      experimentId: experimentResult.experimentId,
      variant: experimentResult.variant === 'control' ? 'a' : 'b',
    });
    if (experimentResult.application.promptModification) {
      experimentPromptInjection = experimentResult.application.promptModification + '\n';
    }
  } else {
    // Fallback: old-style experiments for backward compat
    const activeExperiments = getActiveExperiments(agentId);
    const promptExperiment = activeExperiments.find(e => e.metric === 'score' && e.variant_a && e.variant_b);
    if (promptExperiment) {
      const variant = pickExperimentVariant(promptExperiment);
      _currentExperimentPick.set(agentId, { experimentId: promptExperiment.id, variant });
    }
  }

  let prompt = '';

  // Experiment prompt injection (must come after prompt is declared)
  if (experimentPromptInjection) {
    prompt += experimentPromptInjection;
  }

  // Memory context
  if (memoryContext) {
    prompt += memoryContext;
  }

  // Pending improvements
  const pendingImprovements = getAll<Improvement>(
    "SELECT * FROM improvements WHERE agent_id = ? AND status = 'pending' LIMIT 3",
    [agentId]
  );
  if (pendingImprovements.length > 0) {
    prompt += 'AREAS TO IMPROVE:\n';
    for (const imp of pendingImprovements) {
      prompt += `- [${imp.category}] ${imp.description}\n`;
    }
    prompt += '\n';
  }

  // Recent reflections
  const reflections = getRecentReflections(agentId, 5);
  if (reflections.length > 0) {
    prompt += 'LESSONS FROM RECENT RUNS:\n';
    for (const r of reflections) {
      if (r.went_well) prompt += `- Worked well: ${r.went_well}\n`;
      if (r.improve) prompt += `- To improve: ${r.improve}\n`;
      if (r.pattern) prompt += `- Pattern: ${r.pattern}\n`;
    }
    prompt += '\n';
  }

  // Matching skills
  if (currentTaskDescription) {
    const matchedSkills = getMatchingSkills(agentId, currentTaskDescription, 3);
    if (matchedSkills.length > 0) {
      prompt += 'AVAILABLE SKILLS:\n';
      for (const skill of matchedSkills) {
        prompt += `- ${skill.name}: ${skill.description}\n`;
        if (skill.code_snippet) {
          prompt += `  Snippet: ${skill.code_snippet.slice(0, 200)}\n`;
        }
      }
      prompt += '\n';
      _lastMatchedSkills.set(agentId, matchedSkills);
    }
  }

  // Goal context
  prompt += `You are working autonomously on this goal: "${goal.name}"\n`;
  prompt += `Description: ${goal.description || 'No description provided.'}\n`;
  prompt += `IMPORTANT: Stay focused on this specific goal. Do not work on unrelated improvements.\n\n`;

  // Recent progress
  if (recentLogs.length > 0) {
    prompt += `Recent progress:\n`;
    for (const log of recentLogs) {
      const status = log.success ? 'OK' : 'FAILED';
      prompt += `- [${status}] ${log.action}: ${log.summary}\n`;
    }
    prompt += '\n';
  }

  // Rules
  prompt += `RULES:\n`;
  prompt += `1. Make SMALL, focused changes — edit 1-3 files max per run.\n`;
  prompt += `2. After making changes, ALWAYS run the build.\n`;
  prompt += `3. If the build fails, fix the errors before finishing.\n`;
  prompt += `4. Run tests after changes.\n`;
  prompt += `5. Keep your changes focused and testable.\n`;
  prompt += `6. RESEARCH FIRST: For unfamiliar topics, use WebSearch/WebFetch to learn before coding.\n\n`;

  // Task assignment
  if (pendingTasks.length === 0) {
    prompt += `There are no pending tasks. Research the codebase and pick ONE small improvement related to the goal.\n`;
    prompt += `Implement it, verify the build and tests pass, and you're done.\n`;
  } else {
    const assigned = pendingTasks[0];
    prompt += `YOUR TASK: ${assigned.title}\n`;
    prompt += `DESCRIPTION: ${assigned.description || 'No description.'}\n`;
    if ((assigned as any).done_when) {
      prompt += `DONE WHEN: ${(assigned as any).done_when}\n`;
    } else {
      prompt += `DONE WHEN: Build passes, tests pass, changes match the task description.\n`;
    }
    prompt += `\nDo NOT work on anything else. Focus only on this task.\n`;
  }

  // Seed prompt version if first run
  if (!activeVersion) {
    seedPromptVersion(agentId, prompt);
  }

  return prompt;
}

// ── Planning Prompt ──

/**
 * Build the prompt for goal decomposition (agent creates tasks from a goal).
 */
export function buildPlanningPrompt(
  goal: Goal,
  memoryContext: string,
  repoPath: string,
  existingTasks: { title: string }[],
): string {
  let prompt = '';

  if (memoryContext) {
    prompt += memoryContext;
  }

  // Repo map for codebase understanding
  try {
    const repoMap = buildRepoMap(repoPath, 15);
    const mapText = formatRepoMap(repoMap, 15);
    if (mapText) {
      prompt += `${mapText}\n`;
    }
  } catch { /* skip if repo map fails */ }

  prompt += `Planning tasks for goal: "${goal.name}"\n${goal.description || 'No description.'}\n\n`;

  // Existing tasks (prevent duplicates)
  if (existingTasks.length > 0) {
    prompt += `EXISTING TASKS (do NOT duplicate these):\n`;
    for (const t of existingTasks) {
      prompt += `- ${t.title}\n`;
    }
    prompt += '\n';
  }

  // Dynamic task count
  const descLength = (goal.description || '').length;
  const estimatedComplexity = descLength < 50 ? 'simple' : descLength < 200 ? 'moderate' : 'complex';
  const taskCountGuide = estimatedComplexity === 'simple' ? '1-3' : estimatedComplexity === 'moderate' ? '3-5' : '5-8';

  prompt += `This goal is estimated as ${estimatedComplexity}. Propose ${taskCountGuide} tasks.\n`;
  prompt += `Use the repo map above to understand existing patterns and module boundaries.\n`;
  prompt += `Order tasks by dependency — earlier tasks should not depend on later ones.\n\n`;

  prompt += `Before planning, consider:\n`;
  prompt += `- What existing code/patterns can be reused? (check the repo map)\n`;
  prompt += `- Will this introduce duplication? How to avoid it?\n`;
  prompt += `- Are there tests that need updating?\n`;
  prompt += `- What's the right module boundary for new code?\n\n`;

  prompt += `FORMAT (one per line):\nTASK: <title> | <description with file names> | DONE_WHEN: <specific testable condition>\n\n`;
  prompt += `Examples:\n`;
  prompt += `TASK: Add rate limiter to API | Create src/server/rate-limiter.ts with sliding window counter | DONE_WHEN: build passes, rate limiter rejects requests over 100/min in test\n`;
  prompt += `TASK: Extract git helpers | Move branch functions from autopilot.ts to src/server/systems/git-ops.ts | DONE_WHEN: build passes, all imports updated, no dead code in autopilot.ts\n\n`;
  prompt += `Each task = 1 run (1-3 file edits). Name exact files. Plan only, don't implement.\n`;

  return prompt;
}
