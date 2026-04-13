import type { Agent, Command, Goal } from '../lib/types';
import { timeAgo } from '../lib/format';
import { useStore } from '../stores/store';
import { AGENT_STATUS_COLORS, AGENT_STATUS_LABELS, getPortrait, XpBar } from './AgentWidget';
import { Card } from './ui/card';
import { Badge } from './ui/badge';

export function AgentCard({ agent, lastCommand }: { agent: Agent; lastCommand?: Command }) {
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);
  const goals = useStore((s) => s.goals);

  const handleClick = () => {
    setSelectedAgentId(agent.id);
    setActiveScreen('agent');
  };

  const currentGoal = agent.autopilot_goal_id
    ? goals.find((g) => g.id === agent.autopilot_goal_id)
    : null;

  const summaryLine = lastCommand?.summary?.split('\n')[0] || '';
  const isRunning = agent.status === 'running';

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
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${AGENT_STATUS_COLORS[agent.status]} ${isRunning ? 'animate-pulse' : ''}`} />
            <span className="text-[10px] text-muted-foreground shrink-0">
              {isRunning ? 'working' : timeAgo(agent.last_activity)}
            </span>
          </div>

          {/* Current goal */}
          {currentGoal && (
            <div className="text-[11px] text-primary truncate mb-0.5">
              {currentGoal.name}
            </div>
          )}

          {/* What it's doing right now */}
          {isRunning && lastCommand?.status === 'running' && (
            <div className="text-[11px] text-warning truncate">
              {lastCommand.prompt.slice(0, 80)}...
            </div>
          )}
          {!isRunning && summaryLine && (
            <div className="text-[11px] text-muted-foreground truncate">{summaryLine}</div>
          )}
          {!isRunning && !summaryLine && lastCommand && (
            <div className="text-[11px] text-muted-foreground truncate italic">
              {lastCommand.prompt.slice(0, 60)}
            </div>
          )}
        </div>
      </div>

      {/* XP bar */}
      {(agent.xp || 0) > 0 && <XpBar xp={agent.xp || 0} size="sm" />}

      {/* Status badges */}
      <div className="flex gap-1 mt-2 flex-wrap">
        {agent.autopilot === 1 && (
          <Badge variant="default" className="text-[10px]">
            autopilot {Math.round(agent.autopilot_interval / 60)}m
          </Badge>
        )}
        {agent.self_improve === 1 && (
          <Badge variant="secondary" className="text-[10px]">self-improve</Badge>
        )}
        {agent.workflow_id && (
          <Badge variant="muted" className="text-[10px]">workflow</Badge>
        )}
      </div>
    </Card>
  );
}
