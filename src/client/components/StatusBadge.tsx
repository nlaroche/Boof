import { Badge } from './ui/badge';

const statusConfig: Record<string, { variant: 'success' | 'warning' | 'destructive' | 'muted' | 'default'; label: string }> = {
  done: { variant: 'success', label: 'Done' },
  running: { variant: 'warning', label: 'Running' },
  error: { variant: 'destructive', label: 'Error' },
  idle: { variant: 'success', label: 'Idle' },
  dead: { variant: 'muted', label: 'Offline' },
  active: { variant: 'success', label: 'Active' },
  paused: { variant: 'warning', label: 'Paused' },
  completed: { variant: 'muted', label: 'Done' },
  pending: { variant: 'warning', label: 'Pending' },
  approved: { variant: 'success', label: 'Approved' },
  rejected: { variant: 'destructive', label: 'Rejected' },
};

export function StatusBadge({ status, className = '' }: { status: string; className?: string }) {
  const config = statusConfig[status] || statusConfig.idle;
  return <Badge variant={config.variant} className={className}>{config.label}</Badge>;
}
