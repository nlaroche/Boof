import { useEffect } from 'react';
import { useStore, type UIState } from '../stores/store';

interface NavState {
  screen: UIState['activeScreen'];
  agentId: string | null;
}

function keyOf(s: NavState): string {
  return `${s.screen}|${s.agentId ?? ''}`;
}

/**
 * Mirrors the store's active screen (+ selected agent) into the browser
 * history stack so the Android/browser back button navigates within the PWA
 * instead of exiting it. Each screen change pushes an entry; popstate replays
 * the entry back into the store.
 *
 * Synchronous multi-set navigations (e.g. selectedAgentId + activeScreen when
 * opening an agent) are coalesced via a microtask so they yield one entry.
 */
export function useHistoryNav(): void {
  useEffect(() => {
    const ui = useStore.getState().ui;
    let lastKey = keyOf({ screen: ui.activeScreen, agentId: ui.selectedAgentId });
    let scheduled = false;

    // Seed the initial entry so popstate always has a state object to read.
    window.history.replaceState(
      { screen: ui.activeScreen, agentId: ui.selectedAgentId },
      ''
    );

    const schedulePush = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const cur = useStore.getState().ui;
        const key = keyOf({ screen: cur.activeScreen, agentId: cur.selectedAgentId });
        // Skip when nothing changed or when the change came from a popstate
        // replay (lastKey was pre-set to the popped entry).
        if (key === lastKey) return;
        lastKey = key;
        window.history.pushState(
          { screen: cur.activeScreen, agentId: cur.selectedAgentId },
          ''
        );
      });
    };

    const unsub = useStore.subscribe((state, prev) => {
      if (
        state.ui.activeScreen !== prev.ui.activeScreen ||
        state.ui.selectedAgentId !== prev.ui.selectedAgentId
      ) {
        schedulePush();
      }
    });

    const onPop = (e: PopStateEvent) => {
      const st = (e.state as NavState | null) ?? { screen: 'home', agentId: null };
      // Pre-set lastKey so the store updates below don't echo a fresh push.
      lastKey = keyOf(st);
      const s = useStore.getState();
      s.setSelectedAgentId(st.agentId ?? null);
      s.setActiveScreen(st.screen);
    };

    window.addEventListener('popstate', onPop);
    return () => {
      unsub();
      window.removeEventListener('popstate', onPop);
    };
  }, []);
}
