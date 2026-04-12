/**
 * Goal planner — decomposes goals into tasks and parses agent output.
 *
 * Handles:
 * - Parsing TASK: lines from agent planning output
 * - Creating task records in the database
 * - Managing the "Goal Tasks" folder
 * - Detecting independent tasks for parallel work
 *
 * Extracted from autopilot.ts for modularity.
 */
import { runQuery, getOne, generateId } from '../db-helpers.js';
import { getBroadcast } from '../ws-handler.js';
import { stripAnsi } from '../git-utils.js';

// ── Task Parsing ──

/**
 * Parse TASK: lines from agent planning output.
 * Format: TASK: title | description | DONE_WHEN: condition
 * Also supports old format: TASK: title | description
 */
export function parseTasksFromOutput(output: string, goalId: string, agentId: string): number {
  const clean = stripAnsi(output);
  const lines = clean.split('\n');
  let count = 0;
  for (const line of lines) {
    const match = line.match(/TASK:\s*([^|]+)\|([^|]+)(?:\|\s*DONE_WHEN:\s*(.+))?/);
    if (match) {
      const title = match[1].trim();
      const description = match[2].trim();
      const doneWhen = match[3]?.trim() || '';
      if (title) {
        createTaskForGoal(goalId, agentId, title, description, doneWhen);
        count++;
      }
    }
  }
  return count;
}

// ── Task Creation ──

/**
 * Create a task linked to a goal in the "Goal Tasks" folder.
 */
export function createTaskForGoal(goalId: string, agentId: string, title: string, description: string, doneWhen = ''): void {
  const broadcast = getBroadcast();
  const folderId = getOrCreateGoalTasksFolder();
  const id = generateId();
  const now = new Date().toISOString();

  runQuery(
    `INSERT INTO tasks (id, folder_id, title, description, status, goal_id, agent_generated, done_when, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'todo', ?, 1, ?, ?, ?)`,
    [id, folderId, title, description, goalId, doneWhen, now, now]
  );

  const task = getOne<any>('SELECT * FROM tasks WHERE id = ?', [id]);
  if (task) {
    broadcast({ type: 'task:updated', task });
  }

  logToGoal(goalId, agentId, 'task_created', `Created task: ${title}`, '', 0, true);
}

// ── Folder Management ──

/**
 * Get or create the "Goal Tasks" folder for agent-generated tasks.
 */
export function getOrCreateGoalTasksFolder(): string {
  const broadcast = getBroadcast();
  const existing = getOne<any>("SELECT * FROM folders WHERE name = 'Goal Tasks'", []);
  if (existing) return existing.id;

  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    `INSERT INTO folders (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, 'Goal Tasks', '\uD83C\uDFAF', now, now]
  );
  const folder = getOne<any>('SELECT * FROM folders WHERE id = ?', [id]);
  if (folder) {
    broadcast({ type: 'folder:updated', folder });
  }
  return id;
}

// ── Independent Task Detection ──

/**
 * Detect independent tasks by checking if they mention different files.
 * Tasks are independent if their descriptions reference non-overlapping file sets.
 */
export function detectIndependentTasks(tasks: { id: string; title: string; description: string }[]): typeof tasks {
  if (tasks.length <= 1) return tasks;

  const filePattern = /\b(?:src\/[a-z0-9_/-]+\.(?:ts|tsx|js|jsx|json))\b/gi;
  const taskFiles = tasks.map(task => {
    const matches = (task.description || '').match(filePattern) || [];
    return { task, files: new Set(matches.map(f => f.toLowerCase())) };
  });

  const independent: typeof tasks = [];
  const usedFiles = new Set<string>();

  for (const { task, files } of taskFiles) {
    const hasOverlap = Array.from(files).some(f => usedFiles.has(f));
    if (!hasOverlap || files.size === 0) {
      independent.push(task);
      files.forEach(f => usedFiles.add(f));
    }
  }

  return independent.length > 0 ? independent : [tasks[0]];
}

// ── Helper ──

function logToGoal(goalId: string, agentId: string, action: string, summary: string, diffStats: string, durationMs: number, success: boolean): void {
  const broadcast = getBroadcast();
  const id = generateId();
  const now = new Date().toISOString();
  runQuery(
    `INSERT INTO goal_log (id, goal_id, agent_id, action, summary, diff_stats, duration_ms, success, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, goalId, agentId, action, summary, diffStats, durationMs, success ? 1 : 0, now]
  );
  const entry = getOne<any>('SELECT * FROM goal_log WHERE id = ?', [id]);
  if (entry) broadcast({ type: 'goal:log:entry', entry });
}
