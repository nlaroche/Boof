import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
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

// Path to the cc-mirror minimax native binary
const MINIMAX_CMD = process.env.MINIMAX_CMD
  || (isWindows
    ? 'C:\\Users\\nlaroche\\.cc-mirror\\minimax\\native\\claude.exe'
    : 'minimax');

function getCleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env['CLAUDECODE'];
  delete env['ANTHROPIC_AUTH_TOKEN'];

  env['CLAUDE_CONFIG_DIR'] = 'C:\\Users\\nlaroche\\.cc-mirror\\minimax\\config';
  env['TWEAKCC_CONFIG_DIR'] = 'C:\\Users\\nlaroche\\.cc-mirror\\minimax\\tweakcc';
  env['DISABLE_AUTOUPDATER'] = '1';
  env['DISABLE_AUTO_MIGRATE_TO_NATIVE'] = '1';
  env['DISABLE_INSTALLATION_CHECKS'] = '1';
  env['ANTHROPIC_BASE_URL'] = 'https://api.minimax.io/anthropic';
  env['ANTHROPIC_MODEL'] = 'MiniMax-M2.5';
  env['ANTHROPIC_SMALL_FAST_MODEL'] = 'MiniMax-M2.5';
  env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = 'MiniMax-M2.5';
  env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = 'MiniMax-M2.5';
  env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = 'MiniMax-M2.5';
  env['API_TIMEOUT_MS'] = '3000000';
  env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';

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

/**
 * Strip ConPTY escape codes that corrupt JSON parsing.
 */
function stripPtyNoise(data: string): string {
  return data
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\[[0-9]*[ABCDHJ]/g, '')
    .replace(/\x1b\[[0-9;]*[Hf]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[2J/g, '')
    .replace(/\x1b\[K/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\r+/g, '');
}

/** Shorten a file path to just the relative part for display */
function shortPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const srcIdx = normalized.indexOf('src/');
  if (srcIdx >= 0) return normalized.slice(srcIdx);
  const pubIdx = normalized.indexOf('public/');
  if (pubIdx >= 0) return normalized.slice(pubIdx);
  return path.basename(normalized);
}

/**
 * Parse a single JSONL line from Claude Code stream-json output.
 * Extracts meaningful text for display including tool call details.
 *
 * The format outputs full message objects:
 *   type:"assistant" with message.content[] containing "text", "tool_use", or "thinking"
 *   type:"user" with message.content[] containing "tool_result"
 *   type:"result" at the end with session_id and summary
 *   type:"system" at init with session_id
 */
function parseStreamJsonLine(line: string): string | null {
  try {
    const obj = JSON.parse(line);

    // --- Assistant messages ---
    if (obj.type === 'assistant' && obj.message?.content) {
      const parts: string[] = [];

      for (const block of obj.message.content) {
        // Text output from the assistant
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        }

        // Tool use — show tool name + key details
        if (block.type === 'tool_use') {
          const tool = block.name;
          const input = block.input || {};

          switch (tool) {
            case 'Read':
              parts.push(`\n📖 Read ${shortPath(input.file_path || '?')}\n`);
              break;
            case 'Write':
              parts.push(`\n✏️ Write ${shortPath(input.file_path || '?')}\n`);
              break;
            case 'Edit':
              parts.push(`\n✏️ Edit ${shortPath(input.file_path || '?')}\n`);
              break;
            case 'Glob':
              parts.push(`\n🔍 Glob ${input.pattern || '?'}\n`);
              break;
            case 'Grep':
              parts.push(`\n🔍 Grep "${input.pattern || '?'}" ${input.glob || ''}\n`);
              break;
            case 'Bash':
              parts.push(`\n💻 Bash: ${(input.command || '?').slice(0, 120)}\n`);
              break;
            case 'Task':
              parts.push(`\n🤖 Subagent: ${input.description || input.prompt?.slice(0, 80) || '?'}\n`);
              break;
            case 'TodoWrite':
              parts.push(`\n📋 TodoWrite\n`);
              break;
            default:
              parts.push(`\n🔧 ${tool}\n`);
              break;
          }
        }

        // Skip thinking blocks — don't show internal reasoning
      }

      if (parts.length > 0) return parts.join('');
    }

    // --- Tool results (user messages with tool_result content) ---
    if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      const parts: string[] = [];

      for (const block of obj.message.content) {
        if (block.type === 'tool_result') {
          const result = typeof block.content === 'string' ? block.content : '';

          // Show errors prominently
          if (block.is_error) {
            const errorMsg = result.replace(/<[^>]+>/g, '').trim();
            parts.push(`\n❌ Error: ${errorMsg.slice(0, 200)}\n`);
            continue;
          }

          // Show structured results from toolUseResult if available
          const tur = obj.toolUseResult;
          if (tur && typeof tur === 'object') {
            // Write/Edit results
            if (tur.filePath) {
              parts.push(`  ✅ ${shortPath(tur.filePath)}\n`);
              continue;
            }
            // Glob results
            if (tur.numFiles !== undefined && tur.filenames) {
              parts.push(`  → ${tur.numFiles} file(s) found\n`);
              continue;
            }
            // Grep results
            if (tur.mode) {
              if (tur.mode === 'files_with_matches') {
                parts.push(`  → ${tur.numFiles || 0} file(s) matched\n`);
              } else {
                parts.push(`  → ${tur.numLines || 0} line(s) matched\n`);
              }
              continue;
            }
            // Task/subagent results
            if (tur.status === 'completed') {
              parts.push(`  ✅ Subagent done (${tur.totalToolUseCount || 0} tool calls)\n`);
              continue;
            }
            // Bash results — show brief output
            if (tur.stdout !== undefined || tur.exitCode !== undefined) {
              const code = tur.exitCode ?? 0;
              const stdout = (tur.stdout || '').trim();
              if (code !== 0) {
                parts.push(`  ❌ Exit code ${code}\n`);
              } else if (stdout) {
                const brief = stdout.split('\n').slice(0, 3).join('\n');
                parts.push(`  → ${brief.slice(0, 200)}\n`);
              } else {
                parts.push(`  ✅ OK\n`);
              }
              continue;
            }
          }

          // Fallback: show a brief snippet of the result
          if (result.length > 0 && result.length < 300) {
            // Short results: show them
          } else if (result.length >= 300) {
            // Long results: just confirm receipt
            parts.push(`  → (${result.length} chars)\n`);
          }
        }
      }

      if (parts.length > 0) return parts.join('');
    }

    // --- Streaming deltas (if format uses them) ---
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
      return obj.delta.text;
    }

    if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
      const tool = obj.content_block.name;
      return `\n🔧 ${tool}\n`;
    }

    // --- Result message (end of session) ---
    if (obj.type === 'result' && obj.result) {
      return null; // Don't echo the final result blob — it's redundant
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Wrap the user's prompt with instructions that force implementation.
 * Without this, the model may enter plan mode or just describe what to do.
 */
function wrapPrompt(text: string): string {
  return `${text}

IMPORTANT: Implement the changes directly. Do NOT enter plan mode, do NOT just describe what to do, do NOT ask for confirmation. Read the relevant files, make the code changes using Edit/Write tools, and verify the result. Act autonomously and complete the task fully.`;
}

function spawnClaude(id: string, state: AgentState, text: string): void {
  const args: string[] = [];

  // Non-interactive mode (TUI doesn't work via ConPTY on Windows)
  args.push('-p');
  args.push('--verbose');
  args.push('--output-format', 'stream-json');

  // Skip permissions for autonomous operation
  args.push('--dangerously-skip-permissions');

  // Fresh session every time — no --resume
  // Resuming causes context pollution from previous tasks

  // The wrapped prompt
  args.push(wrapPrompt(text));

  console.log(`[agent ${id.slice(0,6)}] spawning claude (fresh session) prompt=${text.slice(0, 80)}...`);

  const proc = pty.spawn(MINIMAX_CMD, args, {
    cwd: state.workingDirectory,
    cols: 200,
    rows: 50,
    env: getCleanEnv(),
  } as any);

  state.activePty = proc;

  let lineBuffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingOutput = '';
  const recentlySent: string[] = [];
  const MAX_RECENT = 5;

  const flushOutput = () => {
    flushTimer = null;
    if (!pendingOutput) return;

    const stripped = pendingOutput.trim();
    if (!stripped) {
      pendingOutput = '';
      return;
    }
    if (recentlySent.includes(stripped)) {
      pendingOutput = '';
      return;
    }
    recentlySent.push(stripped);
    if (recentlySent.length > MAX_RECENT) recentlySent.shift();

    let output = pendingOutput;
    if (output.length > 8000) {
      output = '... (truncated)\n' + output.slice(-8000);
    }

    state.onOutput(id, output);
    pendingOutput = '';
  };

  proc.onData((data) => {
    const clean = stripPtyNoise(data);
    lineBuffer += clean;

    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const text = parseStreamJsonLine(trimmed);
      if (text) {
        pendingOutput += text;
      }
    }

    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushOutput, 150);
  });

  proc.onExit(({ exitCode }) => {
    if (lineBuffer.trim()) {
      const text = parseStreamJsonLine(lineBuffer.trim());
      if (text) pendingOutput += text;
    }

    if (flushTimer) clearTimeout(flushTimer);
    flushOutput();

    console.log(`[agent ${id.slice(0,6)}] claude exited code=${exitCode}`);
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

  spawnClaude(id, state, text);
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
