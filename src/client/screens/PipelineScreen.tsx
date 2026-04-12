import { useEffect } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
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

  if (mergeGates.length === 0) {
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
      <div className="space-y-4">
        {mergeGates.map((gate) => {
          const verdict = safeJsonParse<{ score?: number }>(gate.review_verdict, {});
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
                  {verdict.score != null && <span>Score: {verdict.score}</span>}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
