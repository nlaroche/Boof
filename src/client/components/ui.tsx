import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react';

// Button variants
const buttonVariants = {
  primary: 'bg-[#7c5bf5] text-white active:bg-[#6b4ae4]',
  secondary: 'bg-[#1e1e2e] text-[#e2e2ef] active:bg-[#2e2e3e]',
  danger: 'bg-[#ef4444] text-white active:bg-[#dc2626]',
  ghost: 'bg-transparent text-[#6b6b80] active:bg-[#1e1e2e]',
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof buttonVariants;
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`py-2.5 px-4 rounded-lg text-sm font-medium transition-all duration-200 disabled:opacity-40 disabled:scale-100 active:scale-95 hover:brightness-110 ${buttonVariants[variant]} ${className}`}
      {...props}
    />
  );
}

// Input
export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] focus:ring-2 focus:ring-[#7c5bf5]/25 transition-all duration-200 ${className}`}
      {...props}
    />
  );
}

// Textarea
export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] focus:ring-2 focus:ring-[#7c5bf5]/25 resize-none transition-all duration-200 ${className}`}
      {...props}
    />
  );
}

// Card
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-[#14141f] border border-[#1e1e2e] rounded-xl ${className}`}>
      {children}
    </div>
  );
}

// StatusBadge
const statusStyles: Record<string, { bg: string; text: string; label: string }> = {
  // Command/task statuses
  done: { bg: 'bg-[#22c55e]/20', text: 'text-[#22c55e]', label: 'Done' },
  running: { bg: 'bg-[#f59e0b]/20', text: 'text-[#f59e0b]', label: 'Running' },
  error: { bg: 'bg-[#ef4444]/20', text: 'text-[#ef4444]', label: 'Error' },
  // Agent statuses
  idle: { bg: 'bg-[#22c55e]/20', text: 'text-[#22c55e]', label: 'Idle' },
  dead: { bg: 'bg-[#6b6b80]/20', text: 'text-[#6b6b80]', label: 'Offline' },
  // Goal statuses
  active: { bg: 'bg-[#22c55e]/20', text: 'text-[#22c55e]', label: 'Active' },
  paused: { bg: 'bg-[#f59e0b]/20', text: 'text-[#f59e0b]', label: 'Paused' },
  completed: { bg: 'bg-[#6b6b80]/20', text: 'text-[#6b6b80]', label: 'Done' },
  // Proposal statuses
  pending: { bg: 'bg-[#f59e0b]/20', text: 'text-[#f59e0b]', label: 'Pending' },
  approved: { bg: 'bg-[#22c55e]/20', text: 'text-[#22c55e]', label: 'Approved' },
  rejected: { bg: 'bg-[#ef4444]/20', text: 'text-[#ef4444]', label: 'Rejected' },
};

export function StatusBadge({ status, className = '' }: { status: string; className?: string }) {
  const style = statusStyles[status] || statusStyles.idle;
  return (
    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${style.bg} ${style.text} ${className}`}>
      {style.label}
    </span>
  );
}

// Label
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <label className={`text-xs text-[#6b6b80] mb-1 block ${className}`}>
      {children}
    </label>
  );
}

// Skeleton components for loading states
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-[#14141f] border border-[#1e1e2e] rounded-xl p-4 ${className}`}>
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonList({ count = 3, className = '' }: { count?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

// EmptyState component for consistent empty states across screens
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
      <p className="text-sm text-[#6b6b80] mb-2">{title}</p>
      {description && <p className="text-xs text-[#4a4a5a] mb-4 max-w-xs">{description}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
