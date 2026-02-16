import type { Command } from '../lib/types';
import { timeAgo, formatDuration } from '../lib/format';
import { DrawerModal } from './DrawerModal';
import { Card, StatusBadge } from './ui';

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
          <span className="text-xs text-[#6b6b80]">{formatDuration(duration)}</span>
        )}
        <span className="text-xs text-[#6b6b80] ml-auto">{timeAgo(command.started_at)}</span>
      </div>

      {/* Prompt */}
      <Card className="p-3 mb-3">
        <div className="text-[10px] text-[#6b6b80] mb-1 uppercase tracking-wider">Prompt</div>
        <p className="text-sm text-[#e2e2ef] break-words">{command.prompt}</p>
      </Card>

      {/* Summary */}
      {command.summary && (
        <Card className="p-3 mb-3">
          <div className="text-[10px] text-[#6b6b80] mb-1 uppercase tracking-wider">Summary</div>
          <div className="text-sm text-[#e2e2ef] whitespace-pre-wrap break-words">
            {command.summary}
          </div>
        </Card>
      )}

      {/* Files Changed */}
      {filesChanged.length > 0 && (
        <Card className="p-3 mb-3">
          <div className="text-[10px] text-[#6b6b80] mb-1 uppercase tracking-wider">
            Files Changed ({filesChanged.length})
          </div>
          <div className="space-y-1">
            {filesChanged.map((f, i) => (
              <div key={i} className="text-xs text-[#e2e2ef] font-mono truncate">{f}</div>
            ))}
          </div>
        </Card>
      )}

      {/* Raw Output */}
      {command.raw_output && (
        <details className="mb-3">
          <summary className="text-xs text-[#6b6b80] cursor-pointer hover:text-[#e2e2ef] transition-colors">
            Raw Output
          </summary>
          <Card className="p-3 mt-2">
            <pre className="text-[11px] text-[#e2e2ef] font-mono whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
              {command.raw_output}
            </pre>
          </Card>
        </details>
      )}

      {/* View raw button */}
      <button
        onClick={onViewRaw}
        className="w-full py-2.5 bg-[#1e1e2e] text-[#e2e2ef] rounded-lg text-sm active:bg-[#2e2e3e] transition-colors"
      >
        View Full Output
      </button>
    </DrawerModal>
  );
}
