/**
 * Task and goal selection scoring tests.
 *
 * Tests the consideration functions in isolation (no DB required)
 * by providing pre-built scoring contexts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskConsiderations,
  goalConsiderations,
  selectBestTask,
  selectBestGoal,
  rankScoredTasks,
  rankScoredGoals,
  type ScoringTask,
  type ScoringGoal,
  type TaskScoringContext,
  type GoalScoringContext,
} from '../../systems/task-selector.js';
import { scoreItem, rankItems } from '../scoring.js';

// ── Test Helpers ──

function makeTask(overrides: Partial<ScoringTask> = {}): ScoringTask {
  return {
    id: 't1',
    title: 'Test task',
    description: 'A test task description',
    status: 'todo',
    goal_id: 'g1',
    created_at: new Date().toISOString(),
    sort_order: 0,
    ...overrides,
  };
}

function makeTaskCtx(overrides: Partial<TaskScoringContext> = {}): TaskScoringContext {
  return {
    agentId: 'a1',
    agentSkills: [],
    failureCounts: new Map(),
    goalPriority: 3,
    maxPriority: 5,
    now: Date.now(),
    ...overrides,
  };
}

function makeGoal(overrides: Partial<ScoringGoal> = {}): ScoringGoal {
  return {
    id: 'g1',
    name: 'Test goal',
    description: 'A test goal',
    status: 'active',
    priority: 3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeGoalCtx(overrides: Partial<GoalScoringContext> = {}): GoalScoringContext {
  return {
    maxPriority: 5,
    actionableTaskCounts: new Map([['g1', 3], ['g2', 1]]),
    totalTaskCounts: new Map([['g1', 5], ['g2', 3]]),
    completedTaskCounts: new Map([['g1', 2], ['g2', 0]]),
    failedTaskCounts: new Map(),
    lastRunTimestamps: new Map(),
    currentGoalId: null,
    now: Date.now(),
    ...overrides,
  };
}

// ── Task Scoring Tests ──

describe('Task Scoring', () => {
  it('all considerations produce valid 0-1 scores', () => {
    const task = makeTask();
    const ctx = makeTaskCtx();
    const result = scoreItem(task, taskConsiderations, ctx);

    assert.ok(result.total >= 0 && result.total <= 1, `Total score ${result.total} not in 0-1`);
    for (const f of result.factors) {
      assert.ok(f.raw >= 0 && f.raw <= 1, `Factor ${f.name} raw score ${f.raw} not in 0-1`);
    }
  });

  it('higher priority tasks score higher', () => {
    const task = makeTask();
    const lowPrio = makeTaskCtx({ goalPriority: 1 });
    const highPrio = makeTaskCtx({ goalPriority: 5 });

    const lowScore = scoreItem(task, taskConsiderations, lowPrio);
    const highScore = scoreItem(task, taskConsiderations, highPrio);

    assert.ok(highScore.total > lowScore.total,
      `High priority (${highScore.total}) should beat low priority (${lowScore.total})`);
  });

  it('tasks with many failures score lower', () => {
    const task = makeTask({ id: 't1' });
    const noFails = makeTaskCtx();
    const manyFails = makeTaskCtx({ failureCounts: new Map([['t1', 5]]) });

    const goodScore = scoreItem(task, taskConsiderations, noFails);
    const badScore = scoreItem(task, taskConsiderations, manyFails);

    assert.ok(goodScore.total > badScore.total,
      `No-fail score (${goodScore.total}) should beat many-fail score (${badScore.total})`);
  });

  it('fresh tasks score higher than old tasks', () => {
    const fresh = makeTask({ created_at: new Date().toISOString() });
    const old = makeTask({ created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() });
    const ctx = makeTaskCtx();

    const freshScore = scoreItem(fresh, taskConsiderations, ctx);
    const oldScore = scoreItem(old, taskConsiderations, ctx);

    assert.ok(freshScore.total > oldScore.total,
      `Fresh score (${freshScore.total}) should beat old score (${oldScore.total})`);
  });

  it('skill match boosts score', () => {
    const task = makeTask({ title: 'Fix React component rendering', description: 'The button component re-renders too often' });
    const noSkills = makeTaskCtx();
    const withSkills = makeTaskCtx({
      agentSkills: [
        { name: 'React components', description: 'Fix and optimize React components', tags: 'react,component,rendering', avg_score: 80 },
      ],
    });

    const noSkillScore = scoreItem(task, taskConsiderations, noSkills);
    const skillScore = scoreItem(task, taskConsiderations, withSkills);

    assert.ok(skillScore.total > noSkillScore.total,
      `Skill match score (${skillScore.total}) should beat no-skill score (${noSkillScore.total})`);
  });

  it('selectBestTask returns highest scoring task', () => {
    const tasks = [
      makeTask({ id: 't1', title: 'Low priority task' }),
      makeTask({ id: 't2', title: 'High priority task' }),
    ];
    const ctx = makeTaskCtx({ goalPriority: 5, maxPriority: 5 });

    const result = selectBestTask(tasks, ctx);
    assert.ok(result !== null);
    assert.ok(result.breakdown.total > 0);
  });

  it('selectBestTask returns null for empty list', () => {
    const result = selectBestTask([], makeTaskCtx());
    assert.equal(result, null);
  });

  it('rankScoredTasks returns all tasks with breakdowns', () => {
    const tasks = [
      makeTask({ id: 't1' }),
      makeTask({ id: 't2' }),
      makeTask({ id: 't3' }),
    ];
    const ctx = makeTaskCtx();
    const ranked = rankScoredTasks(tasks, ctx);

    assert.equal(ranked.length, 3);
    assert.ok(ranked[0].total >= ranked[1].total);
    assert.ok(ranked[1].total >= ranked[2].total);
    assert.ok(ranked[0].factors.length === taskConsiderations.length);
  });
});

// ── Goal Scoring Tests ──

describe('Goal Scoring', () => {
  it('all considerations produce valid 0-1 scores', () => {
    const goal = makeGoal();
    const ctx = makeGoalCtx();
    const result = scoreItem(goal, goalConsiderations, ctx);

    assert.ok(result.total >= 0 && result.total <= 1, `Total score ${result.total} not in 0-1`);
    for (const f of result.factors) {
      assert.ok(f.raw >= 0 && f.raw <= 1, `Factor ${f.name} raw score ${f.raw} not in 0-1`);
    }
  });

  it('higher priority goals score higher', () => {
    const low = makeGoal({ id: 'g1', priority: 1 });
    const high = makeGoal({ id: 'g2', priority: 5 });
    const ctx = makeGoalCtx();

    const lowScore = scoreItem(low, goalConsiderations, ctx);
    const highScore = scoreItem(high, goalConsiderations, ctx);

    assert.ok(highScore.total > lowScore.total,
      `High priority (${highScore.total}) should beat low priority (${lowScore.total})`);
  });

  it('current goal gets momentum bonus', () => {
    const goal = makeGoal({ id: 'g1' });
    const withoutMomentum = makeGoalCtx({ currentGoalId: null });
    const withMomentum = makeGoalCtx({ currentGoalId: 'g1' });

    const noMomentumScore = scoreItem(goal, goalConsiderations, withoutMomentum);
    const momentumScore = scoreItem(goal, goalConsiderations, withMomentum);

    assert.ok(momentumScore.total > noMomentumScore.total,
      `Momentum score (${momentumScore.total}) should beat no-momentum score (${noMomentumScore.total})`);
  });

  it('goals close to completion score higher', () => {
    const almostDone = makeGoal({ id: 'g1' });
    const justStarted = makeGoal({ id: 'g2' });

    const ctx = makeGoalCtx({
      totalTaskCounts: new Map([['g1', 10], ['g2', 10]]),
      completedTaskCounts: new Map([['g1', 9], ['g2', 1]]),
      actionableTaskCounts: new Map([['g1', 1], ['g2', 9]]),
    });

    const almostDoneScore = scoreItem(almostDone, goalConsiderations, ctx);
    const justStartedScore = scoreItem(justStarted, goalConsiderations, ctx);

    // Check the completion_urgency factor specifically
    const almostDoneFactor = almostDoneScore.factors.find(f => f.name === 'completion_urgency');
    const justStartedFactor = justStartedScore.factors.find(f => f.name === 'completion_urgency');

    assert.ok(almostDoneFactor!.raw > justStartedFactor!.raw,
      `Almost done urgency (${almostDoneFactor!.raw}) should beat just started (${justStartedFactor!.raw})`);
  });

  it('goals with no actionable tasks score very low', () => {
    const withTasks = makeGoal({ id: 'g1' });
    const noTasks = makeGoal({ id: 'g2' });

    const ctx = makeGoalCtx({
      actionableTaskCounts: new Map([['g1', 5], ['g2', 0]]),
    });

    const withTasksScore = scoreItem(withTasks, goalConsiderations, ctx);
    const noTasksScore = scoreItem(noTasks, goalConsiderations, ctx);

    assert.ok(withTasksScore.total > noTasksScore.total,
      `With tasks (${withTasksScore.total}) should beat no tasks (${noTasksScore.total})`);
  });

  it('stale goals get a boost', () => {
    const stale = makeGoal({ id: 'g1' });
    const recent = makeGoal({ id: 'g2' });
    const now = Date.now();

    const ctx = makeGoalCtx({
      lastRunTimestamps: new Map([
        ['g1', now - 7 * 24 * 60 * 60 * 1000], // 7 days ago
        ['g2', now - 1 * 60 * 60 * 1000],        // 1 hour ago
      ]),
      now,
    });

    const staleFactor = scoreItem(stale, goalConsiderations, ctx).factors.find(f => f.name === 'staleness');
    const recentFactor = scoreItem(recent, goalConsiderations, ctx).factors.find(f => f.name === 'staleness');

    assert.ok(staleFactor!.raw > recentFactor!.raw,
      `Stale staleness (${staleFactor!.raw}) should beat recent (${recentFactor!.raw})`);
  });

  it('goals with high failure rate score lower', () => {
    const healthy = makeGoal({ id: 'g1' });
    const failing = makeGoal({ id: 'g2' });

    const ctx = makeGoalCtx({
      totalTaskCounts: new Map([['g1', 10], ['g2', 10]]),
      failedTaskCounts: new Map([['g1', 0], ['g2', 8]]),
    });

    const healthyScore = scoreItem(healthy, goalConsiderations, ctx);
    const failingScore = scoreItem(failing, goalConsiderations, ctx);

    const healthyFactor = healthyScore.factors.find(f => f.name === 'failure_rate');
    const failingFactor = failingScore.factors.find(f => f.name === 'failure_rate');

    assert.ok(healthyFactor!.raw > failingFactor!.raw,
      `Healthy failure rate (${healthyFactor!.raw}) should beat failing (${failingFactor!.raw})`);
  });

  it('selectBestGoal returns a goal', () => {
    const goals = [
      makeGoal({ id: 'g1', priority: 3 }),
      makeGoal({ id: 'g2', priority: 5 }),
    ];
    const ctx = makeGoalCtx();
    const result = selectBestGoal(goals, ctx);
    assert.ok(result !== null);
  });

  it('selectBestGoal returns null for empty list', () => {
    const result = selectBestGoal([], makeGoalCtx());
    assert.equal(result, null);
  });

  it('rankScoredGoals returns all goals sorted', () => {
    const goals = [
      makeGoal({ id: 'g1', priority: 1 }),
      makeGoal({ id: 'g2', priority: 5 }),
      makeGoal({ id: 'g3', priority: 3 }),
    ];
    const ctx = makeGoalCtx();
    const ranked = rankScoredGoals(goals, ctx);

    assert.equal(ranked.length, 3);
    assert.ok(ranked[0].total >= ranked[1].total);
    assert.ok(ranked[1].total >= ranked[2].total);
  });
});
