import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { initDb } from '../db.js';
import {
  generateId,
  getNow,
  createTask,
  updateTask,
  deleteTask,
  reorderTask,
  createFolder,
  updateFolder,
  deleteFolder,
  createAgent,
  updateAgent,
  updateAgentStatus,
  deleteAgent,
  createGoal,
  updateGoal,
  deleteGoal,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  createCommand,
  updateCommand,
  listTasks,
  listFolders,
  listAgents,
  listGoals,
  listWorkflows,
  listCommands,
  listGoalLog,
  listAgentCommands,
  listAgentActivity,
  runQuery
} from '../db-helpers.js';

const TEST_DB_PATH = './test-db-helpers.db';

describe('db-helpers', () => {
  beforeEach(async () => {
    // Remove test DB if it exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    process.env.DB_PATH = TEST_DB_PATH;
    await initDb();
  });

  afterEach(() => {
    // Clean up test DB
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('ID Generation', () => {
    it('generateId returns 16 character hex string', () => {
      const id = generateId();
      assert.equal(id.length, 16);
      assert.match(id, /^[abcdef0123456789]+$/);
    });

    it('generateId returns unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }
      assert.equal(ids.size, 100);
    });

    it('getNow returns ISO date string', () => {
      const now = getNow();
      assert.ok(now.includes('T'));
      assert.ok(now.includes('Z'));
      const date = new Date(now);
      assert.ok(!isNaN(date.getTime()));
    });
  });

  describe('Folder Helpers', () => {
    it('createFolder creates and returns folder', () => {
      const broadcasts: any[] = [];
      const folder = createFolder(
        { name: 'Test Folder', icon: '📁' },
        (f) => broadcasts.push(f)
      );

      assert.ok(folder);
      assert.equal(folder.name, 'Test Folder');
      assert.equal(folder.icon, '📁');
      assert.ok(folder.id);
      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0].id, folder.id);
    });

    it('createFolder uses default icon if not provided', () => {
      const folder = createFolder({ name: 'Test' }, () => {});
      assert.ok(folder);
      assert.equal(folder.icon, '📁');
    });

    it('updateFolder updates and broadcasts', () => {
      const folder = createFolder({ name: 'Original' }, () => {});
      assert.ok(folder);

      const broadcasts: any[] = [];
      const updated = updateFolder(
        folder.id,
        { name: 'Updated', icon: '🎯', sort_order: 5 },
        (f) => broadcasts.push(f)
      );

      assert.ok(updated);
      assert.equal(updated.name, 'Updated');
      assert.equal(updated.icon, '🎯');
      assert.equal(updated.sort_order, 5);
      assert.equal(broadcasts.length, 1);
    });

    it('updateFolder with no fields returns null', () => {
      const folder = createFolder({ name: 'Test' }, () => {});
      assert.ok(folder);

      const updated = updateFolder(folder.id, {}, () => {});
      assert.equal(updated, null);
    });

    it('deleteFolder deletes folder and tasks', () => {
      const folder = createFolder({ name: 'Test' }, () => {});
      assert.ok(folder);

      const task = createTask({ folderId: folder.id, title: 'Task' }, () => {});
      assert.ok(task);

      const deletedIds: string[] = [];
      deleteFolder(folder.id, (id) => deletedIds.push(id));

      assert.equal(deletedIds.length, 1);
      assert.equal(deletedIds[0], folder.id);

      const folders = listFolders();
      assert.ok(!folders.find(f => f.id === folder.id));

      const tasks = listTasks();
      assert.ok(!tasks.find(t => t.id === task.id));
    });

    it('listFolders returns all folders sorted', () => {
      createFolder({ name: 'B' }, () => {});
      const folderA = createFolder({ name: 'A' }, () => {});
      assert.ok(folderA);
      updateFolder(folderA.id, { sort_order: 1 }, () => {});

      const folders = listFolders();
      assert.ok(folders.length >= 2);
    });
  });

  describe('Task Helpers', () => {
    it('createTask creates and returns task', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);

      const broadcasts: any[] = [];
      const task = createTask(
        {
          folderId: folder.id,
          title: 'Test Task',
          description: 'Description',
        },
        (t) => broadcasts.push(t)
      );

      assert.ok(task);
      assert.equal(task.title, 'Test Task');
      assert.equal(task.description, 'Description');
      assert.equal(task.folder_id, folder.id);
      assert.equal(task.status, 'todo');
      assert.equal(broadcasts.length, 1);
    });

    it('createTask with parent task', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);

      const parent = createTask({ folderId: folder.id, title: 'Parent' }, () => {});
      assert.ok(parent);

      const child = createTask(
        { folderId: folder.id, title: 'Child', parentTaskId: parent.id },
        () => {}
      );

      assert.ok(child);
      assert.equal(child.parent_task_id, parent.id);
    });

    it('createTask with goal', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const goal = createGoal({ name: 'Goal' }, () => {});
      assert.ok(goal);

      const task = createTask(
        { folderId: folder.id, title: 'Task', goalId: goal.id },
        () => {}
      );

      assert.ok(task);
      assert.equal(task.goal_id, goal.id);
    });

    it('updateTask updates fields', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const task = createTask({ folderId: folder.id, title: 'Original' }, () => {});
      assert.ok(task);

      const broadcasts: any[] = [];
      const updated = updateTask(
        task.id,
        {
          title: 'Updated',
          description: 'New desc',
          status: 'done',
          sort_order: 10,
        },
        (t) => broadcasts.push(t)
      );

      assert.ok(updated);
      assert.equal(updated.title, 'Updated');
      assert.equal(updated.description, 'New desc');
      assert.equal(updated.status, 'done');
      assert.equal(updated.sort_order, 10);
      assert.equal(broadcasts.length, 1);
    });

    it('updateTask with no fields returns null', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const task = createTask({ folderId: folder.id, title: 'Task' }, () => {});
      assert.ok(task);

      const updated = updateTask(task.id, {}, () => {});
      assert.equal(updated, null);
    });

    it('deleteTask deletes and broadcasts', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const task = createTask({ folderId: folder.id, title: 'Task' }, () => {});
      assert.ok(task);

      const deletedIds: string[] = [];
      deleteTask(task.id, (id) => deletedIds.push(id));

      assert.equal(deletedIds.length, 1);
      assert.equal(deletedIds[0], task.id);

      const tasks = listTasks();
      assert.ok(!tasks.find(t => t.id === task.id));
    });

    it('reorderTask updates sort order', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const task = createTask({ folderId: folder.id, title: 'Task' }, () => {});
      assert.ok(task);

      const broadcasts: any[] = [];
      reorderTask(task.id, 42, (t) => broadcasts.push(t));

      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0].sort_order, 42);
    });

    it('listTasks returns all tasks', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);

      createTask({ folderId: folder.id, title: 'Task 1' }, () => {});
      createTask({ folderId: folder.id, title: 'Task 2' }, () => {});

      const tasks = listTasks();
      assert.ok(tasks.length >= 2);
    });
  });

  describe('Agent Helpers', () => {
    it('createAgent creates and returns agent', () => {
      const broadcasts: any[] = [];
      const agent = createAgent(
        { workingDirectory: '/test/dir', name: 'Test Agent' },
        (a) => broadcasts.push(a)
      );

      assert.ok(agent);
      assert.equal(agent.name, 'Test Agent');
      assert.equal(agent.working_directory, '/test/dir');
      assert.equal(agent.status, 'idle');
      assert.equal(agent.profile_id, 'robot');
      assert.equal(agent.agent_type, 'minimax');
      assert.equal(broadcasts.length, 1);
    });

    it('createAgent uses default values', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);
      assert.equal(agent.name, 'Agent');
      assert.equal(agent.profile_id, 'robot');
      assert.equal(agent.agent_type, 'minimax');
    });

    it('createAgent with custom profile and type', () => {
      const agent = createAgent(
        {
          workingDirectory: '/test',
          profileId: 'custom',
          agentType: 'claude',
        },
        () => {}
      );

      assert.ok(agent);
      assert.equal(agent.profile_id, 'custom');
      assert.equal(agent.agent_type, 'claude');
    });

    it('updateAgent updates fields', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      const broadcasts: any[] = [];
      const updated = updateAgent(
        agent.id,
        {
          name: 'Updated',
          instructions: 'New instructions',
          skills: 'skill1,skill2',
          profile_id: 'newprofile',
        },
        (a) => broadcasts.push(a)
      );

      assert.ok(updated);
      assert.equal(updated.name, 'Updated');
      assert.equal(updated.instructions, 'New instructions');
      assert.equal(updated.skills, 'skill1,skill2');
      assert.equal(updated.profile_id, 'newprofile');
      assert.equal(broadcasts.length, 1);
    });

    it('updateAgentStatus updates status and last_activity', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      const broadcasts: any[] = [];
      updateAgentStatus(agent.id, 'running', (a) => broadcasts.push(a));

      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0].status, 'running');
      assert.ok(broadcasts[0].last_activity);
    });

    it('deleteAgent deletes agent and commands', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      const cmdId = createCommand({ agentId: agent.id, prompt: 'test' });
      assert.ok(cmdId);

      const deletedIds: string[] = [];
      deleteAgent(agent.id, (id) => deletedIds.push(id));

      assert.equal(deletedIds.length, 1);

      const agents = listAgents();
      assert.ok(!agents.find(a => a.id === agent.id));
    });

    it('listAgents returns all agents', () => {
      createAgent({ workingDirectory: '/test1' }, () => {});
      createAgent({ workingDirectory: '/test2' }, () => {});

      const agents = listAgents();
      assert.ok(agents.length >= 2);
    });
  });

  describe('Goal Helpers', () => {
    it('createGoal creates and returns goal', () => {
      const broadcasts: any[] = [];
      const goal = createGoal(
        { name: 'Test Goal', description: 'Description' },
        (g) => broadcasts.push(g)
      );

      assert.ok(goal);
      assert.equal(goal.name, 'Test Goal');
      assert.equal(goal.description, 'Description');
      assert.equal(goal.status, 'active');
      assert.equal(broadcasts.length, 1);
    });

    it('createGoal with proposal fields', () => {
      const goal = createGoal(
        {
          name: 'Proposed Goal',
          proposedBy: 'agent-123',
          proposalStatus: 'pending',
          repoId: 'repo-1',
        },
        () => {}
      );

      assert.ok(goal);
      assert.equal(goal.proposed_by, 'agent-123');
      assert.equal(goal.proposal_status, 'pending');
      assert.equal(goal.repo_id, 'repo-1');
    });

    it('updateGoal updates fields', () => {
      const goal = createGoal({ name: 'Original' }, () => {});
      assert.ok(goal);

      const broadcasts: any[] = [];
      const updated = updateGoal(
        goal.id,
        {
          name: 'Updated',
          description: 'New desc',
          status: 'completed',
          priority: 10,
        },
        (g) => broadcasts.push(g)
      );

      assert.ok(updated);
      assert.equal(updated.name, 'Updated');
      assert.equal(updated.description, 'New desc');
      assert.equal(updated.status, 'completed');
      assert.equal(updated.priority, 10);
      assert.equal(broadcasts.length, 1);
    });

    it('deleteGoal deletes goal and goal_log entries', () => {
      const goal = createGoal({ name: 'Test' }, () => {});
      assert.ok(goal);

      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      // Create a goal log entry
      runQuery(
        `INSERT INTO goal_log (id, goal_id, agent_id, action, created_at) VALUES (?, ?, ?, ?, ?)`,
        [generateId(), goal.id, agent.id, 'test_action', getNow()]
      );

      const deletedIds: string[] = [];
      deleteGoal(goal.id, (id) => deletedIds.push(id));

      assert.equal(deletedIds.length, 1);

      const goals = listGoals();
      assert.ok(!goals.find(g => g.id === goal.id));

      const logs = listGoalLog(goal.id);
      assert.equal(logs.length, 0);
    });

    it('listGoals returns all goals sorted by priority', () => {
      const goal1 = createGoal({ name: 'Low Priority' }, () => {});
      const goal2 = createGoal({ name: 'High Priority' }, () => {});
      assert.ok(goal1 && goal2);

      updateGoal(goal2.id, { priority: 10 }, () => {});

      const goals = listGoals();
      assert.ok(goals.length >= 2);
    });
  });

  describe('Workflow Helpers', () => {
    it('createWorkflow creates and returns workflow', () => {
      const broadcasts: any[] = [];
      const steps = [{ id: '1', name: 'Step 1' }, { id: '2', name: 'Step 2' }];
      const workflow = createWorkflow(
        { name: 'Test Workflow', description: 'Desc', steps },
        (w) => broadcasts.push(w)
      );

      assert.ok(workflow);
      assert.equal(workflow.name, 'Test Workflow');
      assert.equal(workflow.description, 'Desc');
      assert.deepEqual(workflow.steps, steps);
      assert.equal(broadcasts.length, 1);
    });

    it('createWorkflow uses empty description by default', () => {
      const workflow = createWorkflow({ name: 'Test', steps: [] }, () => {});
      assert.ok(workflow);
      assert.equal(workflow.description, '');
    });

    it('updateWorkflow updates fields', () => {
      const workflow = createWorkflow(
        { name: 'Original', steps: [] },
        () => {}
      );
      assert.ok(workflow);

      const newSteps = [{ id: '1', name: 'Updated Step' }];
      const broadcasts: any[] = [];
      const updated = updateWorkflow(
        workflow.id,
        { name: 'Updated', description: 'New desc', steps: newSteps },
        (w) => broadcasts.push(w)
      );

      assert.ok(updated);
      assert.equal(updated.name, 'Updated');
      assert.equal(updated.description, 'New desc');
      assert.deepEqual(updated.steps, newSteps);
      assert.equal(broadcasts.length, 1);
    });

    it('updateWorkflow with no fields returns null', () => {
      const workflow = createWorkflow({ name: 'Test', steps: [] }, () => {});
      assert.ok(workflow);

      const updated = updateWorkflow(workflow.id, {}, () => {});
      assert.equal(updated, null);
    });

    it('deleteWorkflow deletes and broadcasts', () => {
      const workflow = createWorkflow({ name: 'Test', steps: [] }, () => {});
      assert.ok(workflow);

      const deletedIds: string[] = [];
      deleteWorkflow(workflow.id, (id) => deletedIds.push(id));

      assert.equal(deletedIds.length, 1);

      const workflows = listWorkflows();
      assert.ok(!workflows.find(w => w.id === workflow.id));
    });

    it('listWorkflows returns all workflows with parsed steps', () => {
      const steps1 = [{ id: '1', name: 'Step 1' }];
      const steps2 = [{ id: '2', name: 'Step 2' }];

      createWorkflow({ name: 'W1', steps: steps1 }, () => {});
      createWorkflow({ name: 'W2', steps: steps2 }, () => {});

      const workflows = listWorkflows();
      assert.ok(workflows.length >= 2);

      workflows.forEach(w => {
        assert.ok(Array.isArray(w.steps));
      });
    });
  });

  describe('Command Helpers', () => {
    it('createCommand creates command and returns ID', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      const cmdId = createCommand({
        agentId: agent.id,
        prompt: 'Test prompt',
      });

      assert.ok(cmdId);
      assert.equal(cmdId.length, 16);

      const commands = listCommands();
      const cmd = commands.find(c => c.id === cmdId);
      assert.ok(cmd);
      assert.equal(cmd.prompt, 'Test prompt');
      assert.equal(cmd.status, 'running');
    });

    it('createCommand with task ID', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const task = createTask({ folderId: folder.id, title: 'Task' }, () => {});
      assert.ok(task);

      const cmdId = createCommand({
        agentId: agent.id,
        prompt: 'Test',
        taskId: task.id,
      });

      const commands = listCommands();
      const cmd = commands.find(c => c.id === cmdId);
      assert.ok(cmd);
      assert.equal(cmd.task_id, task.id);
    });

    it('updateCommand updates fields', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);
      const cmdId = createCommand({ agentId: agent.id, prompt: 'Test' });

      const now = getNow();
      const updated = updateCommand(cmdId, {
        status: 'done',
        completed_at: now,
        raw_output: 'output',
        summary: 'summary',
        files_changed: '["file1.ts"]',
      });

      assert.ok(updated);
      assert.equal(updated.status, 'done');
      assert.equal(updated.completed_at, now);
      assert.equal(updated.raw_output, 'output');
      assert.equal(updated.summary, 'summary');
      assert.equal(updated.files_changed, '["file1.ts"]');
    });

    it('updateCommand with no fields returns null', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);
      const cmdId = createCommand({ agentId: agent.id, prompt: 'Test' });

      const updated = updateCommand(cmdId, {});
      assert.equal(updated, null);
    });

    it('listCommands returns commands sorted by started_at', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      createCommand({ agentId: agent.id, prompt: 'Cmd 1' });
      createCommand({ agentId: agent.id, prompt: 'Cmd 2' });

      const commands = listCommands();
      assert.ok(commands.length >= 2);
    });

    it('listCommands respects limit', () => {
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      for (let i = 0; i < 10; i++) {
        createCommand({ agentId: agent.id, prompt: `Cmd ${i}` });
      }

      const commands = listCommands(5);
      assert.ok(commands.length <= 5);
    });

    it('listAgentCommands returns commands for specific agent', () => {
      const agent1 = createAgent({ workingDirectory: '/test1' }, () => {});
      const agent2 = createAgent({ workingDirectory: '/test2' }, () => {});
      assert.ok(agent1 && agent2);

      const cmd1 = createCommand({ agentId: agent1.id, prompt: 'Agent 1' });
      createCommand({ agentId: agent2.id, prompt: 'Agent 2' });

      const commands = listAgentCommands(agent1.id);
      assert.ok(commands.length >= 1);
      assert.ok(commands.find(c => c.id === cmd1));
      assert.ok(!commands.find(c => c.agent_id === agent2.id));
    });
  });

  describe('Goal Log Helpers', () => {
    it('listGoalLog returns logs for specific goal', () => {
      const goal1 = createGoal({ name: 'Goal 1' }, () => {});
      const goal2 = createGoal({ name: 'Goal 2' }, () => {});
      assert.ok(goal1 && goal2);

      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(agent);

      runQuery(
        `INSERT INTO goal_log (id, goal_id, agent_id, action, created_at) VALUES (?, ?, ?, ?, ?)`,
        [generateId(), goal1.id, agent.id, 'action1', getNow()]
      );
      runQuery(
        `INSERT INTO goal_log (id, goal_id, agent_id, action, created_at) VALUES (?, ?, ?, ?, ?)`,
        [generateId(), goal2.id, agent.id, 'action2', getNow()]
      );

      const logs = listGoalLog(goal1.id);
      assert.ok(logs.length >= 1);
      assert.ok(logs.every(log => log.goal_id === goal1.id));
    });

    it('listGoalLog respects limit', () => {
      const goal = createGoal({ name: 'Goal' }, () => {});
      const agent = createAgent({ workingDirectory: '/test' }, () => {});
      assert.ok(goal && agent);

      for (let i = 0; i < 10; i++) {
        runQuery(
          `INSERT INTO goal_log (id, goal_id, agent_id, action, created_at) VALUES (?, ?, ?, ?, ?)`,
          [generateId(), goal.id, agent.id, `action${i}`, getNow()]
        );
      }

      const logs = listGoalLog(goal.id, 5);
      assert.ok(logs.length <= 5);
    });

    it('listAgentActivity returns logs for specific agent', () => {
      const goal = createGoal({ name: 'Goal' }, () => {});
      const agent1 = createAgent({ workingDirectory: '/test1' }, () => {});
      const agent2 = createAgent({ workingDirectory: '/test2' }, () => {});
      assert.ok(goal && agent1 && agent2);

      const log1Id = generateId();
      runQuery(
        `INSERT INTO goal_log (id, goal_id, agent_id, action, created_at) VALUES (?, ?, ?, ?, ?)`,
        [log1Id, goal.id, agent1.id, 'action1', getNow()]
      );
      runQuery(
        `INSERT INTO goal_log (id, goal_id, agent_id, action, created_at) VALUES (?, ?, ?, ?, ?)`,
        [generateId(), goal.id, agent2.id, 'action2', getNow()]
      );

      const logs = listAgentActivity(agent1.id);
      assert.ok(logs.length >= 1);
      assert.ok(logs.every(log => log.agent_id === agent1.id));
    });
  });

  describe('Generic CRUD Helpers (via specific implementations)', () => {
    it('createAndFetch pattern works (via createTask)', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);

      let broadcastReceived = false;
      const task = createTask(
        { folderId: folder.id, title: 'Task' },
        () => { broadcastReceived = true; }
      );

      assert.ok(task);
      assert.ok(broadcastReceived);
      assert.equal(task.title, 'Task');
    });

    it('updateAndFetch pattern works (via updateTask)', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const task = createTask({ folderId: folder.id, title: 'Original' }, () => {});
      assert.ok(task);

      let broadcastReceived = false;
      const updated = updateTask(
        task.id,
        { title: 'Updated' },
        () => { broadcastReceived = true; }
      );

      assert.ok(updated);
      assert.ok(broadcastReceived);
      assert.equal(updated.title, 'Updated');
      assert.ok(updated.updated_at);
    });

    it('deleteAndBroadcast pattern works (via deleteTask)', () => {
      const folder = createFolder({ name: 'Folder' }, () => {});
      assert.ok(folder);
      const task = createTask({ folderId: folder.id, title: 'Task' }, () => {});
      assert.ok(task);

      let deletedId: string | null = null;
      deleteTask(task.id, (id) => { deletedId = id; });

      assert.equal(deletedId, task.id);

      const tasks = listTasks();
      assert.ok(!tasks.find(t => t.id === task.id));
    });
  });
});
