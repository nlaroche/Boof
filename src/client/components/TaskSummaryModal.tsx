import type { Command } from '../lib/types';
import { timeAgo, formatDuration } from '../lib/format';
import { DrawerModal } from './DrawerModal';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { StatusBadge } from './StatusBadge';

interface Props {
  command: Command;
  onClose: () => void;
  onViewRaw: () => void;
}

export function TaskSummaryModal({ command, onClose, onViewRaw }: Props) {
  const duration = command.completed_at && command.started_at
    ? new Date(command.completed_at).getTime() - new Date(command.started_at).getTime()
    : null;

  const filesChanged = command.files_changed || [];

  return (
    <DrawerModal open title="Task Summary" onClose={onClose} snapPoints={[0.85, 1]}>
      {/* Status header */}
      <div className="flex items-center gap-3 mb-4">
        <StatusBadge status={command.status} />
        {duration !== null && (
          <span className="text-xs text-muted-foreground">{formatDuration(duration)}</span>
        )}
        <span className="text-xs text-muted-foreground ml-auto">{timeAgo(command.started_at)}</span>
      </div>

      {/* Prompt */}
      <Card className="p-3 mb-3">
        <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Prompt</div>
        <p className="text-sm text-foreground break-words">{command.prompt}</p>
      </Card>

      {/* Summary */}
      {command.summary && (
        <Card className="p-3 mb-3">
          <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">Summary</div>
          <div className="text-sm text-foreground whitespace-pre-wrap break-words">
            {command.summary}
          </div>
        </Card>
      )}

      {/* Files Changed */}
      {filesChanged.length > 0 && (
        <Card className="p-3 mb-3">
          <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">
            Files Changed ({filesChanged.length})
          </div>
          <div className="space-y-1">
            {filesChanged.map((f, i) => (
              <div key={i} className="text-xs text-foreground font-mono truncate">{f}</div>
            ))}
          </div>
        </Card>
      )}

      {/* Raw Output */}
      {command.raw_output && (
        <details className="mb-3">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
            Raw Output
          </summary>
          <Card className="p-3 mt-2">
            <pre className="text-[11px] text-foreground font-mono whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
              {command.raw_output}
            </pre>
          </Card>
        </details>
      )}

      {/* View raw button */}
      <Button
        variant="secondary"
        onClick={onViewRaw}
        className="w-full"
      >
        View Full Output
      </Button>
    </DrawerModal>
  );
}
