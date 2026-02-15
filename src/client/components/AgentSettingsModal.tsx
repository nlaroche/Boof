import { useState } from 'react';
import type { Agent, WSClientMessage } from '../lib/types';
import { ProfileSelector } from './ProfileSelector';
import { useStore } from '../stores/store';

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
  const [agentType, setAgentType] = useState<'claude' | 'aider'>(agent.agent_type || 'claude');
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
        agent_type: agentType,
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
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#14141f] border-t border-[#1e1e2e] rounded-t-2xl p-4 pb-8 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-[#e2e2ef]">Agent Settings</h2>
          <button
            onClick={onClose}
            className="text-[#6b6b80] text-xl px-2"
          >
            x
          </button>
        </div>

        {/* Name */}
        <label className="text-xs text-[#6b6b80] mb-1 block">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-4 text-sm text-[#e2e2ef] focus:outline-none focus:border-[#7c5bf5]"
        />

        {/* Backend */}
        <label className="text-xs text-[#6b6b80] mb-1.5 block">Backend</label>
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setAgentType('claude')}
            className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors ${
              agentType === 'claude'
                ? 'bg-[#7c5bf5]/20 text-[#7c5bf5] border border-[#7c5bf5]/40'
                : 'bg-[#0a0a0f] text-[#6b6b80] border border-[#1e1e2e]'
            }`}
          >
            Claude Code
          </button>
          <button
            onClick={() => setAgentType('aider')}
            className={`flex-1 px-3 py-2 rounded-lg text-sm transition-colors ${
              agentType === 'aider'
                ? 'bg-[#22c55e]/20 text-[#22c55e] border border-[#22c55e]/40'
                : 'bg-[#0a0a0f] text-[#6b6b80] border border-[#1e1e2e]'
            }`}
          >
            Aider
          </button>
        </div>

        {/* Profile */}
        <label className="text-xs text-[#6b6b80] mb-1.5 block">Profile</label>
        <div className="mb-4">
          <ProfileSelector selected={profileId} onSelect={setProfileId} />
        </div>

        {/* Instructions */}
        <label className="text-xs text-[#6b6b80] mb-1 block">Instructions</label>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Custom system prompt for this agent..."
          rows={4}
          className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-4 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] resize-none"
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
          <button
            onClick={() => setAutopilot(!autopilot)}
            className={`w-10 h-5 rounded-full transition-colors relative ${
              autopilot ? 'bg-[#22c55e]' : 'bg-[#1e1e2e]'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                autopilot ? 'left-5' : 'left-0.5'
              }`}
            />
          </button>
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
            <select
              value={autopilotGoalId}
              onChange={(e) => setAutopilotGoalId(e.target.value)}
              className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-3 text-sm text-[#e2e2ef] focus:outline-none focus:border-[#7c5bf5]"
            >
              <option value="">No goal selected</option>
              {goals.filter((g) => g.status === 'active').map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>

            <label className="text-xs text-[#6b6b80] mb-1.5 block">Workflow</label>
            <select
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
              className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-3 text-sm text-[#e2e2ef] focus:outline-none focus:border-[#7c5bf5]"
            >
              <option value="">No workflow (simple mode)</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({w.steps.length} steps)</option>
              ))}
            </select>

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
          <button
            onClick={() => setScheduleEnabled(!scheduleEnabled)}
            className={`w-10 h-5 rounded-full transition-colors relative ${
              scheduleEnabled ? 'bg-[#7c5bf5]' : 'bg-[#1e1e2e]'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                scheduleEnabled ? 'left-5' : 'left-0.5'
              }`}
            />
          </button>
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

        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="Cron expression (e.g. */5 * * * *)"
          className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-2 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] font-mono"
        />

        <textarea
          value={schedulePrompt}
          onChange={(e) => setSchedulePrompt(e.target.value)}
          placeholder="Prompt to send when schedule fires..."
          rows={2}
          className="w-full bg-[#0a0a0f] border border-[#1e1e2e] rounded-lg px-3 py-2 mb-4 text-sm text-[#e2e2ef] placeholder-[#6b6b80] focus:outline-none focus:border-[#7c5bf5] resize-none"
        />

        {/* Save */}
        <button
          onClick={handleSave}
          className="w-full bg-[#7c5bf5] text-white py-2.5 rounded-lg text-sm font-medium active:bg-[#6b4ae4] transition-colors"
        >
          Save Settings
        </button>
      </div>
    </div>
  );
}
