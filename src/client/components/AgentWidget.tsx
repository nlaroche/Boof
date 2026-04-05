// Shared agent display constants and helpers
import { Progress } from './ui/progress';

export const AGENT_STATUS_COLORS: Record<string, string> = {
  idle: 'bg-success',
  running: 'bg-warning animate-pulse',
  error: 'bg-destructive',
  dead: 'bg-muted-foreground',
};

export const AGENT_STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  running: 'Working...',
  error: 'Error',
  dead: 'Offline',
};

export const AGENT_STATUS_BADGE_COLORS: Record<string, string> = {
  idle: 'bg-success/20 text-success',
  running: 'bg-warning/20 text-warning',
  error: 'bg-destructive/20 text-destructive',
  dead: 'bg-muted-foreground/20 text-muted-foreground',
};

export function getPortrait(name: string): string {
  const portraits = ['(^_^)', '(o_o)', '(>_<)', '(-_-)', '(~_~)', '(*_*)', '(._.)' , '(T_T)', '(u_u)', '(n_n)'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return portraits[Math.abs(hash) % portraits.length];
}

export function getLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 5)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) * (level - 1) * 5;
}

// XP Bar component using shadcn Progress
export function XpBar({ xp, size = 'sm' }: { xp: number; size?: 'sm' | 'lg' }) {
  const level = getLevel(xp);
  const currentLevelXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const progressValue = nextLevelXp > currentLevelXp
    ? ((xp - currentLevelXp) / (nextLevelXp - currentLevelXp)) * 100
    : 0;

  if (size === 'lg') {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-foreground">Lv.{level}</span>
            <span className="text-xs text-muted-foreground">{xp} XP total</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Progress value={progressValue} className="flex-1 h-2" />
          <span className="text-[10px] text-muted-foreground shrink-0">{xp - currentLevelXp}/{nextLevelXp - currentLevelXp}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-[10px] font-bold text-primary">Lv.{level}</span>
      <Progress value={progressValue} className="flex-1 h-1.5" />
      <span className="text-[9px] text-muted-foreground">{xp - currentLevelXp}/{nextLevelXp - currentLevelXp}</span>
    </div>
  );
}
