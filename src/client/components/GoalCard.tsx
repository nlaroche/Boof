import { useState } from 'react';
import type { Goal, GoalLogEntry, WSClientMessage } from '../lib/types';
import { useStore } from '../stores/store';

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  5: { label: 'P1', color: 'text-red-400' },
  4: { label: 'P2', color: 'text-orange-400' },
  3: { label: 'P3', color: 'text-yellow-400' },
  2: { label: 'P4', color: 'text-blue-400' },
  1: { label: 'P5', color: 'text-[#6b6b80]' },
};

interface Props {
  goal: Goal;
  onSend: (msg: WSClientMessage) => void;
  onEdit: (goal: Goal) => void;
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

const EMPTY_LOGS: GoalLogEntry[] = [];

export function GoalCard({ goal, onSend, onEdit }: Props) {
  const [expanded, setExpanded] = useState(false);
  const goalLogs = useStore((s) => s.goalLogs[goal.id] ?? EMPTY_LOGS);
  const goalStats = useStore((s) => s.goalStats[goal.id]);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);

  const linkedAgents = agents.filter((a) => a.autopilot_goal_id === goal.id);
  const linkedTasks = tasks.filter((t: any) => t.goal_id === goal.id);
  const status = STATUS_COLORS[goal.status] || STATUS_COLORS.active;
  const linkedRepo = repos.find((r) => r.path === goal.repo_id);

  const handleExpand = () => {
    if (!expanded) {
      onSend({ type: 'goal:log', goalId: goal.id, limit: 20 });
      onSend({ type: 'goal:get-stats', goalId: goal.id });
    }
    setExpanded(!expanded);
  };

  const cycleStatus = () => {
    const next = goal.status === 'active' ? 'paused' : goal.status === 'paused' ? 'completed' : 'active';
    onSend({ type: 'goal:update', goalId: goal.id, fields: { status: next } });
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this goal?')) {
      onSend({ type: 'goal:delete', goalId: goal.id });
    }
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit(goal);
  };

  const handleAssignRepo = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (repos.length === 0) {
      alert('No repos available. Add a repo first.');
      return;
    }
    const currentRepoId = goal.repo_id || '';
    const options = repos.map((r) => `${r.path}${r.path === currentRepoId ? ' (current)' : ''}`).join('\n');
    const choice = prompt(`Select a repo (enter number):\n\n${repos.map((r, i) => `${i + 1}. ${r.path}`).join('\n')}`);
    if (choice) {
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < repos.length) {
        onSend({ type: 'goal:update', goalId: goal.id, fields: { repo_id: repos[idx].path } });
      }
    }
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
            {goal.priority > 0 && (() => {
              const p = PRIORITY_LABELS[goal.priority];
              return p ? (
                <span className={`text-[10px] font-bold ${p.color}`}>{p.label}</span>
              ) : null;
            })()}
          </div>
          {goal.description && (
            <p className="text-xs text-[#6b6b80] line-clamp-2">{goal.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-[#6b6b80]">
            {linkedRepo && <span className="text-[#7c5bf5]">{linkedRepo.name}</span>}
            {linkedAgents.length > 0 && <span>{linkedAgents.length} agent{linkedAgents.length !== 1 ? 's' : ''}</span>}
            {linkedTasks.length > 0 && (() => {
              const done = linkedTasks.filter((t: any) => t.status === 'done').length;
              return <span>{done}/{linkedTasks.length} tasks done</span>;
            })()}
            <span>{formatTime(goal.updated_at)}</span>
          </div>
          {linkedTasks.length > 0 && (() => {
            const done = linkedTasks.filter((t: any) => t.status === 'done').length;
            const pct = Math.round((done / linkedTasks.length) * 100);
            return (
              <div className="mt-2 h-1 bg-[#1e1e2e] rounded-full overflow-hidden">
                <div className="h-full bg-[#22c55e] rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
            );
          })()}
        </div>
        <span className="text-[#6b6b80] text-xs mt-1">{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {expanded && (
        <div className="border-t border-[#1e1e2e] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#6b6b80]">Activity Log</span>
            <div className="flex gap-2">
              <button
                onClick={handleAssignRepo}
                className="text-[10px] text-[#7c5bf5] hover:text-[#9d7fff]"
              >
                Assign Repo
              </button>
              <button
                onClick={handleEdit}
                className="text-[10px] text-[#6b6b80] hover:text-[#e2e2ef]"
              >
                Edit
              </button>
              <button
                onClick={handleDelete}
                className="text-[10px] text-red-400/60 hover:text-red-400"
              >
                Delete
              </button>
            </div>
          </div>
          <div className="mb-3">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] text-[#6b6b80]">Priority:</span>
              {[1, 2, 3, 4, 5].map((p) => (
                <button
                  key={p}
                  onClick={(e) => { e.stopPropagation(); onSend({ type: 'goal:set-priority', goalId: goal.id, priority: p }); }}
                  className={`w-5 h-5 rounded text-[10px] font-bold transition-colors ${goal.priority === p ? 'bg-[#7c5bf5] text-white' : 'bg-[#1e1e2e] text-[#6b6b80] hover:text-[#e2e2ef]'}`}
                >
                  {p}
                </button>
              ))}
              {goal.priority > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); onSend({ type: 'goal:set-priority', goalId: goal.id, priority: 0 }); }}
                  className="text-[10px] text-[#6b6b80] hover:text-red-400 ml-1"
                >
                  clear
                </button>
              )}
            </div>
            {goalStats && (
              <div className="flex gap-3 text-[10px] text-[#6b6b80]">
                <span>{goalStats.total_runs} runs</span>
                <span className="text-[#22c55e]">{goalStats.tasks_completed} done</span>
                {goalStats.tasks_failed > 0 && <span className="text-red-400">{goalStats.tasks_failed} failed</span>}
                {goalStats.avg_duration_ms > 0 && <span>{Math.round(goalStats.avg_duration_ms / 60000)}m avg</span>}
              </div>
            )}
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
