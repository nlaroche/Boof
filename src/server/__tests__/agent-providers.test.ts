import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, listProviders, listProviderIds, calculateCost } from '../agent-providers.js';

describe('listProviders', () => {
  it('returns all available providers with pricing', () => {
    const providers = listProviders();
    assert.ok(Array.isArray(providers));
    assert.ok(providers.length >= 9);
    const ids = providers.map(p => p.id);
    assert.ok(ids.includes('claude-sonnet'));
    assert.ok(ids.includes('claude-opus'));
    assert.ok(ids.includes('claude-haiku'));
    assert.ok(ids.includes('qwen3-coder'));
    assert.ok(ids.includes('qwen3-max'));
    assert.ok(ids.includes('qwen3-flash'));
    assert.ok(ids.includes('aider'));
    assert.ok(ids.includes('codex'));
    assert.ok(ids.includes('custom'));
    // minimax should NOT be present
    assert.ok(!ids.includes('minimax'));
    // Each has pricing info
    for (const p of providers) {
      assert.ok(typeof p.inputCost === 'number');
      assert.ok(typeof p.outputCost === 'number');
      assert.ok(typeof p.name === 'string');
    }
  });
});

describe('getProvider', () => {
  it('returns qwen3-coder provider by key', () => {
    const provider = getProvider('qwen3-coder');
    assert.equal(provider.name, 'Qwen3 Coder Plus');
    assert.ok(typeof provider.command === 'string');
    assert.ok(provider.command.length > 0);
  });

  it('returns claude-sonnet provider by key', () => {
    const provider = getProvider('claude-sonnet');
    assert.equal(provider.name, 'Claude Sonnet 4.6');
    assert.ok(typeof provider.command === 'string');
  });

  it('returns claude-opus provider by key', () => {
    const provider = getProvider('claude-opus');
    assert.equal(provider.name, 'Claude Opus 4.6');
    assert.ok(typeof provider.command === 'string');
  });

  it('returns claude-haiku provider by key', () => {
    const provider = getProvider('claude-haiku');
    assert.equal(provider.name, 'Claude Haiku 4.5');
    assert.ok(typeof provider.command === 'string');
  });

  it('falls back to qwen3-coder for unknown key', () => {
    const provider = getProvider('nonexistent-provider');
    assert.equal(provider.name, 'Qwen3 Coder Plus');
  });

  it('falls back to qwen3-coder for empty string', () => {
    const provider = getProvider('');
    assert.equal(provider.name, 'Qwen3 Coder Plus');
  });
});

describe('calculateCost', () => {
  it('calculates cost from token counts', () => {
    const provider = getProvider('claude-sonnet');
    const cost = calculateCost(provider, 1_000_000, 100_000);
    // Sonnet: $3/1M input + $15/1M output = $3 + $1.5 = $4.50
    assert.ok(cost > 4 && cost < 5, `Expected ~$4.50, got $${cost}`);
  });

  it('returns 0 for zero tokens', () => {
    const provider = getProvider('claude-sonnet');
    assert.equal(calculateCost(provider, 0, 0), 0);
  });
});

describe('AgentProvider interface', () => {
  it('qwen3-coder provider has required methods', () => {
    const provider = getProvider('qwen3-coder');
    assert.equal(typeof provider.getArgs, 'function');
    assert.equal(typeof provider.getEnv, 'function');
  });

  it('qwen3-coder provider getArgs returns array with prompt', () => {
    const provider = getProvider('qwen3-coder');
    const args = provider.getArgs('test prompt');
    assert.ok(Array.isArray(args));
    assert.ok(args.includes('test prompt'));
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('qwen3-coder provider getEnv returns object with Dashscope vars', () => {
    const provider = getProvider('qwen3-coder');
    const env = provider.getEnv();
    assert.ok(typeof env === 'object');
    assert.equal(env['DISABLE_AUTOUPDATER'], '1');
    assert.equal(env['DISABLE_AUTO_MIGRATE_TO_NATIVE'], '1');
    assert.equal(env['DISABLE_INSTALLATION_CHECKS'], '1');
    assert.equal(env['API_TIMEOUT_MS'], '3000000');
    assert.equal(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'], '1');
    // Dashscope-specific vars
    assert.equal(env['ANTHROPIC_BASE_URL'], 'https://dashscope-intl.aliyuncs.com/apps/anthropic');
    assert.equal(env['ANTHROPIC_MODEL'], 'qwen3-coder-plus');
  });

  it('qwen3-coder provider getEnv removes dangerous vars', () => {
    const provider = getProvider('qwen3-coder');
    const env = provider.getEnv();
    assert.equal(env['CLAUDECODE'], undefined);
    assert.equal(env['CLAUDE_CODE_ENTRYPOINT'], undefined);
    assert.equal(env['ANTHROPIC_AUTH_TOKEN'], undefined);
  });

  it('claude-sonnet provider getArgs includes model flag', () => {
    const provider = getProvider('claude-sonnet');
    const args = provider.getArgs('test prompt');
    assert.ok(Array.isArray(args));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('sonnet'));
    assert.ok(args.includes('test prompt'));
  });

  it('claude-opus provider getArgs includes opus model', () => {
    const provider = getProvider('claude-opus');
    const args = provider.getArgs('test prompt');
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('opus'));
  });

  it('claude-haiku provider getArgs includes haiku model', () => {
    const provider = getProvider('claude-haiku');
    const args = provider.getArgs('test prompt');
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('haiku'));
  });

  it('claude providers getEnv has base configuration', () => {
    const provider = getProvider('claude-sonnet');
    const env = provider.getEnv();
    assert.equal(env['DISABLE_AUTOUPDATER'], '1');
    assert.equal(env['DISABLE_AUTO_MIGRATE_TO_NATIVE'], '1');
    assert.equal(env['DISABLE_INSTALLATION_CHECKS'], '1');
    assert.equal(env['CLAUDECODE'], undefined);
  });

  it('all providers have unique names', () => {
    const names = listProviders().map(p => p.name);
    const uniqueNames = new Set(names);
    assert.equal(names.length, uniqueNames.size);
  });

  it('all providers return non-empty command', () => {
    const ids = listProviderIds();
    for (const key of ids) {
      const provider = getProvider(key);
      assert.ok(provider.command.length > 0, `${key} has empty command`);
    }
  });

  it('all providers getArgs returns non-empty array', () => {
    const ids = listProviderIds();
    for (const key of ids) {
      const provider = getProvider(key);
      const args = provider.getArgs('test');
      assert.ok(args.length > 0, `${key} returns empty args`);
    }
  });

  it('all providers getEnv returns object', () => {
    const ids = listProviderIds();
    for (const key of ids) {
      const provider = getProvider(key);
      const env = provider.getEnv();
      assert.ok(typeof env === 'object', `${key} getEnv not object`);
    }
  });

  it('all providers have cost information', () => {
    const ids = listProviderIds();
    for (const key of ids) {
      const provider = getProvider(key);
      assert.ok(typeof provider.inputCostPer1M === 'number', `${key} missing inputCostPer1M`);
      assert.ok(typeof provider.outputCostPer1M === 'number', `${key} missing outputCostPer1M`);
    }
  });
});
