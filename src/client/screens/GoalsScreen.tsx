import { useState, useEffect } from 'react';
import { useStore } from '../stores/store';
import { GoalCard } from '../components/GoalCard';
import { GoalCreateModal } from '../components/GoalCreateModal';
import type { WSClientMessage, Goal } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function GoalsScreen({ onSend }: Props) {
  const goals = useStore((s) => s.goals);
  const repos = useStore((s) => s.repos);
  const [showCreate, setShowCreate] = useState(false);
  const [editGoal, setEditGoal] = useState<Goal | null>(null);

  useEffect(() => {
    if (repos.length === 0) {
      onSend({ type: 'repos:list' });
    }
  }, [repos.length, onSend]);

  const activeGoals = goals.filter((g) => g.status === 'active');
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

  return (
    <div className="min-h-full pb-20 px-4 pt-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-[#e2e2ef]">Goals</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 bg-[#7c5bf5] text-white rounded-lg text-sm font-medium active:bg-[#6b4ae4]"
        >
          + New
        </button>
      </div>

      {goals.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-[#6b6b80] text-sm">No goals yet</p>
          <p className="text-[#6b6b80] text-xs mt-1">Create a goal for your agents to work towards</p>
        </div>
      ) : (
        <div className="space-y-3">
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
