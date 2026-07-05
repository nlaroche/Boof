import { useStore } from '../stores/store';
import { AgentCard } from '../components/AgentCard';
import { NeedsAttention } from '../components/NeedsAttention';
import { ActivityFeed } from '../components/ActivityFeed';
import { NotificationToggle } from '../components/NotificationToggle';
import { Button } from '../components/ui/button';
import { formatCost } from '../lib/format';
import type { Agent, Command, WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
  onSendToAgent: (agentId: string, prompt: string) => void;
}

function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    // Running agents first
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    // Then by most recent activity
    const aTime = new Date(a.last_activity).getTime();
    const bTime = new Date(b.last_activity).getTime();
    if (aTime !== bTime) return bTime - aTime;
    // Dead/offline agents last
    if (a.status === 'dead' && b.status !== 'dead') return 1;
    if (b.status === 'dead' && a.status !== 'dead') return -1;
    return 0;
  });
}

function getLastCommand(agentId: string, commands: Command[]): Command | undefined {
  return commands
    .filter((c) => c.agent_id === agentId)
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];
}

export function HomeScreen({ onSend, onSendToAgent }: Props) {
  const agents = useStore((s) => s.agents);
  const commands = useStore((s) => s.commands);
  const globalStats = useStore((s) => s.globalStats);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  const sorted = sortAgents(agents);

  return (
    <div className="min-h-full pb-20">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h1 className="text-2xl font-bold text-foreground">Boof</h1>
          {globalStats && (globalStats.costTodayUsd ?? 0) > 0 && (
            <span className="text-xs text-muted-foreground font-mono">
              {formatCost(globalStats.costTodayUsd ?? 0)} today
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <NotificationToggle />
          <Button
            onClick={() => setActiveScreen('agents')}
            size="sm"
          >
            + Agent
          </Button>
        </div>
      </div>

      <div className="px-3 mb-2">
        <NeedsAttention onSend={onSend} />
      </div>

      <div className="px-3 mb-2">
        <ActivityFeed onSend={onSend} />
      </div>

      {sorted.length > 0 ? (
        <div className="px-3 space-y-2">
          {sorted.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              lastCommand={getLastCommand(agent.id, commands)}
              onSend={onSend}
            />
          ))}
        </div>
      ) : (
        <div className="px-4 py-12 text-center text-muted-foreground">
          <div className="text-lg font-mono mb-2">(._. )</div>
          <p>No agents yet</p>
          <p className="text-sm mt-1">Create one to get started</p>
        </div>
      )}
    </div>
  );
}
