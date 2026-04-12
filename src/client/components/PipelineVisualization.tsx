import { PIPELINE_STATES } from '../lib/ui-constants';
import type { MergeGate } from '../lib/types';

interface Props {
  currentStatus: MergeGate['status'];
}

export function PipelineVisualization({ currentStatus }: Props) {
  const currentIndex = PIPELINE_STATES.indexOf(currentStatus as typeof PIPELINE_STATES[number]);
  const isFailed = currentStatus === 'failed';

  return (
    <div className="flex items-center gap-1 overflow-x-auto py-3 px-1">
      {PIPELINE_STATES.map((state, i) => {
        const isCurrent = state === currentStatus;
        const isPast = currentIndex >= 0 && i < currentIndex;

        return (
          <div key={state} className="flex items-center">
            {i > 0 && (
              <div className={`w-4 h-0.5 ${isPast ? 'bg-primary' : 'bg-border'}`} />
            )}
            <div
              className={`
                px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap border transition-all
                ${isCurrent
                  ? isFailed
                    ? 'bg-destructive/20 border-destructive text-destructive'
                    : 'bg-primary/20 border-primary text-primary'
                  : isPast
                    ? 'bg-primary/10 border-primary/30 text-primary/70'
                    : 'bg-secondary border-border text-muted-foreground'
                }
              `}
            >
              {state}
            </div>
          </div>
        );
      })}
    </div>
  );
}
