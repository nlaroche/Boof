import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { initDb, flushDb } from './db.js';
import { getOne, getAll } from './db.js';
import { setupWebSocket, getBroadcast } from './ws-handler.js';
import { startAutopilotLoop, stopAutopilotLoop, getAgentCwd } from './autopilot.js';
import { initScheduler, stopScheduler } from './scheduler.js';
import { startMaintenanceLoop, stopMaintenanceLoop } from './systems/maintenance.js';
import { killAllAgents } from './pty-manager.js';
import { proposeGoals, initBoofDir } from './agent-memory.js';
import { initNotifications } from './notifications.js';
import { pruneRetention } from './db-helpers.js';
import type { Agent } from '../client/lib/types.js';

const PORT = process.env.PORT || 3456;

// Always resolve from project root
const projectRoot = process.cwd();
const clientDir = path.join(projectRoot, 'dist/client');

const app = express();
const server = createServer(app);

setupWebSocket(server);

app.use(express.static(clientDir));
app.use(express.json());

// ── REST API ──────────────────────────────────────────────────────────────────

/**
 * GET /api/goals/propose?agentId=<id>
 * Returns AI-generated goal proposals based on past patterns.
 * Used when no active goals remain and the autopilot needs new work.
 */
app.get('/api/goals/propose', async (req, res) => {
  const agentId = req.query.agentId as string;
  if (!agentId) {
    res.status(400).json({ error: 'agentId query parameter is required' });
    return;
  }

  const agent = getOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  const agentCwd = getAgentCwd(agent);
  initBoofDir(agentCwd);

  const activeGoals = getAll<{ id: string }>('SELECT id FROM goals WHERE status = \'active\'', []);
  if (activeGoals.length > 0) {
    res.status(200).json({ goals: [], message: 'Active goals exist — no proposals needed' });
    return;
  }

  try {
    const proposed = await proposeGoals(agentId, agentCwd);
    res.status(200).json({ goals: proposed });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to propose goals' });
  }
});

async function start() {
  try {
    await initDb();
    console.log('Database initialized');
    initNotifications(); // VAPID keys + load persisted push subscriptions
    startAutopilotLoop();
    startMaintenanceLoop();
    initScheduler(getBroadcast()); // M3: cron scheduler was never wired in production
    startRetentionLoop(); // M4: daily prune of unbounded tables
  } catch (error) {
    console.error('Failed to initialize database:', error);
  }

  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Boof server running on http://0.0.0.0:${PORT}`);
    console.log(`Access via Tailscale at http://<tailscale-ip>:${PORT}`);
  });
}

start();

// M4: run the retention prune once shortly after boot, then daily.
let retentionTimer: NodeJS.Timeout | null = null;
function startRetentionLoop() {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const run = () => {
    try {
      const result = pruneRetention();
      if (result.truncatedOutputs || result.deletedCommands) {
        console.log(`[retention] pruned: truncated ${result.truncatedOutputs} raw_output, deleted ${result.deletedCommands} orphan command(s)`);
      }
    } catch (e: any) {
      console.error('[retention] prune failed:', e?.message || e);
    }
  };
  setTimeout(run, 5 * 60 * 1000).unref?.(); // first pass 5 min after boot
  retentionTimer = setInterval(run, DAY_MS);
  retentionTimer.unref?.();
}

// Kill all agent child processes on shutdown to prevent orphans
function cleanup() {
  console.log('[server] Shutting down — killing agent processes...');
  stopAutopilotLoop();
  stopMaintenanceLoop();
  stopScheduler();
  if (retentionTimer) clearInterval(retentionTimer);
  killAllAgents();
  flushDb(); // M4: synchronous flush so no debounced write is lost on exit
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGHUP', cleanup);
