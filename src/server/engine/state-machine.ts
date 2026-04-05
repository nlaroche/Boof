/**
 * Data-driven finite state machine with typed context, invariants, and lifecycle hooks.
 *
 * Design principles:
 * 1. States are data — each carries a typed context bag, description, optional prompt, metadata
 * 2. Machines are defined by configuration objects — serializable, introspectable, testable
 * 3. Context is immutable per transition — reducers produce new context (like Redux)
 * 4. Invariant assertions — conditions that MUST hold in a state, checked on every enter
 * 5. Full history — every transition is recorded with before/after context for debugging
 *
 * See engine/__tests__/state-machine.test.ts for usage examples.
 */

import { assertInvariant } from './assert.js';

// ============================================================================
// Types
// ============================================================================

/** Typed metadata for state definitions — skills, tool access, context needs */
export interface StateMeta {
  /** Skill names this state may need (e.g. 'code-editing', 'git-branch-strategy') */
  skills?: string[];
  /** Tool access categories needed (e.g. 'pty', 'filesystem', 'git', 'build') */
  toolAccess?: string[];
  /** Context keys expected to be available (e.g. 'task-description', 'repo-context') */
  contextNeeded?: string[];
  /** Whether this state is retryable */
  retryable?: boolean;
  /** Whether a new PTY process is required */
  requiresNewPty?: boolean;
  /** Whether this state uses the scoring system */
  usesScoring?: boolean;
  /** Arbitrary additional metadata */
  [key: string]: unknown;
}

/** Definition of a single state — pure data */
export interface StateDefinition<C> {
  /** Human-readable description (for debugging, docs, UI, agent prompts) */
  description: string;
  /** Fires when entering this state. Return new context to update, or void to keep. */
  onEnter?: (ctx: C) => C | void;
  /** Fires when exiting this state. */
  onExit?: (ctx: C) => void;
  /** Condition that MUST be true while in this state. Checked on enter. */
  invariant?: (ctx: C) => boolean;
  /** Prompt template associated with this state (static string or dynamic from context) */
  prompt?: string | ((ctx: C) => string);
  /** Metadata bag — structured annotations for skills, tools, and context needs */
  meta?: StateMeta;
}

/** A transition between states — fully data-driven */
export interface TransitionDef<S extends string, E extends string, C> {
  /** Source state(s) — can be a single state or array */
  from: S | S[];
  /** Event that triggers this transition */
  event: E;
  /** Destination state */
  to: S;
  /** Guard: transition only allowed if this returns true */
  guard?: (ctx: C, payload?: any) => boolean;
  /** Produce new context during transition (immutable update) */
  reduce?: (ctx: C, payload?: any) => C;
  /** Side effect during transition (after reduce, before onEnter) */
  action?: (ctx: C, payload?: any) => void;
  /** Human-readable description of this transition */
  description?: string;
}

/** Full machine definition — the "data" that defines the machine */
export interface MachineDefinition<S extends string, E extends string, C> {
  /** Unique identifier for logging/debugging */
  id: string;
  /** Starting state */
  initial: S;
  /** Initial context */
  context: C;
  /** All states with their definitions */
  states: Record<S, StateDefinition<C>>;
  /** All transitions */
  transitions: TransitionDef<S, E, C>[];
}

/** Serializable snapshot of machine state at a point in time */
export interface MachineSnapshot<S extends string, C> {
  machineId: string;
  state: S;
  context: C;
  timestamp: string;
}

/** Record of a single transition — for history/debugging */
export interface TransitionRecord<S extends string, E extends string, C> {
  from: S;
  to: S;
  event: E;
  payload?: any;
  contextBefore: C;
  contextAfter: C;
  timestamp: string;
}

// ============================================================================
// StateMachine Class
// ============================================================================

export class StateMachine<S extends string, E extends string, C> {
  readonly id: string;
  private _state: S;
  private _context: C;
  private _definition: MachineDefinition<S, E, C>;
  private _history: TransitionRecord<S, E, C>[] = [];

  // ── Lifecycle hooks (set by consumer, e.g. to wire event bus) ──

  /** Called on EVERY successful transition */
  onTransition?: (record: TransitionRecord<S, E, C>) => void;
  /** Called when an invariant fails after entering a state */
  onInvariantViolation?: (state: S, ctx: C, machineId: string) => void;
  /** Called when send() can't find a valid transition */
  onInvalidTransition?: (state: S, event: E, payload?: any) => void;

  constructor(definition: MachineDefinition<S, E, C>) {
    this._definition = definition;
    this.id = definition.id;
    this._state = definition.initial;
    // Deep clone initial context to prevent shared mutation
    this._context = JSON.parse(JSON.stringify(definition.context));

    // Run onEnter for initial state
    const initialStateDef = this._definition.states[this._state];
    if (initialStateDef?.onEnter) {
      const result = initialStateDef.onEnter(this._context);
      if (result !== undefined && result !== null) {
        this._context = result as C;
      }
    }

    // Check invariant on initial state
    this._checkInvariant();
  }

  /** Current state */
  get state(): S {
    return this._state;
  }

  /** Current context (readonly copy) */
  get context(): C {
    return this._context;
  }

  /** Transition history */
  get history(): ReadonlyArray<TransitionRecord<S, E, C>> {
    return this._history;
  }

  /**
   * Send an event with optional payload. Returns true if a transition occurred.
   *
   * Order of operations:
   * 1. Find matching transition (from=current, event=E)
   * 2. Evaluate guard — reject if false
   * 3. Capture contextBefore
   * 4. Call onExit on current state
   * 5. Apply reduce (produce new context)
   * 6. Call transition action
   * 7. Update state
   * 8. Call onEnter on new state (may further update context)
   * 9. Check invariant on new state
   * 10. Record transition, call onTransition hook
   */
  send(event: E, payload?: any): boolean {
    const transition = this._findTransition(event, payload);
    if (!transition) {
      this.onInvalidTransition?.(this._state, event, payload);
      return false;
    }

    const from = this._state;
    const contextBefore = { ...this._context };

    // 1. Exit current state
    const fromDef = this._definition.states[from];
    if (fromDef?.onExit) {
      fromDef.onExit(this._context);
    }

    // 2. Apply reducer (immutable context update)
    if (transition.reduce) {
      this._context = transition.reduce(this._context, payload);
    }

    // 3. Run transition action
    if (transition.action) {
      transition.action(this._context, payload);
    }

    // 4. Enter new state
    this._state = transition.to;
    const toDef = this._definition.states[transition.to];
    if (toDef?.onEnter) {
      const result = toDef.onEnter(this._context);
      if (result !== undefined && result !== null) {
        this._context = result as C;
      }
    }

    // 5. Check invariant
    this._checkInvariant();

    // 6. Record and notify
    const record: TransitionRecord<S, E, C> = {
      from,
      to: transition.to,
      event,
      payload,
      contextBefore,
      contextAfter: { ...this._context },
      timestamp: new Date().toISOString(),
    };
    this._history.push(record);
    this.onTransition?.(record);

    return true;
  }

  /** Check if an event would trigger a valid transition (without executing) */
  can(event: E, payload?: any): boolean {
    return this._findTransition(event, payload) !== null;
  }

  /** Get all events that have valid transitions from the current state */
  validEvents(payload?: any): E[] {
    const events = new Set<E>();
    for (const t of this._definition.transitions) {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from];
      if (!fromStates.includes(this._state)) continue;
      if (t.guard && !t.guard(this._context, payload)) continue;
      events.add(t.event);
    }
    return [...events];
  }

  /** Get a serializable snapshot */
  snapshot(): MachineSnapshot<S, C> {
    return {
      machineId: this.id,
      state: this._state,
      context: JSON.parse(JSON.stringify(this._context)),
      timestamp: new Date().toISOString(),
    };
  }

  /** Restore from a snapshot */
  restore(snapshot: MachineSnapshot<S, C>): void {
    if (snapshot.machineId !== this.id) {
      throw new Error(
        `Snapshot machine "${snapshot.machineId}" doesn't match this machine "${this.id}"`
      );
    }
    if (!(snapshot.state in this._definition.states)) {
      throw new Error(`Invalid state "${snapshot.state}" in snapshot`);
    }
    this._state = snapshot.state;
    this._context = JSON.parse(JSON.stringify(snapshot.context));
  }

  /** Get the prompt for the current state (if defined) */
  getPrompt(): string | null {
    const def = this._definition.states[this._state];
    if (!def?.prompt) return null;
    return typeof def.prompt === 'function' ? def.prompt(this._context) : def.prompt;
  }

  /** Get the description for the current state */
  getStateDescription(): string | null {
    return this._definition.states[this._state]?.description ?? null;
  }

  /** Get metadata for the current state */
  getStateMeta(): StateMeta | null {
    return this._definition.states[this._state]?.meta ?? null;
  }

  /** Get the full definition (for validation/introspection) */
  getDefinition(): Readonly<MachineDefinition<S, E, C>> {
    return this._definition;
  }

  /** Manually assert the current state's invariant */
  assertInvariant(): void {
    this._checkInvariant();
  }

  // ── Private ──

  private _findTransition(event: E, payload?: any): TransitionDef<S, E, C> | null {
    for (const t of this._definition.transitions) {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from];
      if (!fromStates.includes(this._state)) continue;
      if (t.event !== event) continue;
      if (t.guard && !t.guard(this._context, payload)) continue;
      return t;
    }
    return null;
  }

  private _checkInvariant(): void {
    const def = this._definition.states[this._state];
    if (def?.invariant) {
      const holds = def.invariant(this._context);
      if (!holds) {
        if (this.onInvariantViolation) {
          this.onInvariantViolation(this._state, this._context, this.id);
        } else {
          assertInvariant(false, this.id, this._state, 'State invariant violated');
        }
      }
    }
  }
}

// ============================================================================
// Validation Utility — enforces structural correctness of machine definitions
// ============================================================================

export interface ValidationError {
  type: 'missing_description' | 'dangling_state' | 'orphan_state' | 'dead_end' | 'missing_initial';
  message: string;
  state?: string;
  transition?: string;
}

/**
 * Validate a machine definition for structural correctness.
 * Call this in tests for every machine definition.
 *
 * Checks:
 * 1. All states have a description
 * 2. All transitions reference valid states
 * 3. Initial state exists
 * 4. Every state is reachable from initial (no orphan states)
 * 5. Every non-terminal state has at least one outgoing transition
 */
export function validateMachineDefinition<S extends string, E extends string, C>(
  def: MachineDefinition<S, E, C>,
  terminalStates: S[] = []
): ValidationError[] {
  const errors: ValidationError[] = [];
  const stateNames = Object.keys(def.states) as S[];

  // 1. Initial state exists
  if (!stateNames.includes(def.initial)) {
    errors.push({
      type: 'missing_initial',
      message: `Initial state "${def.initial}" not found in states`,
    });
  }

  // 2. All states have descriptions
  for (const name of stateNames) {
    if (!def.states[name].description) {
      errors.push({
        type: 'missing_description',
        message: `State "${name}" missing description`,
        state: name,
      });
    }
  }

  // 3. All transitions reference valid states
  for (const t of def.transitions) {
    const fromStates = Array.isArray(t.from) ? t.from : [t.from];
    for (const f of fromStates) {
      if (!stateNames.includes(f)) {
        errors.push({
          type: 'dangling_state',
          message: `Transition from "${f}" references non-existent state`,
          transition: `${f} → ${t.event} → ${t.to}`,
        });
      }
    }
    if (!stateNames.includes(t.to)) {
      errors.push({
        type: 'dangling_state',
        message: `Transition to "${t.to}" references non-existent state`,
        transition: `${String(t.from)} → ${t.event} → ${t.to}`,
      });
    }
  }

  // 4. Reachability: BFS from initial
  const reachable = new Set<S>();
  const queue: S[] = [def.initial];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const t of def.transitions) {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from];
      if (fromStates.includes(current) && !reachable.has(t.to)) {
        queue.push(t.to);
      }
    }
  }
  for (const name of stateNames) {
    if (!reachable.has(name)) {
      errors.push({
        type: 'orphan_state',
        message: `State "${name}" is not reachable from initial state "${def.initial}"`,
        state: name,
      });
    }
  }

  // 5. Dead ends (non-terminal states with no outgoing transitions)
  for (const name of stateNames) {
    if (terminalStates.includes(name)) continue;
    const hasOutgoing = def.transitions.some((t) => {
      const fromStates = Array.isArray(t.from) ? t.from : [t.from];
      return fromStates.includes(name);
    });
    if (!hasOutgoing) {
      errors.push({
        type: 'dead_end',
        message: `State "${name}" has no outgoing transitions and is not marked as terminal`,
        state: name,
      });
    }
  }

  return errors;
}
