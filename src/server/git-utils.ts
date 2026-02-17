/**
 * Git utilities for agent operations.
 * Extracts git-related functions from ws-handler.ts.
 */
import { execSync } from 'child_process';
import { isProtectedBranch } from './branch-guard.js';

/** Cache entry with TTL */
interface CacheEntry<T> {
  value: T;
  expires: number;
}

/** Simple TTL cache for git operations */
class GitCache {
  private cache = new Map<string, CacheEntry<string>>();

  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.cache.set(key, {
      value,
      expires: Date.now() + ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

const gitCache = new GitCache();

/** Strip all ANSI escape codes from text */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Extract edited files from Claude Code stream-json parsed output */
export function extractEditedFiles(rawOutput: string): string[] {
  const clean = stripAnsi(rawOutput);
  const files: string[] = [];
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    // Our parsed output format: "✏️ Write src/foo.ts" or "✏️ Edit src/foo.ts"
    const writeMatch = trimmed.match(/(?:✏️\s*(?:Write|Edit)|✅)\s+(\S+)/);
    if (writeMatch) {
      files.push(writeMatch[1].replace(/[,;]+$/, ''));
    }
    // Also match "Wrote to" / "Applied edit to" from raw Claude output
    const rawMatch = trimmed.match(/(?:Wrote to|Applied edit to|Updated|Created|Edited)\s+(\S+)/);
    if (rawMatch) {
      files.push(rawMatch[1].replace(/[,;]+$/, ''));
    }
  }
  return [...new Set(files)];
}

/** Generate a summary from Claude Code stream-json parsed output */
export function generateSummary(rawOutput: string, prompt: string): string {
  const clean = stripAnsi(rawOutput);
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const tail = lines.slice(-40);

  const toolLines: string[] = [];
  const descriptionLines: string[] = [];

  for (const line of tail) {
    // Track tool usage (our emoji format from parsed stream-json)
    if (/^(?:📖|✏️|🔍|💻|🤖|🔧|📋|❌|✅)/u.test(line)) {
      toolLines.push(line);
      continue;
    }
    // Skip noise and self-review markers
    if (/^[─━═\-]{3,}$/.test(line)) continue;
    if (/^---/.test(line)) continue;
    if (/^===/.test(line)) continue;
    if (line.startsWith('→')) continue;
    if (line.includes('Self-review')) continue;
    if (line.includes('Changes committed')) continue;
    // Collect meaningful text lines
    if (line.length > 10) {
      descriptionLines.push(line);
    }
  }

  const parts: string[] = [];

  if (descriptionLines.length > 0) {
    parts.push(descriptionLines.slice(-3).join(' ').slice(0, 300));
  }

  if (toolLines.length > 0) {
    const uniqueTools = [...new Set(toolLines)];
    parts.push(uniqueTools.slice(-5).join(', '));
  }

  if (parts.length > 0) return parts.join('\n').slice(0, 400);

  const fallback = tail.slice(-5).join(' ').slice(0, 200);
  return fallback || `Ran: ${prompt.slice(0, 100)}`;
}

/** Commit agent changes — only stages files the agent actually touched */
export function commitAgentChanges(workingDirectory: string, prompt: string, agentOutput: string): boolean {
  try {
    // Guard: refuse to commit on protected branches
    const currentBranch = execSync('git branch --show-current', { cwd: workingDirectory, encoding: 'utf-8', timeout: 5000 }).trim();
    if (isProtectedBranch(currentBranch)) {
      console.error(`[git-utils] Refusing to commit on protected branch: ${currentBranch}`);
      return false;
    }

    // Get all modified/untracked files in the repo
    // Use --untracked-files=all to get individual file paths instead of directory summaries
    const statusOutput = execSync('git status --porcelain --untracked-files=all', { cwd: workingDirectory, encoding: 'utf-8', timeout: 5000 }).trim();
    if (!statusOutput) return false;

    // Extract files the agent touched from the output
    const agentFiles = extractEditedFiles(agentOutput);

    // Also get files from git diff that are in src/client or public (likely agent work)
    // but exclude src/server (likely our infrastructure changes)
    const allModified = statusOutput.split('\n')
      .map(line => line.slice(3).trim())
      .filter(f => f);

    // If we detected specific agent files, only stage those + any new files in src/client/public
    const filesToStage: string[] = [];
    if (agentFiles.length > 0) {
      for (const f of allModified) {
        // Stage if it matches an agent-edited file
        const isAgentFile = agentFiles.some(af => f.endsWith(af) || af.endsWith(f) || f.includes(af) || af.includes(f));
        // Or if it's a new untracked file in src/client or public (agent likely created it)
        const statusLine = statusOutput.split('\n').find(l => l.includes(f));
        const isNewClientFile = statusLine?.startsWith('??') && (f.startsWith('src/client') || f.startsWith('public/'));
        if (isAgentFile || isNewClientFile) {
          filesToStage.push(f);
        }
      }
    } else {
      // Fallback: no detected files, stage everything except src/server
      for (const f of allModified) {
        if (!f.startsWith('src/server/')) {
          filesToStage.push(f);
        }
      }
    }

    if (filesToStage.length === 0) return false;

    for (const f of filesToStage) {
      execSync(`git add "${f}"`, { cwd: workingDirectory, timeout: 5000 });
    }

    // Check if anything was actually staged
    const staged = execSync('git diff --cached --stat', { cwd: workingDirectory, encoding: 'utf-8', timeout: 5000 }).trim();
    if (!staged) return false;

    const msg = prompt.slice(0, 72).replace(/"/g, "'");
    execSync(`git commit -m "agent: ${msg}"`, { cwd: workingDirectory, timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** Get current branch with 30s cache */
export function getCurrentBranch(workingDirectory: string): string {
  const cacheKey = `branch:${workingDirectory}`;
  const cached = gitCache.get(cacheKey);
  if (cached) return cached;

  const branch = execSync('git branch --show-current', {
    cwd: workingDirectory,
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  gitCache.set(cacheKey, branch, 30_000);
  return branch;
}

/** Get recent commits with 30s cache */
export function getRecentCommits(
  workingDirectory: string,
  since: string = '10 minutes ago',
  limit: number = 5
): string {
  const cacheKey = `commits:${workingDirectory}:${since}:${limit}`;
  const cached = gitCache.get(cacheKey);
  if (cached) return cached;

  const commits = execSync(`git log --oneline --since="${since}" -${limit}`, {
    cwd: workingDirectory,
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();

  gitCache.set(cacheKey, commits, 30_000);
  return commits;
}

/** Clear git cache (useful for tests or after git operations that change state) */
export function clearGitCache(): void {
  gitCache.clear();
}
