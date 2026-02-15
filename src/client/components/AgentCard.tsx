import type { Agent } from '../lib/types';
import { timeAgo } from '../lib/format';
import { useStore } from '../stores/store';

const statusColors: Record<string, string> = {
  idle: 'bg-[#22c55e]',
  running: 'bg-[#f59e0b] animate-pulse',
  error: 'bg-[#ef4444]',
  dead: 'bg-[#6b6b80]',
};

export function AgentCard({ agent }: { agent: Agent }) {
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);

  const handleClick = () => {
    setSelectedAgentId(agent.id);
    setActiveScreen('agent');
  };

  return (
    <button
      onClick={handleClick}
      className="bg-[#14141f] border border-[#1e1e2e] rounded-xl p-4 text-left w-full active:bg-[#1e1e2e] transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2.5 h-2.5 rounded-full ${statusColors[agent.status]}`} />
        <span className="font-medium text-[#e2e2ef] truncate">{agent.name}</span>
      </div>
      <div className="text-xs text-[#6b6b80] truncate">{agent.working_directory}</div>
      <div className="text-xs text-[#6b6b80] mt-1">
        {agent.status === 'running' ? 'Running...' : timeAgo(agent.last_activity)}
      </div>
    </button>
  );
}
