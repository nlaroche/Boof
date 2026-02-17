import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { initDb } from './db.js';
import { getOne, getAll } from './db.js';
import { setupWebSocket } from './ws-handler.js';
import { startAutopilotLoop, stopAutopilotLoop, getAgentCwd } from './autopilot.js';
import { killAllAgents } from './pty-manager.js';
import { proposeGoals, initBoofDir } from './agent-memory.js';
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
    startAutopilotLoop();
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

// Kill all agent child processes on shutdown to prevent orphans
function cleanup() {
  console.log('[server] Shutting down — killing agent processes...');
  stopAutopilotLoop();
  killAllAgents();
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGHUP', cleanup);
