import { useState } from 'react';
import { useStore } from '../stores/store';
import { AgentCard } from '../components/AgentCard';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function AgentsScreen({ onSend }: Props) {
  const agents = useStore((s) => s.agents);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDir, setNewDir] = useState('');

  const handleCreate = () => {
    if (!newDir.trim()) return;
    onSend({
      type: 'agent:create',
      workingDirectory: newDir.trim(),
      name: newName.trim() || undefined,
    });
    setNewName('');
    setNewDir('');
    setShowNew(false);
  };

  const handleKill = (agentId: string) => {
    onSend({ type: 'agent:kill', agentId });
  };

  const handleRestart = (agentId: string) => {
    onSend({ type: 'agent:restart', agentId });
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
          <input
            value={newDir}
            onChange={(e) => setNewDir(e.target.value)}
            placeholder="Working directory (e.g. /home/user/project)"
            className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-3 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5]"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button
            onClick={handleCreate}
            disabled={!newDir.trim()}
            className="w-full bg-[#7c5bf5] text-white py-2.5 rounded-lg text-sm font-medium disabled:opacity-40 active:bg-[#6b4ae4]"
          >
            Create Agent
          </button>
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
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
