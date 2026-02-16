import { useState } from 'react';
import type { Folder, Task } from '../lib/types';

interface Props {
  folders: Folder[];
  tasks: Task[];
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
  onCreateFolder: () => void;
  onUpdateFolder: (folderId: string, fields: Partial<Folder>) => void;
  onDeleteFolder: (folderId: string) => void;
}

const FOLDER_ICONS = ['📁', '📂', '📋', '📝', '📌', '📎', '🔖', '🏷️', '💼', '🎯', '⭐', '❤️'];

export function FolderList({
  folders,
  tasks,
  selectedFolderId,
  onSelectFolder,
  onCreateFolder,
  onUpdateFolder,
  onDeleteFolder,
}: Props) {
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState('');
  const [longPressTriggered, setLongPressTriggered] = useState(false);

  const handleLongPress = (folder: Folder) => {
    setLongPressTriggered(true);
    const action = prompt(`${folder.name}\n\nChoose action:\n- Edit (type "edit")\n- Delete (type "delete")`);
    if (action === 'edit') {
      setEditingFolder(folder);
      setEditName(folder.name);
      setEditIcon(folder.icon);
    } else if (action === 'delete') {
      if (confirm(`Delete "${folder.name}" and all its tasks?`)) {
        onDeleteFolder(folder.id);
      }
    }
    // Reset the flag after a short delay to allow the click handler to check it
    setTimeout(() => setLongPressTriggered(false), 100);
  };

  const handleTouchStart = (folder: Folder, e: React.TouchEvent) => {
    setLongPressTriggered(false);
    // Start a timer for long press - but we handle this differently
    // to avoid memory leaks, we'll just set a timeout
    const timer = setTimeout(() => {
      handleLongPress(folder);
    }, 500);
    // Store timer id on the element via dataset (hacky but works)
    (e.currentTarget as HTMLButtonElement).dataset.timerId = String(timer);
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const timerId = (e.currentTarget as HTMLButtonElement).dataset.timerId;
    if (timerId) {
      clearTimeout(Number(timerId));
      delete (e.currentTarget as HTMLButtonElement).dataset.timerId;
    }
  };

  const handleMouseDown = (folder: Folder, e: React.MouseEvent) => {
    setLongPressTriggered(false);
    const timer = setTimeout(() => {
      handleLongPress(folder);
    }, 500);
    (e.currentTarget as HTMLButtonElement).dataset.timerId = String(timer);
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    const timerId = (e.currentTarget as HTMLButtonElement).dataset.timerId;
    if (timerId) {
      clearTimeout(Number(timerId));
      delete (e.currentTarget as HTMLButtonElement).dataset.timerId;
    }
  };

  const handleClick = (folderId: string) => {
    if (longPressTriggered) return;
    onSelectFolder(folderId);
  };

  const handleSaveEdit = () => {
    if (!editingFolder || !editName.trim()) return;
    onUpdateFolder(editingFolder.id, { name: editName.trim(), icon: editIcon || '📁' });
    setEditingFolder(null);
  };

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-[#e2e2ef]">Folders</h2>
        <button
          onClick={onCreateFolder}
          className="min-w-[44px] min-h-[44px] bg-[#1e1e2e] text-[#7c5bf5] rounded-lg flex items-center justify-center active:bg-[#2e2e3e] text-xl font-bold"
        >
          +
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {folders.map((folder) => {
          const folderTasks = tasks.filter((t) => t.folder_id === folder.id);
          const done = folderTasks.filter((t) => t.status === 'done').length;
          const isSelected = selectedFolderId === folder.id;

          return (
            <button
              key={folder.id}
              onClick={() => handleClick(folder.id)}
              onTouchStart={(e) => handleTouchStart(folder, e)}
              onTouchEnd={handleTouchEnd}
              onMouseDown={(e) => handleMouseDown(folder, e)}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              className={`p-3 rounded-xl text-left transition-colors border ${
                isSelected
                  ? 'bg-[#1e1e2e] border-[#7c5bf5]'
                  : 'bg-[#14141f] border-[#1e1e2e] active:bg-[#1e1e2e]'
              }`}
            >
              <div className="text-lg mb-1">{folder.icon}</div>
              <div className="text-sm font-medium text-[#e2e2ef] truncate">{folder.name}</div>
              <div className="text-xs text-[#6b6b80]">
                {done}/{folderTasks.length}
              </div>
            </button>
          );
        })}
      </div>

      {/* Edit Modal */}
      {editingFolder && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#14141f] border border-[#1e1e2e] rounded-xl w-full max-w-sm p-4">
            <h3 className="text-lg font-semibold text-[#e2e2ef] mb-4">Edit Folder</h3>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Folder name"
              className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] mb-3"
              autoFocus
            />
            <div className="mb-4">
              <div className="text-xs text-[#6b6b80] mb-2">Icon</div>
              <div className="flex flex-wrap gap-2">
                {FOLDER_ICONS.map((icon) => (
                  <button
                    key={icon}
                    onClick={() => setEditIcon(icon)}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl ${
                      editIcon === icon ? 'bg-[#7c5bf5]' : 'bg-[#1e1e2e]'
                    }`}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setEditingFolder(null)}
                className="flex-1 bg-[#1e1e2e] text-[#e2e2ef] py-2 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                className="flex-1 bg-[#7c5bf5] text-white py-2 rounded-lg"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
