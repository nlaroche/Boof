Create the Zustand store at src/client/stores/store.ts.

The store has these sections:
- folders: Folder[] (from types.ts)
- tasks: Task[] (from types.ts)
- agents: Agent[] (from types.ts)
- commands: Command[] (from types.ts)
- activeOutputs: Record<string, string[]> - maps agentId to array of output lines
- ui: { activeScreen: 'home' | 'tasks' | 'agents' | 'history' | 'agent', selectedAgentId: string | null, selectedFolderId: string | null }

Actions:
- setFolders(folders: Folder[])
- setTasks(tasks: Task[])
- setAgents(agents: Agent[])
- setCommands(commands: Command[])
- appendOutput(agentId: string, chunk: string) - appends to activeOutputs[agentId], keep max 500 lines
- clearOutput(agentId: string)
- setAgentStatus(agentId: string, status: AgentStatus)
- updateTask(task: Task) - upsert into tasks array
- updateFolder(folder: Folder) - upsert into folders array
- updateAgent(agent: Agent) - upsert into agents array
- addCommand(command: Command)
- updateCommand(commandId: string, fields: Partial<Command>)
- setActiveScreen(screen: string)
- setSelectedAgentId(id: string | null)
- setSelectedFolderId(id: string | null)

Import types from '../lib/types'. Use zustand create().
