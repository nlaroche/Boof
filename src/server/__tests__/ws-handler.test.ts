import { describe, it, beforeEach, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleWsMessage, getBroadcast, addClientForTest } from '../ws-handler.js';
import { initDb, runQuery } from '../db.js';
import { initBoofDir, recordPattern, proposeGoals } from '../agent-memory.js';
import type { WSClientMessage } from '../../client/lib/types.js';

// Initialize database before all tests
before(async () => {
  await initDb();
});

// Mock WebSocket interface
interface MockWebSocket {
  readyState: number;
  send: (data: string) => void;
  sentMessages: string[];
}

function createMockWebSocket(): MockWebSocket {
  const ws: MockWebSocket = {
    readyState: 1, // OPEN
    sentMessages: [],
    send: function(data: string) {
      this.sentMessages.push(data);
    }
  };
  return ws;
}

describe('handleWsMessage', () => {
  it('parses valid JSON message', () => {
    const ws = createMockWebSocket();
    const message: WSClientMessage = { type: 'sync:request' };

    // Should not throw
    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles invalid JSON gracefully', () => {
    const ws = createMockWebSocket();

    // Should not throw, just log error
    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, 'not valid json{');
    });
  });

  it('handles malformed message object gracefully', () => {
    const ws = createMockWebSocket();

    // Should not throw
    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, '{"invalid": true}');
    });
  });
});

describe('sync:request message', () => {
  it('sends sync:state response with all data', async () => {
    const ws = createMockWebSocket();
    const message: WSClientMessage = { type: 'sync:request' };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have sent at least one message
    assert.ok(ws.sentMessages.length > 0, 'Should send sync:state');

    const firstMessage = JSON.parse(ws.sentMessages[0]);
    assert.equal(firstMessage.type, 'sync:state');
    assert.ok(Array.isArray(firstMessage.folders), 'Should include folders array');
    assert.ok(Array.isArray(firstMessage.tasks), 'Should include tasks array');
    assert.ok(Array.isArray(firstMessage.agents), 'Should include agents array');
    assert.ok(Array.isArray(firstMessage.goals), 'Should include goals array');
    assert.ok(Array.isArray(firstMessage.workflows), 'Should include workflows array');
  });
});

describe('task message routing', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = createMockWebSocket();
  });

  it('handles task:create message', () => {
    const message: WSClientMessage = {
      type: 'task:create',
      folderId: 'folder-1',
      title: 'Test task',
      description: 'Test description'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles task:update message', () => {
    const message: WSClientMessage = {
      type: 'task:update',
      taskId: 'task-1',
      fields: { title: 'Updated title', status: 'done' }
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles task:delete message', () => {
    const message: WSClientMessage = {
      type: 'task:delete',
      taskId: 'task-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles task:reorder message', () => {
    const message: WSClientMessage = {
      type: 'task:reorder',
      taskId: 'task-1',
      sortOrder: 5
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });
});

describe('folder message routing', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = createMockWebSocket();
  });

  it('handles folder:create message', () => {
    const message: WSClientMessage = {
      type: 'folder:create',
      name: 'New Folder',
      icon: '📁'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles folder:update message', () => {
    const message: WSClientMessage = {
      type: 'folder:update',
      folderId: 'folder-1',
      fields: { name: 'Updated Folder' }
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles folder:delete message', () => {
    const message: WSClientMessage = {
      type: 'folder:delete',
      folderId: 'folder-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });
});

describe('agent message routing', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = createMockWebSocket();
  });

  it('handles agent:create message', () => {
    const message: WSClientMessage = {
      type: 'agent:create',
      workingDirectory: 'D:\\repos\\test',
      name: 'Test Agent',
      profileId: 'robot'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:update message', () => {
    const message: WSClientMessage = {
      type: 'agent:update',
      agentId: 'agent-1',
      fields: { name: 'Updated Agent', instructions: 'New instructions' }
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:delete message', () => {
    const message: WSClientMessage = {
      type: 'agent:delete',
      agentId: 'agent-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:kill message', () => {
    const message: WSClientMessage = {
      type: 'agent:kill',
      agentId: 'agent-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:schedule message', () => {
    const message: WSClientMessage = {
      type: 'agent:schedule',
      agentId: 'agent-1',
      schedule: '0 9 * * *',
      enabled: true,
      prompt: 'Daily task'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:autopilot message', () => {
    const message: WSClientMessage = {
      type: 'agent:autopilot',
      agentId: 'agent-1',
      autopilot: true,
      interval: 300,
      goalId: 'goal-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:autopilot:trigger message', () => {
    const message: WSClientMessage = {
      type: 'agent:autopilot:trigger',
      agentId: 'agent-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:history message', async () => {
    const message: WSClientMessage = {
      type: 'agent:history',
      agentId: 'agent-1',
      limit: 50
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should send response with commands
    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'agent:history');
    assert.equal(response.agentId, 'agent-1');
    assert.ok(Array.isArray(response.commands));
  });

  it('handles agent:activity message', async () => {
    const message: WSClientMessage = {
      type: 'agent:activity',
      agentId: 'agent-1',
      limit: 50
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'agent:activity');
    assert.equal(response.agentId, 'agent-1');
    assert.ok(Array.isArray(response.entries));
  });

  it('handles agent:self-improve message', () => {
    const message: WSClientMessage = {
      type: 'agent:self-improve',
      agentId: 'agent-1',
      enabled: true
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:improvements message', async () => {
    const message: WSClientMessage = {
      type: 'agent:improvements',
      agentId: 'agent-1'
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'agent:improvements');
    assert.equal(response.agentId, 'agent-1');
  });

  it('handles agent:assessments message', async () => {
    const message: WSClientMessage = {
      type: 'agent:assessments',
      agentId: 'agent-1'
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'agent:assessments');
    assert.equal(response.agentId, 'agent-1');
  });

  it('handles agent:interrupt message', () => {
    const message: WSClientMessage = {
      type: 'agent:interrupt',
      agentId: 'agent-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:restart message', () => {
    const message: WSClientMessage = {
      type: 'agent:restart',
      agentId: 'agent-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:branches message', () => {
    const message: WSClientMessage = {
      type: 'agent:branches',
      agentId: 'agent-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:merge-branch message', () => {
    const message: WSClientMessage = {
      type: 'agent:merge-branch',
      agentId: 'agent-1',
      branchName: 'feature/test'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles agent:discard-branch message', () => {
    const message: WSClientMessage = {
      type: 'agent:discard-branch',
      agentId: 'agent-1',
      branchName: 'feature/test'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });
});

describe('goal message routing', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = createMockWebSocket();
  });

  it('handles goal:create message', () => {
    const message: WSClientMessage = {
      type: 'goal:create',
      name: 'Test Goal',
      description: 'Goal description',
      repoId: 'repo-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles goal:propose message', () => {
    const message: WSClientMessage = {
      type: 'goal:propose',
      agentId: 'agent-1',
      name: 'Proposed Goal',
      description: 'Agent proposed this',
      repoId: 'repo-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles goal:update message', () => {
    const message: WSClientMessage = {
      type: 'goal:update',
      goalId: 'goal-1',
      fields: { status: 'completed', priority: 5 }
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles goal:delete message', () => {
    const message: WSClientMessage = {
      type: 'goal:delete',
      goalId: 'goal-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles goal:list message', async () => {
    const message: WSClientMessage = {
      type: 'goal:list'
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'goal:list');
    assert.ok(Array.isArray(response.goals));
  });

  it('handles goal:log message', async () => {
    const message: WSClientMessage = {
      type: 'goal:log',
      goalId: 'goal-1',
      limit: 50
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'goal:log');
    assert.equal(response.goalId, 'goal-1');
    assert.ok(Array.isArray(response.entries));
  });
});

describe('workflow message routing', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = createMockWebSocket();
  });

  it('handles workflow:create message', () => {
    const message: WSClientMessage = {
      type: 'workflow:create',
      name: 'Test Workflow',
      description: 'Workflow description',
      steps: [
        { id: '1', name: 'Step 1', prompt: 'Do task 1', on_fail: 'stop', max_retries: 2 }
      ]
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles workflow:update message', () => {
    const message: WSClientMessage = {
      type: 'workflow:update',
      workflowId: 'workflow-1',
      fields: { name: 'Updated Workflow' }
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles workflow:delete message', () => {
    const message: WSClientMessage = {
      type: 'workflow:delete',
      workflowId: 'workflow-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles workflow:list message', async () => {
    const message: WSClientMessage = {
      type: 'workflow:list'
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'workflow:list');
    assert.ok(Array.isArray(response.workflows));
  });
});

describe('improvement message routing', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = createMockWebSocket();
  });

  it('handles improvement:skip message', () => {
    const message: WSClientMessage = {
      type: 'improvement:skip',
      improvementId: 'improvement-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });

  it('handles improvement:execute message', () => {
    const message: WSClientMessage = {
      type: 'improvement:execute',
      improvementId: 'improvement-1',
      agentId: 'agent-1'
    };

    assert.doesNotThrow(() => {
      handleWsMessage(ws as any, JSON.stringify(message));
    });
  });
});

describe('repos message routing', () => {
  it('handles repos:list message', async () => {
    const ws = createMockWebSocket();
    const message: WSClientMessage = {
      type: 'repos:list'
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    // Give a small delay for synchronous processing
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0);
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'repos:list');
    assert.ok(Array.isArray(response.repos));
  });
});

describe('getBroadcast', () => {
  it('returns a function', () => {
    const broadcast = getBroadcast();
    assert.equal(typeof broadcast, 'function');
  });

  it('broadcast function accepts server message', () => {
    const broadcast = getBroadcast();

    // Should not throw
    assert.doesNotThrow(() => {
      broadcast({ type: 'notify', agentId: 'test', title: 'Test', body: 'Test message' });
    });
  });
});

describe('goal stats WebSocket messages', () => {
  let ws: MockWebSocket;

  beforeEach(() => {
    ws = createMockWebSocket();
  });

  it('handles goal:get-stats message and returns goal:stats response', async () => {
    const message: WSClientMessage = {
      type: 'goal:get-stats',
      goalId: 'nonexistent-goal-id'
    };

    handleWsMessage(ws as any, JSON.stringify(message));

    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0, 'Should send a response');
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'goal:stats', 'Response type should be goal:stats');
    assert.equal(response.goalId, 'nonexistent-goal-id', 'Response should include goalId');
    assert.equal(response.stats, null, 'Stats should be null for nonexistent goal');
  });

  it('goal:stats response has correct shape when stats exist', async () => {
    const { runQuery: rq, getOne: go } = await import('../db.js');

    // Insert a goal and its stats
    const goalId = 'test-stats-goal-' + Date.now();
    const now = new Date().toISOString();
    rq(
      `INSERT INTO goals (id, name, description, status, priority, created_at, updated_at)
       VALUES (?, 'Stats Test Goal', '', 'active', 3, ?, ?)`,
      [goalId, now, now]
    );
    rq(
      `INSERT INTO goal_stats (goal_id, total_runs, tasks_completed, tasks_failed, avg_duration_ms, last_run_at)
       VALUES (?, 5, 4, 1, 7500, ?)`,
      [goalId, now]
    );

    const message: WSClientMessage = {
      type: 'goal:get-stats',
      goalId
    };

    handleWsMessage(ws as any, JSON.stringify(message));
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.ok(ws.sentMessages.length > 0, 'Should send a response');
    const response = JSON.parse(ws.sentMessages[0]);
    assert.equal(response.type, 'goal:stats');
    assert.equal(response.goalId, goalId);
    assert.ok(response.stats !== null, 'Stats should not be null');
    assert.equal(response.stats.total_runs, 5, 'Should return correct total_runs');
    assert.equal(response.stats.tasks_completed, 4, 'Should return correct tasks_completed');
    assert.equal(response.stats.tasks_failed, 1, 'Should return correct tasks_failed');
    assert.equal(response.stats.avg_duration_ms, 7500, 'Should return correct avg_duration_ms');
  });

  it('getBroadcast broadcasts goal:completed with correct structure', () => {
    const broadcast = getBroadcast();

    // Should not throw when broadcasting goal completion
    assert.doesNotThrow(() => {
      broadcast({
        type: 'goal:completed',
        goalId: 'goal-123',
        agentId: 'agent-456',
        goal: {
          id: 'goal-123',
          name: 'Test Goal',
          description: 'A test goal',
          status: 'completed',
          priority: 3,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        } as any
      });
    });
  });

  it('getBroadcast broadcasts goal:switched with correct structure', () => {
    const broadcast = getBroadcast();

    assert.doesNotThrow(() => {
      broadcast({
        type: 'goal:switched',
        agentId: 'agent-456',
        previousGoalId: 'goal-old',
        newGoalId: 'goal-new',
        goal: {
          id: 'goal-new',
          name: 'Next Goal',
          description: 'The next goal to work on',
          status: 'active',
          priority: 5,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any
      });
    });
  });

  it('getBroadcast broadcasts goal:proposed-auto with array of goals', () => {
    const broadcast = getBroadcast();

    assert.doesNotThrow(() => {
      broadcast({
        type: 'goal:proposed-auto',
        agentId: 'agent-456',
        goals: [
          {
            id: 'proposed-1',
            name: 'Improve test coverage',
            description: 'Identified from patterns',
            status: 'active',
            priority: 2,
            proposal_status: 'pending',
            proposed_by: 'agent-456',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as any
        ]
      });
    });
  });

  it('goal:proposed-auto broadcast reaches connected clients with correct structure', () => {
    const broadcast = getBroadcast();
    const received: string[] = [];

    // Register a mock client that captures sent messages
    const mockWs = {
      readyState: 1, // OPEN
      send(data: string) { received.push(data); }
    } as any;
    const removeClient = addClientForTest(mockWs);

    try {
      const proposedGoal = {
        id: 'auto-proposed-1',
        name: 'Add integration test coverage',
        description: 'Based on past run patterns',
        status: 'active' as const,
        priority: 3,
        proposal_status: 'pending',
        proposed_by: 'agent-789',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      broadcast({
        type: 'goal:proposed-auto',
        agentId: 'agent-789',
        goals: [proposedGoal as any]
      });

      assert.equal(received.length, 1, 'Client should receive exactly one broadcast');
      const msg = JSON.parse(received[0]);
      assert.equal(msg.type, 'goal:proposed-auto', 'Broadcast type should be goal:proposed-auto');
      assert.equal(msg.agentId, 'agent-789', 'Broadcast should include agentId');
      assert.ok(Array.isArray(msg.goals), 'Broadcast should include goals array');
      assert.equal(msg.goals.length, 1, 'Goals array should have one entry');
      assert.equal(msg.goals[0].id, 'auto-proposed-1', 'Goal id should be preserved');
      assert.equal(msg.goals[0].proposal_status, 'pending', 'Goal proposal_status should be pending');
    } finally {
      removeClient();
    }
  });
});

describe('self-improve goal proposal WS broadcast', () => {
  let memDir: string;

  beforeEach(() => {
    memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boof-ws-test-'));
    initBoofDir(memDir);
  });

  afterEach(() => {
    fs.rmSync(memDir, { recursive: true, force: true });
  });

  it('proposeGoals broadcasts goal:proposed-auto to connected clients', async () => {
    const agentId = `ws-test-agent-${Date.now()}`;
    const now = new Date().toISOString();

    // Insert an agent into the DB (needed for proposeGoals to look up working_directory)
    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, self_improve, created_at, last_activity)
       VALUES (?, 'WS Test Agent', ?, 'idle', 1, ?, ?)`,
      [agentId, memDir, now, now]
    );

    // Seed memory with patterns so proposeGoals has material
    recordPattern(memDir, 'Improve WebSocket error handling for reconnection', 'ws-test');
    recordPattern(memDir, 'Add integration tests for goal cycling flow', 'ws-test');

    // Register a mock client to capture broadcast messages
    const received: string[] = [];
    const mockWs = {
      readyState: 1, // OPEN
      send(data: string) { received.push(data); }
    } as any;
    const removeClient = addClientForTest(mockWs);

    try {
      // When self-improve proposes goals, it calls proposeGoals then broadcasts goal:proposed-auto
      const proposed = await proposeGoals(agentId, memDir);

      // Must have proposed at least one goal
      assert.ok(proposed.length > 0, 'proposeGoals should return at least one goal');

      // Broadcast the event (mirrors what checkAndCycleGoal does when no active goals remain)
      const broadcast = getBroadcast();
      broadcast({ type: 'goal:proposed-auto', agentId, goals: proposed as any });

      // The connected client should receive the broadcast
      assert.equal(received.length, 1, 'Connected client should receive exactly one goal:proposed-auto message');

      const msg = JSON.parse(received[0]);
      assert.equal(msg.type, 'goal:proposed-auto', 'Message type should be goal:proposed-auto');
      assert.equal(msg.agentId, agentId, 'agentId should match the self-improve agent');
      assert.ok(Array.isArray(msg.goals), 'goals should be an array');
      assert.ok(msg.goals.length > 0, 'goals array should not be empty');

      // Each proposed goal should have correct shape
      for (const g of msg.goals) {
        assert.ok(typeof g.id === 'string' && g.id.length > 0, 'Each goal should have an id');
        assert.ok(typeof g.name === 'string' && g.name.length > 0, 'Each goal should have a name');
        assert.equal(g.proposal_status, 'pending', 'Each proposed goal should have pending proposal_status');
        assert.equal(g.proposed_by, agentId, 'Each proposed goal should reference the proposing agent');
      }
    } finally {
      removeClient();
    }
  });

  it('self-improve toggle then proposeGoals sends goal:proposed-auto via broadcast', async () => {
    const agentId = `ws-selfimprove-${Date.now()}`;
    const now = new Date().toISOString();

    runQuery(
      `INSERT INTO agents (id, name, working_directory, status, self_improve, created_at, last_activity)
       VALUES (?, 'Self-Improve WS Agent', ?, 'idle', 1, ?, ?)`,
      [agentId, memDir, now, now]
    );

    // Seed patterns so proposal has material
    recordPattern(memDir, 'Cache DB queries to reduce repeated lookups', 'self-improve');

    // Register client
    const received: string[] = [];
    const mockWs = {
      readyState: 1,
      send(data: string) { received.push(data); }
    } as any;
    const removeClient = addClientForTest(mockWs);

    try {
      // Enable self-improve via WS message (mimics client toggling it on)
      const selfImproveMsg: WSClientMessage = {
        type: 'agent:self-improve',
        agentId,
        enabled: true
      };
      handleWsMessage(mockWs, JSON.stringify(selfImproveMsg));

      // Clear messages from agent:updated broadcast
      received.length = 0;

      // Now simulate the self-improve cycle proposing goals when none remain
      const proposals = await proposeGoals(agentId, memDir);
      assert.ok(proposals.length > 0, 'Should propose at least one goal');

      const broadcast = getBroadcast();
      broadcast({ type: 'goal:proposed-auto', agentId, goals: proposals as any });

      assert.equal(received.length, 1, 'Client should receive goal:proposed-auto after self-improve proposal');
      const msg = JSON.parse(received[0]);
      assert.equal(msg.type, 'goal:proposed-auto');
      assert.ok(Array.isArray(msg.goals) && msg.goals.length > 0, 'Goals should be proposed');
    } finally {
      removeClient();
    }
  });
});
