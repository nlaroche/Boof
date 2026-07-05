import { useMemo } from 'react';
import { useStore } from '../stores/store';
import { useNow } from '../hooks/useNow';
import { useGoalLogsPrefetch } from '../hooks/useGoalLogsPrefetch';
import { timeAgo, formatCost } from '../lib/format';
import { Card } from './ui/card';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
  limit?: number;
}

type FeedItem = {
  id: string;
  ts: number;
  dot: 'success' | 'warning' | 'destructive' | 'default';
  icon: string;
  text: string;
  meta: string;
  onClick?: () => void;
};

const GATE_STATE_TEXT: Record<string, { text: string; dot: FeedItem['dot']; icon: string }> = {
  approved: { text: 'ready to merge', dot: 'success', icon: '✓' },
  merged: { text: 'merged', dot: 'success', icon: '✓' },
  failed: { text: 'merge gate failed', dot: 'destructive', icon: '✗' },
  reviewing: { text: 'in review', dot: 'default', icon: '○' },
  revising: { text: 'revising', dot: 'warning', icon: '◔' },
  testing: { text: 'running tests', dot: 'default', icon: '○' },
  healing: { text: 'self-healing', dot: 'warning', icon: '◔' },
  consolidating: { text: 'consolidating', dot: 'default', icon: '○' },
};

const DOT_CLASS: Record<FeedItem['dot'], string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  default: 'bg-primary',
};

/**
 * Reverse-chronological cross-goal fleet activity: agent runs (from goal_log),
 * plus merge-gate state transitions. Prefetches recent logs for active goals so
 * the feed is populated on load without opening each goal.
 */
export function ActivityFeed({ onSend, limit = 25 }: Props) {
  const goals = useStore((s) => s.goals);
  const goalLogs = useStore((s) => s.goalLogs);
  const mergeGates = useStore((s) => s.mergeGates);
  const agents = useStore((s) => s.agents);
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);
  useNow(true, 30000); // keep relative timestamps fresh

  const activeGoalIds = useMemo(
    () => goals.filter((g) => g.status === 'active').map((g) => g.id),
    [goals]
  );
  useGoalLogsPrefetch(onSend, activeGoalIds);

  const items = useMemo(() => {
    const goalName = (id: string) => goals.find((g) => g.id === id)?.name || 'goal';
    const agentName = (id: string) => agents.find((a) => a.id === id)?.name || 'agent';
    const out: FeedItem[] = [];

    for (const [goalId, entries] of Object.entries(goalLogs)) {
      for (const log of entries) {
        out.push({
          id: `log-${log.id}`,
          ts: new Date(log.created_at).getTime(),
          dot: log.success ? 'success' : 'destructive',
          icon: log.success ? '✓' : '✗',
          text: `${agentName(log.agent_id)} · ${log.action}`,
          meta: [goalName(goalId), log.cost_usd > 0 ? formatCost(log.cost_usd) : null]
            .filter(Boolean)
            .join(' · '),
          onClick: log.agent_id
            ? () => { setSelectedAgentId(log.agent_id); setActiveScreen('agent'); }
            : undefined,
        });
      }
    }

    for (const gate of mergeGates) {
      const cfg = GATE_STATE_TEXT[gate.status];
      if (!cfg) continue;
      out.push({
        id: `gate-${gate.id}-${gate.status}`,
        ts: new Date(gate.updated_at).getTime(),
        dot: cfg.dot,
        icon: cfg.icon,
        text: `Gate ${cfg.text}`,
        meta: goalName(gate.goal_id),
        onClick: () => setActiveScreen('goals'),
      });
    }

    return out
      .filter((i) => !Number.isNaN(i.ts))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }, [goalLogs, mergeGates, goals, agents, limit, setActiveScreen, setSelectedAgentId]);

  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
        <h2 className="text-xs font-semibold text-foreground">Activity</h2>
        {items.length > 0 && <span className="text-[10px] text-muted-foreground">{items.length}</span>}
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic py-2">No recent activity yet</p>
      ) : (
        <div className="divide-y divide-border/50">
          {items.map((item) => (
            <div
              key={item.id}
              className={`flex items-center gap-2 py-1.5 ${item.onClick ? 'cursor-pointer' : ''}`}
              onClick={item.onClick}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_CLASS[item.dot]}`} />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-foreground truncate">{item.text}</div>
                {item.meta && <div className="text-[10px] text-muted-foreground truncate">{item.meta}</div>}
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(new Date(item.ts).toISOString())}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
