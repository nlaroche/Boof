import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../stores/store';
import { AgentCard } from '../components/AgentCard';
import { ProfileSelector } from '../components/ProfileSelector';
import { AgentSettingsModal } from '../components/AgentSettingsModal';
import type { Agent, WSClientMessage } from '../lib/types';

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
  const [agentType, setAgentType] = useState<'claude' | 'aider'>('claude');
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
      agentType,
    });
    setNewName('');
    setSearch('');
    setSelectedProfile('robot');
    setAgentType('claude');
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
    <div className="pb-20">
      <div className="p-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-[#e2e2ef]">Agents</h1>
        <button
          onClick={() => setShowNew(!showNew)}
          className="bg-[#7c5bf5] text-white text-sm px-4 py-2 rounded-lg active:bg-[#6b4ae4] transition-colors"
        >
          + New
        </button>
      </div>

      {showNew && (
        <div className="mx-3 mb-4 bg-[#14141f] border border-[#1e1e2e] rounded-xl p-4">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Agent name (optional)"
            className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
          />
          <div className="mb-3">
            <label className="text-xs text-[#6b6b80] mb-1.5 block">Profile</label>
            <ProfileSelector selected={selectedProfile} onSelect={setSelectedProfile} />
          </div>
          <div className="mb-3">
            <label className="text-xs text-[#6b6b80] mb-1.5 block">Backend</label>
            <div className="flex gap-2">
              <button
                onClick={() => setAgentType('claude')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors ${
                  agentType === 'claude'
                    ? 'bg-[#7c5bf5]/20 text-[#7c5bf5] border border-[#7c5bf5]/40'
                    : 'bg-[#0a0a0f] text-[#6b6b80] border border-[#1e1e2e]'
                }`}
              >
                Claude Code
              </button>
              <button
                onClick={() => setAgentType('aider')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors ${
                  agentType === 'aider'
                    ? 'bg-[#22c55e]/20 text-[#22c55e] border border-[#22c55e]/40'
                    : 'bg-[#0a0a0f] text-[#6b6b80] border border-[#1e1e2e]'
                }`}
              >
                Aider
              </button>
            </div>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repos..."
            className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-3 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
          />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {filtered.length === 0 ? (
              <p className="text-center text-[#6b6b80] text-sm py-4">
                {repos.length === 0 ? 'Loading repos...' : 'No matching repos'}
              </p>
            ) : (
              filtered.map((repo) => (
                <button
                  key={repo.path}
                  onClick={() => handleCreate(repo.path, repo.name)}
                  className="w-full text-left px-3 py-2.5 rounded-lg bg-[#0a0a0f] hover:bg-[#1e1e2e] active:bg-[#1e1e2e] transition-colors flex items-center justify-between"
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
        </div>
      )}

      {agents.length === 0 ? (
        <div className="px-4 py-12 text-center text-[#6b6b80]">
          <div className="text-4xl mb-2">&#9881;</div>
          <p>No agents yet</p>
          <p className="text-sm mt-1">Create one to get started</p>
        </div>
      ) : (
        <div className="px-3 space-y-2">
          {agents.map((agent) => (
            <div key={agent.id} className="relative">
              <AgentCard agent={agent} />
              <div className="absolute top-3 right-3 flex gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); setSettingsAgent(agent); }}
                  className="px-2 py-1 bg-[#1e1e2e] text-[#6b6b80] rounded text-xs"
                  title="Settings"
                >
                  &#9881;
                </button>
                {agent.status !== 'dead' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleKill(agent.id); }}
                    className="px-2 py-1 bg-[#ef4444]/20 text-[#ef4444] rounded text-xs"
                  >
                    Kill
                  </button>
                )}
                {agent.status === 'dead' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRestart(agent.id); }}
                    className="px-2 py-1 bg-[#22c55e]/20 text-[#22c55e] rounded text-xs"
                  >
                    Restart
                  </button>
                )}
                {(agent.status === 'dead' || agent.status === 'idle') && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(agent.id, agent.name); }}
                    className="px-2 py-1 bg-[#6b6b80]/20 text-[#6b6b80] rounded text-xs"
                  >
                    Delete
                  </button>
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
