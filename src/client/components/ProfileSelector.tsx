import { profiles } from '../lib/ascii-profiles';
import { cn } from '@/lib/utils';

interface Props {
  selected: string;
  onSelect: (id: string) => void;
}

export function ProfileSelector({ selected, onSelect }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-none">
      {profiles.map((p) => (
        <button
          key={p.id}
          onClick={() => onSelect(p.id)}
          className={cn(
            'shrink-0 flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors',
            selected === p.id
              ? 'border-primary bg-primary/10'
              : 'border-border bg-card active:bg-secondary'
          )}
        >
          <pre
            className="text-[7px] leading-[8px] font-mono"
            style={{ color: p.accent }}
          >
            {p.art}
          </pre>
          <span className="text-[10px] text-muted-foreground">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
