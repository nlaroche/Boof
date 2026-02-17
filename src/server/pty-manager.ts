import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import path from 'path';
import { getProvider } from './agent-providers.js';
import type { AgentProvider } from './agent-providers.js';

interface AgentState {
  activePty: IPty | null;
  workingDirectory: string;
  name: string;
  agentType: string;
  onOutput: (id: string, chunk: string) => void;
  onExit: (id: string, code: number) => void;
}

const agents: Map<string, AgentState> = new Map();

export function createAgent(
  id: string,
  workingDirectory: string,
  name: string,
  onOutput: (id: string, chunk: string) => void,
  onExit: (id: string, code: number) => void,
  agentType: string = 'claude-sonnet',
): void {
  if (agents.has(id)) {
    killAgent(id);
  }

  agents.set(id, {
    activePty: null,
    workingDirectory,
    name,
    agentType,
    onOutput,
    onExit,
  });

  console.log(`Agent ${id} registered (${name}) [${agentType}]`);
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
    // ConPTY inserts raw \n (line wraps) inside JSON strings, which breaks JSON.parse.
    // Remove all raw newlines — the actual newlines in JSON string values are escaped as \\n.
    const cleaned = line.replace(/\n/g, '');
    const obj = JSON.parse(cleaned);

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

function spawnWithProvider(
  id: string,
  state: AgentState,
  text: string,
  provider: AgentProvider,
  skipWrap?: boolean
): void {
  const prompt = skipWrap ? text : wrapPrompt(text);
  const args = provider.getArgs(prompt);
  const env = provider.getEnv();

  console.log(`[agent ${id.slice(0,6)}] spawning ${provider.name} (fresh session) prompt=${text.slice(0, 80)}...`);

  const proc = pty.spawn(provider.command, args, {
    cwd: state.workingDirectory,
    cols: 1000,
    rows: 50,
    env,
  } as any);

  state.activePty = proc;

  // JSON object extraction using brace counting instead of line splitting,
  // because ConPTY can inject newlines inside JSON objects (especially Write/Edit
  // tool_use blocks that contain multi-line file content).
  let rawBuffer = '';      // Accumulates raw cleaned data
  let braceDepth = 0;
  let inString = false;
  let escapeNext = false;

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingOutput = '';

  const flushOutput = () => {
    flushTimer = null;
    if (!pendingOutput) return;

    const stripped = pendingOutput.trim();
    if (!stripped) {
      pendingOutput = '';
      return;
    }

    let output = pendingOutput;
    if (output.length > 8000) {
      output = '... (truncated)\n' + output.slice(-8000);
    }

    state.onOutput(id, output);
    pendingOutput = '';
  };

  /**
   * Feed new data into the brace-counting parser.
   * Returns an array of complete top-level JSON objects found.
   * Leftover partial data stays in rawBuffer for next call.
   */
  function feedData(newData: string): string[] {
    rawBuffer += newData;
    const objects: string[] = [];
    let objectStart = -1;

    // Find where to start scanning — if we're mid-object, scan from the
    // beginning of rawBuffer. Otherwise, find the first '{'.
    let scanFrom = 0;
    if (braceDepth === 0) {
      // Not in an object — find the first '{'
      const firstBrace = rawBuffer.indexOf('{');
      if (firstBrace < 0) {
        // No objects starting, discard non-JSON noise
        rawBuffer = '';
        return objects;
      }
      scanFrom = firstBrace;
    }

    for (let i = scanFrom; i < rawBuffer.length; i++) {
      const ch = rawBuffer[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (inString) {
        if (ch === '\\') {
          escapeNext = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      // Outside string
      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        if (braceDepth === 0) {
          objectStart = i;
        }
        braceDepth++;
      } else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0 && objectStart >= 0) {
          objects.push(rawBuffer.slice(objectStart, i + 1));
          objectStart = -1;
        }
        // Guard against negative depth from noise
        if (braceDepth < 0) braceDepth = 0;
      }
    }

    // Trim processed data from buffer
    if (objects.length > 0) {
      // Find the end of the last extracted object
      const lastObj = objects[objects.length - 1];
      const lastEnd = rawBuffer.lastIndexOf(lastObj) + lastObj.length;
      rawBuffer = rawBuffer.slice(lastEnd);
      // Reset string state for fresh buffer (we're between objects)
      if (braceDepth === 0) {
        inString = false;
        escapeNext = false;
      }
    } else if (braceDepth === 0) {
      // No objects found and not mid-object — discard noise
      const nextBrace = rawBuffer.indexOf('{');
      if (nextBrace < 0) {
        rawBuffer = '';
      } else {
        rawBuffer = rawBuffer.slice(nextBrace);
      }
    }
    // If braceDepth > 0 and no objects extracted, keep entire rawBuffer

    // Safety: prevent unbounded buffer growth (>512KB = something is wrong)
    if (rawBuffer.length > 512 * 1024) {
      console.log(`[agent ${id.slice(0,6)}] WARNING: rawBuffer exceeded 512KB, resetting parser`);
      rawBuffer = '';
      braceDepth = 0;
      inString = false;
      escapeNext = false;
    }

    return objects;
  }

  proc.onData((data) => {
    const clean = stripPtyNoise(data);
    const objects = feedData(clean);

    for (const jsonStr of objects) {
      const text = parseStreamJsonLine(jsonStr);
      if (text) {
        pendingOutput += text;
      }
    }

    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushOutput, 150);
  });

  proc.onExit(({ exitCode }) => {
    // Try to parse any remaining buffer
    if (rawBuffer.trim()) {
      const text = parseStreamJsonLine(rawBuffer.trim());
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

export function sendToAgent(id: string, text: string, options?: { skipWrap?: boolean }): void {
  const state = agents.get(id);
  if (!state) return;

  if (state.activePty) {
    try { state.activePty.kill(); } catch {}
    state.activePty = null;
  }

  const provider = getProvider(state.agentType);
  spawnWithProvider(id, state, text, provider, options?.skipWrap);
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

/** Kill all agent processes. Call on server shutdown to prevent orphans. */
export function killAllAgents(): void {
  for (const [id, state] of agents) {
    if (state.activePty) {
      try { state.activePty.kill(); } catch {}
    }
    console.log(`Agent ${id} killed (shutdown)`);
  }
  agents.clear();
}

export function restartAgent(
  id: string,
  workingDirectory: string,
  name: string,
  onOutput: (id: string, chunk: string) => void,
  onExit: (id: string, code: number) => void,
  agentType?: string,
): void {
  killAgent(id);
  createAgent(id, workingDirectory, name, onOutput, onExit, agentType);
}

export function getAgentPid(id: string): number | null {
  const state = agents.get(id);
  return state?.activePty ? state.activePty.pid : null;
}

export function hasAgent(id: string): boolean {
  return agents.has(id);
}
