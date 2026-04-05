import { useStore } from '../stores/store';
import { SummaryCard } from '../components/SummaryCard';
import { Separator } from '../components/ui/separator';

export function HistoryScreen() {
  const commands = useStore((s) => s.commands);
  const agents = useStore((s) => s.agents);

  const sortedCommands = [...commands]
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  return (
    <div className="min-h-full pb-20">
      <div className="p-4">
        <h1 className="text-xl font-bold text-foreground">History</h1>
      </div>

      {sortedCommands.length === 0 ? (
        <div className="px-4 py-12 text-center text-muted-foreground">
          <div className="text-lg font-mono mb-2 text-muted-foreground/60">---</div>
          <p className="text-foreground">No command history yet</p>
          <p className="text-sm mt-1 text-muted-foreground">Send commands to agents to see them here</p>
        </div>
      ) : (
        <div className="px-3 space-y-3">
          {sortedCommands.map((cmd) => {
            const agent = agents.find((a) => a.id === cmd.agent_id);
            return (
              <div key={cmd.id}>
                {agent && (
                  <div className="text-xs text-muted-foreground mb-1 px-1">
                    {agent.name} <span className="text-muted-foreground/60">&middot;</span> {agent.working_directory}
                  </div>
                )}
                <SummaryCard command={cmd} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
