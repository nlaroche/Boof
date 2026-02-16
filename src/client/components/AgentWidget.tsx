// Shared agent display constants and helpers

export const AGENT_STATUS_COLORS: Record<string, string> = {
  idle: 'bg-[#22c55e]',
  running: 'bg-[#f59e0b] animate-pulse',
  error: 'bg-[#ef4444]',
  dead: 'bg-[#6b6b80]',
};

export const AGENT_STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  running: 'Working...',
  error: 'Error',
  dead: 'Offline',
};

export const AGENT_STATUS_BADGE_COLORS: Record<string, string> = {
  idle: 'bg-[#22c55e]/20 text-[#22c55e]',
  running: 'bg-[#f59e0b]/20 text-[#f59e0b]',
  error: 'bg-[#ef4444]/20 text-[#ef4444]',
  dead: 'bg-[#6b6b80]/20 text-[#6b6b80]',
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

// XP Bar component
export function XpBar({ xp, size = 'sm' }: { xp: number; size?: 'sm' | 'lg' }) {
  const level = getLevel(xp);
  const currentLevelXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const progress = nextLevelXp > currentLevelXp
    ? (xp - currentLevelXp) / (nextLevelXp - currentLevelXp)
    : 0;

  if (size === 'lg') {
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-[#e2e2ef]">Lv.{level}</span>
            <span className="text-xs text-[#6b6b80]">{xp} XP total</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 bg-[#1e1e2e] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#7c5bf5] to-[#a78bfa]"
              style={{ width: `${Math.min(100, progress * 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-[#6b6b80] shrink-0">{xp - currentLevelXp}/{nextLevelXp - currentLevelXp}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-[10px] font-bold text-[#7c5bf5]">Lv.{level}</span>
      <div className="flex-1 h-1.5 bg-[#1e1e2e] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#7c5bf5] to-[#a78bfa]"
          style={{ width: `${Math.min(100, progress * 100)}%` }}
        />
      </div>
      <span className="text-[9px] text-[#6b6b80]">{xp - currentLevelXp}/{nextLevelXp - currentLevelXp}</span>
    </div>
  );
}
