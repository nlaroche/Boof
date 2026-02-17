import { useState, useEffect } from 'react';
import type { WSClientMessage, Goal } from '../lib/types';
import { useStore } from '../stores/store';
import { DrawerModal } from './DrawerModal';
import { Label, Input, Textarea, Button } from './ui';

interface Props {
  onSend: (msg: WSClientMessage) => void;
  onClose: () => void;
  editGoal?: Goal | null;
}

export function GoalCreateModal({ onSend, onClose, editGoal }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState('');
  const [search, setSearch] = useState('');
  const repos = useStore((s) => s.repos);

  const isEdit = !!editGoal;

  useEffect(() => {
    if (editGoal) {
      setName(editGoal.name);
      setDescription(editGoal.description || '');
      setRepoId(editGoal.repo_id || '');
    } else {
      setName('');
      setDescription('');
      setRepoId('');
    }
  }, [editGoal]);

  const filteredRepos = search.trim()
    ? repos.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
    : repos;

  const selectedRepo = repos.find((r) => r.path === repoId);

  const handleCreate = () => {
    if (!name.trim()) return;
    onSend({ 
      type: 'goal:create', 
      name: name.trim(), 
      description: description.trim(),
      repoId: repoId || undefined
    });
    onClose();
  };

  const handleUpdate = () => {
    if (!name.trim() || !editGoal) return;
    onSend({
      type: 'goal:update',
      goalId: editGoal.id,
      fields: {
        name: name.trim(),
        description: description.trim(),
        repo_id: repoId || null,
      },
    });
    onClose();
  };

  const handleSelectRepo = (path: string) => {
    setRepoId(path === repoId ? '' : path);
  };

  const handleClearRepo = () => {
    setRepoId('');
  };

  return (
    <DrawerModal open title={isEdit ? 'Edit Goal' : 'New Goal'} onClose={onClose}>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Improve Boof UI polish"
            className="mb-4"
          />

          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should the agent work towards?"
            rows={3}
            className="mb-4"
          />

          <Label>Repo (optional)</Label>
          <div className="mb-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repos..."
              className="mb-2"
            />
          </div>
          
          <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
            {filteredRepos.length === 0 ? (
              <p className="text-center text-[#6b6b80] text-sm py-2">
                {repos.length === 0 ? 'No repos available' : 'No matching repos'}
              </p>
            ) : (
              filteredRepos.map((repo) => (
                <button
                  key={repo.path}
                  onClick={() => handleSelectRepo(repo.path)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-center justify-between ${
                    repoId === repo.path
                      ? 'bg-[#7c5bf5]/20 border border-[#7c5bf5]/40'
                      : 'bg-[#0a0a0f] border border-[#1e1e2e] hover:bg-[#1e1e2e] active:bg-[#1e1e2e]'
                  }`}
                >
                  <span className="text-sm text-[#e2e2ef] truncate">{repo.name}</span>
                  {repo.hasGit && (
                    <span className="text-[10px] text-[#6b6b80] bg-[#1e1e2e] px-1.5 py-0.5 rounded ml-2 shrink-0">
                      git
                    </span>
                  )}
                </button>
              ))
            )}
          </div>

          {selectedRepo && (
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xs text-[#6b6b80]">Selected:</span>
              <span className="text-xs text-[#e2e2ef]">{selectedRepo.name}</span>
              <button
                onClick={handleClearRepo}
                className="text-xs text-[#ef4444] hover:text-[#f87171]"
              >
                Clear
              </button>
            </div>
          )}

          <Button
            onClick={isEdit ? handleUpdate : handleCreate}
            disabled={!name.trim()}
            className="w-full"
          >
            {isEdit ? 'Save Changes' : 'Create Goal'}
          </Button>
    </DrawerModal>
  );
}
