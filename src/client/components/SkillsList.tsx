import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import type { AggregatedSkill } from '../lib/types';

interface Props {
  skills: AggregatedSkill[];
  compact?: boolean;
}

export function SkillsList({ skills, compact = false }: Props) {
  if (skills.length === 0) {
    return <p className="text-xs text-muted-foreground px-4 py-2">No skills yet</p>;
  }

  // Group by category
  const grouped = new Map<string, AggregatedSkill[]>();
  for (const skill of skills) {
    const cat = skill.category || 'general';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(skill);
  }

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {Array.from(grouped.entries()).map(([category, catSkills]) => (
        <div key={category}>
          <div className="px-4 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            {category}
          </div>
          {catSkills.map((skill) => (
            <div key={skill.name} className="px-4 py-1.5 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground">{skill.name}</span>
                  {skill.agentCount > 1 && (
                    <Badge variant="muted" className="text-[9px] px-1 py-0">{skill.agentCount} agents</Badge>
                  )}
                </div>
                <Progress value={skill.avgProficiency} className="h-1 mt-1" />
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0 w-8 text-right">{skill.avgProficiency}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
