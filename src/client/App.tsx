import { useEffect, Component, type ReactNode } from 'react';
import { useStore } from './stores/store';
import { useWebSocket } from './hooks/useWebSocket';
import { BottomNav } from './components/BottomNav';
import { HomeScreen } from './screens/HomeScreen';
import { TasksScreen } from './screens/TasksScreen';
import { AgentScreen } from './screens/AgentScreen';
import { AgentsScreen } from './screens/AgentsScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { GoalsScreen } from './screens/GoalsScreen';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: `${error.message}\n${error.stack}` };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ color: 'red', padding: 20, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          <h2>Render Error</h2>
          <pre>{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const activeScreen = useStore((s) => s.ui.activeScreen);
  const { send, connected } = useWebSocket();

  const handleSendToAgent = (agentId: string, prompt: string) => {
    send({ type: 'agent:send', agentId, prompt });
  };

  // Track visual viewport for keyboard awareness
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    };
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return (
    <div className="h-[100dvh] flex flex-col bg-[#0a0a0f] text-[#e2e2ef] font-[Inter,sans-serif]">
      {/* Connection banner */}
      {!connected && (
        <div className="bg-[#f59e0b]/20 text-[#f59e0b] text-center text-sm py-2 shrink-0">
          Reconnecting...
        </div>
      )}

      {/* Screen router */}
      <div className={`flex-1 ${activeScreen === 'agent' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        <ErrorBoundary>
          {activeScreen === 'home' && <HomeScreen onSendToAgent={handleSendToAgent} />}
          {activeScreen === 'goals' && <GoalsScreen onSend={send} />}
          {activeScreen === 'tasks' && <TasksScreen onSend={send} />}
          {activeScreen === 'agent' && <AgentScreen onSend={send} />}
          {activeScreen === 'agents' && <AgentsScreen onSend={send} />}
          {activeScreen === 'history' && <HistoryScreen />}
        </ErrorBoundary>
      </div>

      {/* Bottom nav (hide on agent detail screen) */}
      {activeScreen !== 'agent' && <BottomNav />}
    </div>
  );
}
