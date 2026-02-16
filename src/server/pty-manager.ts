import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

interface AgentState {
  activePty: IPty | null;
  workingDirectory: string;
  name: string;
  sessionId: string | null;
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
  // Prevent nested Claude Code session errors
  delete env['CLAUDECODE'];
  // cc-mirror pattern: unset auth token
  delete env['ANTHROPIC_AUTH_TOKEN'];

  // Point at the cc-mirror minimax config so the process uses MiniMax API
  env['CLAUDE_CONFIG_DIR'] = 'C:\\Users\\nlaroche\\.cc-mirror\\minimax\\config';
  env['TWEAKCC_CONFIG_DIR'] = 'C:\\Users\\nlaroche\\.cc-mirror\\minimax\\tweakcc';
  env['DISABLE_AUTOUPDATER'] = '1';
  env['DISABLE_AUTO_MIGRATE_TO_NATIVE'] = '1';
  env['DISABLE_INSTALLATION_CHECKS'] = '1';

  // MiniMax API settings (also in settings.json but set explicitly for safety)
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
    sessionId: null,
    onOutput,
    onExit,
  });

  console.log(`Agent ${id} registered (${name})`);
}

/**
 * Strip ConPTY escape code noise from raw PTY data.
 * ConPTY on Windows injects cursor movement, private mode, and OSC sequences
 * into the output stream which corrupt JSON parsing.
 */
function stripPtyNoise(data: string): string {
  return data
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')          // private mode set/reset
    .replace(/\x1b\[[0-9]*[ABCDHJ]/g, '')               // cursor movement/erase
    .replace(/\x1b\[[0-9;]*[Hf]/g, '')                   // cursor position
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences
    .replace(/\x1b\[2J/g, '')                            // clear screen
    .replace(/\x1b\[K/g, '')                             // erase to end of line
    .replace(/\x1b\[[0-9;]*m/g, '')                      // ANSI color codes (strip for JSON)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')      // control chars (keep \n \r \t)
    .replace(/\r+/g, '');                                // carriage returns
}

/**
 * Parse a single stream-json line from Claude Code.
 * Returns extracted text to display, or null if nothing to show.
 */
function parseStreamJsonLine(line: string): { text: string | null; sessionId: string | null } {
  try {
    const obj = JSON.parse(line);

    // Init message — capture session_id
    if (obj.type === 'system' && obj.session_id) {
      return { text: null, sessionId: obj.session_id };
    }

    // Assistant text (full message)
    if (obj.type === 'assistant' && obj.message?.content) {
      const parts = obj.message.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);
      if (parts.length > 0) return { text: parts.join(''), sessionId: null };
    }

    // Streaming text delta
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
      return { text: obj.delta.text, sessionId: null };
    }

    // Tool use — show what tool is being called
    if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
      return { text: `\n[Tool: ${obj.content_block.name}]\n`, sessionId: null };
    }

    // Tool result
    if (obj.type === 'result' && obj.result) {
      return { text: obj.result, sessionId: null };
    }

    return { text: null, sessionId: null };
  } catch {
    return { text: null, sessionId: null };
  }
}

function spawnClaude(id: string, state: AgentState, text: string): void {
  const args: string[] = [];

  // Non-interactive mode (TUI doesn't work via ConPTY on Windows)
  args.push('-p');
  args.push('--verbose');
  args.push('--output-format', 'stream-json');

  // Skip permissions for autonomous operation
  args.push('--dangerously-skip-permissions');

  // Resume existing session to maintain conversation context
  if (state.sessionId) {
    args.push('--resume', state.sessionId);
  }

  // The prompt
  args.push(text);

  console.log(`[agent ${id.slice(0,6)}] spawning claude: session=${state.sessionId || 'new'} prompt=${text.slice(0, 80)}...`);

  const proc = pty.spawn(MINIMAX_CMD, args, {
    cwd: state.workingDirectory,
    cols: 200,
    rows: 50,
    env: getCleanEnv(),
  } as any);

  state.activePty = proc;

  // Buffer for accumulating partial JSON lines
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
    // Suppress duplicate flushes (ConPTY re-renders)
    if (recentlySent.includes(stripped)) {
      pendingOutput = '';
      return;
    }
    recentlySent.push(stripped);
    if (recentlySent.length > MAX_RECENT) recentlySent.shift();

    let output = pendingOutput;
    if (output.length > 4000) {
      output = '... (truncated)\n' + output.slice(-4000);
    }

    state.onOutput(id, output);
    pendingOutput = '';
  };

  proc.onData((data) => {
    const clean = stripPtyNoise(data);
    lineBuffer += clean;

    // Process complete lines
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const { text, sessionId } = parseStreamJsonLine(trimmed);
      if (sessionId && !state.sessionId) {
        state.sessionId = sessionId;
        console.log(`[agent ${id.slice(0,6)}] captured session: ${sessionId}`);
      }
      if (text) {
        pendingOutput += text;
      }
    }

    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushOutput, 150);
  });

  proc.onExit(({ exitCode }) => {
    // Process remaining buffer
    if (lineBuffer.trim()) {
      const { text, sessionId } = parseStreamJsonLine(lineBuffer.trim());
      if (sessionId && !state.sessionId) state.sessionId = sessionId;
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
