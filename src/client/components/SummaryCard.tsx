import type { Command } from '../lib/types';
import { timeAgo, truncate } from '../lib/format';
import { Card } from './ui/card';
import { Badge } from './ui/badge';

const statusVariant: Record<string, 'success' | 'destructive' | 'warning'> = {
  done: 'success',
  error: 'destructive',
  running: 'warning',
};

export function SummaryCard({ command }: { command: Command }) {
  const filesChanged = command.files_changed || [];
  const variant = statusVariant[command.status] || 'warning';

  return (
    <Card className="p-3 mb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">{timeAgo(command.started_at)}</span>
        <Badge variant={variant}>{command.status}</Badge>
      </div>
      <div className="text-xs text-muted-foreground mb-1 font-mono">
        &gt; {truncate(command.prompt, 60)}
      </div>
      {command.summary && (
        <p className="text-sm text-foreground mb-2">{command.summary}</p>
      )}
      {filesChanged.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Changed: {filesChanged.map((f) => f.split('/').pop()).join(', ')}
        </div>
      )}
    </Card>
  );
}
