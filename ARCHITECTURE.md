# Boof Architecture

A game-engine-inspired architecture for autonomous agent orchestration.
Agents are characters, goals are quests, tasks are objectives.

## Core Loop

```
observe state → score options → pick best action → execute → update state → repeat
```

## Directory Structure

```
src/server/
  engine/                    # Core engine (generic, reusable)
    constants.ts             # All enums, magic numbers, timeouts, paths
    assert.ts                # Assertion utilities (score, invariant, defined)
    event-bus.ts             # Typed pub/sub event system
    state-machine.ts         # Generic FSM with context, invariants, history
    scoring.ts               # Utility AI scoring (normalize, weight, combine)
    __tests__/               # Engine tests (reference implementations)

  machines/                  # Entity lifecycle state machines
    agent-machine.ts         # idle → running → error/dead (with retry)
    goal-machine.ts          # active ↔ paused → completed
    task-machine.ts          # todo → in_progress → done → archived
    command-machine.ts       # running → checking → retrying/reviewing → done/failed
    autopilot-machine.ts     # Full autopilot run lifecycle (13 states)

  systems/                   # Focused modules (one concern each)
    git-ops.ts               # Branch management, merging, committing
    build-runner.ts          # Build and test execution
    task-selector.ts         # Utility-scored task/goal selection

  autopilot.ts               # Autopilot orchestration
  ws-handler.ts              # WebSocket message routing (thin)
  db-helpers.ts              # All CRUD operations (canonical)
  db.ts                      # Schema + sql.js wrapper
  pty-manager.ts             # PTY process management
  self-improve.ts            # XP, assessments, skills, experiments
  agent-memory.ts            # File-based memory per repo
  scheduler.ts               # Cron-based scheduling
```

## Engine Patterns

### State Machines (`engine/state-machine.ts`)

Every entity lifecycle is a data-driven state machine:

```typescript
const def: MachineDefinition<MyState, MyEvent, MyContext> = {
  id: 'my-machine',
  initial: 'idle',
  context: { /* typed initial context */ },
  states: {
    idle: {
      description: 'Human-readable description',   // Required
      invariant: (ctx) => ctx.ready === true,       // Checked on enter
      onEnter: (ctx) => ({ ...ctx, startedAt: null }), // Context update
      prompt: 'Optional prompt template',           // For agent-readable state
      meta: { retryable: true },                    // Arbitrary metadata
    },
  },
  transitions: [
    {
      from: 'idle',          // Or array: ['idle', 'error']
      event: 'start',
      to: 'running',
      guard: (ctx) => ctx.retries < MAX,  // Block if false
      reduce: (ctx, p) => ({ ...ctx, id: p.id }), // Immutable context update
      action: (ctx) => console.log('side effect'),
      description: 'Begin execution',
    },
  ],
};

const machine = new StateMachine(def);
machine.send('start', { id: '123' });  // Returns true if transitioned
machine.can('start');                    // Check without transitioning
machine.validEvents();                   // All valid events from current state
machine.snapshot();                      // Serializable state
machine.restore(snapshot);               // Resume from snapshot
```

Key principles:
- **Zero on any factor kills total** (multiplicative scoring)
- **Invariants catch bugs at transition time** (not downstream)
- **Context is immutable** (reduce produces new objects)
- **History is built-in** (every transition recorded)
- **Validate definitions** with `validateMachineDefinition()`

### Scoring (`engine/scoring.ts`)

Utility AI scoring for any "pick the best option" decision:

```typescript
const consideration: Consideration<Item, Context> = {
  name: 'priority',
  description: 'Higher priority = higher score',
  weight: 1.5,
  evaluate: (item, ctx) => normalize(item.priority, 0, ctx.maxPriority),
  // MUST return 0-1 (enforced by assertScore)
};

const result = scoreItem(item, [consideration1, consideration2], ctx);
// result.total: combined score (0-1)
// result.factors: per-factor breakdown (name, raw, weighted)

const ranked = rankItems(items, considerations, ctx);  // Sorted by score
const best = selectBest(items, considerations, ctx);    // Highest score
const pick = selectWeighted(items, considerations, ctx, 3); // Top-3 random
```

Utility functions: `normalize()`, `inverseNormalize()`, `decayCurve()`, `sigmoid()`, `diminishingReturns()`

### Event Bus (`engine/event-bus.ts`)

Typed pub/sub for system-to-system communication:

```typescript
bus.on('agent:status-changed', (data) => { /* typed handler */ });
bus.emit('agent:status-changed', { agentId, from, to });
```

### Constants (`engine/constants.ts`)

All magic strings and numbers. Import these, never use literals:

```typescript
import { AgentStatus, TaskStatus, Timeouts, Limits } from './engine/constants.js';
```

## Adding New Things

### New Entity Lifecycle

1. Define context interface (all data the entity needs)
2. Define states with descriptions and invariants
3. Define transitions with guards and reducers
4. Call `validateMachineDefinition()` in tests
5. Wire `onTransition` to event bus

### New Scoring Factor

1. Create `Consideration<T, Ctx>` with name, description, weight, evaluate
2. `evaluate()` MUST return 0-1 (assertScore enforced)
3. Add to the considerations array
4. Verify impact via `ScoreBreakdown` in tests

### New System Module

1. Create in `systems/` with a single concern
2. Import from `engine/` for infrastructure (constants, scoring, etc.)
3. Import from `db-helpers.ts` for all CRUD
4. Never import ws-handler directly (use event bus)

## Rules

- **No magic strings** — import from `constants.ts`
- **No inline SQL in handlers** — use `db-helpers.ts` CRUD functions
- **No circular imports** — use event bus for cross-module communication
- **All CRUD through db-helpers** — `createAndFetch`, `updateAndFetch`, `deleteAndBroadcast`
- **Test every machine** with `validateMachineDefinition()` + transition tests
- **Score breakdowns logged** for every selection decision
