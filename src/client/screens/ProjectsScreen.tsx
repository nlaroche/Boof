import { useState } from 'react';
import { useStore } from '../stores/store';
import { DrawerModal } from '../components/DrawerModal';
import { cn } from '@/lib/utils';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Separator } from '../components/ui/separator';
import { EmptyState } from '../components/EmptyState';
import { SkillsList } from '../components/SkillsList';
import { CollapsibleSection } from '../components/CollapsibleSection';
import type { WSClientMessage, Project } from '../lib/types';

const EMPTY_REPOS: string[] = [];

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'muted'> = {
  active: 'success',
  paused: 'warning',
  archived: 'muted',
};

function ProjectCard({ project, onSelect, onSend }: { project: Project; onSelect: () => void; onSend: (msg: WSClientMessage) => void }) {
  const goals = useStore((s) => s.goals);
  const projectGoals = goals.filter((g) => g.project_id === project.id);
  const activeGoals = projectGoals.filter((g) => g.status === 'active').length;
  const completedGoals = projectGoals.filter((g) => g.status === 'completed').length;

  return (
    <Card
      onClick={onSelect}
      className="cursor-pointer hover:border-primary/50 transition-colors"
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-foreground truncate">{project.name}</h3>
          <Badge variant={STATUS_VARIANT[project.status] || 'muted'}>
            {project.status}
          </Badge>
        </div>
        {project.description && (
          <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{project.description}</p>
        )}
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span>{projectGoals.length} goal{projectGoals.length !== 1 ? 's' : ''}</span>
          {activeGoals > 0 && <span className="text-success">{activeGoals} active</span>}
          {completedGoals > 0 && <span className="text-primary">{completedGoals} done</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectDetail({ project, onSend, onClose }: { project: Project; onSend: (msg: WSClientMessage) => void; onClose: () => void }) {
  const goals = useStore((s) => s.goals);
  const agents = useStore((s) => s.agents);
  const projectGoals = goals.filter((g) => g.project_id === project.id);
  const projectRepos = useStore((s) => s.projectRepos[project.id] ?? EMPTY_REPOS);
  const projectSkills = useStore((s) => s.projectSkills[project.id] ?? []);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [archPlan, setArchPlan] = useState(project.architecture_plan);

  const activeAgents = agents.filter((a) => {
    const agentGoal = goals.find((g) => g.id === a.autopilot_goal_id);
    return agentGoal?.project_id === project.id && a.status === 'running';
  });

  const handleSave = () => {
    onSend({
      type: 'project:update',
      projectId: project.id,
      fields: { name, description, architecture_plan: archPlan },
    });
    setEditing(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onClose} className="md:hidden">
          &larr; Back
        </Button>
        <div className="flex gap-2">
          {!editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (confirm('Delete this project?')) {
                onSend({ type: 'project:delete', projectId: project.id });
                onClose();
              }
            }}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            Delete
          </Button>
        </div>
      </div>

      {editing ? (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div>
              <Label className="mb-1.5">Project Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label className="mb-1.5">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Description..."
              />
            </div>
            <div>
              <Label className="mb-1.5">Architecture Plan</Label>
              <Textarea
                value={archPlan}
                onChange={(e) => setArchPlan(e.target.value)}
                rows={6}
                placeholder="Architecture plan..."
                className="font-mono text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSave}>Save</Button>
              <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div>
            <h2 className="text-xl font-bold text-foreground">{project.name}</h2>
            {project.description && (
              <p className="text-sm text-muted-foreground mt-2">{project.description}</p>
            )}
          </div>

          {project.architecture_plan && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-muted-foreground">Architecture Plan</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs text-foreground overflow-x-auto whitespace-pre-wrap">
                  {project.architecture_plan}
                </pre>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Repos */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground">Repos ({projectRepos.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {projectRepos.length > 0 ? (
            <div className="space-y-1.5">
              {projectRepos.map((repo) => (
                <div key={repo} className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2 text-sm">
                  <span className="text-foreground truncate">{repo}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onSend({ type: 'project:remove-repo', projectId: project.id, repoPath: repo })}
                    className="text-muted-foreground hover:text-destructive h-6 px-2 text-xs"
                  >
                    remove
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No repos linked yet</p>
          )}
        </CardContent>
      </Card>

      {/* Goals */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground">Goals ({projectGoals.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {projectGoals.length > 0 ? (
            <div className="space-y-2">
              {projectGoals.map((goal) => (
                <div key={goal.id} className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2">
                  <span className="text-sm text-foreground">{goal.name}</span>
                  <Badge variant={
                    goal.status === 'active' ? 'success' :
                    goal.status === 'completed' ? 'default' :
                    'muted'
                  }>
                    {goal.status}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No goals assigned to this project</p>
          )}
        </CardContent>
      </Card>

      {/* Skills */}
      {projectSkills.length > 0 && (
        <CollapsibleSection title="Skills" count={projectSkills.length} defaultOpen>
          <SkillsList skills={projectSkills} compact />
        </CollapsibleSection>
      )}

      {/* Active agents */}
      {activeAgents.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground">Active Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {activeAgents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2 bg-secondary rounded-lg px-3 py-2 text-sm">
                  <span className="w-2 h-2 rounded-full bg-success shrink-0" />
                  <span className="text-foreground">{agent.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CreateProjectModal({ onSend, onClose }: { onSend: (msg: WSClientMessage) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [archPlan, setArchPlan] = useState('');

  const handleCreate = () => {
    if (!name.trim()) return;
    onSend({ type: 'project:create', name: name.trim(), description, architecturePlan: archPlan });
    onClose();
  };

  return (
    <DrawerModal open={true} title="New Project" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <Label className="mb-1.5">Project Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            autoFocus
          />
        </div>
        <div>
          <Label className="mb-1.5">Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Description..."
          />
        </div>
        <div>
          <Label className="mb-1.5">Architecture Plan (optional)</Label>
          <Textarea
            value={archPlan}
            onChange={(e) => setArchPlan(e.target.value)}
            rows={5}
            placeholder="Architecture plan (optional)..."
            className="font-mono text-sm"
          />
        </div>
        <Button onClick={handleCreate} className="w-full" disabled={!name.trim()}>
          Create Project
        </Button>
      </div>
    </DrawerModal>
  );
}

export function ProjectsScreen({ onSend }: Props) {
  const projects = useStore((s) => s.projects);
  const [showCreate, setShowCreate] = useState(false);
  const selectedProjectId = useStore((s) => s.ui.selectedProjectId);
  const setSelectedProjectId = useStore((s) => s.setSelectedProjectId);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) || null;

  const handleSelectProject = (project: Project) => {
    setSelectedProjectId(project.id);
    onSend({ type: 'project:get-repos', projectId: project.id });
    onSend({ type: 'project:skills', projectId: project.id });
  };

  return (
    <div className="min-h-full pb-20 px-4 pt-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-foreground">Projects</h1>
        <Button onClick={() => setShowCreate(true)} size="sm">
          + New
        </Button>
      </div>

      {selectedProject ? (
        <ProjectDetail
          project={selectedProject}
          onSend={onSend}
          onClose={() => setSelectedProjectId(null)}
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="[]"
          title="No projects yet"
          description="Create a project to organize goals and repos"
          action={<Button onClick={() => setShowCreate(true)}>+ New Project</Button>}
        />
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onSelect={() => handleSelectProject(project)}
              onSend={onSend}
            />
          ))}
        </div>
      )}

      {showCreate && <CreateProjectModal onSend={onSend} onClose={() => setShowCreate(false)} />}
    </div>
  );
}
