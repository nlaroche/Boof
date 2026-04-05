import { Card } from './ui/card';

const defaultActions = [
  { label: 'Continue', icon: '\u25B6', prompt: 'continue where you left off' },
  { label: 'Test', icon: '\uD83E\uDDEA', prompt: 'run the test suite and report results' },
  { label: 'Commit', icon: '\uD83D\uDCDD', prompt: 'commit all changes with a descriptive message and push' },
  { label: 'Explain', icon: '\uD83D\uDD0D', prompt: 'explain what you just did and why' },
  { label: 'Status', icon: '\uD83D\uDCCA', prompt: 'show me a summary of the current state of the project' },
  { label: 'Fix', icon: '\uD83D\uDC1B', prompt: 'look at the last error and fix it' },
  { label: 'Refactor', icon: '\u267B\uFE0F', prompt: 'refactor the last thing you worked on for clarity' },
  { label: 'Plan', icon: '\uD83D\uDCCB', prompt: 'create a plan for what to work on next based on the codebase' },
];

interface Props {
  onAction: (prompt: string) => void;
  disabled?: boolean;
}

export function QuickActions({ onAction, disabled }: Props) {
  return (
    <div className="p-3">
      <h3 className="text-sm font-medium text-muted-foreground mb-2">Quick Actions</h3>
      <div className="grid grid-cols-3 gap-2">
        {defaultActions.map((action) => (
          <Card
            key={action.label}
            className="p-3 text-center cursor-pointer active:bg-secondary transition-colors disabled:opacity-40 min-h-[48px] hover:border-primary/30"
            onClick={() => !disabled && onAction(action.prompt)}
            role="button"
            aria-disabled={disabled}
          >
            <div className="text-lg">{action.icon}</div>
            <div className="text-xs text-foreground mt-1">{action.label}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
