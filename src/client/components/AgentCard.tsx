import type { Agent, Command } from '../lib/types';
import { timeAgo } from '../lib/format';
import { useStore } from '../stores/store';
import { AGENT_STATUS_COLORS, AGENT_STATUS_LABELS, getPortrait, XpBar } from './AgentWidget';

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
      className="bg-[#14141f] border border-[#1e1e2e] rounded-xl p-3 text-left w-full active:bg-[#1e1e2e] transition-all duration-200 hover:border-[#7c5bf5]/30 hover:shadow-lg hover:shadow-[#7c5bf5]/5 active:scale-[0.98]"
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
            <span className={`w-1.5 h-1.5 rounded-full ${AGENT_STATUS_COLORS[agent.status]}`} />
            <span className="text-[11px] text-[#6b6b80]">
              {AGENT_STATUS_LABELS[agent.status]}
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

      {/* XP bar */}
      {(agent.xp || 0) > 0 && <XpBar xp={agent.xp || 0} size="sm" />}

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
