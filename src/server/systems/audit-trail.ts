/**
 * Hash-chained audit trail system for merge gate operations.
 *
 * Inspired by IETF Agent Audit Trail (AAT) draft.
 * Each record includes prev_hash (SHA-256 of previous record) for tamper-evidence.
 */
import { createHash, randomUUID } from 'crypto';
import { insertAuditRecord, getAuditRecords, getLastAuditRecord } from '../db-helpers.js';
import type { AuditRecord } from '../../client/lib/types.js';
import type { AuditActionTypeType, AuditOutcomeType } from '../engine/constants.js';

// Genesis hash — used as prev_hash for the first record in a chain
const GENESIS_HASH = createHash('sha256').update('boof-audit-genesis').digest('hex');

/**
 * Compute the SHA-256 hash of an audit record for chain integrity.
 * Uses canonical JSON (sorted keys) per RFC 8785.
 */
function hashRecord(record: AuditRecord): string {
  const canonical = JSON.stringify({
    action_detail: record.action_detail,
    action_type: record.action_type,
    agent_id: record.agent_id,
    confidence: record.confidence,
    cost_usd: record.cost_usd,
    duration_ms: record.duration_ms,
    goal_id: record.goal_id,
    id: record.id,
    merge_gate_id: record.merge_gate_id,
    outcome: record.outcome,
    prev_hash: record.prev_hash,
    session_id: record.session_id,
    timestamp: record.timestamp,
    tokens_used: record.tokens_used,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface AppendAuditInput {
  agentId: string;
  mergeGateId?: string;
  goalId?: string;
  sessionId?: string;
  actionType: AuditActionTypeType;
  actionDetail: Record<string, unknown>;
  outcome: AuditOutcomeType;
  confidence?: number;
  durationMs?: number;
  tokensUsed?: number;
  costUsd?: number;
}

/**
 * Append a new audit record to the chain.
 * Automatically computes prev_hash from the last record in this merge gate's chain.
 * Returns the new record's ID.
 */
export function appendAuditRecord(input: AppendAuditInput): string {
  const id = randomUUID();
  const timestamp = new Date().toISOString();

  // Get the hash of the previous record in this chain
  let prevHash = GENESIS_HASH;
  if (input.mergeGateId) {
    const lastRecord = getLastAuditRecord(input.mergeGateId);
    if (lastRecord) {
      prevHash = hashRecord(lastRecord);
    }
  }

  const record: Omit<AuditRecord, 'created_at'> = {
    id,
    prev_hash: prevHash,
    timestamp,
    agent_id: input.agentId,
    session_id: input.sessionId ?? null,
    merge_gate_id: input.mergeGateId ?? null,
    goal_id: input.goalId ?? null,
    action_type: input.actionType as AuditRecord['action_type'],
    action_detail: JSON.stringify(input.actionDetail),
    outcome: input.outcome as AuditRecord['outcome'],
    confidence: input.confidence ?? null,
    duration_ms: input.durationMs ?? null,
    tokens_used: input.tokensUsed ?? null,
    cost_usd: input.costUsd ?? null,
  };

  insertAuditRecord(record);
  console.log(`[audit] ${input.actionType}:${input.outcome} gate=${input.mergeGateId ?? 'none'} id=${id}`);
  return id;
}

/**
 * Verify the integrity of an audit chain for a merge gate.
 * Walks the chain and checks each prev_hash against the actual hash of the previous record.
 */
export function verifyAuditChain(mergeGateId: string): { valid: boolean; brokenAt?: string; recordCount: number } {
  const records = getAuditRecords(mergeGateId);
  if (records.length === 0) {
    return { valid: true, recordCount: 0 };
  }

  // First record should have genesis hash
  if (records[0].prev_hash !== GENESIS_HASH) {
    return { valid: false, brokenAt: records[0].id, recordCount: records.length };
  }

  // Walk the chain
  for (let i = 1; i < records.length; i++) {
    const expectedHash = hashRecord(records[i - 1]);
    if (records[i].prev_hash !== expectedHash) {
      return { valid: false, brokenAt: records[i].id, recordCount: records.length };
    }
  }

  return { valid: true, recordCount: records.length };
}

/**
 * Get the full audit trail for a merge gate, with parsed action details.
 */
export function getAuditTrail(mergeGateId: string): Array<AuditRecord & { parsedDetail: Record<string, unknown> }> {
  const records = getAuditRecords(mergeGateId);
  return records.map(r => ({
    ...r,
    parsedDetail: typeof r.action_detail === 'string' ? JSON.parse(r.action_detail) : r.action_detail,
  }));
}

/**
 * Get a summary of audit activity for a merge gate.
 */
export function getAuditSummary(mergeGateId: string): {
  totalRecords: number;
  actionCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  chainValid: boolean;
} {
  const records = getAuditRecords(mergeGateId);
  const actionCounts: Record<string, number> = {};
  const outcomeCounts: Record<string, number> = {};
  let totalDurationMs = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const r of records) {
    actionCounts[r.action_type] = (actionCounts[r.action_type] || 0) + 1;
    outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] || 0) + 1;
    totalDurationMs += r.duration_ms ?? 0;
    totalTokens += r.tokens_used ?? 0;
    totalCostUsd += r.cost_usd ?? 0;
  }

  const { valid } = verifyAuditChain(mergeGateId);

  return {
    totalRecords: records.length,
    actionCounts,
    outcomeCounts,
    totalDurationMs,
    totalTokens,
    totalCostUsd,
    chainValid: valid,
  };
}
