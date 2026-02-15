import { useStore } from '../stores/store';
import { SummaryCard } from '../components/SummaryCard';

export function HistoryScreen() {
  const commands = useStore((s) => s.commands);
  const agents = useStore((s) => s.agents);

  const sortedCommands = [...commands]
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  return (
    <div className="pb-20">
      <div className="p-4">
        <h1 className="text-xl font-bold text-[#e2e2ef]">History</h1>
      </div>

      {sortedCommands.length === 0 ? (
        <div className="px-4 py-12 text-center text-[#6b6b80]">
          <div className="text-4xl mb-2">&#9200;</div>
          <p>No command history yet</p>
          <p className="text-sm mt-1">Send commands to agents to see them here</p>
        </div>
      ) : (
        <div className="px-3">
          {sortedCommands.map((cmd) => {
            const agent = agents.find((a) => a.id === cmd.agent_id);
            return (
              <div key={cmd.id}>
                {agent && (
                  <div className="text-xs text-[#6b6b80] mb-1 px-1">
                    {agent.name} &middot; {agent.working_directory}
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
