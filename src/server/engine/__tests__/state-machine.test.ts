/**
 * State machine engine tests.
 * This is the REFERENCE IMPLEMENTATION — agents should follow these patterns
 * when creating new machines.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateMachine,
  validateMachineDefinition,
  type MachineDefinition,
  type TransitionRecord,
} from '../state-machine.js';

// ── Test Machine Definition (a simple door) ──

type DoorState = 'closed' | 'open' | 'locked';
type DoorEvent = 'push' | 'pull' | 'lock' | 'unlock';

interface DoorContext {
  lockCode: string;
  pushCount: number;
  lastAction: string | null;
}

const doorDef: MachineDefinition<DoorState, DoorEvent, DoorContext> = {
  id: 'door',
  initial: 'closed',
  context: { lockCode: '1234', pushCount: 0, lastAction: null },
  states: {
    closed: {
      description: 'Door is closed',
      invariant: (ctx) => ctx.pushCount >= 0,
      onEnter: (ctx) => ({ ...ctx, lastAction: 'closed' }),
    },
    open: {
      description: 'Door is open',
      onEnter: (ctx) => ({ ...ctx, lastAction: 'opened' }),
      prompt: 'The door is open, you can walk through',
    },
    locked: {
      description: 'Door is locked',
      onEnter: (ctx) => ({ ...ctx, lastAction: 'locked' }),
      prompt: (ctx) => `Door locked with code ${ctx.lockCode}`,
      meta: { requiresKey: true },
    },
  },
  transitions: [
    {
      from: 'closed', event: 'push', to: 'open',
      reduce: (ctx) => ({ ...ctx, pushCount: ctx.pushCount + 1 }),
      description: 'Push the door open',
    },
    {
      from: 'open', event: 'pull', to: 'closed',
      description: 'Pull the door closed',
    },
    {
      from: 'closed', event: 'lock', to: 'locked',
      description: 'Lock the door',
    },
    {
      from: 'locked', event: 'unlock', to: 'closed',
      guard: (ctx, payload) => payload?.code === ctx.lockCode,
      description: 'Unlock with correct code',
    },
  ],
};

// ── Tests ──

describe('StateMachine', () => {
  it('starts in initial state with context', () => {
    const m = new StateMachine(doorDef);
    assert.equal(m.state, 'closed');
    assert.equal(m.context.pushCount, 0);
    assert.equal(m.context.lastAction, 'closed'); // onEnter ran
    assert.equal(m.id, 'door');
  });

  it('transitions on valid events', () => {
    const m = new StateMachine(doorDef);
    const result = m.send('push');
    assert.equal(result, true);
    assert.equal(m.state, 'open');
    assert.equal(m.context.pushCount, 1);
    assert.equal(m.context.lastAction, 'opened');
  });

  it('rejects invalid events', () => {
    const m = new StateMachine(doorDef);
    // Can't pull a closed door
    const result = m.send('pull');
    assert.equal(result, false);
    assert.equal(m.state, 'closed');
  });

  it('guard blocks transition with wrong payload', () => {
    const m = new StateMachine(doorDef);
    m.send('lock');
    assert.equal(m.state, 'locked');

    // Wrong code
    const result = m.send('unlock', { code: 'wrong' });
    assert.equal(result, false);
    assert.equal(m.state, 'locked');

    // Right code
    const result2 = m.send('unlock', { code: '1234' });
    assert.equal(result2, true);
    assert.equal(m.state, 'closed');
  });

  it('context is updated by reduce', () => {
    const m = new StateMachine(doorDef);
    m.send('push');
    assert.equal(m.context.pushCount, 1);
    m.send('pull');
    m.send('push');
    assert.equal(m.context.pushCount, 2);
  });

  it('onEnter updates context', () => {
    const m = new StateMachine(doorDef);
    assert.equal(m.context.lastAction, 'closed'); // initial onEnter
    m.send('push');
    assert.equal(m.context.lastAction, 'opened');
    m.send('pull');
    assert.equal(m.context.lastAction, 'closed');
  });

  it('onExit fires when leaving a state', () => {
    let exitedFrom: string | null = null;
    const defWithExit: MachineDefinition<DoorState, DoorEvent, DoorContext> = {
      ...doorDef,
      states: {
        ...doorDef.states,
        closed: {
          ...doorDef.states.closed,
          onExit: () => { exitedFrom = 'closed'; },
        },
      },
    };
    const m = new StateMachine(defWithExit);
    m.send('push');
    assert.equal(exitedFrom, 'closed');
  });

  it('records transition history', () => {
    const m = new StateMachine(doorDef);
    m.send('push');
    m.send('pull');
    assert.equal(m.history.length, 2);

    const first = m.history[0];
    assert.equal(first.from, 'closed');
    assert.equal(first.to, 'open');
    assert.equal(first.event, 'push');
    assert.equal(first.contextBefore.pushCount, 0);
    assert.equal(first.contextAfter.pushCount, 1);
    assert.ok(first.timestamp);
  });

  it('onTransition hook fires with full record', () => {
    const records: TransitionRecord<DoorState, DoorEvent, DoorContext>[] = [];
    const m = new StateMachine(doorDef);
    m.onTransition = (r) => records.push(r);

    m.send('push');
    assert.equal(records.length, 1);
    assert.equal(records[0].from, 'closed');
    assert.equal(records[0].to, 'open');
  });

  it('onInvalidTransition hook fires for bad events', () => {
    let invalidEvent: string | null = null;
    const m = new StateMachine(doorDef);
    m.onInvalidTransition = (_state, event) => { invalidEvent = event; };
    m.send('pull'); // invalid from closed
    assert.equal(invalidEvent, 'pull');
  });

  it('can() checks without transitioning', () => {
    const m = new StateMachine(doorDef);
    assert.equal(m.can('push'), true);
    assert.equal(m.can('pull'), false);
    assert.equal(m.can('lock'), true);
    assert.equal(m.state, 'closed'); // unchanged
  });

  it('validEvents() returns available events', () => {
    const m = new StateMachine(doorDef);
    const events = m.validEvents();
    assert.ok(events.includes('push'));
    assert.ok(events.includes('lock'));
    assert.ok(!events.includes('pull'));
    assert.ok(!events.includes('unlock'));
  });

  it('getPrompt() returns static and dynamic prompts', () => {
    const m = new StateMachine(doorDef);
    assert.equal(m.getPrompt(), null); // closed has no prompt

    m.send('push');
    assert.equal(m.getPrompt(), 'The door is open, you can walk through');

    m.send('pull');
    m.send('lock');
    assert.equal(m.getPrompt(), 'Door locked with code 1234');
  });

  it('getStateDescription() returns description', () => {
    const m = new StateMachine(doorDef);
    assert.equal(m.getStateDescription(), 'Door is closed');
  });

  it('getStateMeta() returns metadata', () => {
    const m = new StateMachine(doorDef);
    m.send('lock');
    const meta = m.getStateMeta();
    assert.deepEqual(meta, { requiresKey: true });
  });

  it('snapshot/restore roundtrip', () => {
    const m = new StateMachine(doorDef);
    m.send('push');
    m.send('pull');
    m.send('push'); // pushCount = 2, state = open

    const snap = m.snapshot();
    assert.equal(snap.state, 'open');
    assert.equal(snap.context.pushCount, 2);
    assert.equal(snap.machineId, 'door');

    // Create new machine and restore
    const m2 = new StateMachine(doorDef);
    assert.equal(m2.state, 'closed');
    m2.restore(snap);
    assert.equal(m2.state, 'open');
    assert.equal(m2.context.pushCount, 2);
  });

  it('restore rejects mismatched machine id', () => {
    const m = new StateMachine(doorDef);
    const snap = m.snapshot();
    snap.machineId = 'wrong';
    assert.throws(() => m.restore(snap), /doesn't match/);
  });

  it('restore rejects invalid state', () => {
    const m = new StateMachine(doorDef);
    const snap = m.snapshot();
    (snap as any).state = 'nonexistent';
    assert.throws(() => m.restore(snap), /Invalid state/);
  });

  it('invariant violation calls handler', () => {
    let violated = false;
    const badDef: MachineDefinition<'a' | 'b', 'go', { value: number }> = {
      id: 'bad',
      initial: 'a',
      context: { value: 0 },
      states: {
        a: { description: 'State A' },
        b: {
          description: 'State B — value must be positive',
          invariant: (ctx) => ctx.value > 0,
        },
      },
      transitions: [
        { from: 'a', event: 'go', to: 'b' },
      ],
    };
    const m = new StateMachine(badDef);
    m.onInvariantViolation = () => { violated = true; };
    m.send('go'); // value is 0, invariant fails
    assert.equal(violated, true);
  });

  it('invariant violation throws if no handler', () => {
    const badDef: MachineDefinition<'a' | 'b', 'go', { value: number }> = {
      id: 'bad',
      initial: 'a',
      context: { value: 0 },
      states: {
        a: { description: 'State A' },
        b: {
          description: 'State B — value must be positive',
          invariant: (ctx) => ctx.value > 0,
        },
      },
      transitions: [
        { from: 'a', event: 'go', to: 'b' },
      ],
    };
    assert.throws(
      () => {
        const m = new StateMachine(badDef);
        m.send('go');
      },
      /Invariant violation/
    );
  });

  it('from accepts array of states', () => {
    type S = 'a' | 'b' | 'c';
    type E = 'go' | 'reset';
    const def: MachineDefinition<S, E, {}> = {
      id: 'multi-from',
      initial: 'a',
      context: {},
      states: {
        a: { description: 'A' },
        b: { description: 'B' },
        c: { description: 'C' },
      },
      transitions: [
        { from: 'a', event: 'go', to: 'b' },
        { from: 'b', event: 'go', to: 'c' },
        { from: ['b', 'c'], event: 'reset', to: 'a', description: 'Reset from B or C' },
      ],
    };

    const m = new StateMachine(def);
    m.send('go');
    assert.equal(m.state, 'b');
    m.send('reset');
    assert.equal(m.state, 'a');

    // Also works from c
    m.send('go');
    m.send('go');
    assert.equal(m.state, 'c');
    m.send('reset');
    assert.equal(m.state, 'a');
  });

  it('payload flows through guard → reduce → action', () => {
    const actions: string[] = [];

    type S = 'idle' | 'active';
    type E = 'start';
    interface Ctx { value: number }

    const def: MachineDefinition<S, E, Ctx> = {
      id: 'payload-flow',
      initial: 'idle',
      context: { value: 0 },
      states: {
        idle: { description: 'Idle' },
        active: { description: 'Active' },
      },
      transitions: [
        {
          from: 'idle', event: 'start', to: 'active',
          guard: (ctx, p) => {
            actions.push(`guard:${p.amount}`);
            return p.amount > 0;
          },
          reduce: (ctx, p) => {
            actions.push(`reduce:${p.amount}`);
            return { ...ctx, value: p.amount };
          },
          action: (ctx, p) => {
            actions.push(`action:${p.amount}`);
          },
        },
      ],
    };

    const m = new StateMachine(def);

    // Blocked by guard
    const r1 = m.send('start', { amount: 0 });
    assert.equal(r1, false);
    assert.deepEqual(actions, ['guard:0']);

    // Passes guard
    actions.length = 0;
    const r2 = m.send('start', { amount: 42 });
    assert.equal(r2, true);
    assert.deepEqual(actions, ['guard:42', 'reduce:42', 'action:42']);
    assert.equal(m.context.value, 42);
  });
});

describe('validateMachineDefinition', () => {
  it('passes for valid definition', () => {
    const errors = validateMachineDefinition(doorDef, ['open', 'locked'] as any);
    // open and locked are marked terminal so dead-end check doesn't apply
    // Actually, open has 'pull' transition and locked has 'unlock', so they're not dead ends
    const errors2 = validateMachineDefinition(doorDef);
    assert.equal(errors2.length, 0);
  });

  it('catches missing initial state', () => {
    const bad = { ...doorDef, initial: 'nonexistent' as any };
    const errors = validateMachineDefinition(bad);
    assert.ok(errors.some(e => e.type === 'missing_initial'));
  });

  it('catches missing description', () => {
    const bad: MachineDefinition<'a', 'go', {}> = {
      id: 'bad',
      initial: 'a',
      context: {},
      states: { a: { description: '' } },
      transitions: [],
    };
    const errors = validateMachineDefinition(bad, ['a']);
    assert.ok(errors.some(e => e.type === 'missing_description'));
  });

  it('catches dangling state references in transitions', () => {
    const bad: MachineDefinition<'a', 'go', {}> = {
      id: 'bad',
      initial: 'a',
      context: {},
      states: { a: { description: 'A' } },
      transitions: [
        { from: 'a', event: 'go', to: 'nonexistent' as any },
      ],
    };
    const errors = validateMachineDefinition(bad);
    assert.ok(errors.some(e => e.type === 'dangling_state'));
  });

  it('catches orphan states', () => {
    const def: MachineDefinition<'a' | 'b' | 'orphan', 'go', {}> = {
      id: 'orphan-test',
      initial: 'a',
      context: {},
      states: {
        a: { description: 'A' },
        b: { description: 'B' },
        orphan: { description: 'Orphan — unreachable' },
      },
      transitions: [
        { from: 'a', event: 'go', to: 'b' },
      ],
    };
    const errors = validateMachineDefinition(def, ['b']);
    assert.ok(errors.some(e => e.type === 'orphan_state' && e.state === 'orphan'));
  });

  it('catches dead-end states', () => {
    const def: MachineDefinition<'a' | 'deadend', 'go', {}> = {
      id: 'deadend-test',
      initial: 'a',
      context: {},
      states: {
        a: { description: 'A' },
        deadend: { description: 'Dead end — no way out' },
      },
      transitions: [
        { from: 'a', event: 'go', to: 'deadend' },
      ],
    };
    // Without marking deadend as terminal
    const errors = validateMachineDefinition(def);
    assert.ok(errors.some(e => e.type === 'dead_end' && e.state === 'deadend'));

    // With marking it as terminal — no error
    const errors2 = validateMachineDefinition(def, ['deadend']);
    assert.ok(!errors2.some(e => e.type === 'dead_end'));
  });
});
