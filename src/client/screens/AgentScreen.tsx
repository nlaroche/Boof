import { useStore } from '../stores/store';
import { AgentOutput } from '../components/AgentOutput';
import { CommandInput } from '../components/CommandInput';
import { useSpeech } from '../hooks/useSpeech';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function AgentScreen({ onSend }: Props) {
  const selectedAgentId = useStore((s) => s.ui.selectedAgentId);
  const agents = useStore((s) => s.agents);
  const activeOutputs = useStore((s) => s.activeOutputs);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  const agent = agents.find((a) => a.id === selectedAgentId);
  const lines = selectedAgentId ? (activeOutputs[selectedAgentId] || []) : [];

  const { transcript, isListening, startListening, stopListening, resetTranscript, supported } = useSpeech();

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-screen text-[#6b6b80]">
        No agent selected
      </div>
    );
  }

  const handleSend = (text: string) => {
    onSend({ type: 'agent:send', agentId: agent.id, prompt: text });
    resetTranscript();
  };

  const handleMicToggle = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  const handleInterrupt = () => {
    onSend({ type: 'agent:interrupt', agentId: agent.id });
  };

  const statusColors: Record<string, string> = {
    idle: 'text-[#22c55e]',
    running: 'text-[#f59e0b]',
    error: 'text-[#ef4444]',
    dead: 'text-[#6b6b80]',
  };

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 bg-[#14141f] border-b border-[#1e1e2e]">
        <button
          onClick={() => setActiveScreen('agents')}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[#6b6b80] active:text-[#e2e2ef]"
        >
          &#8592;
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[#e2e2ef] truncate">{agent.name}</div>
          <div className="text-xs text-[#6b6b80] truncate">{agent.working_directory}</div>
        </div>
        <span className={`text-sm font-medium ${statusColors[agent.status]}`}>
          {agent.status}
        </span>
        {agent.status === 'running' && (
          <button
            onClick={handleInterrupt}
            className="min-w-[44px] min-h-[44px] bg-[#ef4444]/20 text-[#ef4444] rounded-lg flex items-center justify-center text-sm font-medium"
          >
            Stop
          </button>
        )}
      </div>

      {/* Output */}
      <AgentOutput lines={lines} />

      {/* Input */}
      <CommandInput
        onSend={handleSend}
        onMicToggle={handleMicToggle}
        isListening={isListening}
        speechSupported={supported}
        externalText={transcript}
      />
    </div>
  );
}
