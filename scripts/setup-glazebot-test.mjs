/**
 * Setup script for the glaze_bot behavior test.
 * Connects to the running boof instance and:
 * 1. Pauses old goals
 * 2. Scans glaze_bot repo for review guidelines
 * 3. Approves all discovered guidelines
 * 4. Creates a new goal for behavior/event work
 * 5. Assigns the goal to the glaze_bot agent
 *
 * Usage: node scripts/setup-glazebot-test.mjs [host]
 * Default host: localhost:3456
 */
import WebSocket from 'ws';

const HOST = process.argv[2] || 'localhost:3456';
const WS_URL = `ws://${HOST}/ws`;
const REPO_PATH = '/Users/bcbuilmac/projects/glaze_bot';
const AGENT_ID = '4ca7e43d3e942f6d';

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
  console.log(`→ ${msg.type}`);
}

function waitForMessage(ws, type, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

async function main() {
  console.log(`Connecting to boof at ${WS_URL}...`);
  const ws = new WebSocket(WS_URL);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('Connected.\n');

  // Request sync to get current state
  send(ws, { type: 'sync:request' });
  const sync = await waitForMessage(ws, 'sync:state');
  console.log(`State: ${sync.agents.length} agents, ${sync.goals.length} goals\n`);

  // 1. Pause old goals
  const activeGoals = sync.goals.filter(g => g.status === 'active');
  console.log(`Pausing ${activeGoals.length} old goals...`);
  for (const goal of activeGoals) {
    send(ws, { type: 'goal:update', goalId: goal.id, fields: { status: 'paused' } });
    await new Promise(r => setTimeout(r, 200));
  }

  // 2. Scan for review guidelines
  console.log(`\nScanning ${REPO_PATH} for review guidelines...`);
  send(ws, { type: 'guidelines:scan', repoPath: REPO_PATH });
  const scanResult = await waitForMessage(ws, 'guidelines:scanned', 30000);
  console.log(`Found ${scanResult.proposed.length} new guidelines, ${scanResult.existingCount} existing`);
  for (const g of scanResult.proposed) {
    console.log(`  [${g.type}] ${g.name} (${g.source_path})`);
  }

  // 3. Approve all guidelines
  if (scanResult.proposed.length > 0) {
    console.log(`\nApproving all ${scanResult.proposed.length} guidelines...`);
    send(ws, { type: 'guidelines:approve-all', repoPath: REPO_PATH });
    await new Promise(r => setTimeout(r, 500));
  }

  // 4. Create the goal
  const goalName = 'Fresh & exciting commentary behaviors';
  const goalDesc = `Add 10 new behaviors, events, and interactions to the GlazeBot commentary engine to make every session feel fresh and exciting.

Focus areas:
1. New TopicTypes — add 3-4 new topic types (e.g., "conspiracy_theory", "dramatic_narration", "roast_battle", "fan_fiction") with proper prompts and weights
2. Character interactions — add new multi-character interaction patterns (debates, storytelling chains, hype duels)
3. Moment reactions — expand KeyMomentEvent types and add richer reaction templates
4. Dynamic personality shifts — characters can temporarily shift personality traits based on game events (e.g., calm character gets hyped after a kill streak)
5. Frontend freshness — add visual variety to the chat UI (message animations, character mood indicators, themed message backgrounds)

Each new behavior must:
- Follow the existing TopicType/TopicWeights pattern in apps/desktop/src/lib/commentary/types.ts
- Have proper topic prompts in the scheduler
- Include personality-appropriate variations
- Not break existing tests in apps/desktop/tests/unit/commentary/
- Be consistent with the character definition schema in characters/*.json`;

  console.log(`\nCreating goal: "${goalName}"...`);
  send(ws, { type: 'goal:create', name: goalName, description: goalDesc, repoId: REPO_PATH });
  const goalUpdate = await waitForMessage(ws, 'goal:updated');
  const goalId = goalUpdate.goal.id;
  console.log(`Goal created: ${goalId}`);

  // 5. Assign to agent
  console.log(`\nAssigning goal to agent ${AGENT_ID}...`);
  send(ws, {
    type: 'agent:autopilot',
    agentId: AGENT_ID,
    autopilot: true,
    interval: 300, // 5 min between runs
    goalId: goalId,
  });
  await new Promise(r => setTimeout(r, 500));

  // 6. Trigger first run immediately
  console.log('Triggering first autopilot run...');
  send(ws, { type: 'agent:autopilot:trigger', agentId: AGENT_ID });

  console.log('\n✓ Setup complete!');
  console.log(`  Goal: ${goalName}`);
  console.log(`  Agent: glaze_bot (${AGENT_ID})`);
  console.log(`  Interval: 5 min`);
  console.log(`  Guidelines: ${scanResult.proposed.length + scanResult.existingCount} total`);
  console.log(`\nMonitor with: tailscale ssh bcbuilmac@bcbuils-mac-mini-2 'tail -f ~/projects/boof/logs/boof.log'`);

  // Wait a moment for messages to propagate, then disconnect
  await new Promise(r => setTimeout(r, 2000));
  ws.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
