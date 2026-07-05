import { useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import * as Select from '@radix-ui/react-select';
import type { Agent, WSClientMessage } from '../lib/types';
import { ProfileSelector } from './ProfileSelector';
import { useStore } from '../stores/store';
import { cn } from '@/lib/utils';
import { DrawerModal } from './DrawerModal';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';

const AVAILABLE_SKILLS = [
  { id: 'commit', label: 'Commit', desc: 'Auto-commit changes' },
  { id: 'review', label: 'Review', desc: 'Code review' },
  { id: 'test', label: 'Test', desc: 'Run tests' },
  { id: 'refactor', label: 'Refactor', desc: 'Refactor code' },
  { id: 'debug', label: 'Debug', desc: 'Debug issues' },
  { id: 'document', label: 'Document', desc: 'Write docs' },
];

interface Props {
  agent: Agent;
  onSend: (msg: WSClientMessage) => void;
  onClose: () => void;
}

// Radix Select forbids an empty-string <Select.Item value=""> (it throws on open,
// crashing the screen — H9). Use a sentinel that maps to '' (= "none") on change.
const NONE_VALUE = '__none__';

function RadixSelect({ value, onValueChange, placeholder, items }: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder: string;
  items: { value: string; label: string }[];
}) {
  return (
    <Select.Root
      value={value || NONE_VALUE}
      onValueChange={(v) => onValueChange(v === NONE_VALUE ? '' : v)}
    >
      <Select.Trigger className="w-full flex items-center justify-between bg-background border border-input rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-ring focus:ring-2 focus:ring-ring/25 transition-all">
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="text-muted-foreground">&#9662;</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="radix-select-content z-[60]" position="popper" sideOffset={4}>
          <Select.Viewport>
            <Select.Item value={NONE_VALUE} className="radix-select-item">
              <Select.ItemText>{placeholder}</Select.ItemText>
            </Select.Item>
            {items.map((item) => (
              <Select.Item key={item.value} value={item.value} className="radix-select-item">
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function AgentSettingsModal({ agent, onSend, onClose }: Props) {
  const [name, setName] = useState(agent.name);
  const [instructions, setInstructions] = useState(agent.instructions || '');
  const [skills, setSkills] = useState<string[]>(() => {
    try {
      return JSON.parse(agent.skills || '[]');
    } catch {
      return [];
    }
  });
  const [profileId, setProfileId] = useState(agent.profile_id || 'robot');
  const [schedulePrompt, setSchedulePrompt] = useState(agent.schedule_prompt || '');
  const [schedule, setSchedule] = useState(agent.schedule || '');
  const [scheduleEnabled, setScheduleEnabled] = useState(Boolean(agent.schedule_enabled));
  const [autopilot, setAutopilot] = useState(Boolean(agent.autopilot));
  const [autopilotInterval, setAutopilotInterval] = useState(agent.autopilot_interval || 600);
  const [autopilotGoalId, setAutopilotGoalId] = useState(agent.autopilot_goal_id || '');
  const [workflowId, setWorkflowId] = useState(agent.workflow_id || '');
  const goals = useStore((s) => s.goals);
  const workflows = useStore((s) => s.workflows);

  const toggleSkill = (id: string) => {
    setSkills((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    onSend({
      type: 'agent:update',
      agentId: agent.id,
      fields: {
        name: name.trim() || agent.name,
        instructions,
        skills: JSON.stringify(skills),
        profile_id: profileId,
        workflow_id: workflowId || null,
      },
    });

    onSend({
      type: 'agent:schedule',
      agentId: agent.id,
      schedule: schedule || null,
      enabled: scheduleEnabled,
      prompt: schedulePrompt,
    });

    onSend({
      type: 'agent:autopilot',
      agentId: agent.id,
      autopilot,
      interval: autopilotInterval,
      goalId: autopilotGoalId || null,
    });

    onClose();
  };

  return (
    <DrawerModal open title="Agent Settings" onClose={onClose} snapPoints={[0.85, 1]}>
      <div className="space-y-5">
        {/* Name */}
        <div>
          <Label className="mb-1.5">Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {/* Profile */}
        <div>
          <Label className="mb-1.5">Profile</Label>
          <ProfileSelector selected={profileId} onSelect={setProfileId} />
        </div>

        {/* Instructions */}
        <div>
          <Label className="mb-1.5">Instructions</Label>
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Custom system prompt for this agent..."
            rows={4}
          />
        </div>

        {/* Skills */}
        <div>
          <Label className="mb-2">Skills</Label>
          <div className="flex flex-wrap gap-2">
            {AVAILABLE_SKILLS.map((skill) => (
              <Button
                key={skill.id}
                variant="outline"
                size="sm"
                onClick={() => toggleSkill(skill.id)}
                className={cn(
                  'transition-colors',
                  skills.includes(skill.id)
                    ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                    : ''
                )}
                title={skill.desc}
              >
                {skill.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Autopilot */}
        <div>
          <Label className="mb-1.5">Autopilot</Label>
          <div className="flex items-center gap-2 mb-2">
            <Switch.Root
              checked={autopilot}
              onCheckedChange={setAutopilot}
              className="w-10 h-5 rounded-full transition-colors data-[state=checked]:bg-success data-[state=unchecked]:bg-secondary relative"
            >
              <Switch.Thumb className="block w-4 h-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5" />
            </Switch.Root>
            <span className="text-xs text-muted-foreground">
              {autopilot ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          {autopilot && (
            <div className="space-y-3 pl-1">
              <div>
                <Label className="mb-1.5 text-xs">Interval</Label>
                <div className="flex gap-1.5">
                  {[
                    { label: '5min', val: 300 },
                    { label: '10min', val: 600 },
                    { label: '30min', val: 1800 },
                    { label: '1hr', val: 3600 },
                  ].map((preset) => (
                    <Button
                      key={preset.val}
                      variant="ghost"
                      size="sm"
                      onClick={() => setAutopilotInterval(preset.val)}
                      className={cn(
                        autopilotInterval === preset.val
                          ? 'bg-success/20 text-success hover:bg-success/30 hover:text-success'
                          : ''
                      )}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <Label className="mb-1.5 text-xs">Goal</Label>
                <RadixSelect
                  value={autopilotGoalId}
                  onValueChange={setAutopilotGoalId}
                  placeholder="No goal selected"
                  items={goals.filter((g) => g.status === 'active').map((g) => ({
                    value: g.id,
                    label: g.name,
                  }))}
                />
              </div>

              <div>
                <Label className="mb-1.5 text-xs">Workflow</Label>
                <RadixSelect
                  value={workflowId}
                  onValueChange={setWorkflowId}
                  placeholder="No workflow (simple mode)"
                  items={workflows.map((w) => ({
                    value: w.id,
                    label: `${w.name} (${w.steps.length} steps)`,
                  }))}
                />
              </div>

              <Button
                variant="outline"
                onClick={() => onSend({ type: 'agent:autopilot:trigger', agentId: agent.id })}
                className="w-full border-success/40 text-success hover:bg-success/10 hover:text-success"
              >
                Run Now
              </Button>

              {agent.autopilot_last_run && (
                <p className="text-[10px] text-muted-foreground">
                  Last run: {new Date(agent.autopilot_last_run).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Schedule */}
        <div>
          <Label className="mb-1.5">Schedule</Label>
          <div className="flex items-center gap-2 mb-2">
            <Switch.Root
              checked={scheduleEnabled}
              onCheckedChange={setScheduleEnabled}
              className="w-10 h-5 rounded-full transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-secondary relative"
            >
              <Switch.Thumb className="block w-4 h-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5" />
            </Switch.Root>
            <span className="text-xs text-muted-foreground">
              {scheduleEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>

          <div className="flex gap-1.5 mb-2">
            {[
              { label: '1min', val: '*/1 * * * *' },
              { label: 'Hourly', val: '0 * * * *' },
              { label: 'Daily', val: '0 9 * * *' },
              { label: 'Weekly', val: '0 9 * * 1' },
            ].map((preset) => (
              <Button
                key={preset.val}
                variant="ghost"
                size="sm"
                onClick={() => setSchedule(preset.val)}
                className={cn(
                  schedule === preset.val
                    ? 'bg-primary/20 text-primary hover:bg-primary/30 hover:text-primary'
                    : ''
                )}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          <Input
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            placeholder="Cron expression (e.g. */5 * * * *)"
            className="mb-2 font-mono"
          />

          <Textarea
            value={schedulePrompt}
            onChange={(e) => setSchedulePrompt(e.target.value)}
            placeholder="Prompt to send when schedule fires..."
            rows={2}
          />
        </div>

        {/* Save */}
        <Button onClick={handleSave} className="w-full">
          Save Settings
        </Button>
      </div>
    </DrawerModal>
  );
}
