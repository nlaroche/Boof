# Code Standards

## File Size Limits

| Module type | Max lines | Action if exceeded |
|-------------|-----------|-------------------|
| Machine definitions (`machines/`) | 300 | Split states into sub-machines |
| Systems (`systems/`) | 500 | Extract a focused sub-system |
| `autopilot.ts` (orchestrator) | 800 | Extract into systems/ |
| `db-helpers.ts` (CRUD) | 1500 | Split into `crud/` modules |
| `ws-handler.ts` (router) | 800 | Split by message domain |

## Where New Code Goes

```
Is it a lifecycle with states?       → machines/<entity>-machine.ts
Is it a focused concern?             → systems/<concern>.ts
Is it DB read/write?                 → db-helpers.ts (use createAndFetch/updateAndFetch patterns)
Is it a constant, enum, or limit?    → engine/constants.ts
Is it a typed event?                 → engine/event-bus.ts (add to BusEvents)
Is it prompt text for an agent?      → systems/prompt-builder.ts
Is it orchestration logic?           → autopilot.ts (last resort)
```

## DB Access

- All CRUD through `db-helpers.ts` — use `createAndFetch<T>()`, `updateAndFetch<T>()`, `deleteAndBroadcast()`
- No inline SQL in systems or handlers (exception: complex aggregation queries)
- Every new table needs: CREATE IF NOT EXISTS in `db.ts`, TypeScript interface in `types.ts`, CRUD helpers in `db-helpers.ts`
- Use `addColumnIfMissing()` for migrations — never ALTER TABLE directly

## Constants

- No magic strings — import from `engine/constants.ts`
- Status enums: `as const` objects with derived types
- Timeouts, limits, scoring weights: named constants, not inline numbers

## Error Handling

- **Log + decide**: every catch block must log AND choose one of: retry, skip, crash
- **Never silently swallow**: `.catch(() => {})` is banned. At minimum: `.catch(e => console.error('[module] context:', e.message))`
- **Classify failures**: use `failure-tracker.ts` for task failures (agent_error / environment_error / ambiguous_requirement)
- **Escalate**: 3+ consecutive failures on a goal → pause goal, notify

## Prompts

- All agent-facing prompts live in `systems/prompt-builder.ts`
- Prompt text uses template literals, not string concatenation chains
- Include repo map context for planning prompts
- Force the selected task — never tell the agent to "pick" from a list
- Include DONE_WHEN success criteria for every task

## Testing

- Every machine definition: `validateMachineDefinition()` + happy path + error path tests
- Statistical functions: test against known values
- Run all tests: `node --import tsx --test src/server/engine/__tests__/*.test.ts src/server/__tests__/*.test.ts`
- Type check: `node node_modules/tsx/dist/cli.mjs node_modules/typescript/lib/tsc.js --noEmit`

## State Machines

- Define in `machines/<entity>-machine.ts`
- Export: `create<Entity>MachineDef()` factory + Context/State/Event types
- Use `StateMachine<S,E,C>` class — `new StateMachine(def)`, not `createStateMachine()`
- Every state needs `description` and `meta` (skills, toolAccess, contextNeeded)
- Guards prevent invalid transitions; reducers produce new context immutably

## Broadcasting

- CRUD functions take a `broadcast: (item: T) => void` callback
- `ws-handler.ts` provides the broadcast function
- Systems never import `ws-handler` directly — use the callback or event bus
