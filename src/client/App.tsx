import { useStore } from './stores/store';
import { useWebSocket } from './hooks/useWebSocket';
import { BottomNav } from './components/BottomNav';
import { HomeScreen } from './screens/HomeScreen';
import { TasksScreen } from './screens/TasksScreen';
import { AgentScreen } from './screens/AgentScreen';
import { AgentsScreen } from './screens/AgentsScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { GoalsScreen } from './screens/GoalsScreen';

export function App() {
  const activeScreen = useStore((s) => s.ui.activeScreen);
  const { send, connected } = useWebSocket();

  const handleSendToAgent = (agentId: string, prompt: string) => {
    send({ type: 'agent:send', agentId, prompt });
  };

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#e2e2ef] font-[Inter,sans-serif]">
      {/* Connection banner */}
      {!connected && (
        <div className="fixed top-0 left-0 right-0 bg-[#f59e0b]/20 text-[#f59e0b] text-center text-sm py-2 z-50">
          Reconnecting...
        </div>
      )}

      {/* Screen router */}
      {activeScreen === 'home' && <HomeScreen onSendToAgent={handleSendToAgent} />}
      {activeScreen === 'goals' && <GoalsScreen onSend={send} />}
      {activeScreen === 'tasks' && <TasksScreen onSend={send} />}
      {activeScreen === 'agent' && <AgentScreen onSend={send} />}
      {activeScreen === 'agents' && <AgentsScreen onSend={send} />}
      {activeScreen === 'history' && <HistoryScreen />}

      {/* Bottom nav (hide on agent detail screen) */}
      {activeScreen !== 'agent' && <BottomNav />}
    </div>
  );
}
