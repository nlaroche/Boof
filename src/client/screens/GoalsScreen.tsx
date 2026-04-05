import { useState, useEffect } from 'react';
import { useStore } from '../stores/store';
import { GoalCard } from '../components/GoalCard';
import { GoalCreateModal } from '../components/GoalCreateModal';
import type { WSClientMessage, Goal } from '../lib/types';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/EmptyState';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function GoalsScreen({ onSend }: Props) {
  const goals = useStore((s) => s.goals);
  const repos = useStore((s) => s.repos);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const goalLogs = useStore((s) => s.goalLogs);
  const [showCreate, setShowCreate] = useState(false);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);

  useEffect(() => {
    if (repos.length === 0) {
      onSend({ type: 'repos:list' });
    }
  }, [repos.length, onSend]);

  const proposedGoals = goals.filter((g) => g.proposal_status === 'pending');
  const activeGoals = goals.filter((g) => g.status === 'active' && g.proposal_status !== 'pending');
  const pausedGoals = goals.filter((g) => g.status === 'paused');
  const completedGoals = goals.filter((g) => g.status === 'completed');

  const handleEdit = (goal: Goal) => {
    setEditGoal(goal);
    setShowCreate(true);
  };

  const handleClose = () => {
    setShowCreate(false);
    setEditGoal(null);
  };

  const handleApprove = (goal: Goal) => {
    onSend({ type: 'goal:update', goalId: goal.id, fields: { proposal_status: 'approved' } as any });
  };

  const handleReject = (goal: Goal) => {
    onSend({ type: 'goal:delete', goalId: goal.id });
  };

  const getAgentName = (agentId: string | null) => {
    if (!agentId) return 'Unknown';
    const agent = agents.find((a) => a.id === agentId);
    return agent?.name || 'Agent';
  };

  return (
    <div className="min-h-full pb-20 px-4 pt-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-foreground">Goals</h1>
        <Button onClick={() => setShowCreate(true)} size="sm">
          + New
        </Button>
      </div>

      {goals.length === 0 && proposedGoals.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="No goals yet"
          description="Create a goal for your agents to work towards"
          action={<Button onClick={() => setShowCreate(true)}>+ New Goal</Button>}
        />
      ) : (
        <div className="space-y-3">
          {/* Proposed Goals */}
          {proposedGoals.length > 0 && (
            <>
              <h2 className="text-xs text-warning font-medium mb-2">Proposed by Agents</h2>
              <div className="space-y-2">
                {proposedGoals.map((g) => (
                  <Card
                    key={g.id}
                    className="border-warning/30 overflow-hidden"
                  >
                    <CardContent className="p-3 pb-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
                        <h3 className="text-sm font-medium text-foreground truncate flex-1">{g.name}</h3>
                      </div>
                      {g.description && (
                        <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{g.description}</p>
                      )}
                      <div className="text-[10px] text-muted-foreground mb-3">
                        Proposed by {getAgentName(g.proposed_by)}
                      </div>
                    </CardContent>
                    <div className="flex border-t border-warning/20">
                      <Button
                        variant="ghost"
                        onClick={() => handleReject(g)}
                        className="flex-1 rounded-none h-10 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/5"
                      >
                        Reject
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => handleApprove(g)}
                        className="flex-1 rounded-none h-10 text-xs text-success hover:bg-success/5 border-l border-warning/20 font-medium"
                      >
                        Approve
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}

          {activeGoals.length > 0 && (
            <div className="space-y-2">
              {activeGoals.map((g) => <GoalCard key={g.id} goal={g} onSend={onSend} onEdit={handleEdit} />)}
            </div>
          )}
          {pausedGoals.length > 0 && (
            <>
              <h2 className="text-xs text-muted-foreground font-medium mt-4">Paused</h2>
              <div className="space-y-2">
                {pausedGoals.map((g) => <GoalCard key={g.id} goal={g} onSend={onSend} onEdit={handleEdit} />)}
              </div>
            </>
          )}
          {completedGoals.length > 0 && (
            <>
              <h2 className="text-xs text-muted-foreground font-medium mt-4">Completed</h2>
              <div className="space-y-2">
                {completedGoals.map((g) => <GoalCard key={g.id} goal={g} onSend={onSend} onEdit={handleEdit} />)}
              </div>
            </>
          )}
        </div>
      )}

      {showCreate && <GoalCreateModal onSend={onSend} onClose={handleClose} editGoal={editGoal} />}
    </div>
  );
}
