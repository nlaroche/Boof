import type { Agent, Command } from '../lib/types';
import { timeAgo } from '../lib/format';
import { useStore } from '../stores/store';
import { AGENT_STATUS_COLORS, AGENT_STATUS_LABELS, getPortrait, XpBar } from './AgentWidget';
import { Card } from './ui/card';
import { Badge } from './ui/badge';

export function AgentCard({ agent, lastCommand }: { agent: Agent; lastCommand?: Command }) {
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);

  const handleClick = () => {
    setSelectedAgentId(agent.id);
    setActiveScreen('agent');
  };

  const summaryLine = lastCommand?.summary?.split('\n')[0] || '';

  return (
    <Card
      className="p-3 cursor-pointer text-left w-full active:bg-secondary transition-all duration-200 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 active:scale-[0.98]"
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        {/* Portrait */}
        <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
          <span className="text-xs font-mono text-primary">{getPortrait(agent.name)}</span>
        </div>

        <div className="flex-1 min-w-0">
          {/* Name + status */}
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-medium text-sm text-foreground truncate">{agent.name}</span>
          </div>

          {/* Status line */}
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full ${AGENT_STATUS_COLORS[agent.status]}`} />
            <span className="text-[11px] text-muted-foreground">
              {AGENT_STATUS_LABELS[agent.status]}
              {agent.status !== 'running' && ` · ${timeAgo(agent.last_activity)}`}
            </span>
          </div>

          {/* Latest activity summary */}
          {summaryLine && (
            <div className="text-[11px] text-muted-foreground truncate">{summaryLine}</div>
          )}
          {lastCommand && !summaryLine && (
            <div className="text-[11px] text-muted-foreground truncate italic">
              {lastCommand.status === 'running' ? 'Working on task...' : lastCommand.prompt.slice(0, 60)}
            </div>
          )}
        </div>
      </div>

      {/* XP bar */}
      {(agent.xp || 0) > 0 && <XpBar xp={agent.xp || 0} size="sm" />}

      {/* Autopilot badge */}
      {agent.autopilot === 1 && (
        <div className="mt-2">
          <Badge variant="default" className="text-[10px]">
            <span className="w-1 h-1 rounded-full bg-primary animate-pulse" />
            Autopilot
          </Badge>
        </div>
      )}
    </Card>
  );
}
