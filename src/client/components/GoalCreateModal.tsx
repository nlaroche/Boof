import { useState, useEffect } from 'react';
import { Drawer } from 'vaul';
import type { WSClientMessage, Goal } from '../lib/types';
import { useStore } from '../stores/store';

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
    <Drawer.Root open onOpenChange={(open) => !open && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50" />
        <Drawer.Content className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl p-4 pb-8 outline-none">
          {/* Drag handle */}
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-[#6b6b80]/40" />

          <div className="flex items-center justify-between mb-4">
            <Drawer.Title className="text-lg font-bold text-[#e2e2ef]">
              {isEdit ? 'Edit Goal' : 'New Goal'}
            </Drawer.Title>
            <button onClick={onClose} className="text-[#6b6b80] text-xl px-2">x</button>
          </div>

          <label className="text-xs text-[#6b6b80] mb-1 block">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Improve Boof UI polish"
            autoFocus
            className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-4 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
          />

          <label className="text-xs text-[#6b6b80] mb-1 block">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should the agent work towards?"
            rows={3}
            className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-4 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] resize-none"
          />

          <label className="text-xs text-[#6b6b80] mb-1 block">Repo (optional)</label>
          <div className="mb-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repos..."
              className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
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

          <button
            onClick={isEdit ? handleUpdate : handleCreate}
            disabled={!name.trim()}
            className="w-full bg-[#7c5bf5] text-white py-2.5 rounded-lg text-sm font-medium active:bg-[#6b4ae4] transition-colors disabled:opacity-40"
          >
            {isEdit ? 'Save Changes' : 'Create Goal'}
          </button>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
