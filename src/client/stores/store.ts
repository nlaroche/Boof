import { create } from 'zustand';
import type { Folder, Task, Agent, Command, AgentStatus } from '../lib/types';

interface UIState {
  activeScreen: 'home' | 'tasks' | 'agents' | 'history' | 'agent';
  selectedAgentId: string | null;
  selectedFolderId: string | null;
}

interface StoreState {
  folders: Folder[];
  tasks: Task[];
  agents: Agent[];
  commands: Command[];
  activeOutputs: Record<string, string[]>;
  ui: UIState;

  setFolders: (folders: Folder[]) => void;
  setTasks: (tasks: Task[]) => void;
  setAgents: (agents: Agent[]) => void;
  setCommands: (commands: Command[]) => void;
  appendOutput: (agentId: string, chunk: string) => void;
  clearOutput: (agentId: string) => void;
  setAgentStatus: (agentId: string, status: AgentStatus) => void;
  updateTask: (task: Task) => void;
  updateFolder: (folder: Folder) => void;
  updateAgent: (agent: Agent) => void;
  addCommand: (command: Command) => void;
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

  addCommand: (command) =>
    set((state) => ({
      commands: [...state.commands, command],
    })),

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
