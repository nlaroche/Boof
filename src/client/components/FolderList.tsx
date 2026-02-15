import type { Folder, Task } from '../lib/types';

interface Props {
  folders: Folder[];
  tasks: Task[];
  selectedFolderId: string | null;
  onSelectFolder: (id: string) => void;
  onCreateFolder: () => void;
}

export function FolderList({ folders, tasks, selectedFolderId, onSelectFolder, onCreateFolder }: Props) {
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
              onClick={() => onSelectFolder(folder.id)}
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
    </div>
  );
}
