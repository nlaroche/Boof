import { useEffect, useState } from 'react';
import { useStore, type UIState } from '../stores/store';
import { Dialog, DialogContent } from './ui/dialog';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from './ui/command';
import { getPortrait } from './AgentWidget';

type ScreenId = UIState['activeScreen'];

interface NavTarget {
  label: string;
  screen: ScreenId;
  icon: string;
  group: string;
}

const NAV_TARGETS: NavTarget[] = [
  { label: 'Dashboard', screen: 'dashboard', icon: '~', group: 'Workspace' },
  { label: 'Projects', screen: 'projects', icon: '[]', group: 'Workspace' },
  { label: 'Goals', screen: 'goals', icon: '*', group: 'Workspace' },
  { label: 'Tasks', screen: 'tasks', icon: '#', group: 'Workspace' },
  { label: 'Agents', screen: 'agents', icon: '>', group: 'Workspace' },
  { label: 'History', screen: 'history', icon: '%', group: 'Workspace' },
  { label: 'Pipeline', screen: 'pipeline', icon: '|>', group: 'Systems' },
  { label: 'Reviews', screen: 'reviews', icon: '!!', group: 'Systems' },
  { label: 'Audit Trail', screen: 'audit', icon: '##', group: 'Systems' },
  { label: 'Research', screen: 'research', icon: '??', group: 'Systems' },
  { label: 'Memory', screen: 'memory', icon: '<>', group: 'Systems' },
  { label: 'Analytics', screen: 'analytics', icon: '$$', group: 'Systems' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);
  const agents = useStore((s) => s.agents);
  const goals = useStore((s) => s.goals);
  const projects = useStore((s) => s.projects);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const navigate = (screen: ScreenId) => {
    setActiveScreen(screen);
    setOpen(false);
  };

  const goToAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setActiveScreen('agent');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 max-w-lg">
        <Command>
          <CommandInput placeholder="Search screens, agents, goals..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>

            <CommandGroup heading="Navigation">
              {NAV_TARGETS.map(t => (
                <CommandItem key={t.screen} onSelect={() => navigate(t.screen)}>
                  <span className="font-mono text-xs w-5 text-center text-muted-foreground">{t.icon}</span>
                  <span>{t.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            {agents.length > 0 && (
              <CommandGroup heading="Agents">
                {agents.map(agent => (
                  <CommandItem key={agent.id} onSelect={() => goToAgent(agent.id)}>
                    <span className="text-lg font-mono">{getPortrait(agent.name)}</span>
                    <span>{agent.name}</span>
                    <span className="text-xs text-muted-foreground ml-auto">{agent.status}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {goals.filter(g => g.status === 'active').length > 0 && (
              <CommandGroup heading="Active Goals">
                {goals.filter(g => g.status === 'active').map(goal => (
                  <CommandItem key={goal.id} onSelect={() => navigate('goals')}>
                    <span className="font-mono text-xs w-5 text-center text-muted-foreground">*</span>
                    <span>{goal.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {projects.length > 0 && (
              <CommandGroup heading="Projects">
                {projects.map(project => (
                  <CommandItem key={project.id} onSelect={() => navigate('projects')}>
                    <span className="font-mono text-xs w-5 text-center text-muted-foreground">[]</span>
                    <span>{project.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
