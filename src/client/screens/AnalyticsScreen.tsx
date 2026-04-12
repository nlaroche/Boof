import { useMemo } from 'react';
import { useStore } from '../stores/store';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { Badge } from '../components/ui/badge';
import { Progress } from '../components/ui/progress';
import { EmptyState } from '../components/EmptyState';
import { formatTokens, formatDuration } from '../lib/format';
import { EXPERIMENT_STATUS_VARIANT } from '../lib/ui-constants';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
}

export function AnalyticsScreen({ onSend }: Props) {
  const globalStats = useStore((s) => s.globalStats);
  const agents = useStore((s) => s.agents);
  const goals = useStore((s) => s.goals);
  const experimentRecords = useStore((s) => s.experimentRecords);

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-foreground mb-6">Analytics</h1>

      <Tabs defaultValue="cost">
        <TabsList>
          <TabsTrigger value="cost">Cost</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="experiments">Experiments ({experimentRecords.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="cost">
          <CostTab globalStats={globalStats} agents={agents} />
        </TabsContent>

        <TabsContent value="performance">
          <PerformanceTab globalStats={globalStats} activeGoalCount={goals.filter((g) => g.status === 'active').length} />
        </TabsContent>

        <TabsContent value="experiments">
          <ExperimentsTab experiments={experimentRecords} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <span className="text-2xl font-bold text-foreground">{value}</span>
      </CardContent>
    </Card>
  );
}

function CostTab({ globalStats, agents }: { globalStats: import('../lib/types').GlobalStats | null; agents: import('../lib/types').Agent[] }) {
  const maxXp = useMemo(() => Math.max(...agents.map(a => a.xp), 1), [agents]);

  return (
    <div className="mt-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Total Tokens" value={globalStats ? formatTokens(globalStats.totalTokensUsed) : '--'} />
        <StatCard label="Total Commands" value={globalStats?.totalCommands?.toString() ?? '--'} />
        <StatCard label="Total XP" value={globalStats?.totalXp?.toString() ?? '--'} />
      </div>

      {agents.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold text-foreground mb-3">Agents by XP</h2>
          <div className="space-y-2">
            {[...agents].sort((a, b) => b.xp - a.xp).map((agent) => (
              <div key={agent.id} className="flex items-center gap-3">
                <span className="text-sm text-foreground w-32 truncate">{agent.name}</span>
                <Progress value={Math.min(100, (agent.xp / maxXp) * 100)} className="flex-1" />
                <span className="text-xs text-muted-foreground font-mono w-16 text-right">{agent.xp} XP</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PerformanceTab({ globalStats, activeGoalCount }: { globalStats: import('../lib/types').GlobalStats | null; activeGoalCount: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
      <StatCard label="Success Rate" value={globalStats ? `${(globalStats.successRate * 100).toFixed(0)}%` : '--'} />
      <StatCard label="Avg Duration" value={globalStats ? formatDuration(globalStats.avgDurationMs) : '--'} />
      <StatCard label="Active Goals" value={activeGoalCount.toString()} />
    </div>
  );
}

function ExperimentsTab({ experiments }: { experiments: import('../lib/types').ExperimentRecord[] }) {
  if (experiments.length === 0) {
    return (
      <EmptyState
        icon="$$"
        title="No experiments"
        description="Experiments are auto-generated from agent reflections and failure patterns."
      />
    );
  }

  return (
    <div className="space-y-3 mt-4">
      {experiments.map((exp) => (
        <Card key={exp.id}>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-foreground">{exp.name}</span>
              <Badge variant={EXPERIMENT_STATUS_VARIANT[exp.status] || 'muted'}>{exp.status}</Badge>
              <Badge variant="secondary" className="text-[10px]">{exp.experiment_type}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{exp.hypothesis}</p>
            <div className="flex gap-4 mt-2 text-[10px] text-muted-foreground font-mono">
              {exp.p_value != null && <span>p={exp.p_value.toFixed(3)}</span>}
              {exp.effect_size != null && <span>d={exp.effect_size.toFixed(2)}</span>}
              {exp.control_mean != null && <span>ctrl={exp.control_mean.toFixed(2)}</span>}
              {exp.treatment_mean != null && <span>treat={exp.treatment_mean.toFixed(2)}</span>}
              <span>${exp.cost_spent_usd.toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
