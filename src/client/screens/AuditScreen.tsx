import { useEffect, useMemo } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { EmptyState } from '../components/EmptyState';
import { timeAgo, formatTokens, formatCost, formatDuration } from '../lib/format';
import { AUDIT_OUTCOME_VARIANT } from '../lib/ui-constants';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function AuditScreen({ onSend }: Props) {
  const auditRecords = useStore((s) => s.auditRecords);

  const { records, totalCost, totalTokens } = useMemo(() => {
    const all = Object.values(auditRecords).flat()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return {
      records: all,
      totalCost: all.reduce((sum, r) => sum + (r.cost_usd || 0), 0),
      totalTokens: all.reduce((sum, r) => sum + (r.tokens_used || 0), 0),
    };
  }, [auditRecords]);

  useEffect(() => {
    onSend({ type: 'audit:list', limit: 100 });
  }, [onSend]);

  if (records.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-foreground mb-6">Audit Trail</h1>
        <EmptyState
          icon="##"
          title="No audit records"
          description="Audit records are created during merge gate operations (consolidation, review, testing, healing, merging)."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-foreground">Audit Trail</h1>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{records.length} records</span>
          <span>{formatCost(totalCost)} total</span>
          <span>{formatTokens(totalTokens)}</span>
        </div>
      </div>

      <div className="space-y-2">
        {records.map((record) => (
          <Card key={record.id} className="py-0">
            <CardContent className="p-3">
              <div className="flex items-center gap-2">
                <Badge variant={AUDIT_OUTCOME_VARIANT[record.outcome]} className="text-[10px]">
                  {record.outcome}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {record.action_type}
                </Badge>
                <span className="text-xs text-muted-foreground">{timeAgo(record.created_at)}</span>
                <div className="flex-1" />
                {record.cost_usd != null && record.cost_usd > 0 && (
                  <span className="text-[10px] text-muted-foreground font-mono">{formatCost(record.cost_usd)}</span>
                )}
                {record.tokens_used != null && record.tokens_used > 0 && (
                  <span className="text-[10px] text-muted-foreground font-mono">{formatTokens(record.tokens_used)}</span>
                )}
                {record.duration_ms != null && (
                  <span className="text-[10px] text-muted-foreground font-mono">{formatDuration(record.duration_ms)}</span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
