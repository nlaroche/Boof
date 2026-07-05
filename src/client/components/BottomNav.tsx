import { useStore } from '../stores/store';
import { useAttention } from '../hooks/useAttention';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

const tabs = [
  { id: 'home' as const, label: 'Home', icon: '~' },
  { id: 'projects' as const, label: 'Projects', icon: '[]' },
  { id: 'goals' as const, label: 'Goals', icon: '*' },
  { id: 'agents' as const, label: 'Agents', icon: '>' },
  { id: 'history' as const, label: 'History', icon: '%' },
];

export function BottomNav() {
  const activeScreen = useStore((s) => s.ui.activeScreen);
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const navAlerts = useStore((s) => s.navAlerts);
  const { counts } = useAttention();

  const badgeFor = (id: string): number => {
    if (id === 'goals') return counts.goals;
    if (id === 'agents') return counts.agents + (navAlerts.agents || 0);
    return 0;
  };

  return (
    <nav className="bg-card border-t border-border pb-[env(safe-area-inset-bottom)] z-50 shrink-0">
      <div className="flex justify-around items-center h-16">
        {tabs.map((tab) => {
          const isActive = activeScreen === tab.id;
          const badge = badgeFor(tab.id);
          return (
            <Button
              key={tab.id}
              variant="ghost"
              onClick={() => setActiveScreen(tab.id)}
              className={cn(
                'relative flex flex-col items-center justify-center min-w-[64px] min-h-[48px] h-auto gap-0 rounded-lg',
                isActive
                  ? 'text-primary bg-primary/10 hover:bg-primary/15 hover:text-primary'
                  : 'text-muted-foreground'
              )}
            >
              {badge > 0 && (
                <span className="absolute top-1 right-3 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center leading-none">
                  {badge > 9 ? '9+' : badge}
                </span>
              )}
              <span className="text-base font-mono leading-none">{tab.icon}</span>
              <span className="text-xs mt-0.5">{tab.label}</span>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}
