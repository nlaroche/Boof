/**
 * Event bus tests.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../event-bus.js';

describe('EventBus', () => {
  beforeEach(() => {
    bus.clear();
  });

  it('emits and receives events', () => {
    let received: any = null;
    bus.on('agent:output', (data) => { received = data; });
    bus.emit('agent:output', { agentId: 'a1', chunk: 'hello' });
    assert.deepEqual(received, { agentId: 'a1', chunk: 'hello' });
  });

  it('supports multiple handlers', () => {
    const calls: string[] = [];
    bus.on('agent:output', () => calls.push('handler1'));
    bus.on('agent:output', () => calls.push('handler2'));
    bus.emit('agent:output', { agentId: 'a1', chunk: '' });
    assert.deepEqual(calls, ['handler1', 'handler2']);
  });

  it('off removes a handler', () => {
    let count = 0;
    const handler = () => { count++; };
    bus.on('agent:output', handler);
    bus.emit('agent:output', { agentId: 'a1', chunk: '' });
    assert.equal(count, 1);

    bus.off('agent:output', handler);
    bus.emit('agent:output', { agentId: 'a1', chunk: '' });
    assert.equal(count, 1); // not called again
  });

  it('clear removes all handlers', () => {
    let count = 0;
    bus.on('agent:output', () => { count++; });
    bus.on('goal:completed', () => { count++; });
    bus.clear();
    bus.emit('agent:output', { agentId: 'a1', chunk: '' });
    bus.emit('goal:completed', { goalId: 'g1', agentId: 'a1' });
    assert.equal(count, 0);
  });

  it('listenerCount returns correct count', () => {
    assert.equal(bus.listenerCount('agent:output'), 0);
    bus.on('agent:output', () => {});
    assert.equal(bus.listenerCount('agent:output'), 1);
    bus.on('agent:output', () => {});
    assert.equal(bus.listenerCount('agent:output'), 2);
  });

  it('handler errors are caught and logged', () => {
    // Should not throw
    bus.on('agent:output', () => { throw new Error('handler error'); });
    bus.on('agent:output', () => {}); // second handler still runs
    assert.doesNotThrow(() => {
      bus.emit('agent:output', { agentId: 'a1', chunk: '' });
    });
  });

  it('emitting to event with no handlers is safe', () => {
    assert.doesNotThrow(() => {
      bus.emit('goal:completed', { goalId: 'g1', agentId: 'a1' });
    });
  });
});
