import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3456;

const app = express();
const server = createServer(app);

// Serve static files from built client
app.use(express.static(path.join(__dirname, '../client')));

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

server.listen(PORT, () => {
  console.log(`Boof server running on http://localhost:${PORT}`);
});
