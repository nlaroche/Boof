/**
 * Machine definition tests — validates structural correctness of all machines.
 *
 * Every machine definition goes through validateMachineDefinition() which checks:
 * 1. All states have descriptions
 * 2. All transitions reference valid states
 * 3. Initial state exists
 * 4. Every state is reachable from initial
 * 5. Every non-terminal state has outgoing transitions
 *
 * Additionally, we test key transition scenarios for each machine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateMachine, validateMachineDefinition } from '../state-machine.js';
import { createTaskMachineDef, type TaskState, type TaskEvent, type TaskContext } from '../../machines/task-machine.js';
import { createGoalMachineDef, type GoalState, type GoalEvent, type GoalContext } from '../../machines/goal-machine.js';
import { createAgentMachineDef, type AgentState, type AgentEvent, type AgentContext } from '../../machines/agent-machine.js';
import { createCommandMachineDef, type CommandState, type CommandEvent, type CommandContext } from '../../machines/command-machine.js';
import { createAutopilotMachineDef, type AutopilotState, type AutopilotEvent, type AutopilotContext } from '../../machines/autopilot-machine.js';

// ============================================================================
// Task Machine
// ============================================================================

describe('TaskMachine', () => {
  it('passes structural validation', () => {
    const def = createTaskMachineDef();
    const errors = validateMachineDefinition(def, ['archived'] as TaskState[]);
    assert.deepEqual(errors, [], `Validation errors: ${JSON.stringify(errors)}`);
  });

  it('follows happy path: todo → in_progress → done → archived', () => {
    const def = createTaskMachineDef({ taskId: 't1', title: 'Test task' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);

    assert.equal(m.state, 'todo');

    m.send('start', { agentId: 'a1' });
    assert.equal(m.state, 'in_progress');
    assert.equal(m.context.assignedAgentId, 'a1');

    m.send('complete');
    assert.equal(m.state, 'done');

    m.send('archive');
    assert.equal(m.state, 'archived');
  });

  it('fail returns to todo with incremented failure count', () => {
    const def = createTaskMachineDef({ taskId: 't1' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);

    m.send('start', { agentId: 'a1' });
    m.send('fail');

    assert.equal(m.state, 'todo');
    assert.equal(m.context.failureCount, 1);
    assert.equal(m.context.assignedAgentId, null);
  });

  it('reopen from done or archived returns to todo', () => {
    const def = createTaskMachineDef({ taskId: 't1' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);

    m.send('start', { agentId: 'a1' });
    m.send('complete');
    assert.equal(m.state, 'done');

    m.send('reopen');
    assert.equal(m.state, 'todo');
  });

  it('cannot start without being in todo state', () => {
    const def = createTaskMachineDef({ taskId: 't1' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);

    m.send('start', { agentId: 'a1' });
    m.send('complete');
    // Cannot start from done
    const result = m.send('start', { agentId: 'a2' });
    assert.equal(result, false);
    assert.equal(m.state, 'done');
  });
});

// ============================================================================
// Goal Machine
// ============================================================================

describe('GoalMachine', () => {
  it('passes structural validation', () => {
    const def = createGoalMachineDef();
    const errors = validateMachineDefinition(def, ['completed'] as GoalState[]);
    assert.deepEqual(errors, [], `Validation errors: ${JSON.stringify(errors)}`);
  });

  it('tracks task completions and failures in context', () => {
    const def = createGoalMachineDef({ goalId: 'g1', name: 'Test goal' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    m.send('task_completed');
    m.send('task_completed');
    m.send('task_failed');

    assert.equal(m.context.completedTasks, 2);
    assert.equal(m.context.failedTasks, 1);
    assert.equal(m.state, 'active');
  });

  it('pause and resume cycle', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    m.send('pause');
    assert.equal(m.state, 'paused');

    m.send('resume');
    assert.equal(m.state, 'active');
  });

  it('complete and reactivate cycle', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    m.send('complete');
    assert.equal(m.state, 'completed');

    m.send('reactivate');
    assert.equal(m.state, 'active');
  });

  it('run_finished increments totalRuns', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    m.send('run_finished', { timestamp: '2024-01-01T00:00:00Z' });
    assert.equal(m.context.totalRuns, 1);
    assert.equal(m.context.lastRunAt, '2024-01-01T00:00:00Z');
  });
});

// ============================================================================
// Agent Machine
// ============================================================================

describe('AgentMachine', () => {
  it('passes structural validation', () => {
    const def = createAgentMachineDef();
    // Agent has no true terminal states — dead/error can restart
    const errors = validateMachineDefinition(def);
    assert.deepEqual(errors, [], `Validation errors: ${JSON.stringify(errors)}`);
  });

  it('idle → start → complete → idle cycle', () => {
    const def = createAgentMachineDef({ agentId: 'a1', name: 'TestAgent' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    assert.equal(m.state, 'idle');
    m.send('start', { commandId: 'c1' });
    assert.equal(m.state, 'running');
    assert.equal(m.context.commandId, 'c1');

    m.send('complete');
    assert.equal(m.state, 'idle');
    assert.equal(m.context.retries, 0);
    assert.equal(m.context.commandId, null);
  });

  it('fail increments retries and records error', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    m.send('start', { commandId: 'c1' });
    m.send('fail', { error: 'build failed' });

    assert.equal(m.state, 'error');
    assert.equal(m.context.retries, 1);
    assert.equal(m.context.lastError, 'build failed');
  });

  it('restart blocked after max retries', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    // Fail twice (MAX_RETRIES = 2)
    m.send('start', { commandId: 'c1' });
    m.send('fail', { error: 'err1' });
    m.send('restart', { commandId: 'c2' });
    m.send('fail', { error: 'err2' });

    // Now at retries=2, restart should be blocked
    const result = m.send('restart', { commandId: 'c3' });
    assert.equal(result, false);
    assert.equal(m.state, 'error');
  });

  it('kill transitions to dead', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    m.send('start', { commandId: 'c1' });
    m.send('kill');
    assert.equal(m.state, 'dead');
  });

  it('can restart from dead state', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    m.send('start', { commandId: 'c1' });
    m.send('kill');
    assert.equal(m.state, 'dead');

    m.send('restart', { commandId: 'c2' });
    assert.equal(m.state, 'running');
  });
});

// ============================================================================
// Command Machine
// ============================================================================

describe('CommandMachine', () => {
  it('passes structural validation', () => {
    const def = createCommandMachineDef();
    const errors = validateMachineDefinition(def, ['done', 'failed'] as CommandState[]);
    assert.deepEqual(errors, [], `Validation errors: ${JSON.stringify(errors)}`);
  });

  it('happy path: running → checking → commit → committing → done', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'fix bug', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    assert.equal(m.state, 'running');

    m.send('exit', { exitCode: 0 });
    assert.equal(m.state, 'checking');

    m.send('commit', { diffStats: '1 file changed', filesChanged: ['src/foo.ts'] });
    assert.equal(m.state, 'committing');

    m.send('committed');
    assert.equal(m.state, 'done');
    assert.ok(m.context.finishedAt !== null);
  });

  it('retry path: running → checking → retrying → running', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    m.send('exit', { exitCode: 1 });
    assert.equal(m.state, 'checking');

    m.send('needs_retry');
    assert.equal(m.state, 'retrying');
    assert.equal(m.context.retryCount, 1);

    m.send('retry_sent');
    assert.equal(m.state, 'running');
  });

  it('review path: running → checking → reviewing → running', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    m.send('exit', { exitCode: 0 });
    m.send('needs_review', { diffStats: '3 files changed' });
    assert.equal(m.state, 'reviewing');
    assert.equal(m.context.hasDiff, true);

    m.send('review_sent');
    assert.equal(m.state, 'running');
    assert.equal(m.context.reviewed, true);
  });

  it('no changes path → failed', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    m.send('exit', { exitCode: 0 });
    m.send('no_changes');
    assert.equal(m.state, 'failed');
    assert.equal(m.context.succeeded, false);
  });
});

// ============================================================================
// Autopilot Machine
// ============================================================================

describe('AutopilotMachine', () => {
  it('passes structural validation', () => {
    const def = createAutopilotMachineDef();
    const errors = validateMachineDefinition(def, ['done', 'failed'] as AutopilotState[]);
    assert.deepEqual(errors, [], `Validation errors: ${JSON.stringify(errors)}`);
  });

  it('happy path through all phases', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1', goalName: 'Test', goalSlug: 'test', branchName: 'agent/test-branch' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    assert.equal(m.state, 'init');

    m.send('start');
    assert.equal(m.state, 'preflight');

    m.send('preflight_pass');
    assert.equal(m.state, 'planning');
    assert.equal(m.context.preflightPassed, true);

    m.send('plan_done', { output: 'TASK: Do something' });
    assert.equal(m.state, 'selecting');

    m.send('task_selected', { task: { id: 't1', title: 'Do something', description: '' }, breakdown: null });
    assert.equal(m.state, 'implementing');
    assert.equal(m.context.currentTask!.id, 't1');

    m.send('impl_done', { output: 'done' });
    assert.equal(m.state, 'building');

    m.send('build_pass');
    assert.equal(m.state, 'testing');

    m.send('test_pass');
    assert.equal(m.state, 'committing');

    m.send('committed', { hash: 'abc123' });
    assert.equal(m.state, 'merging');
    assert.equal(m.context.commitHash, 'abc123');

    m.send('merged');
    assert.equal(m.state, 'reflecting');

    m.send('reflected');
    assert.equal(m.state, 'cycling');

    m.send('cycle_done');
    assert.equal(m.state, 'done');
  });

  it('preflight failure aborts run', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    m.send('start');
    m.send('preflight_fail', { error: 'tests failing' });
    assert.equal(m.state, 'failed');
    assert.equal(m.context.error, 'tests failing');
  });

  it('build failure retries up to 2 times then fails', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('task_selected', { task: { id: 't1', title: 'x', description: '' } });

    // First build fail → retry
    m.send('impl_done');
    m.send('build_fail', { output: 'err1' });
    assert.equal(m.state, 'implementing');
    assert.equal(m.context.buildRetries, 1);

    // Second build fail → retry
    m.send('impl_done');
    m.send('build_fail', { output: 'err2' });
    assert.equal(m.state, 'implementing');
    assert.equal(m.context.buildRetries, 2);

    // Third build fail → failed
    m.send('impl_done');
    m.send('build_fail', { output: 'err3' });
    assert.equal(m.state, 'failed');
  });

  it('no_tasks goes to done (goal may be complete)', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('no_tasks');
    assert.equal(m.state, 'done');
  });

  it('abort from any active state goes to failed', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('task_selected', { task: { id: 't1', title: 'x', description: '' } });

    // Abort mid-implementation
    m.send('abort', { error: 'user cancelled' });
    assert.equal(m.state, 'failed');
    assert.equal(m.context.error, 'user cancelled');
  });

  it('tracks phase timings', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    m.send('start');
    m.send('preflight_pass');

    // After transitioning through init and preflight, we should have timing data
    assert.ok('init' in m.context.phaseTimings);
    assert.ok(typeof m.context.phaseTimings.init === 'number');
  });

  it('merge_skip skips merge and continues to reflecting', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1', branchName: 'agent/test-branch' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('task_selected', { task: { id: 't1', title: 'x', description: '' } });
    m.send('impl_done');
    m.send('build_pass');
    m.send('test_pass');
    m.send('committed');
    m.send('merge_skip');
    assert.equal(m.state, 'reflecting');
  });
});
