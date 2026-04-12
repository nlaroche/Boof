import { useState } from 'react';
import { useStore } from '../stores/store';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import type { WSClientMessage, ReviewGuideline } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function GuidelinesManager({ onSend }: Props) {
  const repos = useStore((s) => s.repos);
  const guidelines = useStore((s) => s.guidelines);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const repoGuidelines = selectedRepo ? (guidelines[selectedRepo] || []) : [];
  const proposed = repoGuidelines.filter(g => g.status === 'proposed');
  const approved = repoGuidelines.filter(g => g.status === 'approved');

  const handleScan = () => {
    if (!selectedRepo) return;
    setScanning(true);
    onSend({ type: 'guidelines:scan', repoPath: selectedRepo });
    onSend({ type: 'guidelines:list', repoPath: selectedRepo });
    setTimeout(() => setScanning(false), 2000);
  };

  const handleApprove = (id: string) => {
    onSend({ type: 'guidelines:approve', guidelineId: id });
  };

  const handleReject = (id: string) => {
    onSend({ type: 'guidelines:reject', guidelineId: id });
  };

  const handleApproveAll = () => {
    if (!selectedRepo) return;
    onSend({ type: 'guidelines:approve-all', repoPath: selectedRepo });
  };

  return (
    <div>
      {/* Repo selector */}
      <div className="flex gap-2 mb-4">
        <div className="flex gap-1 flex-wrap flex-1">
          {repos.filter(r => r.hasGit).map(repo => (
            <Button
              key={repo.path}
              variant={selectedRepo === repo.path ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setSelectedRepo(repo.path);
                onSend({ type: 'guidelines:list', repoPath: repo.path });
              }}
            >
              {repo.name}
            </Button>
          ))}
        </div>
        {selectedRepo && (
          <Button size="sm" onClick={handleScan} disabled={scanning}>
            {scanning ? 'Scanning...' : 'Scan'}
          </Button>
        )}
      </div>

      {!selectedRepo && (
        <p className="text-sm text-muted-foreground">Select a repo to manage guidelines.</p>
      )}

      {/* Proposed guidelines */}
      {proposed.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-warning">Proposed ({proposed.length})</span>
            <Button variant="outline" size="sm" onClick={handleApproveAll}>Approve all</Button>
          </div>
          <div className="space-y-2">
            {proposed.map(g => (
              <GuidelineItem key={g.id} guideline={g} onApprove={handleApprove} onReject={handleReject} />
            ))}
          </div>
        </div>
      )}

      {/* Approved guidelines */}
      {approved.length > 0 && (
        <div>
          <span className="text-sm font-semibold text-foreground mb-2 block">Active ({approved.length})</span>
          <div className="space-y-2">
            {approved.map(g => (
              <GuidelineItem key={g.id} guideline={g} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GuidelineItem({ guideline, onApprove, onReject }: {
  guideline: ReviewGuideline;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-foreground">{guideline.name}</span>
          <Badge variant={guideline.status === 'approved' ? 'success' : guideline.status === 'rejected' ? 'destructive' : 'warning'}
            className="text-[10px]">{guideline.status}</Badge>
          <Badge variant="secondary" className="text-[10px]">{guideline.type}</Badge>
          <Badge variant="muted" className="text-[10px]">{guideline.source}</Badge>
          <div className="flex-1" />
          {onApprove && guideline.status === 'proposed' && (
            <div className="flex gap-1">
              <Button variant="default" size="sm" className="h-6 text-[10px]" onClick={() => onApprove(guideline.id)}>Approve</Button>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => onReject?.(guideline.id)}>Reject</Button>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{guideline.description}</p>
        {guideline.source_path && (
          <div className="text-[10px] text-muted-foreground mt-1 font-mono">{guideline.source_path}</div>
        )}
      </CardContent>
    </Card>
  );
}
