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
  /** Pre-scope a newly created goal to this project (used from ProjectsScreen). */
  defaultProjectId?: string;
}

export function GoalCreateModal({ onSend, onClose, editGoal, defaultProjectId }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [projectId, setProjectId] = useState('');
  const [budgetCap, setBudgetCap] = useState('');
  const [priority, setPriority] = useState(0);
  const [assignAgentId, setAssignAgentId] = useState('');
  const [search, setSearch] = useState('');
  const repos = useStore((s) => s.repos);
  const projects = useStore((s) => s.projects);
  const agents = useStore((s) => s.agents);

  const isEdit = !!editGoal;

  useEffect(() => {
    if (editGoal) {
      setName(editGoal.name);
      setDescription(editGoal.description || '');
      setRepoId(editGoal.repo_id || '');
      setMergeTarget(editGoal.merge_target || '');
      setProjectId(editGoal.project_id || '');
      setBudgetCap(editGoal.budget_cap_usd != null ? String(editGoal.budget_cap_usd) : '');
      setPriority(editGoal.priority || 0);
      setAssignAgentId('');
    } else {
      setName('');
      setDescription('');
      setRepoId('');
      setMergeTarget('');
      setProjectId(defaultProjectId || '');
      setBudgetCap('');
      setPriority(0);
      setAssignAgentId('');
    }
  }, [editGoal, defaultProjectId]);

  const filteredRepos = search.trim()
    ? repos.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
    : repos;

  const selectedRepo = repos.find((r) => r.path === repoId);

  const budgetNum = budgetCap.trim() ? parseFloat(budgetCap) : null;

  const handleCreate = () => {
    if (!name.trim()) return;
    onSend({
      type: 'goal:create',
      name: name.trim(),
      description: description.trim(),
      repoId: repoId || undefined,
      projectId: projectId || undefined,
      mergeTarget: mergeTarget.trim() || undefined,
      budgetCapUsd: budgetNum != null && !Number.isNaN(budgetNum) ? budgetNum : undefined,
      priority: priority > 0 ? priority : undefined,
      assignAgentId: assignAgentId || undefined,
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
        project_id: projectId || null,
        merge_target: mergeTarget.trim() || null,
        budget_cap_usd: budgetNum != null && !Number.isNaN(budgetNum) ? budgetNum : null,
        priority,
      } as any,
    });
    // Assigning an agent uses the autopilot message (not a goal field).
    if (assignAgentId) {
      const a = agents.find((ag) => ag.id === assignAgentId);
      onSend({ type: 'agent:autopilot', agentId: assignAgentId, autopilot: true, interval: a?.autopilot_interval || 600, goalId: editGoal.id });
    }
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

        {projects.length > 0 && (
          <div>
            <Label className="mb-1.5">Project (optional)</Label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex gap-3">
          <div className="flex-1">
            <Label className="mb-1.5">Budget cap (USD, optional)</Label>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.5"
              value={budgetCap}
              onChange={(e) => setBudgetCap(e.target.value)}
              placeholder="e.g. 5"
              className="font-mono"
            />
          </div>
        </div>

        <div>
          <Label className="mb-1.5">Priority</Label>
          <div className="flex items-center gap-1.5">
            {[1, 2, 3, 4, 5].map((p) => (
              <Button
                key={p}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPriority(p === priority ? 0 : p)}
                className={cn(
                  'w-8 h-8 p-0 rounded text-xs font-bold',
                  priority === p ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'border border-input'
                )}
              >
                {p}
              </Button>
            ))}
            {priority > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPriority(0)} className="text-[10px] text-muted-foreground hover:text-destructive h-8 px-2">
                clear
              </Button>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">5 = highest. Higher-priority goals are scheduled first.</p>
        </div>

        {agents.length > 0 && (
          <div>
            <Label className="mb-1.5">Assign agent now (optional)</Label>
            <select
              value={assignAgentId}
              onChange={(e) => setAssignAgentId(e.target.value)}
              className="w-full bg-background border border-input rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring"
            >
              <option value="">Don't assign</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.status})</option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground mt-1">Enables the agent's autopilot pinned to this goal.</p>
          </div>
        )}

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
