#!/usr/bin/env node
/**
 * Boof Launcher - keeps the server alive across restarts.
 *
 * Usage: node launcher.js
 *
 * The launcher spawns the Boof server (via tsx) as a child process.
 * When the server exits (crash or intentional restart), it automatically
 * respawns after a short delay. The PWA client auto-reconnects via WebSocket.
 *
 * To trigger a restart (e.g. after rebuilding):
 *   - Kill the server process (the launcher will respawn it)
 *   - Or send SIGUSR2 to the launcher PID
 *   - Or create a file called .restart in the project root
 *
 * The launcher itself is tiny and stable - it should never need to restart.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = __dirname;
const RESTART_MARKER = path.join(PROJECT_ROOT, '.restart');
const RESPAWN_DELAY = 1500; // ms to wait before respawning

let child = null;
let intentionalKill = false;
let shuttingDown = false;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [launcher] ${msg}`);
}

function startServer() {
  if (shuttingDown) return;

  // Build client first, then start server
  log('Building client...');
  const build = spawn('node', ['node_modules/vite/bin/vite.js', 'build'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: true,
  });

  build.on('close', (code) => {
    if (code !== 0) {
      log(`Build failed (exit ${code}), retrying in ${RESPAWN_DELAY}ms...`);
      setTimeout(startServer, RESPAWN_DELAY);
      return;
    }

    log('Starting Boof server...');
    child = spawn('node', ['--import', 'tsx', 'src/server/index.ts'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env },
    });

    child.on('close', (exitCode) => {
      log(`Server exited (code ${exitCode})`);
      child = null;

      if (!shuttingDown) {
        log(`Respawning in ${RESPAWN_DELAY}ms...`);
        setTimeout(startServer, RESPAWN_DELAY);
      }
    });

    child.on('error', (err) => {
      log(`Server error: ${err.message}`);
    });
  });
}

// Watch for .restart marker file
function watchRestartMarker() {
  setInterval(() => {
    if (fs.existsSync(RESTART_MARKER)) {
      try { fs.unlinkSync(RESTART_MARKER); } catch {}
      log('Restart marker detected, restarting server...');
      killServer();
    }
  }, 2000);
}

function killServer() {
  if (child) {
    intentionalKill = true;
    child.kill('SIGTERM');
  }
}

// Graceful shutdown
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down...');
  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child) child.kill('SIGKILL');
      process.exit(0);
    }, 3000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// SIGUSR2 triggers a restart (works on Unix, ignored on Windows)
try {
  process.on('SIGUSR2', () => {
    log('SIGUSR2 received, restarting...');
    killServer();
  });
} catch {}

log('Boof launcher starting');
log(`PID: ${process.pid}`);
log(`Project root: ${PROJECT_ROOT}`);

startServer();
watchRestartMarker();
