import { useState } from 'react';
import type { Folder, Task } from '../lib/types';
import { cn } from '@/lib/utils';
import { DrawerModal } from './DrawerModal';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { Card } from './ui/card';

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
  const [deleteFolder, setDeleteFolder] = useState<Folder | null>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState('');
  const [longPressTriggered, setLongPressTriggered] = useState(false);

  const handleLongPress = (folder: Folder) => {
    setLongPressTriggered(true);
    setDeleteFolder(folder);
    setTimeout(() => setLongPressTriggered(false), 100);
  };

  const handleEditFolder = (folder: Folder) => {
    setDeleteFolder(null);
    setEditingFolder(folder);
    setEditName(folder.name);
    setEditIcon(folder.icon);
  };

  const handleConfirmDelete = () => {
    if (deleteFolder) {
      onDeleteFolder(deleteFolder.id);
      setDeleteFolder(null);
    }
  };

  const handleTouchStart = (folder: Folder, e: React.TouchEvent) => {
    setLongPressTriggered(false);
    const timer = setTimeout(() => {
      handleLongPress(folder);
    }, 500);
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
        <h2 className="text-lg font-semibold text-foreground">Folders</h2>
        <Button
          variant="secondary"
          size="icon"
          onClick={onCreateFolder}
          className="min-w-[44px] min-h-[44px] text-primary text-xl font-bold"
        >
          +
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {folders.map((folder) => {
          const folderTasks = tasks.filter((t) => t.folder_id === folder.id);
          const done = folderTasks.filter((t) => t.status === 'done').length;
          const isSelected = selectedFolderId === folder.id;

          return (
            <Card
              key={folder.id}
              onClick={() => handleClick(folder.id)}
              onTouchStart={(e: any) => handleTouchStart(folder, e)}
              onTouchEnd={handleTouchEnd as any}
              onMouseDown={(e: any) => handleMouseDown(folder, e)}
              onMouseUp={handleMouseUp as any}
              onMouseLeave={handleMouseUp as any}
              className={cn(
                'p-3 text-left transition-all duration-200 cursor-pointer relative',
                isSelected
                  ? 'border-primary bg-secondary shadow-lg shadow-primary/10'
                  : 'hover:border-muted-foreground/30 active:bg-secondary'
              )}
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteFolder(folder);
                }}
                className="absolute top-1 right-1 w-7 h-7 p-0 text-sm opacity-60 hover:opacity-100"
              >
                &#9881;
              </Button>
              <div className="text-lg mb-1">{folder.icon}</div>
              <div className="text-sm font-medium text-foreground truncate">{folder.name}</div>
              <div className="text-xs text-muted-foreground">
                {done}/{folderTasks.length}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Edit Modal */}
      {editingFolder && (
        <DrawerModal open title="Edit Folder" onClose={() => setEditingFolder(null)}>
          <div className="space-y-4">
            <div>
              <Label className="mb-1.5">Folder Name</Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Folder name"
              />
            </div>
            <div>
              <Label className="mb-1.5">Icon</Label>
              <div className="flex flex-wrap gap-2">
                {FOLDER_ICONS.map((icon) => (
                  <Button
                    key={icon}
                    variant={editIcon === icon ? 'default' : 'secondary'}
                    size="icon"
                    onClick={() => setEditIcon(icon)}
                    className="w-10 h-10 text-xl"
                  >
                    {icon}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditingFolder(null)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={handleSaveEdit} className="flex-1">
                Save
              </Button>
            </div>
          </div>
        </DrawerModal>
      )}

      {/* Delete Confirmation Modal */}
      {deleteFolder && (
        <DrawerModal open title="Folder Options" onClose={() => setDeleteFolder(null)}>
          <p className="text-sm text-muted-foreground mb-4">
            Delete "{deleteFolder.name}" and all its tasks? This cannot be undone.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setDeleteFolder(null)} className="flex-1">
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => { handleEditFolder(deleteFolder); }} className="flex-1">
              Edit
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} className="flex-1">
              Delete
            </Button>
          </div>
        </DrawerModal>
      )}
    </div>
  );
}
