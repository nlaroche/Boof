import { useStore } from '../stores/store';
import { Button } from './ui/button';

export function ContextPanel() {
  const contextPanel = useStore((s) => s.ui.contextPanel);
  const closeContextPanel = useStore((s) => s.closeContextPanel);

  if (!contextPanel.open || !contextPanel.content) return null;

  return (
    <div className="w-[360px] border-l border-border bg-background flex flex-col shrink-0 h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-medium text-foreground capitalize">
          {contextPanel.content.type}
        </span>
        <Button variant="ghost" size="sm" onClick={closeContextPanel} className="text-muted-foreground h-6 w-6 p-0">
          x
        </Button>
      </div>

      {/* Panel content — will be populated by specific screens */}
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-sm text-muted-foreground">
          Select an item to view details.
        </p>
      </div>
    </div>
  );
}
