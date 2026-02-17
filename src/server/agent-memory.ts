import fs from 'fs';
import path from 'path';
import { getAll } from './db.js';

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
