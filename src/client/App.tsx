import { useEffect, Component, type ReactNode } from 'react';
import { useStore } from './stores/store';
import { useWebSocket } from './hooks/useWebSocket';
import { useIsDesktop, useIsWideDesktop } from './hooks/useIsDesktop';
import { BottomNav } from './components/BottomNav';
import { SideNav } from './components/SideNav';
import { StatusBar } from './components/StatusBar';
import { ContextPanel } from './components/ContextPanel';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { CommandPalette } from './components/CommandPalette';
import { HomeScreen } from './screens/HomeScreen';
import { TasksScreen } from './screens/TasksScreen';
import { AgentScreen } from './screens/AgentScreen';
import { AgentsScreen } from './screens/AgentsScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { GoalsScreen } from './screens/GoalsScreen';
import { ProjectsScreen } from './screens/ProjectsScreen';
import { DashboardScreen } from './screens/DashboardScreen';
import { PipelineScreen } from './screens/PipelineScreen';
import { ReviewsScreen } from './screens/ReviewsScreen';
import { AuditScreen } from './screens/AuditScreen';
import { ResearchScreen } from './screens/ResearchScreen';
import { MemoryScreen } from './screens/MemoryScreen';
import { AnalyticsScreen } from './screens/AnalyticsScreen';

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

function ScreenRouter({ send, onSendToAgent, isDesktop }: { send: (msg: any) => void; onSendToAgent: (agentId: string, prompt: string) => void; isDesktop: boolean }) {
  const activeScreen = useStore((s) => s.ui.activeScreen);

  switch (activeScreen) {
    case 'home':
      return isDesktop
        ? <DashboardScreen onSend={send} onSendToAgent={onSendToAgent} />
        : <HomeScreen onSendToAgent={onSendToAgent} />;
    case 'dashboard':
      return <DashboardScreen onSend={send} onSendToAgent={onSendToAgent} />;
    case 'goals':
      return <GoalsScreen onSend={send} />;
    case 'tasks':
      return <TasksScreen onSend={send} />;
    case 'agent':
      return <AgentScreen onSend={send} />;
    case 'agents':
      return <AgentsScreen onSend={send} />;
    case 'history':
      return <HistoryScreen />;
    case 'projects':
      return <ProjectsScreen onSend={send} />;
    // New system screens
    case 'pipeline':
      return <PipelineScreen onSend={send} />;
    case 'reviews':
      return <ReviewsScreen onSend={send} />;
    case 'audit':
      return <AuditScreen onSend={send} />;
    case 'research':
      return <ResearchScreen onSend={send} />;
    case 'memory':
      return <MemoryScreen onSend={send} />;
    case 'analytics':
      return <AnalyticsScreen onSend={send} />;
    default:
      return <HomeScreen onSendToAgent={onSendToAgent} />;
  }
}

export function App() {
  const activeScreen = useStore((s) => s.ui.activeScreen);
  const contextPanel = useStore((s) => s.ui.contextPanel);
  const { send, connected } = useWebSocket();
  const isDesktop = useIsDesktop();
  const isWideDesktop = useIsWideDesktop();

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
    <TooltipProvider>
      <div className="h-[100dvh] flex flex-col bg-background text-foreground font-sans">
        {isDesktop ? (
          /* Desktop layout */
          <>
            {/* Status bar — desktop only */}
            <StatusBar connected={connected} />

            {/* Main area: SideNav + Content + optional ContextPanel */}
            <div className="flex-1 flex overflow-hidden">
              <SideNav />
              <div className={`flex-1 ${activeScreen === 'agent' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
                <ErrorBoundary>
                  <ScreenRouter send={send} onSendToAgent={handleSendToAgent} isDesktop={isDesktop} />
                </ErrorBoundary>
              </div>
              {/* Context panel on wide desktop */}
              {isWideDesktop && contextPanel.open && <ContextPanel />}
            </div>
          </>
        ) : (
          /* Mobile layout — unchanged */
          <>
            {/* Connection banner — mobile only */}
            {!connected && (
              <div className="bg-warning/20 text-warning text-center text-sm py-2 shrink-0">
                Reconnecting...
              </div>
            )}
            <div className={`flex-1 ${activeScreen === 'agent' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
              <ErrorBoundary>
                <ScreenRouter send={send} onSendToAgent={handleSendToAgent} isDesktop={isDesktop} />
              </ErrorBoundary>
            </div>
            {activeScreen !== 'agent' && <BottomNav />}
          </>
        )}

        <Toaster />
        {isDesktop && <CommandPalette />}
      </div>
    </TooltipProvider>
  );
}
