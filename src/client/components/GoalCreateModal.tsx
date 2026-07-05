import { useState, useEffect } from 'react';
import type { WSClientMessage, Goal } from '../lib/types';
import { useStore } from '../stores/store';
import { cn } from '@/lib/utils';
import { DrawerModal } from './DrawerModal';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card } from './ui/card';

interface Props {
  onSend: (msg: WSClientMessage) => void;
  onClose: () => void;
  editGoal?: Goal | null;
}

export function GoalCreateModal({ onSend, onClose, editGoal }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [search, setSearch] = useState('');
  const repos = useStore((s) => s.repos);

  const isEdit = !!editGoal;

  useEffect(() => {
    if (editGoal) {
      setName(editGoal.name);
      setDescription(editGoal.description || '');
      setRepoId(editGoal.repo_id || '');
      setMergeTarget(editGoal.merge_target || '');
    } else {
      setName('');
      setDescription('');
      setRepoId('');
      setMergeTarget('');
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
      repoId: repoId || undefined,
      mergeTarget: mergeTarget.trim() || undefined,
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
        merge_target: mergeTarget.trim() || null,
      } as any,
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
      <div className="space-y-4">
        <div>
          <Label className="mb-1.5">Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Improve Boof UI polish"
          />
        </div>

        <div>
          <Label className="mb-1.5">Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should the agent work towards?"
            rows={3}
          />
        </div>

        <div>
          <Label className="mb-1.5">Merge target branch (optional)</Label>
          <Input
            value={mergeTarget}
            onChange={(e) => setMergeTarget(e.target.value)}
            placeholder="develop"
            className="font-mono"
          />
          <p className="text-[10px] text-muted-foreground mt-1">Branch to merge into when all tasks complete. Defaults to develop.</p>
        </div>

        <div>
          <Label className="mb-1.5">Repo (optional)</Label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repos..."
            className="mb-2"
          />

          <div className="max-h-40 overflow-y-auto space-y-1.5">
            {filteredRepos.length === 0 ? (
              <p className="text-center text-muted-foreground text-sm py-2">
                {repos.length === 0 ? 'No repos available' : 'No matching repos'}
              </p>
            ) : (
              filteredRepos.map((repo) => (
                <Card
                  key={repo.path}
                  onClick={() => handleSelectRepo(repo.path)}
                  className={cn(
                    'p-2.5 cursor-pointer transition-colors flex items-center justify-between',
                    repoId === repo.path
                      ? 'border-primary/40 bg-primary/10'
                      : 'hover:bg-secondary'
                  )}
                >
                  <span className="text-sm text-foreground truncate">{repo.name}</span>
                  {repo.hasGit && (
                    <Badge variant="secondary" className="ml-2 shrink-0">git</Badge>
                  )}
                </Card>
              ))
            )}
          </div>
        </div>

        {selectedRepo && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Selected:</span>
            <Badge variant="default">{selectedRepo.name}</Badge>
            <Button variant="ghost" size="sm" onClick={handleClearRepo} className="text-xs text-destructive hover:text-destructive h-6 px-2">
              Clear
            </Button>
          </div>
        )}

        <Button
          onClick={isEdit ? handleUpdate : handleCreate}
          disabled={!name.trim()}
          className="w-full"
        >
          {isEdit ? 'Save Changes' : 'Create Goal'}
        </Button>
      </div>
    </DrawerModal>
  );
}
