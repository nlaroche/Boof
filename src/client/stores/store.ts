import { create } from 'zustand';
import type { Folder, Task, Agent, Command, AgentStatus, RepoInfo, Goal, GoalLogEntry, Workflow, Assessment, Improvement, XpEvent } from '../lib/types';

interface UIState {
  activeScreen: 'home' | 'tasks' | 'agents' | 'history' | 'agent' | 'goals';
  selectedAgentId: string | null;
  selectedFolderId: string | null;
}

interface StoreState {
  folders: Folder[];
  tasks: Task[];
  agents: Agent[];
  commands: Command[];
  repos: RepoInfo[];
  goals: Goal[];
  goalLogs: Record<string, GoalLogEntry[]>;
  agentActivity: Record<string, GoalLogEntry[]>;
  agentImprovements: Record<string, Improvement[]>;
  agentAssessments: Record<string, Assessment[]>;
  agentBranches: Record<string, string[]>;
  agentXpEvents: Record<string, XpEvent[]>;
  workflows: Workflow[];
  activeOutputs: Record<string, string[]>;
  ui: UIState;

  setFolders: (folders: Folder[]) => void;
  setTasks: (tasks: Task[]) => void;
  setAgents: (agents: Agent[]) => void;
  setCommands: (commands: Command[]) => void;
  mergeCommands: (agentId: string, commands: Command[]) => void;
  setRepos: (repos: RepoInfo[]) => void;
  setGoals: (goals: Goal[]) => void;
  updateGoal: (goal: Goal) => void;
  removeGoal: (goalId: string) => void;
  setGoalLog: (goalId: string, entries: GoalLogEntry[]) => void;
  addGoalLogEntry: (entry: GoalLogEntry) => void;
  setAgentActivity: (agentId: string, entries: GoalLogEntry[]) => void;
  setAgentImprovements: (agentId: string, improvements: Improvement[]) => void;
  updateImprovement: (improvement: Improvement) => void;
  setAgentAssessments: (agentId: string, assessments: Assessment[]) => void;
  setAgentBranches: (agentId: string, branches: string[]) => void;
  setAgentXpEvents: (agentId: string, events: XpEvent[]) => void;
  addXpEvent: (agentId: string, event: XpEvent) => void;
  setWorkflows: (workflows: Workflow[]) => void;
  updateWorkflow: (workflow: Workflow) => void;
  removeWorkflow: (workflowId: string) => void;
  appendOutput: (agentId: string, chunk: string) => void;
  clearOutput: (agentId: string) => void;
  setAgentStatus: (agentId: string, status: AgentStatus) => void;
  updateTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  updateFolder: (folder: Folder) => void;
  removeFolder: (folderId: string) => void;
  updateAgent: (agent: Agent) => void;
  removeAgent: (agentId: string) => void;
  addCommand: (command: Command) => void;
  upsertCommand: (command: Command) => void;
  updateCommand: (commandId: string, fields: Partial<Command>) => void;
  setActiveScreen: (screen: UIState['activeScreen']) => void;
  setSelectedAgentId: (id: string | null) => void;
  setSelectedFolderId: (id: string | null) => void;
}

const MAX_OUTPUT_LINES = 500;

export const useStore = create<StoreState>((set) => ({
  folders: [],
  tasks: [],
  agents: [],
  commands: [],
  repos: [],
  goals: [],
  goalLogs: {},
  agentActivity: {},
  agentImprovements: {},
  agentAssessments: {},
  agentBranches: {},
  agentXpEvents: {},
  workflows: [],
  activeOutputs: {},
  ui: {
    activeScreen: 'home',
    selectedAgentId: null,
    selectedFolderId: null,
  },

  setFolders: (folders) => set({ folders }),

  setTasks: (tasks) => set({ tasks }),

  setAgents: (agents) => set({ agents }),

  setCommands: (commands) => set({ commands }),

  mergeCommands: (agentId, commands) =>
    set((state) => {
      // Replace commands for this agent, keep others
      const others = state.commands.filter((c) => c.agent_id !== agentId);
      return { commands: [...others, ...commands] };
    }),

  setRepos: (repos) => set({ repos }),

  setGoals: (goals) => set({ goals }),

  updateGoal: (goal) =>
    set((state) => {
      const index = state.goals.findIndex((g) => g.id === goal.id);
      if (index >= 0) {
        const updated = [...state.goals];
        updated[index] = goal;
        return { goals: updated };
      }
      return { goals: [...state.goals, goal] };
    }),

  removeGoal: (goalId) =>
    set((state) => ({
      goals: state.goals.filter((g) => g.id !== goalId),
    })),

  setGoalLog: (goalId, entries) =>
    set((state) => ({
      goalLogs: { ...state.goalLogs, [goalId]: entries },
    })),

  addGoalLogEntry: (entry) =>
    set((state) => {
      const existing = state.goalLogs[entry.goal_id] || [];
      return {
        goalLogs: { ...state.goalLogs, [entry.goal_id]: [entry, ...existing] },
      };
    }),

  setAgentActivity: (agentId, entries) =>
    set((state) => ({
      agentActivity: { ...state.agentActivity, [agentId]: entries },
    })),

  setAgentImprovements: (agentId, improvements) =>
    set((state) => ({
      agentImprovements: { ...state.agentImprovements, [agentId]: improvements },
    })),

  updateImprovement: (improvement) =>
    set((state) => {
      const agentImps = state.agentImprovements[improvement.agent_id] || [];
      const index = agentImps.findIndex((i) => i.id === improvement.id);
      if (index >= 0) {
        const updated = [...agentImps];
        updated[index] = improvement;
        return { agentImprovements: { ...state.agentImprovements, [improvement.agent_id]: updated } };
      }
      return { agentImprovements: { ...state.agentImprovements, [improvement.agent_id]: [improvement, ...agentImps] } };
    }),

  setAgentAssessments: (agentId, assessments) =>
    set((state) => ({
      agentAssessments: { ...state.agentAssessments, [agentId]: assessments },
    })),

  setAgentBranches: (agentId, branches) =>
    set((state) => ({
      agentBranches: { ...state.agentBranches, [agentId]: branches },
    })),
  setAgentXpEvents: (agentId, events) =>
    set((state) => ({
      agentXpEvents: { ...state.agentXpEvents, [agentId]: events },
    })),
  addXpEvent: (agentId, event) =>
    set((state) => ({
      agentXpEvents: {
        ...state.agentXpEvents,
        [agentId]: [event, ...(state.agentXpEvents[agentId] || [])],
      },
    })),

  setWorkflows: (workflows) => set({ workflows }),

  updateWorkflow: (workflow) =>
    set((state) => {
      const index = state.workflows.findIndex((w) => w.id === workflow.id);
      if (index >= 0) {
        const updated = [...state.workflows];
        updated[index] = workflow;
        return { workflows: updated };
      }
      return { workflows: [...state.workflows, workflow] };
    }),

  removeWorkflow: (workflowId) =>
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== workflowId),
    })),

  appendOutput: (agentId, chunk) =>
    set((state) => {
      const current = state.activeOutputs[agentId] || [];
      const newLines = chunk.split('\n');
      const updated = [...current, ...newLines];
      if (updated.length > MAX_OUTPUT_LINES) {
        updated.splice(0, updated.length - MAX_OUTPUT_LINES);
      }
      return {
        activeOutputs: {
          ...state.activeOutputs,
          [agentId]: updated,
        },
      };
    }),

  clearOutput: (agentId) =>
    set((state) => ({
      activeOutputs: {
        ...state.activeOutputs,
        [agentId]: [],
      },
    })),

  setAgentStatus: (agentId, status) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === agentId ? { ...a, status } : a
      ),
    })),

  updateTask: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((t) => t.id === task.id);
      if (index >= 0) {
        const updated = [...state.tasks];
        updated[index] = task;
        return { tasks: updated };
      }
      return { tasks: [...state.tasks, task] };
    }),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  updateFolder: (folder) =>
    set((state) => {
      const index = state.folders.findIndex((f) => f.id === folder.id);
      if (index >= 0) {
        const updated = [...state.folders];
        updated[index] = folder;
        return { folders: updated };
      }
      return { folders: [...state.folders, folder] };
    }),

  removeFolder: (folderId) =>
    set((state) => ({
      folders: state.folders.filter((f) => f.id !== folderId),
      ui: {
        ...state.ui,
        selectedFolderId: state.ui.selectedFolderId === folderId ? null : state.ui.selectedFolderId,
      },
    })),

  updateAgent: (agent) =>
    set((state) => {
      const index = state.agents.findIndex((a) => a.id === agent.id);
      if (index >= 0) {
        const updated = [...state.agents];
        updated[index] = agent;
        return { agents: updated };
      }
      return { agents: [...state.agents, agent] };
    }),

  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== agentId),
    })),

  addCommand: (command) =>
    set((state) => ({
      commands: [...state.commands, command],
    })),

  upsertCommand: (command) =>
    set((state) => {
      const index = state.commands.findIndex((c) => c.id === command.id);
      if (index >= 0) {
        const updated = [...state.commands];
        updated[index] = command;
        return { commands: updated };
      }
      return { commands: [...state.commands, command] };
    }),

  updateCommand: (commandId, fields) =>
    set((state) => ({
      commands: state.commands.map((c) =>
        c.id === commandId ? { ...c, ...fields } : c
      ),
    })),

  setActiveScreen: (screen) =>
    set((state) => ({
      ui: { ...state.ui, activeScreen: screen },
    })),

  setSelectedAgentId: (id) =>
    set((state) => ({
      ui: { ...state.ui, selectedAgentId: id },
    })),

  setSelectedFolderId: (id) =>
    set((state) => ({
      ui: { ...state.ui, selectedFolderId: id },
    })),
}));
