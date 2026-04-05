import { Badge } from './ui/badge';
import { getPortrait } from './AgentWidget';
import { timeAgo } from '../lib/format';
import type { RecentLearning } from '../lib/types';

interface Props {
  learning: RecentLearning;
}

export function LearningItem({ learning }: Props) {
  return (
    <div className="px-4 py-3 flex items-start gap-3 border-t border-border/50">
      <span className="text-lg font-mono shrink-0 mt-0.5">{getPortrait(learning.agentName)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm text-foreground font-medium">{learning.agentName}</span>
          <Badge variant={learning.type === 'improvement' ? 'success' : 'default'}>
            {learning.type === 'improvement' ? 'learned' : 'reflected'}
          </Badge>
        </div>
        <p className="text-sm text-foreground break-words">{learning.text}</p>
        <span className="text-xs text-muted-foreground mt-1 block">{timeAgo(learning.createdAt)}</span>
      </div>
    </div>
  );
}
