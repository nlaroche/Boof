import type { Agent, Command } from '../lib/types';
import { timeAgo } from '../lib/format';
import { useStore } from '../stores/store';

const statusColors: Record<string, string> = {
  idle: 'bg-[#22c55e]',
  running: 'bg-[#f59e0b] animate-pulse',
  error: 'bg-[#ef4444]',
  dead: 'bg-[#6b6b80]',
};

const statusLabels: Record<string, string> = {
  idle: 'Idle',
  running: 'Working...',
  error: 'Error',
  dead: 'Offline',
};

// Deterministic portrait based on agent name
function getPortrait(name: string): string {
  const portraits = ['(^_^)', '(o_o)', '(>_<)', '(-_-)', '(~_~)', '(*_*)', '(._.)' , '(T_T)', '(u_u)', '(n_n)'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return portraits[Math.abs(hash) % portraits.length];
}

export function AgentCard({ agent, lastCommand }: { agent: Agent; lastCommand?: Command }) {
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);

  const handleClick = () => {
    setSelectedAgentId(agent.id);
    setActiveScreen('agent');
  };

  const summaryLine = lastCommand?.summary?.split('\n')[0] || '';

  return (
    <button
      onClick={handleClick}
      className="bg-[#14141f] border border-[#1e1e2e] rounded-xl p-3 text-left w-full active:bg-[#1e1e2e] transition-colors"
    >
      <div className="flex items-start gap-3">
        {/* Portrait */}
        <div className="w-10 h-10 rounded-lg bg-[#1e1e2e] flex items-center justify-center shrink-0">
          <span className="text-xs font-mono text-[#7c5bf5]">{getPortrait(agent.name)}</span>
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + status */}
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-medium text-sm text-[#e2e2ef] truncate">{agent.name}</span>
          </div>

          {/* Status line */}
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColors[agent.status]}`} />
            <span className="text-[11px] text-[#6b6b80]">
              {statusLabels[agent.status]}
              {agent.status !== 'running' && ` · ${timeAgo(agent.last_activity)}`}
            </span>
          </div>

          {/* Latest activity summary */}
          {summaryLine && (
            <div className="text-[11px] text-[#6b6b80] truncate">{summaryLine}</div>
          )}
          {lastCommand && !summaryLine && (
            <div className="text-[11px] text-[#6b6b80] truncate italic">
              {lastCommand.status === 'running' ? 'Working on task...' : lastCommand.prompt.slice(0, 60)}
            </div>
          )}
        </div>
      </div>

      {/* Autopilot badge */}
      {agent.autopilot === 1 && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-[#7c5bf5]">
          <span className="w-1 h-1 rounded-full bg-[#7c5bf5] animate-pulse" />
          Autopilot
        </div>
      )}
    </button>
  );
}
