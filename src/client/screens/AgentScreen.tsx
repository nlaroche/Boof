import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../stores/store';
import { CommandInput } from '../components/CommandInput';
import { useSpeech } from '../hooks/useSpeech';
import { ansiToHtml } from '../lib/ansi';
import { timeAgo } from '../lib/format';
import type { WSClientMessage, Command, GoalLogEntry } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

const EMPTY_COMMANDS: Command[] = [];

export function AgentScreen({ onSend }: Props) {
  const selectedAgentId = useStore((s) => s.ui.selectedAgentId);
  const agents = useStore((s) => s.agents);
  const activeOutputs = useStore((s) => s.activeOutputs);
  const commands = useStore((s) => s.commands);
  const clearOutput = useStore((s) => s.clearOutput);
  const agentActivity = useStore((s) => s.agentActivity);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  const agent = agents.find((a) => a.id === selectedAgentId);
  const lines = selectedAgentId ? (activeOutputs[selectedAgentId] || []) : [];

  const agentCommands = selectedAgentId
    ? commands.filter((c) => c.agent_id === selectedAgentId)
    : EMPTY_COMMANDS;
  const sortedDesc = [...agentCommands].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  const { transcript, isListening, startListening, stopListening, resetTranscript, supported } = useSpeech();

  const activity = selectedAgentId ? (agentActivity[selectedAgentId] || []) : [];

  // null = history list, 'live' = live output, string = viewing a past command
  const [viewing, setViewing] = useState<string | null>(null);
  const [historyTab, setHistoryTab] = useState<'messages' | 'activity'>('messages');
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const lastScrollTop = useRef(0);
  const isAutoScrolling = useRef(false);

  const isRunning = agent?.status === 'running';
  const runningCommand = sortedDesc.find((c) => c.status === 'running');

  // Load history and activity on mount
  useEffect(() => {
    if (selectedAgentId) {
      onSend({ type: 'agent:history', agentId: selectedAgentId, limit: 50 });
      onSend({ type: 'agent:activity', agentId: selectedAgentId, limit: 50 });
    }
  }, [selectedAgentId, onSend]);

  // Auto-switch to live when agent starts running
  useEffect(() => {
    if (isRunning) {
      setViewing('live');
      userScrolledUp.current = false;
    }
  }, [isRunning]);

  // Auto-scroll live output
  useEffect(() => {
    if (viewing !== 'live') return;
    const el = scrollRef.current;
    if (!el || userScrolledUp.current) return;
    isAutoScrolling.current = true;
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { isAutoScrolling.current = false; });
    });
  }, [lines, viewing]);

  const handleScroll = useCallback(() => {
    if (isAutoScrolling.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const currentTop = el.scrollTop;
    const isAtBottom = el.scrollHeight - currentTop - el.clientHeight < 60;
    if (currentTop < lastScrollTop.current && !isAtBottom) {
      userScrolledUp.current = true;
    }
    if (isAtBottom) {
      userScrolledUp.current = false;
    }
    lastScrollTop.current = currentTop;
  }, []);

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-full text-[#6b6b80]">
        No agent selected
      </div>
    );
  }

  const handleSend = (text: string) => {
    onSend({ type: 'agent:send', agentId: agent.id, prompt: text });
    resetTranscript();
    setViewing('live');
    userScrolledUp.current = false;
  };

  const handleMicToggle = () => {
    isListening ? stopListening() : startListening();
  };

  const handleInterrupt = () => {
    onSend({ type: 'agent:interrupt', agentId: agent.id });
  };

  const handleNewChat = () => {
    if (selectedAgentId) {
      clearOutput(selectedAgentId);
    }
    setViewing('live');
    userScrolledUp.current = false;
  };

  const statusColors: Record<string, string> = {
    idle: 'text-[#22c55e]',
    running: 'text-[#f59e0b]',
    error: 'text-[#ef4444]',
    dead: 'text-[#6b6b80]',
  };

  const showHistory = viewing === null;
  const showLive = viewing === 'live';
  const viewingCommand = viewing && viewing !== 'live'
    ? agentCommands.find((c) => c.id === viewing) : null;

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 p-3 bg-[#14141f] border-b border-[#1e1e2e] shrink-0">
        <button
          onClick={() => {
            if (showHistory) setActiveScreen('agents');
            else { setViewing(null); userScrolledUp.current = false; }
          }}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[#6b6b80] active:text-[#e2e2ef]"
        >
          &#8592;
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[#e2e2ef] truncate">{agent.name}</div>
          <div className="text-xs text-[#6b6b80] truncate">
            {showHistory ? agent.working_directory : showLive ? 'Live' : 'History'}
          </div>
        </div>
        <button
          onClick={handleNewChat}
          className="px-3 py-1.5 bg-[#1e1e2e] text-[#6b6b80] border border-[#1e1e2e] rounded-lg text-xs active:bg-[#2e2e3e]"
        >
          + New Chat
        </button>
        <span className={`text-xs font-medium ${statusColors[agent.status]}`}>
          {agent.status}
        </span>
        {isRunning && (
          <button
            onClick={handleInterrupt}
            className="min-w-[44px] min-h-[44px] bg-[#ef4444]/20 text-[#ef4444] rounded-lg flex items-center justify-center text-sm font-medium shrink-0"
          >
            Stop
          </button>
        )}
      </div>

      {/* ===== HISTORY LIST ===== */}
      {showHistory && (
        <>
          {/* Tab toggle */}
          <div className="flex bg-[#14141f] border-b border-[#1e1e2e] shrink-0">
            <button
              onClick={() => setHistoryTab('messages')}
              className={`flex-1 py-2 text-xs font-medium text-center ${
                historyTab === 'messages'
                  ? 'text-[#e2e2ef] border-b-2 border-[#7c5bf5]'
                  : 'text-[#6b6b80]'
              }`}
            >
              Messages
            </button>
            <button
              onClick={() => setHistoryTab('activity')}
              className={`flex-1 py-2 text-xs font-medium text-center ${
                historyTab === 'activity'
                  ? 'text-[#e2e2ef] border-b-2 border-[#7c5bf5]'
                  : 'text-[#6b6b80]'
              }`}
            >
              Activity{activity.length > 0 ? ` (${activity.length})` : ''}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 bg-[#0a0a0f]">
            {historyTab === 'messages' ? (
              <>
                {/* Live output entry */}
                {(lines.length > 0 || isRunning) && (
                  <button
                    onClick={() => { setViewing('live'); userScrolledUp.current = false; }}
                    className="w-full px-4 py-3 flex items-center gap-3 border-b border-[#1e1e2e] bg-[#14141f] active:bg-[#1e1e2e]"
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-[#f59e0b] animate-pulse' : 'bg-[#22c55e]'}`} />
                    <span className="text-sm text-[#e2e2ef] flex-1 text-left truncate">
                      {isRunning ? 'Running...' : 'Latest output'}
                    </span>
                    <span className="text-xs text-[#6b6b80]">&rarr;</span>
                  </button>
                )}

                {sortedDesc.length === 0 && lines.length === 0 ? (
                  <div className="text-center text-[#6b6b80] py-12">
                    <div className="text-lg font-mono mb-2">---</div>
                    <p>No messages yet</p>
                    <p className="text-sm mt-1">Send a command to get started</p>
                  </div>
                ) : (
                  sortedDesc.filter((c) => c.status !== 'running').map((cmd) => (
                    <button
                      key={cmd.id}
                      onClick={() => setViewing(cmd.id)}
                      className="w-full px-4 py-3 flex items-center gap-3 border-b border-[#1e1e2e] active:bg-[#14141f] text-left"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        cmd.status === 'done' ? 'bg-[#22c55e]' :
                        cmd.status === 'error' ? 'bg-[#ef4444]' : 'bg-[#6b6b80]'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[#e2e2ef] truncate">{cmd.prompt}</div>
                        {cmd.summary && (
                          <div className="text-xs text-[#6b6b80] truncate mt-0.5">{cmd.summary.split('\n')[0]}</div>
                        )}
                      </div>
                      <span className="text-[10px] text-[#6b6b80] shrink-0">{timeAgo(cmd.started_at)}</span>
                    </button>
                  ))
                )}
              </>
            ) : (
              /* ===== ACTIVITY TAB ===== */
              activity.length === 0 ? (
                <div className="text-center text-[#6b6b80] py-12">
                  <div className="text-lg font-mono mb-2">---</div>
                  <p>No activity yet</p>
                  <p className="text-sm mt-1">Autopilot runs and workflow steps appear here</p>
                </div>
              ) : (
                activity.map((entry) => (
                  <div
                    key={entry.id}
                    className="px-4 py-3 border-b border-[#1e1e2e]"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        entry.success ? 'bg-[#22c55e]' : 'bg-[#ef4444]'
                      }`} />
                      <span className="text-xs font-medium text-[#e2e2ef]">{entry.action}</span>
                      <span className="text-[10px] text-[#6b6b80] ml-auto shrink-0">{timeAgo(entry.created_at)}</span>
                    </div>
                    {entry.summary && (
                      <p className="text-xs text-[#6b6b80] ml-3.5 break-words">{entry.summary}</p>
                    )}
                    <div className="flex items-center gap-3 ml-3.5 mt-1 text-[10px] text-[#6b6b80]">
                      {entry.duration_ms > 0 && (
                        <span>{(entry.duration_ms / 1000).toFixed(1)}s</span>
                      )}
                      {entry.cost_usd > 0 && (
                        <span>${entry.cost_usd.toFixed(4)}</span>
                      )}
                      {entry.diff_stats && (
                        <span className="truncate">{entry.diff_stats}</span>
                      )}
                    </div>
                  </div>
                ))
              )
            )}
          </div>

          {/* New Chat button on history view */}
          <div className="p-3 bg-[#14141f] border-t border-[#1e1e2e] shrink-0">
            <button
              onClick={handleNewChat}
              className="w-full py-2.5 bg-[#1e1e2e] text-[#e2e2ef] rounded-lg text-sm active:bg-[#2e2e3e]"
            >
              + New Chat
            </button>
          </div>
        </>
      )}

      {/* ===== VIEWING A PAST COMMAND (bubbles) ===== */}
      {viewingCommand && (
        <>
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 bg-[#0a0a0f] p-3 space-y-3">
            {/* User prompt bubble */}
            <div className="flex justify-end">
              <div className="bg-[#7c5bf5]/20 text-[#e2e2ef] text-sm rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[85%] break-words">
                {viewingCommand.prompt}
                <div className="text-[10px] text-[#7c5bf5]/60 mt-1">{timeAgo(viewingCommand.started_at)}</div>
              </div>
            </div>

            {/* Agent response bubble */}
            <div className="flex justify-start">
              <div className="bg-[#14141f] border border-[#1e1e2e] rounded-2xl rounded-bl-sm px-4 py-3 max-w-[90%] break-words">
                {viewingCommand.summary && (
                  <div className="text-sm text-[#e2e2ef] mb-2 whitespace-pre-wrap">{viewingCommand.summary}</div>
                )}
                {viewingCommand.raw_output ? (
                  <div className="font-mono text-xs leading-relaxed max-h-[50vh] overflow-y-auto overflow-x-hidden text-[#e2e2ef]">
                    <pre className="whitespace-pre-wrap break-words m-0">{viewingCommand.raw_output}</pre>
                  </div>
                ) : (
                  <p className="text-xs text-[#6b6b80] italic">No output recorded</p>
                )}
                <div className="flex items-center gap-2 mt-2 text-[10px] text-[#6b6b80]">
                  <span className={viewingCommand.status === 'done' ? 'text-[#22c55e]' : viewingCommand.status === 'error' ? 'text-[#ef4444]' : ''}>
                    {viewingCommand.status === 'done' ? 'Done' : viewingCommand.status === 'error' ? 'Error' : viewingCommand.status}
                  </span>
                  {viewingCommand.files_changed?.length > 0 && (
                    <span>{viewingCommand.files_changed.length} file{viewingCommand.files_changed.length !== 1 ? 's' : ''}</span>
                  )}
                  {viewingCommand.completed_at && (
                    <span className="ml-auto">{timeAgo(viewingCommand.completed_at)}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Back to list button */}
          <div className="p-3 bg-[#14141f] border-t border-[#1e1e2e] shrink-0">
            <button
              onClick={() => { setViewing(null); userScrolledUp.current = false; }}
              className="w-full py-2.5 bg-[#1e1e2e] text-[#e2e2ef] rounded-lg text-sm active:bg-[#2e2e3e]"
            >
              Back to messages
            </button>
          </div>
        </>
      )}

      {/* ===== LIVE OUTPUT (bubbles) ===== */}
      {showLive && (
        <>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 bg-[#0a0a0f] p-3 space-y-3"
          >
            {/* User prompt bubble */}
            {runningCommand && (
              <div className="flex justify-end">
                <div className="bg-[#7c5bf5]/20 text-[#e2e2ef] text-sm rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[85%] break-words">
                  {runningCommand.prompt}
                </div>
              </div>
            )}

            {/* Agent response bubble */}
            <div className="flex justify-start">
              <div className="bg-[#14141f] border border-[#1e1e2e] rounded-2xl rounded-bl-sm px-4 py-3 max-w-[90%] break-words">
                {isRunning && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-[#f59e0b]">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-pulse" />
                    Working...
                  </div>
                )}
                {lines.length > 0 ? (
                  <div className="font-mono text-xs leading-relaxed overflow-x-hidden">
                    {lines.map((line, i) => (
                      <div
                        key={i}
                        className="break-words"
                        style={{ overflowWrap: 'anywhere' }}
                        dangerouslySetInnerHTML={{ __html: ansiToHtml(line) }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-[#6b6b80] italic">Waiting for output...</div>
                )}
                {!isRunning && lines.length > 0 && (
                  <div className={`mt-2 pt-2 border-t border-[#1e1e2e] text-xs ${
                    agent.status === 'idle' ? 'text-[#22c55e]' : 'text-[#ef4444]'
                  }`}>
                    {agent.status === 'idle' ? 'Task complete' : agent.status === 'error' ? 'Task failed' : 'Stopped'}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Input */}
          <CommandInput
            onSend={handleSend}
            onMicToggle={handleMicToggle}
            isListening={isListening}
            speechSupported={supported}
            externalText={transcript}
            disabled={isRunning}
          />
        </>
      )}
    </div>
  );
}
