/**
 * Research agent system — investigates best practices before implementation.
 *
 * Runs a cheap model (with WebSearch/WebFetch tools) to research:
 * - API documentation and usage patterns
 * - Best practices for the task's domain
 * - Examples from other projects
 * - Common pitfalls and gotchas
 *
 * Research is opportunistic and not on the critical path, so it defaults to a
 * cheap provider rather than an Opus-priced one unless the agent explicitly
 * configures a research-role model.
 *
 * Research results are stored in task_research and injected into
 * the implementation prompt so the coding agent has context.
 */
import { runQuery, getOne, getAll, generateId, getNow } from '../db-helpers.js';
import { createAgent, sendToAgent, hasAgent, killAgent } from '../pty-manager.js';
import { AgentRole } from '../engine/constants.js';
import type { Agent, TaskResearch } from '../../client/lib/types.js';

/** Cheap default model for research runs (overridden by an explicit research-role config). */
const DEFAULT_RESEARCH_MODEL = 'qwen3-flash';

/**
 * Resolve the model for a research run. Prefers an explicit research-role model
 * from the agent's model_config, but otherwise defaults to a cheap model — NOT
 * the agent's implementation model, which may be Opus-priced.
 */
function resolveResearchModel(agent: Agent): string {
  if (agent.model_config) {
    try {
      const config = JSON.parse(agent.model_config);
      if (config[AgentRole.RESEARCH]) return config[AgentRole.RESEARCH];
    } catch { /* invalid JSON — fall through to cheap default */ }
  }
  return DEFAULT_RESEARCH_MODEL;
}

// ── Research Execution ──

/**
 * Run research for a task before implementation.
 * Spawns a Claude Opus agent with WebSearch to investigate best practices.
 * Returns the research findings or null if research was skipped/failed.
 */
export async function researchForTask(
  taskId: string,
  taskTitle: string,
  taskDescription: string,
  repoContext: string,
  agent: Agent,
  broadcast: (msg: any) => void,
): Promise<TaskResearch | null> {
  // Check if research already exists for this task
  const existing = getOne<TaskResearch>(
    'SELECT * FROM task_research WHERE task_id = ?',
    [taskId]
  );
  if (existing) {
    console.log(`[research] Using cached research for task ${taskId}`);
    return existing;
  }

  const researchModel = resolveResearchModel(agent);
  const prompt = buildResearchPrompt(taskTitle, taskDescription, repoContext);
  const researchAgentId = `research-${taskId.slice(0, 8)}`;

  console.log(`[research] Researching: "${taskTitle}" using ${researchModel}`);
  broadcast({ type: 'agent:output', agentId: agent.id, chunk: `\n[research] Researching best practices for: ${taskTitle}...\n` });

  const startTime = Date.now();

  try {
    const output = await new Promise<string>((resolve) => {
      let buf = '';
      if (hasAgent(researchAgentId)) killAgent(researchAgentId);

      const handleOutput = (_id: string, chunk: string) => { buf += chunk; };
      const handleExit = (_id: string, _code: number) => { resolve(buf); };

      createAgent(researchAgentId, agent.working_directory, 'Research Agent', handleOutput, handleExit, researchModel);
      sendToAgent(researchAgentId, prompt, { skipWrap: true });
    });

    if (hasAgent(researchAgentId)) killAgent(researchAgentId);

    const durationMs = Date.now() - startTime;
    const parsed = parseResearchOutput(output);

    // Store in DB
    const id = generateId();
    const now = getNow();
    runQuery(
      `INSERT INTO task_research (id, task_id, agent_id, query, findings, sources, recommendations, duration_ms, tokens_used, model_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, taskId, agent.id, taskTitle, parsed.findings, JSON.stringify(parsed.sources), JSON.stringify(parsed.recommendations),
       durationMs, 0, researchModel, now]
    );

    const result = getOne<TaskResearch>('SELECT * FROM task_research WHERE id = ?', [id]);
    console.log(`[research] Completed in ${durationMs}ms: ${parsed.sources.length} sources, ${parsed.recommendations.length} recommendations`);
    broadcast({ type: 'agent:output', agentId: agent.id, chunk: `[research] Found ${parsed.sources.length} sources, ${parsed.recommendations.length} recommendations\n` });

    return result;
  } catch (err: any) {
    console.error(`[research] Error:`, err.message || err);
    if (hasAgent(researchAgentId)) killAgent(researchAgentId);
    return null;
  }
}

// ── Research Prompt ──

function buildResearchPrompt(taskTitle: string, taskDescription: string, repoContext: string): string {
  return `You are a research agent. Your job is to investigate best practices before a coding task is implemented.

TASK: ${taskTitle}
DESCRIPTION: ${taskDescription}

CODEBASE CONTEXT:
${repoContext.slice(0, 3000)}

INSTRUCTIONS:
1. Use WebSearch to find current best practices, patterns, and examples for this task.
2. Use WebFetch to read specific documentation pages that are relevant.
3. Focus on: correct API usage, common pitfalls, performance considerations, testing patterns.
4. Look for real-world examples of similar implementations.

OUTPUT FORMAT (use this exact format):

FINDINGS:
<detailed markdown summary of what you found — patterns, approaches, key considerations>

SOURCES:
- <url1> — <what it covers>
- <url2> — <what it covers>

RECOMMENDATIONS:
- <specific actionable recommendation 1>
- <specific actionable recommendation 2>
- <specific actionable recommendation 3>

GOTCHAS:
- <common mistake or pitfall to avoid>
`;
}

// ── Output Parsing ──

interface ParsedResearch {
  findings: string;
  sources: string[];
  recommendations: string[];
}

function parseResearchOutput(output: string): ParsedResearch {
  let findings = '';
  const sources: string[] = [];
  const recommendations: string[] = [];

  // Extract findings section
  const findingsMatch = output.match(/FINDINGS:\s*\n([\s\S]*?)(?=\nSOURCES:|\nRECOMMENDATIONS:|\nGOTCHAS:|$)/i);
  if (findingsMatch) {
    findings = findingsMatch[1].trim();
  }

  // Extract sources
  const sourcesMatch = output.match(/SOURCES:\s*\n([\s\S]*?)(?=\nRECOMMENDATIONS:|\nGOTCHAS:|$)/i);
  if (sourcesMatch) {
    const lines = sourcesMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      sources.push(line.replace(/^-\s*/, '').trim());
    }
  }

  // Extract recommendations
  const recsMatch = output.match(/RECOMMENDATIONS:\s*\n([\s\S]*?)(?=\nGOTCHAS:|$)/i);
  if (recsMatch) {
    const lines = recsMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    for (const line of lines) {
      recommendations.push(line.replace(/^-\s*/, '').trim());
    }
  }

  // Extract gotchas and add to findings
  const gotchasMatch = output.match(/GOTCHAS:\s*\n([\s\S]*?)$/i);
  if (gotchasMatch) {
    findings += '\n\n### Gotchas\n' + gotchasMatch[1].trim();
  }

  // If structured parsing failed, use the whole output as findings
  if (!findings && output.length > 100) {
    findings = output.slice(0, 5000);
  }

  return { findings, sources, recommendations };
}

// ── Decision: Should we research? ──

/**
 * Determine if a task needs research before implementation.
 * Returns true if the task likely involves unfamiliar APIs, patterns, or domains.
 */
export function shouldResearch(taskTitle: string, taskDescription: string, failureCount: number): boolean {
  // Always research if task has failed before (need new approach)
  if (failureCount > 0) return true;

  const text = `${taskTitle} ${taskDescription}`.toLowerCase();

  // Only trigger on explicit signals that a task involves an unfamiliar
  // library/API/protocol — NOT on ubiquitous words like "api", "cache",
  // "database", "performance" that appear in nearly every task and caused a
  // costly research run almost every time.
  const researchTriggers = [
    // explicit intent to research / integrate something external
    'best practice', 'research ', 'unfamiliar', 'new library', 'new package',
    'third-party', 'third party', 'external api', 'integrate with', 'integration with',
    // specific named protocols / services (specific enough to be meaningful)
    'oauth', 'saml', 'webhook', 'graphql', 'grpc', 'stripe', 'twilio',
    'openai', 'anthropic', ' sdk', 'protocol buffer', 'protobuf',
  ];

  return researchTriggers.some(trigger => text.includes(trigger));
}

// ── Format for Implementation Prompt ──

/**
 * Format research results for injection into the implementation prompt.
 */
export function formatResearchForPrompt(research: TaskResearch): string {
  const parts: string[] = ['RESEARCH FINDINGS (from pre-implementation research):'];

  if (research.findings) {
    parts.push(research.findings.slice(0, 3000));
  }

  try {
    const recs = JSON.parse(research.recommendations);
    if (Array.isArray(recs) && recs.length > 0) {
      parts.push('\nKEY RECOMMENDATIONS:');
      for (const rec of recs) {
        parts.push(`- ${rec}`);
      }
    }
  } catch { /* skip */ }

  parts.push('');
  return parts.join('\n');
}

/**
 * Get cached research for a task (if any).
 */
export function getTaskResearch(taskId: string): TaskResearch | null {
  return getOne<TaskResearch>('SELECT * FROM task_research WHERE task_id = ?', [taskId]);
}
