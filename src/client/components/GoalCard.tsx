import { useState, useMemo } from 'react';
import type { Goal, GoalLogEntry, MergeGate, WSClientMessage } from '../lib/types';
import { useStore } from '../stores/store';
import { cn } from '@/lib/utils';
import { formatCost } from '../lib/format';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Progress } from './ui/progress';

const PRIORITY_LABELS: Record<number, { label: string; variant: 'destructive' | 'warning' | 'default' | 'muted' }> = {
  5: { label: 'P1', variant: 'destructive' },
  4: { label: 'P2', variant: 'warning' },
  3: { label: 'P3', variant: 'warning' },
  2: { label: 'P4', variant: 'default' },
  1: { label: 'P5', variant: 'muted' },
};

interface Props {
  goal: Goal;
  onSend: (msg: WSClientMessage) => void;
  onEdit: (goal: Goal) => void;
}

const STATUS_CONFIG: Record<string, { variant: 'success' | 'warning' | 'muted'; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  paused: { variant: 'warning', label: 'Paused' },
  completed: { variant: 'muted', label: 'Done' },
};

const GATE_STATUS_LABEL: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'destructive' | 'muted' }> = {
  pending: { label: 'Pending', variant: 'muted' },
  consolidating: { label: 'Consolidating...', variant: 'default' },
  reviewing: { label: 'Reviewing...', variant: 'default' },
  revising: { label: 'Revising...', variant: 'warning' },
  testing: { label: 'Testing...', variant: 'default' },
  healing: { label: 'Healing...', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  merging: { label: 'Merging...', variant: 'default' },
  merged: { label: 'Merged', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
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
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState('');
  const goalLogs = useStore((s) => s.goalLogs[goal.id] ?? EMPTY_LOGS);
  const goalStats = useStore((s) => s.goalStats[goal.id]);
  const agents = useStore((s) => s.agents);
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const mergeGates = useStore((s) => s.mergeGates);

  const linkedAgents = agents.filter((a) => a.autopilot_goal_id === goal.id);
  const linkedTasks = tasks.filter((t: any) => t.goal_id === goal.id);
  const statusConfig = STATUS_CONFIG[goal.status] || STATUS_CONFIG.active;
  const linkedRepo = repos.find((r) => r.path === goal.repo_id);

  // Find active merge gate for this goal
  const activeGate = mergeGates.find((g) => g.goal_id === goal.id);
  const gateStatus = activeGate ? GATE_STATUS_LABEL[activeGate.status] : null;

  const handleExpand = () => {
    if (!expanded) {
      onSend({ type: 'goal:log', goalId: goal.id, limit: 20 });
      onSend({ type: 'goal:get-stats', goalId: goal.id });
      onSend({ type: 'mergeGate:list' });
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
    const choice = prompt(`Select a repo (enter number):\n\n${repos.map((r, i) => `${i + 1}. ${r.path}`).join('\n')}`);
    if (choice) {
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < repos.length) {
        onSend({ type: 'goal:update', goalId: goal.id, fields: { repo_id: repos[idx].path } });
      }
    }
  };

  const toggleAutoMerge = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSend({ type: 'goal:update', goalId: goal.id, fields: { auto_merge: goal.auto_merge ? 0 : 1 } as any });
  };

  const handleTargetEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTargetDraft(goal.merge_target || 'develop');
    setEditingTarget(true);
  };

  const handleTargetSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    const val = targetDraft.trim() || null;
    onSend({ type: 'goal:update', goalId: goal.id, fields: { merge_target: val } as any });
    setEditingTarget(false);
  };

  const handleConsolidate = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSend({ type: 'mergeGate:consolidate', goalId: goal.id });
  };

  const handleMerge = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeGate) {
      onSend({ type: 'mergeGate:merge', mergeGateId: activeGate.id });
    }
  };

  const handleAbort = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeGate && confirm('Abort merge?')) {
      onSend({ type: 'mergeGate:abort', mergeGateId: activeGate.id });
    }
  };

  const doneTasks = linkedTasks.filter((t: any) => t.status === 'done').length;
  const taskPct = linkedTasks.length > 0 ? Math.round((doneTasks / linkedTasks.length) * 100) : 0;
  const allTasksDone = linkedTasks.length > 0 && doneTasks === linkedTasks.length;

  // Budget progress (shown on the collapsed card when a cap is set).
  const budgetCap = goal.budget_cap_usd || 0;
  const spent = budgetCap > 0 ? goalLogs.reduce((sum, l) => sum + (l.cost_usd || 0), 0) : 0;
  const budgetPct = budgetCap > 0 ? Math.min(100, Math.round((spent / budgetCap) * 100)) : 0;
  const overBudget = budgetCap > 0 && spent > budgetCap;

  return (
    <Card className="overflow-hidden">
      <div className="p-3 flex items-start gap-3 cursor-pointer" onClick={handleExpand}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium text-foreground truncate">{goal.name}</h3>
            <Badge
              variant={statusConfig.variant}
              className="cursor-pointer"
              onClick={(e) => { e.stopPropagation(); cycleStatus(); }}
            >
              {statusConfig.label}
            </Badge>
            {goal.priority > 0 && (() => {
              const p = PRIORITY_LABELS[goal.priority];
              return p ? (
                <Badge variant={p.variant} className="font-bold">{p.label}</Badge>
              ) : null;
            })()}
          </div>
          {goal.description && (
            <p className="text-xs text-muted-foreground line-clamp-2">{goal.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
            {linkedRepo && <span className="text-primary">{linkedRepo.name}</span>}
            {linkedAgents.length > 0 && <span>{linkedAgents.length} agent{linkedAgents.length !== 1 ? 's' : ''}</span>}
            {linkedTasks.length > 0 && <span>{doneTasks}/{linkedTasks.length} tasks done</span>}
            <span>{formatTime(goal.updated_at)}</span>
          </div>
          {/* Merge gate status indicator */}
          {gateStatus && (
            <div className="flex items-center gap-2 mt-1.5">
              <Badge variant={gateStatus.variant} className="text-[10px]">{gateStatus.label}</Badge>
              {activeGate && activeGate.target_branch && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  → {activeGate.target_branch}
                </span>
              )}
            </div>
          )}
          {linkedTasks.length > 0 && (
            <Progress value={taskPct} className="mt-2 h-1" />
          )}
          {budgetCap > 0 && (
            <div className="mt-1.5">
              <div className="flex items-center justify-between text-[10px] mb-0.5">
                <span className="text-muted-foreground">Budget</span>
                <span className={cn('font-mono', overBudget ? 'text-destructive' : 'text-muted-foreground')}>
                  {formatCost(spent)} / {formatCost(budgetCap)}
                </span>
              </div>
              <Progress value={budgetPct} className={cn('h-1', overBudget && '[&>*]:bg-destructive')} />
            </div>
          )}
        </div>
        <span className="text-muted-foreground text-xs mt-1">{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {expanded && (
        <CardContent className="border-t border-border p-3 pt-3">
          {/* Action buttons */}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-muted-foreground">Activity Log</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={handleAssignRepo} className="text-[10px] h-6 px-2 text-primary">
                Assign Repo
              </Button>
              <Button variant="ghost" size="sm" onClick={handleEdit} className="text-[10px] h-6 px-2">
                Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDelete} className="text-[10px] h-6 px-2 text-destructive hover:text-destructive">
                Delete
              </Button>
            </div>
          </div>

          {/* Merge settings */}
          <div className="mb-3 p-2 rounded bg-secondary/50 space-y-2">
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-muted-foreground shrink-0">Merge to:</span>
              {editingTarget ? (
                <div className="flex items-center gap-1 flex-1" onClick={e => e.stopPropagation()}>
                  <Input
                    value={targetDraft}
                    onChange={(e) => setTargetDraft(e.target.value)}
                    className="h-5 text-[10px] px-1.5 font-mono flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleTargetSave(e as any); }}
                    autoFocus
                  />
                  <Button variant="ghost" size="sm" onClick={handleTargetSave} className="text-[10px] h-5 px-1.5 text-success">
                    Save
                  </Button>
                </div>
              ) : (
                <span className="font-mono text-foreground cursor-pointer hover:text-primary" onClick={handleTargetEdit}>
                  {goal.merge_target || 'develop'}
                </span>
              )}
              <span className="text-muted-foreground mx-1">|</span>
              <span className="text-muted-foreground shrink-0">Auto-merge:</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleAutoMerge}
                className={cn('text-[10px] h-5 px-1.5 font-bold', goal.auto_merge ? 'text-success' : 'text-muted-foreground')}
              >
                {goal.auto_merge ? 'ON' : 'OFF'}
              </Button>
            </div>

            {/* Merge gate actions */}
            {activeGate && !['merged', 'failed'].includes(activeGate.status) && (
              <div className="flex items-center gap-2">
                {activeGate.status === 'approved' && (
                  <Button variant="default" size="sm" onClick={handleMerge} className="text-[10px] h-6 px-2">
                    Merge Now
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={handleAbort} className="text-[10px] h-6 px-2 text-destructive hover:text-destructive">
                  Abort
                </Button>
                {activeGate.review_verdict && (() => {
                  try {
                    const v = JSON.parse(activeGate.review_verdict);
                    return v.score != null ? (
                      <span className="text-[10px] text-muted-foreground">Score: {v.score}/100</span>
                    ) : null;
                  } catch { return null; }
                })()}
              </div>
            )}
            {/* Show consolidate button if all tasks done and no active gate */}
            {allTasksDone && (!activeGate || ['merged', 'failed'].includes(activeGate.status)) && goal.status !== 'completed' && (
              <Button variant="default" size="sm" onClick={handleConsolidate} className="text-[10px] h-6 px-2">
                Consolidate & Review
              </Button>
            )}
            {activeGate?.status === 'merged' && (
              <span className="text-[10px] text-success font-medium">Merged to {activeGate.target_branch}</span>
            )}
            {activeGate?.status === 'failed' && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-destructive font-medium">Merge failed</span>
                <Button variant="ghost" size="sm" onClick={handleConsolidate} className="text-[10px] h-6 px-2">
                  Retry
                </Button>
              </div>
            )}
          </div>

          {/* Priority */}
          <div className="mb-3">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] text-muted-foreground">Priority:</span>
              {[1, 2, 3, 4, 5].map((p) => (
                <Button
                  key={p}
                  variant="ghost"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); onSend({ type: 'goal:set-priority', goalId: goal.id, priority: p }); }}
                  className={cn(
                    'w-5 h-5 p-0 rounded text-[10px] font-bold',
                    goal.priority === p ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''
                  )}
                >
                  {p}
                </Button>
              ))}
              {goal.priority > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); onSend({ type: 'goal:set-priority', goalId: goal.id, priority: 0 }); }}
                  className="text-[10px] h-5 px-1 text-muted-foreground hover:text-destructive"
                >
                  clear
                </Button>
              )}
            </div>
            {goalStats && (
              <div className="flex gap-3 text-[10px] text-muted-foreground">
                <span>{goalStats.total_runs} runs</span>
                <span className="text-success">{goalStats.tasks_completed} done</span>
                {goalStats.tasks_failed > 0 && <span className="text-destructive">{goalStats.tasks_failed} failed</span>}
                {goalStats.avg_duration_ms > 0 && <span>{Math.round(goalStats.avg_duration_ms / 60000)}m avg</span>}
                {goalLogs.length > 0 && (() => {
                  const totalCost = goalLogs.reduce((sum, l) => sum + (l.cost_usd || 0), 0);
                  return totalCost > 0 ? (
                    <span className="font-mono">{formatCost(totalCost)}{goal.budget_cap_usd ? ` / ${formatCost(goal.budget_cap_usd)}` : ''}</span>
                  ) : null;
                })()}
              </div>
            )}
          </div>

          {/* Activity log */}
          {goalLogs.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No activity yet</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {goalLogs.map((log: GoalLogEntry) => (
                <div key={log.id} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className={log.success ? 'text-success' : 'text-destructive'}>
                      {log.success ? '\u2713' : '\u2717'}
                    </span>
                    <span className="text-foreground">{log.action}</span>
                    <span className="text-muted-foreground ml-auto">{formatTime(log.created_at)}</span>
                  </div>
                  {log.summary && <p className="text-muted-foreground ml-5 mt-0.5">{log.summary}</p>}
                  {log.diff_stats && <pre className="text-muted-foreground ml-5 mt-0.5 text-[10px]">{log.diff_stats}</pre>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
