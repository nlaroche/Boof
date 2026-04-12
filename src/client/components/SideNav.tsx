import { useStore, type UIState } from '../stores/store';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { cn } from '@/lib/utils';

type ScreenId = UIState['activeScreen'];

interface NavItem {
  id: ScreenId;
  label: string;
  icon: string;
}

const workspaceItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '~' },
  { id: 'projects', label: 'Projects', icon: '[]' },
  { id: 'goals', label: 'Goals', icon: '*' },
  { id: 'tasks', label: 'Tasks', icon: '#' },
  { id: 'agents', label: 'Agents', icon: '>' },
  { id: 'history', label: 'History', icon: '%' },
];

const systemItems: NavItem[] = [
  { id: 'pipeline', label: 'Pipeline', icon: '|>' },
  { id: 'reviews', label: 'Reviews', icon: '!!' },
  { id: 'audit', label: 'Audit', icon: '##' },
  { id: 'research', label: 'Research', icon: '??' },
  { id: 'memory', label: 'Memory', icon: '<>' },
  { id: 'analytics', label: 'Analytics', icon: '$$' },
];

function NavSection({ label, items, activeScreen, onNavigate }: {
  label: string;
  items: NavItem[];
  activeScreen: ScreenId;
  onNavigate: (id: ScreenId) => void;
}) {
  return (
    <div>
      <div className="px-5 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</span>
      </div>
      {items.map((item) => {
        const isActive = activeScreen === item.id || (item.id === 'dashboard' && activeScreen === 'home');
        return (
          <Button
            key={item.id}
            variant="ghost"
            onClick={() => onNavigate(item.id)}
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
  );
}

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

      {/* Nav sections */}
      <div className="flex-1 py-2 overflow-y-auto">
        <NavSection label="Workspace" items={workspaceItems} activeScreen={activeScreen} onNavigate={setActiveScreen} />
        <div className="my-2">
          <Separator />
        </div>
        <NavSection label="Systems" items={systemItems} activeScreen={activeScreen} onNavigate={setActiveScreen} />
      </div>
    </nav>
  );
}
