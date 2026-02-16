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

/** Guess which files the user's prompt is about so we can make them editable.
 *  Be SELECTIVE — too many files wastes context tokens. */
function guessRelevantFiles(prompt: string, allFiles: string[], mentionedFiles: string[]): string[] {
  const editable = new Set(mentionedFiles);
  const lower = prompt.toLowerCase();

  // Only match specific, meaningful keywords (4+ chars, no stop words)
  const stopWords = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'was', 'are',
    'but', 'not', 'you', 'all', 'can', 'had', 'one', 'our', 'out', 'has', 'its',
    'how', 'did', 'get', 'they', 'them', 'then', 'than', 'want', 'like', 'just',
    'also', 'back', 'make', 'use', 'new', 'should', 'would', 'could', 'will',
    'please', 'need', 'look', 'show', 'remove', 'delete', 'update', 'change',
    'fix', 'create', 'button', 'screen', 'page', 'component', 'feature', 'file',
    'function', 'instead', 'currently', 'only', 'local', 'cleanup', 'call',
    'action', 'send', 'message', 'existing', 'reset', 'clear', 'view',
    'does', 'exist', 'which', 'when', 'what', 'where', 'there', 'here',
    'some', 'each', 'both', 'after', 'before', 'about', 'into', 'more',
    'still', 'already', 'being', 'been', 'were', 'done', 'doing', 'same',
  ]);

  // Look for specific file/component names mentioned in the prompt
  // Match patterns like "AgentScreen", "store.ts", "GoalCard", etc.
  const fileNamePatterns = lower.match(/[a-z][a-z0-9]*(?:screen|card|modal|list|item|nav|input|output|selector|hook)/g) || [];
  const directFileRefs = lower.match(/[a-z][a-z0-9_-]*\.(?:ts|tsx|css|js)/g) || [];

  for (const file of allFiles) {
    if (editable.has(file)) continue;
    const fileLower = file.toLowerCase();
    const basename = path.basename(fileLower, path.extname(fileLower)).toLowerCase();

    // Match exact file references (e.g., "agentscreen.tsx" → AgentScreen.tsx)
    for (const ref of directFileRefs) {
      const refBase = ref.replace(/\.[^.]+$/, '').toLowerCase();
      if (basename === refBase) {
        editable.add(file);
        break;
      }
    }

    // Match component name patterns (e.g., "agentscreen" → AgentScreen.tsx)
    for (const pattern of fileNamePatterns) {
      if (basename === pattern || basename.includes(pattern)) {
        editable.add(file);
        break;
      }
    }
  }

  // If we found explicit files, also add types.ts and store.ts as editable
  // (they're frequently needed for type definitions and state management)
  if (editable.size > 0) {
    const hasClientFiles = [...editable].some(f => f.includes('src/client'));
    if (hasClientFiles) {
      for (const file of allFiles) {
        const base = path.basename(file).toLowerCase();
        if (base === 'types.ts' || base === 'store.ts') {
          editable.add(file);
        }
      }
    }
  }

  // If NOTHING matched, fall back to a small set of likely files
  if (editable.size === 0) {
    // Try looser keyword matching as last resort, but only for 5+ char keywords
    const keywords = lower.match(/[a-z]{5,}/g)?.filter(w => !stopWords.has(w)) || [];
    for (const file of allFiles) {
      const basename = path.basename(file, path.extname(file)).toLowerCase();
      for (const kw of keywords) {
        if (basename.includes(kw)) {
          editable.add(file);
          break;
        }
      }
    }
  }

  // Hard cap: if still nothing, add types.ts only so Aider has something
  if (editable.size === 0) {
    for (const file of allFiles) {
      if (file.endsWith('types.ts')) editable.add(file);
    }
  }

  return [...editable];
}

/** Use grep to find which files actually contain code related to the prompt.
 *  Much more reliable than keyword-matching filenames. */
function selectFilesFromGrep(prompt: string, allFiles: string[], cwd: string): string[] {
  const hitFiles = new Set<string>();

  // Always include types.ts and store.ts (frequently needed)
  for (const f of allFiles) {
    const base = path.basename(f).toLowerCase();
    if (base === 'types.ts' || base === 'store.ts') hitFiles.add(f);
  }

  // Extract explicit file paths mentioned in prompt
  const mentionedFiles = extractFilePaths(prompt, cwd);
  for (const f of mentionedFiles) hitFiles.add(f);

  // Extract search terms from the prompt
  const terms: string[] = [];
  // Quoted strings
  const quoted = prompt.match(/["'`]([^"'`]{2,40})["'`]/g)?.map(s => s.slice(1, -1)) || [];
  terms.push(...quoted);
  // PascalCase identifiers (component names, class names)
  const pascal = prompt.match(/\b[A-Z][a-zA-Z0-9]{2,30}\b/g) || [];
  terms.push(...pascal);
  // UI elements and common words → grep for their JSX usage
  const uiWords = prompt.toLowerCase().match(/\b(?:button|modal|header|footer|nav|input|chat|card|list|tab|menu|icon|title|form|dialog|drawer|toggle|sidebar|toolbar|banner)\b/g) || [];
  // Action words → grep for handlers
  const actions = prompt.toLowerCase().match(/\b(?:remove|add|fix|change|move|hide|show|delete|update|replace|rename)\b/g) || [];

  // Grep each term and collect which files have hits
  const searchTerms = [...new Set([...quoted, ...pascal])];
  for (const term of searchTerms.slice(0, 6)) {
    try {
      const escaped = term.replace(/"/g, '\\"').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const result = execSync(
        `git grep -l "${escaped}" -- "*.ts" "*.tsx"`,
        { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (result) {
        for (const f of result.split('\n').filter(Boolean)) {
          if (allFiles.includes(f)) hitFiles.add(f);
        }
      }
    } catch {}
  }

  // Grep for UI element text in JSX (e.g., "New Chat", "header", "button")
  // Combine UI words with nearby nouns from the prompt for specific searches
  const promptWords = prompt.match(/\b[a-zA-Z]{3,20}\b/g) || [];
  const specificPhrases = uiWords.flatMap(ui =>
    promptWords.filter(w => w.toLowerCase() !== ui && !/^(the|and|for|that|this|with|from|its|should|would|could|please|want|like|just|also|remove|add|fix|change|dont|make)$/i.test(w))
      .slice(0, 2)
      .map(w => `${w}.*${ui}|${ui}.*${w}`)
  );
  for (const phrase of [...new Set(specificPhrases)].slice(0, 4)) {
    try {
      const result = execSync(
        `git grep -l -i -E "${phrase}" -- "*.tsx"`,
        { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (result) {
        for (const f of result.split('\n').filter(Boolean)) {
          if (allFiles.includes(f)) hitFiles.add(f);
        }
      }
    } catch {}
  }

  // If still nothing, fall back to the old guessRelevantFiles approach
  if (hitFiles.size <= 2) {
    const guessed = guessRelevantFiles(prompt, allFiles, mentionedFiles);
    for (const f of guessed) hitFiles.add(f);
  }

  // Cap at 10 files to stay under context limits
  return [...hitFiles].slice(0, 10);
}

/** Enrich a vague user prompt with specific file paths, line numbers, and grep results.
 *  This transforms "remove the button" into "In AgentScreen.tsx (lines 154-159), remove..." */
function enrichPrompt(prompt: string, editableFiles: string[], cwd: string): string {
  const sections: string[] = [];

  // 1. Extract search keywords from the prompt
  const lower = prompt.toLowerCase();
  // UI-related keywords to grep for
  const uiKeywords: string[] = [];
  const uiTerms = lower.match(/\b(?:button|modal|header|footer|nav|input|chat|screen|card|list|tab|menu|icon|label|title|form|dialog|drawer|toggle|switch|select)\b/g);
  if (uiTerms) uiKeywords.push(...new Set(uiTerms));

  // Quoted strings and specific identifiers
  const quoted = prompt.match(/["'`]([^"'`]{2,40})["'`]/g)?.map(s => s.slice(1, -1)) || [];
  const identifiers = prompt.match(/\b[A-Z][a-zA-Z0-9]{2,30}\b/g) || [];
  const allTerms = [...new Set([...quoted, ...identifiers])];

  // 2. Grep for relevant code patterns in editable files
  const grepHits: string[] = [];
  for (const term of allTerms.slice(0, 5)) {
    try {
      const escaped = term.replace(/"/g, '\\"').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const result = execSync(
        `git grep -n --max-count=3 "${escaped}" -- "*.ts" "*.tsx"`,
        { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (result) grepHits.push(result);
    } catch {}
  }

  // Also search for UI element text mentioned in the prompt
  for (const kw of uiKeywords.slice(0, 3)) {
    try {
      const result = execSync(
        `git grep -n -i "${kw}" -- "*.tsx"`,
        { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      if (result) {
        // Only keep lines that seem relevant (JSX, className, onClick, etc.)
        const relevant = result.split('\n')
          .filter(l => /<|className|onClick|{.*}|text|label/i.test(l))
          .slice(0, 5);
        if (relevant.length > 0) grepHits.push(relevant.join('\n'));
      }
    } catch {}
  }

  if (grepHits.length > 0) {
    const deduped = [...new Set(grepHits.join('\n').split('\n'))].slice(0, 20);
    sections.push(`GREP RESULTS (where relevant code lives):\n${deduped.join('\n')}`);
  }

  // 3. List ALL source files so MiniMax knows what exists
  try {
    const allSrc = execSync('git ls-files -- "*.ts" "*.tsx"', { cwd, timeout: 5000, encoding: 'utf-8' })
      .trim().split('\n')
      .filter(f => f.startsWith('src/') && !f.includes('.d.ts'))
      .join('\n');
    sections.push(`ALL SOURCE FILES:\n${allSrc}`);
  } catch {}

  // 4. For each editable file, show a brief summary of what it contains
  for (const file of editableFiles.slice(0, 5)) {
    try {
      const fullPath = path.resolve(cwd, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lineCount = content.split('\n').length;
      // Extract exports and component/function names
      const exports = content.match(/export (?:function|const|class|interface|type) \w+/g) || [];
      sections.push(`FILE: ${file} (${lineCount} lines)\nExports: ${exports.join(', ') || 'none'}`);
    } catch {}
  }

  if (sections.length === 0) return prompt;

  const context = sections.join('\n\n');
  const truncated = context.length > 4000 ? context.slice(0, 4000) + '\n...(truncated)' : context;

  return `${prompt}\n\n--- CONTEXT (auto-generated) ---\n${truncated}\n--- END CONTEXT ---\n\nIMPORTANT: Edit the files that are loaded in the chat. Do NOT create new files unless the task explicitly asks for it. Use the grep results above to find the exact lines to modify.`;
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

  // Smart file selection: use grep to find which files contain relevant code
  // Cap at 10 files to stay under 25k token context limit
  const allFiles = getSourceFiles(state.workingDirectory);
  const editableFiles = selectFilesFromGrep(text, allFiles, state.workingDirectory);
  for (const f of editableFiles) {
    args.push(f);
  }
  console.log(`[agent ${id.slice(0,6)}] ${editableFiles.length} editable files: ${editableFiles.map(f => path.basename(f)).join(', ')}`);

  // Enrich the prompt with grep results, file list, and "edit existing files" instruction
  const enrichedPrompt = enrichPrompt(text, editableFiles, state.workingDirectory);
  console.log(`[agent ${id.slice(0,6)}] prompt: ${enrichedPrompt.slice(0, 120)}...`);

  args.push('--message', enrichedPrompt);

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
  // Track recently sent content to suppress ConPTY re-renders
  const recentlySent: string[] = [];
  const MAX_RECENT = 5;

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

    // Deduplicate consecutive identical lines within this chunk
    const cleanLines = clean.split('\n');
    const deduped: string[] = [];
    for (const line of cleanLines) {
      if (deduped.length === 0 || line !== deduped[deduped.length - 1]) {
        deduped.push(line);
      }
    }
    clean = deduped.join('\n');

    // Suppress exact duplicate flushes (ConPTY re-renders same content)
    if (recentlySent.includes(stripped)) {
      aiderBuffer = '';
      return;
    }
    recentlySent.push(stripped);
    if (recentlySent.length > MAX_RECENT) recentlySent.shift();

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
