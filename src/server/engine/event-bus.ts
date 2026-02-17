/**
 * Typed event bus — central pub/sub for system-to-system communication.
 * Replaces circular dependencies (getBroadcast pattern) with decoupled events.
 *
 * Usage:
 *   bus.on('agent:status-changed', (data) => { ... });
 *   bus.emit('agent:status-changed', { agentId, from, to });
 */

import type { AgentStatusType } from './constants.js';

// ============================================================================
// Event Definitions — add new events here
// ============================================================================

export interface BusEvents {
  // Agent lifecycle
  'agent:status-changed': { agentId: string; from: AgentStatusType; to: AgentStatusType };
  'agent:output': { agentId: string; chunk: string };

  // Goal lifecycle
  'goal:completed': { goalId: string; agentId: string };
  'goal:switched': { agentId: string; previousGoalId: string; newGoalId: string };

  // Autopilot
  'autopilot:phase-changed': { agentId: string; phase: string; goalId: string };
  'autopilot:run-started': { agentId: string; goalId: string };
  'autopilot:run-finished': { agentId: string; goalId: string; success: boolean };

  // WebSocket broadcast (replaces getBroadcast circular dependency)
  'ws:broadcast': { message: any };
  'ws:send': { ws: any; message: any };
}

// ============================================================================
// EventBus Implementation
// ============================================================================

type Handler<T> = (data: T) => void;

class EventBus {
  private handlers = new Map<string, Set<Handler<any>>>();

  /** Subscribe to an event */
  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  /** Unsubscribe from an event */
  off<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** Emit an event to all subscribers */
  emit<K extends keyof BusEvents>(event: K, data: BusEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[event-bus] Error in handler for "${event}":`, err);
      }
    }
  }

  /** Remove all handlers (useful for tests) */
  clear(): void {
    this.handlers.clear();
  }

  /** Get count of handlers for an event (useful for debugging) */
  listenerCount(event: keyof BusEvents): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/** Singleton event bus instance */
export const bus = new EventBus();
