import { useEffect, useRef } from 'react';

// Module-level pub/sub so any screen can re-fetch its mount data when the
// WebSocket reconnects (phone resume / network flap). useWebSocket lives once
// in App, so we bridge through this bus rather than prop-drilling a callback.
type Cb = () => void;
const listeners = new Set<Cb>();

export function onReconnect(cb: Cb): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitReconnect(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (e) {
      console.error('[useReconnect] listener failed:', (e as Error).message);
    }
  }
}

/** Run `cb` whenever the socket reconnects (not on first connect). */
export function useOnReconnect(cb: Cb): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onReconnect(() => ref.current()), []);
}
