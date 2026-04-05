/**
 * Transition logging utility — wires a state machine to the event bus
 * and provides console logging for state transitions and invariant violations.
 */
import type { StateMachine } from './state-machine.js';
import { bus } from './event-bus.js';

/**
 * Wire transition logging onto a StateMachine instance.
 * Logs transitions to console and emits machine:transition events on the bus.
 */
export function wireTransitionLogging<S extends string, E extends string, C>(
  machine: StateMachine<S, E, C>,
  entityId: string,
): void {
  machine.onTransition = (record) => {
    console.log(
      `[${machine.id}:${entityId}] ${record.from} --[${record.event}]--> ${record.to}`,
    );
    bus.emit('machine:transition', {
      machineId: machine.id,
      entityId,
      from: record.from,
      to: record.to,
      event: record.event,
      timestamp: record.timestamp,
    });
  };

  machine.onInvariantViolation = (state, _ctx, machineId) => {
    console.error(
      `[INVARIANT] ${machineId}:${entityId} violated in "${state}"`,
    );
  };

  machine.onInvalidTransition = (state, event) => {
    console.warn(
      `[${machine.id}:${entityId}] invalid event "${event}" in state "${state}"`,
    );
  };
}
