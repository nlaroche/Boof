import { useStore } from '../stores/store';
import { AgentCard } from '../components/AgentCard';
import type { Agent, Command } from '../lib/types';

interface Props {
  onSendToAgent: (agentId: string, prompt: string) => void;
}

function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    // Running agents first
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    // Then by most recent activity
    const aTime = new Date(a.last_activity).getTime();
    const bTime = new Date(b.last_activity).getTime();
    if (aTime !== bTime) return bTime - aTime;
    // Dead/offline agents last
    if (a.status === 'dead' && b.status !== 'dead') return 1;
    if (b.status === 'dead' && a.status !== 'dead') return -1;
    return 0;
  });
}

function getLastCommand(agentId: string, commands: Command[]): Command | undefined {
  return commands
    .filter((c) => c.agent_id === agentId)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];
}

export function HomeScreen({ onSendToAgent }: Props) {
  const agents = useStore((s) => s.agents);
  const commands = useStore((s) => s.commands);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  const sorted = sortAgents(agents);

  return (
    <div className="min-h-full pb-20">
      <div className="p-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#e2e2ef]">Boof</h1>
        <button
          onClick={() => setActiveScreen('agents')}
          className="bg-[#7c5bf5] text-white text-sm px-4 py-2 rounded-lg active:bg-[#6b4ae4] transition-colors"
        >
          + Agent
        </button>
      </div>

      {sorted.length > 0 ? (
        <div className="px-3 space-y-2">
          {sorted.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              lastCommand={getLastCommand(agent.id, commands)}
            />
          ))}
        </div>
      ) : (
        <div className="px-4 py-12 text-center text-[#6b6b80]">
          <div className="text-lg font-mono mb-2">(._. )</div>
          <p>No agents yet</p>
          <p className="text-sm mt-1">Create one to get started</p>
        </div>
      )}
    </div>
  );
}
