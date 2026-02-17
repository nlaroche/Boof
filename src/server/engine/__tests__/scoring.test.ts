/**
 * Scoring engine tests.
 * Reference implementation for agents building new scoring considerations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreItem,
  rankItems,
  selectBest,
  selectWeighted,
  normalize,
  inverseNormalize,
  decayCurve,
  diminishingReturns,
  type Consideration,
} from '../scoring.js';

// ── Test Types ──

interface TestItem {
  name: string;
  priority: number;
  failCount: number;
}

interface TestContext {
  maxPriority: number;
}

// ── Test Considerations ──

const priorityFactor: Consideration<TestItem, TestContext> = {
  name: 'priority',
  description: 'Higher priority items score higher',
  weight: 1.5,
  evaluate: (item, ctx) => normalize(item.priority, 0, ctx.maxPriority),
};

const failurePenalty: Consideration<TestItem, TestContext> = {
  name: 'failure_penalty',
  description: 'More failures = lower score',
  weight: 1.0,
  evaluate: (item) => diminishingReturns(item.failCount),
};

const alwaysOne: Consideration<TestItem, TestContext> = {
  name: 'always_one',
  description: 'Always returns 1',
  weight: 1.0,
  evaluate: () => 1,
};

const alwaysZero: Consideration<TestItem, TestContext> = {
  name: 'always_zero',
  description: 'Always returns 0 (hard veto)',
  weight: 1.0,
  evaluate: () => 0,
};

const ctx: TestContext = { maxPriority: 10 };

// ── Tests ──

describe('scoreItem', () => {
  it('scores a single consideration correctly', () => {
    const item: TestItem = { name: 'test', priority: 5, failCount: 0 };
    const result = scoreItem(item, [priorityFactor], ctx);

    assert.equal(result.item, item);
    assert.equal(result.factors.length, 1);
    assert.equal(result.factors[0].name, 'priority');
    assert.equal(result.factors[0].raw, 0.5); // 5/10
    assert.ok(result.total > 0);
    assert.ok(result.total <= 1);
  });

  it('zero on any factor kills total (multiplicative)', () => {
    const item: TestItem = { name: 'vetoed', priority: 10, failCount: 0 };
    const result = scoreItem(item, [alwaysOne, alwaysZero], ctx);
    assert.equal(result.total, 0);
  });

  it('all ones produce total of 1', () => {
    const item: TestItem = { name: 'perfect', priority: 10, failCount: 0 };
    const result = scoreItem(item, [alwaysOne, alwaysOne], ctx);
    assert.equal(result.total, 1);
  });

  it('weights amplify scores', () => {
    const item: TestItem = { name: 'test', priority: 5, failCount: 0 };

    // Weight 1.0
    const lowWeight: Consideration<TestItem, TestContext> = {
      ...priorityFactor,
      weight: 1.0,
    };
    const r1 = scoreItem(item, [lowWeight], ctx);

    // Weight 2.0 (higher weight = more influence)
    const highWeight: Consideration<TestItem, TestContext> = {
      ...priorityFactor,
      weight: 2.0,
    };
    const r2 = scoreItem(item, [highWeight], ctx);

    // Higher weight on a 0.5 raw score should produce a higher weighted score
    // because score^(1/weight) with higher weight → closer to 1
    assert.ok(r2.total > r1.total);
  });

  it('returns empty factors for empty considerations', () => {
    const item: TestItem = { name: 'test', priority: 5, failCount: 0 };
    const result = scoreItem(item, [], ctx);
    assert.equal(result.total, 0);
    assert.equal(result.factors.length, 0);
  });

  it('throws on score outside 0-1 range', () => {
    const badFactor: Consideration<TestItem, TestContext> = {
      name: 'bad',
      description: 'Returns invalid score',
      weight: 1.0,
      evaluate: () => 1.5,
    };
    const item: TestItem = { name: 'test', priority: 5, failCount: 0 };
    assert.throws(() => scoreItem(item, [badFactor], ctx), /must be 0-1/);
  });

  it('throws on negative score', () => {
    const badFactor: Consideration<TestItem, TestContext> = {
      name: 'bad',
      description: 'Returns negative score',
      weight: 1.0,
      evaluate: () => -0.1,
    };
    const item: TestItem = { name: 'test', priority: 5, failCount: 0 };
    assert.throws(() => scoreItem(item, [badFactor], ctx), /must be 0-1/);
  });

  it('breakdown contains all factor details', () => {
    const item: TestItem = { name: 'test', priority: 8, failCount: 2 };
    const result = scoreItem(item, [priorityFactor, failurePenalty], ctx);

    assert.equal(result.factors.length, 2);
    assert.equal(result.factors[0].name, 'priority');
    assert.ok(Math.abs(result.factors[0].raw - 0.8) < 0.001); // 8/10
    assert.equal(result.factors[1].name, 'failure_penalty');
    assert.ok(Math.abs(result.factors[1].raw - 1/3) < 0.001); // 1/(1+2)
  });
});

describe('rankItems', () => {
  it('sorts by total score descending', () => {
    const items: TestItem[] = [
      { name: 'low', priority: 1, failCount: 5 },
      { name: 'high', priority: 9, failCount: 0 },
      { name: 'mid', priority: 5, failCount: 1 },
    ];
    const ranked = rankItems(items, [priorityFactor, failurePenalty], ctx);

    assert.equal(ranked[0].item.name, 'high');
    assert.equal(ranked[ranked.length - 1].item.name, 'low');
    assert.ok(ranked[0].total >= ranked[1].total);
    assert.ok(ranked[1].total >= ranked[2].total);
  });
});

describe('selectBest', () => {
  it('picks the highest scoring item', () => {
    const items: TestItem[] = [
      { name: 'low', priority: 1, failCount: 0 },
      { name: 'high', priority: 9, failCount: 0 },
    ];
    const result = selectBest(items, [priorityFactor], ctx);
    assert.ok(result !== null);
    assert.equal(result.item.name, 'high');
    assert.ok(result.breakdown.total > 0);
  });

  it('returns null for empty list', () => {
    const result = selectBest([], [priorityFactor], ctx);
    assert.equal(result, null);
  });
});

describe('selectWeighted', () => {
  it('returns an item from the list', () => {
    const items: TestItem[] = [
      { name: 'a', priority: 5, failCount: 0 },
      { name: 'b', priority: 5, failCount: 0 },
    ];
    const result = selectWeighted(items, [priorityFactor], ctx, 2);
    assert.ok(result !== null);
    assert.ok(['a', 'b'].includes(result.item.name));
  });

  it('returns null for empty list', () => {
    const result = selectWeighted([], [priorityFactor], ctx);
    assert.equal(result, null);
  });

  it('handles all-zero scores without crashing', () => {
    const items: TestItem[] = [
      { name: 'a', priority: 0, failCount: 0 },
      { name: 'b', priority: 0, failCount: 0 },
    ];
    const result = selectWeighted(items, [priorityFactor], ctx, 2);
    assert.ok(result !== null);
  });
});

describe('utility functions', () => {
  it('normalize maps to 0-1', () => {
    assert.equal(normalize(5, 0, 10), 0.5);
    assert.equal(normalize(0, 0, 10), 0);
    assert.equal(normalize(10, 0, 10), 1);
    assert.equal(normalize(-5, 0, 10), 0); // clamped
    assert.equal(normalize(15, 0, 10), 1); // clamped
  });

  it('inverseNormalize inverts', () => {
    assert.equal(inverseNormalize(0, 0, 10), 1);
    assert.equal(inverseNormalize(10, 0, 10), 0);
    assert.equal(inverseNormalize(5, 0, 10), 0.5);
  });

  it('decayCurve decreases over time', () => {
    const fresh = decayCurve(0, 100);
    const old = decayCurve(100, 100);
    const veryOld = decayCurve(200, 100);

    assert.equal(fresh, 1);
    assert.ok(Math.abs(old - 0.5) < 0.001);
    assert.ok(veryOld < old);
  });

  it('diminishingReturns decreases with count', () => {
    assert.equal(diminishingReturns(0), 1);
    assert.equal(diminishingReturns(1), 0.5);
    assert.ok(Math.abs(diminishingReturns(2) - 1/3) < 0.001);
    assert.equal(diminishingReturns(9), 0.1);
  });
});
