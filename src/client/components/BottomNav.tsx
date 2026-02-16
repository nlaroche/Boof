import { useStore } from '../stores/store';

const tabs = [
  { id: 'home' as const, label: 'Home', icon: '~' },
  { id: 'goals' as const, label: 'Goals', icon: '*' },
  { id: 'tasks' as const, label: 'Tasks', icon: '#' },
  { id: 'agents' as const, label: 'Agents', icon: '>' },
  { id: 'history' as const, label: 'History', icon: '%' },
];

export function BottomNav() {
  const activeScreen = useStore((s) => s.ui.activeScreen);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  return (
    <nav className="bg-[#14141f] border-t border-[#1e1e2e] pb-[env(safe-area-inset-bottom)] z-50 shrink-0">
      <div className="flex justify-around items-center h-16">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveScreen(tab.id)}
            className={`relative flex flex-col items-center justify-center min-w-[64px] min-h-[48px] rounded-lg transition-colors ${
              activeScreen === tab.id
                ? 'text-[#7c5bf5]'
                : 'text-[#6b6b80] active:text-[#e2e2ef]'
            }`}
          >
            <span className="text-base font-mono leading-none">{tab.icon}</span>
            {activeScreen === tab.id && (
              <span className="absolute top-6 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#a78bfa]" />
            )}
            <span className="text-xs mt-0.5">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
