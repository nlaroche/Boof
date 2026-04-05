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

// ============================================================================
// Invariant Violation Tests
// ============================================================================

describe('Invariant Violations', () => {
  it('AgentMachine: running with empty agentId triggers invariant violation', () => {
    let violated = false;
    const def = createAgentMachineDef({ agentId: '' }); // empty agentId
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);
    m.onInvariantViolation = () => { violated = true; };

    m.send('start', { commandId: 'c1' });
    // running invariant: agentId !== '' && startedAt !== null
    // agentId is empty so invariant fails
    assert.equal(violated, true);
    assert.equal(m.state, 'running'); // transition still completes
  });

  it('CommandMachine: reviewing with hasDiff=false triggers invariant violation', () => {
    let violated = false;
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);
    m.onInvariantViolation = () => { violated = true; };

    m.send('exit', { exitCode: 0 });
    // Manually send needs_review WITHOUT diffStats to leave hasDiff false
    // Actually needs_review reduce sets hasDiff: true, so we need to trick it
    // The invariant on reviewing is (c) => c.hasDiff === true
    // Since the reduce always sets hasDiff: true, let's test the invariant directly
    // by constructing a machine at reviewing state with hasDiff=false
    const def2 = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m2 = new StateMachine<CommandState, CommandEvent, CommandContext>(def2);
    m2.onInvariantViolation = () => { violated = true; };

    // Snapshot trick: force into reviewing state with hasDiff=false
    const snap = m2.snapshot();
    snap.state = 'reviewing' as CommandState;
    snap.context.hasDiff = false;
    m2.restore(snap);
    m2.assertInvariant();
    assert.equal(violated, true);
  });

  it('AutopilotMachine: committing with null branchName triggers invariant violation', () => {
    let violated = false;
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1', branchName: null });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);
    m.onInvariantViolation = () => { violated = true; };

    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('task_selected', { task: { id: 't1', title: 'x', description: '' } });
    m.send('impl_done');
    m.send('build_pass');
    m.send('test_pass');
    // committing invariant: branchName !== null — but branchName is null
    assert.equal(violated, true);
    assert.equal(m.state, 'committing');
  });

  it('TaskMachine: in_progress with null assignedAgentId triggers invariant violation', () => {
    let violated = false;
    const def = createTaskMachineDef({ taskId: 't1' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);
    m.onInvariantViolation = () => { violated = true; };

    // Start without providing agentId — reduce defaults to existing null
    m.send('start'); // no payload → assignedAgentId stays null
    assert.equal(violated, true);
    assert.equal(m.state, 'in_progress');
  });

  it('AutopilotMachine: planning without preflightPassed triggers invariant violation', () => {
    let violated = false;
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);
    m.onInvariantViolation = () => { violated = true; };

    // Force into planning without passing preflight via snapshot
    const snap = m.snapshot();
    snap.state = 'planning' as AutopilotState;
    snap.context.preflightPassed = false;
    m.restore(snap);
    m.assertInvariant();
    assert.equal(violated, true);
  });
});

// ============================================================================
// Snapshot/Restore Round-Trip Tests
// ============================================================================

describe('Snapshot/Restore Round-Trips', () => {
  it('CommandMachine: snapshot mid-retry, restore, continue retrying', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'fix', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    // Get to retrying state
    m.send('exit', { exitCode: 1 });
    m.send('needs_retry');
    assert.equal(m.state, 'retrying');
    assert.equal(m.context.retryCount, 1);

    // Snapshot
    const snap = m.snapshot();
    assert.equal(snap.state, 'retrying');
    assert.equal(snap.context.retryCount, 1);

    // Create fresh machine and restore (provide valid context to avoid invariant violation on init)
    const m2 = new StateMachine<CommandState, CommandEvent, CommandContext>(
      createCommandMachineDef({ commandId: 'c1', agentId: 'a1', startedAt: '2024-01-01T00:00:00Z' })
    );
    m2.restore(snap);
    assert.equal(m2.state, 'retrying');
    assert.equal(m2.context.retryCount, 1);

    // Continue from restored state
    m2.send('retry_sent');
    assert.equal(m2.state, 'running');

    m2.send('exit', { exitCode: 0 });
    m2.send('commit', { diffStats: '1 file', filesChanged: ['a.ts'] });
    m2.send('committed');
    assert.equal(m2.state, 'done');
  });

  it('AutopilotMachine: snapshot mid-build, restore, continue', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1', branchName: 'agent/test' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    // Get to building state
    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('task_selected', { task: { id: 't1', title: 'x', description: '' } });
    m.send('impl_done');
    assert.equal(m.state, 'building');

    // Snapshot
    const snap = m.snapshot();

    // Restore to fresh machine
    const m2 = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(createAutopilotMachineDef());
    m2.restore(snap);
    assert.equal(m2.state, 'building');
    assert.equal(m2.context.currentTask!.id, 't1');

    // Continue
    m2.send('build_pass');
    assert.equal(m2.state, 'testing');
  });

  it('CommandMachine: restore with mismatched machineId throws', () => {
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(
      createCommandMachineDef({ commandId: 'c1', agentId: 'a1', startedAt: '2024-01-01T00:00:00Z' })
    );
    const snap = m.snapshot();
    snap.machineId = 'wrong-machine';
    assert.throws(() => m.restore(snap), /doesn't match/);
  });

  it('GoalMachine: snapshot preserves context counters', () => {
    const def = createGoalMachineDef({ goalId: 'g1', name: 'Test' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    m.send('task_completed');
    m.send('task_completed');
    m.send('task_failed');
    m.send('run_finished', { timestamp: '2024-06-01T00:00:00Z' });

    const snap = m.snapshot();
    assert.equal(snap.context.completedTasks, 2);
    assert.equal(snap.context.failedTasks, 1);
    assert.equal(snap.context.totalRuns, 1);

    const m2 = new StateMachine<GoalState, GoalEvent, GoalContext>(
      createGoalMachineDef({ goalId: 'g1' })
    );
    m2.restore(snap);
    assert.equal(m2.context.completedTasks, 2);
    assert.equal(m2.context.failedTasks, 1);
  });
});

// ============================================================================
// Guard Exhaustion Tests
// ============================================================================

describe('Guard Exhaustion', () => {
  it('CommandMachine: exhaust all retries, needs_retry blocked, exhausted works', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    // Retry 1
    m.send('exit', { exitCode: 1 });
    m.send('needs_retry');
    m.send('retry_sent');

    // Retry 2
    m.send('exit', { exitCode: 1 });
    m.send('needs_retry');
    m.send('retry_sent');
    assert.equal(m.context.retryCount, 2);

    // Retry 3 — should be blocked (maxRetries=2)
    m.send('exit', { exitCode: 1 });
    const blocked = m.send('needs_retry');
    assert.equal(blocked, false);
    assert.equal(m.state, 'checking');

    // exhausted should work
    const exhausted = m.send('exhausted');
    assert.equal(exhausted, true);
    assert.equal(m.state, 'failed');
  });

  it('AgentMachine: exhaust MAX_RETRIES, restart blocked', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    // Fail and restart until retries exhausted (MAX_RETRIES=2)
    m.send('start', { commandId: 'c1' });
    m.send('fail', { error: 'e1' }); // retries=1
    m.send('restart', { commandId: 'c2' });
    m.send('fail', { error: 'e2' }); // retries=2

    // Now at retries=2, restart should be blocked by guard
    const blocked = m.send('restart', { commandId: 'c3' });
    assert.equal(blocked, false);
    assert.equal(m.state, 'error');
    assert.equal(m.context.retries, 2);
  });

  it('AutopilotMachine: test failure retries exhaust then fail', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('task_selected', { task: { id: 't1', title: 'x', description: '' } });

    // Test fail 1 → back to implementing
    m.send('impl_done');
    m.send('build_pass');
    m.send('test_fail', { output: 'fail1' });
    assert.equal(m.state, 'implementing');
    assert.equal(m.context.testRetries, 1);

    // Test fail 2 → back to implementing
    m.send('impl_done');
    m.send('build_pass');
    m.send('test_fail', { output: 'fail2' });
    assert.equal(m.state, 'implementing');
    assert.equal(m.context.testRetries, 2);

    // Test fail 3 → failed (guard: testRetries >= 2)
    m.send('impl_done');
    m.send('build_pass');
    m.send('test_fail', { output: 'fail3' });
    assert.equal(m.state, 'failed');
    assert.ok(m.context.error!.includes('fail3'));
  });
});

// ============================================================================
// Self-Loop Bounds Tests
// ============================================================================

describe('Self-Loop Bounds', () => {
  it('GoalMachine: task_completed 100x tracks correctly without infinite loop', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    for (let i = 0; i < 100; i++) {
      m.send('task_completed');
    }

    assert.equal(m.context.completedTasks, 100);
    assert.equal(m.state, 'active');
    assert.equal(m.history.length, 100);
  });

  it('GoalMachine: task_completed while paused returns false', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    m.send('pause');
    assert.equal(m.state, 'paused');

    const result = m.send('task_completed');
    assert.equal(result, false);
    assert.equal(m.context.completedTasks, 0);
  });

  it('GoalMachine: run_finished while paused returns false', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    m.send('pause');
    const result = m.send('run_finished', { timestamp: '2024-01-01T00:00:00Z' });
    assert.equal(result, false);
    assert.equal(m.context.totalRuns, 0);
  });

  it('CommandMachine: multiple retry cycles track retryCount correctly', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z', maxRetries: 5 });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    for (let i = 0; i < 5; i++) {
      m.send('exit', { exitCode: 1 });
      m.send('needs_retry');
      assert.equal(m.context.retryCount, i + 1);
      m.send('retry_sent');
    }

    assert.equal(m.context.retryCount, 5);
    assert.equal(m.state, 'running');
  });
});

// ============================================================================
// Dead Event Tests
// ============================================================================

describe('Dead Events', () => {
  it('CommandMachine: non-existent event returns false', () => {
    const def = createCommandMachineDef({ commandId: 'c1', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    // review_done was removed — verify no such event works
    const result = m.send('review_done' as any);
    assert.equal(result, false);
    assert.equal(m.state, 'running');
  });

  it('AutopilotMachine: cannot send build events from init', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    assert.equal(m.send('build_pass'), false);
    assert.equal(m.send('build_fail'), false);
    assert.equal(m.send('test_pass'), false);
    assert.equal(m.state, 'init');
  });

  it('TaskMachine: cannot complete from todo', () => {
    const def = createTaskMachineDef({ taskId: 't1' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);

    assert.equal(m.send('complete'), false);
    assert.equal(m.state, 'todo');
  });

  it('AgentMachine: cannot complete from idle', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    assert.equal(m.send('complete'), false);
    assert.equal(m.state, 'idle');
  });
});

// ============================================================================
// Transition Logging & History Tests
// ============================================================================

describe('Transition Logging', () => {
  it('onTransition fires for every transition with correct record', () => {
    const records: any[] = [];
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);
    m.onTransition = (r) => records.push(r);

    m.send('exit', { exitCode: 0 });
    m.send('commit', { diffStats: '1 file', filesChanged: ['a.ts'] });
    m.send('committed');

    assert.equal(records.length, 3);

    assert.equal(records[0].from, 'running');
    assert.equal(records[0].to, 'checking');
    assert.equal(records[0].event, 'exit');

    assert.equal(records[1].from, 'checking');
    assert.equal(records[1].to, 'committing');
    assert.equal(records[1].event, 'commit');

    assert.equal(records[2].from, 'committing');
    assert.equal(records[2].to, 'done');
    assert.equal(records[2].event, 'committed');
  });

  it('history is append-only, never mutated by subsequent transitions', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    m.send('start', { commandId: 'c1' });
    const historyAfterFirst = [...m.history];
    assert.equal(historyAfterFirst.length, 1);

    m.send('complete');
    assert.equal(m.history.length, 2);
    // First entry unchanged
    assert.equal(m.history[0].from, historyAfterFirst[0].from);
    assert.equal(m.history[0].to, historyAfterFirst[0].to);
    assert.equal(m.history[0].event, historyAfterFirst[0].event);
  });

  it('onInvalidTransition fires for blocked events', () => {
    let invalidInfo: { state: string; event: string } | null = null;
    const def = createTaskMachineDef({ taskId: 't1' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);
    m.onInvalidTransition = (s, e) => { invalidInfo = { state: s, event: e }; };

    m.send('complete'); // invalid from todo
    assert.deepEqual(invalidInfo, { state: 'todo', event: 'complete' });
  });

  it('contextBefore and contextAfter differ when reduce runs', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    m.send('start', { commandId: 'c1' });
    m.send('fail', { error: 'boom' });

    const failRecord = m.history[1];
    assert.equal(failRecord.contextBefore.retries, 0);
    assert.equal(failRecord.contextAfter.retries, 1);
    assert.equal(failRecord.contextBefore.lastError, null);
    assert.equal(failRecord.contextAfter.lastError, 'boom');
  });
});

// ============================================================================
// validEvents() / can() Tests
// ============================================================================

describe('validEvents and can', () => {
  it('TaskMachine: validEvents from each state', () => {
    const def = createTaskMachineDef({ taskId: 't1' });
    const m = new StateMachine<TaskState, TaskEvent, TaskContext>(def);

    // From todo: start
    assert.deepEqual(m.validEvents().sort(), ['start']);
    assert.equal(m.can('start'), true);
    assert.equal(m.can('complete'), false);

    // From in_progress: complete, fail
    m.send('start', { agentId: 'a1' });
    assert.deepEqual(m.validEvents().sort(), ['complete', 'fail']);

    // From done: archive, reopen
    m.send('complete');
    assert.deepEqual(m.validEvents().sort(), ['archive', 'reopen']);

    // From archived: reopen
    m.send('archive');
    assert.deepEqual(m.validEvents().sort(), ['reopen']);
  });

  it('GoalMachine: validEvents from each state', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    // From active: pause, complete, task_completed, task_failed, run_finished
    const activeEvents = m.validEvents().sort();
    assert.deepEqual(activeEvents, ['complete', 'pause', 'run_finished', 'task_completed', 'task_failed']);

    // From paused: resume
    m.send('pause');
    assert.deepEqual(m.validEvents().sort(), ['resume']);

    // From completed: reactivate
    m.send('resume');
    m.send('complete');
    assert.deepEqual(m.validEvents().sort(), ['reactivate']);
  });

  it('AgentMachine: validEvents from each state', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);

    // From idle: start
    assert.deepEqual(m.validEvents().sort(), ['start']);

    // From running: complete, fail, kill
    m.send('start', { commandId: 'c1' });
    assert.deepEqual(m.validEvents().sort(), ['complete', 'fail', 'kill']);

    // From error (retries < MAX_RETRIES): restart
    m.send('fail', { error: 'err' });
    assert.deepEqual(m.validEvents().sort(), ['restart']);

    // From dead: restart
    m.send('restart', { commandId: 'c2' });
    m.send('kill');
    assert.deepEqual(m.validEvents().sort(), ['restart']);
  });

  it('CommandMachine: validEvents from running', () => {
    const def = createCommandMachineDef({ commandId: 'c1', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);

    assert.deepEqual(m.validEvents().sort(), ['exit']);
  });

  it('CommandMachine: validEvents from checking', () => {
    const def = createCommandMachineDef({ commandId: 'c1', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);
    m.send('exit', { exitCode: 0 });

    const events = m.validEvents().sort();
    // needs_retry (guard: retryCount < maxRetries=2, currently 0 → passes)
    // needs_review, commit, no_changes, exhausted (guard: retryCount >= maxRetries=2, currently 0 → blocked)
    assert.ok(events.includes('needs_retry'));
    assert.ok(events.includes('needs_review'));
    assert.ok(events.includes('commit'));
    assert.ok(events.includes('no_changes'));
    // exhausted should NOT be in validEvents (guard blocks: retryCount=0 < maxRetries=2)
    assert.ok(!events.includes('exhausted'));
  });

  it('AutopilotMachine: can() checks abort from any active state', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);

    // From init: can abort
    assert.equal(m.can('abort'), true);

    // From preflight: can abort
    m.send('start');
    assert.equal(m.can('abort'), true);

    // From done/failed: cannot abort
    m.send('preflight_pass');
    m.send('plan_done');
    m.send('no_tasks');
    assert.equal(m.state, 'done');
    assert.equal(m.can('abort'), false);
  });
});

// ============================================================================
// Meta / StateMeta Tests
// ============================================================================

describe('StateMeta Annotations', () => {
  it('AgentMachine: running state has expected meta', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);
    m.send('start', { commandId: 'c1' });

    const meta = m.getStateMeta();
    assert.ok(meta);
    assert.ok(meta.skills!.includes('code-editing'));
    assert.ok(meta.toolAccess!.includes('pty'));
    assert.ok(meta.contextNeeded!.includes('repo-context'));
  });

  it('AgentMachine: error state is retryable', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);
    m.send('start', { commandId: 'c1' });
    m.send('fail', { error: 'err' });

    const meta = m.getStateMeta();
    assert.ok(meta);
    assert.equal(meta.retryable, true);
  });

  it('AgentMachine: dead state requires new PTY', () => {
    const def = createAgentMachineDef({ agentId: 'a1' });
    const m = new StateMachine<AgentState, AgentEvent, AgentContext>(def);
    m.send('start', { commandId: 'c1' });
    m.send('kill');

    const meta = m.getStateMeta();
    assert.ok(meta);
    assert.equal(meta.requiresNewPty, true);
  });

  it('AutopilotMachine: selecting state uses scoring', () => {
    const def = createAutopilotMachineDef({ agentId: 'a1', goalId: 'g1' });
    const m = new StateMachine<AutopilotState, AutopilotEvent, AutopilotContext>(def);
    m.send('start');
    m.send('preflight_pass');
    m.send('plan_done');
    assert.equal(m.state, 'selecting');

    const meta = m.getStateMeta();
    assert.ok(meta);
    assert.equal(meta.usesScoring, true);
    assert.ok(meta.skills!.includes('task-prioritization'));
  });

  it('CommandMachine: reviewing state needs code-review skill and git access', () => {
    const def = createCommandMachineDef({ commandId: 'c1', agentId: 'a1', prompt: 'test', startedAt: '2024-01-01T00:00:00Z' });
    const m = new StateMachine<CommandState, CommandEvent, CommandContext>(def);
    m.send('exit', { exitCode: 0 });
    m.send('needs_review', { diffStats: '1 file' });

    const meta = m.getStateMeta();
    assert.ok(meta);
    assert.ok(meta.skills!.includes('code-review'));
    assert.ok(meta.toolAccess!.includes('git'));
  });

  it('GoalMachine: active state uses scoring', () => {
    const def = createGoalMachineDef({ goalId: 'g1' });
    const m = new StateMachine<GoalState, GoalEvent, GoalContext>(def);

    const meta = m.getStateMeta();
    assert.ok(meta);
    assert.equal(meta.usesScoring, true);
  });

  it('terminal states have empty meta arrays', () => {
    const cmdDef = createCommandMachineDef({ commandId: 'c1', startedAt: '2024-01-01T00:00:00Z' });
    const cm = new StateMachine<CommandState, CommandEvent, CommandContext>(cmdDef);
    cm.send('exit', { exitCode: 0 });
    cm.send('no_changes');
    assert.equal(cm.state, 'failed');
    const cmdMeta = cm.getStateMeta();
    assert.ok(cmdMeta);
    assert.deepEqual(cmdMeta.skills, []);
    assert.deepEqual(cmdMeta.toolAccess, []);

    const taskDef = createTaskMachineDef({ taskId: 't1' });
    const tm = new StateMachine<TaskState, TaskEvent, TaskContext>(taskDef);
    tm.send('start', { agentId: 'a1' });
    tm.send('complete');
    assert.equal(tm.state, 'done');
    const taskMeta = tm.getStateMeta();
    assert.ok(taskMeta);
    assert.deepEqual(taskMeta.skills, []);
  });
});
