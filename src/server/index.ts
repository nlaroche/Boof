import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db.js';
import { setupWebSocket, handleWsMessage } from './ws-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;

const app = express();
const server = createServer(app);

setupWebSocket(server);

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws') {
    // Handle WebSocket upgrade manually if needed
  } else {
    socket.destroy();
  }
});

app.use((req, res, next) => {
  if (req.url.startsWith('/ws')) {
    return next();
  }
  next();
});

app.use(express.static(path.join(__dirname, '../client')));

// PTY manager stub - will be implemented in future
console.log('PTY manager stub loaded');

async function start() {
  try {
    await initDb();
    console.log('Database initialized');
  } catch (error) {
    console.error('Failed to initialize database:', error);
  }

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
  });

  server.listen(PORT, () => {
    console.log(`Boof server running on http://localhost:${PORT}`);
  });
}

start();
