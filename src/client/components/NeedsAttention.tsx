import { useStore } from '../stores/store';
import { useAttention } from '../hooks/useAttention';
import { Card } from './ui/card';
import { Button } from './ui/button';
import type { WSClientMessage, Goal } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

type Dot = 'success' | 'warning' | 'destructive';

const DOT_CLASS: Record<Dot, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

function Row({
  dot,
  text,
  onClick,
  actions,
}: {
  dot: Dot;
  text: string;
  onClick?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-2 py-1.5 ${onClick ? 'cursor-pointer' : ''}`}
      onClick={onClick}
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLASS[dot]}`} />
      <span className="text-xs text-foreground truncate flex-1 min-w-0">{text}</span>
      {actions && <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>{actions}</div>}
    </div>
  );
}

export function NeedsAttention({ onSend }: Props) {
  const {
    approvedGates,
    failedGates,
    brokenAgents,
    pausedGoals,
    proposedGoals,
    criticalFindings,
    counts,
  } = useAttention();

  const goals = useStore((s) => s.goals);
  const agents = useStore((s) => s.agents);
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);

  const goalName = (goalId: string) => goals.find((g) => g.id === goalId)?.name || 'goal';
  const runningCount = agents.filter((a) => a.status === 'running').length;

  if (counts.total === 0) {
    return (
      <Card className="p-3 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-success shrink-0" />
        <span className="text-xs text-muted-foreground">
          All quiet{runningCount > 0 ? ` — ${runningCount} agent${runningCount === 1 ? '' : 's'} working` : ''}
        </span>
      </Card>
    );
  }

  const approveGoal = (g: Goal) =>
    onSend({ type: 'goal:update', goalId: g.id, fields: { proposal_status: 'approved' } as Partial<Goal> });
  const rejectGoal = (g: Goal) => onSend({ type: 'goal:delete', goalId: g.id });

  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
        <h2 className="text-xs font-semibold text-foreground">Needs Attention</h2>
        <span className="text-[10px] text-muted-foreground">{counts.total}</span>
      </div>

      <div className="divide-y divide-border/50">
        {/* Gates ready to merge */}
        {approvedGates.map((gate) => (
          <Row
            key={`ag-${gate.id}`}
            dot="success"
            text={`Ready to merge: ${goalName(gate.goal_id)}`}
            actions={
              <Button
                size="sm"
                className="text-[10px] h-6 px-2"
                onClick={() => onSend({ type: 'mergeGate:merge', mergeGateId: gate.id })}
              >
                Merge
              </Button>
            }
          />
        ))}

        {/* Failed gates */}
        {failedGates.map((gate) => (
          <Row
            key={`fg-${gate.id}`}
            dot="destructive"
            text={`Merge failed: ${goalName(gate.goal_id)}`}
            onClick={() => setActiveScreen('pipeline')}
          />
        ))}

        {/* Proposed goals awaiting approval */}
        {proposedGoals.map((g) => (
          <Row
            key={`pg-${g.id}`}
            dot="warning"
            text={`Proposed goal: ${g.name}`}
            actions={
              <>
                <Button variant="ghost" size="sm" className="text-[10px] h-6 px-2 text-destructive hover:text-destructive" onClick={() => rejectGoal(g)}>
                  Reject
                </Button>
                <Button size="sm" className="text-[10px] h-6 px-2" onClick={() => approveGoal(g)}>
                  Approve
                </Button>
              </>
            }
          />
        ))}

        {/* Broken agents */}
        {brokenAgents.map((a) => (
          <Row
            key={`ba-${a.id}`}
            dot="destructive"
            text={`Agent ${a.name} is ${a.status}`}
            onClick={() => {
              setSelectedAgentId(a.id);
              setActiveScreen('agent');
            }}
          />
        ))}

        {/* Paused goals */}
        {pausedGoals.map((g) => (
          <Row
            key={`pa-${g.id}`}
            dot="warning"
            text={`Goal paused: ${g.name}`}
            onClick={() => setActiveScreen('goals')}
          />
        ))}

        {/* Critical review findings */}
        {criticalFindings.length > 0 && (
          <Row
            dot="destructive"
            text={`${criticalFindings.length} unresolved critical review finding${criticalFindings.length === 1 ? '' : 's'}`}
            onClick={() => setActiveScreen('reviews')}
          />
        )}
      </div>
    </Card>
  );
}
