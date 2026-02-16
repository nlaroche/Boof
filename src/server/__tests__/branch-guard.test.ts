import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedBranch, assertNotProtected } from '../branch-guard.js';

describe('isProtectedBranch', () => {
  it('returns true for main', () => {
    assert.equal(isProtectedBranch('main'), true);
  });

  it('returns true for develop', () => {
    assert.equal(isProtectedBranch('develop'), true);
  });

  it('returns true for master', () => {
    assert.equal(isProtectedBranch('master'), true);
  });

  it('returns true for production', () => {
    assert.equal(isProtectedBranch('production'), true);
  });

  it('returns true for staging', () => {
    assert.equal(isProtectedBranch('staging'), true);
  });

  it('returns false for agent/foo/bar-123', () => {
    assert.equal(isProtectedBranch('agent/foo/bar-123'), false);
  });

  it('returns false for feature/xyz', () => {
    assert.equal(isProtectedBranch('feature/xyz'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isProtectedBranch(''), false);
  });
});

describe('assertNotProtected', () => {
  it('throws for main', () => {
    assert.throws(() => assertNotProtected('main'), /protected branch/i);
  });

  it('throws for master', () => {
    assert.throws(() => assertNotProtected('master'), /protected branch/i);
  });

  it('does not throw for agent branch', () => {
    assert.doesNotThrow(() => assertNotProtected('agent/test/foo-123'));
  });

  it('does not throw for feature branch', () => {
    assert.doesNotThrow(() => assertNotProtected('feature/my-feature'));
  });
});
