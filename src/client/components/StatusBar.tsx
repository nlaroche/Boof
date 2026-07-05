import { useStore } from '../stores/store';
import { formatCost } from '../lib/format';
import { NotificationToggle } from './NotificationToggle';

interface Props {
  connected: boolean;
}

export function StatusBar({ connected }: Props) {
  const agents = useStore((s) => s.agents);
  const globalStats = useStore((s) => s.globalStats);
  const runningCount = agents.filter((a) => a.status === 'running').length;
  const errorCount = agents.filter((a) => a.status === 'error').length;

  return (
    <div className="h-8 bg-background border-b border-border flex items-center px-4 gap-4 text-xs text-muted-foreground shrink-0">
      {/* Connection status */}
      <div className="flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${connected ? 'bg-success' : 'bg-warning animate-shimmer'}`} />
        <span>{connected ? 'Connected' : 'Reconnecting...'}</span>
      </div>

      {/* Agent status */}
      <div className="flex items-center gap-3">
        {runningCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-shimmer" />
            {runningCount} running
          </span>
        )}
        {errorCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
            {errorCount} error
          </span>
        )}
        {runningCount === 0 && errorCount === 0 && (
          <span>{agents.length} agents idle</span>
        )}
      </div>

      {/* Cost today */}
      {globalStats && globalStats.costTodayUsd > 0 && (
        <span className="font-mono" title="Estimated spend today">
          {formatCost(globalStats.costTodayUsd)} today
        </span>
      )}

      <div className="flex-1" />

      <NotificationToggle className="mr-1" />

      {/* Keyboard shortcut hint */}
      <span className="text-muted-foreground/50 hidden xl:inline">
        <kbd className="font-mono text-[10px] bg-secondary px-1 py-0.5 rounded">Ctrl+K</kbd> Command palette
      </span>
    </div>
  );
}
