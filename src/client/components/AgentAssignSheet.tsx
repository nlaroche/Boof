import { useStore } from '../stores/store';
import { DrawerModal } from './DrawerModal';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { cn } from '@/lib/utils';
import type { Goal, WSClientMessage } from '../lib/types';

interface Props {
  goal: Goal;
  onSend: (msg: WSClientMessage) => void;
  onClose: () => void;
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'muted' | 'destructive'> = {
  idle: 'muted',
  running: 'success',
  error: 'destructive',
  dead: 'destructive',
};

/**
 * Assign an agent to a goal by enabling its autopilot pinned to this goal —
 * the same `agent:autopilot` message AgentSettingsModal uses.
 */
export function AgentAssignSheet({ goal, onSend, onClose }: Props) {
  const agents = useStore((s) => s.agents);
  const goals = useStore((s) => s.goals);

  const goalName = (id: string | null) => (id ? goals.find((g) => g.id === id)?.name : null);

  const assign = (agentId: string, interval: number) => {
    onSend({ type: 'agent:autopilot', agentId, autopilot: true, interval: interval || 600, goalId: goal.id });
    onClose();
  };

  return (
    <DrawerModal open title={`Assign agent to "${goal.name}"`} onClose={onClose}>
      <div className="space-y-2">
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No agents available. Create one first.</p>
        ) : (
          agents.map((a) => {
            const current = goalName(a.autopilot_goal_id);
            const isAssignedHere = a.autopilot_goal_id === goal.id && !!a.autopilot;
            return (
              <Card
                key={a.id}
                onClick={() => !isAssignedHere && assign(a.id, a.autopilot_interval)}
                className={cn(
                  'p-3 flex items-center gap-3 transition-colors',
                  isAssignedHere ? 'border-primary/40 bg-primary/10' : 'cursor-pointer hover:bg-secondary'
                )}
              >
                <span className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  a.status === 'running' ? 'bg-success animate-pulse' :
                  a.status === 'idle' ? 'bg-muted-foreground' : 'bg-destructive'
                )} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-foreground truncate">{a.name}</span>
                    <Badge variant={STATUS_VARIANT[a.status] || 'muted'} className="text-[10px]">{a.status}</Badge>
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {isAssignedHere ? 'Assigned to this goal' : current ? `On: ${current}` : 'Unassigned'}
                    {a.autopilot ? ' · autopilot' : ''}
                  </div>
                </div>
                {!isAssignedHere && <span className="text-[10px] text-primary shrink-0">Assign →</span>}
              </Card>
            );
          })
        )}
      </div>
    </DrawerModal>
  );
}
