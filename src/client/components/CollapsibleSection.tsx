import { useState } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({ title, count, defaultOpen = false, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left active:bg-card"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</span>
          {count !== undefined && count > 0 && (
            <span className="text-[10px] text-muted-foreground bg-secondary rounded-full px-1.5 py-0.5">{count}</span>
          )}
        </div>
        <span className={cn('text-[10px] text-muted-foreground transition-transform', open && 'rotate-180')}>
          &#9660;
        </span>
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}
