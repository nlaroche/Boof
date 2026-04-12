import type { Agent, MergeGate, ReviewFinding, AuditRecord } from './types';

// ── Badge variant maps ──

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'muted' | 'destructive';

export const MERGE_GATE_STATUS_VARIANT: Record<MergeGate['status'], BadgeVariant> = {
  pending: 'muted',
  consolidating: 'default',
  reviewing: 'default',
  revising: 'warning',
  testing: 'default',
  healing: 'warning',
  approved: 'success',
  merging: 'default',
  merged: 'success',
  failed: 'destructive',
};

export const REVIEW_SEVERITY_VARIANT: Record<ReviewFinding['severity'], BadgeVariant> = {
  critical: 'destructive',
  warning: 'warning',
  info: 'default',
  suggestion: 'muted',
};

export const AUDIT_OUTCOME_VARIANT: Record<AuditRecord['outcome'], BadgeVariant> = {
  success: 'success',
  failure: 'destructive',
  timeout: 'warning',
  escalated: 'warning',
};

export const EXPERIMENT_STATUS_VARIANT: Record<string, BadgeVariant> = {
  proposed: 'muted',
  queued: 'muted',
  running: 'default',
  analyzing: 'default',
  promoted: 'success',
  rolled_back: 'destructive',
  inconclusive: 'warning',
  archived: 'secondary',
};

// ── Pipeline FSM ──

export const PIPELINE_STATES = [
  'pending',
  'consolidating',
  'reviewing',
  'revising',
  'testing',
  'healing',
  'approved',
  'merging',
  'merged',
] as const;

export type PipelineState = typeof PIPELINE_STATES[number];
