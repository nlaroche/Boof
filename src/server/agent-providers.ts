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
  /** Cost per 1M input tokens (USD) */
  inputCostPer1M: number;
  /** Cost per 1M output tokens (USD) */
  outputCostPer1M: number;
}

/** Calculate cost in USD from token counts */
export function calculateCost(provider: AgentProvider, promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * provider.inputCostPer1M
       + (completionTokens / 1_000_000) * provider.outputCostPer1M;
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

import { homedir } from 'os';
import { join } from 'path';

const home = homedir();

// ── Claude Code providers ───────────────────────────────────────────────
// On Windows, use node + cli.js directly to bypass claude.cmd which
// mangles arguments through cmd.exe (causes "Input must be provided" error).
// Use process.execPath since node is not in the system PATH on this machine.

const claudeCliJs = isWindows
  ? join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  : '';
const claudeCommand = isWindows ? process.execPath : '/opt/homebrew/bin/claude';

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
  name: 'Claude Sonnet 4.6',
  command: claudeCommand,
  inputCostPer1M: 3.00,
  outputCostPer1M: 15.00,
  getArgs(prompt: string) { return claudeArgs(prompt, 'sonnet'); },
  getEnv() { return baseEnv(); },
};

const claudeOpusProvider: AgentProvider = {
  name: 'Claude Opus 4.6',
  command: claudeCommand,
  inputCostPer1M: 15.00,
  outputCostPer1M: 75.00,
  getArgs(prompt: string) { return claudeArgs(prompt, 'opus'); },
  getEnv() { return baseEnv(); },
};

const claudeHaikuProvider: AgentProvider = {
  name: 'Claude Haiku 4.5',
  command: claudeCommand,
  inputCostPer1M: 0.80,
  outputCostPer1M: 4.00,
  getArgs(prompt: string) { return claudeArgs(prompt, 'haiku'); },
  getEnv() { return baseEnv(); },
};

// ── Qwen providers via Dashscope (Anthropic-compatible endpoint) ────────
// Dashscope exposes a native Anthropic Messages API endpoint.
// Uses the same Claude Code binary as other providers, just different env vars.
// Requires DASHSCOPE_API_KEY environment variable.
// Endpoint: https://dashscope-intl.aliyuncs.com/apps/anthropic

function dashscopeEnv(model: string): Record<string, string> {
  const env = baseEnv();
  env['ANTHROPIC_BASE_URL'] = 'https://dashscope-intl.aliyuncs.com/apps/anthropic';
  env['ANTHROPIC_API_KEY'] = process.env.DASHSCOPE_API_KEY || '';
  env['ANTHROPIC_MODEL'] = model;
  env['ANTHROPIC_SMALL_FAST_MODEL'] = model;
  env['ANTHROPIC_DEFAULT_SONNET_MODEL'] = model;
  env['ANTHROPIC_DEFAULT_OPUS_MODEL'] = model;
  env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = model;
  return env;
}

const qwen3CoderProvider: AgentProvider = {
  name: 'Qwen3 Coder Plus',
  command: claudeCommand,
  inputCostPer1M: 0.50,
  outputCostPer1M: 2.00,
  getArgs(prompt: string) { return claudeArgs(prompt, 'qwen3-coder-plus'); },
  getEnv() { return dashscopeEnv('qwen3-coder-plus'); },
};

const qwen3MaxProvider: AgentProvider = {
  name: 'Qwen3 Max (Thinking)',
  command: claudeCommand,
  inputCostPer1M: 0.80,
  outputCostPer1M: 3.00,
  getArgs(prompt: string) { return claudeArgs(prompt, 'qwen3-max'); },
  getEnv() { return dashscopeEnv('qwen3-max'); },
};

const qwen3FlashProvider: AgentProvider = {
  name: 'Qwen3 Coder Flash',
  command: claudeCommand,
  inputCostPer1M: 0.15,
  outputCostPer1M: 0.60,
  getArgs(prompt: string) { return claudeArgs(prompt, 'qwen3-coder-flash'); },
  getEnv() { return dashscopeEnv('qwen3-coder-flash'); },
};

// ── Aider provider ──────────────────────────────────────────────────────

const aiderProvider: AgentProvider = {
  name: 'Aider (Sonnet)',
  command: isWindows ? 'aider' : 'aider',
  inputCostPer1M: 3.00,   // depends on model — default sonnet pricing
  outputCostPer1M: 15.00,
  getArgs(prompt: string) {
    return [
      '--yes-always',       // auto-confirm
      '--no-git',           // boof handles git
      '--message', prompt,
    ];
  },
  getEnv() {
    return { ...process.env } as Record<string, string>;
  },
};

// ── OpenAI Codex CLI provider ───────────────────────────────────────────

const codexProvider: AgentProvider = {
  name: 'Codex CLI',
  command: 'codex',
  inputCostPer1M: 2.50,
  outputCostPer1M: 10.00,
  getArgs(prompt: string) {
    return [
      '--quiet',
      '--approval-mode', 'full-auto',
      prompt,
    ];
  },
  getEnv() {
    return { ...process.env } as Record<string, string>;
  },
};

// ── Custom command provider ─────────────────────────────────────────────
// For any CLI tool that accepts a prompt. Set via env vars:
// BOOF_CUSTOM_CMD, BOOF_CUSTOM_ARGS_TEMPLATE (use {prompt} placeholder)

const customProvider: AgentProvider = {
  name: 'Custom Command',
  command: process.env.BOOF_CUSTOM_CMD || 'echo',
  inputCostPer1M: 0,
  outputCostPer1M: 0,
  getArgs(prompt: string) {
    const template = process.env.BOOF_CUSTOM_ARGS_TEMPLATE || '{prompt}';
    return template.split(' ').map(arg => arg === '{prompt}' ? prompt : arg);
  },
  getEnv() {
    return { ...process.env } as Record<string, string>;
  },
};

// ── Registry ────────────────────────────────────────────────────────────

const providers: Record<string, AgentProvider> = {
  'claude-sonnet': claudeSonnetProvider,
  'claude-opus': claudeOpusProvider,
  'claude-haiku': claudeHaikuProvider,
  'qwen3-coder': qwen3CoderProvider,
  'qwen3-max': qwen3MaxProvider,
  'qwen3-flash': qwen3FlashProvider,
  'aider': aiderProvider,
  'codex': codexProvider,
  'custom': customProvider,
};

/** Get a provider by agent_type string. Falls back to qwen3-coder. */
export function getProvider(agentType: string): AgentProvider {
  return providers[agentType] || providers['qwen3-coder'];
}

/**
 * Get the model ID for a specific role, reading from agent's model_config.
 * Falls back to agent.agent_type if no role-specific config, then to 'claude-sonnet'.
 */
export function getModelForRole(agent: { agent_type?: string; model_config?: string | null }, role: string): string {
  if (agent.model_config) {
    try {
      const config = JSON.parse(agent.model_config);
      if (config[role]) return config[role];
    } catch { /* invalid JSON, fall through */ }
  }
  return agent.agent_type || 'qwen3-coder';
}

/** List all available provider names with their display names and pricing */
export function listProviders(): Array<{ id: string; name: string; inputCost: number; outputCost: number }> {
  return Object.entries(providers).map(([id, p]) => ({
    id,
    name: p.name,
    inputCost: p.inputCostPer1M,
    outputCost: p.outputCostPer1M,
  }));
}

/** List just provider IDs */
export function listProviderIds(): string[] {
  return Object.keys(providers);
}
