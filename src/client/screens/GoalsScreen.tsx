import { useState, useEffect } from 'react';
import { useStore } from '../stores/store';
import { GoalCard } from '../components/GoalCard';
import { GoalCreateModal } from '../components/GoalCreateModal';
import type { WSClientMessage, Goal } from '../lib/types';
import { Button, EmptyState } from '../components/ui';

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
        <h1 className="text-xl font-bold text-[#e2e2ef]">Goals</h1>
        <Button onClick={() => setShowCreate(true)} className="px-3 py-1.5 text-sm">
          + New
        </Button>
      </div>

      {goals.length === 0 && proposedGoals.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="No goals yet"
          description="Create a goal for your agents to work towards"
          action={<Button onClick={() => setShowCreate(true)} className="px-4 py-2">+ New Goal</Button>}
        />
      ) : (
        <div className="space-y-3">
          {/* Proposed Goals */}
          {proposedGoals.length > 0 && (
            <>
              <h2 className="text-xs text-[#f59e0b] font-medium mb-2">Proposed by Agents</h2>
              <div className="space-y-2">
                {proposedGoals.map((g) => (
                  <div
                    key={g.id}
                    className="bg-[#14141f] border border-[#f59e0b]/30 rounded-xl overflow-hidden"
                  >
                    <div className="p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="w-2 h-2 rounded-full bg-[#f59e0b] animate-pulse" />
                        <h3 className="text-sm font-medium text-[#e2e2ef] truncate flex-1">{g.name}</h3>
                      </div>
                      {g.description && (
                        <p className="text-xs text-[#6b6b80] mb-2 line-clamp-2">{g.description}</p>
                      )}
                      <div className="text-[10px] text-[#6b6b80]">
                        Proposed by {getAgentName(g.proposed_by)}
                      </div>
                    </div>
                    <div className="flex border-t border-[#f59e0b]/20">
                      <button
                        onClick={() => handleReject(g)}
                        className="flex-1 py-2.5 text-xs text-[#6b6b80] hover:text-[#ef4444] hover:bg-[#ef4444]/5 transition-colors active:bg-[#ef4444]/10"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => handleApprove(g)}
                        className="flex-1 py-2.5 text-xs text-[#22c55e] hover:bg-[#22c55e]/5 border-l border-[#f59e0b]/20 transition-colors active:bg-[#22c55e]/10 font-medium"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
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
              <h2 className="text-xs text-[#6b6b80] font-medium mt-4">Paused</h2>
              <div className="space-y-2">
                {pausedGoals.map((g) => <GoalCard key={g.id} goal={g} onSend={onSend} onEdit={handleEdit} />)}
              </div>
            </>
          )}
          {completedGoals.length > 0 && (
            <>
              <h2 className="text-xs text-[#6b6b80] font-medium mt-4">Completed</h2>
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
