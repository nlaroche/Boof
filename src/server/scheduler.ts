import { getAll, getOne, runQuery } from './db.js';
import { createAgent, sendToAgent, hasAgent } from './pty-manager.js';
import type { Agent } from '../client/lib/types.js';

type BroadcastFn = (msg: any) => void;

let broadcast: BroadcastFn = () => {};
let intervalId: ReturnType<typeof setInterval> | null = null;

export function initScheduler(broadcastFn: BroadcastFn): void {
  broadcast = broadcastFn;

  // Check every 60 seconds
  intervalId = setInterval(() => {
    checkSchedules();
  }, 60_000);

  console.log('Scheduler initialized (checking every 60s)');
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function matchesCron(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();
  const month = now.getMonth() + 1;
  const dayOfWeek = now.getDay(); // 0=Sun

  return (
    matchField(parts[0], minute, 0, 59) &&
    matchField(parts[1], hour, 0, 23) &&
    matchField(parts[2], dayOfMonth, 1, 31) &&
    matchField(parts[3], month, 1, 12) &&
    matchField(parts[4], dayOfWeek, 0, 7)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  // Handle */n (step)
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return false;
    return value % step === 0;
  }

  // Handle comma-separated values
  const values = field.split(',');
  for (const v of values) {
    // Handle range (e.g. 1-5)
    if (v.includes('-')) {
      const [startStr, endStr] = v.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) {
        return true;
      }
    } else {
      const num = parseInt(v, 10);
      if (!isNaN(num) && num === value) return true;
    }
  }

  return false;
}

/** Last minute-key a schedule fired for an agent — prevents double-fire within a minute. */
const lastFiredMinute = new Map<string, string>();

function checkSchedules(): void {
  const now = new Date();
  // Minute-resolution key for dedup (cron ticks at ~60s, but the interval can
  // drift and fire twice in the same wall-clock minute).
  const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

  const agents = getAll<Agent>(
    'SELECT * FROM agents WHERE schedule_enabled = 1 AND schedule IS NOT NULL AND schedule_prompt != ?',
    ['']
  );

  for (const agent of agents) {
    if (!agent.schedule) continue;

    if (matchesCron(agent.schedule, now)) {
      if (lastFiredMinute.get(agent.id) === minuteKey) {
        continue; // already fired this minute — don't double-fire
      }
      lastFiredMinute.set(agent.id, minuteKey);
      console.log(`Schedule fired for agent ${agent.id} (${agent.name})`);
      fireScheduledPrompt(agent);
    }
  }
}

function fireScheduledPrompt(agent: Agent): void {
  const now = new Date().toISOString();

  // Never interrupt a busy agent — skip if it's not currently idle (M3).
  const fresh = getOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [agent.id]);
  if (fresh && fresh.status !== 'idle') {
    console.log(`Scheduled prompt for agent ${agent.id} skipped — status is "${fresh.status}", not idle`);
    return;
  }

  // Create or reuse PTY
  if (!hasAgent(agent.id)) {
    const handleOutput = (id: string, chunk: string) => {
      broadcast({ type: 'agent:output', agentId: id, chunk });
    };

    const handleExit = (id: string, code: number) => {
      const exitStatus = code === 0 ? 'idle' : 'dead';
      runQuery(`UPDATE agents SET status = ?, last_activity = ? WHERE id = ?`, [exitStatus, new Date().toISOString(), id]);
      broadcast({ type: 'agent:status', agentId: id, status: exitStatus });
    };

    createAgent(agent.id, agent.working_directory, agent.name, handleOutput, handleExit, agent.agent_type);
  }

  runQuery(`UPDATE agents SET status = 'running', last_activity = ? WHERE id = ?`, [now, agent.id]);
  sendToAgent(agent.id, agent.schedule_prompt);
  broadcast({ type: 'agent:status', agentId: agent.id, status: 'running' });
  broadcast({
    type: 'notify',
    agentId: agent.id,
    title: `Scheduled: ${agent.name}`,
    body: agent.schedule_prompt.slice(0, 100),
  });
}
