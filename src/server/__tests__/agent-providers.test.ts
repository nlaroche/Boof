import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, listProviders } from '../agent-providers.js';

describe('listProviders', () => {
  it('returns all available provider names', () => {
    const providers = listProviders();
    assert.ok(Array.isArray(providers));
    assert.ok(providers.length > 0);
    assert.ok(providers.includes('minimax'));
    assert.ok(providers.includes('claude-sonnet'));
    assert.ok(providers.includes('claude-opus'));
    assert.ok(providers.includes('claude-haiku'));
  });

  it('returns exactly 4 providers', () => {
    const providers = listProviders();
    assert.equal(providers.length, 4);
  });
});

describe('getProvider', () => {
  it('returns minimax provider by key', () => {
    const provider = getProvider('minimax');
    assert.equal(provider.name, 'MiniMax M2.5');
    assert.ok(typeof provider.command === 'string');
    assert.ok(provider.command.length > 0);
  });

  it('returns claude-sonnet provider by key', () => {
    const provider = getProvider('claude-sonnet');
    assert.equal(provider.name, 'Claude Sonnet');
    assert.ok(typeof provider.command === 'string');
  });

  it('returns claude-opus provider by key', () => {
    const provider = getProvider('claude-opus');
    assert.equal(provider.name, 'Claude Opus');
    assert.ok(typeof provider.command === 'string');
  });

  it('returns claude-haiku provider by key', () => {
    const provider = getProvider('claude-haiku');
    assert.equal(provider.name, 'Claude Haiku');
    assert.ok(typeof provider.command === 'string');
  });

  it('falls back to claude-sonnet for unknown key', () => {
    const provider = getProvider('nonexistent-provider');
    assert.equal(provider.name, 'Claude Sonnet');
  });

  it('falls back to claude-sonnet for empty string', () => {
    const provider = getProvider('');
    assert.equal(provider.name, 'Claude Sonnet');
  });
});

describe('AgentProvider interface', () => {
  it('minimax provider has required methods', () => {
    const provider = getProvider('minimax');
    assert.equal(typeof provider.getArgs, 'function');
    assert.equal(typeof provider.getEnv, 'function');
  });

  it('minimax provider getArgs returns array with prompt', () => {
    const provider = getProvider('minimax');
    const args = provider.getArgs('test prompt');
    assert.ok(Array.isArray(args));
    assert.ok(args.includes('test prompt'));
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('minimax provider getEnv returns object with required vars', () => {
    const provider = getProvider('minimax');
    const env = provider.getEnv();
    assert.ok(typeof env === 'object');
    assert.equal(env['DISABLE_AUTOUPDATER'], '1');
    assert.equal(env['DISABLE_AUTO_MIGRATE_TO_NATIVE'], '1');
    assert.equal(env['DISABLE_INSTALLATION_CHECKS'], '1');
    assert.equal(env['API_TIMEOUT_MS'], '3000000');
    assert.equal(env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'], '1');
    // MiniMax-specific vars
    assert.ok(env['CLAUDE_CONFIG_DIR']);
    assert.ok(env['TWEAKCC_CONFIG_DIR']);
    assert.equal(env['ANTHROPIC_BASE_URL'], 'https://api.minimax.io/anthropic');
    assert.equal(env['ANTHROPIC_MODEL'], 'MiniMax-M2.5-lightning');
  });

  it('minimax provider getEnv removes dangerous vars', () => {
    const provider = getProvider('minimax');
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
    const names = listProviders().map(key => getProvider(key).name);
    const uniqueNames = new Set(names);
    assert.equal(names.length, uniqueNames.size);
  });

  it('all providers return non-empty command', () => {
    const providers = listProviders();
    for (const key of providers) {
      const provider = getProvider(key);
      assert.ok(provider.command.length > 0, `${key} has empty command`);
    }
  });

  it('all providers getArgs returns non-empty array', () => {
    const providers = listProviders();
    for (const key of providers) {
      const provider = getProvider(key);
      const args = provider.getArgs('test');
      assert.ok(args.length > 0, `${key} returns empty args`);
    }
  });

  it('all providers getEnv returns object', () => {
    const providers = listProviders();
    for (const key of providers) {
      const provider = getProvider(key);
      const env = provider.getEnv();
      assert.ok(typeof env === 'object', `${key} getEnv not object`);
    }
  });
});
