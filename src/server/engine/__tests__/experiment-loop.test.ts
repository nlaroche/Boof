/**
 * Tests for the closed-loop experiment system.
 * Covers statistical functions, composite scoring, and variant assignment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, variance, stddev, welchTTest, cohensD,
  compositeScore, DEFAULT_METRIC_WEIGHTS, pickVariant,
  type RunMetrics,
} from '../../systems/experiment-loop.js';

// ============================================================================
// Statistical Functions
// ============================================================================

describe('mean', () => {
  it('returns 0 for empty array', () => {
    assert.equal(mean([]), 0);
  });

  it('calculates mean correctly', () => {
    assert.equal(mean([1, 2, 3, 4, 5]), 3);
    assert.equal(mean([10, 20]), 15);
    assert.equal(mean([100]), 100);
  });
});

describe('variance', () => {
  it('returns 0 for single element', () => {
    assert.equal(variance([5]), 0);
  });

  it('returns 0 for identical values', () => {
    assert.equal(variance([3, 3, 3, 3]), 0);
  });

  it('calculates sample variance correctly', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, variance=4.571...
    const v = variance([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(v - 4.571) < 0.01, `Expected ~4.571, got ${v}`);
  });
});

describe('welchTTest', () => {
  it('returns pValue=1 for insufficient data', () => {
    const result = welchTTest([1], [2]);
    assert.equal(result.pValue, 1);
  });

  it('detects significant difference between well-separated groups', () => {
    const groupA = [80, 85, 82, 88, 79, 84, 81, 86];
    const groupB = [60, 65, 58, 62, 64, 59, 63, 61];
    const result = welchTTest(groupA, groupB);
    assert.ok(result.pValue < 0.01, `Expected p < 0.01, got ${result.pValue}`);
    assert.ok(result.tStat > 0, 'Group A should be greater');
  });

  it('returns non-significant pValue for similar groups', () => {
    const groupA = [70, 72, 68, 71, 73, 69, 70, 72];
    const groupB = [71, 70, 72, 69, 73, 70, 71, 68];
    const result = welchTTest(groupA, groupB);
    // These groups are nearly identical — should NOT be significant at p<0.05
    assert.ok(result.pValue > 0.05, `Expected p > 0.05 (not significant), got ${result.pValue}`);
  });
});

describe('cohensD', () => {
  it('returns 0 for insufficient data', () => {
    assert.equal(cohensD([1], [2]), 0);
  });

  it('returns large effect size for well-separated groups', () => {
    const groupA = [80, 85, 82, 88, 79, 84, 81, 86];
    const groupB = [60, 65, 58, 62, 64, 59, 63, 61];
    const d = cohensD(groupA, groupB);
    assert.ok(d > 2, `Expected large d (>2), got ${d}`);
  });

  it('returns small effect size for similar groups', () => {
    const groupA = [70, 72, 68, 71, 73, 69, 70, 72];
    const groupB = [71, 70, 72, 69, 73, 70, 71, 68];
    const d = Math.abs(cohensD(groupA, groupB));
    assert.ok(d < 0.3, `Expected small d (<0.3), got ${d}`);
  });

  it('is positive when A > B, negative when A < B', () => {
    const high = [90, 92, 88, 91];
    const low = [50, 52, 48, 51];
    assert.ok(cohensD(high, low) > 0);
    assert.ok(cohensD(low, high) < 0);
  });
});

// ============================================================================
// Composite Scoring
// ============================================================================

describe('compositeScore', () => {
  it('returns high score for perfect metrics', () => {
    const metrics: RunMetrics = {
      score: 100,
      costUsd: 0,
      durationMs: 0,
      mergeSuccess: true,
      buildFailures: 0,
      testFailures: 0,
      filesChanged: 1,
    };
    const s = compositeScore(metrics);
    assert.ok(s > 0.9, `Expected > 0.9, got ${s}`);
  });

  it('returns low score for bad metrics', () => {
    const metrics: RunMetrics = {
      score: 20,
      costUsd: 2.0,
      durationMs: 600_000,
      mergeSuccess: false,
      buildFailures: 3,
      testFailures: 2,
      filesChanged: 15,
    };
    const s = compositeScore(metrics);
    assert.ok(s < 0.3, `Expected < 0.3, got ${s}`);
  });

  it('respects custom weights', () => {
    const metrics: RunMetrics = {
      score: 50,
      costUsd: 0,
      durationMs: 0,
      mergeSuccess: true,
      buildFailures: 0,
      testFailures: 0,
      filesChanged: 1,
    };
    // Weight cost heavily — since cost is 0, this should boost score
    const costWeight = { score: 0.1, cost: 0.8, speed: 0.05, mergeSuccess: 0.025, quality: 0.025 };
    const s = compositeScore(metrics, costWeight);
    assert.ok(s > 0.8, `Expected > 0.8 with heavy cost weight, got ${s}`);
  });

  it('handles null merge success as neutral', () => {
    const metrics: RunMetrics = {
      score: 80,
      costUsd: 0.1,
      durationMs: 30_000,
      mergeSuccess: null,
      buildFailures: 0,
      testFailures: 0,
      filesChanged: 2,
    };
    const s = compositeScore(metrics);
    assert.ok(s > 0.5 && s < 1.0, `Expected reasonable score, got ${s}`);
  });
});
