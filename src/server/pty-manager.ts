import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface AgentState {
  activePty: IPty | null;
  workingDirectory: string;
  name: string;
  onOutput: (id: string, chunk: string) => void;
  onExit: (id: string, code: number) => void;
}

const agents: Map<string, AgentState> = new Map();
const isWindows = process.platform === 'win32';

function getCleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env['CLAUDECODE'];
  return env;
}

export function createAgent(
  id: string,
  workingDirectory: string,
  name: string,
  onOutput: (id: string, chunk: string) => void,
  onExit: (id: string, code: number) => void,
): void {
  if (agents.has(id)) {
    killAgent(id);
  }

  agents.set(id, {
    activePty: null,
    workingDirectory,
    name,
    onOutput,
    onExit,
  });

  console.log(`Agent ${id} registered (${name})`);
}

/** Get all git-tracked source files in the repo */
function getSourceFiles(cwd: string): string[] {
  try {
    const output = execSync('git ls-files', { cwd, timeout: 10_000, encoding: 'utf-8' });
    const sourceExts = ['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.md', '.html'];
    return output.split('\n')
      .map(f => f.trim())
      .filter(f => f && sourceExts.some(ext => f.endsWith(ext)))
      .filter(f => !f.includes('node_modules') && !f.includes('dist/'));
  } catch {
    return [];
  }
}

/** Find files explicitly mentioned in the prompt */
function extractFilePaths(text: string, cwd: string): string[] {
  const patterns = text.match(/(?:^|\s|`)([\w./-]+\.[\w]+)/g);
  if (!patterns) return [];
  const files: string[] = [];
  for (const match of patterns) {
    const candidate = match.trim().replace(/^`|`$/g, '');
    const fullPath = path.resolve(cwd, candidate);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      files.push(candidate);
    }
  }
  return [...new Set(files)];
}

/** Guess which files the user's prompt is about so we can make them editable */
function guessRelevantFiles(prompt: string, allFiles: string[], mentionedFiles: string[]): string[] {
  const editable = new Set(mentionedFiles);
  const lower = prompt.toLowerCase();

  // Extract keywords from the prompt (words 3+ chars, excluding stop words)
  const stopWords = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'was', 'are',
    'but', 'not', 'you', 'all', 'can', 'had', 'her', 'one', 'our', 'out', 'has', 'its',
    'how', 'did', 'get', 'him', 'his', 'she', 'they', 'them', 'then', 'than',
    'want', 'like', 'just', 'also', 'back', 'put', 'add', 'make', 'use', 'new',
    'should', 'would', 'could', 'will', 'please', 'need', 'look', 'show', 'remove', 'delete',
    'update', 'change', 'fix', 'create', 'button', 'screen', 'page', 'component', 'feature']);

  const keywords = lower.match(/[a-z]{3,}/g)?.filter(w => !stopWords.has(w)) || [];

  for (const file of allFiles) {
    if (editable.has(file)) continue;
    const fileLower = file.toLowerCase();
    const basename = path.basename(fileLower, path.extname(fileLower));

    // Match file name against keywords
    for (const kw of keywords) {
      if (basename.includes(kw) || kw.includes(basename)) {
        editable.add(file);
        break;
      }
    }

    // Common pattern: "agent" in prompt → AgentScreen, AgentCard, etc.
    // "goal" → GoalScreen, GoalCreateModal, etc.
    // "chat" → AgentScreen (the chat view)
    if (lower.includes('chat') && (fileLower.includes('agent') && fileLower.includes('screen'))) {
      editable.add(file);
    }
    if (lower.includes('nav') && fileLower.includes('nav')) {
      editable.add(file);
    }
  }

  // If we still have nothing, add all client screen/component files as editable
  if (editable.size === 0) {
    for (const file of allFiles) {
      if (file.includes('src/client/') && (file.endsWith('.tsx') || file.endsWith('.ts'))) {
        editable.add(file);
      }
    }
  }

  // Always include types and store if any client files are included
  const hasClientFiles = [...editable].some(f => f.includes('src/client/'));
  if (hasClientFiles) {
    for (const file of allFiles) {
      if (file.includes('types.ts') || file.includes('store.ts') || file.includes('useWebSocket')) {
        editable.add(file);
      }
    }
  }

  return [...editable];
}

function spawnAider(id: string, state: AgentState, text: string): void {
  const args: string[] = [];
  if (isWindows) {
    args.push('/c', 'aider', '--yes-always');
  } else {
    args.push('--yes-always');
  }
  // Everything else (read, map-tokens, auto-test, auto-lint, stream, pretty,
  // suggest-shell-commands, detect-urls, cache-prompts, auto-commits)
  // is handled by .aider.conf.yml in the working directory

  // Add files: mentioned files + keyword-matched files are editable (positional),
  // rest are read-only context (--file)
  const mentionedFiles = extractFilePaths(text, state.workingDirectory);
  const allFiles = getSourceFiles(state.workingDirectory);
  const editableFiles = guessRelevantFiles(text, allFiles, mentionedFiles);
  const readOnlyFiles = allFiles.filter(f => !editableFiles.includes(f));

  // Editable files go as positional args (before --message)
  for (const f of editableFiles) {
    args.push(f);
  }
  // Read-only context files go with --file
  for (const f of readOnlyFiles) {
    args.push('--file', f);
  }
  console.log(`[agent ${id.slice(0,6)}] ${editableFiles.length} editable, ${readOnlyFiles.length} read-only files`);

  args.push('--message', text);

  const shell = isWindows ? 'cmd.exe' : 'aider';

  console.log(`[agent ${id.slice(0,6)}] spawning aider: ${args.join(' ').slice(0, 120)}...`);

  const proc = pty.spawn(shell, args, {
    cwd: state.workingDirectory,
    cols: 200,
    rows: 50,
    env: getCleanEnv(),
  } as any);

  state.activePty = proc;

  // Aider PTY output: strip terminal control sequences, debounce, send clean lines
  let aiderBuffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushAider = () => {
    flushTimer = null;
    if (!aiderBuffer) return;

    // Strip PTY control sequences but keep ANSI color codes
    let clean = aiderBuffer
      .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')   // private mode set/reset
      .replace(/\x1b\[[0-9]*[ABCDHJ]/g, '')        // cursor movement/erase
      .replace(/\x1b\[[0-9;]*[Hf]/g, '')            // cursor position
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
      .replace(/\x1b\[2J/g, '')                     // clear screen
      .replace(/\x1b\[K/g, '')                      // erase to end of line
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // control chars (keep \n \r \t)
      .replace(/\r+/g, '')                          // carriage returns
      .replace(/\n{3,}/g, '\n\n');                  // collapse blank lines

    // Skip if it's just whitespace or spinner noise
    const stripped = clean.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!stripped) {
      aiderBuffer = '';
      return;
    }

    // Skip noisy lines
    const lines = stripped.split('\n').filter(l => l.trim());
    const isNoise = lines.length > 0 && lines.every(l =>
      /^[█░▓▒\s]*$/.test(l) ||
      /Waiting for \S+/.test(l) ||
      /Updating repo map/.test(l) ||
      /^Repo-map:/.test(l) ||
      /^Model:/.test(l) ||
      /^Git repo:/.test(l) ||
      /^Use \/help/.test(l) ||
      /tokens? [\d,]+ (?:remaining|sent|cost)/i.test(l) ||
      /^\s*$/.test(l)
    );
    if (isNoise) {
      aiderBuffer = '';
      return;
    }

    // Deduplicate consecutive identical lines
    const cleanLines = clean.split('\n');
    const deduped: string[] = [];
    for (const line of cleanLines) {
      if (deduped.length === 0 || line !== deduped[deduped.length - 1]) {
        deduped.push(line);
      }
    }
    clean = deduped.join('\n');

    // Truncate very large chunks — keep the tail
    if (clean.length > 4000) {
      clean = '... (truncated)\n' + clean.slice(-4000);
    }

    state.onOutput(id, clean);
    aiderBuffer = '';
  };

  proc.onData((data) => {
    aiderBuffer += data;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushAider, 150);
  });

  proc.onExit(({ exitCode }) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushAider();

    console.log(`[agent ${id.slice(0,6)}] aider exited code=${exitCode}`);
    if (state.activePty === proc) {
      state.activePty = null;
    }
    state.onExit(id, exitCode);
  });
}

export function sendToAgent(id: string, text: string): void {
  const state = agents.get(id);
  if (!state) return;

  if (state.activePty) {
    try { state.activePty.kill(); } catch {}
    state.activePty = null;
  }

  spawnAider(id, state, text);
}

export function interruptAgent(id: string): void {
  const state = agents.get(id);
  if (state?.activePty) {
    state.activePty.kill();
    state.activePty = null;
  }
}

export function killAgent(id: string): void {
  const state = agents.get(id);
  if (state) {
    if (state.activePty) {
      try { state.activePty.kill(); } catch {}
    }
    agents.delete(id);
    console.log(`Agent ${id} killed`);
  }
}

export function restartAgent(
  id: string,
  workingDirectory: string,
  name: string,
  onOutput: (id: string, chunk: string) => void,
  onExit: (id: string, code: number) => void,
): void {
  killAgent(id);
  createAgent(id, workingDirectory, name, onOutput, onExit);
}

export function getAgentPid(id: string): number | null {
  const state = agents.get(id);
  return state?.activePty ? state.activePty.pid : null;
}

export function hasAgent(id: string): boolean {
  return agents.has(id);
}
