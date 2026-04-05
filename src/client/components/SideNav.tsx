import { useStore } from '../stores/store';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { cn } from '@/lib/utils';

const navItems = [
  { id: 'dashboard' as const, label: 'Dashboard', icon: '~' },
  { id: 'projects' as const, label: 'Projects', icon: '[]' },
  { id: 'goals' as const, label: 'Goals', icon: '*' },
  { id: 'tasks' as const, label: 'Tasks', icon: '#' },
  { id: 'agents' as const, label: 'Agents', icon: '>' },
  { id: 'history' as const, label: 'History', icon: '%' },
];

export function SideNav() {
  const activeScreen = useStore((s) => s.ui.activeScreen);
  const setActiveScreen = useStore((s) => s.setActiveScreen);

  return (
    <nav className="w-56 bg-background border-r border-border flex flex-col shrink-0 h-full">
      {/* Branding */}
      <div className="px-5 py-5">
        <span className="text-lg font-bold text-primary tracking-wide">boof</span>
      </div>
      <Separator />

      {/* Nav items */}
      <div className="flex-1 py-2 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = activeScreen === item.id || (item.id === 'dashboard' && activeScreen === 'home');
          return (
            <Button
              key={item.id}
              variant="ghost"
              onClick={() => setActiveScreen(item.id)}
              className={cn(
                'w-full justify-start gap-3 px-5 py-2.5 rounded-none text-sm h-auto',
                isActive
                  ? 'bg-primary/10 text-primary border-l-2 border-primary hover:bg-primary/15 hover:text-primary'
                  : 'text-muted-foreground border-l-2 border-transparent'
              )}
            >
              <span className="font-mono text-xs w-5 text-center">{item.icon}</span>
              <span>{item.label}</span>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}
