import fs from 'fs';
import path from 'path';
import { getAll, runQuery, getOne } from './db.js';
import type { Goal } from '../client/lib/types.js';

export interface Guideline {
  error_pattern: string;
  guideline: string;
  file_context: string | null;
  times_seen: number;
  last_seen: string;
}

export interface AgentMemory {
  patterns: { pattern: string; learned_at: string; source: string }[];
  mistakes: { description: string; fix: string; occurred_at: string }[];
  preferences: { key: string; value: string }[];
  guidelines: Guideline[];
}

const EMPTY_MEMORY: AgentMemory = { patterns: [], mistakes: [], preferences: [], guidelines: [] };

// ── Goal Log Cache ──────────────────────────────────────────────────────

interface GoalLogEntry {
  id: string;
  goal_id: string;
  agent_id: string;
  action: string;
  summary: string;
  diff_stats: string;
  cost_usd: number;
  duration_ms: number;
  success: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS = 30000; // 30 seconds
const goalLogCache = new Map<string, CacheEntry<GoalLogEntry[]>>();

export function getGoalLogCached(goalId: string, limit = 5): GoalLogEntry[] {
  const cacheKey = `${goalId}:${limit}`;
  const now = Date.now();

  const cached = goalLogCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.data;
  }

  const results = getAll<GoalLogEntry>(
    'SELECT * FROM goal_log WHERE goal_id = ? ORDER BY created_at DESC LIMIT ?',
    [goalId, limit]
  );

  goalLogCache.set(cacheKey, { data: results, timestamp: now });
  return results;
}

export function invalidateGoalLogCache(goalId?: string): void {
  if (goalId) {
    // Invalidate all entries for this goal_id
    for (const key of goalLogCache.keys()) {
      if (key.startsWith(`${goalId}:`)) {
        goalLogCache.delete(key);
      }
    }
  } else {
    // Clear entire cache
    goalLogCache.clear();
  }
}

export function initBoofDir(repoPath: string): void {
  const boofDir = path.join(repoPath, '.boof');
  const plansDir = path.join(boofDir, 'plans');
  const logsDir = path.join(boofDir, 'logs');

  if (!fs.existsSync(boofDir)) fs.mkdirSync(boofDir, { recursive: true });
  if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const memoryFile = path.join(boofDir, 'memory.json');
  if (!fs.existsSync(memoryFile)) {
    fs.writeFileSync(memoryFile, JSON.stringify(EMPTY_MEMORY, null, 2));
  }

  // Add .boof/ to .gitignore if not already present
  const gitignorePath = path.join(repoPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.boof/') && !content.includes('.boof')) {
      fs.appendFileSync(gitignorePath, '\n.boof/\n');
    }
  } else {
    fs.writeFileSync(gitignorePath, '.boof/\n');
  }
}

export function loadMemory(repoPath: string): AgentMemory {
  const memoryFile = path.join(repoPath, '.boof', 'memory.json');
  try {
    if (fs.existsSync(memoryFile)) {
      return JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
    }
  } catch {
    // Corrupt file, return empty
  }
  return { ...EMPTY_MEMORY, patterns: [], mistakes: [], preferences: [] };
}

export function saveMemory(repoPath: string, memory: AgentMemory): void {
  const memoryFile = path.join(repoPath, '.boof', 'memory.json');
  const dir = path.dirname(memoryFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2));
}

export function recordMistake(repoPath: string, description: string, fix: string): void {
  const memory = loadMemory(repoPath);
  memory.mistakes.push({
    description,
    fix,
    occurred_at: new Date().toISOString(),
  });
  // Keep last 50 mistakes
  if (memory.mistakes.length > 50) {
    memory.mistakes = memory.mistakes.slice(-50);
  }
  saveMemory(repoPath, memory);
}

export function recordPattern(repoPath: string, pattern: string, source: string): void {
  const memory = loadMemory(repoPath);
  // Don't duplicate patterns
  if (memory.patterns.some(p => p.pattern === pattern)) return;
  memory.patterns.push({
    pattern,
    source,
    learned_at: new Date().toISOString(),
  });
  // Keep last 100 patterns
  if (memory.patterns.length > 100) {
    memory.patterns = memory.patterns.slice(-100);
  }
  saveMemory(repoPath, memory);
}

/**
 * Return all patterns recorded in agent memory for a repo.
 * Used to verify reinforcement entries after goal completion.
 */
export function getPatterns(repoPath: string): { pattern: string; learned_at: string; source: string }[] {
  return loadMemory(repoPath).patterns;
}

export function getMemoryContext(repoPath: string, taskDescription?: string): string {
  const memory = loadMemory(repoPath);
  const parts: string[] = [];

  // Extract keywords for filtering if task description provided
  const keywords = taskDescription
    ? taskDescription.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    : [];

  const matchesKeywords = (text: string): number => {
    if (keywords.length === 0) return 1; // no filter = always match
    const lower = text.toLowerCase();
    return keywords.filter(k => lower.includes(k)).length;
  };

  if (memory.mistakes.length > 0) {
    let mistakes = memory.mistakes;
    if (keywords.length > 0) {
      // Score and filter mistakes by relevance
      mistakes = mistakes
        .map(m => ({ m, score: matchesKeywords(m.description + ' ' + m.fix) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.m);
    } else {
      mistakes = mistakes.slice(-5);
    }
    if (mistakes.length > 0) {
      parts.push('PAST MISTAKES (avoid these):');
      for (const m of mistakes) {
        parts.push(`- ${m.description}${m.fix ? ` → Fix: ${m.fix}` : ''}`);
      }
    }
  }

  if (memory.patterns.length > 0) {
    let patterns = memory.patterns;
    if (keywords.length > 0) {
      patterns = patterns
        .map(p => ({ p, score: matchesKeywords(p.pattern) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(x => x.p);
    }
    if (patterns.length > 0) {
      parts.push('\nLEARNED PATTERNS:');
      for (const p of patterns) {
        parts.push(`- ${p.pattern}`);
      }
    }
  }

  if (memory.guidelines && memory.guidelines.length > 0) {
    let guidelines = memory.guidelines;
    if (keywords.length > 0) {
      guidelines = guidelines
        .map(g => ({ g, score: matchesKeywords(g.error_pattern + ' ' + g.guideline + ' ' + (g.file_context || '')) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(x => x.g);
    } else {
      guidelines = guidelines.slice(-5);
    }
    if (guidelines.length > 0) {
      parts.push('\nCORRECTIVE GUIDELINES:');
      for (const g of guidelines) {
        parts.push(`- [${g.error_pattern}] ${g.guideline} (seen ${g.times_seen}x)`);
      }
    }
  }

  if (memory.preferences.length > 0) {
    parts.push('\nPREFERENCES:');
    for (const p of memory.preferences) {
      parts.push(`- ${p.key}: ${p.value}`);
    }
  }

  return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
}

export function recordGuideline(repoPath: string, errorPattern: string, guideline: string, fileContext?: string): void {
  const memory = loadMemory(repoPath);
  if (!memory.guidelines) memory.guidelines = [];

  // Deduplicate by error_pattern
  const existing = memory.guidelines.find(g => g.error_pattern === errorPattern);
  if (existing) {
    existing.times_seen += 1;
    existing.last_seen = new Date().toISOString();
    existing.guideline = guideline; // update with latest context
    if (fileContext) existing.file_context = fileContext;
  } else {
    memory.guidelines.push({
      error_pattern: errorPattern,
      guideline,
      file_context: fileContext || null,
      times_seen: 1,
      last_seen: new Date().toISOString(),
    });
  }

  // Keep last 50 guidelines
  if (memory.guidelines.length > 50) {
    memory.guidelines = memory.guidelines.slice(-50);
  }
  saveMemory(repoPath, memory);
}

// ── Goal Pattern Decay ───────────────────────────────────────────────────

export interface DecayResult {
  removed: number;
  remaining: number;
}

/**
 * Decay stale patterns by removing entries older than maxAgeDays.
 * Also decays guidelines by reducing times_seen weight for old entries.
 * Returns counts of removed vs remaining patterns.
 */
export function decayStalePatterns(repoPath: string, maxAgeDays = 30): DecayResult {
  const memory = loadMemory(repoPath);
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const before = memory.patterns.length;
  memory.patterns = memory.patterns.filter(p => p.learned_at >= cutoff);
  const removed = before - memory.patterns.length;

  // Decay guidelines: halve times_seen for entries not seen recently
  if (memory.guidelines) {
    for (const g of memory.guidelines) {
      if (g.last_seen < cutoff) {
        g.times_seen = Math.max(1, Math.floor(g.times_seen / 2));
      }
    }
  }

  saveMemory(repoPath, memory);
  return { removed, remaining: memory.patterns.length };
}

// ── Goal Proposal from Past Patterns ────────────────────────────────────

interface GoalStat {
  goal_id: string;
  total_runs: number;
  tasks_completed: number;
  tasks_failed: number;
  avg_duration_ms: number;
}

interface CompletedGoal {
  id: string;
  name: string;
  description: string;
  priority: number;
}

interface Reflection {
  improve: string;
  pattern: string;
}

/**
 * Generate new goal proposals based on past patterns, reflections, and completed goal history.
 * Saves proposed goals to DB with proposal_status = 'pending' and proposed_by = agentId.
 * Returns the proposed goals.
 */
export async function proposeGoals(agentId: string, repoPath: string): Promise<Goal[]> {
  const memory = loadMemory(repoPath);

  // Gather signals for proposals
  const completedGoals = getAll<CompletedGoal>(
    "SELECT id, name, description, priority FROM goals WHERE status = 'completed' ORDER BY priority DESC LIMIT 10"
  );

  const goalStats = getAll<GoalStat>(
    'SELECT * FROM goal_stats ORDER BY tasks_completed DESC LIMIT 10'
  );

  const recentReflections = getAll<Reflection>(
    `SELECT improve, pattern FROM reflections WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10`,
    [agentId]
  );

  // Build candidate goal ideas from patterns
  const candidates: { name: string; description: string; priority: number }[] = [];

  // From reflections: "improve" notes often contain follow-up work ideas
  for (const r of recentReflections) {
    if (r.improve && r.improve.length > 10) {
      candidates.push({
        name: `Follow-up: ${r.improve.slice(0, 60)}`,
        description: r.improve,
        priority: 2,
      });
    }
  }

  // From patterns: recurring patterns suggest systematic improvements
  for (const p of memory.patterns.slice(-5)) {
    if (p.pattern && p.pattern.length > 10) {
      candidates.push({
        name: `Improve: ${p.pattern.slice(0, 60)}`,
        description: `Identified pattern from past runs: ${p.pattern}`,
        priority: 1,
      });
    }
  }

  // From failed tasks: goals with high failure rates need revisiting
  for (const stat of goalStats) {
    if (stat.tasks_failed > 0 && stat.tasks_completed > 0) {
      const failRate = stat.tasks_failed / (stat.tasks_completed + stat.tasks_failed);
      if (failRate > 0.3) {
        const sourceGoal = completedGoals.find(g => g.id === stat.goal_id);
        if (sourceGoal) {
          candidates.push({
            name: `Retry: ${sourceGoal.name}`,
            description: `${sourceGoal.description} (${Math.round(failRate * 100)}% failure rate — needs improvement)`,
            priority: 3,
          });
        }
      }
    }
  }

  if (candidates.length === 0) {
    // Fallback: suggest a general codebase improvement
    candidates.push({
      name: 'Codebase health check',
      description: 'Review codebase for improvements: missing tests, stale TODOs, performance opportunities.',
      priority: 1,
    });
  }

  // Deduplicate and limit to 3 proposals
  const uniqueCandidates = candidates
    .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i)
    .slice(0, 3);

  // Persist proposals to DB
  const now = new Date().toISOString();
  const proposed: Goal[] = [];

  for (const c of uniqueCandidates) {
    // Generate a simple 16-char hex ID (same as autopilot.ts generateId)
    const chars = 'abcdef0123456789';
    let id = '';
    for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];

    runQuery(
      `INSERT INTO goals (id, name, description, status, priority, proposed_by, proposal_status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, 'pending', ?, ?)`,
      [id, c.name, c.description, c.priority, agentId, now, now]
    );

    const saved = getOne<Goal>('SELECT * FROM goals WHERE id = ?', [id]);
    if (saved) proposed.push(saved);
  }

  return proposed;
}
