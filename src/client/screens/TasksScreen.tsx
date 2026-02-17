import { useState, useMemo } from 'react';
import { useStore } from '../stores/store';
import { FolderList } from '../components/FolderList';
import { TaskItem } from '../components/TaskItem';
import type { WSClientMessage, Folder } from '../lib/types';
import { Input, Button, EmptyState } from '../components/ui';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function TasksScreen({ onSend }: Props) {
  const folders = useStore((s) => s.folders);
  const tasks = useStore((s) => s.tasks);
  const goals = useStore((s) => s.goals);
  const selectedFolderId = useStore((s) => s.ui.selectedFolderId);
  const setSelectedFolderId = useStore((s) => s.setSelectedFolderId);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [filterGoalId, setFilterGoalId] = useState<string | null>(null);

  // Build goal lookup map
  const goalMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const g of goals) map[g.id] = g.name;
    return map;
  }, [goals]);

  const activeGoals = goals.filter((g) => g.status === 'active');

  const folderTasks = selectedFolderId
    ? tasks.filter((t) => {
        if (t.folder_id !== selectedFolderId || t.parent_task_id) return false;
        if (filterGoalId && t.goal_id !== filterGoalId) return false;
        return true;
      })
    : [];

  const handleToggle = (taskId: string, currentStatus: string) => {
    onSend({
      type: 'task:update',
      taskId,
      fields: { status: currentStatus === 'done' ? 'todo' : 'done' },
    });
  };

  const handleAddTask = () => {
    if (!newTaskTitle.trim() || !selectedFolderId) return;
    onSend({
      type: 'task:create',
      folderId: selectedFolderId,
      title: newTaskTitle.trim(),
      goalId: filterGoalId || undefined,
    });
    setNewTaskTitle('');
  };

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) {
      setShowNewFolder(true);
      return;
    }
    onSend({ type: 'folder:create', name: newFolderName.trim() });
    setNewFolderName('');
    setShowNewFolder(false);
  };

  const handleUpdateFolder = (folderId: string, fields: Partial<Folder>) => {
    onSend({ type: 'folder:update', folderId, fields });
  };

  const handleDeleteFolder = (folderId: string) => {
    onSend({ type: 'folder:delete', folderId });
  };

  const handleDeleteTask = (taskId: string) => {
    onSend({ type: 'task:delete', taskId });
  };

  return (
    <div className="min-h-full pb-20">
      <div className="p-4">
        <h1 className="text-xl font-bold text-[#e2e2ef]">Tasks</h1>
      </div>

      {showNewFolder && (
        <div className="px-3 mb-3 flex gap-2">
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="Folder name..."
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            className="flex-1"
          />
          <Button onClick={handleCreateFolder} className="px-4">
            Add
          </Button>
        </div>
      )}

      <FolderList
        folders={folders}
        tasks={tasks}
        selectedFolderId={selectedFolderId}
        onSelectFolder={setSelectedFolderId}
        onCreateFolder={() => setShowNewFolder(true)}
        onUpdateFolder={handleUpdateFolder}
        onDeleteFolder={handleDeleteFolder}
      />

      {selectedFolderId && (
        <div className="p-3">
          {/* Goal filter pills */}
          {activeGoals.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-2 mb-2 scrollbar-hide">
              <button
                onClick={() => setFilterGoalId(null)}
                className={`px-3 py-1 rounded-full text-xs whitespace-nowrap shrink-0 ${
                  !filterGoalId
                    ? 'bg-[#7c5bf5]/20 text-[#7c5bf5] border border-[#7c5bf5]/40'
                    : 'bg-[#1e1e2e] text-[#6b6b80] border border-[#1e1e2e]'
                }`}
              >
                All
              </button>
              {activeGoals.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setFilterGoalId(filterGoalId === g.id ? null : g.id)}
                  className={`px-3 py-1 rounded-full text-xs whitespace-nowrap shrink-0 ${
                    filterGoalId === g.id
                      ? 'bg-[#7c5bf5]/20 text-[#7c5bf5] border border-[#7c5bf5]/40'
                      : 'bg-[#1e1e2e] text-[#6b6b80] border border-[#1e1e2e]'
                  }`}
                >
                  {g.name}
                </button>
              ))}
            </div>
          )}

          <div className="bg-[#14141f] rounded-xl border border-[#1e1e2e] overflow-hidden">
            {folderTasks.length === 0 ? (
              <EmptyState icon="📋" title="No tasks yet" description="Add a task below to get started" />
            ) : (
              folderTasks.map((task) => {
                const subtasks = tasks.filter((t) => t.parent_task_id === task.id);
                const doneSubtasks = subtasks.filter((t) => t.status === 'done').length;
                return (
                  <TaskItem
                    key={task.id}
                    task={task}
                    subtaskCount={subtasks.length}
                    doneSubtasks={doneSubtasks}
                    goalName={task.goal_id ? goalMap[task.goal_id] : undefined}
                    onToggle={handleToggle}
                    onDelete={handleDeleteTask}
                  />
                );
              })
            )}

            <div className="flex gap-2 p-3 border-t border-[#1e1e2e]">
              <Input
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="Add a task..."
                onKeyDown={(e) => e.key === 'Enter' && handleAddTask()}
                className="flex-1"
              />
              <Button
                onClick={handleAddTask}
                disabled={!newTaskTitle.trim()}
                className="px-3"
              >
                +
              </Button>
            </div>
          </div>
        </div>
      )}
      <div className="fixed bottom-2 left-0 right-0 text-center">
        <span className="text-xs text-[#4a4a5a]">Boof v1.0</span>
      </div>
    </div>
  );
}
