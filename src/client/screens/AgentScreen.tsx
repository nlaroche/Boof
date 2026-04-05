import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useStore } from '../stores/store';
import { CommandInput } from '../components/CommandInput';
import { TaskSummaryModal } from '../components/TaskSummaryModal';
import { useSpeech } from '../hooks/useSpeech';
import { ansiToHtml } from '../lib/ansi';
import { timeAgo } from '../lib/format';
import { cn } from '@/lib/utils';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Separator } from '../components/ui/separator';
import type { WSClientMessage, Command, GoalLogEntry, Improvement, Assessment, XpEvent, DashboardData, Skill, Experiment, TimelineRun } from '../lib/types';
import { getLevel, xpForLevel, XpBar, getPortrait, AGENT_STATUS_BADGE_COLORS, AGENT_STATUS_LABELS } from '../components/AgentWidget';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { SkillsList } from '../components/SkillsList';
import { Progress } from '../components/ui/progress';

const categoryColors: Record<string, string> = {
  parser: 'bg-warning/20 text-warning',
  prompt: 'bg-info/20 text-info',
  build: 'bg-destructive/20 text-destructive',
  workflow: 'bg-success/20 text-success',
  general: 'bg-muted-foreground/20 text-muted-foreground',
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
  const agentXpEvents = useStore((s) => s.agentXpEvents);
  const agentDashboard = useStore((s) => s.agentDashboard);
  const agentSkillsList = useStore((s) => s.agentSkillsList);
  const agentExperiments = useStore((s) => s.agentExperiments);
  const agentTimelineData = useStore((s) => s.agentTimeline);
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
  const xpEvents = selectedAgentId ? (agentXpEvents[selectedAgentId] || []) : [];
  const dashboard = selectedAgentId ? agentDashboard[selectedAgentId] : undefined;
  const skillsList = selectedAgentId ? (agentSkillsList[selectedAgentId] || []) : [];
  const experiments = selectedAgentId ? (agentExperiments[selectedAgentId] || []) : [];
  const timeline = selectedAgentId ? (agentTimelineData[selectedAgentId] || []) : [];

  // null = history list, 'live' = live output, string = viewing a past command
  const [viewing, setViewing] = useState<string | null>(null);
  const [historyTab, setHistoryTab] = useState<'messages' | 'experience' | 'branches'>('messages');
  const [summaryCommandId, setSummaryCommandId] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const [showNewExperiment, setShowNewExperiment] = useState(false);
  const [newExpForm, setNewExpForm] = useState({ name: '', hypothesis: '', variantA: '', variantB: '' });
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const lastScrollTop = useRef(0);
  const isAutoScrolling = useRef(false);

  const goals = useStore((s) => s.goals);
  const isRunning = agent?.status === 'running';
  const runningCommand = sortedDesc.find((c) => c.status === 'running');
  const currentGoalName = agent?.autopilot_goal_id ? goals.find((g) => g.id === agent.autopilot_goal_id)?.name : null;

  // Load history and activity on mount
  useEffect(() => {
    if (selectedAgentId) {
      onSend({ type: 'agent:history', agentId: selectedAgentId, limit: 50 });
      onSend({ type: 'agent:activity', agentId: selectedAgentId, limit: 50 });
      onSend({ type: 'agent:improvements', agentId: selectedAgentId });
      onSend({ type: 'agent:assessments', agentId: selectedAgentId });
      onSend({ type: 'agent:branches', agentId: selectedAgentId });
      onSend({ type: 'agent:xp-events', agentId: selectedAgentId });
      onSend({ type: 'agent:dashboard', agentId: selectedAgentId });
      onSend({ type: 'agent:skills', agentId: selectedAgentId });
      onSend({ type: 'agent:experiments', agentId: selectedAgentId });
      onSend({ type: 'agent:timeline', agentId: selectedAgentId });
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
      <div className="flex items-center justify-center h-full text-muted-foreground">
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
      <div className="bg-card border-b border-border shrink-0">
        <div className="flex items-center gap-2 p-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (showHistory) setActiveScreen('agents');
              else { setViewing(null); userScrolledUp.current = false; }
            }}
            className="min-w-[44px] min-h-[44px]"
          >
            &#8592;
          </Button>
          <span className="text-2xl font-mono shrink-0">{getPortrait(agent.name)}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground truncate">{agent.name}</span>
              <Badge className={statusColors[agent.status]}>
                {statusLabels[agent.status]}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {showHistory ? (currentGoalName || agent.working_directory) : showLive ? 'Live' : 'History'}
            </div>
          </div>
          {isRunning && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleInterrupt}
              className="min-w-[44px] min-h-[44px] shrink-0"
            >
              Stop
            </Button>
          )}
        </div>
        {/* XP bar + quick stats */}
        {showHistory && (
          <div className="px-3 pb-3">
            <XpBar xp={agent.xp || 0} size="sm" />
            {dashboard && (
              <div className="flex items-center gap-4 mt-1.5 text-[10px] text-muted-foreground">
                <span>{dashboard.success_rate_all}% success</span>
                <span>{(dashboard.total_tokens / 1000).toFixed(0)}k tokens</span>
                <span>{dashboard.skills_count} skills</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== HISTORY LIST ===== */}
      {showHistory && (
        <>
          {/* Tab toggle */}
          <div className="flex bg-card border-b border-border shrink-0">
            <button
              onClick={() => setHistoryTab('messages')}
              className={cn(
                'flex-1 py-2 text-xs font-medium text-center transition-colors',
                historyTab === 'messages'
                  ? 'text-foreground border-b-2 border-primary'
                  : 'text-muted-foreground'
              )}
            >
              Messages
            </button>
            <button
              onClick={() => setHistoryTab('experience')}
              className={cn(
                'flex-1 py-2 text-xs font-medium text-center transition-colors',
                historyTab === 'experience'
                  ? 'text-foreground border-b-2 border-primary'
                  : 'text-muted-foreground'
              )}
            >
              Experience{(agent.xp || 0) > 0 ? ` Lv.${getLevel(agent.xp || 0)}` : ''}
            </button>
            <button
              onClick={() => {
                setHistoryTab('branches');
                onSend({ type: 'agent:branches', agentId: agent.id });
              }}
              className={cn(
                'flex-1 py-2 text-xs font-medium text-center transition-colors',
                historyTab === 'branches'
                  ? 'text-foreground border-b-2 border-primary'
                  : 'text-muted-foreground'
              )}
            >
              Branches{branches.length > 0 ? ` (${branches.length})` : ''}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 bg-background">
            {historyTab === 'branches' ? (
              /* ===== BRANCHES TAB ===== */
              branches.length === 0 ? (
                <div className="text-center text-muted-foreground py-12">
                  <div className="text-lg font-mono mb-2">---</div>
                  <p>No agent branches</p>
                  <p className="text-sm mt-1">Autopilot runs create branches for isolation</p>
                </div>
              ) : (
                branches.map((branchName) => (
                  <div
                    key={branchName}
                    className="px-4 py-3 border-b border-border"
                  >
                    <div className="text-xs text-foreground font-mono break-all mb-2">{branchName}</div>
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onSend({ type: 'agent:merge-branch', agentId: agent.id, branchName })}
                        className="bg-success/20 text-success hover:bg-success/30"
                      >
                        Merge
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => onSend({ type: 'agent:discard-branch', agentId: agent.id, branchName })}
                      >
                        Discard
                      </Button>
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
                    className="w-full px-4 py-3 flex items-center gap-3 border-b border-border bg-card active:bg-secondary"
                  >
                    <span className={cn(
                      'w-2 h-2 rounded-full shrink-0',
                      isRunning ? 'bg-warning animate-pulse' : 'bg-success'
                    )} />
                    <span className="text-sm text-foreground flex-1 text-left truncate">
                      {isRunning ? 'Running...' : 'Latest output'}
                    </span>
                    <span className="text-xs text-muted-foreground">&rarr;</span>
                  </button>
                )}

                {sortedDesc.length === 0 && lines.length === 0 ? (
                  <div className="text-center text-muted-foreground py-12">
                    <div className="text-lg font-mono mb-2">---</div>
                    <p>No messages yet</p>
                    <p className="text-sm mt-1">Send a command to get started</p>
                  </div>
                ) : (
                  sortedDesc.filter((c) => c.status !== 'running').map((cmd) => (
                    <button
                      key={cmd.id}
                      onClick={() => setSummaryCommandId(cmd.id)}
                      className="w-full px-4 py-3 flex items-center gap-3 border-b border-border active:bg-card text-left"
                    >
                      <span className={cn(
                        'w-1.5 h-1.5 rounded-full shrink-0',
                        cmd.status === 'done' ? 'bg-success' :
                        cmd.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground'
                      )} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-foreground truncate">{cmd.prompt}</div>
                        {cmd.summary && (
                          <div className="text-xs text-muted-foreground truncate mt-0.5">{cmd.summary.split('\n')[0]}</div>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(cmd.started_at)}</span>
                    </button>
                  ))
                )}
              </>
            ) : (
              /* ===== EXPERIENCE TAB ===== */
              <div>
                {/* Self-improve toggle + XP header */}
                <div className="px-4 py-3 bg-card border-b border-border">
                  <div className="flex items-center justify-end mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground">Self-improve</span>
                      <button
                        onClick={() => onSend({ type: 'agent:self-improve', agentId: agent.id, enabled: !agent.self_improve })}
                        className={cn(
                          'w-10 h-5 rounded-full relative transition-colors',
                          agent.self_improve ? 'bg-primary' : 'bg-secondary'
                        )}
                      >
                        <span className={cn(
                          'absolute top-0.5 w-4 h-4 rounded-full bg-foreground transition-transform',
                          agent.self_improve ? 'left-5' : 'left-0.5'
                        )} />
                      </button>
                    </div>
                  </div>
                  <XpBar xp={agent.xp || 0} size="lg" />
                </div>

                {/* Skills */}
                {skillsList.length > 0 && (
                  <CollapsibleSection title="Skills" count={skillsList.length} defaultOpen>
                    {skillsList.map((skill) => (
                      <div key={skill.id} className="px-4 py-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-foreground font-medium">{skill.name}</span>
                          <span className="text-[9px] text-muted-foreground">
                            {skill.times_used}x used, {Math.round(skill.avg_score)}avg
                          </span>
                        </div>
                        <Progress value={skill.avg_score} className="h-1 mt-1" />
                        <div className="text-[10px] text-muted-foreground mt-0.5 break-words">{skill.description}</div>
                      </div>
                    ))}
                  </CollapsibleSection>
                )}

                {/* Experiments */}
                <CollapsibleSection title="Experiments" count={experiments.length}>
                  <div className="px-4 pb-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowNewExperiment(!showNewExperiment)}
                      className="text-[10px] h-6 px-2 text-primary"
                    >
                      {showNewExperiment ? 'Cancel' : '+ New Experiment'}
                    </Button>
                  </div>
                  {showNewExperiment && (
                    <div className="px-4 pb-3 space-y-2">
                      <Input
                        className="h-8 text-xs"
                        placeholder="Experiment name"
                        value={newExpForm.name}
                        onChange={(e) => setNewExpForm({ ...newExpForm, name: e.target.value })}
                      />
                      <Input
                        className="h-8 text-xs"
                        placeholder="Hypothesis"
                        value={newExpForm.hypothesis}
                        onChange={(e) => setNewExpForm({ ...newExpForm, hypothesis: e.target.value })}
                      />
                      <Textarea
                        className="text-xs min-h-[60px]"
                        rows={2}
                        placeholder="Variant A text"
                        value={newExpForm.variantA}
                        onChange={(e) => setNewExpForm({ ...newExpForm, variantA: e.target.value })}
                      />
                      <Textarea
                        className="text-xs min-h-[60px]"
                        rows={2}
                        placeholder="Variant B text"
                        value={newExpForm.variantB}
                        onChange={(e) => setNewExpForm({ ...newExpForm, variantB: e.target.value })}
                      />
                      <Button
                        className="w-full"
                        size="sm"
                        onClick={() => {
                          if (newExpForm.name && newExpForm.variantA && newExpForm.variantB) {
                            onSend({
                              type: 'agent:create-experiment',
                              agentId: agent.id,
                              name: newExpForm.name,
                              hypothesis: newExpForm.hypothesis,
                              variantA: newExpForm.variantA,
                              variantB: newExpForm.variantB,
                            });
                            setNewExpForm({ name: '', hypothesis: '', variantA: '', variantB: '' });
                            setShowNewExperiment(false);
                          }
                        }}
                      >
                        Create Experiment
                      </Button>
                    </div>
                  )}
                  {experiments.map((exp) => (
                    <div key={exp.id} className="px-4 py-2.5 border-t border-border/50">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-foreground">{exp.name}</span>
                        <Badge variant={exp.status === 'running' ? 'warning' : 'success'}>
                          {exp.status}{exp.winner ? ` (${exp.winner})` : ''}
                        </Badge>
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">{exp.hypothesis}</div>
                      <div className="flex gap-4 mt-1 text-[10px]">
                        <span className="text-info">A: {exp.avg_metric_a.toFixed(1)} ({exp.runs_a})</span>
                        <span className="text-warning">B: {exp.avg_metric_b.toFixed(1)} ({exp.runs_b})</span>
                      </div>
                    </div>
                  ))}
                </CollapsibleSection>

                {/* Assessments */}
                {assessments.length > 0 && (
                  <CollapsibleSection title="Assessments" count={assessments.length}>
                    {assessments.map((a) => (
                      <div key={a.id} className="px-4 py-2.5 border-t border-border/50 flex items-center gap-3">
                        <div className={cn(
                          'text-sm font-bold',
                          a.score >= 90 ? 'text-success' :
                          a.score >= 70 ? 'text-warning' : 'text-destructive'
                        )}>{a.score}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            {a.retries > 0 && <span>{a.retries} retries</span>}
                            <span>{a.files_touched} files</span>
                            {a.duration_ms > 0 && <span>{(a.duration_ms / 1000).toFixed(0)}s</span>}
                          </div>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(a.created_at)}</span>
                      </div>
                    ))}
                  </CollapsibleSection>
                )}

                {/* Improvements */}
                {improvements.length > 0 && (
                  <CollapsibleSection title="Improvements" count={improvements.length} defaultOpen>
                    {improvements.map((imp) => (
                      <div key={imp.id} className="px-4 py-2.5 border-t border-border/50 flex items-start gap-2">
                        <span className={cn(
                          'text-xs mt-0.5 shrink-0',
                          imp.status === 'completed' ? 'text-success' :
                          imp.status === 'failed' ? 'text-destructive' :
                          imp.status === 'running' ? 'text-warning' :
                          imp.status === 'skipped' ? 'text-muted-foreground' : 'text-foreground'
                        )}>{statusIcons[imp.status]}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-foreground break-words">{imp.description}</div>
                          <div className="flex items-center gap-2 mt-1">
                            <Badge variant="muted" className={categoryColors[imp.category] || categoryColors.general}>
                              {imp.category}
                            </Badge>
                            {imp.xp_awarded > 0 && <span className="text-[9px] text-primary">+{imp.xp_awarded} XP</span>}
                          </div>
                        </div>
                        {imp.status === 'pending' && (
                          <div className="flex gap-1 shrink-0">
                            <Button
                              size="sm"
                              onClick={() => onSend({ type: 'improvement:execute', improvementId: imp.id, agentId: agent.id })}
                              className="text-[10px] h-6 px-2"
                            >
                              Run
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onSend({ type: 'improvement:skip', improvementId: imp.id })}
                              className="text-[10px] h-6 px-2"
                            >
                              Skip
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </CollapsibleSection>
                )}

                {/* Reflections */}
                {dashboard && dashboard.recent_reflections.length > 0 && (
                  <CollapsibleSection title="Reflections" count={dashboard.recent_reflections.length}>
                    {dashboard.recent_reflections.map((r) => (
                      <div key={r.id} className="px-4 py-2 border-t border-border/50">
                        {r.went_well && <div className="text-[10px] text-success mb-0.5">+ {r.went_well}</div>}
                        {r.improve && <div className="text-[10px] text-warning mb-0.5">- {r.improve}</div>}
                        {r.pattern && <div className="text-[10px] text-primary">Pattern: {r.pattern}</div>}
                        <div className="text-[9px] text-muted-foreground mt-0.5">{timeAgo(r.created_at)}</div>
                      </div>
                    ))}
                  </CollapsibleSection>
                )}

                {/* Dashboard Stats */}
                {dashboard && (
                  <CollapsibleSection title="Performance Stats">
                    <div className="px-4 py-3 grid grid-cols-2 gap-3">
                      <div className="text-center">
                        <div className="text-lg font-bold text-success">{dashboard.success_rate_10}%</div>
                        <div className="text-[9px] text-muted-foreground">Last 10</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-warning">{dashboard.success_rate_all}%</div>
                        <div className="text-[9px] text-muted-foreground">All time</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-info">{dashboard.merge_success_rate}%</div>
                        <div className="text-[9px] text-muted-foreground">Merge rate</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-foreground">{(dashboard.total_tokens / 1000).toFixed(0)}k</div>
                        <div className="text-[9px] text-muted-foreground">Tokens</div>
                      </div>
                    </div>
                    {dashboard.top_errors.length > 0 && (
                      <div className="px-4 pb-3">
                        <div className="text-[9px] text-muted-foreground mb-1">Top errors</div>
                        {dashboard.top_errors.map((e, i) => (
                          <div key={i} className="text-[10px] text-destructive flex justify-between">
                            <span className="truncate">{e.type}</span>
                            <span className="shrink-0 ml-2">{e.count}x</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CollapsibleSection>
                )}

                {/* Run Timeline */}
                {timeline.length > 0 && (
                  <CollapsibleSection title="Run Timeline" count={timeline.length}>
                    {timeline.slice(0, 10).map((run) => {
                      const isExpanded = expandedRuns.has(run.id);
                      const duration = run.totalDurationMs > 0 ? `${(run.totalDurationMs / 1000).toFixed(0)}s` : '';
                      return (
                        <div key={run.id} className="border-t border-border/50">
                          <button
                            onClick={() => {
                              const next = new Set(expandedRuns);
                              isExpanded ? next.delete(run.id) : next.add(run.id);
                              setExpandedRuns(next);
                            }}
                            className="w-full px-4 py-2.5 flex items-center gap-2 text-left active:bg-card"
                          >
                            <span className={cn(
                              'w-1.5 h-1.5 rounded-full shrink-0',
                              run.success ? 'bg-success' : 'bg-destructive'
                            )} />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-foreground font-mono truncate">{run.branch}</div>
                              <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
                                <span>{run.stages.length} stage{run.stages.length !== 1 ? 's' : ''}</span>
                                {duration && <span>{duration}</span>}
                                {run.totalTokens > 0 && <span>{(run.totalTokens / 1000).toFixed(0)}k tok</span>}
                              </div>
                            </div>
                            <span className="text-[10px] text-muted-foreground">{timeAgo(run.startedAt)}</span>
                            <span className="text-[10px] text-muted-foreground">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                          </button>
                          {isExpanded && (
                            <div className="px-4 pb-2 pl-8 space-y-1">
                              {run.stages.map((stage, i) => (
                                <div key={stage.id || i} className="flex items-center gap-2 text-[10px]">
                                  <span className={stage.success ? 'text-success' : 'text-destructive'}>
                                    {stage.success ? '\u2713' : '\u2717'}
                                  </span>
                                  <span className="text-foreground">{stage.action}</span>
                                  {stage.duration_ms > 0 && (
                                    <span className="text-muted-foreground">{(stage.duration_ms / 1000).toFixed(0)}s</span>
                                  )}
                                  {(stage.total_tokens || 0) > 0 && (
                                    <span className="text-muted-foreground">{((stage.total_tokens || 0) / 1000).toFixed(0)}k</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CollapsibleSection>
                )}

                {/* XP History */}
                {xpEvents.length > 0 && (
                  <CollapsibleSection title="XP History" count={xpEvents.length}>
                    {xpEvents.map((evt) => (
                      <div key={evt.id} className="px-4 py-2 border-t border-border/50 flex items-center gap-2">
                        <span className="text-sm font-bold text-primary shrink-0 w-8 text-right">+{evt.amount}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-foreground break-words">{evt.reason}</div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{evt.source}</Badge>
                            <span className="text-[9px] text-muted-foreground">{timeAgo(evt.created_at)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </CollapsibleSection>
                )}

                {/* Empty state */}
                {improvements.length === 0 && xpEvents.length === 0 && !dashboard && skillsList.length === 0 && assessments.length === 0 && (
                  <div className="text-center text-muted-foreground py-12">
                    <div className="text-lg font-mono mb-2">---</div>
                    <p>No experience yet</p>
                    <p className="text-sm mt-1">Complete tasks to earn XP</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* New Chat button on history view */}
          <div className="p-3 bg-card border-t border-border shrink-0">
            <Button
              onClick={handleNewChat}
              className="w-full"
            >
              + New Chat
            </Button>
          </div>
        </>
      )}

      {/* ===== VIEWING A PAST COMMAND (bubbles) ===== */}
      {viewingCommand && (
        <>
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 bg-background p-3 space-y-3">
            {/* User prompt bubble */}
            <div className="flex justify-end">
              <div className="bg-primary/20 text-foreground text-sm rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[85%] break-words">
                {viewingCommand.prompt}
                <div className="text-[10px] text-primary/60 mt-1">{timeAgo(viewingCommand.started_at)}</div>
              </div>
            </div>

            {/* Agent response bubble */}
            <div className="flex justify-start">
              <Card className="rounded-2xl rounded-bl-sm px-4 py-3 max-w-[90%] break-words">
                {viewingCommand.summary && (
                  <div className="text-sm text-foreground mb-2 whitespace-pre-wrap">{viewingCommand.summary}</div>
                )}
                {viewingCommand.raw_output ? (
                  <div className="font-mono text-xs leading-relaxed max-h-[50vh] overflow-y-auto overflow-x-hidden text-foreground">
                    <pre className="whitespace-pre-wrap break-words m-0">{viewingCommand.raw_output}</pre>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">No output recorded</p>
                )}
                <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
                  <span className={viewingCommand.status === 'done' ? 'text-success' : viewingCommand.status === 'error' ? 'text-destructive' : ''}>
                    {viewingCommand.status === 'done' ? 'Done' : viewingCommand.status === 'error' ? 'Error' : viewingCommand.status}
                  </span>
                  {viewingCommand.files_changed?.length > 0 && (
                    <span>{viewingCommand.files_changed.length} file{viewingCommand.files_changed.length !== 1 ? 's' : ''}</span>
                  )}
                  {viewingCommand.completed_at && (
                    <span className="ml-auto">{timeAgo(viewingCommand.completed_at)}</span>
                  )}
                </div>
              </Card>
            </div>
          </div>

          {/* Back to list button */}
          <div className="p-3 bg-card border-t border-border shrink-0">
            <Button
              variant="secondary"
              onClick={() => { setViewing(null); userScrolledUp.current = false; }}
              className="w-full"
            >
              Back to messages
            </Button>
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
            className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 bg-background p-3 space-y-3"
          >
            {/* User prompt bubble */}
            {runningCommand && (
              <div className="flex justify-end">
                <div className="bg-primary/20 text-foreground text-sm rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[85%] break-words">
                  {runningCommand.prompt}
                </div>
              </div>
            )}

            {/* Agent response bubble */}
            <div className="flex justify-start">
              <Card className="rounded-2xl rounded-bl-sm px-4 py-3 max-w-[90%] break-words">
                {isRunning && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-warning">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
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
                  <div className="text-xs text-muted-foreground italic">Waiting for output...</div>
                )}
                {!isRunning && lines.length > 0 && (
                  <>
                    <Separator className="my-2" />
                    <div className={cn(
                      'text-xs',
                      agent.status === 'idle' ? 'text-success' : 'text-destructive'
                    )}>
                      {agent.status === 'idle' ? 'Task complete' : agent.status === 'error' ? 'Task failed' : 'Stopped'}
                    </div>
                  </>
                )}
              </Card>
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
