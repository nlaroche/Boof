import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useStore } from '../stores/store';
import { emitReconnect } from './useReconnect';
import { showServerNotify } from '../lib/notify';
import type { WSClientMessage, WSServerMessage } from '../lib/types';

// Map an agentId to the nav target whose badge should light up for its alerts.
const NOTIFY_NAV_TARGET = 'agents';
const MAX_QUEUE = 50;

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backoff = useRef(1000);
  const disposed = useRef(false);
  const firstConnect = useRef(true);
  // Messages attempted while the socket is down — flushed on reopen.
  const queue = useRef<WSClientMessage[]>([]);

  const connect = useCallback(() => {
    // Don't open a second socket if one is already connecting/open.
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      backoff.current = 1000;
      const isReconnect = !firstConnect.current;
      firstConnect.current = false;

      // Clear any buffered live output BEFORE requesting sync so the server's
      // replay doesn't append duplicates on top of what we already have.
      useStore.getState().resetOutputs();

      ws.send(JSON.stringify({ type: 'sync:request' }));
      ws.send(JSON.stringify({ type: 'global:skills' }));
      ws.send(JSON.stringify({ type: 'global:stats' }));
      ws.send(JSON.stringify({ type: 'global:learnings', limit: 10 }));

      // Flush queued sends.
      const pending = queue.current;
      queue.current = [];
      for (const m of pending) {
        try {
          ws.send(JSON.stringify(m));
        } catch (e) {
          console.error('[ws] flush failed:', (e as Error).message);
        }
      }

      // Let screens re-fetch their scoped mount data after a reconnect.
      if (isReconnect) emitReconnect();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSServerMessage;
        const s = useStore.getState();

        switch (msg.type) {
          case 'sync:state':
            s.setFolders(msg.folders);
            s.setTasks(msg.tasks);
            s.setAgents(msg.agents);
            s.setGoals(msg.goals);
            s.setWorkflows(msg.workflows);
            s.setProjects(msg.projects || []);
            if (msg.commands) {
              s.setCommands(msg.commands);
            }
            // Merge gates travel with sync so Needs Attention is populated on load/reconnect.
            if (msg.mergeGates) {
              s.setMergeGates(msg.mergeGates);
            }
            break;
          case 'agent:output':
            s.appendOutput(msg.agentId, msg.chunk);
            break;
          case 'agent:updated':
            s.updateAgent(msg.agent);
            break;
          case 'agent:deleted':
            s.removeAgent(msg.agentId);
            break;
          case 'agent:status':
            s.setAgentStatus(msg.agentId, msg.status);
            break;
          case 'repos:list':
            s.setRepos(msg.repos);
            break;
          case 'agent:history':
            s.mergeCommands(msg.agentId, msg.commands);
            break;
          case 'task:updated':
            s.updateTask(msg.task);
            break;
          case 'task:deleted':
            s.removeTask(msg.taskId);
            break;
          case 'folder:updated':
            s.updateFolder(msg.folder);
            break;
          case 'folder:deleted':
            s.removeFolder(msg.folderId);
            break;
          case 'command:updated':
            s.upsertCommand(msg.command);
            break;
          case 'agent:summary':
            s.updateCommand(msg.commandId, {
              summary: msg.summary,
              files_changed: msg.filesChanged,
              status: 'done',
            });
            break;
          case 'notify':
            showServerNotify(msg.title, msg.body);
            s.bumpNavAlert(NOTIFY_NAV_TARGET);
            break;
          case 'agent:activity':
            s.setAgentActivity(msg.agentId, msg.entries);
            break;
          case 'goal:updated':
            s.updateGoal(msg.goal);
            break;
          case 'goal:proposed':
            s.updateGoal(msg.goal);
            break;
          case 'goal:deleted':
            s.removeGoal(msg.goalId);
            break;
          case 'goal:list':
            s.setGoals(msg.goals);
            break;
          case 'goal:log':
            s.setGoalLog(msg.goalId, msg.entries);
            break;
          case 'goal:log:entry':
            s.addGoalLogEntry(msg.entry);
            break;
          case 'goal:stats':
            s.setGoalStats(msg.goalId, msg.stats);
            break;
          case 'workflow:updated':
            s.updateWorkflow(msg.workflow);
            break;
          case 'workflow:deleted':
            s.removeWorkflow(msg.workflowId);
            break;
          case 'workflow:list':
            s.setWorkflows(msg.workflows);
            break;
          case 'agent:improvements':
            s.setAgentImprovements(msg.agentId, msg.improvements);
            break;
          case 'agent:assessments':
            s.setAgentAssessments(msg.agentId, msg.assessments);
            break;
          case 'improvement:updated':
            s.updateImprovement(msg.improvement);
            break;
          case 'agent:xp': {
            // Guard: a stray xp event for an unknown agent must not inject a
            // ghost agent record (all other fields would be undefined).
            const existing = s.agents.find((a) => a.id === msg.agentId);
            if (!existing) break;
            s.updateAgent({ ...existing, xp: msg.xp });
            if (msg.event) s.addXpEvent(msg.agentId, msg.event);
            break;
          }
          case 'agent:xp-events':
            s.setAgentXpEvents(msg.agentId, msg.events);
            break;
          case 'agent:branches':
            s.setAgentBranches(msg.agentId, msg.branches);
            break;
          case 'agent:branch-merged':
            if (msg.success) {
              // Remove the merged branch from the list
              const current = s.agentBranches[msg.agentId] || [];
              s.setAgentBranches(msg.agentId, current.filter(b => b !== msg.branchName));
            }
            break;
          case 'agent:branch-discarded':
            {
              const cur = s.agentBranches[msg.agentId] || [];
              s.setAgentBranches(msg.agentId, cur.filter(b => b !== msg.branchName));
            }
            break;
          case 'agent:dashboard':
            s.setAgentDashboard(msg.agentId, msg.data);
            break;
          case 'agent:skills':
            s.setAgentSkillsList(msg.agentId, msg.skills);
            break;
          case 'agent:experiments':
            s.setAgentExperiments(msg.agentId, msg.experiments);
            break;
          case 'agent:timeline':
            s.setAgentTimeline(msg.agentId, msg.runs);
            break;
          case 'goal:completed':
            s.updateGoal(msg.goal);
            toast.success(`Goal completed: ${msg.goal.name}`);
            break;
          case 'goal:switched':
            s.updateGoal(msg.goal);
            break;
          case 'goal:proposed-auto':
            for (const g of msg.goals) s.updateGoal(g);
            break;
          case 'project:updated':
            s.updateProject(msg.project);
            break;
          case 'project:deleted':
            s.removeProject(msg.projectId);
            break;
          case 'project:list':
            s.setProjects(msg.projects);
            break;
          case 'project:repos':
            s.setProjectRepos(msg.projectId, msg.repos);
            break;
          case 'project:goals':
            // Goals are already in the main goals list; this is for filtering
            break;
          case 'global:skills:result':
            s.setGlobalSkills(msg.skills);
            break;
          case 'global:stats:result':
            s.setGlobalStats(msg.stats);
            break;
          case 'global:learnings:result':
            s.setRecentLearnings(msg.learnings);
            break;
          case 'project:skills:result':
            s.setProjectSkills(msg.projectId, msg.skills);
            break;
          // Merge Gates
          case 'mergeGate:list':
            s.setMergeGates(msg.gates);
            break;
          case 'mergeGate:get':
            s.updateMergeGate(msg.gate);
            break;
          case 'mergeGate:updated':
            s.updateMergeGate(msg.gate);
            // Only surface the states that need a human's eyes — a gate emits
            // ~8 FSM transitions per run and toasting each is noise.
            if (msg.gate.status === 'approved') {
              toast.success(`Ready to merge: ${msg.gate.goal_branch}`);
            } else if (msg.gate.status === 'merged') {
              toast.success(`Merged: ${msg.gate.goal_branch} → ${msg.gate.target_branch}`);
            } else if (msg.gate.status === 'failed') {
              toast.error(`Merge gate failed: ${msg.gate.goal_branch}`);
            }
            break;
          // Review Findings
          case 'reviewFindings:list':
            s.setReviewFindings(msg.mergeGateId, msg.findings);
            break;
          case 'reviewFinding:updated': {
            const gateFindings = s.reviewFindings[msg.finding.merge_gate_id] || [];
            const idx = gateFindings.findIndex(f => f.id === msg.finding.id);
            if (idx >= 0) {
              const updated = [...gateFindings];
              updated[idx] = msg.finding;
              s.setReviewFindings(msg.finding.merge_gate_id, updated);
            } else {
              s.setReviewFindings(msg.finding.merge_gate_id, [...gateFindings, msg.finding]);
            }
            break;
          }
          // Audit Trail
          case 'audit:list':
            s.setAuditRecords(msg.key, msg.records);
            break;
          // Research
          case 'research:list':
            for (const r of msg.research) {
              s.setTaskResearch(r.task_id, r);
            }
            // Ensure the loading flag clears even when there is no research yet.
            s.setLoading('research', false);
            break;
          case 'research:result':
            s.setTaskResearch(msg.taskId, msg.research);
            break;
          // Agent Memory
          case 'agentMemory:patterns':
            s.setAgentPatterns(msg.agentId, msg.patterns);
            break;
          case 'agentMemory:fixes':
            s.setAgentFixes(msg.agentId, msg.fixes);
            break;
          // Experiment Records
          case 'experimentRecords:list':
            s.setExperimentRecords(msg.experiments);
            break;
          case 'experimentRecords:runs':
            s.setExperimentRuns(msg.experimentId, msg.runs);
            break;
          case 'experimentRecord:updated':
            s.updateExperimentRecord(msg.experiment);
            break;
          // Guidelines — store integration for existing server messages
          case 'guidelines:list':
            s.setGuidelines(msg.repoPath, msg.guidelines);
            break;
          case 'guidelines:updated':
            s.updateGuideline(msg.guideline);
            break;
          case 'guidelines:deleted':
            s.removeGuideline(msg.guidelineId);
            break;
          case 'guidelines:scanned':
            s.setGuidelines(msg.repoPath, msg.proposed);
            break;
          case 'guidelines:deep-scan:result':
            s.setGuidelines(msg.repoPath, msg.guidelines);
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (disposed.current) return; // unmounted — don't resurrect a zombie timer
      reconnectTimer.current = setTimeout(() => {
        backoff.current = Math.min(backoff.current * 2, 30000);
        connect();
      }, backoff.current);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  // Reconnect immediately (cancel any pending backoff) — used on app resume
  // and network-online, when a phone's socket is likely already dead.
  const reconnectNow = useCallback(() => {
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = undefined;
    }
    backoff.current = 1000;
    connect();
  }, [connect]);

  useEffect(() => {
    disposed.current = false;
    connect();

    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    const onOnline = () => reconnectNow();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      disposed.current = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect, reconnectNow]);

  const send = useCallback((msg: WSClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    // Socket down: queue so taps (Approve / Merge / Stop) aren't silently lost.
    if (queue.current.length >= MAX_QUEUE) {
      toast.error('Still offline — some queued actions were dropped');
      return;
    }
    queue.current.push(msg);
  }, []);

  return { send, connected };
}
