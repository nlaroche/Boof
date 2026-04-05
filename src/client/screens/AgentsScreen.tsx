import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../stores/store';
import { AgentCard } from '../components/AgentCard';
import { ProfileSelector } from '../components/ProfileSelector';
import { AgentSettingsModal } from '../components/AgentSettingsModal';
import type { Agent, WSClientMessage } from '../lib/types';
import { cn } from '@/lib/utils';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function AgentsScreen({ onSend }: Props) {
  const agents = useStore((s) => s.agents);
  const repos = useStore((s) => s.repos);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [search, setSearch] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('robot');
  const [settingsAgent, setSettingsAgent] = useState<Agent | null>(null);

  useEffect(() => {
    if (showNew) {
      onSend({ type: 'repos:list' });
    }
  }, [showNew, onSend]);

  const filtered = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter((r) => r.name.toLowerCase().includes(q));
  }, [repos, search]);

  const handleCreate = (repoPath: string, repoName: string) => {
    onSend({
      type: 'agent:create',
      workingDirectory: repoPath,
      name: newName.trim() || repoName,
      profileId: selectedProfile,
    });
    setNewName('');
    setSearch('');
    setSelectedProfile('robot');
    setShowNew(false);
  };

  const handleKill = (agentId: string) => {
    onSend({ type: 'agent:kill', agentId });
  };

  const handleRestart = (agentId: string) => {
    onSend({ type: 'agent:restart', agentId });
  };

  const handleDelete = (agentId: string, agentName: string) => {
    if (confirm(`Delete agent "${agentName}" permanently?`)) {
      onSend({ type: 'agent:delete', agentId });
    }
  };

  return (
    <div className="min-h-full pb-20">
      <div className="p-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-foreground">Agents</h1>
        <Button
          onClick={() => setShowNew(!showNew)}
          size="sm"
        >
          + New
        </Button>
      </div>

      {showNew && (
        <Card className="mx-3 mb-4">
          <CardContent className="p-4 space-y-3">
            <div>
              <Label className="mb-1.5">Agent Name (optional)</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Agent name (optional)"
              />
            </div>
            <div>
              <Label className="mb-1.5">Profile</Label>
              <ProfileSelector selected={selectedProfile} onSelect={setSelectedProfile} />
            </div>
            <div>
              <Label className="mb-1.5">Select Repo</Label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search repos..."
                className="mb-2"
              />
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1.5">
              {filtered.length === 0 ? (
                <p className="text-center text-muted-foreground text-sm py-4">
                  {repos.length === 0 ? 'Loading repos...' : 'No matching repos'}
                </p>
              ) : (
                filtered.map((repo) => (
                  <Card
                    key={repo.path}
                    onClick={() => handleCreate(repo.path, repo.name)}
                    className="p-2.5 cursor-pointer hover:bg-secondary active:bg-secondary transition-colors flex items-center justify-between"
                  >
                    <span className="text-sm text-foreground truncate">{repo.name}</span>
                    {repo.hasGit && (
                      <Badge variant="secondary" className="ml-2 shrink-0">git</Badge>
                    )}
                  </Card>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {agents.length === 0 ? (
        <div className="px-4 py-12 text-center text-muted-foreground">
          <div className="text-lg font-mono mb-2">--</div>
          <p>No agents yet</p>
          <p className="text-sm mt-1">Create one to get started</p>
        </div>
      ) : (
        <div className="px-3 space-y-2">
          {agents.map((agent) => (
            <div key={agent.id} className="relative">
              <AgentCard agent={agent} />
              <div className="absolute top-3 right-3 flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => { e.stopPropagation(); setSettingsAgent(agent); }}
                  title="Settings"
                  className="px-2 py-1 h-7"
                >
                  &#9881;
                </Button>
                {agent.status !== 'dead' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); handleKill(agent.id); }}
                    className="px-2 py-1 h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    Kill
                  </Button>
                )}
                {agent.status === 'dead' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); handleRestart(agent.id); }}
                    className="px-2 py-1 h-7 text-success hover:text-success hover:bg-success/10"
                  >
                    Restart
                  </Button>
                )}
                {(agent.status === 'dead' || agent.status === 'idle') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); handleDelete(agent.id, agent.name); }}
                    className="px-2 py-1 h-7"
                  >
                    Delete
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {settingsAgent && (
        <AgentSettingsModal
          agent={settingsAgent}
          onSend={onSend}
          onClose={() => setSettingsAgent(null)}
        />
      )}
    </div>
  );
}
