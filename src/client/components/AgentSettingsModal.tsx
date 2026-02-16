import { useState } from 'react';
import * as Switch from '@radix-ui/react-switch';
import * as Select from '@radix-ui/react-select';
import type { Agent, WSClientMessage } from '../lib/types';
import { ProfileSelector } from './ProfileSelector';
import { useStore } from '../stores/store';
import { DrawerModal } from './DrawerModal';
import { Label, Input, Textarea, Button } from './ui';

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

function RadixSelect({ value, onValueChange, placeholder, items }: {
  value: string;
  onValueChange: (v: string) => void;
  placeholder: string;
  items: { value: string; label: string }[];
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger className="w-full flex items-center justify-between bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 text-sm text-[#e2e2ef] focus:outline-none focus:border-[#7c5bf5]">
        <Select.Value placeholder={placeholder} />
        <Select.Icon className="text-[#6b6b80]">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="radix-select-content z-[60]" position="popper" sideOffset={4}>
          <Select.Viewport>
            <Select.Item value="" className="radix-select-item">
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
            {/* Name */}
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mb-4"
            />

            {/* Profile */}
            <Label className="mb-1.5">Profile</Label>
            <div className="mb-4">
              <ProfileSelector selected={profileId} onSelect={setProfileId} />
            </div>

            {/* Instructions */}
            <Label>Instructions</Label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Custom system prompt for this agent..."
              rows={4}
              className="mb-4"
            />

            {/* Skills */}
            <label className="text-xs text-[#6b6b80] mb-2 block">Skills</label>
            <div className="flex flex-wrap gap-2 mb-4">
              {AVAILABLE_SKILLS.map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => toggleSkill(skill.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    skills.includes(skill.id)
                      ? 'bg-[#7c5bf5]/20 text-[#7c5bf5] border border-[#7c5bf5]/40'
                      : 'bg-[#0a0a0f] text-[#6b6b80] border border-[#1e1e2e]'
                  }`}
                  title={skill.desc}
                >
                  {skill.label}
                </button>
              ))}
            </div>

            {/* Autopilot */}
            <label className="text-xs text-[#6b6b80] mb-1.5 block">Autopilot</label>
            <div className="flex items-center gap-2 mb-2">
              <Switch.Root
                checked={autopilot}
                onCheckedChange={setAutopilot}
                className="w-10 h-5 rounded-full transition-colors data-[state=checked]:bg-[#22c55e] data-[state=unchecked]:bg-[#1e1e2e] relative"
              >
                <Switch.Thumb className="block w-4 h-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5" />
              </Switch.Root>
              <span className="text-xs text-[#6b6b80]">
                {autopilot ? 'Enabled' : 'Disabled'}
              </span>
            </div>

            {autopilot && (
              <>
                <label className="text-xs text-[#6b6b80] mb-1.5 block">Interval</label>
                <div className="flex gap-1.5 mb-3">
                  {[
                    { label: '5min', val: 300 },
                    { label: '10min', val: 600 },
                    { label: '30min', val: 1800 },
                    { label: '1hr', val: 3600 },
                  ].map((preset) => (
                    <button
                      key={preset.val}
                      onClick={() => setAutopilotInterval(preset.val)}
                      className={`px-2 py-1 rounded text-xs ${
                        autopilotInterval === preset.val
                          ? 'bg-[#22c55e]/20 text-[#22c55e]'
                          : 'bg-[#0a0a0f] text-[#6b6b80]'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <label className="text-xs text-[#6b6b80] mb-1.5 block">Goal</label>
                <div className="mb-3">
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

                <label className="text-xs text-[#6b6b80] mb-1.5 block">Workflow</label>
                <div className="mb-3">
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

                <button
                  onClick={() => onSend({ type: 'agent:autopilot:trigger', agentId: agent.id })}
                  className="w-full bg-[#22c55e]/20 text-[#22c55e] border border-[#22c55e]/40 py-2 rounded-lg text-sm font-medium mb-3 active:bg-[#22c55e]/30"
                >
                  Run Now
                </button>

                {agent.autopilot_last_run && (
                  <p className="text-[10px] text-[#6b6b80] mb-3">
                    Last run: {new Date(agent.autopilot_last_run).toLocaleString()}
                  </p>
                )}
              </>
            )}

            {/* Schedule */}
            <label className="text-xs text-[#6b6b80] mb-1.5 block">Schedule</label>
            <div className="flex items-center gap-2 mb-2">
              <Switch.Root
                checked={scheduleEnabled}
                onCheckedChange={setScheduleEnabled}
                className="w-10 h-5 rounded-full transition-colors data-[state=checked]:bg-[#7c5bf5] data-[state=unchecked]:bg-[#1e1e2e] relative"
              >
                <Switch.Thumb className="block w-4 h-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5" />
              </Switch.Root>
              <span className="text-xs text-[#6b6b80]">
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
                <button
                  key={preset.val}
                  onClick={() => setSchedule(preset.val)}
                  className={`px-2 py-1 rounded text-xs ${
                    schedule === preset.val
                      ? 'bg-[#7c5bf5]/20 text-[#7c5bf5]'
                      : 'bg-[#0a0a0f] text-[#6b6b80]'
                  }`}
                >
                  {preset.label}
                </button>
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
              className="mb-4"
            />

            {/* Save */}
            <Button onClick={handleSave} className="w-full">
              Save Settings
            </Button>
    </DrawerModal>
  );
}
