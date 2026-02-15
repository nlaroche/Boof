import type { Command } from '../lib/types';
import { timeAgo, truncate } from '../lib/format';

export function SummaryCard({ command }: { command: Command }) {
  const filesChanged = command.files_changed || [];

  return (
    <div className="bg-[#14141f] border border-[#1e1e2e] rounded-xl p-3 mb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-[#6b6b80]">{timeAgo(command.started_at)}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          command.status === 'done' ? 'bg-[#22c55e]/20 text-[#22c55e]' :
          command.status === 'error' ? 'bg-[#ef4444]/20 text-[#ef4444]' :
          'bg-[#f59e0b]/20 text-[#f59e0b]'
        }`}>
          {command.status}
        </span>
      </div>
      <div className="text-xs text-[#6b6b80] mb-1 font-mono">
        &gt; {truncate(command.prompt, 60)}
      </div>
      {command.summary && (
        <p className="text-sm text-[#e2e2ef] mb-2">{command.summary}</p>
      )}
      {filesChanged.length > 0 && (
        <div className="text-xs text-[#6b6b80]">
          Changed: {filesChanged.map((f) => f.split('/').pop()).join(', ')}
        </div>
      )}
    </div>
  );
}
