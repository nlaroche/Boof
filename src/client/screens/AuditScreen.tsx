import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { EmptyState } from '../components/EmptyState';
import { timeAgo, formatTokens, formatCost, formatDuration, safeJsonParse } from '../lib/format';
import { useEntityMap, lookupName } from '../lib/lookups';
import { AUDIT_OUTCOME_VARIANT } from '../lib/ui-constants';
import type { WSClientMessage, AuditRecord } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function AuditScreen({ onSend }: Props) {
  const auditRecords = useStore((s) => s.auditRecords);
  const agents = useStore((s) => s.agents);
  const agentMap = useEntityMap(agents);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterAction, setFilterAction] = useState<string | null>(null);

  const { records, totalCost, totalTokens, actionTypes } = useMemo(() => {
    const all = Object.values(auditRecords).flat()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const actions = [...new Set(all.map(r => r.action_type))];
    return {
      records: filterAction ? all.filter(r => r.action_type === filterAction) : all,
      totalCost: all.reduce((sum, r) => sum + (r.cost_usd || 0), 0),
      totalTokens: all.reduce((sum, r) => sum + (r.tokens_used || 0), 0),
      actionTypes: actions,
    };
  }, [auditRecords, filterAction]);

  useEffect(() => {
    onSend({ type: 'audit:list', limit: 200 });
  }, [onSend]);

  if (records.length === 0 && !filterAction) {
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
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-foreground">Audit Trail</h1>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{records.length} records</span>
          <span>{formatCost(totalCost)} total</span>
          <span>{formatTokens(totalTokens)}</span>
        </div>
      </div>

      {/* Action type filters */}
      {actionTypes.length > 1 && (
        <div className="flex gap-1 mb-4 flex-wrap">
          <Button variant={filterAction === null ? 'default' : 'outline'} size="sm"
            onClick={() => setFilterAction(null)}>All</Button>
          {actionTypes.map(action => (
            <Button key={action} variant={filterAction === action ? 'default' : 'outline'} size="sm"
              onClick={() => setFilterAction(action)}>{action}</Button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {records.map((record) => (
          <AuditRecordCard
            key={record.id}
            record={record}
            agentName={lookupName(agentMap, record.agent_id)}
            expanded={expandedId === record.id}
            onToggle={() => setExpandedId(expandedId === record.id ? null : record.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AuditRecordCard({ record, agentName, expanded, onToggle }: {
  record: AuditRecord;
  agentName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detail = safeJsonParse<Record<string, unknown>>(record.action_detail, {});
  const hasDetail = Object.keys(detail).length > 0;

  return (
    <Card className="py-0">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 cursor-pointer" onClick={hasDetail ? onToggle : undefined}>
          <Badge variant={AUDIT_OUTCOME_VARIANT[record.outcome]} className="text-[10px]">
            {record.outcome}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {record.action_type}
          </Badge>
          <span className="text-[10px] text-muted-foreground">{agentName}</span>
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
          {hasDetail && (
            <span className="text-[10px] text-muted-foreground">{expanded ? '▾' : '▸'}</span>
          )}
        </div>
        {expanded && hasDetail && (
          <pre className="mt-2 text-[10px] text-muted-foreground bg-secondary rounded p-2 overflow-x-auto font-mono max-h-48 overflow-y-auto">
            {JSON.stringify(detail, null, 2)}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
