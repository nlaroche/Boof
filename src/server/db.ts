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
  addColumnIfMissing('agents', 'agent_type', "TEXT DEFAULT 'claude'");

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
