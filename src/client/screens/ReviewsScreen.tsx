import { useState, useMemo } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/EmptyState';
import { REVIEW_SEVERITY_VARIANT } from '../lib/ui-constants';
import type { WSClientMessage, ReviewFinding } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function ReviewsScreen({ onSend }: Props) {
  const reviewFindings = useStore((s) => s.reviewFindings);
  const allFindings = Object.values(reviewFindings).flat();
  const [showResolved, setShowResolved] = useState(false);
  const [filterSeverity, setFilterSeverity] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string | null>(null);

  const { severities, categories } = useMemo(() => ({
    severities: [...new Set(allFindings.map(f => f.severity))],
    categories: [...new Set(allFindings.map(f => f.category))],
  }), [allFindings]);

  const filtered = useMemo(() => {
    let results = allFindings;
    if (filterSeverity) results = results.filter(f => f.severity === filterSeverity);
    if (filterCategory) results = results.filter(f => f.category === filterCategory);
    return results;
  }, [allFindings, filterSeverity, filterCategory]);

  if (allFindings.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-foreground mb-6">Reviews</h1>
        <EmptyState
          icon="!!"
          title="No review findings"
          description="Review findings appear when the review agent analyzes consolidated branches."
        />
      </div>
    );
  }

  const unresolved = filtered.filter((f) => !f.resolved);
  const resolved = filtered.filter((f) => f.resolved);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-foreground">Reviews</h1>
        <span className="text-xs text-muted-foreground">{allFindings.length} total findings</span>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-4">
        {severities.length > 1 && (
          <div className="flex gap-1">
            <Button variant={filterSeverity === null ? 'default' : 'outline'} size="sm"
              onClick={() => setFilterSeverity(null)}>All</Button>
            {severities.map(s => (
              <Button key={s} variant={filterSeverity === s ? 'default' : 'outline'} size="sm"
                onClick={() => setFilterSeverity(s)}>{s}</Button>
            ))}
          </div>
        )}
        {categories.length > 1 && (
          <div className="flex gap-1">
            {categories.map(c => (
              <Button key={c} variant={filterCategory === c ? 'default' : 'outline'} size="sm"
                onClick={() => setFilterCategory(filterCategory === c ? null : c)}>{c}</Button>
            ))}
          </div>
        )}
      </div>

      {unresolved.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">
            Unresolved ({unresolved.length})
          </h2>
          <div className="space-y-2">
            {unresolved.map((finding) => (
              <FindingCard key={finding.id} finding={finding} onResolve={(id) => {
                onSend({ type: 'reviewFindings:resolve', findingId: id, resolvedBy: 'user' });
              }} />
            ))}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowResolved(!showResolved)}
            className="text-muted-foreground mb-2">
            {showResolved ? '▾' : '▸'} Resolved ({resolved.length})
          </Button>
          {showResolved && (
            <div className="space-y-2">
              {resolved.map((finding) => (
                <FindingCard key={finding.id} finding={finding} dimmed />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding, dimmed, onResolve }: {
  finding: ReviewFinding;
  dimmed?: boolean;
  onResolve?: (id: string) => void;
}) {
  return (
    <div className={`rounded-lg border border-border bg-card p-3 ${dimmed ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 mb-1">
        <Badge variant={REVIEW_SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
        <Badge variant="secondary">{finding.category}</Badge>
        <span className="text-xs text-muted-foreground font-mono">
          {finding.file_path}{finding.line_start ? `:${finding.line_start}` : ''}
          {finding.line_end && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ''}
        </span>
        <div className="flex-1" />
        {onResolve && !dimmed && (
          <Button variant="ghost" size="sm" className="text-[10px] h-6"
            onClick={() => onResolve(finding.id)}>Resolve</Button>
        )}
      </div>
      <p className={`text-sm text-foreground ${dimmed ? 'line-through' : ''}`}>{finding.description}</p>
      {finding.suggestion && !dimmed && (
        <p className="text-xs text-primary mt-1">{finding.suggestion}</p>
      )}
    </div>
  );
}
