import { useEffect } from 'react';
import { useStore } from '../stores/store';
import { DrawerModal } from './DrawerModal';
import { PipelineVisualization } from './PipelineVisualization';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { SkeletonList } from './Skeletons';
import { MERGE_GATE_STATUS_VARIANT, REVIEW_SEVERITY_VARIANT } from '../lib/ui-constants';
import { safeJsonParse } from '../lib/format';
import type { MergeGate, ReviewFinding, WSClientMessage } from '../lib/types';

interface Props {
  gate: MergeGate;
  goalName: string;
  onSend: (msg: WSClientMessage) => void;
  onClose: () => void;
}

const EMPTY: ReviewFinding[] = [];

export function GateSheet({ gate, goalName, onSend, onClose }: Props) {
  // undefined = not fetched yet (show skeleton); array = loaded (maybe empty)
  const findings = useStore((s) => s.reviewFindings[gate.id]);
  const list = findings ?? EMPTY;

  useEffect(() => {
    onSend({ type: 'reviewFindings:list', mergeGateId: gate.id });
  }, [gate.id, onSend]);

  const verdict = safeJsonParse<{ score?: number; summary?: string }>(gate.review_verdict, {});
  const canMerge = gate.status === 'approved';
  const isTerminal = gate.status === 'merged' || gate.status === 'failed';

  const unresolved = list.filter((f) => !f.resolved);
  const resolved = list.filter((f) => f.resolved);

  const handleMerge = () => onSend({ type: 'mergeGate:merge', mergeGateId: gate.id });
  const handleAbort = () => {
    if (confirm('Abort this merge gate?')) {
      onSend({ type: 'mergeGate:abort', mergeGateId: gate.id });
      onClose();
    }
  };

  return (
    <DrawerModal open title={`Merge: ${goalName}`} onClose={onClose} snapPoints={[0.85, 1]}>
      <div className="space-y-4">
        {/* Status + branches */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={MERGE_GATE_STATUS_VARIANT[gate.status]}>{gate.status}</Badge>
          <span className="text-[10px] font-mono text-muted-foreground truncate">
            {gate.goal_branch} → {gate.target_branch}
          </span>
          {typeof verdict.score === 'number' && (
            <span className="text-[10px] text-muted-foreground ml-auto">Score: {verdict.score}/100</span>
          )}
        </div>

        {/* Pipeline */}
        <div>
          <PipelineVisualization currentStatus={gate.status} />
        </div>

        {verdict.summary && (
          <p className="text-xs text-muted-foreground italic border-l-2 border-border pl-2">{verdict.summary}</p>
        )}

        {/* Actions */}
        {!isTerminal && (
          <div className="flex items-center gap-2">
            <Button
              onClick={handleMerge}
              disabled={!canMerge}
              className="flex-1"
              title={canMerge ? 'Merge now' : 'Gate must be approved before merging'}
            >
              {canMerge ? 'Merge Now' : 'Awaiting approval'}
            </Button>
            <Button variant="ghost" onClick={handleAbort} className="text-destructive hover:text-destructive">
              Abort
            </Button>
          </div>
        )}
        {gate.status === 'merged' && (
          <p className="text-xs text-success font-medium">Merged to {gate.target_branch}</p>
        )}
        {gate.status === 'failed' && (
          <p className="text-xs text-destructive font-medium">Merge gate failed — see Pipeline for details</p>
        )}

        {/* Review findings */}
        <div>
          <h3 className="text-xs font-semibold text-foreground mb-2">
            Review findings{list.length > 0 ? ` (${unresolved.length} open)` : ''}
          </h3>
          {findings === undefined ? (
            <SkeletonList count={2} />
          ) : list.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No review findings for this gate.</p>
          ) : (
            <div className="space-y-2">
              {[...unresolved, ...resolved].map((f) => (
                <div
                  key={f.id}
                  className={`rounded-lg border border-border bg-card/50 p-2.5 ${f.resolved ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <Badge variant={REVIEW_SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
                    <Badge variant="secondary">{f.category}</Badge>
                    <span className="text-[10px] text-muted-foreground font-mono truncate">
                      {f.file_path}{f.line_start ? `:${f.line_start}` : ''}
                    </span>
                    {!f.resolved && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[10px] h-6 px-2 ml-auto"
                        onClick={() => onSend({ type: 'reviewFindings:resolve', findingId: f.id, resolvedBy: 'user' })}
                      >
                        Resolve
                      </Button>
                    )}
                  </div>
                  <p className={`text-xs text-foreground ${f.resolved ? 'line-through' : ''}`}>{f.description}</p>
                  {f.suggestion && !f.resolved && (
                    <p className="text-[11px] text-primary mt-1">{f.suggestion}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DrawerModal>
  );
}
