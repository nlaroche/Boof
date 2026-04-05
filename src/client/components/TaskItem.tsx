import type { Task } from '../lib/types';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface Props {
  task: Task;
  subtaskCount?: number;
  doneSubtasks?: number;
  goalName?: string;
  onToggle: (taskId: string, currentStatus: string) => void;
  onDelete: (taskId: string) => void;
}

export function TaskItem({ task, subtaskCount = 0, doneSubtasks = 0, goalName, onToggle, onDelete }: Props) {
  const isDone = task.status === 'done';

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(task.id, task.status);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(task.id);
  };

  return (
    <div className="flex items-center gap-2 w-full p-3 text-left hover:bg-secondary/70 active:bg-secondary transition-all duration-200 rounded-lg group">
      <button
        onClick={handleToggle}
        className="flex-shrink-0 transition-all duration-200 active:scale-90 focus:outline-none focus:ring-2 focus:ring-ring/50 rounded-full"
      >
        <span
          className={cn(
            'w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-200',
            isDone ? 'border-success bg-success scale-110' : 'border-muted-foreground hover:border-muted-foreground/70'
          )}
        >
          {isDone && (
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-white animate-check" fill="none" stroke="currentColor" strokeWidth={3}>
              <path d="M5 13l4 4L19 7" />
            </svg>
          )}
        </span>
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn('text-sm', isDone ? 'line-through text-muted-foreground' : 'text-foreground')}>
            {task.title}
          </span>
          {subtaskCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {doneSubtasks}/{subtaskCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {goalName && (
            <Badge variant="default" className="text-[10px]">{goalName}</Badge>
          )}
          {task.agent_generated === 1 && (
            <Badge variant="muted" className="text-[10px]">bot</Badge>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        className="flex-shrink-0 p-2 h-auto text-muted-foreground hover:text-destructive"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </Button>
    </div>
  );
}
