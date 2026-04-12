import { create } from 'zustand';
import type { Folder, Task, Agent, Command, AgentStatus, RepoInfo, Goal, GoalLogEntry, GoalStats, Workflow, Assessment, Improvement, XpEvent, DashboardData, Skill, Experiment, TimelineRun, Project, AggregatedSkill, GlobalStats, RecentLearning, MergeGate, ReviewFinding, AuditRecord, TaskResearch, AgentPattern, AgentFix, ExperimentRecord, ExperimentRun, ReviewGuideline } from '../lib/types';

interface ContextPanelState {
  open: boolean;
  content: { type: string; id: string } | null;
}

export interface UIState {
  activeScreen: 'home' | 'tasks' | 'agents' | 'history' | 'agent' | 'goals' | 'projects' | 'dashboard'
    | 'pipeline' | 'reviews' | 'audit' | 'research' | 'memory' | 'analytics';
  selectedAgentId: string | null;
  selectedFolderId: string | null;
  selectedProjectId: string | null;
  contextPanel: ContextPanelState;
}

interface StoreState {
  folders: Folder[];
  tasks: Task[];
  agents: Agent[];
  commands: Command[];
  repos: RepoInfo[];
  goals: Goal[];
  goalLogs: Record<string, GoalLogEntry[]>;
  goalStats: Record<string, GoalStats | null>;
  agentActivity: Record<string, GoalLogEntry[]>;
  agentImprovements: Record<string, Improvement[]>;
  agentAssessments: Record<string, Assessment[]>;
  agentBranches: Record<string, string[]>;
  agentXpEvents: Record<string, XpEvent[]>;
  agentDashboard: Record<string, DashboardData>;
  agentSkillsList: Record<string, Skill[]>;
  agentExperiments: Record<string, Experiment[]>;
  agentTimeline: Record<string, TimelineRun[]>;
  projects: Project[];
  projectRepos: Record<string, string[]>;
  projectSkills: Record<string, AggregatedSkill[]>;
  globalSkills: AggregatedSkill[];
  globalStats: GlobalStats | null;
  recentLearnings: RecentLearning[];
  workflows: Workflow[];
  activeOutputs: Record<string, string[]>;
  // New Phase 1 slices
  mergeGates: MergeGate[];
  reviewFindings: Record<string, ReviewFinding[]>;
  auditRecords: Record<string, AuditRecord[]>;
  taskResearch: Record<string, TaskResearch>;
  agentPatterns: Record<string, AgentPattern[]>;
  agentFixes: Record<string, AgentFix[]>;
  experimentRecords: ExperimentRecord[];
  experimentRuns: Record<string, ExperimentRun[]>;
  guidelines: Record<string, ReviewGuideline[]>;
  ui: UIState;

  // New setters
  setMergeGates: (gates: MergeGate[]) => void;
  updateMergeGate: (gate: MergeGate) => void;
  setReviewFindings: (mergeGateId: string, findings: ReviewFinding[]) => void;
  setAuditRecords: (key: string, records: AuditRecord[]) => void;
  setTaskResearch: (taskId: string, research: TaskResearch) => void;
  setAgentPatterns: (agentId: string, patterns: AgentPattern[]) => void;
  setAgentFixes: (agentId: string, fixes: AgentFix[]) => void;
  setExperimentRecords: (records: ExperimentRecord[]) => void;
  updateExperimentRecord: (record: ExperimentRecord) => void;
  setExperimentRuns: (experimentId: string, runs: ExperimentRun[]) => void;
  setGuidelines: (repoPath: string, guidelines: ReviewGuideline[]) => void;
  updateGuideline: (guideline: ReviewGuideline) => void;
  removeGuideline: (guidelineId: string) => void;
  setContextPanel: (content: ContextPanelState['content']) => void;
  closeContextPanel: () => void;

  setProjects: (projects: Project[]) => void;
  updateProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  setProjectRepos: (projectId: string, repos: string[]) => void;
  setProjectSkills: (projectId: string, skills: AggregatedSkill[]) => void;
  setGlobalSkills: (skills: AggregatedSkill[]) => void;
  setGlobalStats: (stats: GlobalStats) => void;
  setRecentLearnings: (learnings: RecentLearning[]) => void;
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
  setGoalStats: (goalId: string, stats: GoalStats | null) => void;
  setAgentActivity: (agentId: string, entries: GoalLogEntry[]) => void;
  setAgentImprovements: (agentId: string, improvements: Improvement[]) => void;
  updateImprovement: (improvement: Improvement) => void;
  setAgentAssessments: (agentId: string, assessments: Assessment[]) => void;
  setAgentBranches: (agentId: string, branches: string[]) => void;
  setAgentXpEvents: (agentId: string, events: XpEvent[]) => void;
  addXpEvent: (agentId: string, event: XpEvent) => void;
  setAgentDashboard: (agentId: string, data: DashboardData) => void;
  setAgentSkillsList: (agentId: string, skills: Skill[]) => void;
  setAgentExperiments: (agentId: string, experiments: Experiment[]) => void;
  setAgentTimeline: (agentId: string, runs: TimelineRun[]) => void;
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
  setSelectedProjectId: (id: string | null) => void;
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
  goalStats: {},
  agentActivity: {},
  agentImprovements: {},
  agentAssessments: {},
  agentBranches: {},
  agentXpEvents: {},
  agentDashboard: {},
  agentSkillsList: {},
  agentExperiments: {},
  agentTimeline: {},
  projects: [],
  projectRepos: {},
  projectSkills: {},
  globalSkills: [],
  globalStats: null,
  recentLearnings: [],
  workflows: [],
  activeOutputs: {},
  mergeGates: [],
  reviewFindings: {},
  auditRecords: {},
  taskResearch: {},
  agentPatterns: {},
  agentFixes: {},
  experimentRecords: [],
  experimentRuns: {},
  guidelines: {},
  ui: {
    activeScreen: 'home',
    selectedAgentId: null,
    selectedFolderId: null,
    selectedProjectId: null,
    contextPanel: { open: false, content: null },
  },

  setMergeGates: (gates) => set({ mergeGates: gates }),

  updateMergeGate: (gate) =>
    set((state) => {
      const index = state.mergeGates.findIndex((g) => g.id === gate.id);
      if (index >= 0) {
        const updated = [...state.mergeGates];
        updated[index] = gate;
        return { mergeGates: updated };
      }
      return { mergeGates: [...state.mergeGates, gate] };
    }),

  setReviewFindings: (mergeGateId, findings) =>
    set((state) => ({
      reviewFindings: { ...state.reviewFindings, [mergeGateId]: findings },
    })),

  setAuditRecords: (key, records) =>
    set((state) => ({
      auditRecords: { ...state.auditRecords, [key]: records },
    })),

  setTaskResearch: (taskId, research) =>
    set((state) => ({
      taskResearch: { ...state.taskResearch, [taskId]: research },
    })),

  setAgentPatterns: (agentId, patterns) =>
    set((state) => ({
      agentPatterns: { ...state.agentPatterns, [agentId]: patterns },
    })),

  setAgentFixes: (agentId, fixes) =>
    set((state) => ({
      agentFixes: { ...state.agentFixes, [agentId]: fixes },
    })),

  setExperimentRecords: (records) => set({ experimentRecords: records }),

  updateExperimentRecord: (record) =>
    set((state) => {
      const index = state.experimentRecords.findIndex((r) => r.id === record.id);
      if (index >= 0) {
        const updated = [...state.experimentRecords];
        updated[index] = record;
        return { experimentRecords: updated };
      }
      return { experimentRecords: [...state.experimentRecords, record] };
    }),

  setExperimentRuns: (experimentId, runs) =>
    set((state) => ({
      experimentRuns: { ...state.experimentRuns, [experimentId]: runs },
    })),

  setGuidelines: (repoPath, guidelines) =>
    set((state) => ({
      guidelines: { ...state.guidelines, [repoPath]: guidelines },
    })),

  updateGuideline: (guideline) =>
    set((state) => {
      const repoGuidelines = state.guidelines[guideline.repo_path] || [];
      const index = repoGuidelines.findIndex((g) => g.id === guideline.id);
      if (index >= 0) {
        const updated = [...repoGuidelines];
        updated[index] = guideline;
        return { guidelines: { ...state.guidelines, [guideline.repo_path]: updated } };
      }
      return { guidelines: { ...state.guidelines, [guideline.repo_path]: [...repoGuidelines, guideline] } };
    }),

  removeGuideline: (guidelineId) =>
    set((state) => {
      const newGuidelines = { ...state.guidelines };
      for (const repoPath of Object.keys(newGuidelines)) {
        newGuidelines[repoPath] = newGuidelines[repoPath].filter((g) => g.id !== guidelineId);
      }
      return { guidelines: newGuidelines };
    }),

  setContextPanel: (content) =>
    set((state) => ({
      ui: { ...state.ui, contextPanel: { open: content !== null, content } },
    })),

  closeContextPanel: () =>
    set((state) => ({
      ui: { ...state.ui, contextPanel: { open: false, content: null } },
    })),

  setProjects: (projects) => set({ projects }),

  updateProject: (project) =>
    set((state) => {
      const index = state.projects.findIndex((p) => p.id === project.id);
      if (index >= 0) {
        const updated = [...state.projects];
        updated[index] = project;
        return { projects: updated };
      }
      return { projects: [...state.projects, project] };
    }),

  removeProject: (projectId) =>
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== projectId),
    })),

  setProjectRepos: (projectId, repos) =>
    set((state) => ({
      projectRepos: { ...state.projectRepos, [projectId]: repos },
    })),

  setProjectSkills: (projectId, skills) =>
    set((state) => ({
      projectSkills: { ...state.projectSkills, [projectId]: skills },
    })),

  setGlobalSkills: (skills) => set({ globalSkills: skills }),

  setGlobalStats: (stats) => set({ globalStats: stats }),

  setRecentLearnings: (learnings) => set({ recentLearnings: learnings }),

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

  setGoalStats: (goalId, stats) =>
    set((state) => ({
      goalStats: { ...state.goalStats, [goalId]: stats },
    })),

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

  setAgentDashboard: (agentId, data) =>
    set((state) => ({
      agentDashboard: { ...state.agentDashboard, [agentId]: data },
    })),

  setAgentSkillsList: (agentId, skills) =>
    set((state) => ({
      agentSkillsList: { ...state.agentSkillsList, [agentId]: skills },
    })),

  setAgentExperiments: (agentId, experiments) =>
    set((state) => ({
      agentExperiments: { ...state.agentExperiments, [agentId]: experiments },
    })),

  setAgentTimeline: (agentId, runs) =>
    set((state) => ({
      agentTimeline: { ...state.agentTimeline, [agentId]: runs },
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

  setSelectedProjectId: (id) =>
    set((state) => ({
      ui: { ...state.ui, selectedProjectId: id },
    })),
}));
