import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface MasterDetailProps {
  master: ReactNode;
  detail: ReactNode | null;
  masterWidth?: string;
}

export function MasterDetail({ master, detail, masterWidth = 'w-80' }: MasterDetailProps) {
  return (
    <div className="flex h-full overflow-hidden bg-background">
      <div className={cn(
        detail ? masterWidth : 'flex-1',
        'border-r border-border overflow-y-auto shrink-0'
      )}>
        {master}
      </div>
      {detail && (
        <div className="flex-1 overflow-y-auto bg-background">
          {detail}
        </div>
      )}
    </div>
  );
}
