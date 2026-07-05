> **HISTORICAL (v1 spec).** This is the original design doc, kept for reference. The product has since grown into an autonomous multi-agent goal engine — see `docs/ARCHITECTURE.md` for current design and `docs/PRODUCT-VISION.md` for the roadmap.

# 🔨 Boof — Mobile Claude Code Command Center

> A personal PWA + desktop server that lets you control Claude Code agents from your phone. Speech-to-text, task management, parallel sessions, zero friction.

---

## Overview

Boof is a two-part system:

1. **Boof Server** — runs on your desktop, manages Claude Code CLI sessions, serves the PWA
2. **Boof App** — a PWA you install on your Android phone via Chrome's "Add to Home Screen"

No app store. No Android Studio. No build toolchain on your phone. Open a URL → tap "Install" → done.

---

## Architecture

```
┌─────────────────────┐         Tailscale VPN         ┌──────────────────────────┐
│   Android Phone     │◄──────────────────────────────►│   Desktop / Server       │
│                     │         WebSocket (wss)        │                          │
│  ┌───────────────┐  │                                │  ┌────────────────────┐  │
│  │  Boof PWA     │  │  ── send prompt ──────────►    │  │  Boof Server       │  │
│  │  (React/TS)   │  │                                │  │  (Node.js)         │  │
│  │               │  │  ◄── stream output ────────    │  │                    │  │
│  │  - Tasks UI   │  │                                │  │  - WebSocket API   │  │
│  │  - Voice      │  │  ◄── status/summary ───────    │  │  - PTY manager     │  │
│  │  - Agents     │  │                                │  │  - Task DB (SQLite) │  │
│  │  - Output     │  │  ── task CRUD ─────────────►   │  │  - Summarizer      │  │
│  └───────────────┘  │                                │  └────────────────────┘  │
│                     │                                │          │               │
└─────────────────────┘                                │    ┌─────▼─────┐         │
                                                       │    │ Claude    │         │
                                                       │    │ Code CLI  │ × N     │
                                                       │    │ (node-pty)│         │
                                                       │    └───────────┘         │
                                                       └──────────────────────────┘
```

---

## Tech Stack

| Component        | Tech                          | Why                                    |
|-----------------|-------------------------------|----------------------------------------|
| **PWA Frontend** | React 18 + TypeScript + Vite  | Nicholas is fastest here               |
| **Styling**      | Tailwind CSS                  | Fast, utility-first, dark theme easy   |
| **Server**       | Node.js + Express             | Simple, serves PWA + WebSocket         |
| **WebSocket**    | `ws` library                  | Real-time bidirectional comms           |
| **Terminal Mgmt**| `node-pty`                    | Spawn & manage Claude Code processes   |
| **Database**     | SQLite via `better-sqlite3`   | Zero config, single file, fast         |
| **Speech**       | Web Speech API                | Built into Android Chrome, free        |
| **Summarization**| Anthropic Claude API          | Summarize verbose terminal output      |
| **Networking**   | Tailscale                     | Secure LAN access, zero port config    |
| **Icons/PWA**    | Vite PWA plugin               | Auto-generates manifest + SW           |

---

## Installation & Setup

### Desktop (one-time)

```bash
# Clone and install
git clone <repo> && cd boof
npm install

# Set env
cp .env.example .env
# Edit .env → set ANTHROPIC_API_KEY (for output summarization)

# Start server
npm run start
# Server starts on http://localhost:3456
# Also available at http://<tailscale-ip>:3456
```

### Phone (one-time)

1. Install Tailscale on phone (if not already)
2. Open Chrome → navigate to `http://<tailscale-hostname>:3456`
3. Chrome shows "Install app" banner → tap it
4. Boof appears on home screen with the 🔨 icon
5. Done. That's it.

---

## Design & Theme

### Visual Identity
- **Name**: Boof 🔨
- **Vibe**: Dark, modern, minimal — like a sleek terminal meets a task app
- **Color palette**:
  - Background: `#0a0a0f` (near-black with slight blue)
  - Surface: `#14141f` (cards, panels)
  - Border: `#1e1e2e` (subtle separation)
  - Primary: `#7c5bf5` (purple accent — buttons, active states)
  - Success: `#22c55e` (task complete, agent idle)
  - Warning: `#f59e0b` (agent running)
  - Error: `#ef4444`
  - Text primary: `#e2e2ef`
  - Text secondary: `#6b6b80`
- **Font**: `JetBrains Mono` for terminal output, `Inter` for UI
- **Border radius**: 12px for cards, 8px for buttons, full-round for avatars/badges
- **Animations**: Subtle spring animations on interactions, smooth transitions, pulse on active agents

### Mobile-First Layout
- Bottom navigation bar (not top — thumb-friendly)
- Large touch targets everywhere (min 48px)
- Swipe gestures for common actions (swipe task to complete, swipe to archive)
- Pull-to-refresh on agent output
- Haptic feedback on key actions (if supported)

---

## Data Model (SQLite)

```sql
-- Folders group tasks
CREATE TABLE folders (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📁',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tasks live in folders
CREATE TABLE tasks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,  -- subtasks
  title TEXT NOT NULL,
  description TEXT DEFAULT '',       -- scratchpad / notes / context
  status TEXT DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'archived')),
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent sessions (Claude Code instances)
CREATE TABLE agents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  name TEXT DEFAULT 'Agent',
  working_directory TEXT NOT NULL,
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error', 'dead')),
  pid INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Command history per agent
CREATE TABLE commands (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,              -- what you sent
  raw_output TEXT DEFAULT '',        -- full terminal output
  summary TEXT DEFAULT '',           -- AI-generated summary
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  files_changed TEXT DEFAULT '[]'    -- JSON array of file paths from git diff
);
```

---

## WebSocket API

All communication between phone and server happens over a single WebSocket connection. Messages are JSON with a `type` field.

### Client → Server

```typescript
// Task CRUD
{ type: 'task:create', folderId: string, title: string, description?: string, parentTaskId?: string }
{ type: 'task:update', taskId: string, fields: Partial<Task> }
{ type: 'task:delete', taskId: string }
{ type: 'task:reorder', taskId: string, sortOrder: number }

// Folder CRUD
{ type: 'folder:create', name: string, icon?: string }
{ type: 'folder:update', folderId: string, fields: Partial<Folder> }
{ type: 'folder:delete', folderId: string }

// Agent management
{ type: 'agent:create', workingDirectory: string, name?: string }
{ type: 'agent:kill', agentId: string }
{ type: 'agent:restart', agentId: string }

// Send command to agent
{ type: 'agent:send', agentId: string, prompt: string, taskId?: string }
{ type: 'agent:interrupt', agentId: string }  // Ctrl+C

// Data requests
{ type: 'sync:request' }  // get full state on connect
{ type: 'agent:history', agentId: string, limit?: number }
```

### Server → Client

```typescript
// Full state sync (on connect)
{ type: 'sync:state', folders: Folder[], tasks: Task[], agents: Agent[] }

// Real-time updates
{ type: 'agent:output', agentId: string, chunk: string }          // streaming terminal output
{ type: 'agent:status', agentId: string, status: AgentStatus }    // idle/running/error/dead
{ type: 'agent:summary', agentId: string, commandId: string, summary: string, filesChanged: string[] }
{ type: 'task:updated', task: Task }
{ type: 'folder:updated', folder: Folder }

// Notifications
{ type: 'notify', agentId: string, title: string, body: string }  // triggers push notification
```

---

## Server Implementation Details

### PTY Manager (`pty-manager.ts`)

```typescript
// Each agent gets its own PTY running Claude Code
// Key behaviors:
// - Spawn: `claude` CLI in the specified working directory
// - Stream stdout/stderr back over WebSocket
// - Buffer output per-command for storage and summarization
// - Detect command completion (watch for Claude Code's idle prompt)
// - On completion: store raw output, trigger summarization, send notification
// - Handle Ctrl+C (SIGINT) forwarding
// - Auto-reconnect if PTY dies unexpectedly
// - Support N concurrent agents (practical limit ~5-8)
```

### Output Summarizer (`summarizer.ts`)

```typescript
// When a Claude Code command completes:
// 1. Capture full output buffer
// 2. Run `git diff --stat` in the agent's working directory
// 3. Send to Claude API:
//    System: "Summarize this Claude Code session output in 2-3 sentences.
//             Focus on: what was accomplished, files changed, any errors.
//             Be terse and specific."
//    User: <raw output, truncated to last 4000 tokens if needed>
// 4. Store summary + files_changed in commands table
// 5. Send summary to client
// 6. Trigger notification
```

### Notifications

```typescript
// Use Web Push API for PWA notifications
// Server generates VAPID keys on first run, stores in .env
// Client subscribes on first connect
// Triggers:
//   - Agent command completed (include summary in notification body)
//   - Agent error / crash
//   - Agent needs input (if Claude Code prompts for confirmation)
```

---

## PWA Frontend Structure

```
src/
├── main.tsx                    # Entry point
├── App.tsx                     # Root layout + bottom nav + WebSocket provider
├── sw.ts                       # Service worker (workbox via vite-plugin-pwa)
│
├── hooks/
│   ├── useWebSocket.ts         # WebSocket connection + reconnect logic
│   ├── useSpeech.ts            # Web Speech API wrapper
│   ├── useNotifications.ts     # Push notification subscription
│   └── useHaptic.ts            # Vibration API wrapper
│
├── stores/
│   └── store.ts                # Zustand store — single source of truth
│                               # Hydrated from sync:state, updated via WS messages
│                               # Sections: folders, tasks, agents, commands, ui
│
├── screens/
│   ├── HomeScreen.tsx           # Dashboard: active agents overview + quick actions
│   ├── TasksScreen.tsx          # Folder list → task list → subtasks (drill-down)
│   ├── AgentScreen.tsx          # Single agent: output stream + input bar
│   ├── AgentsScreen.tsx         # All agents overview, status badges, quick switch
│   └── HistoryScreen.tsx        # Searchable command history with summaries
│
├── components/
│   ├── BottomNav.tsx            # 🏠 Home | 📋 Tasks | 🤖 Agents | 📜 History
│   ├── AgentCard.tsx            # Agent status card (name, status badge, last activity)
│   ├── AgentOutput.tsx          # Scrollable terminal output with ANSI color support
│   ├── TaskItem.tsx             # Task row with checkbox, swipe actions
│   ├── TaskTree.tsx             # Recursive subtask rendering
│   ├── FolderList.tsx           # Folder cards with task counts
│   ├── CommandInput.tsx         # Text input + mic button + send button
│   ├── VoiceButton.tsx          # Hold-to-talk, animated, sends on release
│   ├── QuickActions.tsx         # Grid of common command buttons
│   ├── SummaryCard.tsx          # Completed command summary display
│   ├── NewAgentSheet.tsx        # Bottom sheet: create agent, pick directory
│   └── Notification.tsx         # In-app toast notifications
│
└── lib/
    ├── types.ts                 # Shared TypeScript types
    ├── ansi.ts                  # ANSI escape code → styled spans
    └── format.ts                # Time formatting, truncation helpers
```

---

## Screen Designs

### 1. Home Screen (Dashboard)
```
┌─────────────────────────────┐
│  🔨 Boof                    │
│                              │
│  ┌────────────┐ ┌──────────┐│
│  │ 🟢 Agent 1 │ │ 🟡 Agt 2 ││
│  │ myproject   │ │ sideproj ││
│  │ Idle 2m ago│ │ Running..││
│  └────────────┘ └──────────┘│
│                              │
│  Quick Actions               │
│  ┌──────┐┌──────┐┌────────┐ │
│  │▶ Run ││🧪Test││📝Commit│ │
│  │ last ││      ││& Push  │ │
│  └──────┘└──────┘└────────┘ │
│  ┌──────┐┌──────┐┌────────┐ │
│  │🔍 Ex-││↩ Con-││📊 Diff │ │
│  │plain ││tinue ││Summary │ │
│  └──────┘└──────┘└────────┘ │
│                              │
│  Recent                      │
│  ✅ Refactored auth — 5m ago │
│  ✅ Fixed CSS grid — 12m ago │
│                              │
├──────────────────────────────┤
│  🏠    📋    🤖    📜        │
└──────────────────────────────┘
```

### 2. Agent Screen
```
┌─────────────────────────────┐
│  ← Agent 1 — myproject  🟢  │
│─────────────────────────────│
│                              │
│  ┌─ Terminal Output ───────┐ │
│  │ > Editing src/auth.ts   │ │
│  │ > Running tests...      │ │
│  │ > All 14 tests passed ✓ │ │
│  │ > Ready for next task   │ │
│  │                         │ │
│  │                         │ │
│  └─────────────────────────┘ │
│                              │
│  Summary: Refactored the     │
│  auth module to use JWT      │
│  refresh tokens. Updated     │
│  3 files, all tests pass.    │
│                              │
│  📁 Changed: src/auth.ts,    │
│     src/middleware.ts (+2)    │
│                              │
│ ┌───────────────────┐ ┌───┐ │
│ │ Tell it what to do│ │🎤 │ │
│ └───────────────────┘ └───┘ │
├──────────────────────────────┤
│  🏠    📋    🤖    📜        │
└──────────────────────────────┘
```

### 3. Tasks Screen
```
┌─────────────────────────────┐
│  📋 Tasks              + 📁 │
│─────────────────────────────│
│                              │
│  📁 Boof App (3/7)           │
│  ┌─────────────────────────┐ │
│  │ ☑ Set up project        │ │
│  │ ☑ WebSocket server      │ │
│  │ ☐ PTY manager           │ │
│  │   ├ ☐ Spawn logic       │ │
│  │   ├ ☐ Output buffering  │ │
│  │   └ ☐ Idle detection    │ │
│  │ ☐ PWA frontend          │ │
│  └─────────────────────────┘ │
│                              │
│  📁 Side Project (1/3)       │
│  ▸ tap to expand             │
│                              │
│  📁 Consulting (0/2)         │
│  ▸ tap to expand             │
│                              │
├──────────────────────────────┤
│  🏠    📋    🤖    📜        │
└──────────────────────────────┘
```

---

## Quick Actions (Configurable Templates)

Pre-built commands that map to common Claude Code operations. These are stored in a JSON config and rendered as tappable buttons on the home screen and in agent views.

```typescript
const defaultQuickActions = [
  { label: '▶ Continue', icon: '▶', prompt: 'continue where you left off' },
  { label: '🧪 Test', icon: '🧪', prompt: 'run the test suite and report results' },
  { label: '📝 Commit', icon: '📝', prompt: 'commit all changes with a descriptive message and push' },
  { label: '🔍 Explain', icon: '🔍', prompt: 'explain what you just did and why' },
  { label: '📊 Status', icon: '📊', prompt: 'show me a summary of the current state of the project' },
  { label: '🐛 Fix', icon: '🐛', prompt: 'look at the last error and fix it' },
  { label: '♻️ Refactor', icon: '♻️', prompt: 'refactor the last thing you worked on for clarity' },
  { label: '📋 Plan', icon: '📋', prompt: 'create a plan for what to work on next based on the codebase' },
];
// Users can add/edit/remove via settings
```

---

## Voice Input Details

```typescript
// useSpeech.ts
// Uses Web Speech API (SpeechRecognition)
// Behavior:
//   - Tap mic button → starts listening, button pulses purple
//   - Speak naturally, text appears in input field in real-time
//   - Tap mic again OR pause for 2 seconds → stops, text stays in input
//   - User can edit text before sending, or just hit send
//   - Hold-to-talk mode (optional setting): hold mic button, release to stop
//   - Language: en-US (hardcoded, it's just for Nicholas)
//
// Important: Web Speech API requires HTTPS or localhost
// Tailscale provides HTTPS via MagicDNS (https://boof.tailnet-name.ts.net)
// OR serve over HTTP on localhost and proxy
```

---

## Server Configuration

### `.env` file

```bash
PORT=3456
ANTHROPIC_API_KEY=sk-ant-...        # For output summarization
ANTHROPIC_MODEL=claude-sonnet-4-20250514  # Cheap + fast for summaries
CLAUDE_CODE_PATH=claude             # Path to claude CLI binary
DEFAULT_WORKING_DIR=/home/nicholas  # Default cwd for new agents
DB_PATH=./boof.db                   # SQLite database file
```

### `package.json` scripts

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "tsx watch src/server/index.ts",
    "dev:client": "vite",
    "build": "vite build && tsc -p tsconfig.server.json",
    "start": "node dist/server/index.js",
    "setup": "node scripts/setup.js"
  }
}
```

---

## Key Implementation Notes

### Claude Code CLI Interaction
- Claude Code is interactive — it has its own prompt, asks for confirmation, etc.
- The PTY approach treats it like a raw terminal. We send text + Enter to it, read all stdout.
- **Idle detection**: Watch for Claude Code's prompt pattern (e.g., the `>` prompt or the cost summary line) to detect when a command is "done."
- **Confirmation handling**: If Claude Code asks "Do you want to proceed? (y/n)", detect this and surface it to the phone as a notification + quick-reply button.
- Use `--no-input` or `--dangerously-skip-permissions` flags if available to reduce interactive prompts (check Claude Code docs for current flags).

### ANSI Color Support
- Claude Code outputs ANSI color codes for syntax highlighting, diffs, etc.
- Use a library like `ansi-to-html` or a custom parser to render colored output in the PWA.
- Keep the terminal output area monospace with proper styling.

### Reconnection
- WebSocket should auto-reconnect with exponential backoff.
- On reconnect, send `sync:request` to get full state.
- Agent output that was missed during disconnect is lost (acceptable for personal use).
- Show a "Reconnecting..." banner in the UI when disconnected.

### Performance
- Terminal output can be huge. Keep only the last ~500 lines in-memory per agent for display.
- Full output is stored in SQLite (commands.raw_output) for history.
- Use virtualized scrolling for long output (react-window or similar).

---

## Project Structure

```
boof/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.server.json
├── tailwind.config.ts
├── .env.example
├── .env
│
├── public/
│   ├── boof-icon-192.png        # PWA icon
│   ├── boof-icon-512.png        # PWA icon
│   └── manifest.json            # Generated by vite-plugin-pwa
│
├── scripts/
│   └── setup.js                 # First-run: create DB, generate VAPID keys
│
├── src/
│   ├── server/
│   │   ├── index.ts             # Express + WebSocket server + static file serving
│   │   ├── db.ts                # SQLite setup + query helpers
│   │   ├── pty-manager.ts       # PTY lifecycle management
│   │   ├── summarizer.ts        # Claude API output summarization
│   │   ├── ws-handler.ts        # WebSocket message routing
│   │   └── notifications.ts     # Web Push notification sender
│   │
│   └── client/                  # Vite/React PWA (structure from above)
│       ├── main.tsx
│       ├── App.tsx
│       ├── hooks/
│       ├── stores/
│       ├── screens/
│       ├── components/
│       └── lib/
│
└── CLAUDE.md                    # Claude Code project instructions
```

---

## CLAUDE.md (for Claude Code to read)

```markdown
# Boof — Project Instructions

This is a personal PWA + Node server for controlling Claude Code from a phone.

## Stack
- Server: Node.js, Express, ws, node-pty, better-sqlite3, tsx
- Client: React 18, TypeScript, Vite, Tailwind CSS, Zustand, vite-plugin-pwa

## Key Rules
- This is a single-user personal tool. No auth, no multi-tenancy.
- Dark theme only. Colors defined in tailwind.config.ts.
- Mobile-first. Everything must be thumb-friendly.
- Bottom navigation, not top.
- All state flows through Zustand store, hydrated via WebSocket.
- Terminal output must preserve ANSI colors.
- Keep it simple. No over-engineering.

## Running
- `npm run dev` starts both server and client
- Server on :3456, Vite dev on :5173 (proxied)
- `npm run build && npm start` for production

## Database
- SQLite at ./boof.db
- Schema in src/server/db.ts
- Migrations are just CREATE IF NOT EXISTS (it's personal, keep it simple)
```

---

## Build Order (suggested phases)

### Phase 1 — Foundation
1. Project scaffold: Vite + React + Tailwind + TypeScript
2. Express server serving static files
3. SQLite database with schema
4. WebSocket connection (client ↔ server)
5. Basic state sync

### Phase 2 — Agent Core
6. PTY manager: spawn Claude Code, stream output
7. Agent CRUD (create, list, kill)
8. Send prompts to agent, receive output
9. Agent screen with terminal output display
10. ANSI color rendering

### Phase 3 — Task Management
11. Folder CRUD
12. Task CRUD with subtasks
13. Task list UI with completion toggling
14. Link tasks to agent commands
15. Swipe gestures

### Phase 4 — Intelligence
16. Output summarization via Claude API
17. Git diff detection after commands
18. Summary cards in UI
19. Command history + search

### Phase 5 — Voice & Polish
20. Speech-to-text integration
21. Voice button with hold-to-talk mode
22. Quick action buttons
23. Push notifications
24. PWA manifest + service worker + icons
25. Install flow testing on Android

### Phase 6 — Nice-to-haves
26. Confirmation prompt detection + relay
27. Custom quick actions editor
28. Agent auto-naming based on directory
29. Output text search within terminal
30. Export task list as markdown
