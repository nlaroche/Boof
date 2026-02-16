import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3456/ws');

ws.on('open', () => {
  console.log('Connected to Boof');

  // Create a new agent
  ws.send(JSON.stringify({
    type: 'agent:create',
    name: 'MiniMax Coder',
    workingDirectory: 'D:\\repos\\boof',
    profileId: 'robot'
  }));
});

let agentId = null;
let promptSent = false;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'sync:state') return;

  if (msg.type === 'agent:updated' && !agentId) {
    agentId = msg.agent.id;
    console.log('Agent created:', agentId);
  }

  if (msg.type === 'agent:updated' && agentId && !promptSent) {
    promptSent = true;
    console.log('Sending favicon task...');
    ws.send(JSON.stringify({
      type: 'agent:send',
      agentId: agentId,
      prompt: 'Update the favicon and PWA icons for this app. The current ones are generic SVG placeholders. Create a better favicon that represents a mobile command center / controller app. Use a simple, bold design with the app colors (dark theme with blue/purple accents). Update the relevant files in the public/ directory and any references in index.html or the PWA manifest.'
    }));
  }

  if (msg.type === 'agent:output') {
    process.stdout.write(msg.chunk);
  }

  if (msg.type === 'agent:status') {
    console.log('\nAgent status:', msg.status);
    if (msg.status === 'idle' || msg.status === 'dead') {
      setTimeout(() => process.exit(0), 2000);
    }
  }

  if (msg.type === 'command:updated') {
    console.log('\nCommand:', msg.command.status, msg.command.summary || '');
  }
});

ws.on('error', (err) => {
  console.error('WS error:', err.message);
  process.exit(1);
});

// Timeout after 5 minutes
setTimeout(() => {
  console.log('\nTimeout - stopping');
  process.exit(0);
}, 300000);
