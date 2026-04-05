import { useStore } from '../stores/store';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Progress } from '../components/ui/progress';
import { DashboardAgentCard } from '../components/DashboardAgentCard';
import { SkillsList } from '../components/SkillsList';
import { LearningItem } from '../components/LearningItem';
import { CollapsibleSection } from '../components/CollapsibleSection';
import { formatDuration } from '../lib/format';
import type { WSClientMessage } from '../lib/types';

interface Props {
  onSend: (msg: WSClientMessage) => void;
  onSendToAgent: (agentId: string, prompt: string) => void;
}

export function DashboardScreen({ onSend, onSendToAgent }: Props) {
  const projects = useStore((s) => s.projects);
  const goals = useStore((s) => s.goals);
  const agents = useStore((s) => s.agents);
  const commands = useStore((s) => s.commands);
  const globalSkills = useStore((s) => s.globalSkills);
  const globalStats = useStore((s) => s.globalStats);
  const recentLearnings = useStore((s) => s.recentLearnings);
  const setActiveScreen = useStore((s) => s.setActiveScreen);
  const setSelectedAgentId = useStore((s) => s.setSelectedAgentId);
  const setSelectedProjectId = useStore((s) => s.setSelectedProjectId);

  const activeProjects = projects.filter((p) => p.status === 'active');
  const activeGoals = goals.filter((g) => g.status === 'active');
  const completedGoals = goals.filter((g) => g.status === 'completed');
  const runningAgents = agents.filter((a) => a.status === 'running');
  const runningCommands = commands.filter((c) => c.status === 'running');

  return (
    <div className="p-4 space-y-5 max-w-7xl pb-24">
      <h1 className="text-xl font-bold text-foreground">Dashboard</h1>

      {/* Enhanced Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Projects"
          value={activeProjects.length}
          total={projects.length}
          detail={completedGoals.length > 0 ? `${Math.round(completedGoals.length / Math.max(goals.length, 1) * 100)}% goals done` : undefined}
          onClick={() => setActiveScreen('projects')}
        />
        <StatCard
          label="Goals"
          value={activeGoals.length}
          total={goals.length}
          onClick={() => setActiveScreen('goals')}
        />
        <StatCard
          label="Agents"
          value={runningAgents.length}
          total={agents.length}
          detail={globalStats ? `${globalStats.successRate}% success` : undefined}
          onClick={() => setActiveScreen('agents')}
        />
        <StatCard
          label="Commands"
          value={runningCommands.length}
          total={commands.length}
          detail={globalStats ? `${formatDuration(globalStats.avgDurationMs)} avg` : undefined}
          onClick={() => setActiveScreen('history')}
        />
      </div>

      {/* Active Projects */}
      {activeProjects.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Active Projects</h2>
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none">
            {activeProjects.map((project) => {
              const projectGoals = goals.filter((g) => g.project_id === project.id);
              const completed = projectGoals.filter((g) => g.status === 'completed').length;
              const total = projectGoals.length;
              const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

              return (
                <Card
                  key={project.id}
                  className="min-w-[200px] shrink-0 cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => {
                    setSelectedProjectId(project.id);
                    setActiveScreen('projects');
                  }}
                >
                  <CardHeader className="p-4 pb-2">
                    <CardTitle className="truncate">{project.name}</CardTitle>
                    <CardDescription>{total} goals</CardDescription>
                  </CardHeader>
                  {total > 0 && (
                    <CardContent className="p-4 pt-0">
                      <Progress value={pct} className="h-1" />
                      <span className="text-xs text-muted-foreground mt-1 block">{pct}%</span>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Agent Cards */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">Agents</h2>
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agents</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.map((agent) => (
              <DashboardAgentCard
                key={agent.id}
                agent={agent}
                commands={commands}
                goals={goals}
                onClick={() => {
                  setSelectedAgentId(agent.id);
                  setActiveScreen('agent');
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Global Skills */}
      {globalSkills.length > 0 && (
        <CollapsibleSection title="Fleet Skills" count={globalSkills.length} defaultOpen>
          <SkillsList skills={globalSkills} />
        </CollapsibleSection>
      )}

      {/* Recent Learnings */}
      {recentLearnings.length > 0 && (
        <CollapsibleSection title="Recent Learnings" count={recentLearnings.length} defaultOpen>
          {recentLearnings.map((learning) => (
            <LearningItem key={learning.id} learning={learning} />
          ))}
        </CollapsibleSection>
      )}

      {/* Fleet Stats */}
      {globalStats && (globalStats.totalCommands > 0 || globalStats.totalXp > 0) && (
        <CollapsibleSection title="Fleet Stats">
          <div className="px-4 py-2 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="text-center">
              <div className="text-lg font-bold text-success">{globalStats.successRate}%</div>
              <div className="text-[9px] text-muted-foreground">Success Rate</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-foreground">{globalStats.totalXp}</div>
              <div className="text-[9px] text-muted-foreground">Total XP</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-info">{(globalStats.totalTokensUsed / 1000).toFixed(0)}k</div>
              <div className="text-[9px] text-muted-foreground">Tokens Used</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-warning">{formatDuration(globalStats.avgDurationMs)}</div>
              <div className="text-[9px] text-muted-foreground">Avg Duration</div>
            </div>
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

function StatCard({ label, value, total, detail, onClick }: { label: string; value: number; total: number; detail?: string; onClick: () => void }) {
  return (
    <Card
      className="cursor-pointer hover:border-primary/50 transition-colors"
      onClick={onClick}
    >
      <CardHeader className="p-3 pb-1">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        <p className="text-2xl font-bold text-foreground">{value}</p>
        <p className="text-xs text-muted-foreground">of {total}</p>
        {detail && <p className="text-[10px] text-primary mt-0.5">{detail}</p>}
      </CardContent>
    </Card>
  );
}
