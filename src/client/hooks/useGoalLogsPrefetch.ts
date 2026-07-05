import { useEffect } from 'react';
import { useOnReconnect } from './useReconnect';
import type { WSClientMessage } from '../lib/types';

/**
 * Batch-fetch recent goal_log entries for a set of goals on mount and after a
 * reconnect. Powers the fleet Activity feed and keeps collapsed GoalCard budget
 * bars accurate before a goal is first expanded (KNOWN-ISSUES: budget reads $0
 * until first expand). `goalIds` should already be capped to active goals.
 */
export function useGoalLogsPrefetch(
  onSend: (msg: WSClientMessage) => void,
  goalIds: string[],
  limit = 15
): void {
  const key = goalIds.join(',');

  const fetchAll = () => {
    for (const goalId of goalIds) {
      onSend({ type: 'goal:log', goalId, limit });
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onSend, limit]);

  useOnReconnect(fetchAll);
}
