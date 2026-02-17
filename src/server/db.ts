import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.DB_PATH || './boof.db';

let db: Database | null = null;

function addColumnIfMissing(tableName: string, columnName: string, columnDef: string): void {
  if (!db) return;
  const cols = db.exec(`PRAGMA table_info(${tableName})`);
  if (cols.length > 0) {
    const names = cols[0].values.map((row: any) => row[1] as string);
    if (!names.includes(columnName)) {
      db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
    }
  }
}

export async function initDb(): Promise<Database> {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      icon TEXT DEFAULT '📁',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'archived')),
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      name TEXT DEFAULT 'Agent',
      working_directory TEXT NOT NULL,
      status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error', 'dead')),
      pid INTEGER,
      profile_id TEXT DEFAULT 'robot',
      instructions TEXT DEFAULT '',
      skills TEXT DEFAULT '[]',
      schedule TEXT DEFAULT NULL,
      schedule_enabled INTEGER DEFAULT 0,
      schedule_prompt TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate existing agents table
  addColumnIfMissing('agents', 'profile_id', "TEXT DEFAULT 'robot'");
  addColumnIfMissing('agents', 'instructions', "TEXT DEFAULT ''");
  addColumnIfMissing('agents', 'skills', "TEXT DEFAULT '[]'");
  addColumnIfMissing('agents', 'schedule', 'TEXT DEFAULT NULL');
  addColumnIfMissing('agents', 'schedule_enabled', 'INTEGER DEFAULT 0');
  addColumnIfMissing('agents', 'schedule_prompt', "TEXT DEFAULT ''");
  addColumnIfMissing('agents', 'agent_type', "TEXT DEFAULT 'minimax'");
  addColumnIfMissing('agents', 'xp', 'INTEGER DEFAULT 0');
  addColumnIfMissing('agents', 'self_improve', 'INTEGER DEFAULT 0');
  addColumnIfMissing('agents', 'worktree_path', 'TEXT DEFAULT NULL');

  db.run(`
    CREATE TABLE IF NOT EXISTS assessments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      retries INTEGER DEFAULT 0,
      build_failures INTEGER DEFAULT 0,
      review_issues INTEGER DEFAULT 0,
      files_touched INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      completed_fully INTEGER DEFAULT 1,
      improvements TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS improvements (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      assessment_id TEXT,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      status TEXT DEFAULT 'pending',
      xp_awarded INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS xp_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      source TEXT DEFAULT 'autopilot',
      created_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      raw_output TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      status TEXT DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      files_changed TEXT DEFAULT '[]'
    )
  `);

  // Goals table
  db.run(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Goal activity log
  db.run(`
    CREATE TABLE IF NOT EXISTS goal_log (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      summary TEXT DEFAULT '',
      diff_stats TEXT DEFAULT '',
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);

  // Workflows table — configurable step sequences for autopilot agents
  db.run(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Seed default workflow if none exist
  const wfCount = db.exec('SELECT COUNT(*) as c FROM workflows');
  if (wfCount.length > 0 && (wfCount[0].values[0][0] as number) === 0) {
    const defaultSteps = JSON.stringify([
      { id: '1', name: 'Implement', prompt: 'Pick the highest-priority pending task and implement it. Make focused, testable changes.', on_fail: 'stop', max_retries: 0 },
      { id: '2', name: 'Build', prompt: 'Run the build command (npm run build) and fix any errors.', on_fail: 'retry', max_retries: 2 },
      { id: '3', name: 'Test', prompt: 'Run the test suite and fix any failures. If no tests exist for your changes, write them.', on_fail: 'retry', max_retries: 1 },
      { id: '4', name: 'QA Review', prompt: 'Review your own changes critically. Check for bugs, edge cases, missing error handling, and code quality issues. Fix anything you find.', on_fail: 'skip', max_retries: 0 },
    ]);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workflows (id, name, description, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['default-dev-qa', 'Dev & QA', 'Implement → Build → Test → QA Review', defaultSteps, now, now]
    );
  }

  // Autopilot columns on agents
  addColumnIfMissing('agents', 'autopilot', 'INTEGER DEFAULT 0');
  addColumnIfMissing('agents', 'autopilot_interval', 'INTEGER DEFAULT 600');
  addColumnIfMissing('agents', 'autopilot_goal_id', 'TEXT DEFAULT NULL');
  addColumnIfMissing('agents', 'autopilot_last_run', 'TEXT DEFAULT NULL');
  addColumnIfMissing('agents', 'workflow_id', 'TEXT DEFAULT NULL');

  // Goal columns
  addColumnIfMissing('goals', 'repo_id', 'TEXT DEFAULT NULL');
  addColumnIfMissing('goals', 'proposed_by', 'TEXT DEFAULT NULL');
  addColumnIfMissing('goals', 'proposal_status', 'TEXT DEFAULT NULL');

  // Goal log token tracking
  addColumnIfMissing('goal_log', 'prompt_tokens', 'INTEGER DEFAULT 0');
  addColumnIfMissing('goal_log', 'completion_tokens', 'INTEGER DEFAULT 0');
  addColumnIfMissing('goal_log', 'total_tokens', 'INTEGER DEFAULT 0');

  // Goal completion tracking
  addColumnIfMissing('goals', 'completed_at', 'TEXT DEFAULT NULL');

  // Goal stats table — tracks runs, tasks completed, avg duration per goal
  db.run(`
    CREATE TABLE IF NOT EXISTS goal_stats (
      goal_id TEXT PRIMARY KEY,
      total_runs INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      tasks_failed INTEGER DEFAULT 0,
      avg_duration_ms REAL DEFAULT 0,
      last_run_at TEXT DEFAULT NULL
    )
  `);

  // Goal linkage on tasks
  addColumnIfMissing('tasks', 'goal_id', 'TEXT DEFAULT NULL');
  addColumnIfMissing('tasks', 'agent_generated', 'INTEGER DEFAULT 0');

  // Run metrics — per-run performance data
  db.run(`
    CREATE TABLE IF NOT EXISTS run_metrics (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      command_id TEXT,
      goal_id TEXT,
      task_id TEXT,
      duration_ms INTEGER DEFAULT 0,
      retries INTEGER DEFAULT 0,
      build_failures INTEGER DEFAULT 0,
      files_touched INTEGER DEFAULT 0,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_type TEXT DEFAULT NULL,
      prompt_version_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Post-run reflections
  db.run(`
    CREATE TABLE IF NOT EXISTS reflections (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      command_id TEXT,
      went_well TEXT DEFAULT '',
      improve TEXT DEFAULT '',
      pattern TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  // Skill library — reusable learned patterns
  db.run(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      code_snippet TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      times_used INTEGER DEFAULT 0,
      times_succeeded INTEGER DEFAULT 0,
      avg_score REAL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Prompt versions — versioned prompt templates
  db.run(`
    CREATE TABLE IF NOT EXISTS prompt_versions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      template TEXT NOT NULL,
      avg_score REAL DEFAULT 0,
      total_runs INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // Experiments — A/B test tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      hypothesis TEXT DEFAULT '',
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      metric TEXT DEFAULT 'score',
      runs_a INTEGER DEFAULT 0,
      runs_b INTEGER DEFAULT 0,
      avg_metric_a REAL DEFAULT 0,
      avg_metric_b REAL DEFAULT 0,
      status TEXT DEFAULT 'running',
      winner TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  // Merge success tracking on run_metrics
  addColumnIfMissing('run_metrics', 'merge_success', 'INTEGER DEFAULT NULL');

  // Reset any agents stuck in 'running' from a previous server crash
  db.run(`UPDATE agents SET status = 'idle' WHERE status = 'running'`);

  saveDb();
  return db;
}

function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, buffer);
}

export function runQuery(sql: string, params: unknown[] = []): void {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
  saveDb();
}

export function getOne<T>(sql: string, params: unknown[] = []): T | null {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const result = stmt.getAsObject() as T;
    stmt.free();
    return result;
  }
  stmt.free();
  return null;
}

export function getAll<T>(sql: string, params: unknown[] = []): T[] {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

export function getDb(): Database | null {
  return db;
}
