import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { getPortrait, getLevel, XpBar, AGENT_STATUS_BADGE_COLORS, AGENT_STATUS_LABELS } from './AgentWidget';
import { formatDuration, truncate, timeAgo } from '../lib/format';
import type { Agent, Command, Goal } from '../lib/types';

interface Props {
  agent: Agent;
  commands: Command[];
  goals: Goal[];
  onClick: () => void;
}

export function DashboardAgentCard({ agent, commands, goals, onClick }: Props) {
  const agentCommands = commands
    .filter((c) => c.agent_id === agent.id)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  const runningCmd = agentCommands.find((c) => c.status === 'running');
  const recentDone = agentCommands.filter((c) => c.status !== 'running').slice(0, 3);
  const currentGoal = agent.autopilot_goal_id ? goals.find((g) => g.id === agent.autopilot_goal_id) : null;

  const statusColors = AGENT_STATUS_BADGE_COLORS;
  const statusLabels = AGENT_STATUS_LABELS;
  const isRunning = agent.status === 'running';

  return (
    <Card
      className="cursor-pointer hover:border-primary/50 transition-colors"
      onClick={onClick}
    >
      <div className="p-3">
        {/* Header: portrait + name + status */}
        <div className="flex items-center gap-3 mb-2">
          <span className="text-lg font-mono shrink-0">{getPortrait(agent.name)}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground truncate">{agent.name}</span>
              <Badge className={statusColors[agent.status]}>
                {statusLabels[agent.status]}
              </Badge>
              {!isRunning && (
                <span className="text-[10px] text-muted-foreground">{timeAgo(agent.last_activity)}</span>
              )}
            </div>
            {currentGoal && (
              <div className="text-[11px] text-primary truncate mt-0.5">
                {currentGoal.name}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-0.5 items-end shrink-0">
            {agent.autopilot === 1 && <Badge variant="default" className="text-[9px]">auto {Math.round(agent.autopilot_interval / 60)}m</Badge>}
            {agent.self_improve === 1 && <Badge variant="secondary" className="text-[9px]">SI</Badge>}
          </div>
        </div>

        {/* XP bar */}
        <XpBar xp={agent.xp || 0} size="sm" />

        {/* Running command */}
        {runningCmd && (
          <div className="mt-2 bg-warning/10 rounded-md px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse shrink-0" />
              <span className="text-[10px] text-warning">Working...</span>
            </div>
            <p className="text-[10px] text-foreground truncate mt-0.5">{truncate(runningCmd.prompt, 80)}</p>
          </div>
        )}

        {/* Idle status with next run info */}
        {!isRunning && agent.autopilot === 1 && agent.autopilot_last_run && (
          <div className="mt-2 text-[10px] text-muted-foreground">
            Last run {timeAgo(agent.autopilot_last_run)} · next in ~{Math.max(0, Math.round((agent.autopilot_interval - (Date.now() - new Date(agent.autopilot_last_run).getTime()) / 1000) / 60))}m
          </div>
        )}

        {/* Recent commands */}
        {recentDone.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {recentDone.map((cmd) => {
              const durationMs = cmd.completed_at
                ? new Date(cmd.completed_at).getTime() - new Date(cmd.started_at).getTime()
                : 0;
              return (
                <div key={cmd.id} className="flex items-center gap-2 text-[10px]">
                  <span className={cmd.status === 'done' ? 'text-success' : 'text-destructive'}>
                    {cmd.status === 'done' ? '\u2713' : '\u2717'}
                  </span>
                  <span className="text-foreground truncate flex-1">{truncate(cmd.prompt, 50)}</span>
                  {durationMs > 0 && (
                    <span className="text-muted-foreground shrink-0">{formatDuration(durationMs)}</span>
                  )}
                  <span className="text-muted-foreground shrink-0">{timeAgo(cmd.started_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
