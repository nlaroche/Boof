import { useEffect } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { EmptyState } from '../components/EmptyState';
import { PipelineVisualization } from '../components/PipelineVisualization';
import { useEntityMap, lookupName } from '../lib/lookups';
import { safeJsonParse } from '../lib/format';
import { MERGE_GATE_STATUS_VARIANT } from '../lib/ui-constants';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function PipelineScreen({ onSend }: Props) {
  const mergeGates = useStore((s) => s.mergeGates);
  const goals = useStore((s) => s.goals);
  const goalMap = useEntityMap(goals);

  useEffect(() => {
    onSend({ type: 'mergeGate:list' });
  }, [onSend]);

  // Goals with all tasks done that could be consolidated
  const tasks = useStore((s) => s.tasks);
  const consolidatableGoals = goals.filter((g) => {
    if (g.status === 'completed') return false;
    const goalTasks = tasks.filter((t: any) => t.goal_id === g.id);
    if (goalTasks.length === 0) return false;
    const allDone = goalTasks.every((t: any) => t.status === 'done');
    const hasActiveGate = mergeGates.some((mg) => mg.goal_id === g.id && !['merged', 'failed'].includes(mg.status));
    return allDone && !hasActiveGate;
  });

  if (mergeGates.length === 0 && consolidatableGoals.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-foreground mb-6">Pipeline</h1>
        <EmptyState
          icon="|>"
          title="No merge gates"
          description="Merge gates are created when all tasks for a goal are completed and consolidation begins."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-foreground mb-6">Pipeline</h1>

      {/* Ready to consolidate */}
      {consolidatableGoals.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Ready to consolidate</h2>
          <div className="space-y-2">
            {consolidatableGoals.map((g) => (
              <Card key={g.id} className="p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-foreground">{g.name}</span>
                    <span className="text-xs text-muted-foreground ml-2 font-mono">→ {g.merge_target || 'develop'}</span>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => onSend({ type: 'mergeGate:consolidate', goalId: g.id })}
                    className="text-xs h-7 px-3"
                  >
                    Consolidate & Review
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Active merge gates */}
      <div className="space-y-4">
        {mergeGates.map((gate) => {
          const verdict = safeJsonParse<{ score?: number; summary?: string }>(gate.review_verdict, {});
          const isActive = !['merged', 'failed'].includes(gate.status);
          return (
            <Card key={gate.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">{lookupName(goalMap, gate.goal_id)}</CardTitle>
                  <Badge variant={MERGE_GATE_STATUS_VARIANT[gate.status]}>
                    {gate.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {gate.goal_branch} → {gate.target_branch}
                </div>
              </CardHeader>
              <CardContent>
                <PipelineVisualization currentStatus={gate.status} />
                <div className="flex gap-4 text-xs text-muted-foreground mt-2">
                  <span>Reviews: {gate.review_cycles}</span>
                  <span>Heals: {gate.heal_attempts}</span>
                  {verdict.score != null && (
                    <span className={verdict.score >= 70 ? 'text-success' : 'text-destructive'}>
                      Score: {verdict.score}
                    </span>
                  )}
                </div>
                {verdict.summary && (
                  <p className="text-xs text-muted-foreground mt-2 italic">{verdict.summary}</p>
                )}
                {/* Action buttons */}
                <div className="flex gap-2 mt-3">
                  {gate.status === 'approved' && (
                    <Button
                      size="sm"
                      onClick={() => onSend({ type: 'mergeGate:merge', mergeGateId: gate.id })}
                      className="text-xs h-7 px-3"
                    >
                      Merge Now
                    </Button>
                  )}
                  {isActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm('Abort this merge gate?')) {
                          onSend({ type: 'mergeGate:abort', mergeGateId: gate.id });
                        }
                      }}
                      className="text-xs h-7 px-3 text-destructive hover:text-destructive"
                    >
                      Abort
                    </Button>
                  )}
                  {gate.status === 'failed' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onSend({ type: 'mergeGate:consolidate', goalId: gate.goal_id })}
                      className="text-xs h-7 px-3"
                    >
                      Retry
                    </Button>
                  )}
                  {gate.status === 'merged' && (
                    <Badge variant="success" className="text-xs">Merged</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
