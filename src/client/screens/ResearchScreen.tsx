import { useEffect, useState } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { EmptyState } from '../components/EmptyState';
import { timeAgo, formatDuration, formatTokens, safeJsonParse, safeHostname } from '../lib/format';
import { useEntityMap, lookupName } from '../lib/lookups';
import { useOnReconnect } from '../hooks/useReconnect';
import { SkeletonList } from '../components/Skeletons';
import type { WSClientMessage, TaskResearch } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function ResearchScreen({ onSend }: Props) {
  const taskResearch = useStore((s) => s.taskResearch);
  const agents = useStore((s) => s.agents);
  const agentMap = useEntityMap(agents);
  const loading = useStore((s) => s.loading.research);
  const allResearch = Object.values(taskResearch)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    onSend({ type: 'research:list', limit: 50 });
  }, [onSend]);
  useOnReconnect(() => onSend({ type: 'research:list', limit: 50 }));

  if (allResearch.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-foreground mb-6">Research</h1>
        {loading ? (
          <SkeletonList count={3} />
        ) : (
          <EmptyState
            icon="??"
            title="No research results"
            description="Research is conducted by agents before implementing tasks, using web search and code analysis."
          />
        )}
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-foreground mb-6">Research Library ({allResearch.length})</h1>
      <div className="space-y-3">
        {allResearch.map((research) => (
          <ResearchCard
            key={research.id}
            research={research}
            agentName={lookupName(agentMap, research.agent_id)}
            expanded={expandedId === research.id}
            onToggle={() => setExpandedId(expandedId === research.id ? null : research.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ResearchCard({ research, agentName, expanded, onToggle }: {
  research: TaskResearch;
  agentName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const sources = safeJsonParse<string[]>(research.sources, []);
  const recommendations = safeJsonParse<string[]>(research.recommendations, []);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <Badge variant="secondary">{agentName}</Badge>
          <Badge variant="muted">{research.model_used}</Badge>
          <span className="text-xs text-muted-foreground">{timeAgo(research.created_at)}</span>
          <div className="flex-1" />
          <span className="text-[10px] text-muted-foreground font-mono">
            {formatDuration(research.duration_ms)} / {formatTokens(research.tokens_used)}
          </span>
        </div>
        <p className="text-xs font-medium text-foreground mb-2 cursor-pointer" onClick={onToggle}>
          {expanded ? '▾' : '▸'} {research.query}
        </p>

        {!expanded && (
          <div className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-3">
            {research.findings}
          </div>
        )}

        {expanded && (
          <>
            <div className="text-xs text-muted-foreground whitespace-pre-wrap mb-3 max-h-96 overflow-y-auto">
              {research.findings}
            </div>

            {sources.length > 0 && (
              <div className="mb-3">
                <span className="text-[10px] font-semibold text-foreground">Sources</span>
                <div className="mt-1 flex flex-col gap-1">
                  {sources.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline truncate">
                      {safeHostname(src)} — {src}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {recommendations.length > 0 && (
              <div>
                <span className="text-[10px] font-semibold text-foreground">Recommendations</span>
                <ul className="mt-1 space-y-1">
                  {recommendations.map((rec, i) => (
                    <li key={i} className="text-xs text-foreground flex gap-2">
                      <span className="text-primary shrink-0">-</span>
                      <span>{rec}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {!expanded && (sources.length > 0 || recommendations.length > 0) && (
          <div className="mt-2 flex gap-2 text-[10px] text-muted-foreground">
            {sources.length > 0 && <span>{sources.length} source{sources.length > 1 ? 's' : ''}</span>}
            {recommendations.length > 0 && <span>{recommendations.length} rec{recommendations.length > 1 ? 's' : ''}</span>}
            <Button variant="ghost" size="sm" className="text-[10px] h-5 px-1" onClick={onToggle}>expand</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
