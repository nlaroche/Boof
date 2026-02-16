import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useStore } from '../stores/store';
import { CommandInput } from '../components/CommandInput';
import { TaskSummaryModal } from '../components/TaskSummaryModal';
import { useSpeech } from '../hooks/useSpeech';
import { ansiToHtml } from '../lib/ansi';
import { timeAgo } from '../lib/format';
import type { WSClientMessage, Command, GoalLogEntry, Improvement, Assessment } from '../lib/types';
import { getLevel, xpForLevel, XpBar, AGENT_STATUS_BADGE_COLORS, AGENT_STATUS_LABELS } from '../components/AgentWidget';

const categoryColors: Record<string, string> = {
  parser: 'bg-[#f59e0b]/20 text-[#f59e0b]',
  prompt: 'bg-[#3b82f6]/20 text-[#3b82f6]',
  build: 'bg-[#ef4444]/20 text-[#ef4444]',
  workflow: 'bg-[#22c55e]/20 text-[#22c55e]',
  general: 'bg-[#6b6b80]/20 text-[#6b6b80]',
};

const statusIcons: Record<string, string> = {
  pending: '\u25CB',
  running: '\u25D4',
  completed: '\u2713',
  skipped: '\u2014',
  failed: '\u2717',
};

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
  const agentImprovements = useStore((s) => s.agentImprovements);
  const agentAssessments = useStore((s) => s.agentAssessments);
  const agentBranches = useStore((s) => s.agentBranches);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  const agent = agents.find((a) => a.id === selectedAgentId);
  const lines = useMemo(() => selectedAgentId ? (activeOutputs[selectedAgentId] || []) : [], [selectedAgentId, activeOutputs]);

  const agentCommands = selectedAgentId
    ? commands.filter((c) => c.agent_id === selectedAgentId)
    : EMPTY_COMMANDS;
  const sortedDesc = [...agentCommands].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
  );

  const { transcript, isListening, startListening, stopListening, resetTranscript, supported } = useSpeech();

  const activity = selectedAgentId ? (agentActivity[selectedAgentId] || []) : [];
  const improvements = selectedAgentId ? (agentImprovements[selectedAgentId] || []) : [];
  const assessments = selectedAgentId ? (agentAssessments[selectedAgentId] || []) : [];
  const branches = selectedAgentId ? (agentBranches[selectedAgentId] || []) : [];

  // null = history list, 'live' = live output, string = viewing a past command
  const [viewing, setViewing] = useState<string | null>(null);
  const [historyTab, setHistoryTab] = useState<'messages' | 'experience' | 'branches'>('messages');
  const [summaryCommandId, setSummaryCommandId] = useState<string | null>(null);
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
      onSend({ type: 'agent:improvements', agentId: selectedAgentId });
      onSend({ type: 'agent:assessments', agentId: selectedAgentId });
      onSend({ type: 'agent:branches', agentId: selectedAgentId });
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

  const statusColors = AGENT_STATUS_BADGE_COLORS;
  const statusLabels = AGENT_STATUS_LABELS;

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
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColors[agent.status]}`}>
          {statusLabels[agent.status]}
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
              onClick={() => setHistoryTab('experience')}
              className={`flex-1 py-2 text-xs font-medium text-center ${
                historyTab === 'experience'
                  ? 'text-[#e2e2ef] border-b-2 border-[#7c5bf5]'
                  : 'text-[#6b6b80]'
              }`}
            >
              Experience{(agent.xp || 0) > 0 ? ` Lv.${getLevel(agent.xp || 0)}` : ''}
            </button>
            <button
              onClick={() => {
                setHistoryTab('branches');
                onSend({ type: 'agent:branches', agentId: agent.id });
              }}
              className={`flex-1 py-2 text-xs font-medium text-center ${
                historyTab === 'branches'
                  ? 'text-[#e2e2ef] border-b-2 border-[#7c5bf5]'
                  : 'text-[#6b6b80]'
              }`}
            >
              Branches{branches.length > 0 ? ` (${branches.length})` : ''}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 bg-[#0a0a0f]">
            {historyTab === 'branches' ? (
              /* ===== BRANCHES TAB ===== */
              branches.length === 0 ? (
                <div className="text-center text-[#6b6b80] py-12">
                  <div className="text-lg font-mono mb-2">---</div>
                  <p>No agent branches</p>
                  <p className="text-sm mt-1">Autopilot runs create branches for isolation</p>
                </div>
              ) : (
                branches.map((branchName) => (
                  <div
                    key={branchName}
                    className="px-4 py-3 border-b border-[#1e1e2e]"
                  >
                    <div className="text-xs text-[#e2e2ef] font-mono break-all mb-2">{branchName}</div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => onSend({ type: 'agent:merge-branch', agentId: agent.id, branchName })}
                        className="text-xs px-3 py-1.5 bg-[#22c55e]/20 text-[#22c55e] rounded active:bg-[#22c55e]/30"
                      >
                        Merge
                      </button>
                      <button
                        onClick={() => onSend({ type: 'agent:discard-branch', agentId: agent.id, branchName })}
                        className="text-xs px-3 py-1.5 bg-[#ef4444]/20 text-[#ef4444] rounded active:bg-[#ef4444]/30"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                ))
              )
            ) : historyTab === 'messages' ? (
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
                      onClick={() => setSummaryCommandId(cmd.id)}
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
              /* ===== EXPERIENCE TAB ===== */
              <div>
                {/* XP Header */}
                <div className="px-4 py-3 bg-[#14141f] border-b border-[#1e1e2e]">
                  <div className="flex items-center justify-end mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-[#6b6b80]">Self-improve</span>
                      <button
                        onClick={() => onSend({ type: 'agent:self-improve', agentId: agent.id, enabled: !agent.self_improve })}
                        className={`w-10 h-5 rounded-full relative transition-colors ${agent.self_improve ? 'bg-[#7c5bf5]' : 'bg-[#1e1e2e]'}`}
                      >
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${agent.self_improve ? 'left-5' : 'left-0.5'}`} />
                      </button>
                    </div>
                  </div>
                  <XpBar xp={agent.xp || 0} size="lg" />
                </div>

                {/* Improvements List */}
                {improvements.length > 0 && (
                  <div className="border-b border-[#1e1e2e]">
                    <div className="px-4 py-2 text-[10px] font-medium text-[#6b6b80] uppercase tracking-wider">Improvements</div>
                    {improvements.map((imp) => (
                      <div key={imp.id} className="px-4 py-2.5 border-t border-[#1e1e2e]/50 flex items-start gap-2">
                        <span className={`text-xs mt-0.5 shrink-0 ${
                          imp.status === 'completed' ? 'text-[#22c55e]' :
                          imp.status === 'failed' ? 'text-[#ef4444]' :
                          imp.status === 'running' ? 'text-[#f59e0b]' :
                          imp.status === 'skipped' ? 'text-[#6b6b80]' : 'text-[#e2e2ef]'
                        }`}>{statusIcons[imp.status]}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-[#e2e2ef] break-words">{imp.description}</div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded ${categoryColors[imp.category] || categoryColors.general}`}>{imp.category}</span>
                            {imp.xp_awarded > 0 && <span className="text-[9px] text-[#7c5bf5]">+{imp.xp_awarded} XP</span>}
                          </div>
                        </div>
                        {imp.status === 'pending' && (
                          <div className="flex gap-1 shrink-0">
                            <button
                              onClick={() => onSend({ type: 'improvement:execute', improvementId: imp.id, agentId: agent.id })}
                              className="text-[10px] px-2 py-1 bg-[#7c5bf5]/20 text-[#7c5bf5] rounded active:bg-[#7c5bf5]/30"
                            >
                              Run
                            </button>
                            <button
                              onClick={() => onSend({ type: 'improvement:skip', improvementId: imp.id })}
                              className="text-[10px] px-2 py-1 bg-[#1e1e2e] text-[#6b6b80] rounded active:bg-[#2e2e3e]"
                            >
                              Skip
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Assessment History */}
                {assessments.length > 0 ? (
                  <div>
                    <div className="px-4 py-2 text-[10px] font-medium text-[#6b6b80] uppercase tracking-wider">Assessment History</div>
                    {assessments.map((a) => (
                      <div key={a.id} className="px-4 py-2.5 border-t border-[#1e1e2e]/50 flex items-center gap-3">
                        <div className={`text-sm font-bold ${
                          a.score >= 90 ? 'text-[#22c55e]' :
                          a.score >= 70 ? 'text-[#f59e0b]' : 'text-[#ef4444]'
                        }`}>{a.score}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-[10px] text-[#6b6b80]">
                            {a.retries > 0 && <span>{a.retries} retries</span>}
                            <span>{a.files_touched} files</span>
                            {a.duration_ms > 0 && <span>{(a.duration_ms / 1000).toFixed(0)}s</span>}
                          </div>
                        </div>
                        <span className="text-[10px] text-[#6b6b80] shrink-0">{timeAgo(a.created_at)}</span>
                      </div>
                    ))}
                  </div>
                ) : improvements.length === 0 && (
                  <div className="text-center text-[#6b6b80] py-12">
                    <div className="text-lg font-mono mb-2">---</div>
                    <p>No experience yet</p>
                    <p className="text-sm mt-1">Complete tasks to earn XP</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* New Chat button on history view */}
          <div className="p-3 bg-[#14141f] border-t border-[#1e1e2e] shrink-0">
            <button
              onClick={handleNewChat}
              className="w-full py-2.5 bg-[#7c5bf5] text-white rounded-lg text-sm font-medium active:bg-[#6b4ae4]"
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

      {/* ===== TASK SUMMARY MODAL ===== */}
      {summaryCommandId && (() => {
        const cmd = agentCommands.find((c) => c.id === summaryCommandId);
        if (!cmd) return null;
        return (
          <TaskSummaryModal
            command={cmd}
            onClose={() => setSummaryCommandId(null)}
            onViewRaw={() => { setSummaryCommandId(null); setViewing(cmd.id); }}
          />
        );
      })()}

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
