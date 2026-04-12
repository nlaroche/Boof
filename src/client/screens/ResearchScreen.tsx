import { useEffect } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { EmptyState } from '../components/EmptyState';
import { timeAgo, formatDuration, formatTokens, safeJsonParse, safeHostname } from '../lib/format';
import { useEntityMap, lookupName } from '../lib/lookups';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function ResearchScreen({ onSend }: Props) {
  const taskResearch = useStore((s) => s.taskResearch);
  const agents = useStore((s) => s.agents);
  const agentMap = useEntityMap(agents);
  const allResearch = Object.values(taskResearch)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  useEffect(() => {
    onSend({ type: 'research:list', limit: 50 });
  }, [onSend]);

  if (allResearch.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-foreground mb-6">Research</h1>
        <EmptyState
          icon="??"
          title="No research results"
          description="Research is conducted by agents before implementing tasks, using web search and code analysis."
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-foreground mb-6">Research Library</h1>
      <div className="space-y-3">
        {allResearch.map((research) => {
          const sources = safeJsonParse<string[]>(research.sources, []);
          const recommendations = safeJsonParse<string[]>(research.recommendations, []);

          return (
            <Card key={research.id}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary">{lookupName(agentMap, research.agent_id)}</Badge>
                  <Badge variant="muted">{research.model_used}</Badge>
                  <span className="text-xs text-muted-foreground">{timeAgo(research.created_at)}</span>
                  <div className="flex-1" />
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {formatDuration(research.duration_ms)} / {formatTokens(research.tokens_used)}
                  </span>
                </div>
                <p className="text-xs font-medium text-foreground mb-2">{research.query}</p>
                <div className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">
                  {research.findings}
                </div>
                {sources.length > 0 && (
                  <div className="mt-2 flex gap-1 flex-wrap">
                    {sources.map((src, i) => (
                      <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] text-primary hover:underline">
                        {safeHostname(src)}
                      </a>
                    ))}
                  </div>
                )}
                {recommendations.length > 0 && (
                  <div className="mt-2 text-xs text-primary">
                    {recommendations.length} recommendation{recommendations.length > 1 ? 's' : ''}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
