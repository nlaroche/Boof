import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { initDb } from './db.js';
import { setupWebSocket } from './ws-handler.js';

const PORT = process.env.PORT || 3456;

// Always resolve from project root
const projectRoot = process.cwd();
const clientDir = path.join(projectRoot, 'dist/client');

const app = express();
const server = createServer(app);

setupWebSocket(server);

app.use(express.static(clientDir));

async function start() {
  try {
    await initDb();
    console.log('Database initialized');
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
