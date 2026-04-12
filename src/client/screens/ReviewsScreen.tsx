import { useState } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/EmptyState';
import { REVIEW_SEVERITY_VARIANT } from '../lib/ui-constants';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function ReviewsScreen({ onSend }: Props) {
  const reviewFindings = useStore((s) => s.reviewFindings);
  const allFindings = Object.values(reviewFindings).flat();
  const [showResolved, setShowResolved] = useState(false);

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

  const unresolved = allFindings.filter((f) => !f.resolved);
  const resolved = allFindings.filter((f) => f.resolved);

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-foreground mb-6">Reviews</h1>

      {unresolved.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">
            Unresolved ({unresolved.length})
          </h2>
          <div className="space-y-2">
            {unresolved.map((finding) => (
              <FindingCard key={finding.id} finding={finding} />
            ))}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowResolved(!showResolved)}
            className="text-muted-foreground mb-2"
          >
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

function FindingCard({ finding, dimmed }: { finding: import('../lib/types').ReviewFinding; dimmed?: boolean }) {
  return (
    <div className={`rounded-lg border border-border bg-card p-3 ${dimmed ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 mb-1">
        <Badge variant={REVIEW_SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
        <Badge variant="secondary">{finding.category}</Badge>
        <span className="text-xs text-muted-foreground font-mono">
          {finding.file_path}{finding.line_start ? `:${finding.line_start}` : ''}
        </span>
      </div>
      <p className={`text-sm text-foreground ${dimmed ? 'line-through' : ''}`}>{finding.description}</p>
      {finding.suggestion && !dimmed && (
        <p className="text-xs text-muted-foreground mt-1">{finding.suggestion}</p>
      )}
    </div>
  );
}
