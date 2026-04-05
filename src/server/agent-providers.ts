/**
 * Agent provider abstraction — makes it easy to swap between models.
 * Each provider defines how to spawn and configure a CLI agent process.
 */

export interface AgentProvider {
  /** Display name */
  name: string;
  /** Executable path or command */
  command: string;
  /** Build the args array for spawning */
  getArgs(prompt: string): string[];
  /** Environment variables for the subprocess */
  getEnv(): Record<string, string>;
}

const isWindows = process.platform === 'win32';

/** Clean env: remove vars that cause nested session errors */
function baseEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // Must remove these to prevent "nested session" error from Claude Code
  delete env['CLAUDECODE'];
  delete env['CLAUDE_CODE_ENTRYPOINT'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  env['DISABLE_AUTOUPDATER'] = '1';
  env['DISABLE_AUTO_MIGRATE_TO_NATIVE'] = '1';
  env['DISABLE_INSTALLATION_CHECKS'] = '1';
  env['API_TIMEOUT_MS'] = '3000000';
  env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
  return env;
}

// ── MiniMax M2.5 via cc-mirror (Windows-only) ──────────────────────────
// MiniMax provider requires cc-mirror which is only available on Windows.
// On macOS this provider will be registered but won't work — use Claude providers instead.

import { homedir } from 'os';
import { join } from 'path';

const home = homedir();

const minimaxProvider: AgentProvider = {
  name: 'MiniMax M2.5',
  command: process.env.MINIMAX_CMD
    || (isWindows
      ? join(home, '.cc-mirror', 'minimax', 'native', 'claude.exe')
      : 'minimax'),
  getArgs(prompt: string) {
    return [
      '-p', '--verbose', '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      prompt,
    ];
  },
  getEnv() {
    const env = baseEnv();
    env['CLAUDE_CONFIG_DIR'] = join(home, '.cc-mirror', 'minimax', 'config');
    env['TWEAKCC_CONFIG_DIR'] = join(home, '.cc-mirror', 'minimax', 'tweakcc');
    env['ANTHROPIC_BASE_URL'] = 'https://api.minimax.io/anthropic';
    env['ANTHROPIC_MODEL'] = 'MiniMax-M2.5-lightning';
    env['ANTHROPIC_SMALL_FAST_MODEL'] = 'MiniMax-M2.5-lightning';
    env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = 'MiniMax-M2.5-lightning';
    env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = 'MiniMax-M2.5-lightning';
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = 'MiniMax-M2.5-lightning';
    return env;
  },
};

// ── Claude Code providers ───────────────────────────────────────────────
// On Windows, use node + cli.js directly to bypass claude.cmd which
// mangles arguments through cmd.exe (causes "Input must be provided" error).
// Use process.execPath since node is not in the system PATH on this machine.

const claudeCliJs = isWindows
  ? join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  : '';
const claudeCommand = isWindows ? process.execPath : 'claude';

function claudeArgs(prompt: string, model: string): string[] {
  const base = isWindows ? [claudeCliJs] : [];
  return [
    ...base,
    '-p', '--verbose', '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', model,
    prompt,
  ];
}

const claudeSonnetProvider: AgentProvider = {
  name: 'Claude Sonnet',
  command: claudeCommand,
  getArgs(prompt: string) { return claudeArgs(prompt, 'sonnet'); },
  getEnv() { return baseEnv(); },
};

const claudeOpusProvider: AgentProvider = {
  name: 'Claude Opus',
  command: claudeCommand,
  getArgs(prompt: string) { return claudeArgs(prompt, 'opus'); },
  getEnv() { return baseEnv(); },
};

const claudeHaikuProvider: AgentProvider = {
  name: 'Claude Haiku',
  command: claudeCommand,
  getArgs(prompt: string) { return claudeArgs(prompt, 'haiku'); },
  getEnv() { return baseEnv(); },
};

// ── Registry ────────────────────────────────────────────────────────────

const providers: Record<string, AgentProvider> = {
  minimax: minimaxProvider,
  'claude-sonnet': claudeSonnetProvider,
  'claude-opus': claudeOpusProvider,
  'claude-haiku': claudeHaikuProvider,
};

/** Get a provider by agent_type string. Falls back to claude-sonnet. */
export function getProvider(agentType: string): AgentProvider {
  return providers[agentType] || providers['claude-sonnet'];
}

/** List all available provider names */
export function listProviders(): string[] {
  return Object.keys(providers);
}
