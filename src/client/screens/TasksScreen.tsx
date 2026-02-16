import { useState } from 'react';
import { useStore } from '../stores/store';
import { FolderList } from '../components/FolderList';
import { TaskItem } from '../components/TaskItem';
import type { WSClientMessage, Folder } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function TasksScreen({ onSend }: Props) {
  const folders = useStore((s) => s.folders);
  const tasks = useStore((s) => s.tasks);
  const selectedFolderId = useStore((s) => s.ui.selectedFolderId);
  const setSelectedFolderId = useStore((s) => s.setSelectedFolderId);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const folderTasks = selectedFolderId
    ? tasks.filter((t) => t.folder_id === selectedFolderId && !t.parent_task_id)
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
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="Folder name..."
            className="flex-1 bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            autoFocus
          />
          <button
            onClick={handleCreateFolder}
            className="bg-[#7c5bf5] text-white px-4 py-2 rounded-lg text-sm"
          >
            Add
          </button>
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
          <div className="bg-[#14141f] rounded-xl border border-[#1e1e2e] overflow-hidden">
            {folderTasks.length === 0 ? (
              <div className="p-4 text-center text-[#6b6b80] text-sm">No tasks yet</div>
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
                    onToggle={handleToggle}
                    onDelete={handleDeleteTask}
                  />
                );
              })
            )}

            <div className="flex gap-2 p-3 border-t border-[#1e1e2e]">
              <input
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="Add a task..."
                className="flex-1 bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
                onKeyDown={(e) => e.key === 'Enter' && handleAddTask()}
              />
              <button
                onClick={handleAddTask}
                disabled={!newTaskTitle.trim()}
                className="bg-[#7c5bf5] text-white px-3 py-2 rounded-lg text-sm disabled:opacity-40"
              >
                +
              </button>
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
