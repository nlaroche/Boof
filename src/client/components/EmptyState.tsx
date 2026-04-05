import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
      {icon && <div className="text-3xl mb-3 opacity-50">{icon}</div>}
      <p className="text-sm text-muted-foreground mb-2">{title}</p>
      {description && <p className="text-xs text-muted-foreground/60 mb-4 max-w-xs">{description}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
