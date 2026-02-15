import { useState } from 'react';
import type { Goal, GoalLogEntry, WSClientMessage } from '../lib/types';
import { useStore } from '../stores/store';

interface Props {
  goal: Goal;
  onSend: (msg: WSClientMessage) => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  active: { bg: 'bg-[#22c55e]/20', text: 'text-[#22c55e]', label: 'Active' },
  paused: { bg: 'bg-[#f59e0b]/20', text: 'text-[#f59e0b]', label: 'Paused' },
  completed: { bg: 'bg-[#6b6b80]/20', text: 'text-[#6b6b80]', label: 'Done' },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

export function GoalCard({ goal, onSend }: Props) {
  const [expanded, setExpanded] = useState(false);
  const goalLogs = useStore((s) => s.goalLogs[goal.id] || []);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);

  const linkedAgents = agents.filter((a) => a.autopilot_goal_id === goal.id);
  const linkedTasks = tasks.filter((t: any) => t.goal_id === goal.id);
  const status = STATUS_COLORS[goal.status] || STATUS_COLORS.active;

  const handleExpand = () => {
    if (!expanded) {
      onSend({ type: 'goal:log', goalId: goal.id, limit: 20 });
    }
    setExpanded(!expanded);
  };

  const cycleStatus = () => {
    const next = goal.status === 'active' ? 'paused' : goal.status === 'paused' ? 'completed' : 'active';
    onSend({ type: 'goal:update', goalId: goal.id, fields: { status: next } });
  };

  return (
    <div className="bg-[#14141f] border border-[#1e1e2e] rounded-xl overflow-hidden">
      <div className="p-3 flex items-start gap-3" onClick={handleExpand}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium text-[#e2e2ef] truncate">{goal.name}</h3>
            <button
              onClick={(e) => { e.stopPropagation(); cycleStatus(); }}
              className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${status.bg} ${status.text}`}
            >
              {status.label}
            </button>
          </div>
          {goal.description && (
            <p className="text-xs text-[#6b6b80] line-clamp-2">{goal.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-[#6b6b80]">
            {linkedAgents.length > 0 && <span>{linkedAgents.length} agent{linkedAgents.length !== 1 ? 's' : ''}</span>}
            {linkedTasks.length > 0 && <span>{linkedTasks.length} task{linkedTasks.length !== 1 ? 's' : ''}</span>}
            <span>{formatTime(goal.updated_at)}</span>
          </div>
        </div>
        <span className="text-[#6b6b80] text-xs mt-1">{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {expanded && (
        <div className="border-t border-[#1e1e2e] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#6b6b80]">Activity Log</span>
            <button
              onClick={() => onSend({ type: 'goal:delete', goalId: goal.id })}
              className="text-[10px] text-red-400/60 hover:text-red-400"
            >
              Delete
            </button>
          </div>
          {goalLogs.length === 0 ? (
            <p className="text-xs text-[#6b6b80] italic">No activity yet</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {goalLogs.map((log: GoalLogEntry) => (
                <div key={log.id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className={log.success ? 'text-[#22c55e]' : 'text-red-400'}>
                      {log.success ? '\u2713' : '\u2717'}
                    </span>
                    <span className="text-[#e2e2ef]">{log.action}</span>
                    <span className="text-[#6b6b80] ml-auto">{formatTime(log.created_at)}</span>
                  </div>
                  {log.summary && <p className="text-[#6b6b80] ml-5 mt-0.5">{log.summary}</p>}
                  {log.diff_stats && <pre className="text-[#6b6b80] ml-5 mt-0.5 text-[10px]">{log.diff_stats}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
