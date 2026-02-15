import { profiles } from '../lib/ascii-profiles';

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
          className={`shrink-0 flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${
            selected === p.id
              ? 'border-[#7c5bf5] bg-[#7c5bf5]/10'
              : 'border-[#1e1e2e] bg-[#0a0a0f] active:bg-[#1e1e2e]'
          }`}
        >
          <pre
            className="text-[7px] leading-[8px] font-mono"
            style={{ color: p.accent }}
          >
            {p.art}
          </pre>
          <span className="text-[10px] text-[#6b6b80]">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
