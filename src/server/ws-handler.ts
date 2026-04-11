/**
 * WebSocket message router — thin handler that delegates to systems.
 *
 * Each case is 1-5 lines: parse message → call system function → broadcast result.
 * Heavy logic lives in systems/ modules (command-lifecycle, git-ops, etc.).
 */
import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import {
  runQuery, getOne, getAll, generateId, getNow,
  createTask, updateTask, deleteTask, reorderTask,
  createFolder, updateFolder, deleteFolder,
  createAgent as dbCreateAgent, updateAgent,
  createGoal, updateGoal, deleteGoal,
  createWorkflow, updateWorkflow, deleteWorkflow,
  createProject, updateProject, deleteProject,
  addProjectRepo, removeProjectRepo, listProjectRepos, getProjectGoals,
  listTasks, listFolders, listAgents, listGoals, listWorkflows, listCommands, listProjects,
  listGoalLog, listAgentCommands, listAgentActivity,
  listGuidelines as dbListGuidelines, updateGuidelineStatus, updateGuideline,
  createGuideline, deleteGuideline as dbDeleteGuideline, approveAllGuidelines,
} from './db-helpers.js';
import type { Agent, Command, GoalLogEntry, GoalStats, WSClientMessage, WSServerMessage, RepoInfo, TimelineRun, ReviewGuideline } from '../client/lib/types.js';
import {
  getAgentXpEvents,
  skipImprovement, markImprovementRunning,
  getDashboardData, getAgentSkills, getAllExperiments, createExperiment,
  getAgentImprovements, getAgentAssessments,
  getGlobalSkills, getGlobalStats, getProjectSkills, getRecentLearnings,
} from './self-improve.js';
import { createAgent as ptyCreateAgent, sendToAgent, interruptAgent, killAgent, restartAgent, hasAgent } from './pty-manager.js';
import { triggerAutopilotRun, listAgentBranches, mergeAgentBranch, getAgentCwd, resetAgentSessionCounters } from './autopilot.js';
import { createWorktree, removeWorktree } from './systems/git-ops.js';
import { scanRepoForGuidelines, scanFolderForGuidelines, buildDeepScanPrompt, parseDeepScanOutput, storeDeepScanGuidelines } from './systems/review-agent.js';
import {
  parseCommand, parseCommands,
  appendAgentOutput, clearAgentOutput, getAgentOutputBuffer,
  setCurrentCommandId, getCurrentCommandId, clearCurrentCommandId,
  setRunningImprovement, initCommandMachine,
  createOutputHandler, createExitHandler, createSimpleExitHandler,
} from './systems/command-lifecycle.js';
import { Paths, Timeouts, AgentStatus } from './engine/constants.js';
import { bus } from './engine/event-bus.js';

// ── WebSocket Infrastructure ──

interface ConnectedClient { ws: WebSocket }
const clients: ConnectedClient[] = [];

function broadcast(message: WSServerMessage): void {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  });
}

function send(ws: WebSocket, message: WSServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    console.log('Client connected');
    clients.push({ ws });
    ws.on('message', (data) => handleWsMessage(ws, data.toString()));
    ws.on('close', () => {
      console.log('Client disconnected');
      const index = clients.findIndex((c) => c.ws === ws);
      if (index !== -1) clients.splice(index, 1);
    });
  });

  // Wire event bus → WebSocket broadcast (allows systems to broadcast without importing ws-handler)
  bus.on('ws:broadcast', ({ message }) => broadcast(message));
}

export function getBroadcast(): (message: WSServerMessage) => void {
  return broadcast;
}

export function addClientForTest(ws: WebSocket): () => void {
  clients.push({ ws });
  return () => {
    const idx = clients.findIndex((c) => c.ws === ws);
    if (idx !== -1) clients.splice(idx, 1);
  };
}

export function handleWsMessage(ws: WebSocket, data: string): void {
  try {
    const message = JSON.parse(data) as WSClientMessage;
    handleMessage(ws, message);
  } catch (error) {
    console.error('Failed to parse WebSocket message:', error);
  }
}

// ── Message Router ──

function handleMessage(ws: WebSocket, message: WSClientMessage): void {
  switch (message.type) {
    // ── CRUD: Tasks ──
    case 'task:create':
      createTask(
        { folderId: message.folderId, title: message.title, description: message.description, parentTaskId: message.parentTaskId, goalId: message.goalId },
        (task) => broadcast({ type: 'task:updated', task })
      );
      break;

    case 'task:update':
      updateTask(message.taskId, { ...message.fields, goal_id: (message.fields as any).goal_id }, (task) => broadcast({ type: 'task:updated', task }));
      break;

    case 'task:delete':
      deleteTask(message.taskId, () => broadcast({ type: 'task:deleted', taskId: message.taskId }));
      break;

    case 'task:reorder':
      reorderTask(message.taskId, message.sortOrder, (task) => broadcast({ type: 'task:updated', task }));
      break;

    // ── CRUD: Folders ──
    case 'folder:create':
      createFolder({ name: message.name, icon: message.icon }, (folder) => broadcast({ type: 'folder:updated', folder }));
      break;

    case 'folder:update':
      updateFolder(message.folderId, message.fields, (folder) => broadcast({ type: 'folder:updated', folder }));
      break;

    case 'folder:delete':
      deleteFolder(message.folderId, () => broadcast({ type: 'folder:deleted', folderId: message.folderId }));
      break;

    // ── CRUD: Goals ──
    case 'goal:create':
      createGoal({ name: message.name, description: message.description, repoId: message.repoId, projectId: (message as any).projectId }, (goal) => broadcast({ type: 'goal:updated', goal }));
      break;

    case 'goal:propose':
      createGoal(
        { name: message.name, description: message.description, repoId: message.repoId, proposedBy: message.agentId, proposalStatus: 'pending' },
        (g) => { broadcast({ type: 'goal:proposed', goal: g, agentId: message.agentId }); broadcast({ type: 'goal:updated', goal: g }); }
      );
      break;

    case 'goal:update':
      updateGoal(message.goalId, { ...message.fields, proposal_status: (message.fields as any).proposal_status }, (goal) => broadcast({ type: 'goal:updated', goal }));
      break;

    case 'goal:delete':
      deleteGoal(message.goalId, () => broadcast({ type: 'goal:deleted', goalId: message.goalId }));
      break;

    case 'goal:set-priority': {
      const clampedPriority = message.priority === 0 ? 0 : Math.max(1, Math.min(5, message.priority));
      updateGoal(message.goalId, { priority: clampedPriority }, (goal) => broadcast({ type: 'goal:updated', goal }));
      break;
    }

    case 'goal:list':
      send(ws, { type: 'goal:list', goals: listGoals() });
      break;

    case 'goal:log':
      send(ws, { type: 'goal:log', goalId: message.goalId, entries: listGoalLog(message.goalId, message.limit || 50) });
      break;

    case 'goal:get-stats': {
      const stats = getOne<GoalStats>('SELECT * FROM goal_stats WHERE goal_id = ?', [message.goalId]);
      send(ws, { type: 'goal:stats', goalId: message.goalId, stats: stats ?? null });
      break;
    }

    // ── CRUD: Workflows ──
    case 'workflow:create':
      createWorkflow({ name: message.name, description: message.description, steps: message.steps }, (workflow) => broadcast({ type: 'workflow:updated', workflow }));
      break;

    case 'workflow:update':
      updateWorkflow(message.workflowId, message.fields, (workflow) => broadcast({ type: 'workflow:updated', workflow }));
      break;

    case 'workflow:delete':
      deleteWorkflow(message.workflowId, () => broadcast({ type: 'workflow:deleted', workflowId: message.workflowId }));
      break;

    case 'workflow:list':
      send(ws, { type: 'workflow:list', workflows: listWorkflows() });
      break;

    // ── Agent: Lifecycle ──
    case 'agent:create': {
      const workDir = message.workingDirectory;
      const createdAgent = dbCreateAgent(
        { workingDirectory: workDir, name: message.name, profileId: message.profileId },
        (agent) => broadcast({ type: 'agent:updated', agent })
      );
      if (createdAgent) {
        const worktreePath = createWorktree(workDir, createdAgent.name, createdAgent.id);
        if (worktreePath) {
          runQuery('UPDATE agents SET worktree_path = ? WHERE id = ?', [worktreePath, createdAgent.id]);
          const updated = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [createdAgent.id]);
          if (updated) broadcast({ type: 'agent:updated', agent: updated });
        }
      }
      break;
    }

    case 'agent:update':
      updateAgent(message.agentId, message.fields, (agent) => broadcast({ type: 'agent:updated', agent }));
      break;

    case 'agent:delete': {
      const { agentId } = message;
      if (hasAgent(agentId)) killAgent(agentId);
      const delAgent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (delAgent?.worktree_path) {
        removeWorktree(delAgent.working_directory, delAgent.worktree_path);
      }
      clearAgentOutput(agentId);
      clearCurrentCommandId(agentId);
      runQuery('DELETE FROM commands WHERE agent_id = ?', [agentId]);
      runQuery('DELETE FROM agents WHERE id = ?', [agentId]);
      broadcast({ type: 'agent:deleted', agentId });
      break;
    }

    case 'agent:kill': {
      const { agentId } = message;
      killAgent(agentId);
      runQuery(`UPDATE agents SET status = ? WHERE id = ?`, [AgentStatus.DEAD, agentId]);
      broadcast({ type: 'agent:status', agentId, status: AgentStatus.DEAD });
      break;
    }

    case 'agent:restart': {
      const { agentId } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [AgentStatus.RUNNING, getNow(), agentId]);
        clearAgentOutput(agentId);
        restartAgent(agentId, getAgentCwd(agent), agent.name, createOutputHandler(broadcast), createSimpleExitHandler(broadcast), agent.agent_type);
        broadcast({ type: 'agent:status', agentId, status: AgentStatus.RUNNING });
      }
      break;
    }

    case 'agent:interrupt':
      interruptAgent(message.agentId);
      break;

    // ── Agent: Send Command ──
    case 'agent:send': {
      const { agentId, prompt, taskId } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (!agent) break;

      const commandId = generateId();
      const now = getNow();
      runQuery(
        `INSERT INTO commands (id, agent_id, task_id, prompt, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
        [commandId, agentId, taskId || null, prompt, now]
      );
      setCurrentCommandId(agentId, commandId);
      initCommandMachine(agentId, commandId, prompt, taskId || null);

      if (!hasAgent(agentId)) {
        clearAgentOutput(agentId);
        ptyCreateAgent(agentId, getAgentCwd(agent), agent.name,
          createOutputHandler(broadcast),
          createExitHandler(agentId, prompt, taskId || null, agent, broadcast),
          agent.agent_type);
      }

      runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [AgentStatus.RUNNING, now, agentId]);
      sendToAgent(agentId, prompt);
      broadcast({ type: 'agent:status', agentId, status: AgentStatus.RUNNING });

      const newCmd = getOne<Command>('SELECT * FROM commands WHERE id = ?', [commandId]);
      if (newCmd) broadcast({ type: 'command:updated', command: parseCommand(newCmd) });
      break;
    }

    // ── Agent: UI Verification ──
    case 'agent:verify-ui': {
      const { agentId, url, navigate } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        const verifyUrl = url || 'http://localhost:3456';
        const args = ['-ExecutionPolicy', 'Bypass', '-File', 'verify-ui.ps1', '-Url', verifyUrl];
        if (navigate) args.push('-Navigate', navigate);
        try {
          if (process.platform !== 'win32') { broadcast({ type: 'agent:output', agentId, chunk: '\n--- UI Verification skipped (macOS) ---\n' }); break; }
          const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.LOCALAPPDATA + '\\ms-playwright' };
          const output = execSync(`powershell ${args.join(' ')}`, { cwd: getAgentCwd(agent), encoding: 'utf-8', timeout: Timeouts.UI_VERIFY, env });
          appendAgentOutput(agentId, `\n--- UI Verification ---\n${output}\n`);
          broadcast({ type: 'agent:output', agentId, chunk: `\n--- UI Verification ---\n${output}\n` });
        } catch (e: any) {
          const errOutput = e.stdout || e.message || 'Verification failed';
          appendAgentOutput(agentId, `\n--- UI Verification FAILED ---\n${errOutput}\n`);
          broadcast({ type: 'agent:output', agentId, chunk: `\n--- UI Verification FAILED ---\n${errOutput}\n` });
        }
      }
      break;
    }

    // ── Agent: Config ──
    case 'agent:schedule': {
      const { agentId, schedule, enabled, prompt } = message;
      runQuery(
        `UPDATE agents SET schedule = ?, schedule_enabled = ?, schedule_prompt = ?, last_activity = ? WHERE id = ?`,
        [schedule, enabled ? 1 : 0, prompt, getNow(), agentId]
      );
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) broadcast({ type: 'agent:updated', agent });
      break;
    }

    case 'agent:autopilot': {
      const { agentId, autopilot, interval, goalId } = message;
      runQuery(
        'UPDATE agents SET autopilot = ?, autopilot_interval = ?, autopilot_goal_id = ?, last_activity = ? WHERE id = ?',
        [autopilot ? 1 : 0, interval, goalId, getNow(), agentId]
      );
      if (autopilot) resetAgentSessionCounters(agentId);
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) broadcast({ type: 'agent:updated', agent });
      break;
    }

    case 'agent:autopilot:trigger':
      triggerAutopilotRun(message.agentId);
      break;

    case 'agent:self-improve': {
      const { agentId, enabled } = message;
      runQuery('UPDATE agents SET self_improve = ?, last_activity = ? WHERE id = ?', [enabled ? 1 : 0, getNow(), agentId]);
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) broadcast({ type: 'agent:updated', agent });
      break;
    }

    // ── Agent: Queries ──
    case 'agent:history':
      send(ws, { type: 'agent:history', agentId: message.agentId, commands: parseCommands(listAgentCommands(message.agentId, message.limit || 50)) });
      break;

    case 'agent:activity':
      send(ws, { type: 'agent:activity', agentId: message.agentId, entries: listAgentActivity(message.agentId, message.limit || 50) });
      break;

    case 'agent:dashboard':
      send(ws, { type: 'agent:dashboard', agentId: message.agentId, data: getDashboardData(message.agentId) });
      break;

    case 'agent:skills':
      send(ws, { type: 'agent:skills', agentId: message.agentId, skills: getAgentSkills(message.agentId) });
      break;

    case 'agent:improvements':
      send(ws, { type: 'agent:improvements', agentId: message.agentId, improvements: getAgentImprovements(message.agentId) });
      break;

    case 'agent:assessments':
      send(ws, { type: 'agent:assessments', agentId: message.agentId, assessments: getAgentAssessments(message.agentId) });
      break;

    case 'agent:xp-events':
      send(ws, { type: 'agent:xp-events', agentId: message.agentId, events: getAgentXpEvents(message.agentId) });
      break;

    case 'agent:experiments':
      send(ws, { type: 'agent:experiments', agentId: message.agentId, experiments: getAllExperiments(message.agentId) });
      break;

    case 'agent:create-experiment': {
      const { agentId, name, hypothesis, variantA, variantB } = message;
      createExperiment(agentId, name, hypothesis, variantA, variantB);
      broadcast({ type: 'agent:experiments', agentId, experiments: getAllExperiments(agentId) });
      break;
    }

    // ── Agent: Improvements ──
    case 'improvement:skip': {
      const imp = skipImprovement(message.improvementId);
      if (imp) broadcast({ type: 'improvement:updated', improvement: imp });
      break;
    }

    case 'improvement:execute': {
      const { improvementId, agentId } = message;
      const imp = markImprovementRunning(improvementId);
      if (imp) {
        broadcast({ type: 'improvement:updated', improvement: imp });
        setRunningImprovement(agentId, improvementId);
        const agentData = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
        if (agentData && agentData.status === AgentStatus.IDLE) {
          const prompt = `Self-improvement task: ${imp.description}\n\nMake minimal, focused changes. Run the build to verify.`;
          handleMessage(ws, { type: 'agent:send', agentId, prompt });
        }
      }
      break;
    }

    // ── Agent: Git Branches ──
    case 'agent:branches': {
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [message.agentId]);
      if (agent) {
        listAgentBranches(agent.working_directory).then(branches => {
          send(ws, { type: 'agent:branches', agentId: message.agentId, branches });
        });
      }
      break;
    }

    case 'agent:merge-branch': {
      const { agentId, branchName } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        mergeAgentBranch(agent.working_directory, getAgentCwd(agent), branchName).then(result => {
          broadcast({ type: 'agent:branch-merged', agentId, branchName, success: result.success, output: result.output });
        });
      }
      break;
    }

    case 'agent:discard-branch': {
      const { agentId, branchName } = message;
      const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
      if (agent) {
        execAsync(`git branch -D "${branchName}"`, { cwd: getAgentCwd(agent), timeout: Timeouts.GIT_CHECKOUT })
          .then(() => broadcast({ type: 'agent:branch-discarded', agentId, branchName }))
          .catch(() => {});
      }
      break;
    }

    // ── Agent: Timeline ──
    case 'agent:timeline': {
      const { agentId } = message;
      const entries = getAll<GoalLogEntry>(
        'SELECT * FROM goal_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100',
        [agentId]
      );
      send(ws, { type: 'agent:timeline', agentId, runs: buildTimelineRuns(entries) });
      break;
    }

    // ── Repos ──
    case 'repos:list': {
      try {
        const entries = fs.readdirSync(Paths.DEFAULT_REPOS_DIR, { withFileTypes: true });
        const repos: RepoInfo[] = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
          .map((e) => {
            const fullPath = path.join(Paths.DEFAULT_REPOS_DIR, e.name);
            const hasGit = fs.existsSync(path.join(fullPath, '.git'));
            return { name: e.name, path: fullPath, hasGit };
          })
          .sort((a, b) => {
            if (a.hasGit !== b.hasGit) return a.hasGit ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        send(ws, { type: 'repos:list', repos });
      } catch {
        send(ws, { type: 'repos:list', repos: [] });
      }
      break;
    }

    // ── CRUD: Projects ──
    case 'project:create': {
      const { name, description, architecturePlan } = message as any;
      createProject({ name, description, architecturePlan }, (p) => broadcast({ type: 'project:updated', project: p }));
      break;
    }
    case 'project:update': {
      const { projectId, fields } = message as any;
      updateProject(projectId, fields, (p) => broadcast({ type: 'project:updated', project: p }));
      break;
    }
    case 'project:delete': {
      const { projectId } = message as any;
      deleteProject(projectId, (id) => broadcast({ type: 'project:deleted', projectId: id }));
      break;
    }
    case 'project:list': {
      send(ws, { type: 'project:list', projects: listProjects() });
      break;
    }
    case 'project:add-repo': {
      const { projectId, repoPath } = message as any;
      addProjectRepo(projectId, repoPath);
      send(ws, { type: 'project:repos', projectId, repos: listProjectRepos(projectId) });
      break;
    }
    case 'project:remove-repo': {
      const { projectId, repoPath } = message as any;
      removeProjectRepo(projectId, repoPath);
      send(ws, { type: 'project:repos', projectId, repos: listProjectRepos(projectId) });
      break;
    }
    case 'project:get-repos': {
      const { projectId } = message as any;
      send(ws, { type: 'project:repos', projectId, repos: listProjectRepos(projectId) });
      break;
    }
    case 'project:get-goals': {
      const { projectId } = message as any;
      send(ws, { type: 'project:goals', projectId, goals: getProjectGoals(projectId) });
      break;
    }

    // ── Global Aggregations ──
    case 'global:skills':
      send(ws, { type: 'global:skills:result', skills: getGlobalSkills() });
      break;

    case 'global:stats':
      send(ws, { type: 'global:stats:result', stats: getGlobalStats() });
      break;

    case 'global:learnings':
      send(ws, { type: 'global:learnings:result', learnings: getRecentLearnings((message as any).limit || 5) });
      break;

    case 'project:skills': {
      const { projectId } = message as any;
      send(ws, { type: 'project:skills:result', projectId, skills: getProjectSkills(projectId) });
      break;
    }

    // ── Guidelines ──

    case 'guidelines:scan': {
      const { repoPath } = message as any;
      const broadcastGuideline = (g: ReviewGuideline) => broadcast({ type: 'guidelines:updated', guideline: g } as any);
      const result = scanRepoForGuidelines(repoPath, broadcastGuideline);
      send(ws, { type: 'guidelines:scanned', repoPath, proposed: result.proposed, existingCount: result.existingCount } as any);
      break;
    }

    case 'guidelines:list': {
      const { repoPath } = message as any;
      const guidelines = dbListGuidelines(repoPath);
      send(ws, { type: 'guidelines:list', repoPath, guidelines } as any);
      break;
    }

    case 'guidelines:approve': {
      const { guidelineId } = message as any;
      const updated = updateGuidelineStatus(guidelineId, 'approved', (g) => broadcast({ type: 'guidelines:updated', guideline: g } as any));
      break;
    }

    case 'guidelines:reject': {
      const { guidelineId } = message as any;
      const updated = updateGuidelineStatus(guidelineId, 'rejected', (g) => broadcast({ type: 'guidelines:updated', guideline: g } as any));
      break;
    }

    case 'guidelines:approve-all': {
      const { repoPath } = message as any;
      const approved = approveAllGuidelines(repoPath);
      for (const g of approved) {
        broadcast({ type: 'guidelines:updated', guideline: g } as any);
      }
      break;
    }

    case 'guidelines:update': {
      const { guidelineId, fields } = message as any;
      updateGuideline(guidelineId, fields, (g) => broadcast({ type: 'guidelines:updated', guideline: g } as any));
      break;
    }

    case 'guidelines:add': {
      const { repoPath, name, content, type: gType, scope } = message as any;
      createGuideline({
        repoPath,
        name,
        content,
        type: gType || 'custom',
        source: 'manual',
        scope: scope || '*',
        status: 'approved', // user-added guidelines are approved by default
      }, (g) => broadcast({ type: 'guidelines:updated', guideline: g } as any));
      break;
    }

    case 'guidelines:add-folder': {
      const { repoPath, folderPath, type: fType } = message as any;
      const created = scanFolderForGuidelines(
        repoPath, folderPath, fType || 'custom',
        (g) => broadcast({ type: 'guidelines:updated', guideline: g } as any)
      );
      // Send back the full list so the UI can update
      const allGuidelines = dbListGuidelines(repoPath);
      send(ws, { type: 'guidelines:list', repoPath, guidelines: allGuidelines } as any);
      break;
    }

    case 'guidelines:delete': {
      const { guidelineId } = message as any;
      dbDeleteGuideline(guidelineId, (id) => broadcast({ type: 'guidelines:deleted', guidelineId: id } as any));
      break;
    }

    case 'guidelines:deep-scan': {
      const { repoPath } = message as any;
      const broadcastGuideline = (g: ReviewGuideline) => broadcast({ type: 'guidelines:updated', guideline: g } as any);

      // Build the source map and prompt
      const { prompt, sourceMap } = buildDeepScanPrompt(repoPath);

      if (!prompt) {
        send(ws, { type: 'guidelines:deep-scan:result', repoPath, sourceMapSize: 0, prompt: '', guidelines: [] } as any);
        break;
      }

      // The deep-scan prompt is returned to the client so it can be sent to an agent.
      // The client (or autopilot) sends the prompt to an LLM, gets the response,
      // then the response can be parsed and stored as guidelines.
      // For now, we return the prompt and source map size so the UI can orchestrate this.
      send(ws, {
        type: 'guidelines:deep-scan:result',
        repoPath,
        sourceMapSize: sourceMap.length,
        prompt,
        guidelines: [],
      } as any);
      break;
    }

    // ── Sync ──
    case 'sync:request': {
      const folders = listFolders();
      const tasks = listTasks();
      const agents = listAgents();
      const goals = listGoals();
      const workflows = listWorkflows();
      const projects = listProjects();
      const recentCommands = listCommands(100);
      send(ws, { type: 'sync:state', folders, tasks, agents, goals, workflows, projects, commands: parseCommands(recentCommands) });

      // Replay buffered output for all agents
      for (const agent of agents) {
        const buf = getAgentOutputBuffer(agent.id);
        if (buf && buf.length > 0) {
          send(ws, { type: 'agent:output', agentId: agent.id, chunk: buf.slice(-100).join('\n') });
        }
      }
      break;
    }
  }
}

// ── Helpers ──

/** Group goal log entries into timeline runs by branch/time. */
function buildTimelineRuns(entries: GoalLogEntry[]): TimelineRun[] {
  const runs: TimelineRun[] = [];
  let currentRun: TimelineRun | null = null;
  const sorted = [...entries].reverse();

  for (const entry of sorted) {
    const branchMatch = entry.summary.match(/\[branch: ([^\]]+)\]/);
    const branch = branchMatch ? branchMatch[1] : '';
    const entryTime = new Date(entry.created_at).getTime();

    const shouldStartNew = !currentRun
      || (branch && currentRun.branch && branch !== currentRun.branch)
      || (entryTime - new Date(currentRun.endedAt).getTime() > 15 * 60 * 1000)
      || entry.action === 'planning';

    if (shouldStartNew) {
      currentRun = {
        id: entry.id,
        branch: branch || 'unknown',
        startedAt: entry.created_at,
        endedAt: entry.created_at,
        stages: [entry],
        success: entry.success === 1,
        totalDurationMs: entry.duration_ms,
        totalTokens: entry.total_tokens || 0,
      };
      runs.push(currentRun);
    } else {
      currentRun!.stages.push(entry);
      currentRun!.endedAt = entry.created_at;
      currentRun!.totalDurationMs += entry.duration_ms;
      currentRun!.totalTokens += entry.total_tokens || 0;
      if (entry.success !== 1) currentRun!.success = false;
    }
  }

  return runs.reverse().slice(0, 20);
}
