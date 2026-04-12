import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { EmptyState } from '../components/EmptyState';
import { useEntityMap, lookupName } from '../lib/lookups';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function MemoryScreen({ onSend }: Props) {
  const agents = useStore((s) => s.agents);
  const agentPatterns = useStore((s) => s.agentPatterns);
  const agentFixes = useStore((s) => s.agentFixes);
  const guidelines = useStore((s) => s.guidelines);
  const agentMap = useEntityMap(agents);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current || agents.length === 0) return;
    fetchedRef.current = true;
    for (const agent of agents) {
      onSend({ type: 'agentMemory:patterns', agentId: agent.id });
      onSend({ type: 'agentMemory:fixes', agentId: agent.id });
    }
  }, [agents, onSend]);

  const allPatterns = selectedAgentId
    ? (agentPatterns[selectedAgentId] || [])
    : Object.values(agentPatterns).flat();

  const allFixes = selectedAgentId
    ? (agentFixes[selectedAgentId] || [])
    : Object.values(agentFixes).flat();

  const allGuidelines = Object.values(guidelines).flat();

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-foreground">Agent Memory</h1>
        {agents.length > 1 && (
          <div className="flex gap-1">
            <Button variant={selectedAgentId === null ? 'default' : 'outline'} size="sm"
              onClick={() => setSelectedAgentId(null)}>All</Button>
            {agents.map((agent) => (
              <Button key={agent.id} variant={selectedAgentId === agent.id ? 'default' : 'outline'}
                size="sm" onClick={() => setSelectedAgentId(agent.id)}>{agent.name}</Button>
            ))}
          </div>
        )}
      </div>

      <Tabs defaultValue="patterns">
        <TabsList>
          <TabsTrigger value="patterns">Patterns ({allPatterns.length})</TabsTrigger>
          <TabsTrigger value="fixes">Fixes ({allFixes.length})</TabsTrigger>
          <TabsTrigger value="guidelines">Guidelines ({allGuidelines.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="patterns">
          {allPatterns.length === 0 ? (
            <EmptyState icon="<>" title="No patterns" description="Agents discover patterns as they work on tasks." />
          ) : (
            <div className="space-y-2 mt-3">
              {allPatterns.map((pattern) => (
                <PatternCard key={pattern.id} pattern={pattern} agentName={lookupName(agentMap, pattern.agent_id)} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="fixes">
          {allFixes.length === 0 ? (
            <EmptyState icon="!" title="No fixes" description="Agents record fixes when they resolve recurring errors." />
          ) : (
            <div className="space-y-2 mt-3">
              {allFixes.map((fix) => (
                <FixCard key={fix.id} fix={fix} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="guidelines">
          {allGuidelines.length === 0 ? (
            <EmptyState icon="§" title="No guidelines" description="Scan a repo to discover guidelines, or add custom ones." />
          ) : (
            <div className="space-y-2 mt-3">
              {allGuidelines.map((guideline) => (
                <GuidelineCard key={guideline.id} guideline={guideline} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PatternCard({ pattern, agentName }: { pattern: import('../lib/types').AgentPattern; agentName: string }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-foreground">{pattern.name}</span>
          <Badge variant={pattern.verified ? 'success' : 'muted'} className="text-[10px]">
            {pattern.verified ? 'verified' : 'unverified'}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">{agentName}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{pattern.trigger_condition}</p>
        {pattern.code_example && (
          <pre className="mt-2 text-[10px] text-muted-foreground bg-secondary rounded p-2 overflow-x-auto font-mono">
            {pattern.code_example}
          </pre>
        )}
        <div className="flex gap-2 mt-2 text-[10px] text-muted-foreground">
          <span>Used: {pattern.use_count}</span>
          <span>Success: {pattern.success_count}</span>
          {pattern.domain_tags && <span>Tags: {pattern.domain_tags}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function FixCard({ fix }: { fix: import('../lib/types').AgentFix }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono text-destructive">{fix.error_signature}</span>
          <div className="flex-1" />
          <span className="text-[10px] text-muted-foreground">
            seen {fix.times_seen}x / fixed {fix.times_fixed}x
          </span>
        </div>
        <p className="text-xs text-foreground mt-1">{fix.root_cause}</p>
        <p className="text-xs text-primary mt-1">{fix.fix_action}</p>
        {fix.fix_code && (
          <pre className="mt-2 text-[10px] text-muted-foreground bg-secondary rounded p-2 overflow-x-auto font-mono">
            {fix.fix_code}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function GuidelineCard({ guideline }: { guideline: import('../lib/types').ReviewGuideline }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-foreground">{guideline.name}</span>
          <Badge variant={guideline.status === 'approved' ? 'success' : guideline.status === 'rejected' ? 'destructive' : 'warning'} className="text-[10px]">
            {guideline.status}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">{guideline.type}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">{guideline.description}</p>
        <div className="text-[10px] text-muted-foreground mt-1 font-mono">{guideline.scope}</div>
      </CardContent>
    </Card>
  );
}
