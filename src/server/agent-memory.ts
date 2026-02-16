import fs from 'fs';
import path from 'path';

export interface AgentMemory {
  patterns: { pattern: string; learned_at: string; source: string }[];
  mistakes: { description: string; fix: string; occurred_at: string }[];
  preferences: { key: string; value: string }[];
}

const EMPTY_MEMORY: AgentMemory = { patterns: [], mistakes: [], preferences: [] };

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

export function getMemoryContext(repoPath: string): string {
  const memory = loadMemory(repoPath);
  const parts: string[] = [];

  if (memory.mistakes.length > 0) {
    const recent = memory.mistakes.slice(-10);
    parts.push('PAST MISTAKES (avoid these):');
    for (const m of recent) {
      parts.push(`- ${m.description}${m.fix ? ` → Fix: ${m.fix}` : ''}`);
    }
  }

  if (memory.patterns.length > 0) {
    parts.push('\nLEARNED PATTERNS:');
    for (const p of memory.patterns) {
      parts.push(`- ${p.pattern}`);
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
