import { useState, useEffect } from 'react';

const DESKTOP_BREAKPOINT = 768;
const WIDE_DESKTOP_BREAKPOINT = 1280;

function useMediaQuery(breakpoint: number): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(min-width: ${breakpoint}px)`).matches;
  });

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);

  return matches;
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_BREAKPOINT);
}

export function useIsWideDesktop(): boolean {
  return useMediaQuery(WIDE_DESKTOP_BREAKPOINT);
}
