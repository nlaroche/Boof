import { useStore } from '../stores/store';
import { AgentCard } from '../components/AgentCard';
import { SummaryCard } from '../components/SummaryCard';

interface Props {
  onSendToAgent: (agentId: string, prompt: string) => void;
}

export function HomeScreen({ onSendToAgent }: Props) {
  const agents = useStore((s) => s.agents);
  const commands = useStore((s) => s.commands);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  const recentCommands = commands
    .filter((c) => c.status === 'done' && c.summary)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
    .slice(0, 5);

  return (
    <div className="pb-20">
      <div className="p-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#e2e2ef]">Boof</h1>
        <button
          onClick={() => setActiveScreen('agents')}
          className="bg-[#7c5bf5] text-white text-sm px-4 py-2 rounded-lg active:bg-[#6b4ae4] transition-colors"
        >
          + Agent
        </button>
      </div>

      {agents.length > 0 ? (
        <div className="px-3 mb-4">
          <h3 className="text-sm font-medium text-[#6b6b80] mb-2 px-1">Active Agents</h3>
          <div className="grid grid-cols-2 gap-2">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </div>
      ) : (
        <div className="px-4 py-8 text-center text-[#6b6b80]">
          <div className="text-4xl mb-2">&#128296;</div>
          <p>No agents running</p>
          <p className="text-sm mt-1">Create one from the Agents tab</p>
        </div>
      )}

      {recentCommands.length > 0 && (
        <div className="p-3">
          <h3 className="text-sm font-medium text-[#6b6b80] mb-2">Recent</h3>
          {recentCommands.map((cmd) => (
            <SummaryCard key={cmd.id} command={cmd} />
          ))}
        </div>
      )}
    </div>
  );
}
