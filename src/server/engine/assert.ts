/**
 * Assertion utilities for the engine.
 * Used by state machines, scoring, and throughout the codebase.
 * Fail loudly with context-rich errors instead of silently misbehaving.
 */

/** Assert a condition is true. Throws with context if not. */
export function assert(
  condition: boolean,
  message: string,
  context?: Record<string, unknown>
): asserts condition {
  if (!condition) {
    const ctx = context ? ` | ${JSON.stringify(context)}` : '';
    throw new Error(`Assertion failed: ${message}${ctx}`);
  }
}

/** Assert a value is not null/undefined. Returns the narrowed type. */
export function assertDefined<T>(
  value: T | null | undefined,
  name: string
): T {
  if (value === null || value === undefined) {
    throw new Error(`Assertion failed: ${name} is ${value}`);
  }
  return value;
}

/** Assert a score is in the valid 0-1 range. */
export function assertScore(value: number, name: string): void {
  if (typeof value !== 'number' || isNaN(value) || value < 0 || value > 1) {
    throw new Error(
      `Assertion failed: score "${name}" must be 0-1, got ${value}`
    );
  }
}

/** Assert a state machine invariant holds. */
export function assertInvariant(
  condition: boolean,
  machineId: string,
  state: string,
  message: string
): void {
  if (!condition) {
    throw new Error(
      `Invariant violation [${machineId}:${state}]: ${message}`
    );
  }
}
