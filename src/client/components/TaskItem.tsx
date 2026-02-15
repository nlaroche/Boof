import type { Task } from '../lib/types';

interface Props {
  task: Task;
  subtaskCount?: number;
  doneSubtasks?: number;
  onToggle: (taskId: string, currentStatus: string) => void;
}

export function TaskItem({ task, subtaskCount = 0, doneSubtasks = 0, onToggle }: Props) {
  const isDone = task.status === 'done';

  return (
    <button
      onClick={() => onToggle(task.id, task.status)}
      className="flex items-center gap-3 w-full p-3 text-left active:bg-[#1e1e2e] transition-colors rounded-lg"
    >
      <span
        className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          isDone ? 'border-[#22c55e] bg-[#22c55e]' : 'border-[#6b6b80]'
        }`}
      >
        {isDone && (
          <svg viewBox="0 0 24 24" className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={3}>
            <path d="M5 13l4 4L19 7" />
          </svg>
        )}
      </span>
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${isDone ? 'line-through text-[#6b6b80]' : 'text-[#e2e2ef]'}`}>
          {task.title}
        </span>
        {subtaskCount > 0 && (
          <span className="text-xs text-[#6b6b80] ml-2">
            {doneSubtasks}/{subtaskCount}
          </span>
        )}
      </div>
    </button>
  );
}
