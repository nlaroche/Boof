import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import fs from 'fs';
import path from 'path';

interface AgentState {
  activePty: IPty | null;
  sessionId: string | null;
  workingDirectory: string;
  name: string;
  agentType: 'claude' | 'aider';
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
  agentType: 'claude' | 'aider' = 'claude'
): void {
  if (agents.has(id)) {
    killAgent(id);
  }

  agents.set(id, {
    activePty: null,
    sessionId: null,
    workingDirectory,
    name,
    agentType,
    onOutput,
    onExit,
  });

  console.log(`Agent ${id} registered (${name}, type=${agentType})`);
}

function spawnClaude(id: string, state: AgentState, text: string): void {
  const args: string[] = [];
  if (isWindows) {
    args.push('/c', 'claude');
  }
  args.push('-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages');
  if (state.sessionId) {
    args.push('--resume', state.sessionId);
  }
  args.push(text);

  const shell = isWindows ? 'cmd.exe' : 'claude';

  console.log(`[agent ${id.slice(0,6)}] spawning claude: ${shell} ${args.join(' ').slice(0, 80)}...`);

  const proc = pty.spawn(shell, args, {
    cwd: state.workingDirectory,
    cols: 200,
    rows: 50,
    env: getCleanEnv(),
  } as any);

  state.activePty = proc;

  let outputBuffer = '';

  proc.onData((data) => {
    outputBuffer += data;

    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.replace(/\x1b\[[^@-~]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b./g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
      if (!trimmed) continue;

      const jsonStart = trimmed.indexOf('{');
      if (jsonStart === -1) continue;
      const jsonStr = trimmed.slice(jsonStart);

      try {
        const msg = JSON.parse(jsonStr);

        if (msg.type === 'system' && msg.session_id) {
          state.sessionId = msg.session_id;
          console.log(`[agent ${id.slice(0,6)}] session: ${msg.session_id}`);
        }

        if (msg.type === 'content_block_start') {
          if (msg.content_block?.type === 'tool_use' && msg.content_block.name) {
            state.onOutput(id, `\n--- ${msg.content_block.name} ---\n`);
          }
        }

        if (msg.type === 'content_block_delta') {
          if (msg.delta?.type === 'text_delta' && msg.delta.text) {
            state.onOutput(id, msg.delta.text);
          }
        }

        if (msg.type === 'assistant' && !msg.partial && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              state.onOutput(id, block.text);
            }
            if (block.type === 'tool_use') {
              const toolName = block.name || 'unknown';
              let detail = '';
              if (block.input) {
                if (toolName === 'Bash' && block.input.command) {
                  detail = `: ${block.input.command.slice(0, 120)}`;
                } else if ((toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') && block.input.file_path) {
                  detail = `: ${block.input.file_path}`;
                } else if ((toolName === 'Grep' || toolName === 'Glob') && block.input.pattern) {
                  detail = `: ${block.input.pattern}`;
                }
              }
              state.onOutput(id, `\n--- ${toolName}${detail} ---\n`);
            }
          }
        }

        if (msg.type === 'tool_result' && msg.content) {
          let preview = '';
          if (typeof msg.content === 'string') {
            preview = msg.content.slice(0, 300);
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && block.text) {
                preview = block.text.slice(0, 300);
                break;
              }
            }
          }
          if (preview) {
            state.onOutput(id, preview + (preview.length >= 300 ? '...' : '') + '\n');
          }
        }

        if (msg.type === 'result') {
          let summary = '\n=== Task Complete ===\n';
          if (msg.cost_usd !== undefined) {
            summary += `Cost: $${msg.cost_usd.toFixed(4)}\n`;
          }
          if (msg.duration_ms !== undefined) {
            summary += `Duration: ${(msg.duration_ms / 1000).toFixed(1)}s\n`;
          }
          if (msg.num_turns !== undefined) {
            summary += `Turns: ${msg.num_turns}\n`;
          }
          state.onOutput(id, summary);
        }
      } catch {
        // Not valid JSON — partial line, ignore
      }
    }
  });

  proc.onExit(({ exitCode }) => {
    console.log(`[agent ${id.slice(0,6)}] process exited code=${exitCode}`);
    if (state.activePty === proc) {
      state.activePty = null;
    }
    state.onExit(id, exitCode);
  });
}

function spawnAider(id: string, state: AgentState, text: string): void {
  // Check for conventions file — pass via --read so it's context, not the prompt
  const conventionsPath = path.join(state.workingDirectory, 'aider-conventions.md');
  const hasConventions = fs.existsSync(conventionsPath);

  const args: string[] = [];
  if (isWindows) {
    args.push('/c', 'aider', '--yes-always', '--no-fancy-input');
  } else {
    args.push('--yes-always', '--no-fancy-input');
  }
  if (hasConventions) {
    args.push('--read', conventionsPath);
  }
  args.push('--message', text);

  const shell = isWindows ? 'cmd.exe' : 'aider';

  console.log(`[agent ${id.slice(0,6)}] spawning aider: ${args.join(' ').slice(0, 80)}...`);

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
      // Remove cursor movement/positioning
      .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')   // private mode set/reset (?25l, ?25h, etc)
      .replace(/\x1b\[[0-9]*[ABCDHJ]/g, '')        // cursor up/down/fwd/back, erase
      .replace(/\x1b\[[0-9;]*[Hf]/g, '')            // cursor position
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (window titles)
      .replace(/\x1b\[2J/g, '')                     // clear screen
      .replace(/\x1b\[K/g, '')                      // erase to end of line
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '') // control chars (keep \n \r \t)
      .replace(/\r+/g, '')                          // carriage returns
      // Collapse runs of blank lines
      .replace(/\n{3,}/g, '\n\n');

    // Skip if it's just whitespace or spinner noise
    const stripped = clean.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!stripped) {
      aiderBuffer = '';
      return;
    }

    // Skip pure spinner lines ("Waiting for openai/MiniMax-M2.5", "Updating repo map:")
    const lines = stripped.split('\n').filter(l => l.trim());
    const isAllSpinner = lines.length > 0 && lines.every(l =>
      /^[█░\s]*$/.test(l) ||
      /Waiting for \S+/.test(l) ||
      /Updating repo map/.test(l)
    );
    if (isAllSpinner) {
      aiderBuffer = '';
      return;
    }

    state.onOutput(id, clean);
    aiderBuffer = '';
  };

  proc.onData((data) => {
    aiderBuffer += data;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushAider, 150); // debounce 150ms
  });

  proc.onExit(({ exitCode }) => {
    // Flush any remaining buffered output
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

  // Kill any existing running process for this agent
  if (state.activePty) {
    try { state.activePty.kill(); } catch {}
    state.activePty = null;
  }

  if (state.agentType === 'aider') {
    spawnAider(id, state, text);
  } else {
    spawnClaude(id, state, text);
  }
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
  agentType: 'claude' | 'aider' = 'claude'
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
