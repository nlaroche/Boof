import { useMemo } from 'react';
import type { Agent, Goal } from './types';

export function useEntityMap<T extends { id: string; name: string }>(entities: T[]): Record<string, string> {
  return useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of entities) map[e.id] = e.name;
    return map;
  }, [entities]);
}

export function lookupName(map: Record<string, string>, id: string): string {
  return map[id] || id.slice(0, 8);
}
