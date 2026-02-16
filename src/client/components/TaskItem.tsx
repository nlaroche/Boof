import type { Task } from '../lib/types';

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
    <div className="flex items-center gap-2 w-full p-3 text-left hover:bg-[#1a1a28] active:bg-[#1e1e2e] transition-all duration-200 rounded-lg group">
      <button
        onClick={handleToggle}
        className="flex-shrink-0 transition-all duration-200 active:scale-90 focus:outline-none focus:ring-2 focus:ring-[#7c5bf5]/50 rounded-full"
      >
        <span
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
            isDone ? 'border-[#22c55e] bg-[#22c55e] scale-110' : 'border-[#6b6b80] hover:border-[#8b8b9a]'
          }`}
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
          <span className={`text-sm ${isDone ? 'line-through text-[#6b6b80]' : 'text-[#e2e2ef]'}`}>
            {task.title}
          </span>
          {subtaskCount > 0 && (
            <span className="text-xs text-[#6b6b80]">
              {doneSubtasks}/{subtaskCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {goalName && (
            <span className="text-[10px] text-[#7c5bf5] bg-[#7c5bf5]/10 px-1.5 py-0.5 rounded">
              {goalName}
            </span>
          )}
          {task.agent_generated === 1 && (
            <span className="text-[10px] text-[#6b6b80] bg-[#6b6b80]/10 px-1.5 py-0.5 rounded">
              bot
            </span>
          )}
        </div>
      </div>
      <button
        onClick={handleDelete}
        className="flex-shrink-0 p-2 text-[#6b6b80] hover:text-[#ef4444] active:text-[#ef4444] transition-colors rounded-lg focus:outline-none focus:ring-2 focus:ring-[#ef4444]/30"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}
