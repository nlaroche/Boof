import { runQuery, getOne, getAll } from './db.js';
import type { Assessment, Improvement, Agent, Command } from '../client/lib/types.js';

// ── XP & Leveling ──

export function getLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 5)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) * (level - 1) * 5;
}

// ── Helpers ──

function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ── Performance Assessment ──

interface AssessContext {
  retries: number;
  buildFailures: number;
  reviewIssues: number;
  filesTouched: number;
  durationMs: number;
  completedFully: boolean;
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

export function awardXp(agentId: string, amount: number): number {
  const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent) return 0;
  const newXp = (agent.xp || 0) + amount;
  runQuery('UPDATE agents SET xp = ? WHERE id = ?', [newXp, agentId]);
  return newXp;
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
