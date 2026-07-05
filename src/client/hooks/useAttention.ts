import { useMemo } from 'react';
import { useStore } from '../stores/store';
import type { MergeGate, Goal, Agent, ReviewFinding } from '../lib/types';

export interface AttentionData {
  approvedGates: MergeGate[];
  failedGates: MergeGate[];
  brokenAgents: Agent[];
  pausedGoals: Goal[];
  proposedGoals: Goal[];
  criticalFindings: ReviewFinding[];
  counts: {
    /** Goals-tab badge: pending proposals + gates awaiting a manual merge. */
    goals: number;
    /** Agents-tab badge: agents in error/dead. */
    agents: number;
    /** Total number of things needing attention (drives collapse). */
    total: number;
  };
}

/**
 * Single source of truth for "what needs a human right now", shared by the
 * Needs Attention strip and the BottomNav badges so they never disagree.
 */
export function useAttention(): AttentionData {
  const mergeGates = useStore((s) => s.mergeGates);
  const goals = useStore((s) => s.goals);
  const agents = useStore((s) => s.agents);
  const reviewFindings = useStore((s) => s.reviewFindings);

  return useMemo(() => {
    const approvedGates = mergeGates.filter((g) => g.status === 'approved');
    const failedGates = mergeGates.filter((g) => g.status === 'failed');
    const brokenAgents = agents.filter((a) => a.status === 'error' || a.status === 'dead');
    const pausedGoals = goals.filter((g) => g.status === 'paused');
    const proposedGoals = goals.filter((g) => g.proposal_status === 'pending');
    const criticalFindings = Object.values(reviewFindings)
      .flat()
      .filter((f) => f.severity === 'critical' && !f.resolved);

    const total =
      approvedGates.length +
      failedGates.length +
      brokenAgents.length +
      pausedGoals.length +
      proposedGoals.length +
      (criticalFindings.length > 0 ? 1 : 0);

    return {
      approvedGates,
      failedGates,
      brokenAgents,
      pausedGoals,
      proposedGoals,
      criticalFindings,
      counts: {
        goals: proposedGoals.length + approvedGates.length,
        agents: brokenAgents.length,
        total,
      },
    };
  }, [mergeGates, goals, agents, reviewFindings]);
}
