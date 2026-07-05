import { useEffect, useState } from 'react';

/**
 * Returns a periodically-updating `Date.now()` so "Working… 14m" style elapsed
 * timers tick without a prop change. Only runs the interval when `active`.
 */
export function useNow(active: boolean, intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
