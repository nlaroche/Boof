import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { useWebSocket } from '../hooks/useWebSocket';
import { ansiToHtml } from '../lib/ansi';
import type { Agent, Command } from '../lib/types';
import { profiles } from '../lib/ascii-profiles';

export function ChatScreen() {
  const agents = useStore((s) => s.agents);
  const commands = useStore((s) => s.commands);
  const { send } = useWebSocket();
  const [input, setInput] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [commands]);

  const handleSend = () => {
    if (!input.trim() || !selectedAgentId) return;

    send({
      type: 'agent:send',
      agentId: selectedAgentId,
      prompt: input,
    });
    setInput('');
  };

  const filteredCommands: Command[] = selectedAgentId
    ? commands.filter((c: Command) => c.agent_id === selectedAgentId)
    : commands;

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#14141f]">
        <h1 className="text-lg font-semibold text-white">Chat</h1>
      </div>

      {/* Agent Selector */}
      <div className="px-4 py-2 border-b border-[#14141f]">
        <select
          value={selectedAgentId || ''}
          onChange={(e) => setSelectedAgentId(e.target.value || null)}
          className="w-full px-3 py-2 bg-[#14141f] text-white rounded-lg border border-[#2a2a3a] focus:outline-none focus:border-[#7c5bf5]"
        >
          <option value="">Select an agent...</option>
          {agents.map((agent: Agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {filteredCommands.map((command: Command) => (
          <div key={command.id} className="space-y-2">
            <div className="bg-[#14141f] rounded-lg p-3">
              <div className="text-xs text-gray-400 mb-1">You</div>
              <div className="text-white text-sm">{command.prompt}</div>
            </div>
            {command.status === 'running' && (
              <div className="bg-[#14141f] rounded-lg p-3">
                <div className="text-xs text-gray-400 mb-1">{selectedAgentId ? agents.find((a: Agent) => a.id === selectedAgentId)?.name : 'Agent'}</div>
                <div className="text-white text-sm">Thinking...</div>
              </div>
            )}
            {command.summary && (
              <div className="bg-[#14141f] rounded-lg p-3">
                <div className="text-xs text-gray-400 mb-1">{selectedAgentId ? agents.find((a: Agent) => a.id === selectedAgentId)?.name : 'Agent'}</div>
                <div
                  className="text-white text-sm prose prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: ansiToHtml(command.summary) }}
                />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-[#14141f]">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
            className="flex-1 px-4 py-2 bg-[#14141f] text-white rounded-lg border border-[#2a2a3a] focus:outline-none focus:border-[#7c5bf5]"
          />
          <button
            onClick={handleSend}
            disabled={!selectedAgentId}
            className="px-4 py-2 bg-[#7c5bf5] text-white rounded-lg hover:bg-[#6b4ce6] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
